import { afterEach, describe, expect, it } from "vitest";
import { formatSandboxes, formatSetup, sandboxCommand } from "../src/commands/sandbox.js";
import { startStubDaemon, useCommandRunner, type StubDaemon } from "./helpers/stub-daemon.js";

describe("sandbox command", () => {
  it("registers ls, rm and setup", () => {
    expect(sandboxCommand().commands.map((c) => c.name()).sort()).toEqual(["ls", "rm", "setup"]);
  });

  it("explains how to get a sandbox when there are none", () => {
    expect(formatSandboxes([])).toContain("isolation: worktree");
  });

  it("aligns the columns and puts the path last", () => {
    const out = formatSandboxes([
      { nodeId: "01A", rigName: "demo", seat: "dev.impl", state: "provisioned", branch: "squad/demo/dev.impl", worktreePath: "/w/repo/demo/dev.impl" },
      { nodeId: "01B", rigName: "alpha-long-name", seat: "qa", state: "requested", branch: null, worktreePath: null },
    ]);

    const [header, first, second] = out.split("\n");
    expect(header).toMatch(/^NODE\s+RIG\s+SEAT\s+STATE\s+BRANCH\s+PATH$/);
    // Every column before the path starts at the same offset on every line.
    const pathColumn = header!.indexOf("PATH");
    expect(first!.indexOf("/w/repo/demo/dev.impl")).toBe(pathColumn);
    expect(second!.slice(pathColumn)).toBe("-");
    expect(first!.startsWith("01A ")).toBe(true);
  });
});

describe("formatSetup", () => {
  it("says a pass in one line", () => {
    expect(formatSetup({ status: "passed", exitCode: 0, durationMs: 41_200, outputTail: "added 300 packages" })).toBe("Setup passed (41.2s).");
  });

  it("says a failure with its exit code and the end of its output", () => {
    expect(formatSetup({ status: "failed", exitCode: 1, durationMs: 1_000, outputTail: "npm error 404" })).toBe("Setup failed (exit code 1) (1.0s).\nnpm error 404");
    expect(formatSetup({ status: "timed_out", exitCode: null, durationMs: 900_000, outputTail: "" })).toBe("Setup timed out (900.0s).");
  });
});

describe("sandbox setup", () => {
  let daemon: StubDaemon | undefined;
  const runCommand = useCommandRunner(sandboxCommand);
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("asks the daemon to run the seat's setup again and prints the verdict", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, setup: { status: "passed", exitCode: 0, durationMs: 2_000, outputTail: "" } } }));

    const run = await runCommand(daemon.url, "sandbox", "setup", "01ABC", "--timeout", "600");

    expect(daemon.requests).toEqual([{ method: "POST", url: "/api/sandboxes/01ABC/setup", body: { timeoutSeconds: 600 } }]);
    expect(run.out).toBe("Setup passed (2.0s).");
    expect(run.exitCode).toBeUndefined();
  });

  it("exits non-zero when setup fails, and shows why when it could not be run", async () => {
    daemon = await startStubDaemon((request) =>
      request.url.endsWith("/01BAD/setup")
        ? { status: 409, body: { ok: false, code: "failed", error: "No setup command is configured for dev.impl." } }
        : { body: { ok: true, setup: { status: "failed", exitCode: 3, durationMs: 500, outputTail: "boom" } } },
    );

    const failed = await runCommand(daemon.url, "sandbox", "setup", "01ABC");
    expect(failed.out).toContain("Setup failed (exit code 3)");
    expect(failed.exitCode).toBe(1);

    const refused = await runCommand(daemon.url, "sandbox", "setup", "01BAD");
    expect(refused.err).toBe("No setup command is configured for dev.impl.");
    expect(refused.exitCode).toBe(1);
  });
});
