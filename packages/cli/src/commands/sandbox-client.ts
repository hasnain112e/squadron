import type { DaemonClient, DaemonResponse } from "../client.js";

// What `sandbox`, `gate` and `land` share: one request to the daemon, said the same way when the daemon
// is not there, and a --timeout option checked the same way.

/** Send one request. If the daemon cannot be reached, say so, fail the command and return null. */
export async function askDaemon<T>(send: (client: DaemonClient) => Promise<DaemonResponse<T>>): Promise<DaemonResponse<T> | null> {
  const { DaemonClient } = await import("../client.js");
  try {
    return await send(new DaemonClient());
  } catch (err) {
    console.error(`Could not reach the daemon (${(err as Error).message}). Start it with: squad start`);
    process.exitCode = 1;
    return null;
  }
}

/** Print why the daemon refused a request and fail the command. */
export function refused(status: number, data: { error?: string } | undefined): void {
  console.error(data?.error ?? `The daemon refused the request (HTTP ${status}).`);
  process.exitCode = 1;
}

/** Seconds from a --timeout option: undefined when not given, null (after saying why) when not a number from 1 to 86400. */
export function timeoutSeconds(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
    console.error("--timeout must be a number of seconds from 1 to 86400.");
    process.exitCode = 1;
    return null;
  }
  return seconds;
}

/** The daemon runs a command for 15 minutes unless told otherwise; give the request a minute more than that. */
export const requestTimeoutMs = (seconds: number | undefined): number => ((seconds ?? 900) + 60) * 1000;
