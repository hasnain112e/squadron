import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { planSwarm, swarmCommand } from "../src/commands/swarm.js";

describe("squad swarm (preview)", () => {
  it("plans backend, frontend and qa lanes on squad/<mission>/<seat> branches", () => {
    const plan = planSwarm("Build Auth API");
    expect(plan.mission).toBe("build-auth-api");
    expect(plan.lanes.map((lane) => lane.branch)).toEqual([
      "squad/build-auth-api/backend",
      "squad/build-auth-api/frontend",
      "squad/build-auth-api/qa",
    ]);
    expect(planSwarm("???").mission).toBe("swarm");
  });

  it("refuses an empty prompt", () => {
    expect(() => planSwarm("   ")).toThrow(/needs a prompt/);
  });

  it("is registered on the program", () => {
    expect(createProgram().commands.some((command) => command.name() === "swarm")).toBe(true);
  });

  it("says plainly that it is only a preview", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ""));
    });
    try {
      await swarmCommand().parseAsync(["node", "swarm", "Build Auth API"]);
    } finally {
      log.mockRestore();
    }
    expect(lines.join("\n")).toContain("Preview only");
  });
});
