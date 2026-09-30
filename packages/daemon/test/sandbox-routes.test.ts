import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";

describe("/api/sandboxes", { timeout: 30_000 }, () => {
  let tmp: string;
  let repo: string;
  const closers: Array<() => void> = [];

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-routes-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"]);
  });

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function boot(withSandboxes = true, commands: { setup?: string[]; gate?: string[] } = {}) {
    const db = createFullTestDb();
    closers.push(() => db.close());
    const sandboxes = new SeatSandboxService(db);
    const setup = createTestApp(db, withSandboxes ? { sandboxes } : undefined);
    const rig = setup.rigRepo.createRig("demo");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", cwd: repo });
    sandboxes.request({ nodeId: node.id, rigId: rig.id, seat: "dev.impl", repoPath: repo, ...commands });
    return { ...setup, sandboxes, node };
  }

  const post = (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, url: string, body?: unknown) =>
    app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const node = (code: string) => [process.execPath, "-e", code];
  const commitInWorktree = (worktree: string, name: string) => {
    fs.writeFileSync(path.join(worktree, name), "x\n");
    execFileSync("git", ["-C", worktree, "add", name]);
    execFileSync("git", ["-C", worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `add ${name}`]);
  };

  it("lists the recorded sandboxes", async () => {
    const { app, node, sandboxes } = boot();
    await sandboxes.provision(node.id);

    const res = await app.request("/api/sandboxes");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sandboxes: [{ nodeId: node.id, rigName: "demo", seat: "dev.impl", state: "provisioned", branch: "squad/demo/dev.impl" }],
    });
  });

  it("removes a sandbox and reports what it removed", async () => {
    const { app, node, sandboxes } = boot();
    const cwd = (await sandboxes.provision(node.id))!;

    const res = await app.request(`/api/sandboxes/${node.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, worktreeRemoved: true, branchDeleted: true });
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("answers 409 with the reason when the worktree has uncommitted changes, and removes it with force=true", async () => {
    const { app, node, sandboxes } = boot();
    const cwd = (await sandboxes.provision(node.id))!;
    fs.writeFileSync(path.join(cwd, "wip.txt"), "unsaved");

    const refused = await app.request(`/api/sandboxes/${node.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: "failed" });
    expect(fs.existsSync(cwd)).toBe(true);

    const forced = await app.request(`/api/sandboxes/${node.id}?force=true`, { method: "DELETE" });
    expect(forced.status).toBe(200);
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("answers 404 for a node with no sandbox", async () => {
    const { app } = boot();

    const res = await app.request("/api/sandboxes/no-such-node", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
  });

  it("answers 503 when the daemon has no sandbox service", async () => {
    const { app } = boot(false);

    expect((await app.request("/api/sandboxes")).status).toBe(503);
    expect((await app.request("/api/sandboxes/x", { method: "DELETE" })).status).toBe(503);
    expect((await post(app, "/api/sandboxes/x/setup")).status).toBe(503);
    expect((await post(app, "/api/sandboxes/x/gate")).status).toBe(503);
    expect((await post(app, "/api/land", { rig: "demo" })).status).toBe(503);
    expect((await post(app, "/api/land/reset", { rig: "demo" })).status).toBe(503);
  });

  describe("POST /api/sandboxes/:nodeId/gate", () => {
    it("runs the gate and returns the run; a failing gate is still a 200", async () => {
      const passing = boot(true, { gate: node("process.exit(0)") });
      await passing.sandboxes.provision(passing.node.id);
      const passed = await post(passing.app, `/api/sandboxes/${passing.node.id}/gate`);
      expect(passed.status).toBe(200);
      expect(await passed.json()).toMatchObject({ ok: true, run: { status: "passed", exitCode: 0, lane: "seat", seat: "dev.impl" } });

      const failing = boot(true, { gate: node("console.log('nope'); process.exit(1)") });
      await failing.sandboxes.provision(failing.node.id);
      const failed = await post(failing.app, `/api/sandboxes/${failing.node.id}/gate`, { timeoutSeconds: 60 });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ ok: true, run: { status: "failed", exitCode: 1 } });
    });

    it("answers 409 with the reason when the gate cannot be run, 404 for an unknown node", async () => {
      const { app, node: seat, sandboxes } = boot(true, {});
      await sandboxes.provision(seat.id);

      const noGate = await post(app, `/api/sandboxes/${seat.id}/gate`);
      expect(noGate.status).toBe(409);
      expect(await noGate.json()).toMatchObject({ ok: false, code: "failed", error: expect.stringContaining("No gate is configured") });

      const unknown = await post(app, "/api/sandboxes/no-such-node/gate");
      expect(unknown.status).toBe(404);
    });

    it.each([0, -5, "60", 86_401, null])("rejects a timeoutSeconds of %j", async (timeoutSeconds) => {
      const { app, node: seat } = boot(true, { gate: node("process.exit(0)") });

      const res = await post(app, `/api/sandboxes/${seat.id}/gate`, { timeoutSeconds });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "invalid" });
    });
  });

  describe("POST /api/sandboxes/:nodeId/setup", () => {
    it("re-runs setup and returns the result", async () => {
      const { app, node: seat, sandboxes } = boot(true, { setup: node("console.log('installed')") });
      await sandboxes.provision(seat.id);

      const res = await post(app, `/api/sandboxes/${seat.id}/setup`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, setup: { status: "passed", exitCode: 0 } });
    });

    it("answers 409 when the seat has no setup configured", async () => {
      const { app, node: seat, sandboxes } = boot(true, {});
      await sandboxes.provision(seat.id);

      const res = await post(app, `/api/sandboxes/${seat.id}/setup`);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("No setup command is configured") });
    });
  });

  describe("/api/land", () => {
    it("lands a gated lane, reports lanes that are not ready as a normal answer, and resets", async () => {
      const { app, node: seat, sandboxes } = boot(true, { gate: node("process.exit(0)") });
      const cwd = (await sandboxes.provision(seat.id))!;
      commitInWorktree(cwd, "feature.txt");

      const notReady = await post(app, "/api/land", { rig: "demo" });
      expect(notReady.status).toBe(200);
      expect(await notReady.json()).toMatchObject({ ok: true, result: { outcome: "not_ready", lanes: [{ seat: "dev.impl", result: "not_ready" }] } });

      expect((await post(app, `/api/sandboxes/${seat.id}/gate`)).status).toBe(200);
      const landed = await post(app, "/api/land", { rig: "demo", timeoutSeconds: 120 });
      expect(landed.status).toBe(200);
      expect(await landed.json()).toMatchObject({
        ok: true,
        result: { outcome: "landed", branch: "squad/demo/integration", lanes: [{ seat: "dev.impl", result: "merged" }], gates: [{ run: { lane: "integration", status: "passed" } }] },
      });

      const reset = await post(app, "/api/land/reset", { rig: "demo" });
      expect(reset.status).toBe(200);
      expect(await reset.json()).toEqual({ ok: true, worktreeRemoved: true, branchDeleted: true });
    });

    it("judges the lanes without landing them when dryRun is true, and refuses a dryRun that is not true or false", async () => {
      const { app, node: seat, sandboxes } = boot(true, { gate: node("process.exit(0)") });
      const cwd = (await sandboxes.provision(seat.id))!;
      commitInWorktree(cwd, "feature.txt");
      expect((await post(app, `/api/sandboxes/${seat.id}/gate`)).status).toBe(200);

      const dry = await post(app, "/api/land", { rig: "demo", dryRun: true });
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ ok: true, result: { outcome: "ready", lanes: [{ seat: "dev.impl", result: "would_merge" }], gates: [] } });
      expect(execFileSync("git", ["-C", repo, "branch", "--list", "squad/demo/integration"], { encoding: "utf8" })).toBe("");

      const invalid = await post(app, "/api/land", { rig: "demo", dryRun: "yes" });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ ok: false, code: "invalid" });

      // A dry run left everything as it was, so the real land follows.
      expect(await (await post(app, "/api/land", { rig: "demo", dryRun: false })).json()).toMatchObject({ result: { outcome: "landed" } });
    });

    it("answers 404 for a rig with nothing to land, and 400 for a request that names no rig", async () => {
      const { app } = boot(true, {});

      const unknown = await post(app, "/api/land", { rig: "no-such-rig" });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ ok: false, code: "not_found" });
      expect((await post(app, "/api/land/reset", { rig: "no-such-rig" })).status).toBe(404);

      expect((await post(app, "/api/land", {})).status).toBe(400);
      expect((await post(app, "/api/land", { rig: "" })).status).toBe(400);
      expect((await post(app, "/api/land", { rig: "demo", timeoutSeconds: 0 })).status).toBe(400);
      expect((await post(app, "/api/land/reset", {})).status).toBe(400);
    });
  });
});
