import { Command } from "commander";
import { askDaemon, refused, requestTimeoutMs, timeoutSeconds } from "./sandbox-client.js";

// `gate run` — run a seat's gate, the command its rig spec member declares to decide whether its work may
// land. The daemon runs it in the seat's worktree and records the result against the commit it tested;
// `squad land` reads those results. This command asks and reports.

export interface GateRunView {
  seat: string;
  commitSha: string;
  argv: string[];
  status: "passed" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

/** A command line for a message: arguments with spaces are quoted so it can be read back. */
export const commandLine = (argv: string[]): string => argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** One run as text: the verdict on the first line, then, if it did not pass, the end of its output. */
export function formatGateRun(run: GateRunView, tailLines = 30): string {
  const subject = `${run.seat} at ${run.commitSha.slice(0, 7)}`;
  if (run.status === "passed") return `Gate passed for ${subject} (${seconds(run.durationMs)}): ${commandLine(run.argv)}`;
  const verdict =
    run.status === "failed" ? `failed (exit code ${run.exitCode})` : run.status === "timed_out" ? "timed out" : "did not complete";
  const tail = run.outputTail.trimEnd().split(/\r?\n/).slice(-tailLines).join("\n");
  return `Gate ${verdict} for ${subject} (${seconds(run.durationMs)}): ${commandLine(run.argv)}${tail ? `\n${tail}` : ""}`;
}

export function gateCommand(): Command {
  const gate = new Command("gate").description("Run a seat's gate, the command that decides whether its work may land");

  gate
    .command("run")
    .description("Run the seat's gate in its worktree and record the result against the commit it tested")
    .argument("<node-id>", "Node id, from `sandbox ls`")
    .option("--timeout <seconds>", "Stop the gate after this many seconds (default 900)")
    .option("--json", "Output the run as JSON")
    .action(async (nodeId: string, opts: { timeout?: string; json?: boolean }) => {
      const timeout = timeoutSeconds(opts.timeout);
      if (timeout === null) return;
      const res = await askDaemon((client) =>
        client.post<{ ok?: boolean; run?: GateRunView; error?: string }>(
          `/api/sandboxes/${encodeURIComponent(nodeId)}/gate`,
          timeout === undefined ? undefined : { timeoutSeconds: timeout },
          { timeoutMs: requestTimeoutMs(timeout) },
        ),
      );
      if (!res) return;
      if (!res.data.ok || !res.data.run) return refused(res.status, res.data);
      console.log(opts.json ? JSON.stringify(res.data.run, null, 2) : formatGateRun(res.data.run));
      if (res.data.run.status !== "passed") process.exitCode = 1;
    });

  return gate;
}
