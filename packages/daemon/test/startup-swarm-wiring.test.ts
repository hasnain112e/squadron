import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createDaemon } from "../src/startup.js";
import { SwarmService } from "../src/domain/swarm-service.js";
import { CockpitService } from "../src/domain/cockpit-service.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

// The route tests build their app from test-app.ts, which wires the swarm service by hand. Only booting the
// daemon the way `squad start` does shows that startup.ts wires it too, and that the route is mounted.
describe("createDaemon serves squad swarm", { timeout: 60_000 }, () => {
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("plans a squad over HTTP through the daemon's own wiring", async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-startup-swarm-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");

    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.swarm).toBeInstanceOf(SwarmService);

      const res = await app.request("/api/swarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Build Auth API", cwd: tmp }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        plan: { rig: "build-auth-api", gate: ["npm", "test"], written: false, lanes: [{ seat: "swarm.backend" }, { seat: "swarm.frontend" }, { seat: "swarm.qa" }] },
      });
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves the dual cockpit: its view of a rig, and its page", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.cockpit).toBeInstanceOf(CockpitService);

      // The cockpit's own answer for a rig that is not there, not the catch-all `{ error, path }` an unmounted route would give.
      const view = await app.request("/api/cockpit/no-such-rig");
      expect(view.status).toBe(404);
      expect(await view.json()).toMatchObject({ ok: false, code: "not_found", error: expect.stringContaining("no-such-rig") });

      const page = await app.request("/cockpit");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>Squadron cockpit</title>");
    } finally {
      db.close();
    }
  });
});
