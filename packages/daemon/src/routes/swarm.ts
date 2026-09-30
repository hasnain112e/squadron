import { Hono } from "hono";
import { SandboxError } from "../domain/sandbox-common.js";
import { SwarmService, parseSwarmRequest } from "../domain/swarm-service.js";
import { sandboxFailure } from "./sandboxes.js";

// Plan a squad for a prompt. In preview mode nothing is written; write and launch modes write the rig spec
// under the instance directory. Starting the seats is the existing `up`, which the CLI runs on that file.
export function swarmRoutes(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const swarm = c.get("swarm" as never) as SwarmService | undefined;
    if (!swarm) return c.json({ error: "Swarm planning is not configured on this daemon." }, 503);
    try {
      const request = parseSwarmRequest(await c.req.json().catch(() => {
        throw new SandboxError("invalid", "The request must be JSON.");
      }));
      return c.json({ ok: true, plan: await swarm.plan(request) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  return app;
}
