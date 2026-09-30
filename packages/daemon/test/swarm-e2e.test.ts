import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";
import type { SwarmPlan } from "../src/domain/swarm-service.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// The whole path of `squad swarm` short of a real agent: plan a squad, start it through the real instantiator
// (mock tmux, stub runtime, real git), check every seat got its worktree, its setup and its brief, then do
// what the seats would do (commit, run the gate) and land the result. Real agents need tmux, which is the one
// thing this cannot cover.
describe("squad swarm, end to end", { timeout: 180_000 }, () => {
  it("plans a squad, starts its seats, and takes their work through the gate and landing", async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-e2e-")));
    const repo = path.join(tmp, "repo");
    const home = path.join(tmp, "home");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");
    const baseSha = git(repo, "rev-parse", "main");

    const db = createFullTestDb();
    const tmux = mockTmuxAdapter();
    const sandboxes = new SeatSandboxService(db);
    const daemon = createTestApp(db, {
      tmux,
      sandboxes,
      swarmHome: home,
      upRouterFsOps: {
        exists: (p) => fs.existsSync(p),
        readFile: (p) => fs.readFileSync(p, "utf-8"),
        readHead: (p, n) => fs.readFileSync(p).subarray(0, n),
      },
      podInstantiatorFsOps: { exists: (p) => fs.existsSync(p), readFile: (p) => fs.readFileSync(p, "utf-8") },
    });
    const post = (url: string, body: unknown) =>
      daemon.app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      // 1. Plan and write, through the route `squad swarm --launch` calls first.
      const setup = [process.execPath, "-e", "require('fs').writeFileSync('setup-ran.txt', 'yes')"];
      const gate = [process.execPath, "-e", "process.exit(0)"];
      const planned = await post("/api/swarm", { prompt: "Build Auth API", cwd: repo, mode: "launch", setup, gate });
      expect(planned.status).toBe(200);
      const { plan } = (await planned.json()) as { plan: SwarmPlan };
      expect(plan.written).toBe(true);
      expect(plan.excluded).toEqual([".openrig/", ".claude/settings.local.json"]);

      // 2. Start it, through the route `up` calls with the file that was written.
      const up = await post("/api/up", { sourceRef: plan.specPath });
      const launched = (await up.json()) as { status: string; stages: Array<{ stage: string; detail?: { nodes?: Array<{ logicalId: string; status: string }> } }> };
      expect(up.status, JSON.stringify(launched)).toBe(201);
      expect(launched.status).toBe("completed");
      const nodes = launched.stages.find((stage) => stage.stage === "import_rig")?.detail?.nodes ?? [];
      expect(nodes.map((node) => [node.logicalId, node.status])).toEqual([
        ["swarm.backend", "launched"],
        ["swarm.frontend", "launched"],
        ["swarm.qa", "launched"],
      ]);

      // 3. Every seat has its own worktree on its own branch, set up before its session started, and its brief sent and submitted.
      const seats = sandboxes.forRig("build-auth-api");
      expect(seats.map((seat) => seat.seat)).toEqual(["swarm.backend", "swarm.frontend", "swarm.qa"]);
      for (const lane of plan.lanes) {
        const seat = seats.find((candidate) => candidate.seat === lane.seat)!;
        expect(seat).toMatchObject({ state: "provisioned", branch: lane.branch, setupState: "passed", gate });
        expect(path.basename(seat.worktreePath!)).toBe(lane.seat);
        expect(fs.readFileSync(path.join(seat.worktreePath!, "setup-ran.txt"), "utf8")).toBe("yes");

        const created = vi.mocked(tmux.createSession).mock.calls.find((call) => call[0] === lane.session);
        expect(created?.[1], `${lane.session} should start in its worktree`).toBe(seat.worktreePath);

        const sent = vi.mocked(tmux.sendText).mock.calls.filter((call) => call[0] === lane.session).map((call) => call[1]);
        expect(sent, `${lane.session} should be sent its brief`).toContain(lane.brief);
      }
      expect(vi.mocked(tmux.sendKeys).mock.calls.filter((call) => call[1]?.[0] === "C-m").length).toBeGreaterThanOrEqual(3);

      // 4. OpenRig's own files in a worktree do not even show up for git, so a careless git add -A cannot commit them.
      const backend = seats[0]!.worktreePath!;
      fs.mkdirSync(path.join(backend, ".openrig"), { recursive: true });
      fs.writeFileSync(path.join(backend, ".openrig", "context-collector.cjs"), "x");
      fs.mkdirSync(path.join(backend, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(backend, ".claude", "settings.local.json"), "{}");
      const visible = git(backend, "status", "--porcelain", "--untracked-files=all");
      expect(visible).not.toMatch(/\.openrig|\.claude/);
      expect(visible).toContain("setup-ran.txt"); // an ordinary untracked file still shows, so the check is not vacuous

      // 5. The seats do their work the way the brief says: commit a file each, staged by name.
      for (const seat of seats) {
        fs.writeFileSync(path.join(seat.worktreePath!, `${seat.seat}.txt`), `work of ${seat.seat}\n`);
        git(seat.worktreePath!, "add", `${seat.seat}.txt`);
        git(seat.worktreePath!, ...IDENT, "commit", "-q", "-m", `work of ${seat.seat}`);
      }

      // 6. Each seat runs its gate, then a person lands the rig.
      for (const seat of seats) expect((await daemon.seatGates!.run(seat.nodeId)).status).toBe("passed");
      const landed = await daemon.sandboxLanding!.land("build-auth-api");

      expect(landed.outcome).toBe("landed");
      expect(landed.lanes.map((lane) => lane.result)).toEqual(["merged", "merged", "merged"]);
      expect(landed.branch).toBe("squad/build-auth-api/integration");
      for (const seat of seats) expect(fs.existsSync(path.join(landed.worktreePath, `${seat.seat}.txt`))).toBe(true);
      // The person's own branch is exactly where it started, and nothing was added to their working tree.
      expect(git(repo, "rev-parse", "main")).toBe(baseSha);
      expect(git(repo, "status", "--porcelain")).toBe("");
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
