import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";
import { LANE_AGENT_SPEC, SwarmService, excludeHarnessFiles, parseSwarmRequest, type SwarmRequest } from "../src/domain/swarm-service.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// Real git and the real rig-spec schema: a generated spec is only worth having if the daemon accepts it.
describe("SwarmService", { timeout: 60_000 }, () => {
  let tmp: string;
  let repo: string;
  let home: string;
  let service: SwarmService;
  const excludeFile = () => path.join(repo, ".git", "info", "exclude");
  /** git init already makes this file, with comments in it, so "untouched" means our lines are not in it. */
  const excludeText = () => (fs.existsSync(excludeFile()) ? fs.readFileSync(excludeFile(), "utf8") : "");

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-swarm-")));
    repo = path.join(tmp, "repo");
    home = path.join(tmp, "home");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
    fs.writeFileSync(path.join(repo, "package-lock.json"), "{}");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");
    service = new SwarmService(home);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const request = (over: Partial<SwarmRequest> = {}): SwarmRequest => ({ prompt: "Build Auth API", cwd: repo, ...over });

  describe("planning", () => {
    it("shows what would happen and writes nothing, not even the instance directory", async () => {
      const plan = await service.plan(request());

      expect(plan).toMatchObject({
        rig: "build-auth-api",
        repo,
        cwd: repo,
        runtime: "claude-code",
        gate: ["npm", "test"],
        gateBasis: "detected from package.json scripts.test and package-lock.json",
        setup: ["npm", "ci"],
        written: false,
        excluded: [],
        specPath: path.join(home, "swarms", "build-auth-api", "rig.yaml"),
      });
      expect(plan.lanes.map((lane) => lane.seat)).toEqual(["swarm.backend", "swarm.frontend", "swarm.qa"]);
      expect(plan.lanes.map((lane) => lane.session)).toEqual(["swarm-backend@build-auth-api", "swarm-frontend@build-auth-api", "swarm-qa@build-auth-api"]);
      // The real branches the sandbox will create, not invented ones.
      expect(plan.lanes.map((lane) => lane.branch)).toEqual([
        "squad/build-auth-api/swarm.backend",
        "squad/build-auth-api/swarm.frontend",
        "squad/build-auth-api/swarm.qa",
      ]);
      expect(fs.existsSync(home)).toBe(false);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });

    it("generates a spec the real schema accepts: isolated, set up and gated members with one brief each", async () => {
      const plan = await service.plan(request());

      const parsed = RigSpecCodec.parse(plan.specYaml);
      expect(RigSpecSchema.validate(parsed).errors).toEqual([]);
      const spec = RigSpecSchema.normalize(parsed);
      expect(spec.name).toBe("build-auth-api");
      expect(spec.pods).toHaveLength(1);
      expect(spec.pods[0]!.id).toBe("swarm");
      const members = spec.pods[0]!.members;
      expect(members.map((member) => member.id)).toEqual(["backend", "frontend", "qa"]);
      for (const member of members) {
        expect(member).toMatchObject({ isolation: "worktree", cwd: repo, runtime: "claude-code", agentRef: "local:agents/lane", setup: ["npm", "ci"], gate: ["npm", "test"] });
        expect(member.startup?.actions).toHaveLength(1);
        expect(member.startup!.actions[0]).toMatchObject({ type: "send_text", phase: "after_ready", idempotent: false, appliesOn: ["fresh_start"] });
      }
      // The brief in the spec is exactly the brief in the plan, multi-line text intact.
      members.forEach((member, index) => expect(member.startup!.actions[0]!.value).toBe(plan.lanes[index]!.brief));
      expect(plan.lanes[0]!.brief).toContain("Build Auth API");
      expect(plan.lanes[0]!.brief.split("\n").length).toBeGreaterThan(5);
    });

    it("works from the directory the person ran the command in, so a package of a monorepo gets its own commands", async () => {
      const pkg = path.join(repo, "packages", "api");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "api", scripts: { test: "node --test" } }));
      fs.writeFileSync(path.join(pkg, "pnpm-lock.yaml"), "");
      git(repo, "add", ".");
      git(repo, ...IDENT, "commit", "-q", "-m", "add api package");

      const plan = await service.plan(request({ cwd: pkg }));

      expect(plan).toMatchObject({ repo, cwd: pkg, gate: ["pnpm", "test"], setup: ["pnpm", "install", "--frozen-lockfile"] });
      expect(RigSpecSchema.normalize(RigSpecCodec.parse(plan.specYaml)).pods[0]!.members[0]!.cwd).toBe(pkg);
    });

    it("takes the lanes, runtime, name, gate and setup the person asked for", async () => {
      const plan = await service.plan(
        request({ lanes: ["qa", "backend", "qa"], runtime: "codex", name: "auth-squad", gate: ["node", "--test"], setup: ["node", "prepare.js"] }),
      );

      expect(plan).toMatchObject({
        rig: "auth-squad",
        runtime: "codex",
        gate: ["node", "--test"],
        gateBasis: "given with --gate",
        setup: ["node", "prepare.js"],
        setupBasis: "given with --setup",
      });
      expect(plan.lanes.map((lane) => lane.lane)).toEqual(["qa", "backend"]);
      expect(plan.lanes[0]!.session).toBe("swarm-qa@auth-squad");
      expect(RigSpecSchema.validate(RigSpecCodec.parse(plan.specYaml)).errors).toEqual([]);
    });

    it("runs a whole squad on Gemini, or a mix: one default runtime, and a different one for the lanes that name it", async () => {
      const allGemini = await service.plan(request({ runtime: "gemini" }));
      expect(allGemini.runtime).toBe("gemini");
      expect(allGemini.lanes.map((lane) => lane.runtime)).toEqual(["gemini", "gemini", "gemini"]);

      const mixed = await service.plan(request({ runtimes: { frontend: "gemini", qa: "codex" } }));
      const runtimeOfEach = (lanes: Array<{ lane: string; runtime: string }>) => Object.fromEntries(lanes.map((lane) => [lane.lane, lane.runtime]));
      expect(mixed.runtime).toBe("claude-code");
      expect(runtimeOfEach(mixed.lanes)).toEqual({ backend: "claude-code", frontend: "gemini", qa: "codex" });

      // What gets launched is the rig spec, so each seat's runtime has to be in it, and the real schema has to accept it.
      const parsed = RigSpecCodec.parse(mixed.specYaml);
      expect(RigSpecSchema.validate(parsed).errors).toEqual([]);
      const members = RigSpecSchema.normalize(parsed).pods[0]!.members;
      expect(Object.fromEntries(members.map((member) => [member.id, member.runtime]))).toEqual({ backend: "claude-code", frontend: "gemini", qa: "codex" });
    });

    it("lets the default runtime be Gemini with one lane on Claude", async () => {
      const plan = await service.plan(request({ runtime: "gemini", runtimes: { backend: "claude-code" } }));

      expect(plan.lanes.map((lane) => [lane.lane, lane.runtime])).toEqual([["backend", "claude-code"], ["frontend", "gemini"], ["qa", "gemini"]]);
    });

    it("turns setup off when asked", async () => {
      const plan = await service.plan(request({ noSetup: true }));

      expect(plan.setup).toBeNull();
      expect(plan.setupBasis).toBe("turned off with --no-setup");
      expect(plan.specYaml).not.toContain("setup:");
    });

    it("plans a repository with no install step, such as a Rust one, without a setup line", async () => {
      fs.rmSync(path.join(repo, "package.json"));
      fs.rmSync(path.join(repo, "package-lock.json"));
      fs.writeFileSync(path.join(repo, "Cargo.toml"), '[package]\nname = "x"\n');
      git(repo, "add", "-A");
      git(repo, ...IDENT, "commit", "-q", "-m", "rust");

      const plan = await service.plan(request());

      expect(plan).toMatchObject({ gate: ["cargo", "test"], setup: null, setupBasis: "none needed" });
    });
  });

  describe("writing", () => {
    it("writes the rig spec and the agent spec under the instance directory, and nothing into the repository", async () => {
      const plan = await service.plan(request({ mode: "write" }));

      expect(plan.written).toBe(true);
      expect(fs.readFileSync(plan.specPath, "utf8")).toBe(plan.specYaml);
      const agent = fs.readFileSync(path.join(home, "swarms", "build-auth-api", "agents", "lane", "agent.yaml"), "utf8");
      expect(agent).toContain("name: lane");
      expect(plan.excluded).toEqual([]);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });

    it("writes it again over an earlier one for the same rig", async () => {
      await service.plan(request({ mode: "write", gate: ["node", "old.js"] }));

      const plan = await service.plan(request({ mode: "write", gate: ["node", "new.js"] }));

      expect(fs.readFileSync(plan.specPath, "utf8")).toContain("new.js");
      expect(fs.readFileSync(plan.specPath, "utf8")).not.toContain("old.js");
    });
  });

  describe("launching", () => {
    it("hides OpenRig's own files from git in every worktree, so a seat's git add -A cannot commit them", async () => {
      const plan = await service.plan(request({ mode: "launch" }));
      expect(plan.excluded).toEqual([".openrig/", ".claude/settings.local.json"]);

      // Prove it with a real worktree, the way a seat would see it.
      git(repo, "worktree", "add", "-q", path.join(tmp, "seat"), "-b", "lane", "HEAD");
      fs.mkdirSync(path.join(tmp, "seat", ".openrig"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "seat", ".openrig", "context-collector.cjs"), "x");
      fs.mkdirSync(path.join(tmp, "seat", ".claude"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "seat", ".claude", "settings.local.json"), "{}");
      fs.writeFileSync(path.join(tmp, "seat", "work.txt"), "real work");
      git(tmp + "/seat", "add", "-A");
      expect(git(path.join(tmp, "seat"), "diff", "--cached", "--name-only")).toBe("work.txt");
    });

    it("adds them once, keeps what was already in the exclude file, and leaves the repository status clean", async () => {
      fs.mkdirSync(path.dirname(excludeFile()), { recursive: true });
      fs.writeFileSync(excludeFile(), "*.log");

      const first = await service.plan(request({ mode: "launch" }));
      const second = await service.plan(request({ mode: "launch" }));

      expect(first.excluded).toHaveLength(2);
      expect(second.excluded).toEqual([]);
      const text = fs.readFileSync(excludeFile(), "utf8");
      expect(text.startsWith("*.log\n")).toBe(true);
      expect(text.match(/\.openrig\//g)).toHaveLength(1);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });

    it("finds the shared exclude file even when run from inside a linked worktree", async () => {
      git(repo, "worktree", "add", "-q", path.join(tmp, "inner"), "-b", "inner", "HEAD");

      const added = await excludeHarnessFiles(path.join(tmp, "inner"));

      expect(added).toEqual([".openrig/", ".claude/settings.local.json"]);
      expect(fs.readFileSync(excludeFile(), "utf8")).toContain(".openrig/");
    });

    it("does not touch the exclude file when only previewing or writing", async () => {
      const before = excludeText();

      await service.plan(request({ mode: "preview" }));
      await service.plan(request({ mode: "write" }));

      expect(excludeText()).toBe(before);
      expect(excludeText()).not.toContain(".openrig/");
    });
  });

  describe("refusing", () => {
    const refuses = async (over: Partial<SwarmRequest>, code: string, message: RegExp) => {
      await expect(service.plan(request(over))).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    };

    it("an empty prompt, and one that is too long", async () => {
      await refuses({ prompt: "   " }, "invalid", /needs a prompt/);
      await refuses({ prompt: "x".repeat(8001) }, "invalid", /longer than 8000/);
    });

    it("lanes that do not exist, or none at all", async () => {
      await refuses({ lanes: ["backend", "devops"] }, "invalid", /Unknown lane devops\. Choose from backend, frontend, qa/);
      await refuses({ lanes: [] }, "invalid", /Name at least one lane/);
    });

    it("a runtime or a rig name that cannot be used", async () => {
      await refuses({ runtime: "gpt" }, "invalid", /runtime must be one of claude-code, codex, gemini\./);
      await refuses({ name: "Bad Name!" }, "invalid", /rig name "Bad Name!" cannot be used/);
    });

    it("a runtime for a lane that is not in the squad, or one that does not exist", async () => {
      await refuses({ runtimes: { devops: "gemini" } }, "invalid", /runtimes names the lane "devops", which is not in this squad \(backend, frontend, qa\)/);
      await refuses({ lanes: ["backend"], runtimes: { qa: "gemini" } }, "invalid", /which is not in this squad \(backend\)/);
      await refuses({ runtimes: { qa: "gpt" } }, "invalid", /The runtime for qa must be one of claude-code, codex, gemini\./);
    });

    it("a directory that is not in a git repository, and a repository with no commits", async () => {
      const plain = path.join(tmp, "plain");
      fs.mkdirSync(plain);
      await refuses({ cwd: plain }, "failed", /needs a git repository/);

      const empty = path.join(tmp, "empty");
      fs.mkdirSync(empty);
      git(empty, "init", "-q", "-b", "main");
      await refuses({ cwd: empty }, "failed", /no commits yet/);
    });

    it("a repository where no test command can be found, telling the person how to give one", async () => {
      fs.rmSync(path.join(repo, "package.json"));
      git(repo, "add", "-A");
      git(repo, ...IDENT, "commit", "-q", "-m", "no tests");

      await refuses({}, "failed", /No test command was found: no package\.json test script.*Pass one with --gate, for example: --gate "npm test"/);
      await expect(service.plan(request({ gate: ["make", "check"], noSetup: true }))).resolves.toMatchObject({ gate: ["make", "check"] });
    });

    it("writes nothing when it refuses", async () => {
      const before = excludeText();

      await expect(service.plan(request({ mode: "launch", lanes: ["nope"] }))).rejects.toThrow();

      expect(fs.existsSync(home)).toBe(false);
      expect(excludeText()).toBe(before);
    });
  });
});

describe("the agent spec every lane uses", () => {
  it("is accepted by the real agent spec validator, so a change to the format fails here and not on someone's first launch", () => {
    const result = validateAgentSpec(parseAgentSpec(LANE_AGENT_SPEC));

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("parseSwarmRequest", () => {
  const good ={ prompt: "Build it", cwd: path.resolve("/somewhere") };

  it("accepts a full request and a minimal one", () => {
    expect(parseSwarmRequest(good)).toMatchObject({ prompt: "Build it" });
    expect(parseSwarmRequest({ ...good, mode: "launch", name: "n", lanes: ["qa"], runtime: "codex", gate: ["a"], setup: ["b"], noSetup: false })).toMatchObject({
      mode: "launch",
      lanes: ["qa"],
    });
    expect(parseSwarmRequest({ ...good, runtime: "claude-code", runtimes: { frontend: "gemini" } })).toMatchObject({
      runtime: "claude-code",
      runtimes: { frontend: "gemini" },
    });
  });

  it.each([
    ["not an object", "text", /JSON object/],
    ["an array", [], /JSON object/],
    ["no prompt", { cwd: good.cwd }, /prompt is required/],
    ["a non-string prompt", { ...good, prompt: 5 }, /prompt must be a string/],
    ["no cwd", { prompt: "x" }, /cwd is required/],
    ["a relative cwd", { ...good, cwd: "repo" }, /absolute path/],
    ["an unknown mode", { ...good, mode: "explode" }, /mode must be one of preview, write, launch/],
    ["lanes that are not strings", { ...good, lanes: [1] }, /lanes must be a list of strings/],
    ["a gate that is a string", { ...good, gate: "npm test" }, /gate must be a list of strings/],
    ["a noSetup that is not a boolean", { ...good, noSetup: "yes" }, /noSetup must be true or false/],
    ["runtimes that is a list", { ...good, runtimes: ["gemini"] }, /runtimes must map a lane to a runtime/],
    ["runtimes that is null", { ...good, runtimes: null }, /runtimes must map a lane to a runtime/],
    ["a runtime in runtimes that is not text", { ...good, runtimes: { qa: 3 } }, /runtimes must map a lane to a runtime/],
  ])("rejects %s", (_label, body, message) => {
    expect(() => parseSwarmRequest(body)).toThrow(message);
    try {
      parseSwarmRequest(body);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalid");
    }
  });
});
