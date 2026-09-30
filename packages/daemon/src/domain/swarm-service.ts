import * as fs from "node:fs";
import * as path from "node:path";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { SandboxError, locateRepo, sandboxGit, segment } from "./sandbox-common.js";
import { deriveCanonicalSessionName, validateSessionComponents } from "./session-name.js";
import { LANE_SUMMARIES, SWARM_LANE_IDS, detectProject, laneBrief, rigNameFor, type SwarmLaneId } from "./swarm-planner.js";
import type { RigSpec } from "./types.js";

// `squad swarm`: turn a prompt into a rig spec of isolated, gated seats. The service plans, and in `write`
// and `launch` modes writes the spec under the instance directory (never into the repository). Starting the
// seats is the existing `up`, run by the CLI on the file written here.

export type SwarmMode = "preview" | "write" | "launch";

const MODES: readonly SwarmMode[] = ["preview", "write", "launch"];
const RUNTIMES = ["claude-code", "codex"] as const;
const MAX_PROMPT_LENGTH = 8000;

/** Files OpenRig writes into each seat's worktree. A seat's `git add -A` would commit them, so launching hides them. */
const HARNESS_EXCLUDES = [".openrig/", ".claude/settings.local.json"];

// The one agent spec every lane uses: no skills, no guidance. The task and the rules arrive as the seat's first message.
// Kept to the smallest shape the validator accepts, since the format has dropped keys before (hooks) and the
// reference example in the docs had not caught up.
export const LANE_AGENT_SPEC = `name: lane
version: "1.0"
description: A lane of a squad. Its task and rules arrive as its first message.

resources:
  skills: []

profiles:
  default:
    uses:
      skills: []
`;

export interface SwarmRequest {
  prompt: string;
  /** The directory the person ran the command in: an absolute path inside a git repository. */
  cwd: string;
  mode?: SwarmMode;
  name?: string;
  lanes?: string[];
  runtime?: string;
  gate?: string[];
  setup?: string[];
  noSetup?: boolean;
}

export interface SwarmLanePlan {
  lane: SwarmLaneId;
  /** The logical id of the seat, for example swarm.backend. */
  seat: string;
  session: string;
  branch: string;
  summary: string;
  /** The message the seat gets when it starts. */
  brief: string;
}

export interface SwarmPlan {
  prompt: string;
  rig: string;
  repo: string;
  /** Where the seats work: the directory the command was run in, inside their worktrees. */
  cwd: string;
  runtime: string;
  gate: string[];
  gateBasis: string;
  setup: string[] | null;
  setupBasis: string;
  lanes: SwarmLanePlan[];
  specYaml: string;
  /** Where the rig spec is, or would be, written. */
  specPath: string;
  written: boolean;
  /** The patterns this call added to the repository's .git/info/exclude. */
  excluded: string[];
}

const invalid = (message: string) => new SandboxError("invalid", message);

/** Check the shape of a request body, so the rest of the service can trust its types. */
export function parseSwarmRequest(body: unknown): SwarmRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The request must be a JSON object.");
  const b = body as Record<string, unknown>;
  const text = (key: string, required: boolean): string | undefined => {
    const value = b[key];
    if (value === undefined) {
      if (required) throw invalid(`${key} is required.`);
      return undefined;
    }
    if (typeof value !== "string") throw invalid(`${key} must be a string.`);
    return value;
  };
  const list = (key: string): string[] | undefined => {
    const value = b[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalid(`${key} must be a list of strings.`);
    return value as string[];
  };
  const cwd = text("cwd", true)!;
  if (!path.isAbsolute(cwd)) throw invalid("cwd must be an absolute path.");
  const mode = text("mode", false);
  if (mode !== undefined && !MODES.includes(mode as SwarmMode)) throw invalid(`mode must be one of ${MODES.join(", ")}.`);
  if (b["noSetup"] !== undefined && typeof b["noSetup"] !== "boolean") throw invalid("noSetup must be true or false.");
  return {
    prompt: text("prompt", true)!,
    cwd,
    mode: mode as SwarmMode | undefined,
    name: text("name", false),
    lanes: list("lanes"),
    runtime: text("runtime", false),
    gate: list("gate"),
    setup: list("setup"),
    noSetup: b["noSetup"] as boolean | undefined,
  };
}

/**
 * Add the harness files to the repository's local exclude list, once. `.git/info/exclude` lives in the common
 * git directory, so it covers every worktree. It is never committed. Returns the patterns that were added.
 */
export async function excludeHarnessFiles(top: string): Promise<string[]> {
  const common = path.resolve(top, await sandboxGit(["rev-parse", "--git-common-dir"], top));
  const file = path.join(common, "info", "exclude");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = HARNESS_EXCLUDES.filter((pattern) => !have.has(pattern));
  if (missing.length === 0) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${separator}# Squadron: files OpenRig writes into each seat's worktree\n${missing.join("\n")}\n`);
  return missing;
}

export class SwarmService {
  /** `homeDir` is the instance directory (OPENRIG_HOME); specs are written under `<homeDir>/swarms/<rig>/`. */
  constructor(private readonly homeDir: string) {}

  async plan(request: SwarmRequest): Promise<SwarmPlan> {
    const mode = request.mode ?? "preview";
    const prompt = request.prompt.trim();
    if (!prompt) throw invalid('squad swarm needs a prompt, for example: squad swarm "Build Auth API"');
    if (prompt.length > MAX_PROMPT_LENGTH) throw invalid(`The prompt is longer than ${MAX_PROMPT_LENGTH} characters. Put the details in a file in the repository and point to it.`);

    const lanes = this.lanesFor(request.lanes);
    const runtime = request.runtime ?? "claude-code";
    if (!(RUNTIMES as readonly string[]).includes(runtime)) throw invalid(`runtime must be one of ${RUNTIMES.join(", ")}.`);
    const rig = request.name ?? rigNameFor(prompt);
    const nameErrors = lanes.flatMap((lane) => validateSessionComponents("swarm", lane, rig));
    if (nameErrors.length > 0) throw invalid(`The rig name "${rig}" cannot be used: ${[...new Set(nameErrors)].join("; ")}.`);

    // The seats work in the directory the person ran the command in, so the project files are looked for there.
    const { real, top } = await locateRepo(request.cwd);
    await sandboxGit(["rev-parse", "--verify", "HEAD"], top).catch(() => {
      throw new SandboxError("failed", `${top} has no commits yet, so seats have nothing to branch from. Make an initial commit first.`);
    });
    const detected = detectProject(real);
    const gate = request.gate ?? detected.gate;
    if (!gate) {
      throw new SandboxError(
        "failed",
        `No test command was found: ${detected.basis}. Pass one with --gate, for example: --gate "npm test". A gate is required because squad land refuses lanes without one.`,
      );
    }
    const setup = request.noSetup ? null : (request.setup ?? detected.setup);

    const sessions = lanes.map((lane) => ({ lane, session: deriveCanonicalSessionName("swarm", lane, rig) }));
    const lanePlans: SwarmLanePlan[] = sessions.map(({ lane, session }) => ({
      lane,
      seat: `swarm.${lane}`,
      session,
      branch: `squad/${segment(rig)}/${segment(`swarm.${lane}`)}`,
      summary: LANE_SUMMARIES[lane],
      brief: laneBrief({ lane, prompt, rig, teammates: sessions }),
    }));

    const spec: RigSpec = {
      version: "0.2",
      name: rig,
      summary: `A squad for: ${prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt}`,
      pods: [
        {
          id: "swarm",
          label: "Squad",
          members: lanePlans.map((plan) => ({
            id: plan.lane,
            agentRef: "local:agents/lane",
            profile: "default",
            runtime,
            cwd: real,
            isolation: "worktree" as const,
            ...(setup ? { setup } : {}),
            gate,
            startup: {
              files: [],
              actions: [{ type: "send_text" as const, value: plan.brief, phase: "after_ready" as const, idempotent: false, appliesOn: ["fresh_start" as const] }],
            },
          })),
          edges: [],
        },
      ],
      edges: [],
    };
    const specYaml = RigSpecCodec.serialize(spec);
    const validation = RigSpecSchema.validate(RigSpecCodec.parse(specYaml));
    if (!validation.valid) throw invalid(`The generated rig spec is not valid: ${validation.errors.join("; ")}`);

    const dir = path.join(this.homeDir, "swarms", rig);
    const specPath = path.join(dir, "rig.yaml");
    const write = mode !== "preview";
    if (write) {
      fs.mkdirSync(path.join(dir, "agents", "lane"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agents", "lane", "agent.yaml"), LANE_AGENT_SPEC);
      fs.writeFileSync(specPath, specYaml);
    }
    const excluded = mode === "launch" ? await excludeHarnessFiles(top) : [];

    return {
      prompt,
      rig,
      repo: top,
      cwd: real,
      runtime,
      gate,
      gateBasis: request.gate ? "given with --gate" : `detected from ${detected.basis}`,
      setup,
      setupBasis: request.noSetup ? "turned off with --no-setup" : request.setup ? "given with --setup" : setup ? `detected from ${detected.basis}` : "none needed",
      lanes: lanePlans,
      specYaml,
      specPath,
      written: write,
      excluded,
    };
  }

  private lanesFor(requested: string[] | undefined): SwarmLaneId[] {
    if (requested === undefined) return [...SWARM_LANE_IDS];
    const unique = [...new Set(requested.map((lane) => lane.trim()).filter(Boolean))];
    const unknown = unique.filter((lane) => !(SWARM_LANE_IDS as readonly string[]).includes(lane));
    if (unique.length === 0 || unknown.length > 0) {
      throw invalid(`${unknown.length > 0 ? `Unknown lane ${unknown.join(", ")}. ` : "Name at least one lane. "}Choose from ${SWARM_LANE_IDS.join(", ")}.`);
    }
    return unique as SwarmLaneId[];
  }
}
