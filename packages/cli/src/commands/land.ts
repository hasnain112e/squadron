import { Command } from "commander";
import { commandLine } from "./gate.js";
import { askDaemon, refused, timeoutSeconds } from "./sandbox-client.js";

// `land` — bring the work of a rig's isolated seats together on the rig's integration branch, after each
// seat's gate has passed at the commit being merged, then gate the result as a whole. Nothing on your own
// branches changes: the result is a branch to review and merge, and `land --reset` throws it away.
// The daemon does the work and holds every rule; this command asks and reports.

type RunStatus = "passed" | "failed" | "timed_out" | "error";

export interface LandResultView {
  outcome: "landed" | "nothing_to_land" | "conflict" | "gate_failed" | "setup_failed" | "not_ready";
  rig: string;
  branch: string;
  worktreePath: string;
  tipSha: string | null;
  lanes: Array<{
    nodeId: string;
    seat: string;
    branch: string;
    tipSha: string | null;
    result: "merged" | "already_landed" | "conflict" | "not_attempted" | "not_ready";
    detail?: string;
    files?: string[];
  }>;
  setup: { argv: string[]; status: RunStatus; exitCode: number | null; outputTail: string } | null;
  gates: Array<{
    seats: string[];
    argv: string[];
    subdir: string;
    reused: boolean;
    run: { status: RunStatus; exitCode: number | null; durationMs: number; commitSha: string; outputTail: string };
  }>;
}

const LANE_WORDS: Record<LandResultView["lanes"][number]["result"], string> = {
  merged: "merged",
  already_landed: "already landed",
  conflict: "conflict",
  not_attempted: "not merged",
  not_ready: "not ready",
};

const tail = (text: string, lines = 30): string => text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");

/** A landing as text: one line per lane, then each gate, then what happened and what to do next. */
export function formatLand(result: LandResultView): string {
  const seatWidth = Math.max(...result.lanes.map((lane) => lane.seat.length));
  const lines = [`Rig ${result.rig} -> ${result.branch}`];
  for (const lane of result.lanes) {
    const sha = lane.tipSha ? lane.tipSha.slice(0, 7) : "-------";
    lines.push(`  ${lane.seat.padEnd(seatWidth)}  ${LANE_WORDS[lane.result].padEnd(14)}  ${sha}${lane.detail ? `  ${lane.detail}` : ""}`);
    for (const file of lane.files ?? []) lines.push(`      conflict in ${file}`);
  }

  for (const gate of result.gates) {
    const where = gate.subdir ? ` in ${gate.subdir}` : "";
    const verdict = gate.run.status === "passed" ? "passed" : gate.run.status === "failed" ? `failed (exit code ${gate.run.exitCode})` : gate.run.status === "timed_out" ? "timed out" : "did not complete";
    const when = gate.reused ? "already passed at this commit" : `${(gate.run.durationMs / 1000).toFixed(1)}s`;
    lines.push(`Gate ${verdict}: ${commandLine(gate.argv)}${where} for ${gate.seats.join(", ")} at ${gate.run.commitSha.slice(0, 7)} (${when})`);
    if (gate.run.status !== "passed") lines.push(tail(gate.run.outputTail));
  }
  if (result.setup) {
    lines.push(`Setting up the integration worktree failed: ${commandLine(result.setup.argv)} (${result.setup.status === "failed" ? `exit code ${result.setup.exitCode}` : result.setup.status.replace("_", " ")})`);
    lines.push(tail(result.setup.outputTail));
  }

  switch (result.outcome) {
    case "landed":
      lines.push(`Landed. The result is on ${result.branch}, checked out at ${result.worktreePath}. Review it, then merge it into your own branch when you are ready; landing never changes your branches.`);
      break;
    case "nothing_to_land":
      lines.push("Nothing new to land: every lane is already included.");
      break;
    case "not_ready":
      lines.push(`Nothing was merged: some lanes are not ready, and ${result.branch} is unchanged.`);
      break;
    case "conflict": {
      const lane = result.lanes.find((candidate) => candidate.result === "conflict")!;
      lines.push(
        `Stopped at a conflict in ${lane.seat}. ${result.branch} keeps the lanes merged before it and is otherwise unchanged. ` +
          `To resolve it, merge ${result.branch} into ${lane.branch} in that seat's worktree, fix the conflict and commit, ` +
          `run: squad gate run ${lane.nodeId}, then land again.`,
      );
      break;
    }
    case "gate_failed":
      lines.push(`The integration branch failed its gate. It is kept at ${result.worktreePath} so you can look. Fix the lanes and land again, or run: squad land ${result.rig} --reset`);
      break;
    case "setup_failed":
      lines.push(`Fix the setup command, then land again, or run: squad land ${result.rig} --reset`);
      break;
  }
  return lines.join("\n");
}

export function formatReset(reset: { worktreeRemoved: boolean; branchDeleted: boolean }): string {
  if (!reset.worktreeRemoved && !reset.branchDeleted) return "There was no integration branch or worktree to remove.";
  return [
    reset.worktreeRemoved ? "Removed the integration worktree." : "There was no integration worktree on disk.",
    reset.branchDeleted ? "Deleted the integration branch. The seats' branches are untouched." : "There was no integration branch.",
  ].join("\n");
}

export function landCommand(): Command {
  return new Command("land")
    .description("Land a rig's isolated seats on its integration branch, or throw that branch away with --reset")
    .argument("<rig>", "Rig name")
    .option("--reset", "Throw the integration branch and its worktree away instead of landing")
    .option("--force", "With --reset: discard uncommitted changes in the integration worktree")
    .option("--timeout <seconds>", "Stop each setup or gate command after this many seconds (default 900)")
    .option("--json", "Output JSON")
    .action(async (rig: string, opts: { reset?: boolean; force?: boolean; timeout?: string; json?: boolean }) => {
      if (opts.force && !opts.reset) {
        console.error("--force only applies to --reset.");
        process.exitCode = 1;
        return;
      }
      const timeout = timeoutSeconds(opts.timeout);
      if (timeout === null) return;

      if (opts.reset) {
        const res = await askDaemon((client) =>
          client.post<{ ok?: boolean; worktreeRemoved?: boolean; branchDeleted?: boolean; error?: string }>(
            "/api/land/reset",
            { rig, force: opts.force === true },
            { timeoutMs: 120_000 },
          ),
        );
        if (!res) return;
        if (!res.data.ok) return refused(res.status, res.data);
        console.log(opts.json ? JSON.stringify(res.data, null, 2) : formatReset({ worktreeRemoved: res.data.worktreeRemoved === true, branchDeleted: res.data.branchDeleted === true }));
        return;
      }

      // Landing can run setup and several gates, each up to the timeout, so the request gets a long ceiling.
      const res = await askDaemon((client) =>
        client.post<{ ok?: boolean; result?: LandResultView; error?: string }>(
          "/api/land",
          { rig, ...(timeout === undefined ? {} : { timeoutSeconds: timeout }) },
          { timeoutMs: 2 * 60 * 60 * 1000 },
        ),
      );
      if (!res) return;
      if (!res.data.ok || !res.data.result) return refused(res.status, res.data);
      console.log(opts.json ? JSON.stringify(res.data.result, null, 2) : formatLand(res.data.result));
      if (res.data.result.outcome !== "landed" && res.data.result.outcome !== "nothing_to_land") process.exitCode = 1;
    });
}
