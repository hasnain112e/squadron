import { afterEach, describe, expect, it } from "vitest";
import { formatLand, formatReset, landCommand, type LandResultView } from "../src/commands/land.js";
import { startStubDaemon, useCommandRunner, type StubDaemon } from "./helpers/stub-daemon.js";

const passedRun = { status: "passed" as const, exitCode: 0, durationMs: 2_500, commitSha: "9f8e7d6c5b4a", outputTail: "" };

const result = (over: Partial<LandResultView> = {}): LandResultView => ({
  outcome: "landed",
  rig: "demo",
  branch: "squad/demo/integration",
  worktreePath: "/w/repo/demo/integration",
  tipSha: "9f8e7d6c5b4a",
  lanes: [
    { nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "merged" },
    { nodeId: "01B", seat: "dev.bb", branch: "squad/demo/dev.bb", tipSha: "b2b2b2b2b2", result: "already_landed" },
  ],
  setup: null,
  gates: [{ seats: ["dev.a", "dev.bb"], argv: ["npm", "test"], subdir: "", reused: false, run: passedRun }],
  ...over,
});

describe("formatLand", () => {
  it("lists each lane with what happened to it, the integration gate, and where to look", () => {
    const lines = formatLand(result()).split("\n");

    expect(lines[0]).toBe("Rig demo -> squad/demo/integration");
    expect(lines[1]).toBe("  dev.a   merged          a1a1a1a");
    expect(lines[2]).toBe("  dev.bb  already landed  b2b2b2b");
    expect(lines[3]).toBe("Gate passed: npm test for dev.a, dev.bb at 9f8e7d6 (2.5s)");
    expect(lines[4]).toContain("Landed. The result is on squad/demo/integration, checked out at /w/repo/demo/integration.");
    expect(lines[4]).toContain("landing never changes your branches");
  });

  it("says a gate result was reused, and where a gate ran in a subdirectory", () => {
    const text = formatLand(result({ outcome: "nothing_to_land", gates: [{ seats: ["dev.a"], argv: ["npm", "test"], subdir: "pkg", reused: true, run: passedRun }] }));

    expect(text).toContain("Gate passed: npm test in pkg for dev.a at 9f8e7d6 (already passed at this commit)");
    expect(text).toContain("Nothing new to land");
  });

  it("says a dry run is ready, which lanes would merge, that nothing changed, and that conflicts are not looked for", () => {
    const lines = formatLand(
      result({
        outcome: "ready",
        gates: [],
        lanes: [
          { nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "would_merge" },
          { nodeId: "01B", seat: "dev.bb", branch: "squad/demo/dev.bb", tipSha: "b2b2b2b2b2", result: "would_merge" },
          { nodeId: "01C", seat: "dev.c", branch: "squad/demo/dev.c", tipSha: "c3c3c3c3c3", result: "already_landed" },
        ],
      }),
    ).split("\n");

    expect(lines[1]).toBe("  dev.a   would merge     a1a1a1a");
    expect(lines[2]).toBe("  dev.bb  would merge     b2b2b2b");
    expect(lines[4]).toContain("Ready. Landing would merge 2 lanes onto squad/demo/integration, then set up and gate the result. Nothing was changed.");
    expect(lines[4]).toContain("A dry run cannot find merge conflicts");
    expect(lines[4]).toContain("Land for real with: squad land demo");
  });

  it("says lane, not lanes, for one", () => {
    const text = formatLand(result({ outcome: "ready", gates: [], lanes: [{ nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "would_merge" }] }));

    expect(text).toContain("would merge 1 lane onto");
  });

  it("explains a lane that is not ready, and that nothing was merged", () => {
    const text = formatLand(
      result({
        outcome: "not_ready",
        gates: [],
        lanes: [
          { nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "not_attempted" },
          { nodeId: "01B", seat: "dev.b", branch: "squad/demo/dev.b", tipSha: "b2b2b2b2b2", result: "not_ready", detail: "no gate result for b2b2b2b. Run: squad gate run 01B" },
        ],
      }),
    );

    expect(text).toContain("dev.b  not ready       b2b2b2b  no gate result for b2b2b2b. Run: squad gate run 01B");
    expect(text).toContain("Nothing was merged: some lanes are not ready, and squad/demo/integration is unchanged.");
  });

  it("names the conflicting files and the way out", () => {
    const text = formatLand(
      result({
        outcome: "conflict",
        gates: [],
        lanes: [
          { nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "merged" },
          { nodeId: "01B", seat: "dev.b", branch: "squad/demo/dev.b", tipSha: "b2b2b2b2b2", result: "conflict", files: ["shared.txt", "pkg/x.ts"] },
          { nodeId: "01C", seat: "dev.c", branch: "squad/demo/dev.c", tipSha: "c3c3c3c3c3", result: "not_attempted" },
        ],
      }),
    );

    expect(text).toContain("      conflict in shared.txt\n      conflict in pkg/x.ts");
    expect(text).toContain("dev.c  not merged");
    expect(text).toContain("Stopped at a conflict in dev.b.");
    expect(text).toContain("merge squad/demo/integration into squad/demo/dev.b");
    expect(text).toContain("run: squad gate run 01B, then land again.");
  });

  it("shows a failed integration gate with its output, and offers the reset", () => {
    const text = formatLand(
      result({
        outcome: "gate_failed",
        gates: [{ seats: ["dev.a"], argv: ["npm", "test"], subdir: "", reused: false, run: { ...passedRun, status: "failed", exitCode: 1, outputTail: "2 failing" } }],
      }),
    );

    expect(text).toContain("Gate failed (exit code 1): npm test for dev.a at 9f8e7d6");
    expect(text).toContain("2 failing");
    expect(text).toContain("squad land demo --reset");
  });

  it("shows a failed integration setup with its output", () => {
    const text = formatLand(result({ outcome: "setup_failed", gates: [], setup: { argv: ["npm", "ci"], status: "failed", exitCode: 7, outputTail: "install broke" } }));

    expect(text).toContain("Setting up the integration worktree failed: npm ci (exit code 7)");
    expect(text).toContain("install broke");
  });
});

describe("formatReset", () => {
  it("says what was thrown away", () => {
    expect(formatReset({ worktreeRemoved: true, branchDeleted: true })).toBe(
      "Removed the integration worktree.\nDeleted the integration branch. The seats' branches are untouched.",
    );
    expect(formatReset({ worktreeRemoved: false, branchDeleted: false })).toBe("There was no integration branch or worktree to remove.");
  });
});

describe("land", () => {
  let daemon: StubDaemon | undefined;
  const runCommand = useCommandRunner(landCommand);
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("asks the daemon to land the rig, prints the report, and exits cleanly when it landed", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, result: result() } }));

    const run = await runCommand(daemon.url, "land", "demo");

    expect(daemon.requests).toEqual([{ method: "POST", url: "/api/land", body: { rig: "demo" } }]);
    expect(run.out).toContain("Landed.");
    expect(run.exitCode).toBeUndefined();
  });

  it("sends the timeout, and prints JSON with --json", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, result: result() } }));

    const run = await runCommand(daemon.url, "land", "demo", "--timeout", "120", "--json");

    expect(daemon.requests[0]!.body).toEqual({ rig: "demo", timeoutSeconds: 120 });
    expect(JSON.parse(run.out)).toMatchObject({ outcome: "landed", branch: "squad/demo/integration" });
  });

  it.each(["conflict", "gate_failed", "setup_failed", "not_ready"] as const)("exits non-zero when the outcome is %s", async (outcome) => {
    daemon = await startStubDaemon(() => ({
      body: { ok: true, result: result({ outcome, lanes: [{ nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: outcome === "conflict" ? "conflict" : "merged" }], setup: outcome === "setup_failed" ? { argv: ["npm", "ci"], status: "failed", exitCode: 1, outputTail: "" } : null }) },
    }));

    const run = await runCommand(daemon.url, "land", "demo");

    expect(run.exitCode).toBe(1);
  });

  it("asks for a dry run with --dry-run, prints what would land, and exits cleanly when it is ready", async () => {
    daemon = await startStubDaemon(() => ({
      body: { ok: true, result: result({ outcome: "ready", gates: [], lanes: [{ nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "would_merge" }] }) },
    }));

    const run = await runCommand(daemon.url, "land", "demo", "--dry-run");

    expect(daemon.requests).toEqual([{ method: "POST", url: "/api/land", body: { rig: "demo", dryRun: true } }]);
    expect(run.out).toContain("would merge");
    expect(run.out).toContain("Ready.");
    expect(run.exitCode).toBeUndefined();
  });

  it("still exits non-zero when a dry run finds lanes that are not ready", async () => {
    daemon = await startStubDaemon(() => ({
      body: { ok: true, result: result({ outcome: "not_ready", gates: [], lanes: [{ nodeId: "01A", seat: "dev.a", branch: "squad/demo/dev.a", tipSha: "a1a1a1a1a1", result: "not_ready", detail: "no gate result" }] }) },
    }));

    const run = await runCommand(daemon.url, "land", "demo", "--dry-run");

    expect(run.out).toContain("no gate result");
    expect(run.exitCode).toBe(1);
  });

  it("refuses --dry-run with --reset, without contacting the daemon", async () => {
    daemon = await startStubDaemon(() => ({ body: {} }));

    const run = await runCommand(daemon.url, "land", "demo", "--dry-run", "--reset");

    expect(run.err).toBe("--dry-run cannot be combined with --reset.");
    expect(daemon.requests).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("exits cleanly when there was nothing to land", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, result: result({ outcome: "nothing_to_land", gates: [] }) } }));

    expect((await runCommand(daemon.url, "land", "demo")).exitCode).toBeUndefined();
  });

  it("asks for a reset with --reset, and only forces it with --force", async () => {
    daemon = await startStubDaemon(() => ({ body: { ok: true, worktreeRemoved: true, branchDeleted: true } }));

    const plain = await runCommand(daemon.url, "land", "demo", "--reset");
    const forced = await runCommand(daemon.url, "land", "demo", "--reset", "--force");

    expect(daemon.requests.map((r) => [r.url, r.body])).toEqual([
      ["/api/land/reset", { rig: "demo", force: false }],
      ["/api/land/reset", { rig: "demo", force: true }],
    ]);
    expect(plain.out).toContain("Removed the integration worktree.");
    expect(forced.exitCode).toBeUndefined();
  });

  it("refuses --force without --reset, without contacting the daemon", async () => {
    daemon = await startStubDaemon(() => ({ body: {} }));

    const run = await runCommand(daemon.url, "land", "demo", "--force");

    expect(run.err).toBe("--force only applies to --reset.");
    expect(daemon.requests).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("shows the daemon's reason and exits non-zero when landing could not start", async () => {
    daemon = await startStubDaemon(() => ({ status: 404, body: { ok: false, code: "not_found", error: "Rig demo has no provisioned sandboxes." } }));

    const run = await runCommand(daemon.url, "land", "demo");

    expect(run.err).toBe("Rig demo has no provisioned sandboxes.");
    expect(run.exitCode).toBe(1);
  });
});
