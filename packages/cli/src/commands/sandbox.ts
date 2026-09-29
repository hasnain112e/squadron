import { Command } from "commander";

// `sandbox ls|rm` — the seat worktrees that `isolation: worktree` creates. The daemon owns every rule
// (refusing a running seat or uncommitted changes, keeping a branch that is not merged); this command
// lists what it recorded and asks it to remove one.

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

export function sandboxCommand(): Command {
  const sandbox = new Command("sandbox").description("List or remove the git worktrees given to seats by `isolation: worktree`");

  sandbox
    .command("ls")
    .description("List the recorded seat sandboxes, including those whose rig has been torn down")
    .option("--all", "Include sandboxes that were already removed")
    .option("--json", "Output JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { DaemonClient } = await import("../client.js");
      let res;
      try {
        res = await new DaemonClient().get<{ sandboxes?: SandboxRow[]; error?: string }>("/api/sandboxes");
      } catch (err) {
        console.error(`Could not reach the daemon (${(err as Error).message}). Start it with: squad start`);
        process.exitCode = 1;
        return;
      }
      if (res.status >= 400 || !res.data.sandboxes) {
        console.error(res.data.error ?? `The daemon refused the request (HTTP ${res.status}).`);
        process.exitCode = 1;
        return;
      }
      const rows = opts.all ? res.data.sandboxes : res.data.sandboxes.filter((s) => s.state !== "removed");
      console.log(opts.json ? JSON.stringify(rows, null, 2) : formatSandboxes(rows));
    });

  sandbox
    .command("rm")
    .description("Remove a seat's worktree; its branch too when git reports it fully merged")
    .argument("<node-id>", "Node id, from `sandbox ls`")
    .option("--force", "Remove even if the seat is running or the worktree has uncommitted changes")
    .action(async (nodeId: string, opts: { force?: boolean }) => {
      const { DaemonClient } = await import("../client.js");
      let res;
      try {
        // Removing a large checkout takes longer than the client's default 5 seconds.
        res = await new DaemonClient().delete<{ ok?: boolean; worktreeRemoved?: boolean; branchDeleted?: boolean; error?: string }>(
          `/api/sandboxes/${encodeURIComponent(nodeId)}${opts.force ? "?force=true" : ""}`,
          { timeoutMs: 120_000 },
        );
      } catch (err) {
        console.error(`Could not reach the daemon (${(err as Error).message}). Start it with: squad start`);
        process.exitCode = 1;
        return;
      }
      if (!res.data.ok) {
        console.error(res.data.error ?? `The daemon refused the request (HTTP ${res.status}).`);
        process.exitCode = 1;
        return;
      }
      console.log(res.data.worktreeRemoved ? "Removed the worktree." : "There was no worktree on disk to remove.");
      console.log(res.data.branchDeleted ? "Deleted its branch, which was fully merged." : "Kept its branch: it has commits that are not merged, or there was none.");
    });

  return sandbox;
}
