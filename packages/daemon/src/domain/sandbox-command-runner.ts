import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Runs the `setup` and `gate` commands a rig spec declares. A command is an argument vector, never a
// shell string, so nothing in it is interpreted by a shell. Output is kept to a bounded tail, and a
// timeout kills the whole process tree, because test runners leave children behind.

export interface CommandResult {
  status: "passed" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  durationMs: number;
  /** The last 64 KiB of stdout and stderr, in the order they arrived. */
  outputTail: string;
}

const TAIL_CHARS = 64 * 1024;

/** A few words for an error message: "exit code 1", "timed out", "could not start". */
export function describeResult(result: CommandResult): string {
  if (result.status === "passed") return "passed";
  if (result.status === "timed_out") return "timed out";
  if (result.status === "error") return "could not start";
  return result.exitCode === null ? "was stopped" : `exit code ${result.exitCode}`;
}

// On Windows `npm`, `npx`, `pnpm` and `yarn` are `.cmd` files, which can only run through cmd.exe. Quoting an
// arbitrary argument for cmd.exe correctly is a known trap, so such a command accepts only arguments made of
// characters cmd.exe leaves alone inside double quotes, and anything else is refused with an explanation.
const CMD_SAFE_ARGUMENT = /^[A-Za-z0-9_\-.\/\\:@+=,~# ]*$/;

/** Find the file that would run for `command` on Windows, the way cmd.exe searches PATH and PATHEXT. */
function resolveWindowsCommand(command: string, cwd: string): string | null {
  const extensions = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const names = hasExtension ? [command] : extensions.map((ext) => command + ext);
  const hasSeparator = /[\\/]/.test(command);
  const directories = hasSeparator ? [path.dirname(path.resolve(cwd, command))] : (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, hasSeparator ? path.basename(name) : name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here; try the next */
      }
    }
  }
  return null;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the child leads its own process group (see `detached` below)
  } catch {
    child.kill("SIGKILL");
  }
}

/** Run `argv` in `cwd`. Resolves whatever happens; it never rejects. */
export function runCommand(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  const started = Date.now();
  const fail = (message: string): Promise<CommandResult> =>
    Promise.resolve({ status: "error", exitCode: null, durationMs: Date.now() - started, outputTail: message });

  let file = argv[0]!;
  let args = argv.slice(1);
  let verbatim = false;
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(file, opts.cwd);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      const unsafe = args.find((arg) => !CMD_SAFE_ARGUMENT.test(arg));
      if (unsafe !== undefined) {
        return fail(
          `Cannot pass ${JSON.stringify(unsafe)} to ${file} on Windows: it runs through cmd.exe, which would interpret some of those characters. ` +
            "Use an executable, or put the command in a script file and run that.",
        );
      }
      file = process.env["ComSpec"] ?? "cmd.exe";
      // Backslashes before a closing quote are doubled, or the program reading its arguments would treat that quote as part of one.
      const quote = (part: string) => `"${part.replace(/(\\+)$/, "$1$1")}"`;
      args = ["/d", "/s", "/c", `"${[resolved, ...args].map(quote).join(" ")}"`];
      verbatim = true;
    } else if (resolved) {
      file = resolved;
    }
  }

  return new Promise((resolve) => {
    let tail = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: Omit<CommandResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - started });
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: { CI: "true", ...process.env }, // many test runners wait for input or watch files unless CI is set
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      settle({ status: "error", exitCode: null, outputTail: `Could not start ${JSON.stringify(argv[0])}: ${(error as Error).message}` });
      return;
    }
    const collect = (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_CHARS);
    };
    child.stdout?.setEncoding("utf8").on("data", collect);
    child.stderr?.setEncoding("utf8").on("data", collect);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    child.once("error", (error) => settle({ status: "error", exitCode: null, outputTail: `Could not start ${JSON.stringify(argv[0])}: ${error.message}` }));
    child.once("close", (code) => {
      if (timedOut) settle({ status: "timed_out", exitCode: code, outputTail: tail });
      else settle({ status: code === 0 ? "passed" : "failed", exitCode: code, outputTail: tail });
    });
  });
}
