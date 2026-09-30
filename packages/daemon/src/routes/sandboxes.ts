import { Hono, type Context } from "hono";
import { SandboxError, type SeatSandboxService } from "../domain/seat-sandbox-service.js";
import type { SeatGateService } from "../domain/seat-gate-service.js";

// The seat worktrees that `isolation: worktree` creates. GET lists every recorded sandbox, including
// ones whose rig is gone; DELETE takes one away (the service decides what is safe to remove); POST
// .../setup re-runs a seat's setup and POST .../gate runs its gate. A failing setup or gate is a normal
// answer (200, with the result); a request that could not be attempted is a 404 or 409 with the reason.

/** A sandbox failure as an HTTP answer: 400 for a wrong request, 404 for an unknown node, 409 for anything else the caller can fix. Other errors are bugs. */
export function sandboxFailure(c: Context, error: unknown) {
  if (!(error instanceof SandboxError)) throw error;
  const status = error.code === "invalid" ? 400 : error.code === "not_found" ? 404 : 409;
  return c.json({ ok: false, code: error.code, error: error.message }, status);
}

/** Seconds from a request body to milliseconds: undefined when absent, null when present but not a sensible number. */
export function timeoutMsFrom(seconds: unknown): number | undefined | null {
  if (seconds === undefined) return undefined;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) return null;
  return Math.round(seconds * 1000);
}

const invalidTimeout = (c: Context) =>
  c.json({ ok: false, code: "invalid", error: "timeoutSeconds must be a number from 1 to 86400." }, 400);

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
      return sandboxFailure(c, error);
    }
  });

  app.post("/:nodeId/setup", async (c) => {
    const sandboxes = c.get("seatSandboxes" as never) as SeatSandboxService | undefined;
    if (!sandboxes) return c.json({ error: "Seat sandboxes are not configured on this daemon." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { timeoutSeconds?: unknown };
    const timeoutMs = timeoutMsFrom(body.timeoutSeconds);
    if (timeoutMs === null) return invalidTimeout(c);
    try {
      return c.json({ ok: true, setup: await sandboxes.runSetup(c.req.param("nodeId"), { timeoutMs }) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  app.post("/:nodeId/gate", async (c) => {
    const gates = c.get("seatGates" as never) as SeatGateService | undefined;
    if (!gates) return c.json({ error: "Gates are not configured on this daemon." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { timeoutSeconds?: unknown };
    const timeoutMs = timeoutMsFrom(body.timeoutSeconds);
    if (timeoutMs === null) return invalidTimeout(c);
    try {
      return c.json({ ok: true, run: await gates.run(c.req.param("nodeId"), { timeoutMs }) });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  });

  return app;
}
