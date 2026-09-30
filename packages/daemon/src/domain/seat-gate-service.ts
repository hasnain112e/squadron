import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { runCommand, type CommandResult } from "./sandbox-command-runner.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, SandboxError, exclusive, sandboxGit } from "./sandbox-common.js";
import type { SeatSandboxService } from "./seat-sandbox-service.js";

// The gate: a command the member declares that decides whether its work may land. A run belongs to the
// commit it tested, so a pass on an older commit never counts for a newer one, and it is only recorded
// when the worktree held still while it ran. Runs are kept as history; nothing here changes a seat's files.

export type GateLane = "seat" | "integration";

export interface GateRun {
  id: string;
  nodeId: string;
  rigName: string;
  seat: string;
  lane: GateLane;
  commitSha: string;
  argv: string[];
  subdir: string;
  status: CommandResult["status"];
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  startedAt: string;
}

interface GateRunRow {
  id: string;
  node_id: string;
  rig_name: string;
  seat: string;
  lane: GateLane;
  commit_sha: string;
  argv_json: string;
  subdir: string;
  status: CommandResult["status"];
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
  started_at: string;
}

function toRun(row: GateRunRow): GateRun {
  return {
    id: row.id,
    nodeId: row.node_id,
    rigName: row.rig_name,
    seat: row.seat,
    lane: row.lane,
    commitSha: row.commit_sha,
    argv: JSON.parse(row.argv_json) as string[],
    subdir: row.subdir,
    status: row.status,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    outputTail: row.output_tail,
    startedAt: row.started_at,
  };
}

/** Files whose tracked content differs from HEAD, staged or not. Untracked files are not counted. */
export async function trackedChanges(worktree: string): Promise<string[]> {
  const changed = await sandboxGit(["diff", "--name-only", "HEAD"], worktree);
  return changed ? changed.split(/\r?\n/) : [];
}

export class SeatGateService {
  constructor(
    private readonly db: Database.Database,
    private readonly sandboxes: SeatSandboxService,
  ) {}

  /**
   * Run the seat's gate in its worktree and record the result against the commit it tested. A gate that
   * fails is a result, not an error; an error means it could not be run at all (no gate configured, no
   * worktree, setup not passed, uncommitted changes to tracked files, or the seat is off its own branch).
   */
  async run(nodeId: string, opts: { timeoutMs?: number } = {}): Promise<GateRun> {
    const row = this.sandboxes.get(nodeId);
    if (!row) throw new SandboxError("not_found", `No sandbox is recorded for node ${nodeId}.`);
    if (!row.gate) throw new SandboxError("failed", `No gate is configured for ${row.seat}. Add gate: [...] to the member in the rig spec.`);
    const worktree = row.worktreePath;
    if (row.state !== "provisioned" || !worktree || !fs.existsSync(path.join(worktree, ".git"))) {
      throw new SandboxError("failed", `${row.seat} has no worktree yet. Launch the seat first.`);
    }
    if (row.setup && row.setupState !== "passed") {
      throw new SandboxError("failed", `Setup has not passed for ${row.seat} (it is ${row.setupState}). Run: squad sandbox setup ${nodeId}`);
    }
    const gate = row.gate;

    return exclusive(`gate:${nodeId}`, `A gate is already running for ${row.seat}.`, async () => {
      const branch = await sandboxGit(["symbolic-ref", "--short", "-q", "HEAD"], worktree).catch(() => "");
      if (branch !== row.branch) {
        throw new SandboxError(
          "failed",
          `${row.seat}'s worktree is on ${branch || "a detached HEAD"}, not its own branch ${row.branch}. The gate tests the seat's branch, so switch back first.`,
        );
      }
      const before = await trackedChanges(worktree);
      if (before.length > 0) {
        const shown = before.slice(0, 5).join(", ") + (before.length > 5 ? `, and ${before.length - 5} more` : "");
        throw new SandboxError("failed", `${row.seat} has uncommitted changes to tracked files (${shown}). Commit or stash them: a gate result belongs to a commit.`);
      }
      const commitSha = await sandboxGit(["rev-parse", "HEAD"], worktree);

      const result = await runCommand(gate, { cwd: path.join(worktree, row.subdir), timeoutMs: opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });

      // A seat that keeps working while its gate runs makes the result describe something that no longer exists.
      const moved = (await sandboxGit(["rev-parse", "HEAD"], worktree)) !== commitSha || (await trackedChanges(worktree)).length > 0;
      const settled: CommandResult = moved
        ? {
            ...result,
            status: "error",
            outputTail:
              `The worktree changed while the gate was running (a new commit, or edits to tracked files, made by the seat or by the gate command itself), ` +
              `so this result was not counted for ${commitSha.slice(0, 7)}. Run the gate again when the seat is idle; a gate should not modify tracked files.\n\n${result.outputTail}`,
          }
        : result;
      return this.record({ nodeId, rigName: row.rigName, seat: row.seat, lane: "seat", commitSha, argv: gate, subdir: row.subdir }, settled);
    });
  }

  /** Run `argv` in `cwd` and record it as a gate run. Also how the integration branch is gated. */
  async runAndRecord(
    subject: { nodeId: string; rigName: string; seat: string; lane: GateLane; commitSha: string; argv: string[]; subdir: string },
    cwd: string,
    timeoutMs: number,
  ): Promise<GateRun> {
    return this.record(subject, await runCommand(subject.argv, { cwd, timeoutMs }));
  }

  private record(
    subject: { nodeId: string; rigName: string; seat: string; lane: GateLane; commitSha: string; argv: string[]; subdir: string },
    result: CommandResult,
  ): GateRun {
    const id = ulid();
    // Recorded with an explicit start time in one format, so "the latest run" sorts correctly.
    const startedAt = new Date(Date.now() - result.durationMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO sandbox_gate_runs (id, node_id, rig_name, seat, lane, commit_sha, argv_json, subdir, status, exit_code, duration_ms, output_tail, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, subject.nodeId, subject.rigName, subject.seat, subject.lane, subject.commitSha, JSON.stringify(subject.argv), subject.subdir, result.status, result.exitCode, result.durationMs, result.outputTail, startedAt);
    return toRun(this.db.prepare("SELECT * FROM sandbox_gate_runs WHERE id = ?").get(id) as GateRunRow);
  }

  /** The most recent seat run at exactly this commit, or null. */
  latestAt(nodeId: string, commitSha: string): GateRun | null {
    const row = this.db
      .prepare("SELECT * FROM sandbox_gate_runs WHERE node_id = ? AND lane = 'seat' AND commit_sha = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(nodeId, commitSha) as GateRunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The most recent seat run at any commit, or null. Used to explain why a lane is not ready. */
  latest(nodeId: string): GateRun | null {
    const row = this.db
      .prepare("SELECT * FROM sandbox_gate_runs WHERE node_id = ? AND lane = 'seat' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(nodeId) as GateRunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The most recent integration run of this command, in this directory, at exactly this commit, or null. */
  latestIntegration(rigName: string, commitSha: string, argv: string[], subdir: string): GateRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sandbox_gate_runs WHERE rig_name = ? AND lane = 'integration' AND commit_sha = ? AND argv_json = ? AND subdir = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(rigName, commitSha, JSON.stringify(argv), subdir) as GateRunRow | undefined;
    return row ? toRun(row) : null;
  }
}
