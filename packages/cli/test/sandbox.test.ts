import { describe, expect, it } from "vitest";
import { formatSandboxes, sandboxCommand } from "../src/commands/sandbox.js";

describe("sandbox command", () => {
  it("registers ls and rm", () => {
    expect(sandboxCommand().commands.map((c) => c.name()).sort()).toEqual(["ls", "rm"]);
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
