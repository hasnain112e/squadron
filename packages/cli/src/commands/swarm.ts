import { Command } from "commander";
import { commandLine } from "./gate.js";
import { askDaemon, refused } from "./sandbox-client.js";

// `squad swarm <prompt>` — plan a squad of isolated, gated agent seats for a prompt. The daemon does the
// planning and writes the rig spec; this command asks and reports. By default it only shows the plan.
// `--write` writes the rig spec, `--launch` also starts the seats by running `up` on that spec. The lanes
// (backend, frontend, qa) are a fixed template, not an agent's reading of the prompt, and the output says so.

export type SwarmMode = "preview" | "write" | "launch";

export interface SwarmPlanView {
  prompt: string;
  rig: string;
  repo: string;
  cwd: string;
  runtime: string;
  gate: string[];
  gateBasis: string;
  setup: string[] | null;
  setupBasis: string;
  lanes: Array<{ lane: string; seat: string; runtime: string; session: string; branch: string; summary: string; brief: string }>;
  specYaml: string;
  specPath: string;
  written: boolean;
  excluded: string[];
}

/**
 * Split command text into arguments: words, with single or double quotes to keep spaces together. There is no
 * expansion and there are no operators, because the daemon runs the result directly, without a shell.
 * Backslashes are plain characters (Windows paths) except before a quote or a backslash inside double quotes.
 */
export function parseCommandText(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true; // "" is an argument, an empty one
    } else if (/\s/.test(ch)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`The command has a ${quote} quote that is never closed: ${text}`);
  if (inWord) args.push(current);
  if (args.length === 0) throw new Error("The command is empty.");
  return args;
}

/**
 * The --runtime value. A runtime alone is for every lane ("gemini"). `lane=runtime` is for one lane
 * ("backend=claude-code,frontend=gemini"), which is how Claude and Gemini seats share a squad. A runtime
 * without `=` among those is the default for the lanes that name none ("claude-code,frontend=gemini").
 * Whether the names are real is the daemon's to say.
 */
export function parseRuntimeOption(text: string): { runtime?: string; runtimes?: Record<string, string> } {
  let runtime: string | undefined;
  const runtimes: Record<string, string> = {};
  for (const item of text.split(",").map((part) => part.trim())) {
    if (!item) throw new Error(`--runtime has an empty item: "${text}"`);
    const eq = item.indexOf("=");
    if (eq === -1) {
      if (runtime !== undefined) throw new Error(`--runtime names two default runtimes (${runtime} and ${item}). Give one, and use lane=runtime for the lanes that differ.`);
      runtime = item;
      continue;
    }
    const lane = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!lane || !value) throw new Error(`--runtime item "${item}" must look like lane=runtime, for example frontend=gemini.`);
    if (Object.prototype.hasOwnProperty.call(runtimes, lane)) throw new Error(`--runtime names the lane ${lane} twice.`);
    runtimes[lane] = value;
  }
  return { ...(runtime === undefined ? {} : { runtime }), ...(Object.keys(runtimes).length === 0 ? {} : { runtimes }) };
}

/** A plan as text, and what to do next for the mode it was made in. */
export function formatSwarmPlan(plan: SwarmPlanView, mode: SwarmMode): string {
  const width = Math.max(...plan.lanes.map((lane) => lane.lane.length));
  const runtimeOf = (lane: SwarmPlanView["lanes"][number]) => lane.runtime ?? plan.runtime;
  const mixed = new Set(plan.lanes.map(runtimeOf)).size > 1;
  const lines = [
    `Squad for: ${plan.prompt}`,
    `Rig ${plan.rig} on ${mixed ? "a mix of runtimes" : plan.lanes[0] ? runtimeOf(plan.lanes[0]) : plan.runtime}, working in ${plan.cwd}`,
    ...(mixed ? [`Runtimes: ${plan.lanes.map((lane) => `${lane.lane} ${runtimeOf(lane)}`).join(", ")}`] : []),
    `Gate:  ${commandLine(plan.gate)} (${plan.gateBasis})`,
    `Setup: ${plan.setup ? commandLine(plan.setup) : "none"} (${plan.setupBasis})`,
    "",
    "Seats, each in its own git worktree on its own branch:",
  ];
  for (const lane of plan.lanes) {
    lines.push(`  ${lane.lane.padEnd(width)}  ${lane.branch}`);
    lines.push(`  ${" ".repeat(width)}  ${lane.summary}`);
  }
  lines.push(
    "",
    "The lanes are a fixed backend / frontend / qa template, not an agent's reading of your prompt.",
    "Each seat is told the task and the working rules when it starts. To read them all: add --json.",
  );
  if (mode === "preview") {
    lines.push("", "Preview only: nothing was written and nothing was started.", "Add --launch to start the squad, or --write to only write its rig spec.");
  } else {
    lines.push("", `Wrote the rig spec: ${plan.specPath}`);
    if (plan.excluded.length > 0) {
      lines.push(`Hid OpenRig's files from git in this repository (${plan.excluded.join(", ")} in .git/info/exclude), so a seat cannot commit them.`);
    }
    if (mode === "write") lines.push(`Start it with: squad up ${plan.specPath}`);
  }
  return lines.join("\n");
}

/** What to do once the squad is running. */
export function formatLaunched(plan: SwarmPlanView): string {
  return [
    "",
    `The squad is starting. Each seat gets its brief when it is ready. Watch the seats with: squad ps`,
    `Each seat runs its own gate when its work is committed. When they have, check with: squad land ${plan.rig} --dry-run`,
    `Then land the work on an integration branch for you to review: squad land ${plan.rig}`,
  ].join("\n");
}

/** Run `up` on the written spec. True when it succeeded; `up` has already said why when it did not. */
async function runUp(specPath: string): Promise<boolean> {
  const { upCommand } = await import("./up.js");
  await upCommand().parseAsync(["node", "up", specPath]);
  return !process.exitCode;
}

export interface SwarmDeps {
  /** Start the rig written at this path. True when it started. Replaceable so tests need no daemon to launch with. */
  up?: (specPath: string) => Promise<boolean>;
}

interface SwarmOptions {
  launch?: boolean;
  write?: boolean;
  lanes?: string;
  runtime?: string;
  gate?: string;
  setup?: string | false;
  name?: string;
  json?: boolean;
}

export function swarmCommand(deps: SwarmDeps = {}): Command {
  const up = deps.up ?? runUp;
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
  };

  return new Command("swarm")
    .description("Plan a squad of isolated, gated agent seats for a prompt: a preview by default, --launch to start it")
    .argument("<prompt>", "What the squad should build")
    .option("--launch", "Start the squad: write its rig spec, then run it with `up`")
    .option("--write", "Write the rig spec under the instance directory without starting it")
    .option("--lanes <lanes>", "The lanes to include, separated by commas: backend, frontend, qa (default: all three)")
    .option("--runtime <runtimes>", "Runtime of the seats: claude-code, codex or gemini (default: claude-code). One lane at a time: backend=claude-code,frontend=gemini")
    .option("--gate <command>", "The test command that decides whether a seat's work may land (default: found from the project)")
    .option("--setup <command>", "Command run once in each new worktree, such as an install (default: found from the project)")
    .option("--no-setup", "Run no setup command in the worktrees")
    .option("--name <name>", "Rig name (default: made from the prompt)")
    .option("--json", "Output the plan as JSON, including the brief of each seat (not with --launch)")
    .action(async (prompt: string, opts: SwarmOptions) => {
      if (opts.launch && opts.write) return fail("--launch already writes the rig spec. Use --launch or --write, not both.");
      if (opts.launch && opts.json) return fail("--json cannot be used with --launch. Run with --write --json, then start the rig with: squad up <the spec path>");

      let gate: string[] | undefined;
      let setup: string[] | undefined;
      let runtimeChoice: ReturnType<typeof parseRuntimeOption> = {};
      try {
        gate = opts.gate === undefined ? undefined : parseCommandText(opts.gate);
        setup = typeof opts.setup === "string" ? parseCommandText(opts.setup) : undefined;
        runtimeChoice = opts.runtime === undefined ? {} : parseRuntimeOption(opts.runtime);
      } catch (err) {
        return fail(`${(err as Error).message}`);
      }

      const mode: SwarmMode = opts.launch ? "launch" : opts.write ? "write" : "preview";
      const lanes = opts.lanes?.split(",").map((lane) => lane.trim()).filter(Boolean);
      const res = await askDaemon((client) =>
        client.post<{ ok?: boolean; plan?: SwarmPlanView; error?: string }>(
          "/api/swarm",
          {
            prompt,
            cwd: process.cwd(),
            mode,
            ...(opts.name === undefined ? {} : { name: opts.name }),
            ...(lanes === undefined ? {} : { lanes }),
            ...runtimeChoice,
            ...(gate === undefined ? {} : { gate }),
            ...(setup === undefined ? {} : { setup }),
            ...(opts.setup === false ? { noSetup: true } : {}),
          },
          { timeoutMs: 60_000 },
        ),
      );
      if (!res) return;
      if (!res.data.ok || !res.data.plan) return refused(res.status, res.data);

      const plan = res.data.plan;
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(formatSwarmPlan(plan, mode));
      if (mode !== "launch") return;
      console.log("");
      if (await up(plan.specPath)) console.log(formatLaunched(plan));
    });
}
