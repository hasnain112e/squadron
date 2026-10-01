import nodePath from "node:path";
import type { TmuxAdapter } from "./tmux.js";
import { geminiPostureArg } from "./yolo-mode.js";
import { shellQuote } from "./shell-quote.js";
import { assessGeminiScreen } from "../domain/gemini-screen.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  resolveConcreteHint,
  type RuntimeAdapter, type NodeBinding, type ResolvedStartupFile, type InstalledResource,
  type ProjectionResult, type StartupDeliveryResult, type ReadinessResult, type HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";

// The Gemini CLI (`gemini`, google-gemini/gemini-cli) as a seat runtime: the interactive CLI in the seat's tmux
// pane, like Claude Code and Codex. Facts about the CLI come from its own docs and source at v0.62:
//   - Context comes from GEMINI.md files in the workspace, and workspace skills from `.agents/skills/`
//     (an alias of `.gemini/skills/`), which is also where Codex seats get theirs.
//   - Folder trust is off by default; when it is on, GEMINI_CLI_TRUST_WORKSPACE=true trusts the workspace for
//     that run only. This adapter sets it on the command, so it writes nothing under ~/.gemini.
//   - `--approval-mode` is default | auto_edit | yolo | plan; see geminiPostureArg.
//   - Signing in (Google account, API key or Vertex AI) is the person's: a seat that finds the sign-in
//     screen reports login_required instead of guessing.
// Not supported yet, and refused or skipped loudly: resuming or forking a session (no session id is recorded),
// activity hooks, and subagents, plugins and runtime resources in a projection plan.

export interface GeminiAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  /** Every file under a directory, as paths relative to it (nested files included). */
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

const CONTEXT_FILE = "GEMINI.md";
const SKILLS_DIR = nodePath.join(".agents", "skills");

export class GeminiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "gemini";
  private tmux: TmuxAdapter;
  private fs: GeminiAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private launchPath?: string;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: GeminiAdapterFsOps;
    sleep?: (ms: number) => Promise<void>;
    /** Match the daemon's prerequisite probe even if the pane's login shell rewrites PATH. */
    launchPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.launchPath = deps.launchPath;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const skillsDir = nodePath.join(binding.cwd, SKILLS_DIR);
    if (!this.fs.exists(skillsDir) || !this.fs.listFiles) return [];
    return this.fs.listFiles(skillsDir).map((file) => ({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        (this.projectEntry(entry, binding.cwd) ? projected : skipped).push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }
    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (!this.mergeGuidance(nodePath.join(binding.cwd, CONTEXT_FILE), file.path, content)) continue; // per-seat role: sent as text instead, so not counted
        } else if (hint === "skill_install") {
          const targetDir = nodePath.join(binding.cwd, SKILLS_DIR, nodePath.basename(nodePath.dirname(file.absolutePath)));
          this.fs.mkdirp(targetDir);
          this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
        } else if (hint === "send_text" && binding.tmuxSession) {
          const text = await this.tmux.sendText(binding.tmuxSession, content);
          if (!text.ok) throw new Error(text.message);
          await this.sleep(200);
          const submit = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
          if (!submit.ok) throw new Error(submit.message);
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound — cannot launch the Gemini CLI" };
    if (opts.resumeToken || opts.forkSource) {
      return {
        ok: false,
        recovery: "retry_fresh",
        error: "gemini seats cannot be resumed or forked yet: no Gemini session is recorded for the seat. Start it fresh.",
      };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const cmd = `GEMINI_CLI_TRUST_WORKSPACE=true gemini${geminiPostureArg(process.env, binding.launchPosture)}${modelArg}`;
    const sent = await this.tmux.sendShellCommand(binding.tmuxSession, this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd);
    if (!sent.ok) return { ok: false, error: `Failed to send launch command: ${sent.message}` };
    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) return { ready: false, reason: "tmux session not responsive" };

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    // The rendered screen is the truth about now; scrollback keeps dismissed dialogs.
    const paneContent = (this.tmux.capturePaneScreen
      ? await this.tmux.capturePaneScreen(binding.tmuxSession)
      : await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const screen = assessGeminiScreen({ paneCommand, paneContent });
    return screen.status === "resumed" ? { ready: true } : { ready: false, reason: screen.detail, code: screen.code };
  }

  /** Returns false when the entry has no home in Gemini's workspace (it is skipped, not failed). */
  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(nodePath.join(cwd, CONTEXT_FILE), entry.effectiveId, this.fs.readFile(entry.absolutePath));
    }
    if (entry.category !== "skill") return false;

    const targetDir = nodePath.join(cwd, SKILLS_DIR, entry.effectiveId);
    this.fs.mkdirp(targetDir);
    const nested = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath) : [];
    if (nested.length === 0) {
      this.copyFile(entry.absolutePath, nodePath.join(targetDir, nodePath.basename(entry.absolutePath))); // a skill given as one file
      return true;
    }
    for (const file of nested) this.copyFile(nodePath.join(entry.absolutePath, file), nodePath.join(targetDir, file));
    return true;
  }

  /** Copy a file, keeping its permission bits so a skill's helper scripts stay executable. */
  private copyFile(src: string, dest: string): void {
    this.fs.mkdirp(nodePath.dirname(dest));
    this.fs.writeFile(dest, this.fs.readFile(src));
    if (this.fs.statMode && this.fs.chmod) {
      const mode = this.fs.statMode(src) & 0o777;
      if ((this.fs.statMode(dest) & 0o777) !== mode) this.fs.chmod(dest, mode);
    }
  }

  /**
   * Merge guidance into GEMINI.md as a managed block. False means skipped on purpose: the per-seat role block
   * would collide between pod-mates in one file, so that content goes to the seat through send_text instead.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.fs, targetPath, blockId, content);
    return true;
  }
}
