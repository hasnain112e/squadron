import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { formatLaunched, formatSwarmPlan, parseCommandText, parseRuntimeOption, swarmCommand, type SwarmPlanView } from "../src/commands/swarm.js";
import { startStubDaemon, useCommandRunner, type StubDaemon } from "./helpers/stub-daemon.js";

const lane = (name: string, summary: string, runtime = "claude-code") => ({
  lane: name,
  seat: `swarm.${name}`,
  runtime,
  session: `swarm-${name}@build-auth-api`,
  branch: `squad/build-auth-api/swarm.${name}`,
  summary,
  brief: `You are the ${name} seat.`,
});

const plan = (over: Partial<SwarmPlanView> = {}): SwarmPlanView => ({
  prompt: "Build Auth API",
  rig: "build-auth-api",
  repo: "/w/repo",
  cwd: "/w/repo",
  runtime: "claude-code",
  gate: ["npm", "test"],
  gateBasis: "detected from package.json scripts.test and package-lock.json",
  setup: ["npm", "ci"],
  setupBasis: "detected from package.json scripts.test and package-lock.json",
  lanes: [lane("backend", "Build the server side"), lane("frontend", "Build the client side"), lane("qa", "Write the tests")],
  specYaml: "name: build-auth-api\n",
  specPath: "/home/.openrig/swarms/build-auth-api/rig.yaml",
  written: false,
  excluded: [],
  ...over,
});

describe("parseCommandText", () => {
  it("splits words on any whitespace", () => {
    expect(parseCommandText("npm test")).toEqual(["npm", "test"]);
    expect(parseCommandText("  npm \t run   check  ")).toEqual(["npm", "run", "check"]);
  });

  it("keeps quoted text together, with either kind of quote, and lets one kind hold the other", () => {
    expect(parseCommandText('pytest -k "not slow"')).toEqual(["pytest", "-k", "not slow"]);
    expect(parseCommandText("pytest -k 'not slow'")).toEqual(["pytest", "-k", "not slow"]);
    expect(parseCommandText(`echo "it's" 'say "hi"'`)).toEqual(["echo", "it's", 'say "hi"']);
    expect(parseCommandText("a\"b c\"d")).toEqual(["ab cd"]);
  });

  it("takes an escaped quote or backslash inside double quotes, and leaves every other backslash alone", () => {
    expect(parseCommandText('echo "say \\"hi\\" \\\\ now"')).toEqual(["echo", 'say "hi" \\ now']);
    expect(parseCommandText("C:\\tools\\node.exe --version")).toEqual(["C:\\tools\\node.exe", "--version"]);
    expect(parseCommandText('"C:\\Program Files\\node.exe" -v')).toEqual(["C:\\Program Files\\node.exe", "-v"]);
  });

  it("makes an empty quoted argument an argument", () => {
    expect(parseCommandText('cmd "" x')).toEqual(["cmd", "", "x"]);
  });

  it("does not expand or split on shell operators, because nothing runs through a shell", () => {
    expect(parseCommandText("npm test && echo $HOME | cat")).toEqual(["npm", "test", "&&", "echo", "$HOME", "|", "cat"]);
  });

  it("refuses an empty command and a quote that is never closed", () => {
    expect(() => parseCommandText("   ")).toThrow("The command is empty.");
    expect(() => parseCommandText("")).toThrow("The command is empty.");
    expect(() => parseCommandText('pytest -k "not slow')).toThrow(/quote that is never closed/);
  });
});

describe("parseRuntimeOption", () => {
  it("takes one runtime for every lane", () => {
    expect(parseRuntimeOption("gemini")).toEqual({ runtime: "gemini" });
  });

  it("takes a runtime for single lanes, which is how Claude and Gemini seats share a squad", () => {
    expect(parseRuntimeOption("backend=claude-code,frontend=gemini")).toEqual({ runtimes: { backend: "claude-code", frontend: "gemini" } });
  });

  it("takes a default and the lanes that differ from it", () => {
    expect(parseRuntimeOption("claude-code,frontend=gemini")).toEqual({ runtime: "claude-code", runtimes: { frontend: "gemini" } });
    expect(parseRuntimeOption("frontend=gemini,claude-code")).toEqual({ runtime: "claude-code", runtimes: { frontend: "gemini" } });
  });

  it("ignores spaces around the items", () => {
    expect(parseRuntimeOption(" frontend = gemini , qa=codex ")).toEqual({ runtimes: { frontend: "gemini", qa: "codex" } });
  });

  it.each([
    ["an empty item", "backend=claude-code,,qa=codex", /empty item/],
    ["a trailing comma", "gemini,", /empty item/],
    ["two defaults", "claude-code,gemini", /two default runtimes \(claude-code and gemini\)/],
    ["a lane with no runtime", "frontend=", /must look like lane=runtime/],
    ["a runtime with no lane", "=gemini", /must look like lane=runtime/],
    ["the same lane twice", "qa=gemini,qa=codex", /names the lane qa twice/],
  ])("refuses %s", (_label, text, message) => {
    expect(() => parseRuntimeOption(text)).toThrow(message);
  });

  it("does not treat a lane named like an object property as already taken", () => {
    expect(parseRuntimeOption("constructor=gemini")).toEqual({ runtimes: { constructor: "gemini" } });
  });
});

describe("formatSwarmPlan", () => {
  it("shows the rig, the gate and setup with where they came from, and each seat's branch", () => {
    const lines = formatSwarmPlan(plan(), "preview").split("\n");

    expect(lines[0]).toBe("Squad for: Build Auth API");
    expect(lines[1]).toBe("Rig build-auth-api on claude-code, working in /w/repo");
    expect(lines[2]).toBe("Gate:  npm test (detected from package.json scripts.test and package-lock.json)");
    expect(lines[3]).toBe("Setup: npm ci (detected from package.json scripts.test and package-lock.json)");
    expect(lines).toContain("  backend   squad/build-auth-api/swarm.backend");
    expect(lines).toContain("            Build the server side");
    expect(lines).toContain("  qa        squad/build-auth-api/swarm.qa");
  });

  it("names the runtime when every seat has the same one, going by the seats and not by the default", () => {
    const allGemini = plan({ lanes: [lane("backend", "Build the server side", "gemini"), lane("qa", "Write the tests", "gemini")] });

    const text = formatSwarmPlan(allGemini, "preview");

    expect(text.split("\n")[1]).toBe("Rig build-auth-api on gemini, working in /w/repo");
    expect(text).not.toContain("Runtimes:");
  });

  it("lists each seat's runtime when Claude and Gemini seats share the squad", () => {
    const mixed = plan({ lanes: [lane("backend", "Build the server side"), lane("frontend", "Build the client side", "gemini"), lane("qa", "Write the tests")] });

    const lines = formatSwarmPlan(mixed, "preview").split("\n");

    expect(lines[1]).toBe("Rig build-auth-api on a mix of runtimes, working in /w/repo");
    expect(lines[2]).toBe("Runtimes: backend claude-code, frontend gemini, qa claude-code");
  });

  it("falls back to the plan's runtime for a daemon that does not name one per seat", () => {
    const older = plan({ runtime: "codex", lanes: [{ ...lane("backend", "x"), runtime: undefined as unknown as string }] });

    expect(formatSwarmPlan(older, "preview").split("\n")[1]).toBe("Rig build-auth-api on codex, working in /w/repo");
  });

  it("says the lanes are a template, and how to read what the seats are told", () => {
    const text = formatSwarmPlan(plan(), "preview");

    expect(text).toContain("fixed backend / frontend / qa template, not an agent's reading of your prompt");
    expect(text).toContain("To read them all: add --json.");
  });

  it("says when there is no setup, and quotes a command part that has spaces", () => {
    const text = formatSwarmPlan(plan({ setup: null, setupBasis: "turned off with --no-setup", gate: ["pytest", "-k", "not slow"] }), "preview");

    expect(text).toContain("Setup: none (turned off with --no-setup)");
    expect(text).toContain('Gate:  pytest -k "not slow" (');
  });

  it("says a preview changed nothing, and how to go on", () => {
    const text = formatSwarmPlan(plan(), "preview");

    expect(text).toContain("Preview only: nothing was written and nothing was started.");
    expect(text).toContain("Add --launch to start the squad, or --write to only write its rig spec.");
    expect(text).not.toContain("Wrote the rig spec");
  });

  it("names the file that was written, and how to start it, in write mode", () => {
    const text = formatSwarmPlan(plan({ written: true }), "write");

    expect(text).toContain("Wrote the rig spec: /home/.openrig/swarms/build-auth-api/rig.yaml");
    expect(text).toContain("Start it with: squad up /home/.openrig/swarms/build-auth-api/rig.yaml");
    expect(text).not.toContain("Preview only");
  });

  it("says what it hid from git in launch mode, and only when it hid something", () => {
    const hid = formatSwarmPlan(plan({ written: true, excluded: [".openrig/", ".claude/settings.local.json"] }), "launch");
    const already = formatSwarmPlan(plan({ written: true, excluded: [] }), "launch");

    expect(hid).toContain("Hid OpenRig's files from git in this repository (.openrig/, .claude/settings.local.json in .git/info/exclude)");
    expect(already).not.toContain("Hid OpenRig's files");
    expect(hid).not.toContain("Start it with: squad up"); // launching does that itself
  });
});

describe("formatLaunched", () => {
  it("tells the person how to watch the seats and what to run when they are done", () => {
    const text = formatLaunched(plan());

    expect(text).toContain("squad ps");
    expect(text).toContain("squad land build-auth-api --dry-run");
    expect(text).toMatch(/squad land build-auth-api$/m); // the real land, on a line of its own
  });
});

describe("squad swarm", () => {
  let daemon: StubDaemon | undefined;
  const up = vi.fn(async (_specPath: string) => true);
  const runCommand = useCommandRunner(() => swarmCommand({ up }));
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    up.mockClear();
    up.mockImplementation(async () => true);
  });

  const answersWith = (body: unknown, status = 200) => startStubDaemon(() => ({ status, body }));

  it("is registered on the program", () => {
    expect(createProgram().commands.some((command) => command.name() === "swarm")).toBe(true);
  });

  it("previews by default: asks the daemon for a plan in preview mode, prints it, and starts nothing", async () => {
    daemon = await answersWith({ ok: true, plan: plan() });

    const run = await runCommand(daemon.url, "swarm", "Build Auth API");

    expect(daemon.requests).toEqual([{ method: "POST", url: "/api/swarm", body: { prompt: "Build Auth API", cwd: process.cwd(), mode: "preview" } }]);
    expect(run.out).toContain("Squad for: Build Auth API");
    expect(run.out).toContain("Preview only");
    expect(up).not.toHaveBeenCalled();
    expect(run.exitCode).toBeUndefined();
  });

  it("sends what the person chose, with commands split into arguments", async () => {
    daemon = await answersWith({ ok: true, plan: plan({ written: true }) });

    const run = await runCommand(
      daemon.url,
      "swarm", "Fix login", "--write", "--lanes", "backend, qa", "--runtime", "codex", "--gate", 'pytest -k "not slow"', "--setup", "pip install -e .", "--name", "login",
    );

    expect(daemon.requests[0]!.body).toEqual({
      prompt: "Fix login",
      cwd: process.cwd(),
      mode: "write",
      name: "login",
      lanes: ["backend", "qa"],
      runtime: "codex",
      gate: ["pytest", "-k", "not slow"],
      setup: ["pip", "install", "-e", "."],
    });
    expect(run.out).toContain("Start it with: squad up");
    expect(up).not.toHaveBeenCalled();
  });

  it("sends one runtime for every seat, or a runtime for single seats, as the daemon expects them", async () => {
    daemon = await answersWith({ ok: true, plan: plan() });

    await runCommand(daemon.url, "swarm", "Build Auth API", "--runtime", "gemini");
    await runCommand(daemon.url, "swarm", "Build Auth API", "--runtime", "backend=claude-code,frontend=gemini");
    await runCommand(daemon.url, "swarm", "Build Auth API", "--runtime", "claude-code,frontend=gemini");

    expect(daemon.requests.map((request) => request.body)).toEqual([
      { prompt: "Build Auth API", cwd: process.cwd(), mode: "preview", runtime: "gemini" },
      { prompt: "Build Auth API", cwd: process.cwd(), mode: "preview", runtimes: { backend: "claude-code", frontend: "gemini" } },
      { prompt: "Build Auth API", cwd: process.cwd(), mode: "preview", runtime: "claude-code", runtimes: { frontend: "gemini" } },
    ]);
  });

  it("refuses a --runtime it cannot read, without contacting the daemon", async () => {
    daemon = await answersWith({});

    const run = await runCommand(daemon.url, "swarm", "x", "--runtime", "claude-code,gemini");

    expect(run.err).toMatch(/two default runtimes/);
    expect(run.exitCode).toBe(1);
    expect(daemon.requests).toEqual([]);
  });

  it("turns setup off with --no-setup", async () => {
    daemon = await answersWith({ ok: true, plan: plan({ setup: null }) });

    await runCommand(daemon.url, "swarm", "Fix login", "--no-setup");

    expect(daemon.requests[0]!.body).toMatchObject({ noSetup: true });
    expect(daemon.requests[0]!.body).not.toHaveProperty("setup");
  });

  it("launches by writing the spec through the daemon, then running up on the file it wrote", async () => {
    daemon = await answersWith({ ok: true, plan: plan({ written: true, excluded: [".openrig/"] }) });

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--launch");

    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]!.body).toMatchObject({ mode: "launch" });
    expect(up).toHaveBeenCalledExactlyOnceWith("/home/.openrig/swarms/build-auth-api/rig.yaml");
    expect(run.out).toContain("The squad is starting.");
    expect(run.out).toContain("squad land build-auth-api --dry-run");
    expect(run.exitCode).toBeUndefined();
  });

  it("does not say the squad is starting when up did not start it", async () => {
    up.mockImplementation(async () => {
      process.exitCode = 1; // what `up` does when it fails, after saying why
      return false;
    });
    daemon = await answersWith({ ok: true, plan: plan({ written: true }) });

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--launch");

    expect(up).toHaveBeenCalledOnce();
    expect(run.out).not.toContain("The squad is starting.");
    expect(run.exitCode).toBe(1);
  });

  it("prints the whole plan as JSON, briefs included, with --json", async () => {
    daemon = await answersWith({ ok: true, plan: plan() });

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--json");

    expect(JSON.parse(run.out)).toMatchObject({ rig: "build-auth-api", lanes: [{ brief: "You are the backend seat." }, {}, {}] });
  });

  it("refuses --launch with --write or --json, without contacting the daemon", async () => {
    daemon = await answersWith({});

    const both = await runCommand(daemon.url, "swarm", "x", "--launch", "--write");
    const json = await runCommand(daemon.url, "swarm", "x", "--launch", "--json");

    expect(both.err).toContain("--launch already writes the rig spec");
    expect(json.err).toContain("--json cannot be used with --launch");
    expect(both.exitCode).toBe(1);
    expect(json.exitCode).toBe(1);
    expect(daemon.requests).toEqual([]);
  });

  it("refuses a command it cannot read, without contacting the daemon", async () => {
    daemon = await answersWith({});

    const run = await runCommand(daemon.url, "swarm", "x", "--gate", 'pytest -k "not slow');

    expect(run.err).toMatch(/quote that is never closed/);
    expect(run.exitCode).toBe(1);
    expect(daemon.requests).toEqual([]);
  });

  it("shows the daemon's reason, starts nothing and exits non-zero when the plan cannot be made", async () => {
    daemon = await answersWith({ ok: false, code: "failed", error: "No test command was found. Pass one with --gate." }, 409);

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--launch");

    expect(run.err).toBe("No test command was found. Pass one with --gate.");
    expect(run.out).toBe("");
    expect(up).not.toHaveBeenCalled();
    expect(run.exitCode).toBe(1);
  });

  it("says so when the daemon is not running", async () => {
    daemon = await answersWith({});
    const url = daemon.url;
    await daemon.close();
    daemon = undefined;

    const run = await runCommand(url, "swarm", "Build Auth API");

    expect(run.err).toContain("Could not reach the daemon");
    expect(up).not.toHaveBeenCalled();
    expect(run.exitCode).toBe(1);
  });
});
