import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand, type CommandResult } from "./sandbox-command-runner.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  SandboxError,
  branchExists,
  exclusive,
  integrationNodeId,
  rigWorktreePath,
  samePath,
  sandboxGit,
  segment,
} from "./sandbox-common.js";
import { trackedChanges, type GateRun, type SeatGateService } from "./seat-gate-service.js";
import type { SeatSandbox, SeatSandboxService } from "./seat-sandbox-service.js";

// Landing: bring the work of a rig's isolated seats together on one integration branch,
// `squad/<rig>/integration`, in its own worktree. A lane lands only if its gate passed at the exact commit
// that would be merged, and that exact commit is what gets merged, so a seat that keeps committing cannot
// slip untested work in. The first conflict stops the landing and leaves the branch as it was. The
// integration branch is then set up and gated as a whole. The repository's own branches are never touched:
// the result is a branch to review and merge, and `reset` throws it away.

export type LaneResult = "merged" | "already_landed" | "conflict" | "not_attempted" | "not_ready" | "would_merge";

export interface LandLane {
  nodeId: string;
  seat: string;
  branch: string;
  tipSha: string | null;
  result: LaneResult;
  /** Why a lane is not ready. */
  detail?: string;
  /** The files that conflicted, when result is "conflict". */
  files?: string[];
}

export interface LandGate {
  /** The seats whose gate this is; seats that declare the same command in the same directory share one run. */
  seats: string[];
  argv: string[];
  subdir: string;
  /** A passing run at this same integration commit already existed, so nothing was run again. */
  reused: boolean;
  run: GateRun;
}

/** "ready" is only ever the answer to a dry run: every lane could land, and none was touched. */
export type LandOutcome = "landed" | "nothing_to_land" | "conflict" | "gate_failed" | "setup_failed" | "not_ready" | "ready";

export interface LandResult {
  outcome: LandOutcome;
  rig: string;
  branch: string;
  worktreePath: string;
  /** The integration branch's tip after this call, or where it would start if nothing was created. */
  tipSha: string | null;
  lanes: LandLane[];
  /** The setup command that failed, when outcome is "setup_failed". */
  setup: (CommandResult & { argv: string[] }) | null;
  gates: LandGate[];
}

export interface LandReset {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

async function isAncestor(top: string, ancestor: string, descendant: string): Promise<boolean> {
  return sandboxGit(["merge-base", "--is-ancestor", ancestor, descendant], top).then(
    () => true,
    () => false,
  );
}

export class SandboxLandingService {
  constructor(
    private readonly sandboxes: SeatSandboxService,
    private readonly gates: SeatGateService,
  ) {}

  /**
   * Land every isolated seat of `rigName` on the rig's integration branch. Safe to call again: lanes already on
   * the branch are left alone, and only work committed and gated since is merged. With `dryRun`, stop once the
   * lanes are judged: no worktree, merge, setup or gate happens, so a conflict is not found, only lanes that are not ready.
   */
  async land(rigName: string, opts: { timeoutMs?: number; dryRun?: boolean } = {}): Promise<LandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return exclusive<LandResult>(`land:${rigName}`, `A land is already running for rig ${rigName}.`, async () => {
      const seats = this.sandboxes.forRig(rigName).filter((seat) => seat.state === "provisioned" && seat.branch !== null);
      if (seats.length === 0) {
        throw new SandboxError("not_found", `Rig ${rigName} has no provisioned sandboxes. Launch its isolated seats first.`);
      }
      const top = await this.repositoryOf(rigName, seats);
      const branch = `squad/${segment(rigName)}/integration`;
      const existing = await branchExists(top, branch);
      // Lanes are judged against what the integration branch already holds, or where it will start.
      const reference = await sandboxGit(["rev-parse", "--verify", existing ? `refs/heads/${branch}` : "HEAD"], top);
      const lanes = await this.classify(seats, reference, top);
      const base = { rig: rigName, branch, worktreePath: rigWorktreePath(top, rigName, "integration"), lanes, setup: null, gates: [] as LandGate[] };

      if (lanes.some((lane) => lane.result === "not_ready")) return { ...base, outcome: "not_ready", tipSha: reference };
      const pending = lanes.filter((lane) => lane.result === "not_attempted");
      if (pending.length === 0 && !existing) return { ...base, outcome: "nothing_to_land", tipSha: reference };
      if (opts.dryRun) {
        for (const lane of pending) lane.result = "would_merge";
        return { ...base, outcome: pending.length === 0 ? "nothing_to_land" : "ready", tipSha: reference };
      }

      const integrationId = this.sandboxes.requestIntegration({ rigName, repoPath: seats[0]!.repoPath });
      await this.sandboxes.provision(integrationId);
      const integration = this.sandboxes.get(integrationId)!;
      const worktree = integration.worktreePath!;
      await this.requireUsable(rigName, branch, worktree);

      let conflicted = false;
      for (const lane of pending) {
        if (conflicted) break; // later lanes stay "not_attempted"
        conflicted = await this.merge(lane, worktree);
      }
      const tipSha = await sandboxGit(["rev-parse", "HEAD"], worktree);
      if (conflicted) return { ...base, outcome: "conflict", tipSha };

      // The lanes now on the branch, whether merged just now or earlier, decide what to set up and gate.
      const onBranch = lanes.filter((lane) => lane.result === "merged" || lane.result === "already_landed").map((lane) => seats.find((seat) => seat.nodeId === lane.nodeId)!);
      const mergedNow = lanes.some((lane) => lane.result === "merged");

      // New merges can change the lockfile, so setup runs again after them; otherwise once per fresh worktree.
      const setups = distinct(onBranch.filter((seat) => seat.setup).map((seat) => seat.setup!), (argv) => JSON.stringify(argv));
      if (setups.length > 0 && (mergedNow || integration.setupState !== "passed")) {
        for (const argv of setups) {
          const result = await runCommand(argv, { cwd: worktree, timeoutMs });
          if (result.status !== "passed") {
            this.sandboxes.recordSetup(integrationId, "failed", result.outputTail);
            return { ...base, outcome: "setup_failed", tipSha, setup: { ...result, argv } };
          }
        }
        this.sandboxes.recordSetup(integrationId, "passed", "");
      }

      const wanted = new Map<string, { argv: string[]; subdir: string; owners: SeatSandbox[] }>();
      for (const seat of onBranch) {
        if (!seat.gate) continue;
        const key = JSON.stringify([seat.gate, seat.subdir]);
        const entry = wanted.get(key) ?? { argv: seat.gate, subdir: seat.subdir, owners: [] };
        entry.owners.push(seat);
        wanted.set(key, entry);
      }
      const gates: LandGate[] = [];
      let failed = false;
      for (const { argv, subdir, owners } of wanted.values()) {
        const earlier = this.gates.latestIntegration(rigName, tipSha, argv, subdir);
        if (earlier?.status === "passed") {
          gates.push({ seats: owners.map((seat) => seat.seat), argv, subdir, reused: true, run: earlier });
          continue;
        }
        const run = await this.gates.runAndRecord(
          { nodeId: owners[0]!.nodeId, rigName, seat: owners[0]!.seat, lane: "integration", commitSha: tipSha, argv, subdir },
          path.join(worktree, subdir),
          timeoutMs,
        );
        gates.push({ seats: owners.map((seat) => seat.seat), argv, subdir, reused: false, run });
        if (run.status !== "passed") {
          failed = true;
          break;
        }
      }
      return { ...base, outcome: failed ? "gate_failed" : mergedNow ? "landed" : "nothing_to_land", tipSha, gates };
    });
  }

  /**
   * Throw the integration branch and its worktree away. The seats' branches are untouched, so landing again
   * starts fresh from the repository's current HEAD. Refuses a worktree with uncommitted changes unless forced.
   */
  async reset(rigName: string, opts: { force?: boolean } = {}): Promise<LandReset> {
    return exclusive<LandReset>(`land:${rigName}`, `A land is running for rig ${rigName}.`, async () => {
      const integrationId = integrationNodeId(rigName);
      const integration = this.sandboxes.get(integrationId);
      const repoPath = integration?.repoPath ?? this.sandboxes.forRig(rigName)[0]?.repoPath;
      if (!repoPath) throw new SandboxError("not_found", `No sandboxes are recorded for rig ${rigName}.`);
      const top = await this.sandboxes.repositoryRoot(repoPath);
      const branch = `squad/${segment(rigName)}/integration`;
      const worktreePath = rigWorktreePath(top, rigName, "integration");

      let worktreeRemoved = false;
      let branchDeleted = false;
      if (fs.existsSync(worktreePath)) {
        await sandboxGit(["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath], top);
        worktreeRemoved = true;
      }
      await sandboxGit(["worktree", "prune"], top);
      // The branch holds only merges of the seats' own branches, which stay, so it is safe to force.
      if (await branchExists(top, branch)) {
        await sandboxGit(["branch", "-D", branch], top);
        branchDeleted = true;
      }
      if (integration) this.sandboxes.markRemoved(integrationId);
      return { worktreeRemoved, branchDeleted };
    });
  }

  private async repositoryOf(rigName: string, seats: SeatSandbox[]): Promise<string> {
    const roots = await Promise.all(seats.map((seat) => this.sandboxes.repositoryRoot(seat.repoPath)));
    if (roots.some((root) => !samePath(root, roots[0]!))) {
      throw new SandboxError("failed", `The isolated seats of rig ${rigName} are in more than one repository, and landing works on one repository at a time.`);
    }
    return roots[0]!;
  }

  /** Decide, for each seat in order, whether it is already on the branch, ready to merge, or not ready and why. */
  private async classify(seats: SeatSandbox[], reference: string, top: string): Promise<LandLane[]> {
    const lanes: LandLane[] = [];
    for (const seat of seats) {
      const lane: LandLane = { nodeId: seat.nodeId, seat: seat.seat, branch: seat.branch!, tipSha: null, result: "not_attempted" };
      lanes.push(lane);
      const notReady = (detail: string) => {
        lane.result = "not_ready";
        lane.detail = detail;
      };

      lane.tipSha = await sandboxGit(["rev-parse", "--verify", `refs/heads/${seat.branch}`], top).catch(() => null);
      if (!lane.tipSha) {
        notReady(`its branch ${seat.branch} no longer exists`);
      } else if (await isAncestor(top, lane.tipSha, reference)) {
        lane.result = "already_landed";
      } else if (!seat.gate) {
        notReady("no gate is configured, so nothing can show it is safe to land. Add gate: [...] to the member in the rig spec");
      } else {
        const run = this.gates.latestAt(seat.nodeId, lane.tipSha);
        if (!run) {
          const last = this.gates.latest(seat.nodeId);
          notReady(
            `no gate result for ${short(lane.tipSha)}${last ? ` (the last run was ${last.status} at ${short(last.commitSha)})` : ""}. Run: squad gate run ${seat.nodeId}`,
          );
        } else if (run.status !== "passed") {
          notReady(`the gate ${run.status.replace("_", " ")} at ${short(lane.tipSha)}. Fix it, then run: squad gate run ${seat.nodeId}`);
        }
      }
    }
    return lanes;
  }

  private async requireUsable(rigName: string, branch: string, worktree: string): Promise<void> {
    const onBranch = await sandboxGit(["symbolic-ref", "--short", "-q", "HEAD"], worktree).catch(() => "");
    if (onBranch !== branch) {
      throw new SandboxError("failed", `The integration worktree ${worktree} is on ${onBranch || "a detached HEAD"}, not ${branch}. Run: squad land ${rigName} --reset`);
    }
    const dirty = await trackedChanges(worktree);
    if (dirty.length > 0) {
      throw new SandboxError(
        "failed",
        `The integration worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}). Commit or discard them, or run: squad land ${rigName} --reset`,
      );
    }
  }

  /** Merge one lane's gated commit. Returns true on a conflict, after putting the worktree back as it was. */
  private async merge(lane: LandLane, worktree: string): Promise<boolean> {
    const before = await sandboxGit(["rev-parse", "HEAD"], worktree);
    try {
      // Merge the exact commit that was gated, not the branch name. No signing: a merge made by a tool must not wait for a passphrase.
      await sandboxGit(
        ["-c", "core.longpaths=true", "-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "-m", `squad: land ${lane.seat} (${short(lane.tipSha!)})`, lane.tipSha!],
        worktree,
      );
    } catch (error) {
      const conflicts = await sandboxGit(["diff", "--name-only", "--diff-filter=U"], worktree).catch(() => "");
      await sandboxGit(["merge", "--abort"], worktree).catch(() => undefined);
      if (conflicts) {
        lane.result = "conflict";
        lane.files = conflicts.split(/\r?\n/);
        return true;
      }
      const message = (error as Error).message;
      throw new SandboxError(
        "failed",
        /tell me who you are|identity unknown/i.test(message) ? `${message}\nSet git user.name and user.email, then land again.` : message,
      );
    }
    lane.result = (await sandboxGit(["rev-parse", "HEAD"], worktree)) === before ? "already_landed" : "merged";
    return false;
  }
}

function distinct<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
