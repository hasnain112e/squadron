import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// The HTTP edge of `squad swarm`: what a client sends and what status and body it gets back. What the plan
// contains is covered by swarm-service.test.ts.
describe("/api/swarm", { timeout: 30_000 }, () => {
  let tmp: string;
  let repo: string;
  let home: string;
  const closers: Array<() => void> = [];

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-swarm-routes-")));
    repo = path.join(tmp, "repo");
    home = path.join(tmp, "home");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
    fs.writeFileSync(path.join(repo, "package-lock.json"), "{}");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function boot(withSwarm = true) {
    const db = createFullTestDb();
    closers.push(() => db.close());
    return createTestApp(db, withSwarm ? { swarmHome: home } : undefined).app;
  }

  const post = (app: ReturnType<typeof boot>, body: unknown) =>
    app.request("/api/swarm", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("answers a preview with the plan, and writes nothing", async () => {
    const app = boot();

    const res = await post(app, { prompt: "Build Auth API", cwd: repo });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      plan: {
        rig: "build-auth-api",
        gate: ["npm", "test"],
        setup: ["npm", "ci"],
        written: false,
        lanes: [{ seat: "swarm.backend" }, { seat: "swarm.frontend" }, { seat: "swarm.qa" }],
      },
    });
    expect(fs.existsSync(home)).toBe(false);
  });

  it("writes the specs in write mode, and also hides OpenRig's files from git in launch mode", async () => {
    const app = boot();

    const written = await post(app, { prompt: "Build Auth API", cwd: repo, mode: "write" });
    const plan = ((await written.json()) as { plan: { specPath: string; written: boolean; excluded: string[] } }).plan;

    expect(plan.written).toBe(true);
    expect(plan.excluded).toEqual([]);
    expect(fs.existsSync(plan.specPath)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(plan.specPath), "agents", "lane", "agent.yaml"))).toBe(true);

    const launched = await post(app, { prompt: "Build Auth API", cwd: repo, mode: "launch" });
    expect(((await launched.json()) as { plan: { excluded: string[] } }).plan.excluded).toEqual([".openrig/", ".claude/settings.local.json"]);
  });

  it("passes the person's choices through", async () => {
    const app = boot();

    const res = await post(app, { prompt: "Fix login", cwd: repo, name: "login", lanes: ["backend", "qa"], runtime: "codex", gate: ["make", "check"], noSetup: true });

    expect(await res.json()).toMatchObject({
      plan: { rig: "login", runtime: "codex", gate: ["make", "check"], setup: null, lanes: [{ lane: "backend" }, { lane: "qa" }] },
    });
  });

  it.each<[string, (cwd: string) => unknown]>([
    ["a body that is not JSON", () => "{nope"],
    ["a body that is not an object", () => "[1]"],
    ["no prompt", (cwd) => ({ cwd })],
    ["a prompt that is not text", (cwd) => ({ prompt: 7, cwd })],
    ["an empty prompt", (cwd) => ({ prompt: "   ", cwd })],
    ["a relative cwd", () => ({ prompt: "x", cwd: "some/dir" })],
    ["an unknown mode", (cwd) => ({ prompt: "x", cwd, mode: "deploy" })],
    ["lanes that are not a list", (cwd) => ({ prompt: "x", cwd, lanes: "qa" })],
    ["a lane that does not exist", (cwd) => ({ prompt: "x", cwd, lanes: ["design"] })],
    ["a gate that is not a list of text", (cwd) => ({ prompt: "x", cwd, gate: [1] })],
    ["noSetup that is not true or false", (cwd) => ({ prompt: "x", cwd, noSetup: "yes" })],
  ])("answers 400 for %s", async (_name, body) => {
    const res = await post(boot(), body(repo));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid", error: expect.any(String) });
  });

  it("answers 409 with the reason when the plan cannot be made, and points to --gate when no test command is found", async () => {
    const app = boot();
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare);
    git(bare, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(bare, "notes.txt"), "x");
    git(bare, "add", ".");
    git(bare, ...IDENT, "commit", "-q", "-m", "base");

    const noGate = await post(app, { prompt: "Build Auth API", cwd: bare });
    expect(noGate.status).toBe(409);
    expect(await noGate.json()).toMatchObject({ ok: false, code: "failed", error: expect.stringContaining("--gate") });

    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const notRepo = await post(app, { prompt: "Build Auth API", cwd: plain });
    expect(notRepo.status).toBe(409);
    expect(await notRepo.json()).toMatchObject({ ok: false, code: "failed", error: expect.stringContaining("not inside one") });
  });

  it("answers 503 when the daemon has no swarm service", async () => {
    const app = boot(false);

    const res = await post(app, { prompt: "Build Auth API", cwd: repo });

    expect(res.status).toBe(503);
  });
});
