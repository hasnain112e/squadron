import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, vi } from "vitest";
import { Command } from "commander";

// A real HTTP server standing in for the daemon, so a command test sees the request the command actually
// sends (method, path, JSON body) and the way it turns the answer into output and an exit code.

export interface StubRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface StubDaemon {
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

export async function startStubDaemon(respond: (request: StubRequest) => { status?: number; body: unknown }): Promise<StubDaemon> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request: StubRequest = { method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : undefined };
      requests.push(request);
      const answer = respond(request);
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface CommandRun {
  out: string;
  err: string;
  exitCode: number | undefined;
}

/**
 * Install per-test capture of console output and process.exitCode (restored afterwards, so a command that
 * fails on purpose cannot fail the test run), and return a function that runs one command line.
 */
export function useCommandRunner(command: () => Command) {
  let saved: typeof process.exitCode;
  let savedUrl: string | undefined;
  const lines = { out: [] as string[], err: [] as string[] };

  beforeEach(() => {
    saved = process.exitCode;
    savedUrl = process.env["OPENRIG_URL"];
    process.exitCode = undefined;
    lines.out = [];
    lines.err = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void lines.out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.err.push(args.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = saved;
    if (savedUrl === undefined) delete process.env["OPENRIG_URL"];
    else process.env["OPENRIG_URL"] = savedUrl;
  });

  return async (daemonUrl: string, ...argv: string[]): Promise<CommandRun> => {
    process.env["OPENRIG_URL"] = daemonUrl;
    process.exitCode = undefined;
    lines.out = [];
    lines.err = [];
    const program = new Command();
    program.exitOverride();
    program.addCommand(command());
    await program.parseAsync(["node", "squad", ...argv]);
    return { out: lines.out.join("\n"), err: lines.err.join("\n"), exitCode: process.exitCode as number | undefined };
  };
}
