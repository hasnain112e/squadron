import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntimeAdapter, type GeminiAdapterFsOps } from "../src/adapters/gemini-runtime-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { geminiPostureArg } from "../src/adapters/yolo-mode.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

const READY_SCREEN = "╭────╮\n│ >   Type your message or @path/to/file │\n╰────╯\n~/app   no sandbox (see /docs)   gemini-2.5-pro";

function mockTmux(overrides: Partial<TmuxAdapter> = {}): TmuxAdapter {
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "node"),
    capturePaneScreen: vi.fn(async () => READY_SCREEN),
    capturePaneContent: vi.fn(async () => READY_SCREEN),
    ...overrides,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
}

// Keys are POSIX paths; the adapter builds its paths with path.join, which gives backslashes on Windows.
const posix = (p: string) => p.replace(/\\/g, "/");

function mockFs(files: Record<string, string> = {}): GeminiAdapterFsOps & { store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    store,
    readFile: (p) => { if (posix(p) in store) return store[posix(p)]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p, c) => { store[posix(p)] = c; },
    exists: (p) => posix(p) in store || Object.keys(store).some((k) => k.startsWith(`${posix(p)}/`)),
    mkdirp: () => {},
    listFiles: (dir) => Object.keys(store).filter((k) => k.startsWith(`${posix(dir)}/`)).map((k) => k.slice(posix(dir).length + 1)),
  };
}

const binding = (extra: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: "swarm-backend@demo", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...extra,
});

const entry = (over: Partial<ProjectionEntry> = {}): ProjectionEntry => ({
  category: "skill", effectiveId: "test-skill", sourceSpec: "base", sourcePath: "/agents/base",
  resourcePath: "skills/test", absolutePath: "/agents/base/skills/test", classification: "safe_projection", ...over,
});

const plan = (entries: ProjectionEntry[]): ProjectionPlan => ({ runtime: "gemini", cwd: "/project", entries, startup: { files: [], actions: [] } as never, conflicts: [], noOps: [], diagnostics: [] });

const startupFile = (over: Partial<ResolvedStartupFile> = {}): ResolvedStartupFile => ({
  path: "guidance/role.md", absolutePath: "/agents/base/guidance/role.md", ownerRoot: "/agents/base", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"], ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("GeminiRuntimeAdapter", () => {
  it("is the gemini runtime and has the five-method contract", () => {
    const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() });

    expect(adapter.runtime).toBe("gemini");
    for (const method of ["listInstalled", "project", "deliverStartup", "launchHarness", "checkReady"] as const) {
      expect(typeof adapter[method]).toBe("function");
    }
  });

  describe("launchHarness", () => {
    it("starts gemini in the seat's pane, at the floor posture, trusting the folder for this session only", async () => {
      vi.stubEnv("OPENRIG_YOLO", "");
      const tmux = mockTmux();
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps: mockFs() });

      const result = await adapter.launchHarness(binding(), { name: "swarm-backend@demo" });

      expect(result).toEqual({ ok: true });
      expect(tmux.sendText).toHaveBeenCalledWith("swarm-backend@demo", "GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode auto_edit");
      expect(tmux.sendKeys).toHaveBeenCalledWith("swarm-backend@demo", ["Enter"]);
    });

    it("passes the seat's model", async () => {
      vi.stubEnv("OPENRIG_YOLO", "");
      const tmux = mockTmux();
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps: mockFs() });

      await adapter.launchHarness(binding({ model: "gemini-2.5-flash" }), { name: "n" });

      expect(tmux.sendText).toHaveBeenCalledWith("swarm-backend@demo", `GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode auto_edit -m ${shellQuote("gemini-2.5-flash")}`);
    });

    it("quotes a model name so it cannot become more than one argument", async () => {
      const tmux = mockTmux();
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps: mockFs() });

      await adapter.launchHarness(binding({ model: "x; rm -rf /" }), { name: "n" });

      const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
      expect(command).toContain(`-m ${shellQuote("x; rm -rf /")}`);
      expect(command).not.toMatch(/-m x;/);
    });

    it("uses full bypass when YOLO is on, or when the seat's policy resolved to full bypass", async () => {
      vi.stubEnv("OPENRIG_YOLO", "1");
      const viaEnv = mockTmux();
      await new GeminiRuntimeAdapter({ tmux: viaEnv, fsOps: mockFs() }).launchHarness(binding(), { name: "n" });
      expect(vi.mocked(viaEnv.sendText).mock.calls[0]![1]).toBe("GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode yolo");

      vi.stubEnv("OPENRIG_YOLO", "");
      const viaPolicy = mockTmux();
      await new GeminiRuntimeAdapter({ tmux: viaPolicy, fsOps: mockFs() }).launchHarness(binding({ launchPosture: "full_bypass" }), { name: "n" });
      expect(vi.mocked(viaPolicy.sendText).mock.calls[0]![1]).toContain("--approval-mode yolo");

      // A seat whose policy says floor stays at the floor even when YOLO is on globally.
      vi.stubEnv("OPENRIG_YOLO", "1");
      const floored = mockTmux();
      await new GeminiRuntimeAdapter({ tmux: floored, fsOps: mockFs() }).launchHarness(binding({ launchPosture: "floor" }), { name: "n" });
      expect(vi.mocked(floored.sendText).mock.calls[0]![1]).toContain("--approval-mode auto_edit");
    });

    it("keeps the daemon's PATH when it was given one", async () => {
      vi.stubEnv("OPENRIG_YOLO", "");
      const tmux = mockTmux();
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps: mockFs(), launchPath: "/usr/local/bin:/usr/bin" });

      await adapter.launchHarness(binding(), { name: "n" });

      expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toBe(`env PATH=${shellQuote("/usr/local/bin:/usr/bin")} GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode auto_edit`);
    });

    it("refuses to resume or fork, because it never records a session to come back to, and says to start fresh", async () => {
      const tmux = mockTmux();
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps: mockFs() });

      const resumed = await adapter.launchHarness(binding(), { name: "n", resumeToken: "a1b2" });
      const forked = await adapter.launchHarness(binding(), { name: "n", forkSource: { kind: "native_id", value: "a1b2" } });

      for (const result of [resumed, forked]) {
        expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
        expect((result as { error: string }).error).toContain("gemini");
      }
      expect(tmux.sendText).not.toHaveBeenCalled();
    });

    it("fails clearly when there is no pane to start it in, or the pane would not take the command", async () => {
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() });
      expect(await adapter.launchHarness(binding({ tmuxSession: null }), { name: "n" })).toEqual({ ok: false, error: "No tmux session bound — cannot launch the Gemini CLI" });

      const refusing = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, code: "x", message: "pane is gone" })) as never });
      const result = await new GeminiRuntimeAdapter({ tmux: refusing, fsOps: mockFs() }).launchHarness(binding(), { name: "n" });
      expect(result).toEqual({ ok: false, error: "Failed to send launch command: pane is gone" });
    });
  });

  describe("checkReady", () => {
    it("is ready when the input prompt is showing", async () => {
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() });

      expect(await adapter.checkReady(binding())).toEqual({ ready: true });
    });

    it("reads the rendered screen, and falls back to the last lines when the screen cannot be read", async () => {
      const tmux = mockTmux({ capturePaneScreen: undefined, capturePaneContent: vi.fn(async () => READY_SCREEN) } as never);

      expect((await new GeminiRuntimeAdapter({ tmux, fsOps: mockFs() }).checkReady(binding())).ready).toBe(true);
      expect(tmux.capturePaneContent).toHaveBeenCalledWith("swarm-backend@demo", 40);
    });

    it("says why it is not ready: no pane, a dead session, a shell prompt, a sign-in, a trust dialog, still starting", async () => {
      const ready = (over: Partial<TmuxAdapter>) => new GeminiRuntimeAdapter({ tmux: mockTmux(over), fsOps: mockFs() }).checkReady(binding());

      expect(await new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() }).checkReady(binding({ tmuxSession: null }))).toEqual({ ready: false, reason: "No tmux session bound" });
      expect(await ready({ hasSession: vi.fn(async () => false) })).toEqual({ ready: false, reason: "tmux session not responsive" });
      expect(await ready({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneScreen: vi.fn(async () => "user@host ~ %") })).toMatchObject({ ready: false, code: "returned_to_shell" });
      expect(await ready({ capturePaneScreen: vi.fn(async () => "How would you like to authenticate for this project?") })).toMatchObject({ ready: false, code: "login_required" });
      expect(await ready({ capturePaneScreen: vi.fn(async () => "Do you trust the files in this folder?") })).toMatchObject({ ready: false, code: "trust_gate" });
      expect(await ready({ capturePaneScreen: vi.fn(async () => "") })).toMatchObject({ ready: false, code: "awaiting_runtime" });
    });
  });

  describe("project", () => {
    it("copies a skill folder, nested files included, to where Gemini looks for workspace skills", async () => {
      const fsOps = mockFs({ "/agents/base/skills/test/SKILL.md": "# SKILL\nuse me", "/agents/base/skills/test/scripts/run.sh": "echo hi" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      const result = await adapter.project(plan([entry()]), binding());

      expect(result).toEqual({ projected: ["test-skill"], skipped: [], failed: [] });
      expect(fsOps.store["/project/.agents/skills/test-skill/SKILL.md"]).toBe("# SKILL\nuse me");
      expect(fsOps.store["/project/.agents/skills/test-skill/scripts/run.sh"]).toBe("echo hi");
    });

    it("copies a single-file skill into its own folder", async () => {
      const fsOps = mockFs({ "/agents/base/skills/one/SKILL.md": "# SKILL" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      await adapter.project(plan([entry({ effectiveId: "one", absolutePath: "/agents/base/skills/one/SKILL.md" })]), binding());

      expect(fsOps.store["/project/.agents/skills/one/SKILL.md"]).toBe("# SKILL");
    });

    it("merges guidance into GEMINI.md as a managed block, keeping what is already there", async () => {
      const fsOps = mockFs({ "/agents/base/guidance/role.md": "Be careful.", "/project/GEMINI.md": "# Mine\nKeep this." });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      const result = await adapter.project(plan([entry({ category: "guidance", effectiveId: "role.md", absolutePath: "/agents/base/guidance/role.md", mergeStrategy: "managed_block" })]), binding());

      expect(result.projected).toEqual(["role.md"]);
      const merged = fsOps.store["/project/GEMINI.md"]!;
      expect(merged).toContain("# Mine\nKeep this.");
      expect(merged).toContain("BEGIN OpenRig MANAGED BLOCK: role.md");
      expect(merged).toContain("Be careful.");
      expect(fsOps.store["/project/AGENTS.md"]).toBeUndefined();
    });

    it("skips what Gemini has no home for yet instead of failing the launch, and says so", async () => {
      const fsOps = mockFs({ "/a/sub.yaml": "x", "/a/plugin/p.json": "x", "/a/rr.json": "x" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      const result = await adapter.project(
        plan([
          entry({ category: "subagent", effectiveId: "helper", absolutePath: "/a/sub.yaml" }),
          entry({ category: "plugin", effectiveId: "plug", absolutePath: "/a/plugin" }),
          entry({ category: "runtime_resource", effectiveId: "rr", absolutePath: "/a/rr.json" }),
          entry({ effectiveId: "already", classification: "no_op" }),
        ]),
        binding(),
      );

      expect(result).toEqual({ projected: [], skipped: ["helper", "plug", "rr", "already"], failed: [] });
      expect(Object.keys(fsOps.store).filter((k) => k.startsWith("/project/"))).toEqual([]);
    });

    it("reports a failure for the entry that failed and keeps going", async () => {
      const fsOps = mockFs({ "/agents/base/skills/good/SKILL.md": "# SKILL" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      const result = await adapter.project(
        plan([entry({ effectiveId: "missing", absolutePath: "/agents/base/skills/missing/SKILL.md" }), entry({ effectiveId: "good", absolutePath: "/agents/base/skills/good" })]),
        binding(),
      );

      expect(result.projected).toEqual(["good"]);
      expect(result.failed).toEqual([{ effectiveId: "missing", error: expect.stringContaining("Not found") }]);
    });
  });

  describe("deliverStartup", () => {
    it("merges guidance into GEMINI.md, installs skills, and types text into the pane then submits it", async () => {
      const tmux = mockTmux();
      const fsOps = mockFs({
        "/agents/base/guidance/role.md": "Be careful.",
        "/agents/base/skills/x/SKILL.md": "# SKILL\nx",
        "/agents/base/notes.txt": "hello seat",
      });
      const adapter = new GeminiRuntimeAdapter({ tmux, fsOps, sleep: async () => {} });

      const result = await adapter.deliverStartup(
        [
          startupFile(),
          startupFile({ path: "skills/x/SKILL.md", absolutePath: "/agents/base/skills/x/SKILL.md" }),
          startupFile({ path: "notes.txt", absolutePath: "/agents/base/notes.txt", deliveryHint: "send_text" }),
        ],
        binding(),
      );

      expect(result).toEqual({ delivered: 3, failed: [] });
      expect(fsOps.store["/project/GEMINI.md"]).toContain("Be careful.");
      expect(fsOps.store["/project/.agents/skills/x/SKILL.md"]).toBe("# SKILL\nx");
      expect(tmux.sendText).toHaveBeenCalledWith("swarm-backend@demo", "hello seat");
      expect(tmux.sendKeys).toHaveBeenCalledWith("swarm-backend@demo", ["C-m"]);
    });

    it("does not count the per-seat role block as delivered, since that goes through send_text", async () => {
      const fsOps = mockFs({ "/agents/base/guidance/rig-role.md": "role" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps, sleep: async () => {} });

      const result = await adapter.deliverStartup([startupFile({ path: "rig-role", absolutePath: "/agents/base/guidance/rig-role.md", deliveryHint: "guidance_merge" })], binding());

      expect(result.delivered).toBe(0);
      expect(fsOps.store["/project/GEMINI.md"]).toBeUndefined();
    });

    it("reports a required file it could not deliver, and quietly drops an optional one", async () => {
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs(), sleep: async () => {} });

      const result = await adapter.deliverStartup([startupFile({ path: "a.md", required: true }), startupFile({ path: "b.md", required: false })], binding());

      expect(result.delivered).toBe(0);
      expect(result.failed).toEqual([{ path: "a.md", error: expect.stringContaining("Not found") }]);
    });
  });

  describe("listInstalled", () => {
    it("lists the skills in the seat's workspace", async () => {
      const fsOps = mockFs({ "/project/.agents/skills/alpha/SKILL.md": "x", "/project/.agents/skills/beta/SKILL.md": "x" });
      const adapter = new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps });

      const installed = await adapter.listInstalled(binding());

      expect(installed.map((r) => r.category)).toEqual(["skill", "skill"]);
      expect(installed.map((r) => r.effectiveId).sort()).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    });

    it("lists nothing when there is no skills folder", async () => {
      expect(await new GeminiRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() }).listInstalled(binding())).toEqual([]);
    });
  });
});

describe("geminiPostureArg", () => {
  it("is the floor unless YOLO is on", () => {
    expect(geminiPostureArg({})).toBe(" --approval-mode auto_edit");
    expect(geminiPostureArg({ OPENRIG_YOLO: "0" })).toBe(" --approval-mode auto_edit");
    expect(geminiPostureArg({ OPENRIG_YOLO: "1" })).toBe(" --approval-mode yolo");
    expect(geminiPostureArg({ OPENRIG_YOLO: "true" })).toBe(" --approval-mode yolo");
  });

  it("lets a seat's resolved policy decide, in both directions", () => {
    expect(geminiPostureArg({}, "full_bypass")).toBe(" --approval-mode yolo");
    expect(geminiPostureArg({ OPENRIG_YOLO: "1" }, "floor")).toBe(" --approval-mode auto_edit");
  });
});
