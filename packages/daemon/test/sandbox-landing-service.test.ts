import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";
import { SeatGateService } from "../src/domain/seat-gate-service.js";
import { SandboxLandingService } from "../src/domain/sandbox-landing-service.js";
import { createFullTestDb } from "./helpers/test-app.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const node = (code: string) => [process.execPath, "-e", code];
const PASS = node("process.exit(0)");
// Passes in each lane alone, fails once a.txt and b.txt are both present: the shape of "each lane is fine, together they are not".
const BREAKS_TOGETHER = node("const fs = require('fs'); process.exit(fs.existsSync('a.txt') && fs.existsSync('b.txt') ? 1 : 0)");

// Real git, real commands, real merges: landing is only worth trusting if it survived a real conflict.
describe("SandboxLandingService", { timeout: 120_000 }, () => {
  let tmp: string;
  let repo: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sandboxes: SeatSandboxService;
  let gates: SeatGateService;
  let landing: SandboxLandingService;
  let rigId: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-land-")));
    repo = makeRepo("repo");

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sandboxes = new SeatSandboxService(db);
    gates = new SeatGateService(db, sandboxes);
    landing = new SandboxLandingService(sandboxes, gates);
    rigId = rigRepo.createRig("demo").id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeRepo(name: string): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(dir, "pkg", "keep.txt"), "tracked\n");
    fs.writeFileSync(path.join(dir, "shared.txt"), "one\ntwo\nthree\n");
    git(dir, "add", ".");
    git(dir, ...IDENT, "commit", "-q", "-m", "base");
    return dir;
  }

  /** A provisioned seat in the rig. */
  async function seat(logicalId: string, commands: { setup?: string[]; gate?: string[] } = { gate: PASS }, repoPath = repo) {
    const n = rigRepo.addNode(rigId, logicalId, { role: "worker", runtime: "claude-code" });
    sandboxes.request({ nodeId: n.id, rigId, seat: logicalId, repoPath, ...commands });
    await sandboxes.provision(n.id);
    return { nodeId: n.id, worktree: sandboxes.get(n.id)!.worktreePath! };
  }

  const commitFile = (worktree: string, name: string, body = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true });
    fs.writeFileSync(path.join(worktree, name), body);
    git(worktree, "add", name);
    git(worktree, ...IDENT, "commit", "-q", "-m", `change ${name}`);
    return git(worktree, "rev-parse", "HEAD");
  };

  const integrationBranch = "squad/demo/integration";
  const integrationDir = () => path.join(tmp, "squad-worktrees", "repo", "demo", "integration");
  const runCount = () => (db.prepare("SELECT COUNT(*) AS n FROM sandbox_gate_runs").get() as { n: number }).n;
  const resultsOf = (r: { lanes: Array<{ seat: string; result: string }> }) => Object.fromEntries(r.lanes.map((l) => [l.seat, l.result]));

  describe("landing", () => {
    it("merges every lane whose gate passed at its tip onto the integration branch, and leaves the repository's own branches alone", async () => {
      const a = await seat("dev.a");
      const b = await seat("dev.b");
      commitFile(a.worktree, "a.txt");
      commitFile(b.worktree, "b.txt");
      await gates.run(a.nodeId);
      await gates.run(b.nodeId);
      const mainBefore = git(repo, "rev-parse", "main");

      const result = await landing.land("demo");

      expect(result).toMatchObject({ outcome: "landed", rig: "demo", branch: integrationBranch, worktreePath: integrationDir() });
      expect(resultsOf(result)).toEqual({ "dev.a": "merged", "dev.b": "merged" });
      expect(fs.existsSync(path.join(integrationDir(), "a.txt"))).toBe(true);
      expect(fs.existsSync(path.join(integrationDir(), "b.txt"))).toBe(true);
      expect(git(integrationDir(), "log", "--merges", "--format=%s")).toMatch(/squad: land dev\.b[\s\S]*squad: land dev\.a/);
      expect(result.tipSha).toBe(git(repo, "rev-parse", integrationBranch));
      // The repository's own branch and working tree are exactly as they were.
      expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false);
      // The integration branch was gated as a whole, at the commit it ended on.
      expect(result.gates).toHaveLength(1);
      expect(result.gates[0]).toMatchObject({ seats: ["dev.a", "dev.b"], reused: false, run: { lane: "integration", status: "passed", commitSha: result.tipSha } });
    });

    it("merges the exact commit that was gated, not whatever the branch has since become", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "a.txt");
      const gated = (await gates.run(a.nodeId)).commitSha;
      commitFile(a.worktree, "late.txt"); // committed after the gate ran

      const result = await landing.land("demo");

      // The lane is stale, so nothing merged, and in particular late.txt did not slip in behind the gate.
      expect(result.outcome).toBe("not_ready");
      expect(result.lanes[0]!.detail).toContain(`the last run was passed at ${gated.slice(0, 7)}`);
      expect(git(repo, "branch", "--list", integrationBranch)).toBe("");
    });
  });

  describe("refuses to land, creating nothing, when a lane is not ready", () => {
    it("has no gate result yet", async () => {
      const a = await seat("dev.a");
      const b = await seat("dev.b");
      commitFile(a.worktree, "a.txt");
      commitFile(b.worktree, "b.txt");
      await gates.run(a.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("not_ready");
      expect(resultsOf(result)).toEqual({ "dev.a": "not_attempted", "dev.b": "not_ready" });
      expect(result.lanes[1]!.detail).toMatch(new RegExp(`no gate result for [0-9a-f]{7}\\. Run: squad gate run ${b.nodeId}`));
      expect(git(repo, "branch", "--list", integrationBranch)).toBe("");
      expect(fs.existsSync(integrationDir())).toBe(false);
    });

    it("had a gate that failed", async () => {
      const a = await seat("dev.a", { gate: node("process.exit(1)") });
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("not_ready");
      expect(result.lanes[0]!.detail).toMatch(/the gate failed at [0-9a-f]{7}/);
    });

    it("has no gate configured at all", async () => {
      const a = await seat("dev.a", {});
      commitFile(a.worktree, "a.txt");

      const result = await landing.land("demo");

      expect(result.outcome).toBe("not_ready");
      expect(result.lanes[0]!.detail).toContain("no gate is configured");
    });

    it("was gated, but only before its latest commit", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "first.txt");
      await gates.run(a.nodeId);
      commitFile(a.worktree, "second.txt");

      const result = await landing.land("demo");

      expect(result.outcome).toBe("not_ready");
      expect(result.lanes[0]!.detail).toMatch(/no gate result for [0-9a-f]{7} \(the last run was passed at [0-9a-f]{7}\)/);
    });
  });

  describe("lanes with nothing to land", () => {
    it("counts a lane that made no commits as already landed, without needing a gate", async () => {
      const a = await seat("dev.a");
      await seat("dev.idle", {}); // no commits, no gate
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("landed");
      expect(resultsOf(result)).toEqual({ "dev.a": "merged", "dev.idle": "already_landed" });
    });

    it("reports nothing to land, and creates no branch, when no lane has changed anything", async () => {
      await seat("dev.a");

      const result = await landing.land("demo");

      expect(result.outcome).toBe("nothing_to_land");
      expect(git(repo, "branch", "--list", integrationBranch)).toBe("");
      expect(fs.existsSync(integrationDir())).toBe(false);
    });

    it("lands again without redoing anything, reusing the gate result for an unchanged branch", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);
      const first = await landing.land("demo");
      const runsAfterFirst = runCount();

      const second = await landing.land("demo");

      expect(second.outcome).toBe("nothing_to_land");
      expect(second.tipSha).toBe(first.tipSha);
      expect(resultsOf(second)).toEqual({ "dev.a": "already_landed" });
      expect(second.gates).toHaveLength(1);
      expect(second.gates[0]).toMatchObject({ reused: true });
      expect(runCount()).toBe(runsAfterFirst);
    });

    it("merges only what was committed and gated since the last land", async () => {
      const a = await seat("dev.a");
      const b = await seat("dev.b");
      commitFile(a.worktree, "a.txt");
      commitFile(b.worktree, "b.txt");
      await gates.run(a.nodeId);
      await gates.run(b.nodeId);
      const first = await landing.land("demo");
      commitFile(a.worktree, "a2.txt");
      await gates.run(a.nodeId);

      const second = await landing.land("demo");

      expect(second.outcome).toBe("landed");
      expect(resultsOf(second)).toEqual({ "dev.a": "merged", "dev.b": "already_landed" });
      expect(second.tipSha).not.toBe(first.tipSha);
      expect(second.gates[0]).toMatchObject({ reused: false, run: { commitSha: second.tipSha } });
      expect(fs.existsSync(path.join(integrationDir(), "a2.txt"))).toBe(true);
    });
  });

  describe("conflicts", () => {
    it("stops at the first conflict, names the files, and leaves the branch as it was", async () => {
      const a = await seat("dev.a");
      const b = await seat("dev.b");
      const c = await seat("dev.c");
      commitFile(a.worktree, "shared.txt", "one\nFROM A\nthree\n");
      commitFile(b.worktree, "shared.txt", "one\nFROM B\nthree\n");
      commitFile(c.worktree, "c.txt");
      for (const s of [a, b, c]) await gates.run(s.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("conflict");
      expect(resultsOf(result)).toEqual({ "dev.a": "merged", "dev.b": "conflict", "dev.c": "not_attempted" });
      expect(result.lanes[1]!.files).toEqual(["shared.txt"]);
      expect(result.gates).toEqual([]); // nothing is gated on a half-landed branch
      // A's merge is kept; the failed merge left no trace: no conflict markers, no merge in progress, nothing staged.
      expect(fs.readFileSync(path.join(integrationDir(), "shared.txt"), "utf8")).toBe("one\nFROM A\nthree\n");
      expect(git(integrationDir(), "status", "--porcelain")).toBe("");
      expect(fs.existsSync(path.join(git(integrationDir(), "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(false);
      expect(result.tipSha).toBe(git(repo, "rev-parse", integrationBranch));
    });

    it("lands once the conflicting lane has resolved it on its own branch, gated again", async () => {
      const a = await seat("dev.a");
      const b = await seat("dev.b");
      commitFile(a.worktree, "shared.txt", "one\nFROM A\nthree\n");
      commitFile(b.worktree, "shared.txt", "one\nFROM B\nthree\n");
      await gates.run(a.nodeId);
      await gates.run(b.nodeId);
      expect((await landing.land("demo")).outcome).toBe("conflict");

      // The way out is on lane b: bring the integration branch in, resolve there, commit, gate again.
      expect(() => git(b.worktree, ...IDENT, "merge", "--no-edit", integrationBranch)).toThrow();
      fs.writeFileSync(path.join(b.worktree, "shared.txt"), "one\nFROM A and B\nthree\n");
      git(b.worktree, "add", "shared.txt");
      git(b.worktree, ...IDENT, "commit", "-q", "--no-edit");
      await gates.run(b.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("landed");
      expect(resultsOf(result)).toEqual({ "dev.a": "already_landed", "dev.b": "merged" });
      expect(fs.readFileSync(path.join(integrationDir(), "shared.txt"), "utf8")).toBe("one\nFROM A and B\nthree\n");
    });
  });

  describe("gating the integration branch", () => {
    it("reports a failure that only appears once the lanes are together", async () => {
      const a = await seat("dev.a", { gate: BREAKS_TOGETHER });
      const b = await seat("dev.b", { gate: BREAKS_TOGETHER });
      commitFile(a.worktree, "a.txt");
      commitFile(b.worktree, "b.txt");
      expect((await gates.run(a.nodeId)).status).toBe("passed");
      expect((await gates.run(b.nodeId)).status).toBe("passed");

      const result = await landing.land("demo");

      expect(result.outcome).toBe("gate_failed");
      expect(resultsOf(result)).toEqual({ "dev.a": "merged", "dev.b": "merged" }); // the branch is kept for inspection
      expect(result.gates[0]).toMatchObject({ reused: false, run: { lane: "integration", status: "failed" } });

      // Landing again does not pretend it passed: with nothing new to merge, it runs the gate again.
      const runsBefore = runCount();
      const again = await landing.land("demo");
      expect(again.outcome).toBe("gate_failed");
      expect(runCount()).toBe(runsBefore + 1);
    });

    it("runs each distinct gate once, in the directory its seat works in", async () => {
      // keep.txt exists only under pkg/, so this gate passes only when run there.
      const inPkg = node("require('fs').accessSync('keep.txt')");
      const a = await seat("dev.a", { gate: inPkg }, path.join(repo, "pkg"));
      const b = await seat("dev.b", { gate: inPkg }, path.join(repo, "pkg"));
      commitFile(a.worktree, "pkg/a.txt");
      commitFile(b.worktree, "pkg/b.txt");
      await gates.run(a.nodeId);
      await gates.run(b.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("landed");
      expect(result.gates).toHaveLength(1);
      expect(result.gates[0]).toMatchObject({ seats: ["dev.a", "dev.b"], subdir: "pkg", run: { status: "passed" } });
    });

    it("sets the integration worktree up before gating it, once, and again after new merges", async () => {
      const counting = node("require('fs').appendFileSync('setup-runs.txt', 'x')");
      const a = await seat("dev.a", { setup: counting, gate: PASS });
      const b = await seat("dev.b", { setup: counting, gate: PASS });
      commitFile(a.worktree, "a.txt");
      commitFile(b.worktree, "b.txt");
      await gates.run(a.nodeId);
      await gates.run(b.nodeId);
      const setupRuns = () => (fs.existsSync(path.join(integrationDir(), "setup-runs.txt")) ? fs.readFileSync(path.join(integrationDir(), "setup-runs.txt"), "utf8").length : 0);

      await landing.land("demo");
      expect(setupRuns()).toBe(1); // both seats declare the same setup, so it ran once

      await landing.land("demo"); // nothing new
      expect(setupRuns()).toBe(1);

      commitFile(a.worktree, "a2.txt");
      await gates.run(a.nodeId);
      await landing.land("demo");
      expect(setupRuns()).toBe(2);
    });

    it("stops with the setup output when the integration setup fails, without gating", async () => {
      const a = await seat("dev.a", { setup: PASS, gate: PASS });
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);
      db.prepare("UPDATE node_sandboxes SET setup_json = ? WHERE node_id = ?").run(JSON.stringify(node("console.log('install broke'); process.exit(7)")), a.nodeId);

      const result = await landing.land("demo");

      expect(result.outcome).toBe("setup_failed");
      expect(result.setup).toMatchObject({ status: "failed", exitCode: 7 });
      expect(result.setup!.outputTail).toContain("install broke");
      expect(result.gates).toEqual([]);
      expect(sandboxes.get("integration:demo")?.setupState).toBe("failed");
    });
  });

  describe("refuses to start", () => {
    it("for a rig with no provisioned sandboxes", async () => {
      await expect(landing.land("no-such-rig")).rejects.toMatchObject({ code: "not_found" });
    });

    it("when the rig's seats are in different repositories", async () => {
      await seat("dev.a");
      await seat("dev.b", { gate: PASS }, makeRepo("other"));

      await expect(landing.land("demo")).rejects.toThrow(/more than one repository/);
    });

    it("while another land of the same rig is running", async () => {
      const a = await seat("dev.a", { gate: node("setTimeout(() => {}, 1500)") });
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);

      const first = landing.land("demo");
      await expect(landing.land("demo")).rejects.toMatchObject({ code: "in_use" });
      await expect(first).resolves.toMatchObject({ outcome: "landed" });
    });

    it("when someone left uncommitted changes to tracked files on the integration branch", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);
      await landing.land("demo");
      fs.appendFileSync(path.join(integrationDir(), "a.txt"), "hand edit");
      commitFile(a.worktree, "a2.txt");
      await gates.run(a.nodeId);

      await expect(landing.land("demo")).rejects.toThrow(/integration worktree has uncommitted changes \(a\.txt\)[\s\S]*--reset/);
    });
  });

  describe("reset", () => {
    it("throws the integration branch and worktree away, leaves the seats' branches, and lets landing start fresh", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);
      await landing.land("demo");

      const reset = await landing.reset("demo");

      expect(reset).toEqual({ worktreeRemoved: true, branchDeleted: true });
      expect(fs.existsSync(integrationDir())).toBe(false);
      expect(git(repo, "branch", "--list", integrationBranch)).toBe("");
      expect(git(repo, "branch", "--list", "squad/demo/dev.a")).not.toBe(""); // the lane's work is untouched
      expect(sandboxes.get("integration:demo")?.state).toBe("removed");

      // Nothing to do the second time.
      expect(await landing.reset("demo")).toEqual({ worktreeRemoved: false, branchDeleted: false });

      // And the next land starts over, landing the same lane again.
      const again = await landing.land("demo");
      expect(again.outcome).toBe("landed");
      expect(resultsOf(again)).toEqual({ "dev.a": "merged" });
      expect(fs.existsSync(path.join(integrationDir(), "a.txt"))).toBe(true);
    });

    it("refuses to discard uncommitted changes unless forced", async () => {
      const a = await seat("dev.a");
      commitFile(a.worktree, "a.txt");
      await gates.run(a.nodeId);
      await landing.land("demo");
      fs.appendFileSync(path.join(integrationDir(), "a.txt"), "hand edit");

      await expect(landing.reset("demo")).rejects.toThrow(/--force/);
      expect(fs.existsSync(integrationDir())).toBe(true);

      await expect(landing.reset("demo", { force: true })).resolves.toEqual({ worktreeRemoved: true, branchDeleted: true });
    });

    it("reports a rig it has no record of", async () => {
      await expect(landing.reset("no-such-rig")).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("shows the integration worktree as a sandbox of its own, but does not treat it as a lane", async () => {
    const a = await seat("dev.a");
    commitFile(a.worktree, "a.txt");
    await gates.run(a.nodeId);
    await landing.land("demo");

    expect(sandboxes.list().map((s) => s.nodeId)).toContain("integration:demo");
    expect(sandboxes.forRig("demo").map((s) => s.seat)).toEqual(["dev.a"]);
    expect(sandboxes.get("integration:demo")).toMatchObject({ state: "provisioned", branch: integrationBranch, worktreePath: integrationDir() });
  });
});
