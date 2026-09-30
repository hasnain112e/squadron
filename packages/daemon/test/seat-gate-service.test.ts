import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";
import { SeatGateService } from "../src/domain/seat-gate-service.js";
import { createFullTestDb } from "./helpers/test-app.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const node = (code: string) => [process.execPath, "-e", code];

// Real git and real child processes: a gate is only worth trusting if it ran a real command on a real commit.
describe("SeatGateService", { timeout: 60_000 }, () => {
  let tmp: string;
  let repo: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sandboxes: SeatSandboxService;
  let gates: SeatGateService;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-gate-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "pkg", "keep.txt"), "tracked\n");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sandboxes = new SeatSandboxService(db);
    gates = new SeatGateService(db, sandboxes);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A seat with a provisioned worktree. */
  async function seat(commands: { setup?: string[]; gate?: string[] } = { gate: node("process.exit(0)") }, repoPath = repo, rigName = "demo") {
    const rig = rigRepo.createRig(rigName);
    const n = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sandboxes.request({ nodeId: n.id, rigId: rig.id, seat: "dev.impl", repoPath, ...commands });
    const cwd = (await sandboxes.provision(n.id))!;
    return { nodeId: n.id, cwd, worktree: sandboxes.get(n.id)!.worktreePath! };
  }

  const commitFile = (worktree: string, name: string, body = "x") => {
    fs.writeFileSync(path.join(worktree, name), body);
    git(worktree, "add", name);
    git(worktree, ...IDENT, "commit", "-q", "-m", `add ${name}`);
    return git(worktree, "rev-parse", "HEAD");
  };

  it("runs the gate in the seat's cwd and records a pass against the commit it tested", async () => {
    // keep.txt exists only in pkg/, so the gate can pass only if it ran there and not at the worktree root.
    const { nodeId, worktree } = await seat({ gate: node("require('fs').accessSync('keep.txt')") }, path.join(repo, "pkg"));

    const run = await gates.run(nodeId);

    expect(run).toMatchObject({ status: "passed", exitCode: 0, lane: "seat", commitSha: git(worktree, "rev-parse", "HEAD"), subdir: "pkg", seat: "dev.impl", rigName: "demo" });
    expect(gates.latestAt(nodeId, run.commitSha)?.id).toBe(run.id);
  });

  it("records a failure with its exit code and output; a failing gate is a result, not an error", async () => {
    const { nodeId } = await seat({ gate: node("console.log('3 tests failed'); process.exit(1)") });

    const run = await gates.run(nodeId);

    expect(run).toMatchObject({ status: "failed", exitCode: 1 });
    expect(run.outputTail).toContain("3 tests failed");
  });

  it("belongs to the commit it tested: a new commit has no result until the gate runs again", async () => {
    const { nodeId, worktree } = await seat();
    const first = await gates.run(nodeId);

    const newSha = commitFile(worktree, "feature.txt");

    expect(gates.latestAt(nodeId, first.commitSha)?.status).toBe("passed");
    expect(gates.latestAt(nodeId, newSha)).toBeNull();
    expect(gates.latest(nodeId)?.id).toBe(first.id);
    const second = await gates.run(nodeId);
    expect(second.commitSha).toBe(newSha);
    expect(gates.latestAt(nodeId, newSha)?.id).toBe(second.id);
  });

  it("uses the latest run at a commit, so a later failure overrides an earlier pass", async () => {
    const { nodeId } = await seat();
    const pass = await gates.run(nodeId);
    db.prepare("UPDATE node_sandboxes SET gate_json = ? WHERE node_id = ?").run(JSON.stringify(node("process.exit(1)")), nodeId);

    const fail = await gates.run(nodeId);

    expect(fail.commitSha).toBe(pass.commitSha);
    expect(gates.latestAt(nodeId, pass.commitSha)).toMatchObject({ id: fail.id, status: "failed" });
  });

  it("does not count untracked files as changes, since a gate may leave them behind", async () => {
    const { nodeId, worktree } = await seat();
    fs.writeFileSync(path.join(worktree, "coverage-output.txt"), "left by an earlier run");

    await expect(gates.run(nodeId)).resolves.toMatchObject({ status: "passed" });
  });

  it("times out a gate that hangs, and records it", async () => {
    const { nodeId } = await seat({ gate: node("setTimeout(() => {}, 60000)") });

    const run = await gates.run(nodeId, { timeoutMs: 700 });

    expect(run.status).toBe("timed_out");
    expect(gates.latestAt(nodeId, run.commitSha)?.status).toBe("timed_out");
  });

  it("does not count a result when the worktree changed while the gate ran", async () => {
    // The gate itself edits a tracked file, which stands in for the seat editing while its gate runs.
    const { nodeId } = await seat({ gate: node("require('fs').appendFileSync('pkg/keep.txt', 'edited during the run')") });

    const run = await gates.run(nodeId);

    expect(run.status).toBe("error");
    expect(run.outputTail).toMatch(/changed while the gate was running/);
  });

  describe("refuses to run", () => {
    it("for an unknown node", async () => {
      await expect(gates.run("no-such-node")).rejects.toMatchObject({ code: "not_found" });
    });

    it("when no gate is configured", async () => {
      const { nodeId } = await seat({});
      await expect(gates.run(nodeId)).rejects.toThrow(/No gate is configured for dev\.impl/);
    });

    it("before the seat has a worktree", async () => {
      const rig = rigRepo.createRig("demo");
      const n = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
      sandboxes.request({ nodeId: n.id, rigId: rig.id, seat: "dev.impl", repoPath: repo, gate: node("process.exit(0)") });

      await expect(gates.run(n.id)).rejects.toThrow(/no worktree yet/);
    });

    it("while setup has not passed", async () => {
      const { nodeId } = await seat({ setup: node("process.exit(0)"), gate: node("process.exit(0)") });
      db.prepare("UPDATE node_sandboxes SET setup_state = 'failed' WHERE node_id = ?").run(nodeId);

      await expect(gates.run(nodeId)).rejects.toThrow(/Setup has not passed for dev\.impl \(it is failed\)[\s\S]*squad sandbox setup/);
    });

    it("with uncommitted changes to tracked files, naming them", async () => {
      const { nodeId, worktree } = await seat();
      fs.appendFileSync(path.join(worktree, "pkg", "keep.txt"), "an edit");

      await expect(gates.run(nodeId)).rejects.toThrow(/uncommitted changes to tracked files \(pkg\/keep\.txt\)/);
    });

    it("when the worktree is not on the seat's own branch", async () => {
      const { nodeId, worktree } = await seat();
      git(worktree, "checkout", "-q", "-b", "side-branch");

      await expect(gates.run(nodeId)).rejects.toThrow(/on side-branch, not its own branch squad\/demo\/dev\.impl/);
    });

    it("while another gate is running for the same seat", async () => {
      const { nodeId } = await seat({ gate: node("setTimeout(() => {}, 1500)") });

      const first = gates.run(nodeId);
      await expect(gates.run(nodeId)).rejects.toMatchObject({ code: "in_use" });
      await expect(first).resolves.toMatchObject({ status: "passed" });
    });
  });
});
