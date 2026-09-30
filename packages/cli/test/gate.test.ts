import { afterEach, describe, expect, it, vi } from "vitest";
import { commandLine, formatGateRun, gateCommand, type GateRunView } from "../src/commands/gate.js";
import { startStubDaemon, useCommandRunner, type StubDaemon } from "./helpers/stub-daemon.js";

const run = (over: Partial<GateRunView> = {}): GateRunView => ({
  seat: "dev.impl",
  commitSha: "a1b2c3d4e5f6a7b8",
  argv: ["npm", "test"],
  status: "passed",
  exitCode: 0,
  durationMs: 12_345,
  outputTail: "",
  ...over,
});

describe("formatGateRun", () => {
  it("says a pass in one line, with the commit it applies to", () => {
    expect(formatGateRun(run())).toBe("Gate passed for dev.impl at a1b2c3d (12.3s): npm test");
  });

  it("says a failure with its exit code, then the end of the output", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

    const text = formatGateRun(run({ status: "failed", exitCode: 2, outputTail: lines }), 5);

    expect(text.split("\n")[0]).toBe("Gate failed (exit code 2) for dev.impl at a1b2c3d (12.3s): npm test");
    expect(text.split("\n").slice(1)).toEqual(["line 46", "line 47", "line 48", "line 49", "line 50"]);
  });

  it("names a timeout and a run that could not be counted", () => {
    expect(formatGateRun(run({ status: "timed_out", exitCode: null }))).toContain("Gate timed out for");
    expect(formatGateRun(run({ status: "error", exitCode: null, outputTail: "The worktree changed while the gate was running" }))).toMatch(
      /^Gate did not complete for[\s\S]*worktree changed/,
    );
  });
});

describe("commandLine", () => {
  it("quotes only the parts that need it", () => {
    expect(commandLine(["npm", "test", "--", "-t", "a name with spaces"])).toBe('npm test -- -t "a name with spaces"');
  });
});

describe("gate run", () => {
  let daemon: StubDaemon | undefined;
  const runCommand = useCommandRunner(gateCommand);
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("registers only run", () => {
    expect(gateCommand().commands.map((c) => c.name())).toEqual(["run"]);
  });

  it("asks the daemon to run the seat's gate, prints the verdict, and exits cleanly on a pass", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, run: run() } }));

    const result = await runCommand(daemon.url, "gate", "run", "01ABC");

    expect(daemon.requests).toEqual([{ method: "POST", url: "/api/sandboxes/01ABC/gate", body: undefined }]);
    expect(result.out).toBe("Gate passed for dev.impl at a1b2c3d (12.3s): npm test");
    expect(result.exitCode).toBeUndefined();
  });

  describe("inside a seat's session", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("runs its own gate with no argument, using the node id in the environment", async () => {
      vi.stubEnv("OPENRIG_NODE_ID", "01SEAT");
      daemon = await startStubDaemon(() => ({ body: { ok: true, run: run() } }));

      const result = await runCommand(daemon.url, "gate", "run");

      expect(daemon.requests[0]!.url).toBe("/api/sandboxes/01SEAT/gate");
      expect(result.exitCode).toBeUndefined();
    });

    it("uses the node id it is given over the one in the environment", async () => {
      vi.stubEnv("OPENRIG_NODE_ID", "01SEAT");
      daemon = await startStubDaemon(() => ({ body: { ok: true, run: run() } }));

      await runCommand(daemon.url, "gate", "run", "01OTHER");

      expect(daemon.requests[0]!.url).toBe("/api/sandboxes/01OTHER/gate");
    });

    it("says what to give when there is no node id anywhere, without contacting the daemon", async () => {
      vi.stubEnv("OPENRIG_NODE_ID", "");
      vi.stubEnv("RIGGED_NODE_ID", "");
      daemon = await startStubDaemon(() => ({ body: {} }));

      const result = await runCommand(daemon.url, "gate", "run");

      expect(result.err).toContain("Give the node id of a seat");
      expect(result.err).toContain("OPENRIG_NODE_ID");
      expect(daemon.requests).toEqual([]);
      expect(result.exitCode).toBe(1);
    });
  });

  it("sends the timeout, and exits non-zero with the output when the gate fails", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, run: run({ status: "failed", exitCode: 1, outputTail: "3 tests failed" }) } }));

    const result = await runCommand(daemon.url, "gate", "run", "01ABC", "--timeout", "30");

    expect(daemon.requests[0]!.body).toEqual({ timeoutSeconds: 30 });
    expect(result.out).toContain("Gate failed (exit code 1)");
    expect(result.out).toContain("3 tests failed");
    expect(result.exitCode).toBe(1);
  });

  it("prints the JSON run with --json", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, run: run() } }));

    const result = await runCommand(daemon.url, "gate", "run", "01ABC", "--json");

    expect(JSON.parse(result.out)).toMatchObject({ seat: "dev.impl", status: "passed" });
  });

  it("shows the daemon's reason and exits non-zero when the gate could not be run", async () => {
    daemon = await startStubDaemon(() => ({ status: 409, body: { ok: false, code: "failed", error: "No gate is configured for dev.impl." } }));

    const result = await runCommand(daemon.url, "gate", "run", "01ABC");

    expect(result.err).toBe("No gate is configured for dev.impl.");
    expect(result.out).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("rejects a timeout that is not a number of seconds, without contacting the daemon", async () => {
    daemon = await startStubDaemon(() => ({ body: {} }));

    const result = await runCommand(daemon.url, "gate", "run", "01ABC", "--timeout", "soon");

    expect(result.err).toContain("--timeout must be a number of seconds");
    expect(daemon.requests).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it("says so when the daemon is not running", async () => {
    daemon = await startStubDaemon(() => ({ body: {} }));
    const url = daemon.url;
    await daemon.close();
    daemon = undefined;

    const result = await runCommand(url, "gate", "run", "01ABC");

    expect(result.err).toContain("Could not reach the daemon");
    expect(result.exitCode).toBe(1);
  });
});
