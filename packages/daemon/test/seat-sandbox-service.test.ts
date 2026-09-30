import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatSandboxService, SandboxError } from "../src/domain/seat-sandbox-service.js";
import { createFullTestDb } from "./helpers/test-app.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ...IDENT, "commit", "--allow-empty", "-q", "-m", message);
}

// Real git in a temp directory: what is being tested is how the service drives git, so a fake would prove nothing.
describe("SeatSandboxService", { timeout: 30_000 }, () => {
  let tmp: string;
  let repo: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let service: SeatSandboxService;

  beforeEach(() => {
    // Real path: the service works with real paths, and a tmp dir can be a symlink or an 8.3 short name.
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-sandbox-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    // A developer's global autocrlf must not rewrite the fixture's line endings.
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "pkg", "keep.txt"), "tracked\n");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    service = new SeatSandboxService(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seat(repoPath = repo, rigName = "demo", logicalId = "dev.impl", commands: { setup?: string[]; gate?: string[] } = {}) {
    const rig = rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime: "claude-code" });
    service.request({ nodeId: node.id, rigId: rig.id, seat: logicalId, repoPath, ...commands });
    return node.id;
  }

  const worktreeFor = (rig: string, logicalId: string) => path.join(tmp, "squad-worktrees", "repo", rig, logicalId);

  it("gives the seat its own worktree on its own branch", async () => {
    const nodeId = seat();

    const cwd = await service.provision(nodeId);

    expect(cwd).toBe(worktreeFor("demo", "dev.impl"));
    expect(fs.readFileSync(path.join(cwd!, "pkg", "keep.txt"), "utf8")).toBe("tracked\n");
    expect(git(cwd!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("squad/demo/dev.impl");
    expect(service.get(nodeId)).toMatchObject({
      state: "provisioned",
      worktreePath: cwd,
      branch: "squad/demo/dev.impl",
      baseSha: git(repo, "rev-parse", "HEAD"),
    });
    // The seat's checkout is separate: nothing it does touches the authored repository's working tree.
    fs.writeFileSync(path.join(cwd!, "scratch.txt"), "x");
    expect(fs.existsSync(path.join(repo, "scratch.txt"))).toBe(false);
  });

  it("keeps a subdirectory cwd inside the worktree", async () => {
    const nodeId = seat(path.join(repo, "pkg"));

    const cwd = await service.provision(nodeId);

    expect(cwd).toBe(path.join(worktreeFor("demo", "dev.impl"), "pkg"));
    expect(service.get(nodeId)?.subdir).toBe("pkg");
    expect(fs.existsSync(path.join(cwd!, "keep.txt"))).toBe(true);
  });

  it("reuses the worktree on every later launch", async () => {
    const nodeId = seat();
    const first = await service.provision(nodeId);
    fs.writeFileSync(path.join(first!, "wip.txt"), "unsaved work");

    const second = await service.provision(nodeId);

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second!, "wip.txt"), "utf8")).toBe("unsaved work");
  });

  it("recreates a deleted worktree on its existing branch, keeping the commits", async () => {
    const nodeId = seat();
    const base = git(repo, "rev-parse", "HEAD");
    const first = (await service.provision(nodeId))!;
    commit(first, "seat work");
    fs.rmSync(first, { recursive: true, force: true });

    const again = await service.provision(nodeId);

    expect(again).toBe(first);
    expect(git(again!, "log", "-1", "--format=%s")).toBe("seat work");
    expect(service.get(nodeId)?.baseSha).toBe(base);
  });

  it("adopts the worktree when the same rig starts again under new node ids", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    const first = (await service.provision(seat()))!;
    commit(first, "from the first generation");

    const secondNode = seat();
    const second = await service.provision(secondNode);

    expect(second).toBe(first);
    expect(git(second!, "log", "-1", "--format=%s")).toBe("from the first generation");
    expect(service.list().map((s) => s.nodeId)).toEqual([secondNode]);
    // The base is where the seat's branch forked from, not wherever its earlier generation left it.
    expect(service.get(secondNode)?.baseSha).toBe(base);
  });

  it("makes names that git or the filesystem would reject safe", async () => {
    const nodeId = seat(repo, "Team A!", "pod one.member");

    const cwd = await service.provision(nodeId);

    expect(cwd).toBe(worktreeFor("Team-A", "pod-one.member"));
    expect(service.get(nodeId)?.branch).toBe("squad/Team-A/pod-one.member");
  });

  it("returns null for a node that never asked for a sandbox", async () => {
    expect(await service.provision("no-such-node")).toBeNull();
  });

  it("keeps the first request when a node is requested twice", () => {
    const nodeId = seat();
    const rigId = (db.prepare("SELECT id FROM rigs").get() as { id: string }).id;

    service.request({ nodeId, rigId, seat: "dev.impl", repoPath: path.join(tmp, "elsewhere") });

    expect(service.get(nodeId)?.repoPath).toBe(repo);
  });

  it("refuses a cwd that is not inside a git repository", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);

    await expect(service.provision(seat(plain))).rejects.toThrow(/needs a git repository/);
  });

  it("refuses a cwd that does not exist", async () => {
    await expect(service.provision(seat(path.join(tmp, "gone")))).rejects.toThrow(/does not exist/);
  });

  it("refuses a repository with no commits", async () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");

    await expect(service.provision(seat(empty))).rejects.toThrow(/no commits yet/);
  });

  it("refuses to build on a directory that is not the seat's worktree", async () => {
    const nodeId = seat();
    const target = worktreeFor("demo", "dev.impl");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "precious.txt"), "not ours");

    await expect(service.provision(nodeId)).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("not ours");
    expect(service.get(nodeId)?.state).toBe("requested");
  });

  describe("setup", () => {
    // Each run appends one character to a file in the directory it runs in, so the file records how often and where.
    const counting = (extra = "") => [process.execPath, "-e", `${extra} require('fs').appendFileSync('setup-runs.txt', 'x')`];
    const runsIn = (dir: string) => (fs.existsSync(path.join(dir, "setup-runs.txt")) ? fs.readFileSync(path.join(dir, "setup-runs.txt"), "utf8").length : 0);

    it("stores the declared commands with the request", () => {
      const withSetup = seat(repo, "demo", "dev.impl", { setup: ["npm", "ci"], gate: ["npm", "test"] });
      const without = seat(repo, "other", "dev.qa");

      expect(service.get(withSetup)).toMatchObject({ setup: ["npm", "ci"], gate: ["npm", "test"], setupState: "pending" });
      expect(service.get(without)).toMatchObject({ setup: null, gate: null, setupState: "none" });
    });

    it("runs in the worktree root before the seat starts, even when the seat works in a subdirectory", async () => {
      const nodeId = seat(path.join(repo, "pkg"), "demo", "dev.impl", { setup: counting() });

      const cwd = await service.provision(nodeId);

      const worktree = worktreeFor("demo", "dev.impl");
      expect(cwd).toBe(path.join(worktree, "pkg"));
      expect(runsIn(worktree)).toBe(1);
      expect(runsIn(path.join(worktree, "pkg"))).toBe(0);
      expect(service.get(nodeId)?.setupState).toBe("passed");
    });

    it("does not run again on later launches", async () => {
      const nodeId = seat(repo, "demo", "dev.impl", { setup: counting() });

      await service.provision(nodeId);
      await service.provision(nodeId);

      expect(runsIn(worktreeFor("demo", "dev.impl"))).toBe(1);
    });

    it("stops the launch when setup fails, keeps the worktree, and tries again on the next launch", async () => {
      const failUntilFlag = [process.execPath, "-e", "if (!require('fs').existsSync('ok.flag')) { console.log('deps missing'); process.exit(4) }"];
      const nodeId = seat(repo, "demo", "dev.impl", { setup: failUntilFlag });
      const worktree = worktreeFor("demo", "dev.impl");

      await expect(service.provision(nodeId)).rejects.toThrow(/Setup failed for dev\.impl \(exit code 4\)[\s\S]*deps missing[\s\S]*squad sandbox setup/);
      expect(service.get(nodeId)).toMatchObject({ state: "provisioned", setupState: "failed" });
      expect(service.get(nodeId)?.setupOutput).toContain("deps missing");
      expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);

      fs.writeFileSync(path.join(worktree, "ok.flag"), "");
      await expect(service.provision(nodeId)).resolves.toBe(worktree);
      expect(service.get(nodeId)?.setupState).toBe("passed");
    });

    it("runs again when the worktree had to be recreated", async () => {
      const nodeId = seat(repo, "demo", "dev.impl", { setup: counting() });
      const worktree = (await service.provision(nodeId))!;
      fs.rmSync(worktree, { recursive: true, force: true });

      await service.provision(nodeId);

      expect(runsIn(worktree)).toBe(1); // the fresh checkout has only the run it just made
      expect(service.get(nodeId)?.setupState).toBe("passed");
    });

    it("does not repeat a setup that already passed in a worktree adopted from an earlier generation of the rig", async () => {
      const worktree = (await service.provision(seat(repo, "demo", "dev.impl", { setup: counting() })))!;

      const second = seat(repo, "demo", "dev.impl", { setup: counting() });
      await service.provision(second);

      expect(runsIn(worktree)).toBe(1);
      expect(service.get(second)?.setupState).toBe("passed");
    });

    it("does run a different setup in an adopted worktree", async () => {
      const worktree = (await service.provision(seat(repo, "demo", "dev.impl", { setup: counting() })))!;

      await service.provision(seat(repo, "demo", "dev.impl", { setup: counting("/* changed */") }));

      expect(runsIn(worktree)).toBe(2);
    });

    it("can be run again on demand, and a failing command is a result rather than an error", async () => {
      const nodeId = seat(repo, "demo", "dev.impl", { setup: counting() });
      const worktree = (await service.provision(nodeId))!;

      const again = await service.runSetup(nodeId);

      expect(again).toMatchObject({ status: "passed", exitCode: 0 });
      expect(runsIn(worktree)).toBe(2);

      db.prepare("UPDATE node_sandboxes SET setup_json = ? WHERE node_id = ?").run(JSON.stringify([process.execPath, "-e", "console.log('boom'); process.exit(2)"]), nodeId);
      const failed = await service.runSetup(nodeId);
      expect(failed).toMatchObject({ status: "failed", exitCode: 2 });
      expect(service.get(nodeId)).toMatchObject({ setupState: "failed" });
      expect(service.get(nodeId)?.setupOutput).toContain("boom");
    });

    it("refuses to run when nothing is configured or the seat has no worktree yet", async () => {
      const noSetup = seat(repo, "demo", "dev.impl");
      await service.provision(noSetup);
      await expect(service.runSetup(noSetup)).rejects.toThrow(/No setup command is configured for dev\.impl/);

      const notLaunched = seat(repo, "other", "dev.qa", { setup: counting() });
      await expect(service.runSetup(notLaunched)).rejects.toThrow(/no worktree yet/);
      await expect(service.runSetup("no-such-node")).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses to run two setups for one seat at once", async () => {
      const slow = [process.execPath, "-e", "setTimeout(() => {}, 1500)"];
      const nodeId = seat(repo, "demo", "dev.impl", { setup: slow });
      await service.provision(nodeId);

      const first = service.runSetup(nodeId);
      await expect(service.runSetup(nodeId)).rejects.toMatchObject({ code: "in_use" });
      await expect(first).resolves.toMatchObject({ status: "passed" });
    });
  });

  describe("remove", () => {
    it("removes the worktree and deletes a branch that holds nothing new", async () => {
      const nodeId = seat();
      const cwd = (await service.provision(nodeId))!;

      const result = await service.remove(nodeId);

      expect(result).toEqual({ worktreeRemoved: true, branchDeleted: true });
      expect(fs.existsSync(cwd)).toBe(false);
      expect(git(repo, "branch", "--list", "squad/demo/dev.impl")).toBe("");
      expect(service.get(nodeId)?.state).toBe("removed");
    });

    it("keeps a branch that has commits nothing else contains", async () => {
      const nodeId = seat();
      commit((await service.provision(nodeId))!, "unmerged seat work");

      const result = await service.remove(nodeId);

      expect(result).toEqual({ worktreeRemoved: true, branchDeleted: false });
      expect(git(repo, "log", "-1", "--format=%s", "squad/demo/dev.impl")).toBe("unmerged seat work");
    });

    it("refuses a worktree with uncommitted changes unless forced", async () => {
      const nodeId = seat();
      const cwd = (await service.provision(nodeId))!;
      fs.writeFileSync(path.join(cwd, "wip.txt"), "unsaved work");

      await expect(service.remove(nodeId)).rejects.toThrow(SandboxError);
      expect(fs.existsSync(path.join(cwd, "wip.txt"))).toBe(true);
      expect(service.get(nodeId)?.state).toBe("provisioned");

      await service.remove(nodeId, { force: true });
      expect(fs.existsSync(cwd)).toBe(false);
    });

    it("refuses while the seat is running unless forced", async () => {
      const nodeId = seat();
      const cwd = (await service.provision(nodeId))!;
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'demo-dev.impl', 'running')").run(nodeId);

      await expect(service.remove(nodeId)).rejects.toMatchObject({ code: "in_use" });
      expect(fs.existsSync(cwd)).toBe(true);

      await service.remove(nodeId, { force: true });
      expect(fs.existsSync(cwd)).toBe(false);
    });

    it("is a no-op the second time, and provisioning afterwards makes a fresh worktree", async () => {
      const nodeId = seat();
      const cwd = (await service.provision(nodeId))!;
      await service.remove(nodeId);

      expect(await service.remove(nodeId)).toEqual({ worktreeRemoved: false, branchDeleted: false });
      expect(await service.provision(nodeId)).toBe(cwd);
      expect(fs.existsSync(path.join(cwd, "pkg", "keep.txt"))).toBe(true);
    });

    it("closes the record when the repository and worktree were both deleted by hand", async () => {
      const nodeId = seat();
      await service.provision(nodeId);
      fs.rmSync(worktreeFor("demo", "dev.impl"), { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });

      expect(await service.remove(nodeId)).toEqual({ worktreeRemoved: false, branchDeleted: false });
      expect(service.get(nodeId)?.state).toBe("removed");
    });

    it("reports an unknown node", async () => {
      await expect(service.remove("no-such-node")).rejects.toMatchObject({ code: "not_found" });
    });
  });
});
