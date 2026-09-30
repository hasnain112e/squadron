import { Command } from "commander";
import { askDaemon, refused, requestTimeoutMs, timeoutSeconds } from "./sandbox-client.js";

// `sandbox ls|rm|setup` — the seat worktrees that `isolation: worktree` creates. The daemon owns every rule
// (refusing a running seat or uncommitted changes, keeping a branch that is not merged); this command
// lists what it recorded and asks it to remove one or to run a seat's setup again.

export interface SandboxRow {
  nodeId: string;
  rigName: string;
  seat: string;
  state: "requested" | "provisioned" | "removed";
  branch: string | null;
  worktreePath: string | null;
}

/** One line per sandbox, columns padded to the widest value; the path last because it is the longest. */
export function formatSandboxes(rows: SandboxRow[]): string {
  if (rows.length === 0) {
    return "No seat sandboxes. Set `isolation: worktree` on a rig spec member to give a seat its own worktree.";
  }
  const table = [
    ["NODE", "RIG", "SEAT", "STATE", "BRANCH", "PATH"],
    ...rows.map((r) => [r.nodeId, r.rigName, r.seat, r.state, r.branch ?? "-", r.worktreePath ?? "-"]),
  ];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => row[col]!.length)));
  return table.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!))).join("  ")).join("\n");
}

export interface SetupResultView {
  status: "passed" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

/** A setup run as text: the verdict, then, if it did not pass, the end of its output. */
export function formatSetup(setup: SetupResultView, tailLines = 30): string {
  const took = `${(setup.durationMs / 1000).toFixed(1)}s`;
  if (setup.status === "passed") return `Setup passed (${took}).`;
  const verdict = setup.status === "failed" ? `failed (exit code ${setup.exitCode})` : setup.status === "timed_out" ? "timed out" : "did not start";
  const tail = setup.outputTail.trimEnd().split(/\r?\n/).slice(-tailLines).join("\n");
  return `Setup ${verdict} (${took}).${tail ? `\n${tail}` : ""}`;
}

export function sandboxCommand(): Command {
  const sandbox = new Command("sandbox").description("List, remove or set up the git worktrees given to seats by `isolation: worktree`");

  sandbox
    .command("ls")
    .description("List the recorded seat sandboxes, including those whose rig has been torn down")
    .option("--all", "Include sandboxes that were already removed")
    .option("--json", "Output JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const res = await askDaemon((client) => client.get<{ sandboxes?: SandboxRow[]; error?: string }>("/api/sandboxes"));
      if (!res) return;
      if (res.status >= 400 || !res.data.sandboxes) return refused(res.status, res.data);
      const rows = opts.all ? res.data.sandboxes : res.data.sandboxes.filter((s) => s.state !== "removed");
      console.log(opts.json ? JSON.stringify(rows, null, 2) : formatSandboxes(rows));
    });

  sandbox
    .command("rm")
    .description("Remove a seat's worktree; its branch too when git reports it fully merged")
    .argument("<node-id>", "Node id, from `sandbox ls`")
    .option("--force", "Remove even if the seat is running or the worktree has uncommitted changes")
    .action(async (nodeId: string, opts: { force?: boolean }) => {
      // Removing a large checkout takes longer than the client's default 5 seconds.
      const res = await askDaemon((client) =>
        client.delete<{ ok?: boolean; worktreeRemoved?: boolean; branchDeleted?: boolean; error?: string }>(
          `/api/sandboxes/${encodeURIComponent(nodeId)}${opts.force ? "?force=true" : ""}`,
          { timeoutMs: 120_000 },
        ),
      );
      if (!res) return;
      if (!res.data.ok) return refused(res.status, res.data);
      console.log(res.data.worktreeRemoved ? "Removed the worktree." : "There was no worktree on disk to remove.");
      console.log(res.data.branchDeleted ? "Deleted its branch, which was fully merged." : "Kept its branch: it has commits that are not merged, or there was none.");
    });

  sandbox
    .command("setup")
    .description("Run the seat's setup command again in its worktree, for example after its lockfile changed")
    .argument("<node-id>", "Node id, from `sandbox ls`")
    .option("--timeout <seconds>", "Stop the command after this many seconds (default 900)")
    .option("--json", "Output the result as JSON")
    .action(async (nodeId: string, opts: { timeout?: string; json?: boolean }) => {
      const timeout = timeoutSeconds(opts.timeout);
      if (timeout === null) return;
      const res = await askDaemon((client) =>
        client.post<{ ok?: boolean; setup?: SetupResultView; error?: string }>(
          `/api/sandboxes/${encodeURIComponent(nodeId)}/setup`,
          timeout === undefined ? undefined : { timeoutSeconds: timeout },
          { timeoutMs: requestTimeoutMs(timeout) },
        ),
      );
      if (!res) return;
      if (!res.data.ok || !res.data.setup) return refused(res.status, res.data);
      console.log(opts.json ? JSON.stringify(res.data.setup, null, 2) : formatSetup(res.data.setup));
      if (res.data.setup.status !== "passed") process.exitCode = 1;
    });

  return sandbox;
}
