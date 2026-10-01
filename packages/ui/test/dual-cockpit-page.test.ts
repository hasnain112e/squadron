import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";

// assets/dual-cockpit.html is a standalone page, so it is tested as one: loaded into a DOM, running its own
// scripts, with a stand-in for the daemon behind fetch. The seats, gates and landing on screen are checked against
// the answers the daemon's routes give (see daemon/test/cockpit-routes.test.ts for the real routes).
const PAGE = path.resolve(import.meta.dirname, "../../../assets/dual-cockpit.html");
const html = fs.readFileSync(PAGE, "utf-8");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; body: unknown };

const seat = (over: Record<string, unknown>) => ({
  nodeId: "n1", seat: "swarm.backend", runtime: "claude-code", session: "backend@duo", sessionStatus: "running",
  branch: "squad/duo/swarm.backend", worktreePath: "/w/duo/swarm.backend", setupState: "passed", gate: null, ...over,
});
const passed = { status: "passed", exitCode: 0, commitSha: "3f9c1ab0000", argv: ["npm", "test"], durationMs: 2400, startedAt: "" };
const failed = { status: "failed", exitCode: 1, commitSha: "b21d7e00000", argv: ["npm", "test"], durationMs: 2800, startedAt: "" };
const claude = (over: Record<string, unknown> = {}) => seat(over);
const gemini = (over: Record<string, unknown> = {}) =>
  seat({ nodeId: "n2", seat: "swarm.frontend", runtime: "gemini", session: "frontend@duo", branch: "squad/duo/swarm.frontend", worktreePath: "/w/duo/swarm.frontend", ...over });
const notReady = {
  outcome: "not_ready", branch: "squad/duo/integration",
  lanes: [{ seat: "swarm.backend", result: "not_attempted", tipSha: "3f9c1ab" }, { seat: "swarm.frontend", result: "not_ready", tipSha: "b21d7e0", detail: "the gate failed at b21d7e0" }],
};
const ready = {
  outcome: "ready", branch: "squad/duo/integration",
  lanes: [{ seat: "swarm.backend", result: "would_merge", tipSha: "3f9c1ab" }, { seat: "swarm.frontend", result: "would_merge", tipSha: "5d0a8c4" }],
};
const view = (over: Record<string, unknown> = {}) => ({
  rig: { id: "r1", name: "duo" },
  seats: [claude({ gate: passed }), gemini({ gate: failed })],
  landing: notReady,
  generatedAt: new Date().toISOString(),
  ...over,
});

let open: JSDOM[] = [];
afterEach(() => {
  for (const dom of open) dom.window.close(); // stops the page's timers
  open = [];
});

/** Load the page the way a browser would at `url`, with `answer` standing in for the daemon. */
function load(search: string, answer: (call: Call) => Answer | Promise<Answer>, opts: { token?: string; confirm?: () => boolean; url?: string } = {}) {
  const calls: Call[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!/Could not parse CSS/.test(error.message)) errors.push(error.stack ?? error.message);
  });
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: opts.url ?? `http://127.0.0.1:7433/cockpit${search}`,
    virtualConsole,
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>;
      w.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const call: Call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const result = await answer(call);
        return { status: result.status ?? 200, json: async () => result.body };
      };
      w.confirm = opts.confirm ?? (() => true);
      if (opts.token) w.__SQUADRON_TOKEN__ = opts.token;
    },
  });
  open.push(dom);
  const document = dom.window.document;
  const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? null;
  const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
  return { dom, document, calls, errors, text, button, logic: (dom.window as unknown as { CockpitLogic: Record<string, (...args: unknown[]) => unknown> }).CockpitLogic };
}

/** The daemon's answers for a rig called duo. */
const daemon = (opts: { cockpit?: Answer; preview?: (session: string) => Answer; land?: (body: unknown) => Answer } = {}) => (call: Call): Answer => {
  if (call.url === "/api/rigs/summary") return { body: [{ id: "r1", name: "duo" }] };
  if (call.url.startsWith("/api/cockpit/")) return opts.cockpit ?? { body: { ok: true, cockpit: view() } };
  if (call.url.startsWith("/api/sessions/")) {
    const session = decodeURIComponent(call.url.split("/")[3]!);
    return opts.preview ? opts.preview(session) : { body: { content: `output of ${session}\n\n\n`, lines: 120, sessionName: session } };
  }
  if (call.url === "/api/land") return opts.land ? opts.land(call.body) : { body: { ok: true, result: ready } };
  return { status: 404, body: { error: "not_found" } };
};

describe("dual cockpit, live", () => {
  it("puts the Claude seat on the left and the Gemini seat on the right, each with its session and its screen", async () => {
    const page = load("?rig=duo", daemon());

    await vi.waitFor(() => expect(page.text("#deck-right .stream")).toContain("output of frontend@duo"));

    expect(page.text("#deck-left .badge")).toBe("Claude Code");
    expect(page.text("#deck-left .seat")).toBe("swarm.backend");
    expect(page.text("#deck-left .session")).toBe("backend@duo");
    expect(page.text("#deck-left .stream")).toBe("output of backend@duo");
    expect(page.text("#deck-right .badge")).toBe("Gemini CLI");
    expect(page.text("#deck-right .seat")).toBe("swarm.frontend");
    expect(page.text("#deck-left .deck-foot")).toContain("squad/duo/swarm.backend");
    expect(page.text("#mode")).toBe("Live");
    expect(page.errors).toEqual([]);
  });

  it("asks for each seat's screen by its session name", async () => {
    const page = load("?rig=duo", daemon());
    await vi.waitFor(() => expect(page.calls.filter((c) => c.url.startsWith("/api/sessions/")).length).toBeGreaterThanOrEqual(2));

    const previews = page.calls.filter((c) => c.url.startsWith("/api/sessions/")).map((c) => c.url);
    expect(previews).toContain("/api/sessions/backend%40duo/preview?lines=120");
    expect(previews).toContain("/api/sessions/frontend%40duo/preview?lines=120");
  });

  it("shows each seat's test gate as a lamp with its verdict and what it tested", async () => {
    const page = load("?rig=duo", daemon());

    await vi.waitFor(() => expect(page.text("#gate-left .verdict")).toBe("Passed"));

    expect(page.document.querySelector("#gate-left")!.className).toBe("cell pass");
    expect(page.text("#gate-left .what")).toBe("Test gate, swarm.backend");
    expect(page.text("#gate-left .detail")).toBe("at 3f9c1ab, 2.4s, npm test");
    expect(page.document.querySelector("#gate-right")!.className).toBe("cell fail");
    expect(page.text("#gate-right .verdict")).toBe("Failed (exit code 1)");
    expect(page.text("#gate-right .detail")).toBe("at b21d7e0, 2.8s, npm test");
  });

  it("says landing is not ready and why, and offers only the dry run", async () => {
    const page = load("?rig=duo", daemon());

    await vi.waitFor(() => expect(page.text("#land .verdict")).toBe("Not ready: swarm.frontend"));

    expect([...page.document.querySelectorAll("#land .lane")].map((lane) => lane.textContent)).toEqual(["swarm.backend: not merged", "swarm.frontend: not ready"]);
    expect(page.document.querySelector("#land .lane.warn")!.getAttribute("title")).toBe("the gate failed at b21d7e0");
    expect(page.button("Dry run").disabled).toBe(false);
    expect(page.button("Land").disabled).toBe(true);
    expect(page.text("#land .actions code")).toBe("squad land duo");
  });

  it("does a dry run when asked, and shows what it found", async () => {
    const page = load("?rig=duo", daemon());
    await vi.waitFor(() => expect(page.button("Dry run").disabled).toBe(false));

    page.button("Dry run").click();

    await vi.waitFor(() => expect(page.text("#land .msg")).toBe("Dry run: 2 lanes would merge onto squad/duo/integration. Nothing was changed."));
    expect(page.calls.find((c) => c.url === "/api/land")).toMatchObject({ method: "POST", body: { rig: "duo", dryRun: true } });
  });

  it("offers Land when every lane is ready, asks first, and lands for real only after a yes", async () => {
    const confirm = vi.fn(() => false);
    const answer = daemon({
      cockpit: { body: { ok: true, cockpit: view({ landing: ready, seats: [claude({ gate: passed }), gemini({ gate: passed })] }) } },
      land: () => ({ body: { ok: true, result: { outcome: "landed", branch: "squad/duo/integration", worktreePath: "/w/duo/integration", lanes: [] } } }),
    });
    const page = load("?rig=duo", answer, { confirm });
    await vi.waitFor(() => expect(page.button("Land").disabled).toBe(false));
    expect(page.text("#land .verdict")).toBe("Ready to land");
    expect(page.document.querySelector("#land")!.className).toBe("cell pass");

    page.button("Land").click(); // the person says no
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0])).toContain("Your own branches are not changed");
    expect(page.calls.filter((c) => c.url === "/api/land")).toEqual([]);

    confirm.mockReturnValue(true);
    page.button("Land").click();
    await vi.waitFor(() => expect(page.text("#land .msg")).toContain("Landed on squad/duo/integration, checked out at /w/duo/integration."));
    expect(page.calls.find((c) => c.url === "/api/land")).toMatchObject({ method: "POST", body: { rig: "duo" } });
    expect((page.calls.find((c) => c.url === "/api/land")!.body as Record<string, unknown>).dryRun).toBeUndefined();
  });

  it("never turns what the daemon sends into markup", async () => {
    const hostile = "<img src=x onerror=alert(1)><script>window.pwned=1</script>";
    const answer = daemon({
      preview: () => ({ body: { content: hostile } }),
      cockpit: { body: { ok: true, cockpit: view({ seats: [claude({ seat: hostile, session: "backend@duo" }), gemini()], landing: { error: hostile, code: "failed" } }) } },
    });
    const page = load("?rig=duo", answer);

    await vi.waitFor(() => expect(page.text("#deck-left .stream")).toContain("<img src=x"));

    expect(page.document.querySelectorAll("img")).toHaveLength(0);
    expect(page.document.querySelectorAll("script")).toHaveLength(2); // the two that are in the file
    expect((page.dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(page.text("#deck-left .seat")).toBe(hostile);
    expect(page.text("#land .detail")).toBe(hostile);
  });

  it("strips the terminal's escape codes and the blank lines it pads a screen with", async () => {
    const answer = daemon({ preview: () => ({ body: { content: "\u001b[32mgreen\u001b[0m text\n$ ls\n\n\n\n" } }) });
    const page = load("?rig=duo", answer);

    await vi.waitFor(() => expect(page.text("#deck-left .stream")).toBe("green text\n$ ls"));
  });

  it("draws a shell prompt and Squadron's own gate words in colour, and leaves the agent's output plain", async () => {
    const screen = ["> build it", "$ squad gate run", "Gate failed (exit code 1) for swarm.frontend at b21d7e0 (2.8s): npm test", "tests: 1 failing", "Gate passed for swarm.frontend at 5d0a8c4 (2.6s): npm test"].join("\n");
    const page = load("?rig=duo", daemon({ preview: () => ({ body: { content: screen } }) }));

    await vi.waitFor(() => expect(page.document.querySelectorAll("#deck-left .ln").length).toBe(3));

    const drawn = [...page.document.querySelectorAll("#deck-left .ln")].map((line) => [line.className, line.textContent!.slice(0, 11)]);
    expect(drawn).toEqual([["ln cmd", "$ squad gat"], ["ln fail", "Gate failed"], ["ln pass", "Gate passed"]]);
    expect(page.text("#deck-left .stream")).toBe(screen); // the colour changes nothing about the text
  });

  it("explains an empty side, and how to fill it", async () => {
    const answer = daemon({ cockpit: { body: { ok: true, cockpit: view({ seats: [claude()] }) } } });
    const page = load("?rig=duo", answer);

    await vi.waitFor(() => expect(page.text("#deck-right .stream")).toContain("No Gemini CLI seat in this rig."));

    expect(page.text("#deck-right .stream")).toContain('squad swarm "…" --runtime frontend=gemini');
    expect(page.text("#gate-right .verdict")).toBe("No seat");
    expect(page.text("#deck-left .badge")).toBe("Claude Code");
  });

  it("lets the person choose between two seats on the same runtime", async () => {
    const second = claude({ nodeId: "n3", seat: "swarm.qa", session: "qa@duo", branch: "squad/duo/swarm.qa" });
    const answer = daemon({ cockpit: { body: { ok: true, cockpit: view({ seats: [claude(), second, gemini()] }) } } });
    const page = load("?rig=duo", answer);
    await vi.waitFor(() => expect(page.document.querySelector("#deck-left select.seat-pick")).not.toBeNull());

    const pick = page.document.querySelector("#deck-left select.seat-pick") as HTMLSelectElement;
    expect([...pick.options].map((option) => option.value)).toEqual(["swarm.backend", "swarm.qa"]);
    pick.value = "swarm.qa";
    pick.dispatchEvent(new page.dom.window.Event("change"));

    await vi.waitFor(() => expect(page.text("#deck-left .stream")).toBe("output of qa@duo"));
    expect((page.document.querySelector("#deck-left select.seat-pick") as HTMLSelectElement).value).toBe("swarm.qa");
  });

  it("follows the seats as they change, polling the screens again", async () => {
    let n = 0;
    const page = load("?rig=duo", daemon({ preview: (session) => ({ body: { content: `${session} frame ${session.startsWith("backend") ? ++n : 0}` } }) }));
    await vi.waitFor(() => expect(page.text("#deck-left .stream")).toMatch(/backend@duo frame 1$/));

    await vi.waitFor(() => expect(page.text("#deck-left .stream")).toMatch(/backend@duo frame [2-9]$/), { timeout: 4000 });
  });

  it("sends the daemon's bearer token with every request when it was handed one", async () => {
    const page = load("?rig=duo", daemon(), { token: "secret-token" });
    await vi.waitFor(() => expect(page.calls.some((c) => c.url.startsWith("/api/sessions/"))).toBe(true));

    for (const call of page.calls) expect(call.headers.Authorization).toBe("Bearer secret-token");
  });

  it("says so when the daemon cannot be reached, and when the rig is unknown", async () => {
    const down = load("?rig=duo", () => { throw new Error("connection refused"); });
    await vi.waitFor(() => expect(down.text("#mode")).toBe("Offline"));
    expect(down.text("#notice")).toContain("Cannot reach the daemon");

    const unknown = load("?rig=ghost", daemon({ cockpit: { status: 404, body: { ok: false, code: "not_found", error: 'No rig is named "ghost".' } } }));
    await vi.waitFor(() => expect(unknown.text("#notice")).toBe('No rig is named "ghost".'));
    expect(unknown.text("#mode")).toBe("Offline");
  });

  it("lists the daemon's rigs to choose from, and starts on the first when none is named", async () => {
    const page = load("", daemon());

    await vi.waitFor(() => expect(page.text("#deck-left .seat")).toBe("swarm.backend"));

    expect([...(page.document.querySelector("#rig") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["duo"]);
    expect(page.calls.some((c) => c.url === "/api/cockpit/duo")).toBe(true);
  });
});

describe("dual cockpit, simulation", () => {
  const demo = (t: number) => load(`?demo=1&t=${t}&paused=1`, () => { throw new Error("the simulation must not call the daemon"); });

  it("is labelled a simulation, makes no request, and cannot land anything", () => {
    const page = demo(21);

    expect(page.text("#mode")).toBe("Simulation");
    expect(page.document.querySelector("#mode")!.getAttribute("title")).toContain("not live");
    expect(page.calls).toEqual([]);
    expect(page.button("Land").disabled).toBe(true);
    expect(page.button("Dry run").disabled).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("draws the same page: a Claude seat and a Gemini seat, a gate blocking one of them, and landing not ready", () => {
    const page = demo(14);

    expect(page.text("#deck-left .badge")).toBe("Claude Code");
    expect(page.text("#deck-right .badge")).toBe("Gemini CLI");
    expect(page.text("#gate-left .verdict")).toBe("Passed");
    expect(page.text("#gate-right .verdict")).toBe("Failed (exit code 1)");
    expect(page.document.querySelector("#gate-right")!.className).toBe("cell fail");
    expect(page.text("#land .verdict")).toBe("Not ready: swarm.frontend");
    expect(page.text("#deck-right .stream")).toContain("1 failing");
  });

  it("starts with nothing run, and ends with both gates passed and the work landed", () => {
    const start = demo(0);
    expect(start.text("#gate-left .verdict")).toBe("No gate run yet");
    expect(start.text("#deck-left .stream")).toBe("");

    const end = demo(26);
    expect(end.text("#gate-left .verdict")).toBe("Passed");
    expect(end.text("#gate-right .verdict")).toBe("Passed");
    expect(end.text("#land .verdict")).toBe("Nothing new to land");
    expect(end.text("#land .msg")).toBe("Landed on squad/build-auth-api/integration. Your own branches were not changed. (Simulated.)");
  });

  it("is what a page opened as a file shows, with a note on how to get live seats", () => {
    const page = load("", () => { throw new Error("no daemon"); }, { url: "file:///repo/assets/dual-cockpit.html" });

    expect(page.text("#mode")).toBe("Simulation");
    expect(page.text("#notice")).toContain("squad start");
    expect(page.document.querySelector("#notice")!.hasAttribute("hidden")).toBe(false);
  });
});

describe("CockpitLogic", () => {
  const { logic } = load("?demo=1&paused=1", () => ({ body: null }));

  it("tidies a screen capture", () => {
    expect(logic.stripAnsi!("\u001b[1;31mred\u001b[0m \u001b]0;title\u0007ok")).toBe("red ok");
    expect(logic.tailLines!("a\nb\nc\nd\n\n  \n", 2)).toBe("c\nd");
    expect(logic.tailLines!(null, 5)).toBe("");
  });

  it("singles out only a shell prompt and the gate's own verdict lines", () => {
    expect(logic.lineTone!("$ npm test")).toBe("cmd");
    expect(logic.lineTone!("  $ git status")).toBe("cmd");
    expect(logic.lineTone!("Gate passed for a at b (1s): npm test")).toBe("pass");
    expect(logic.lineTone!("Gate failed (exit code 1) for a")).toBe("fail");
    expect(logic.lineTone!("Gate timed out for a")).toBe("fail");
    expect(logic.lineTone!("Gate did not complete for a")).toBe("fail");
    for (const plain of ["> a prompt", "all tests passed", "1 failing", "price is $ 5", "The Gate passed", ""]) expect(logic.lineTone!(plain)).toBe("");
  });

  it("picks the seat asked for if it has the runtime, else the first that does", () => {
    const seats = [{ seat: "a", runtime: "gemini" }, { seat: "b", runtime: "claude-code" }, { seat: "c", runtime: "claude-code" }];
    expect(logic.pickSeat!(seats, "claude-code", "c")).toMatchObject({ seat: "c" });
    expect(logic.pickSeat!(seats, "claude-code", "a")).toMatchObject({ seat: "b" }); // a is not a Claude seat
    expect(logic.pickSeat!(seats, "claude-code")).toMatchObject({ seat: "b" });
    expect(logic.pickSeat!(seats, "codex")).toBeNull();
    expect(logic.pickSeat!(undefined, "gemini")).toBeNull();
  });

  it("names runtimes, shortens commits, and formats times and commands", () => {
    expect(logic.runtimeName!("gemini")).toBe("Gemini CLI");
    expect(logic.runtimeName!("claude-code")).toBe("Claude Code");
    expect(logic.runtimeName!("odd")).toBe("odd");
    expect(logic.runtimeName!(null)).toBe("Unknown runtime");
    expect(logic.shortSha!("abcdef0123456")).toBe("abcdef0");
    expect([logic.formatDuration!(450), logic.formatDuration!(2450), logic.formatDuration!(null)]).toEqual(["450ms", "2.5s", ""]);
    expect(logic.commandLine!(["pytest", "-k", "not slow"])).toBe('pytest -k "not slow"');
  });

  it("reads a gate run as a lamp", () => {
    expect(logic.gateView!(null)).toEqual({ tone: "off", label: "No gate run yet", detail: "" });
    expect(logic.gateView!({ status: "passed", commitSha: "abcdef0123", durationMs: 1000, argv: ["x"] })).toEqual({ tone: "pass", label: "Passed", detail: "at abcdef0, 1.0s, x" });
    expect(logic.gateView!({ status: "failed", exitCode: 2, argv: [] })).toMatchObject({ tone: "fail", label: "Failed (exit code 2)" });
    expect(logic.gateView!({ status: "failed", exitCode: null, argv: [] })).toMatchObject({ label: "Failed" });
    expect(logic.gateView!({ status: "timed_out", argv: [] })).toMatchObject({ tone: "fail", label: "Timed out" });
    expect(logic.gateView!({ status: "error", argv: [] })).toMatchObject({ tone: "warn", label: "Did not complete" });
  });

  it("reads the dry run as a lamp and decides whether landing is on offer", () => {
    expect(logic.landingView!(ready)).toMatchObject({ tone: "pass", label: "Ready to land", canLand: true, detail: "onto squad/duo/integration" });
    expect(logic.landingView!(notReady)).toMatchObject({ tone: "warn", label: "Not ready: swarm.frontend", canLand: false });
    expect(logic.landingView!({ outcome: "nothing_to_land", branch: "b", lanes: [] })).toMatchObject({ tone: "off", label: "Nothing new to land", canLand: false });
    expect(logic.landingView!({ outcome: "conflict", branch: "b", lanes: [] })).toMatchObject({ tone: "warn", label: "conflict", canLand: false });
    expect(logic.landingView!({ error: "none", code: "not_found" })).toMatchObject({ tone: "off", label: "No isolated seats to land", canLand: false });
    expect(logic.landingView!({ error: "busy", code: "in_use" })).toMatchObject({ tone: "warn", label: "A land is running" });
    expect(logic.landingView!({ error: "boom", code: "failed" })).toMatchObject({ tone: "fail", label: "Landing cannot be judged", detail: "boom" });
    expect(logic.landingView!(null)).toMatchObject({ tone: "off", canLand: false });
  });

  it("says what a land or a dry run did", () => {
    expect(logic.landResultText!({ outcome: "ready", branch: "b", lanes: [{ result: "would_merge" }] }, true)).toBe("Dry run: 1 lane would merge onto b. Nothing was changed.");
    expect(logic.landResultText!({ outcome: "conflict", branch: "b", lanes: [{ seat: "s", result: "conflict" }] }, false)).toContain("Stopped at a conflict in s.");
    expect(logic.landResultText!({ outcome: "gate_failed", worktreePath: "/w" }, false)).toContain("kept at /w");
    expect(logic.landResultText!({ outcome: "mystery" }, false)).toBe("Landing answered: mystery.");
  });

  it("says how long ago, and nothing for a time it cannot read", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(logic.agoText!("2026-10-01T11:59:59Z", now)).toBe("just now");
    expect(logic.agoText!("2026-10-01T11:59:30Z", now)).toBe("30s ago");
    expect(logic.agoText!("2026-10-01T11:50:00Z", now)).toBe("10m ago");
    expect(logic.agoText!("not a date", now)).toBe("");
  });
});

describe("the page file", () => {
  it("makes no request of its own to anywhere but the daemon it is served from", () => {
    const withoutIconNamespace = html.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/, "");
    expect(withoutIconNamespace).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:|<link[^>]+rel=["']stylesheet|<script[^>]+src=/i);
  });

  it("never writes markup from data: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval", () => {
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
  });
});
