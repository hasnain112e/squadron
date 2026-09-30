import * as fs from "node:fs";
import * as path from "node:path";

// The pure parts of `squad swarm`: which lanes exist, what each seat is told, and how to find a repository's
// test command. The lanes are a fixed template, not an agent's reading of the prompt, and every place that
// shows them says so.

export const SWARM_LANE_IDS = ["backend", "frontend", "qa"] as const;
export type SwarmLaneId = (typeof SWARM_LANE_IDS)[number];

/** What a lane does. QA's job depends on which builders are in the squad, so it is a function of them. */
function jobFor(lane: SwarmLaneId, others: SwarmLaneId[]): string {
  if (lane === "backend") return "You build the server side: the data, the logic and the API.";
  if (lane === "frontend") return "You build the client side: the screens, and the calls to the API.";
  const builders = others.filter((other) => other !== "qa");
  const opening =
    "You write the tests for the task from its description, before the code exists. Test behaviour that a user or a client can observe, not internal details.";
  if (builders.length === 0) return `${opening} Base your tests on the task.`;
  const who = builders.length === 1 ? `The ${builders[0]} seat works` : `The ${builders.join(" and ")} seats work`;
  return (
    `${opening} ${who} at the same time and you cannot see their code, so base your tests on the task and on any API you agree with them. ` +
    "The integration gate will run your tests on their merged work."
  );
}

/** The one line that says what the lane is for, for the plan. */
export const LANE_SUMMARIES: Record<SwarmLaneId, string> = {
  backend: "Build the server side: data, logic and API",
  frontend: "Build the client side: screens and calls to the API",
  qa: "Write the tests from the prompt; the integration gate runs them on the merged work",
};

/** The rig name for a prompt: lowercase letters, digits and dashes, at most 40 characters. */
export function rigNameFor(prompt: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
  return slug || "swarm";
}

/** What one seat is told when it starts. Written as plain text so it can be pasted into the seat's terminal as one message. */
export function laneBrief(input: {
  lane: SwarmLaneId;
  prompt: string;
  rig: string;
  teammates: Array<{ lane: SwarmLaneId; session: string }>;
}): string {
  const others = input.teammates.filter((teammate) => teammate.lane !== input.lane);
  const lines = [
    `You are the ${input.lane} seat in a squad of AI agents that build this together:`,
    "",
    input.prompt,
    "",
    jobFor(input.lane, others.map((teammate) => teammate.lane)),
    "",
    "Rules:",
    `- Work only in your own git worktree, which is your current directory.${others.length > 0 ? " Your teammates work in theirs." : ""}`,
    "- Commit early and often on your branch.",
    "- Stage only the files you changed, by name. Never run `git add -A`, and never commit anything under .openrig/ or .claude/.",
  ];
  if (others.length > 0) {
    const team = others.map((teammate) => `${teammate.lane} (${teammate.session})`).join(", ");
    const lanesInSquad = new Set(input.teammates.map((teammate) => teammate.lane));
    // Only two seats can share an API, and only if both are in the squad.
    const apiRule = lanesInSquad.has("backend") && lanesInSquad.has("frontend") ? " Agree the API between backend and frontend that way before you build against it." : "";
    lines.push(`- Your teammates: ${team}. Message one with: squad send <session> "<message>".${apiRule}`);
  }
  lines.push(
    "- When your work is committed, run: squad gate run",
    "- If the gate fails, fix the cause, commit, and run it again.",
    `- Do not merge, rebase onto other lanes, or push. A person will run: squad land ${input.rig}`,
  );
  return lines.join("\n");
}

export interface DetectedCommands {
  gate: string[] | null;
  setup: string[] | null;
  /** Where the answer came from, or why there is none. Shown to the person. */
  basis: string;
}

/**
 * Find the test command, and the install command that goes with it, from the files in `dir`. Conservative:
 * a repository whose test script is only npm's placeholder has no test command, and a project it cannot
 * read confidently gets no answer, so the person passes one with --gate rather than gating on a guess.
 */
export function detectProject(dir: string): DetectedCommands {
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  };

  if (has("package.json")) {
    let test: unknown;
    try {
      test = (JSON.parse(read("package.json")) as { scripts?: { test?: unknown } }).scripts?.test;
    } catch {
      /* an unreadable package.json says nothing; try the other kinds of project */
    }
    if (typeof test === "string" && test.trim() && !/no test specified/i.test(test)) {
      if (has("pnpm-lock.yaml")) {
        return { gate: ["pnpm", "test"], setup: ["pnpm", "install", "--frozen-lockfile"], basis: "package.json scripts.test and pnpm-lock.yaml" };
      }
      if (has("yarn.lock")) {
        // Yarn 2 and later dropped --frozen-lockfile for --immutable; .yarnrc.yml marks those.
        const setup = has(".yarnrc.yml") ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"];
        return { gate: ["yarn", "test"], setup, basis: "package.json scripts.test and yarn.lock" };
      }
      if (has("bun.lock") || has("bun.lockb")) {
        return { gate: null, setup: null, basis: "this is a bun project, and its commands are not detected" };
      }
      if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
        return { gate: ["npm", "test"], setup: ["npm", "ci"], basis: "package.json scripts.test and package-lock.json" };
      }
      return { gate: ["npm", "test"], setup: ["npm", "install"], basis: "package.json scripts.test (there is no lockfile)" };
    }
  }
  if (has("pytest.ini") || /pytest/i.test(read("pyproject.toml") + read("setup.cfg") + read("tox.ini"))) {
    return { gate: [process.platform === "win32" ? "python" : "python3", "-m", "pytest"], setup: null, basis: "pytest configuration" };
  }
  if (has("Cargo.toml")) return { gate: ["cargo", "test"], setup: null, basis: "Cargo.toml" };
  if (has("go.mod")) return { gate: ["go", "test", "./..."], setup: null, basis: "go.mod" };
  return { gate: null, setup: null, basis: "no package.json test script, pytest configuration, Cargo.toml or go.mod was found" };
}
