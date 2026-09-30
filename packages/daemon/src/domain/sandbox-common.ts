import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

// Shared by the sandbox, gate and landing services: the error type, the one way git is run, and the
// path and branch naming, so all three agree on where a seat's or a rig's worktree lives.

const execFileAsync = promisify(execFile);
// The first checkout of a large tree is slow; a hung git is still bounded.
const GIT_TIMEOUT_MS = 120_000;
/** How long a setup or gate command may run unless the caller says otherwise. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/** "invalid": the request itself is wrong (400). "not_found" (404). Anything else the caller can fix is a conflict (409). */
export type SandboxErrorCode = "not_found" | "in_use" | "failed" | "invalid";

/**
 * A rig's integration branch has a worktree like a seat does, and is recorded as one more sandbox under this id.
 * Its seat name is "integration", which no pod-qualified seat name can equal (those always contain a dot), so
 * `squad-worktrees/<repo>/<rig>/integration` and `squad/<rig>/integration` cannot collide with a seat's.
 */
export const integrationNodeId = (rigName: string): string => `integration:${rigName}`;
export const isIntegrationNode = (nodeId: string): boolean => nodeId.startsWith("integration:");

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** One safe path and branch segment: letters, digits, `.`, `_`, `-`; never empty, never edged by a dot or dash. */
export function segment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\.lock$/, "")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "seat";
}

export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.relative(real(a), real(b)) === "";
}

/** Run `git <args>` in `cwd` with an argument vector, never a shell string, and return trimmed stdout. */
export async function sandboxGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new SandboxError("failed", `git ${args.join(" ")}: ${stderr?.trim() || message}`);
  }
}

/** `<repo parent>/squad-worktrees/<repo>/<rig>/<leaf>`: a sibling of the repository, so nothing appears inside it. */
export function rigWorktreePath(top: string, rigName: string, leaf: string): string {
  return path.join(path.dirname(top), "squad-worktrees", segment(path.basename(top)), segment(rigName), segment(leaf));
}

/** Resolve the authored cwd to its real path and the root of the repository that contains it. */
export async function locateRepo(repoPath: string): Promise<{ real: string; top: string }> {
  let real: string;
  try {
    real = fs.realpathSync.native(repoPath);
  } catch {
    throw new SandboxError("failed", `isolation: worktree needs the seat's repository directory, but ${repoPath} does not exist.`);
  }
  const top = await sandboxGit(["rev-parse", "--show-toplevel"], real).catch((error: SandboxError) => {
    // Only say "not a repository" when git said so; a missing git binary or a timeout keeps its own message.
    if (!/not a git repository/i.test(error.message)) throw error;
    throw new SandboxError(
      "failed",
      `isolation: worktree needs a git repository, but ${real} is not inside one. Run git init there, or remove isolation: worktree from the member.`,
    );
  });
  return { real, top: fs.realpathSync.native(top) };
}

/** True when `worktreePath` is a registered worktree of the repository at `top`, checked out on `branch`. */
export async function isWorktreeOnBranch(top: string, worktreePath: string, branch: string): Promise<boolean> {
  const listing = await sandboxGit(["worktree", "list", "--porcelain"], top);
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const space = line.indexOf(" ");
      if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const listed = fields.get("worktree");
    if (listed && samePath(listed, worktreePath)) return fields.get("branch") === `refs/heads/${branch}`;
  }
  return false;
}

export async function branchExists(top: string, branch: string): Promise<boolean> {
  return sandboxGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], top).then(
    () => true,
    () => false,
  );
}

const running = new Set<string>();

/** Run `fn` unless another call holds `key`, so two setups, gates or lands never race over one worktree. */
export async function exclusive<T>(key: string, busyMessage: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new SandboxError("in_use", busyMessage);
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

/** The last `n` lines of command output, for an error message. */
export function lastLines(text: string, n = 20): string {
  return text.trimEnd().split(/\r?\n/).slice(-n).join("\n");
}
