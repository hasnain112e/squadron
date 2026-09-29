import { Hono } from "hono";
import { SandboxError, type SeatSandboxService } from "../domain/seat-sandbox-service.js";

// The seat worktrees that `isolation: worktree` creates. GET lists every recorded sandbox, including
// ones whose rig is gone; DELETE takes one away (the service decides what is safe to remove).
export function sandboxRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const sandboxes = c.get("seatSandboxes" as never) as SeatSandboxService | undefined;
    if (!sandboxes) return c.json({ error: "Seat sandboxes are not configured on this daemon." }, 503);
    return c.json({ sandboxes: sandboxes.list() });
  });

  app.delete("/:nodeId", async (c) => {
    const sandboxes = c.get("seatSandboxes" as never) as SeatSandboxService | undefined;
    if (!sandboxes) return c.json({ error: "Seat sandboxes are not configured on this daemon." }, 503);
    try {
      const removal = await sandboxes.remove(c.req.param("nodeId"), { force: c.req.query("force") === "true" });
      return c.json({ ok: true, ...removal });
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      return c.json({ ok: false, code: error.code, error: error.message }, error.code === "not_found" ? 404 : 409);
    }
  });

  return app;
}
