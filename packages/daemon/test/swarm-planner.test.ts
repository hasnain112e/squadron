import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SWARM_LANE_IDS, detectProject, laneBrief, rigNameFor } from "../src/domain/swarm-planner.js";

describe("rigNameFor", () => {
  it("makes a short name of lowercase letters, digits and dashes", () => {
    expect(rigNameFor("Build Auth API")).toBe("build-auth-api");
    expect(rigNameFor("  Fix the *login* bug!!  ")).toBe("fix-the-login-bug");
    expect(rigNameFor("x".repeat(100))).toBe("x".repeat(40));
  });

  it("never returns an empty name", () => {
    expect(rigNameFor("!!!")).toBe("swarm");
  });
});

describe("detectProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-detect-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body = "") => fs.writeFileSync(path.join(dir, name), body);
  const packageJson = (scripts: Record<string, string> | undefined) => write("package.json", JSON.stringify({ name: "x", scripts }));

  it("finds npm from a test script and a lockfile, and installs exactly what the lockfile says", () => {
    packageJson({ test: "vitest run" });
    write("package-lock.json", "{}");

    expect(detectProject(dir)).toEqual({ gate: ["npm", "test"], setup: ["npm", "ci"], basis: "package.json scripts.test and package-lock.json" });
  });

  it("installs instead of using ci when there is no lockfile", () => {
    packageJson({ test: "vitest run" });

    expect(detectProject(dir)).toMatchObject({ gate: ["npm", "test"], setup: ["npm", "install"] });
  });

  it("finds pnpm and both generations of yarn", () => {
    packageJson({ test: "vitest run" });
    write("pnpm-lock.yaml");
    expect(detectProject(dir)).toMatchObject({ gate: ["pnpm", "test"], setup: ["pnpm", "install", "--frozen-lockfile"] });

    fs.rmSync(path.join(dir, "pnpm-lock.yaml"));
    write("yarn.lock");
    expect(detectProject(dir)).toMatchObject({ gate: ["yarn", "test"], setup: ["yarn", "install", "--frozen-lockfile"] });

    write(".yarnrc.yml");
    expect(detectProject(dir)).toMatchObject({ gate: ["yarn", "test"], setup: ["yarn", "install", "--immutable"] });
  });

  it("does not guess for a bun project", () => {
    packageJson({ test: "bun test" });
    write("bun.lockb");

    expect(detectProject(dir)).toMatchObject({ gate: null, setup: null });
    expect(detectProject(dir).basis).toContain("bun");
  });

  it("does not take npm's placeholder test script for a test command", () => {
    packageJson({ test: 'echo "Error: no test specified" && exit 1' });

    expect(detectProject(dir).gate).toBeNull();
  });

  it("says nothing about a package.json without a test script, or one it cannot read", () => {
    packageJson(undefined);
    expect(detectProject(dir).gate).toBeNull();

    write("package.json", "{ not json");
    expect(detectProject(dir).gate).toBeNull();
  });

  it("finds pytest, cargo and go, with no install step", () => {
    write("pytest.ini", "[pytest]");
    expect(detectProject(dir)).toEqual({ gate: [process.platform === "win32" ? "python" : "python3", "-m", "pytest"], setup: null, basis: "pytest configuration" });

    fs.rmSync(path.join(dir, "pytest.ini"));
    write("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]');
    expect(detectProject(dir).gate?.slice(1)).toEqual(["-m", "pytest"]);

    fs.rmSync(path.join(dir, "pyproject.toml"));
    write("Cargo.toml");
    expect(detectProject(dir)).toMatchObject({ gate: ["cargo", "test"], setup: null });

    fs.rmSync(path.join(dir, "Cargo.toml"));
    write("go.mod");
    expect(detectProject(dir)).toMatchObject({ gate: ["go", "test", "./..."], setup: null });
  });

  it("prefers the JavaScript test script when a repository has several kinds of project", () => {
    packageJson({ test: "vitest run" });
    write("Cargo.toml");

    expect(detectProject(dir).gate).toEqual(["npm", "test"]);
  });

  it("finds nothing in an empty directory, and says what it looked for", () => {
    expect(detectProject(dir)).toEqual({
      gate: null,
      setup: null,
      basis: "no package.json test script, pytest configuration, Cargo.toml or go.mod was found",
    });
  });
});

describe("laneBrief", () => {
  const teammates = SWARM_LANE_IDS.map((lane) => ({ lane, session: `swarm-${lane}@demo` }));
  const brief = (lane: (typeof SWARM_LANE_IDS)[number], team = teammates) => laneBrief({ lane, prompt: "Build Auth API", rig: "demo", teammates: team });

  it("tells a seat its task, its lane and its rules", () => {
    const text = brief("backend");

    expect(text).toContain("You are the backend seat");
    expect(text).toContain("Build Auth API");
    expect(text).toContain("the server side");
    expect(text).toContain("Work only in your own git worktree");
    expect(text).toContain("Stage only the files you changed, by name. Never run `git add -A`, and never commit anything under .openrig/ or .claude/.");
    expect(text).toContain("run: squad gate run");
    expect(text).toContain("A person will run: squad land demo");
  });

  it("names the other seats and how to message them, but not the seat itself", () => {
    const text = brief("backend");

    expect(text).toContain("frontend (swarm-frontend@demo), qa (swarm-qa@demo)");
    expect(text).not.toContain("swarm-backend@demo");
    expect(text).toContain('squad send <session> "<message>"');
  });

  it("describes only the squad that exists: a squad of one has no teammates to mention", () => {
    const text = brief("qa", [{ lane: "qa", session: "swarm-qa@demo" }]);

    expect(text).not.toMatch(/teammate/i);
    expect(text).not.toContain("squad send");
    expect(text).not.toMatch(/backend|frontend/);
    expect(text).toContain("Base your tests on the task.");
  });

  it("makes QA write tests first, checked by the integration gate", () => {
    const text = brief("qa");

    expect(text).toContain("before the code exists");
    expect(text).toContain("The backend and frontend seats work at the same time and you cannot see their code");
    expect(text).toContain("The integration gate will run your tests on their merged work.");
  });

  it("names only the builders that are in the squad when QA works with one", () => {
    const text = brief("qa", [
      { lane: "backend", session: "swarm-backend@demo" },
      { lane: "qa", session: "swarm-qa@demo" },
    ]);

    expect(text).toContain("The backend seat works at the same time");
    expect(text).not.toContain("frontend");
  });

  it("is one message: plain text, no tab characters or NULs that a terminal paste could mangle", () => {
    for (const lane of SWARM_LANE_IDS) expect(brief(lane)).not.toMatch(/[\t\0]/);
  });
});
