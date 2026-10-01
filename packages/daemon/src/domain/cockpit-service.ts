import type Database from "better-sqlite3";
import { getNodeInventory } from "./node-inventory.js";
import type { RigRepository } from "./rig-repository.js";
import { SandboxError } from "./sandbox-common.js";
import type { LandLane, LandOutcome, SandboxLandingService } from "./sandbox-landing-service.js";
import type { GateRun, SeatGateService } from "./seat-gate-service.js";
import type { SeatSandboxService } from "./seat-sandbox-service.js";

// What the dual cockpit (assets/dual-cockpit.html) shows besides the seats' screens, in one read: the agent
// seats of a rig with their runtimes and sessions, each seat's latest gate result, and what `land --dry-run`
// says about landing. Nothing here changes anything: the dry run creates no branch and no worktree.

export interface CockpitSeat {
  nodeId: string | null;
  /** The logical id, for example swarm.backend. */
  seat: string;
  runtime: string | null;
  session: string | null;
  sessionStatus: string | null;
  /** Null for a seat that is not isolated. */
  branch: string | null;
  /** Null until the seat's worktree exists. */
  worktreePath: string | null;
  setupState: string | null;
  /** The seat's latest gate run, whichever commit it tested; null if it has none. */
  gate: Pick<GateRun, "status" | "exitCode" | "commitSha" | "argv" | "durationMs" | "startedAt"> | null;
}

export interface CockpitLanding {
  outcome: LandOutcome;
  branch: string;
  lanes: Array<Pick<LandLane, "seat" | "result" | "tipSha" | "detail" | "files">>;
}

export interface CockpitView {
  rig: { id: string; name: string };
  seats: CockpitSeat[];
  /** The dry run's answer, or why it could not be given (for example, a rig with no isolated seats). */
  landing: CockpitLanding | { error: string; code: string };
  generatedAt: string;
}

export class CockpitService {
  constructor(
    private readonly deps: {
      db: Database.Database;
      rigRepo: RigRepository;
      sandboxes: SeatSandboxService;
      gates: SeatGateService;
      landing: SandboxLandingService;
    },
  ) {}

  async view(rigName: string): Promise<CockpitView> {
    const rigs = this.deps.rigRepo.findRigsByName(rigName);
    const rig = rigs[rigs.length - 1]; // a name can be used again after a rig is gone; the newest is the live one
    if (!rig) throw new SandboxError("not_found", `No rig is named "${rigName}".`);

    const sandboxes = new Map(this.deps.sandboxes.forRig(rig.name).map((sandbox) => [sandbox.nodeId, sandbox]));
    const seats: CockpitSeat[] = getNodeInventory(this.deps.db, rig.id)
      .filter((entry) => entry.nodeKind === "agent")
      .map((entry) => {
        const sandbox = entry.nodeId ? sandboxes.get(entry.nodeId) : undefined;
        const run = sandbox && entry.nodeId ? this.deps.gates.latest(entry.nodeId) : null;
        return {
          nodeId: entry.nodeId ?? null,
          seat: entry.logicalId,
          runtime: entry.runtime,
          session: entry.canonicalSessionName,
          sessionStatus: entry.sessionStatus,
          branch: sandbox?.branch ?? null,
          worktreePath: sandbox?.worktreePath ?? null,
          setupState: sandbox?.setupState ?? null,
          gate: run ? { status: run.status, exitCode: run.exitCode, commitSha: run.commitSha, argv: run.argv, durationMs: run.durationMs, startedAt: run.startedAt } : null,
        };
      });

    return { rig: { id: rig.id, name: rig.name }, seats, landing: await this.landing(rig.name), generatedAt: new Date().toISOString() };
  }

  private async landing(rigName: string): Promise<CockpitView["landing"]> {
    try {
      const result = await this.deps.landing.land(rigName, { dryRun: true });
      return {
        outcome: result.outcome,
        branch: result.branch,
        lanes: result.lanes.map(({ seat, result: laneResult, tipSha, detail, files }) => ({ seat, result: laneResult, tipSha, ...(detail ? { detail } : {}), ...(files ? { files } : {}) })),
      };
    } catch (error) {
      // "Nothing to land yet" and "a land is running" are answers the cockpit shows, not reasons to lose the rest of the view.
      if (error instanceof SandboxError) return { error: error.message, code: error.code };
      throw error;
    }
  }
}
