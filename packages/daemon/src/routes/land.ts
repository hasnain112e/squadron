import { Hono } from "hono";
import type { SandboxLandingService } from "../domain/sandbox-landing-service.js";
import { sandboxFailure, timeoutMsFrom } from "./sandboxes.js";

// Landing a rig's isolated seats on its integration branch, and throwing that branch away. Landing that
// ends in a conflict, a failed gate or lanes that are not ready is a normal answer (200 with the outcome);
// only a request that could not be attempted is a 404 or 409. `dryRun: true` judges the lanes and changes nothing.
export function landRoutes(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const landing = c.get("sandboxLanding" as never) as SandboxLandingService | undefined;
    if (!landing) return c.json({ error: "Landing is not configured on this daemon." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { rig?: unknown; timeoutSeconds?: unknown; dryRun?: unknown };
    if (typeof body.rig !== "string" || body.rig.length === 0) return c.json({ ok: false, code: "invalid", error: "rig must be the name of a rig." }, 400);
    const timeoutMs = timeoutMsFrom(body.timeoutSeconds);
    if (timeoutMs === null) return c.json({ ok: false, code: "invalid", error: "timeoutSeconds must be a number from 1 to 86400." }, 400);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return c.json({ ok: false, code: "invalid", error: "dryRun must be true or false." }, 400);
    try {
      return c.json({ ok: true, result: await landing.land(body.rig, { timeoutMs, dryRun: body.dryRun }) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  app.post("/reset", async (c) => {
    const landing = c.get("sandboxLanding" as never) as SandboxLandingService | undefined;
    if (!landing) return c.json({ error: "Landing is not configured on this daemon." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { rig?: unknown; force?: unknown };
    if (typeof body.rig !== "string" || body.rig.length === 0) return c.json({ ok: false, code: "invalid", error: "rig must be the name of a rig." }, 400);
    try {
      return c.json({ ok: true, ...(await landing.reset(body.rig, { force: body.force === true })) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  return app;
}
