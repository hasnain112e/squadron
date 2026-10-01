import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatSandboxService } from "../src/domain/seat-sandbox-service.js";

const IDENT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const PASS = [process.execPath, "-e", "process.exit(0)"];
const FAIL = [process.execPath, "-e", "console.log('1 failing'); process.exit(1)"];

// One call that gives the dual cockpit everything it shows besides the panes: the seats of a rig with their
// runtimes and sessions, each seat's latest gate, and what `squad land --dry-run` says about landing.
describe("/api/cockpit", { timeout: 60_000 }, () => {
  let tmp: string;
  let repo: string;
  const closers: Array<() => void> = [];

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-cockpit-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
    git(repo, "add", ".");
    git(repo, ...IDENT, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function boot(withSandboxes = true) {
    const db = createFullTestDb();
    closers.push(() => db.close());
    const sandboxes = new SeatSandboxService(db);
    return { ...createTestApp(db, withSandboxes ? { sandboxes } : undefined), db, sandboxes };
  }

  type Booted = ReturnType<typeof boot>;

  /** A rig of two isolated seats, a Claude one and a Gemini one, each with a running session and its own worktree. */
  async function duo(t: Booted, rigName = "duo", gates: { claude?: string[]; gemini?: string[] } = {}) {
    const rig = t.rigRepo.createRig(rigName);
    const seats: Record<"claude" | "gemini", { nodeId: string; worktree: string }> = {} as never;
    for (const [key, logicalId, runtime, session] of [
      ["claude", "swarm.backend", "claude-code", `backend@${rigName}`],
      ["gemini", "swarm.frontend", "gemini", `frontend@${rigName}`],
    ] as const) {
      const node = t.rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime, cwd: repo });
      const registered = t.sessionRegistry.registerSession(node.id, session);
      t.sessionRegistry.updateStatus(registered.id, "running");
      t.sandboxes.request({ nodeId: node.id, rigId: rig.id, seat: logicalId, repoPath: repo, ...(gates[key] ? { gate: gates[key] } : {}) });
      seats[key] = { nodeId: node.id, worktree: (await t.sandboxes.provision(node.id))! };
    }
    return { rig, seats };
  }

  const commitIn = (worktree: string, name: string) => {
    fs.writeFileSync(path.join(worktree, name), "x\n");
    git(worktree, "add", name);
    git(worktree, ...IDENT, "commit", "-q", "-m", `add ${name}`);
    return git(worktree, "rev-parse", "HEAD");
  };

  const get = async (t: Booted, rig: string) => {
    const res = await t.app.request(`/api/cockpit/${encodeURIComponent(rig)}`);
    return { status: res.status, body: (await res.json()) as any };
  };

  it("shows each seat with its runtime, session, branch and worktree, side by side", async () => {
    const t = boot();
    const { rig, seats } = await duo(t, "duo", { claude: PASS, gemini: PASS });

    const { status, body } = await get(t, "duo");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cockpit.rig).toEqual({ id: rig.id, name: "duo" });
    expect(body.cockpit.seats).toHaveLength(2);
    expect(body.cockpit.seats[0]).toMatchObject({
      nodeId: seats.claude.nodeId, seat: "swarm.backend", runtime: "claude-code", session: "backend@duo", sessionStatus: "running",
      branch: "squad/duo/swarm.backend", worktreePath: seats.claude.worktree, gate: null,
    });
    expect(body.cockpit.seats[1]).toMatchObject({ seat: "swarm.frontend", runtime: "gemini", session: "frontend@duo", branch: "squad/duo/swarm.frontend", gate: null });
    expect(typeof body.cockpit.generatedAt).toBe("string");
  });

  it("gives each seat's latest gate verdict with the commit it tested, and says landing is not ready while one fails", async () => {
    const t = boot();
    const { seats } = await duo(t, "duo", { claude: PASS, gemini: FAIL });
    const claudeTip = commitIn(seats.claude.worktree, "a.txt");
    const geminiTip = commitIn(seats.gemini.worktree, "b.txt");
    await t.seatGates!.run(seats.claude.nodeId);
    await t.seatGates!.run(seats.gemini.nodeId);

    const { body } = await get(t, "duo");

    const [claude, gemini] = body.cockpit.seats;
    expect(claude.gate).toMatchObject({ status: "passed", exitCode: 0, commitSha: claudeTip, argv: PASS });
    expect(gemini.gate).toMatchObject({ status: "failed", exitCode: 1, commitSha: geminiTip });
    expect(typeof claude.gate.durationMs).toBe("number");
    expect(body.cockpit.landing).toMatchObject({ outcome: "not_ready", branch: "squad/duo/integration" });
    expect(body.cockpit.landing.lanes.map((lane: { seat: string; result: string }) => [lane.seat, lane.result])).toEqual([["swarm.backend", "not_attempted"], ["swarm.frontend", "not_ready"]]);
    expect(body.cockpit.landing.lanes[1].detail).toMatch(/the gate failed at [0-9a-f]{7}/);
  });

  it("says landing is ready once every lane has passed at its tip, and changes nothing by saying so", async () => {
    const t = boot();
    const { seats } = await duo(t, "duo", { claude: PASS, gemini: PASS });
    commitIn(seats.claude.worktree, "a.txt");
    commitIn(seats.gemini.worktree, "b.txt");
    await t.seatGates!.run(seats.claude.nodeId);
    await t.seatGates!.run(seats.gemini.nodeId);

    const { body } = await get(t, "duo");

    expect(body.cockpit.landing.outcome).toBe("ready");
    expect(body.cockpit.landing.lanes.map((lane: { result: string }) => lane.result)).toEqual(["would_merge", "would_merge"]);
    expect(git(repo, "branch", "--list", "squad/duo/integration")).toBe("");
  });

  it("keeps the whole view when landing cannot be judged, and says why", async () => {
    const t = boot();
    const rig = t.rigRepo.createRig("loose");
    const node = t.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", cwd: repo });
    t.sessionRegistry.updateStatus(t.sessionRegistry.registerSession(node.id, "impl@loose").id, "running");

    const { status, body } = await get(t, "loose");

    expect(status).toBe(200);
    expect(body.cockpit.seats).toEqual([expect.objectContaining({ seat: "dev.impl", runtime: "claude-code", session: "impl@loose", branch: null, worktreePath: null, gate: null })]);
    expect(body.cockpit.landing).toMatchObject({ code: "not_found", error: expect.stringContaining("no provisioned sandboxes") });
  });

  it("lists agent seats only, not terminals", async () => {
    const t = boot();
    const { rig } = await duo(t);
    t.rigRepo.addNode(rig.id, "swarm.logs", { role: "infrastructure", runtime: "terminal", cwd: repo });

    const { body } = await get(t, "duo");

    expect(body.cockpit.seats.map((seat: { seat: string }) => seat.seat)).toEqual(["swarm.backend", "swarm.frontend"]);
  });

  it("uses the newest rig when a name has been used more than once", async () => {
    const t = boot();
    const older = t.rigRepo.createRig("again");
    t.rigRepo.addNode(older.id, "old.seat", { role: "worker", runtime: "codex", cwd: repo });
    const newer = t.rigRepo.createRig("again");
    t.rigRepo.addNode(newer.id, "new.seat", { role: "worker", runtime: "gemini", cwd: repo });

    const { body } = await get(t, "again");

    expect(body.cockpit.rig.id).toBe(newer.id);
    expect(body.cockpit.seats.map((seat: { seat: string }) => seat.seat)).toEqual(["new.seat"]);
  });

  it("finds a rig whose name URLs escape, decoding the name once", async () => {
    const t = boot();
    const names = ["my rig", "100%", "a%20b"];
    for (const name of names) t.rigRepo.createRig(name);

    for (const name of names) {
      const { status, body } = await get(t, name);
      expect(status, name).toBe(200);
      expect(body.cockpit.rig.name).toBe(name);
    }
  });

  describe("GET /cockpit, the page", () => {
    const pageFile = path.resolve(import.meta.dirname, "../../../assets/dual-cockpit.html");

    it("serves the dual cockpit page from the repository, as HTML", async () => {
      const { app } = createTestApp(createFullTestDb());

      const res = await app.request("/cockpit");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(fs.readFileSync(pageFile, "utf-8"));
    });

    it("hands the page the daemon's bearer token when there is one, and never invents one", async () => {
      const withToken = createTestApp(createFullTestDb(), { terminalBearerToken: "abc</script>123" });
      const html = await (await withToken.app.request("/cockpit")).text();
      expect(html).toContain('<script>window.__SQUADRON_TOKEN__="abc\\u003c/script>123"</script></head>');
      expect(html.match(/__SQUADRON_TOKEN__/g)).toHaveLength(2); // the one handed over, and the one the page reads

      const without = createTestApp(createFullTestDb());
      expect(await (await without.app.request("/cockpit")).text()).not.toContain("__SQUADRON_TOKEN__=");
    });

    it("hands over a token that contains replacement patterns exactly as it is", async () => {
      const token = "a$&b$'c$`d$$e";
      const html = await (await createTestApp(createFullTestDb(), { terminalBearerToken: token }).app.request("/cockpit")).text();
      const script = `<script>window.__SQUADRON_TOKEN__=${JSON.stringify(token)}</script>`;

      expect(html).toContain(`${script}</head>`);
      expect(html.length).toBe(fs.readFileSync(pageFile, "utf-8").length + script.length);
    });

    it("says why when the page is not part of the install", async () => {
      const { app } = createTestApp(createFullTestDb(), { cockpitPagePath: path.join(tmp, "missing.html") });

      const res = await app.request("/cockpit");

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "cockpit_page_missing", hint: expect.stringContaining("assets/dual-cockpit.html") });
    });
  });

  it("answers 404 for a rig that does not exist, and 503 when the daemon has no cockpit", async () => {
    const t = boot();
    const missing = await get(t, "no-such-rig");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, code: "not_found", error: expect.stringContaining("no-such-rig") });

    const bare = boot(false);
    expect((await get(bare, "duo")).status).toBe(503);
  });
});
