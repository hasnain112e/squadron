import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";

// Gives a seat that declares `isolation: worktree` its own git worktree and branch, so parallel
// seats on one repository never write into the same checkout. A member asks for a sandbox when its
// node is created (`request`, database only) and the worktree is made when the seat launches
// (`provision`, idempotent). Nothing here deletes work: `remove` is only ever run by an operator, and
// a branch is dropped only when git says it is fully merged.

const execFileAsync = promisify(execFile);
// The first checkout of a large tree is slow; a hung git is still bounded.
const GIT_TIMEOUT_MS = 120_000;

export type SandboxErrorCode = "not_found" | "in_use" | "failed";

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

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
  created_at: string;
  updated_at: string;
}

/** One safe path and branch segment: letters, digits, `.`, `_`, `-`; never empty, never edged by a dot or dash. */
function segment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\.lock$/, "")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "seat";
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.relative(real(a), real(b)) === "";
}

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SeatSandboxService {
  constructor(private readonly db: Database.Database) {}

  /** Record that a node wants a sandbox. Database only, so it is safe inside the node-creation transaction. */
  request(input: { nodeId: string; rigId: string; seat: string; repoPath: string }): void {
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?").get(input.rigId) as { name: string } | undefined;
    if (!rig) throw new SandboxError("not_found", `Rig ${input.rigId} not found`);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO node_sandboxes (node_id, rig_name, seat, mode, repo_path) VALUES (?, ?, ?, 'worktree', ?)",
      )
      .run(input.nodeId, rig.name, input.seat, input.repoPath);
  }

  get(nodeId: string): SeatSandbox | null {
    const row = this.db.prepare("SELECT * FROM node_sandboxes WHERE node_id = ?").get(nodeId) as SandboxRow | undefined;
    return row ? toSandbox(row) : null;
  }

  list(): SeatSandbox[] {
    const rows = this.db.prepare("SELECT * FROM node_sandboxes ORDER BY created_at, node_id").all() as SandboxRow[];
    return rows.map(toSandbox);
  }

  /**
   * Make sure the node's worktree exists and return the directory the seat should run in, or null when
   * the node did not ask for a sandbox. Safe to call on every launch: an existing worktree is reused,
   * a deleted one is recreated on its branch, and a worktree left by an earlier generation of the same
   * rig and seat is adopted.
   */
  async provision(nodeId: string): Promise<string | null> {
    const row = this.get(nodeId);
    if (!row) return null;
    if (row.state === "provisioned" && row.worktreePath && fs.existsSync(path.join(row.worktreePath, ".git"))) {
      return path.join(row.worktreePath, row.subdir);
    }

    const { real, top } = await this.locate(row.repoPath);
    const head = await this.git(["rev-parse", "--verify", "HEAD"], top).catch(() => {
      throw new SandboxError("failed", `${top} has no commits yet, so there is nothing to branch a worktree from. Make an initial commit first.`);
    });
    const subdir = path.relative(top, real);
    const branch = row.branch ?? `squad/${segment(row.rigName)}/${segment(row.seat)}`;
    const worktreePath =
      row.worktreePath ??
      path.join(path.dirname(top), "squad-worktrees", segment(path.basename(top)), segment(row.rigName), segment(row.seat));

    // Forget worktrees whose directory was deleted, so their branch and path are free again.
    await this.git(["worktree", "prune"], top);
    // Set only when this call creates the branch. A branch that already existed keeps the base it was
    // first recorded with, even when this call has to attach a new worktree to it.
    let baseSha: string | null = null;
    if (!(await this.isWorktreeOnBranch(top, worktreePath, branch))) {
      if (fs.existsSync(worktreePath) && fs.readdirSync(worktreePath).length > 0) {
        throw new SandboxError(
          "failed",
          `${worktreePath} already exists and is not the worktree for branch ${branch}. Move it aside, then relaunch the seat.`,
        );
      }
      const branchExists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], top).then(
        () => true,
        () => false,
      );
      // core.longpaths: Windows refuses to check out deep trees into a nested path without it.
      await this.git(
        ["-c", "core.longpaths=true", "worktree", "add", "--quiet", ...(branchExists ? [worktreePath, branch] : ["-b", branch, worktreePath, head])],
        top,
      );
      if (!branchExists) baseSha = head;
    }
    if (baseSha === null) {
      const earlier = this.db
        .prepare("SELECT base_sha FROM node_sandboxes WHERE worktree_path = ? AND node_id <> ? AND base_sha IS NOT NULL LIMIT 1")
        .get(worktreePath, nodeId) as { base_sha: string } | undefined;
      baseSha = row.baseSha ?? earlier?.base_sha ?? (await this.git(["rev-parse", "HEAD"], worktreePath));
    }

    this.db.transaction(() => {
      // A rig started again under the same name gets new node ids; the old rows would point at this worktree too.
      this.db.prepare("DELETE FROM node_sandboxes WHERE worktree_path = ? AND node_id <> ?").run(worktreePath, nodeId);
      this.db
        .prepare(
          "UPDATE node_sandboxes SET state = 'provisioned', worktree_path = ?, subdir = ?, branch = ?, base_sha = ?, updated_at = datetime('now') WHERE node_id = ?",
        )
        .run(worktreePath, subdir, branch, baseSha, nodeId);
    })();

    const seatCwd = path.join(worktreePath, subdir);
    // The authored directory may be untracked, in which case a fresh checkout does not have it.
    fs.mkdirSync(seatCwd, { recursive: true });
    return seatCwd;
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
      const { top } = await this.locate(row.repoPath);
      if (fs.existsSync(row.worktreePath)) {
        await this.git(["worktree", "remove", ...(opts.force ? ["--force"] : []), row.worktreePath], top);
        worktreeRemoved = true;
      }
      await this.git(["worktree", "prune"], top);
      if (row.branch) {
        branchDeleted = await this.git(["branch", "-d", row.branch], top).then(
          () => true,
          () => false,
        );
      }
    }
    this.db.prepare("UPDATE node_sandboxes SET state = 'removed', updated_at = datetime('now') WHERE node_id = ?").run(nodeId);
    return { worktreeRemoved, branchDeleted };
  }

  /** Resolve the authored cwd to its real path and the root of the repository that contains it. */
  private async locate(repoPath: string): Promise<{ real: string; top: string }> {
    let real: string;
    try {
      real = fs.realpathSync.native(repoPath);
    } catch {
      throw new SandboxError("failed", `isolation: worktree needs the seat's repository directory, but ${repoPath} does not exist.`);
    }
    const top = await this.git(["rev-parse", "--show-toplevel"], real).catch((error: SandboxError) => {
      // Only say "not a repository" when git said so; a missing git binary or a timeout keeps its own message.
      if (!/not a git repository/i.test(error.message)) throw error;
      throw new SandboxError(
        "failed",
        `isolation: worktree needs a git repository, but ${real} is not inside one. Run git init there, or remove isolation: worktree from the member.`,
      );
    });
    return { real, top: fs.realpathSync.native(top) };
  }

  private async isWorktreeOnBranch(top: string, worktreePath: string, branch: string): Promise<boolean> {
    const listing = await this.git(["worktree", "list", "--porcelain"], top);
    for (const block of listing.split(/\r?\n\r?\n/)) {
      const fields = new Map<string, string>();
      for (const line of block.split(/\r?\n/)) {
        const space = line.indexOf(" ");
        if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
      }
      const listed = fields.get("worktree");
      if (listed && samePath(listed, worktreePath)) return fields.get("branch") === `refs/heads/${branch}`;
    }
    return false;
  }

  private async git(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true });
      return stdout.trim();
    } catch (error) {
      const { stderr, message } = error as { stderr?: string; message: string };
      throw new SandboxError("failed", `git ${args.join(" ")}: ${stderr?.trim() || message}`);
    }
  }
}
