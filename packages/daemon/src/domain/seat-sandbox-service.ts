import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { describeResult, runCommand, type CommandResult } from "./sandbox-command-runner.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  SandboxError,
  branchExists,
  exclusive,
  integrationNodeId,
  isWorktreeOnBranch,
  lastLines,
  locateRepo,
  rigWorktreePath,
  sandboxGit,
  segment,
} from "./sandbox-common.js";

export { SandboxError } from "./sandbox-common.js";
export type { SandboxErrorCode } from "./sandbox-common.js";

// Gives a seat that declares `isolation: worktree` its own git worktree and branch, so parallel
// seats on one repository never write into the same checkout. A member asks for a sandbox when its
// node is created (`request`, database only) and the worktree is made when the seat launches
// (`provision`, idempotent). If the member declares a `setup` command it runs once in each fresh
// worktree, before the seat starts. Nothing here deletes work: `remove` is only ever run by an
// operator, and a branch is dropped only when git says it is fully merged.

export type SetupState = "none" | "pending" | "passed" | "failed";

export interface SeatSandbox {
  nodeId: string;
  rigName: string;
  seat: string;
  mode: "worktree";
  /** The authored cwd; may be a subdirectory of the repository. */
  repoPath: string;
  state: "requested" | "provisioned" | "removed";
  worktreePath: string | null;
  /** The authored cwd relative to the repository root ("" when it is the root). */
  subdir: string;
  branch: string | null;
  /** The commit the sandbox's branch started from. */
  baseSha: string | null;
  /** The member's `setup` command: run in the worktree root once per fresh worktree. */
  setup: string[] | null;
  /** The member's `gate` command: run in the seat's cwd to decide whether its work may land. */
  gate: string[] | null;
  setupState: SetupState;
  /** The tail of the last setup run's output. */
  setupOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxRemoval {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

interface SandboxRow {
  node_id: string;
  rig_name: string;
  seat: string;
  mode: "worktree";
  repo_path: string;
  state: SeatSandbox["state"];
  worktree_path: string | null;
  subdir: string;
  branch: string | null;
  base_sha: string | null;
  setup_json: string | null;
  gate_json: string | null;
  setup_state: SetupState;
  setup_output: string | null;
  created_at: string;
  updated_at: string;
}

const parseCommand = (json: string | null): string[] | null => (json ? (JSON.parse(json) as string[]) : null);

function toSandbox(row: SandboxRow): SeatSandbox {
  return {
    nodeId: row.node_id,
    rigName: row.rig_name,
    seat: row.seat,
    mode: row.mode,
    repoPath: row.repo_path,
    state: row.state,
    worktreePath: row.worktree_path,
    subdir: row.subdir,
    branch: row.branch,
    baseSha: row.base_sha,
    setup: parseCommand(row.setup_json),
    gate: parseCommand(row.gate_json),
    setupState: row.setup_state,
    setupOutput: row.setup_output,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SeatSandboxService {
  constructor(private readonly db: Database.Database) {}

  /** Record that a node wants a sandbox. Database only, so it is safe inside the node-creation transaction. */
  request(input: { nodeId: string; rigId: string; seat: string; repoPath: string; setup?: string[]; gate?: string[] }): void {
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?").get(input.rigId) as { name: string } | undefined;
    if (!rig) throw new SandboxError("not_found", `Rig ${input.rigId} not found`);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO node_sandboxes (node_id, rig_name, seat, mode, repo_path, setup_json, gate_json, setup_state) VALUES (?, ?, ?, 'worktree', ?, ?, ?, ?)",
      )
      .run(
        input.nodeId,
        rig.name,
        input.seat,
        input.repoPath,
        input.setup ? JSON.stringify(input.setup) : null,
        input.gate ? JSON.stringify(input.gate) : null,
        input.setup ? "pending" : "none",
      );
  }

  /** Record the worktree for a rig's integration branch. Repeated calls keep one record and follow the repository. */
  requestIntegration(input: { rigName: string; repoPath: string }): string {
    const nodeId = integrationNodeId(input.rigName);
    this.db
      .prepare(
        "INSERT INTO node_sandboxes (node_id, rig_name, seat, mode, repo_path) VALUES (?, ?, 'integration', 'worktree', ?) ON CONFLICT(node_id) DO UPDATE SET repo_path = excluded.repo_path",
      )
      .run(nodeId, input.rigName, input.repoPath);
    return nodeId;
  }

  get(nodeId: string): SeatSandbox | null {
    const row = this.db.prepare("SELECT * FROM node_sandboxes WHERE node_id = ?").get(nodeId) as SandboxRow | undefined;
    return row ? toSandbox(row) : null;
  }

  list(): SeatSandbox[] {
    const rows = this.db.prepare("SELECT * FROM node_sandboxes ORDER BY created_at, node_id").all() as SandboxRow[];
    return rows.map(toSandbox);
  }

  /** The sandboxes of a rig's seats, in the order the seats were created. The integration branch's is not one of them. */
  forRig(rigName: string): SeatSandbox[] {
    const rows = this.db
      .prepare("SELECT * FROM node_sandboxes WHERE rig_name = ? AND node_id NOT LIKE 'integration:%' ORDER BY created_at, seat")
      .all(rigName) as SandboxRow[];
    return rows.map(toSandbox);
  }

  /** Close a record whose worktree and branch the caller has just removed. */
  markRemoved(nodeId: string): void {
    this.db.prepare("UPDATE node_sandboxes SET state = 'removed', setup_state = 'none', updated_at = datetime('now') WHERE node_id = ?").run(nodeId);
  }

  /** Record how a setup run ended. */
  recordSetup(nodeId: string, state: "passed" | "failed", output: string): void {
    this.db.prepare("UPDATE node_sandboxes SET setup_state = ?, setup_output = ?, updated_at = datetime('now') WHERE node_id = ?").run(state, output, nodeId);
  }

  /** The root of the git repository that contains a sandbox's authored cwd. */
  async repositoryRoot(repoPath: string): Promise<string> {
    return (await locateRepo(repoPath)).top;
  }

  /**
   * Make sure the node's worktree exists and return the directory the seat should run in, or null when
   * the node did not ask for a sandbox. Safe to call on every launch: an existing worktree is reused,
   * a deleted one is recreated on its branch, and a worktree left by an earlier generation of the same
   * rig and seat is adopted. A `setup` command runs whenever the worktree is fresh or its last setup
   * did not pass; if it fails, so does this call, and the seat does not start.
   */
  async provision(nodeId: string): Promise<string | null> {
    const row = this.get(nodeId);
    if (!row) return null;
    const setupSettled = row.setupState === "none" || row.setupState === "passed";
    if (row.state === "provisioned" && setupSettled && row.worktreePath && fs.existsSync(path.join(row.worktreePath, ".git"))) {
      return path.join(row.worktreePath, row.subdir);
    }

    const { real, top } = await locateRepo(row.repoPath);
    const head = await sandboxGit(["rev-parse", "--verify", "HEAD"], top).catch(() => {
      throw new SandboxError("failed", `${top} has no commits yet, so there is nothing to branch a worktree from. Make an initial commit first.`);
    });
    const subdir = path.relative(top, real);
    const branch = row.branch ?? `squad/${segment(row.rigName)}/${segment(row.seat)}`;
    const worktreePath = row.worktreePath ?? rigWorktreePath(top, row.rigName, row.seat);

    // Forget worktrees whose directory was deleted, so their branch and path are free again.
    await sandboxGit(["worktree", "prune"], top);
    // Set only when this call creates the branch. A branch that already existed keeps the base it was
    // first recorded with, even when this call has to attach a new worktree to it.
    let baseSha: string | null = null;
    let created = false;
    if (!(await isWorktreeOnBranch(top, worktreePath, branch))) {
      if (fs.existsSync(worktreePath) && fs.readdirSync(worktreePath).length > 0) {
        throw new SandboxError(
          "failed",
          `${worktreePath} already exists and is not the worktree for branch ${branch}. Move it aside, then relaunch the seat.`,
        );
      }
      const reuseBranch = await branchExists(top, branch);
      // core.longpaths: Windows refuses to check out deep trees into a nested path without it.
      await sandboxGit(
        ["-c", "core.longpaths=true", "worktree", "add", "--quiet", ...(reuseBranch ? [worktreePath, branch] : ["-b", branch, worktreePath, head])],
        top,
      );
      created = true;
      if (!reuseBranch) baseSha = head;
    }
    if (baseSha === null) {
      const earlier = this.db
        .prepare("SELECT base_sha FROM node_sandboxes WHERE worktree_path = ? AND node_id <> ? AND base_sha IS NOT NULL LIMIT 1")
        .get(worktreePath, nodeId) as { base_sha: string } | undefined;
      baseSha = row.baseSha ?? earlier?.base_sha ?? (await sandboxGit(["rev-parse", "HEAD"], worktreePath));
    }

    let setupState = row.setupState;
    this.db.transaction(() => {
      // A fresh checkout has none of what setup installed, whatever was recorded before.
      if (created) {
        setupState = row.setup ? "pending" : "none";
      } else if (row.setup && setupState === "pending") {
        // An adopted worktree keeps what an earlier generation of the rig installed there, if it ran the same setup.
        const earlier = this.db
          .prepare("SELECT setup_json FROM node_sandboxes WHERE worktree_path = ? AND node_id <> ? AND setup_state = 'passed' LIMIT 1")
          .get(worktreePath, nodeId) as { setup_json: string | null } | undefined;
        if (earlier?.setup_json === JSON.stringify(row.setup)) setupState = "passed";
      }
      // A rig started again under the same name gets new node ids; the old rows would point at this worktree too.
      this.db.prepare("DELETE FROM node_sandboxes WHERE worktree_path = ? AND node_id <> ?").run(worktreePath, nodeId);
      this.db
        .prepare(
          "UPDATE node_sandboxes SET state = 'provisioned', worktree_path = ?, subdir = ?, branch = ?, base_sha = ?, setup_state = ?, updated_at = datetime('now') WHERE node_id = ?",
        )
        .run(worktreePath, subdir, branch, baseSha, setupState, nodeId);
    })();

    const seatCwd = path.join(worktreePath, subdir);
    // The authored directory may be untracked, in which case a fresh checkout does not have it.
    fs.mkdirSync(seatCwd, { recursive: true });

    if (row.setup && setupState !== "passed") {
      const outcome = await this.runSetup(nodeId);
      if (outcome.status !== "passed") {
        throw new SandboxError(
          "failed",
          `Setup failed for ${row.seat} (${describeResult(outcome)}): ${row.setup.join(" ")}\n${lastLines(outcome.outputTail)}\n` +
            `Fix it, then relaunch the seat, or run: squad sandbox setup ${nodeId}`,
        );
      }
    }
    return seatCwd;
  }

  /**
   * Run the member's `setup` command in the root of its worktree and record whether it passed. This is
   * what `provision` calls for a fresh worktree; it is also how an operator re-runs it, for example after
   * a lockfile changes. A failing command is a result, not an error.
   */
  async runSetup(nodeId: string, opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const row = this.get(nodeId);
    if (!row) throw new SandboxError("not_found", `No sandbox is recorded for node ${nodeId}.`);
    if (!row.setup) {
      throw new SandboxError("failed", `No setup command is configured for ${row.seat}. Add setup: [...] to the member in the rig spec.`);
    }
    const worktree = row.worktreePath;
    if (row.state !== "provisioned" || !worktree || !fs.existsSync(path.join(worktree, ".git"))) {
      throw new SandboxError("failed", `${row.seat} has no worktree yet. Launch the seat first.`);
    }
    const command = row.setup;
    return exclusive(`setup:${nodeId}`, `Setup is already running for ${row.seat}.`, async () => {
      const result = await runCommand(command, { cwd: worktree, timeoutMs: opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });
      this.recordSetup(nodeId, result.status === "passed" ? "passed" : "failed", result.outputTail);
      return result;
    });
  }

  /**
   * Take a sandbox away: remove its worktree and, when git reports it fully merged, its branch. An
   * unmerged branch is kept so no commit is lost. Refuses while the seat is running or the worktree has
   * uncommitted changes, unless `force` is set.
   */
  async remove(nodeId: string, opts: { force?: boolean } = {}): Promise<SandboxRemoval> {
    const row = this.get(nodeId);
    if (!row) throw new SandboxError("not_found", `No sandbox is recorded for node ${nodeId}.`);
    if (row.state === "removed") return { worktreeRemoved: false, branchDeleted: false };
    if (!opts.force && this.db.prepare("SELECT 1 FROM sessions WHERE node_id = ? AND status = 'running' LIMIT 1").get(nodeId)) {
      throw new SandboxError("in_use", `The seat is running in ${row.worktreePath}. Stop it first, or pass --force.`);
    }

    let worktreeRemoved = false;
    let branchDeleted = false;
    // If the repository and the worktree were both deleted by hand there is nothing left for git to
    // clean up, and the record must still be closable.
    const nothingOnDisk = !fs.existsSync(row.repoPath) && !(row.worktreePath && fs.existsSync(row.worktreePath));
    if (row.worktreePath && !nothingOnDisk) {
      const { top } = await locateRepo(row.repoPath);
      if (fs.existsSync(row.worktreePath)) {
        await sandboxGit(["worktree", "remove", ...(opts.force ? ["--force"] : []), row.worktreePath], top);
        worktreeRemoved = true;
      }
      await sandboxGit(["worktree", "prune"], top);
      if (row.branch) {
        branchDeleted = await sandboxGit(["branch", "-d", row.branch], top).then(
          () => true,
          () => false,
        );
      }
    }
    this.db.prepare("UPDATE node_sandboxes SET state = 'removed', updated_at = datetime('now') WHERE node_id = ?").run(nodeId);
    return { worktreeRemoved, branchDeleted };
  }
}
