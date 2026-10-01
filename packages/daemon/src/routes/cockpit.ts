import { Hono } from "hono";
import type { CockpitService } from "../domain/cockpit-service.js";
import { sandboxFailure } from "./sandboxes.js";

// The read-only view behind the dual cockpit: GET /api/cockpit/<rig name>. Hono has already decoded the name;
// decoding it again would misread a name that contains a "%".
export function cockpitRoutes(): Hono {
  const app = new Hono();

  app.get("/:rig", async (c) => {
    const cockpit = c.get("cockpit" as never) as CockpitService | undefined;
    if (!cockpit) return c.json({ error: "The cockpit is not configured on this daemon." }, 503);
    try {
      return c.json({ ok: true, cockpit: await cockpit.view(c.req.param("rig")) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  return app;
}
