import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// retry-first-start.test.ts proves the retry for an ordinary seat. A worktree seat is different in one
// way: the daemon has already pointed its node.cwd at the worktree by the time projection fails, so the
// retry must compare the fragment's authored cwd with the sandbox record, not with node.cwd.

const skillIds = ["development-team", "systematic-debugging"];
let tmp: string;
let root: string;
const closers: Array<() => void> = [];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-retry-")));
  root = path.join(tmp, "repo");
  fs.mkdirSync(root);
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"]);
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function failedIsolatedAdd() {
  const db = createFullTestDb();
  closers.push(() => db.close());
  const member = { id: "pi", agent_ref: "local:agent", profile: "default", runtime: "pi", model: "provider/model", cwd: root, isolation: "worktree" };
  const agent = (...parts: string[]) => path.join(root, "agent", ...parts);
  const files: Record<string, string> = {
    [root]: "",
    [agent("agent.yaml")]: `name: implementer\nversion: "1.0.0"\nresources:\n  skills:\n${skillIds.map(id => `    - id: ${id}\n      path: skills/${id}`).join("\n")}\nprofiles:\n  default:\n    uses:\n      skills: [${skillIds.join(", ")}]\n`,
    ...Object.fromEntries(skillIds.flatMap(id => [[agent("skills", id), ""], [agent("skills", id, "SKILL.md"), `# ${id}`]])),
  };
  let projectionBlocked = true;
  const adapter: RuntimeAdapter = {
    runtime: "pi",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: projectionBlocked ? skillIds.map(effectiveId => ({ effectiveId, error: "EACCES: projection ancestor" })) : [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
  const tmux = mockTmuxAdapter();
  const sandboxes = new SeatSandboxService(db);
  const setup = createTestApp(db, {
    tmux, adapters: { pi: adapter }, sandboxes,
    podInstantiatorFsOps: { exists: p => p in files, readFile: p => { if (!(p in files)) throw new Error(`Missing ${p}`); return files[p]!; } },
  });
  const rig = setup.rigRepo.createRig("first-start");
  const seeded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "dev", label: "Dev", members: [{ id: "sibling", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: root }], edges: [] } });
  expect(seeded.ok).toBe(true);
  const added = await setup.podInstantiator.addMemberToPod(rig.id, "dev", member, root);
  expect(added).toMatchObject({ ok: true, result: { node: { status: "failed", logicalId: "dev.pi" } } });
  const node = setup.rigRepo.getRig(rig.id)!.nodes.find(n => n.logicalId === "dev.pi")!;
  const worktree = path.join(tmp, "squad-worktrees", "repo", "first-start", "dev.pi");
  // The projection failed AFTER the worktree was made, and node.cwd already points at it.
  expect(node.cwd).toBe(worktree);
  expect(sandboxes.get(node.id)).toMatchObject({ state: "provisioned", repoPath: root, worktreePath: worktree });
  expect(adapter.launchHarness).not.toHaveBeenCalled();
  const lifecycle = new SeatLifecycleService({ ...setup, db, tmuxAdapter: tmux });
  tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const clean = await lifecycle.cleanSeat({ seatRef: "dev-pi@first-start", reason: "Projection failed before native launch; shell has exited" });
  expect(clean.ok).toBe(true);
  projectionBlocked = false;
  const request = (retryMember: Record<string, unknown> = member) => setup.app.request(`/api/rigs/${rig.id}/nodes/dev.pi/launch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retryStartupFrom: { member: retryMember, rigRoot: root } }),
  });
  return { ...setup, db, rig, node, adapter, member, worktree, request };
}

describe("explicit first-start retry of a worktree seat", () => {
  it("retries in the same worktree when the fragment carries the authored cwd and isolation", async () => {
    const f = await failedIsolatedAdd();

    const res = await f.request();
    const body = await res.json();

    expect({ status: res.status, body }, JSON.stringify(body)).toMatchObject({ status: 201, body: { ok: true, nodeId: f.node.id, status: "launched" } });
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![0].cwd).toBe(f.worktree);
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find(n => n.id === f.node.id)!.cwd).toBe(f.worktree);
  });

  it("refuses a fragment that drops the isolation the seat was created with", async () => {
    const f = await failedIsolatedAdd();
    const { isolation: _dropped, ...withoutIsolation } = f.member;

    const res = await f.request(withoutIsolation);

    expect(res.status).toBe(409);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  });

  it("refuses a fragment whose cwd is not the authored one", async () => {
    const f = await failedIsolatedAdd();

    const res = await f.request({ ...f.member, cwd: f.worktree });

    expect(res.status).toBe(409);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  });
});
