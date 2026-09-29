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

  function boot(withSandboxes = true) {
    const db = createFullTestDb();
    closers.push(() => db.close());
    const sandboxes = new SeatSandboxService(db);
    const setup = createTestApp(db, withSandboxes ? { sandboxes } : undefined);
    const rig = setup.rigRepo.createRig("demo");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", cwd: repo });
    sandboxes.request({ nodeId: node.id, rigId: rig.id, seat: "dev.impl", repoPath: repo });
    return { ...setup, sandboxes, node };
  }

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
  });
});
