import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { swarmCommand } from "../src/commands/swarm.js";
import { startStubDaemon, useCommandRunner, type StubDaemon } from "./helpers/stub-daemon.js";

// swarm.test.ts hands the command a stand-in for `up`. This file leaves the default in place, to show that
// --launch really runs the `up` command on the spec the daemon wrote, and reports what `up` reports.
const { upCalls, upExitCode } = vi.hoisted(() => ({ upCalls: [] as string[], upExitCode: { value: undefined as number | undefined } }));

vi.mock("../src/commands/up.js", () => ({
  upCommand: () =>
    new Command("up").argument("<source>").action((source: string) => {
      upCalls.push(source);
      if (upExitCode.value !== undefined) process.exitCode = upExitCode.value; // how `up` fails
    }),
}));

const planWithSpecAt = (specPath: string) => ({
  ok: true,
  plan: {
    prompt: "Build Auth API",
    rig: "build-auth-api",
    repo: "/w/repo",
    cwd: "/w/repo",
    runtime: "claude-code",
    gate: ["npm", "test"],
    gateBasis: "given with --gate",
    setup: null,
    setupBasis: "none needed",
    lanes: [{ lane: "backend", seat: "swarm.backend", session: "swarm-backend@build-auth-api", branch: "squad/build-auth-api/swarm.backend", summary: "Build the server side", brief: "" }],
    specYaml: "",
    specPath,
    written: true,
    excluded: [],
  },
});

describe("squad swarm --launch with the real up command", () => {
  let daemon: StubDaemon | undefined;
  const runCommand = useCommandRunner(() => swarmCommand());
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    upCalls.length = 0;
    upExitCode.value = undefined;
  });

  it("runs up on the spec the daemon wrote, once, and then says how to go on", async () => {
    daemon = await startStubDaemon(() => ({ body: planWithSpecAt("/home/.openrig/swarms/build-auth-api/rig.yaml") }));

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--launch");

    expect(upCalls).toEqual(["/home/.openrig/swarms/build-auth-api/rig.yaml"]);
    expect(run.out).toContain("The squad is starting.");
    expect(run.exitCode).toBeUndefined();
  });

  it("keeps up's failure, and does not claim the squad is starting", async () => {
    upExitCode.value = 2;
    daemon = await startStubDaemon(() => ({ body: planWithSpecAt("/home/.openrig/swarms/build-auth-api/rig.yaml") }));

    const run = await runCommand(daemon.url, "swarm", "Build Auth API", "--launch");

    expect(upCalls).toHaveLength(1);
    expect(run.out).not.toContain("The squad is starting.");
    expect(run.exitCode).toBe(2);
  });

  it("does not run up for a preview or a write", async () => {
    daemon = await startStubDaemon(() => ({ body: planWithSpecAt("/home/.openrig/swarms/build-auth-api/rig.yaml") }));

    await runCommand(daemon.url, "swarm", "Build Auth API");
    await runCommand(daemon.url, "swarm", "Build Auth API", "--write");

    expect(upCalls).toEqual([]);
  });
});
