import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../src/domain/sandbox-command-runner.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runCommand", { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "squad-run-")));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const js = (code: string) => [process.execPath, "-e", code];
  const run = (argv: string[], timeoutMs = 30_000) => runCommand(argv, { cwd: dir, timeoutMs });

  it("passes on exit code 0 and captures stdout and stderr", async () => {
    const result = await run(js("console.log('to-stdout'); console.error('to-stderr')"));

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.outputTail).toContain("to-stdout");
    expect(result.outputTail).toContain("to-stderr");
  });

  it("fails on a non-zero exit code and reports it", async () => {
    const result = await run(js("console.log('about to fail'); process.exit(3)"));

    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    expect(result.outputTail).toContain("about to fail");
  });

  it("runs in the directory it is given", async () => {
    const result = await run(js("console.log(process.cwd())"));

    expect(fs.realpathSync.native(result.outputTail.trim())).toBe(dir);
  });

  it("sets CI so test runners do not wait for input", async () => {
    const result = await run(js("console.log('CI=' + process.env.CI)"));

    expect(result.outputTail).toContain("CI=");
    expect(result.outputTail).not.toContain("CI=undefined");
  });

  it("keeps only the tail of long output", async () => {
    const result = await run(js("process.stdout.write('x'.repeat(300000) + 'THE-END')"));

    expect(result.status).toBe("passed");
    expect(result.outputTail.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.outputTail.endsWith("THE-END")).toBe(true);
  });

  it("reports a command that cannot be started, without throwing", async () => {
    const result = await run(["definitely-not-a-real-command-squad"]);

    expect(result.status).toBe("error");
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).toContain("Could not start");
  });

  it("kills the command and the processes it started when it times out", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const childCode = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const parentCode =
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' });` +
      "setInterval(() => {}, 1000)";

    const started = Date.now();
    const result = await run(js(parentCode), 4_000);

    expect(result.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(20_000);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 60 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });

  describe.skipIf(process.platform !== "win32")("Windows .cmd shims", () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env["PATH"];
      fs.writeFileSync(path.join(dir, "squadshim.cmd"), "@echo off\r\ntype nul > ran.marker\r\necho shim-args %*\r\n");
      process.env["PATH"] = `${dir}${path.delimiter}${savedPath ?? ""}`;
    });

    afterEach(() => {
      process.env["PATH"] = savedPath;
    });

    it("runs a bare command that is really a .cmd file, keeping arguments with spaces whole", async () => {
      const result = await run(["squadshim", "one two", "three"]);

      expect(result).toMatchObject({ status: "passed", exitCode: 0 });
      expect(result.outputTail).toContain('"one two"');
      expect(result.outputTail).toContain('"three"');
    });

    it("hands the program exactly the arguments given, including spaces and a trailing backslash", async () => {
      // A shim that runs node and prints the arguments node actually received.
      fs.writeFileSync(
        path.join(dir, "argshim.cmd"),
        `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
      );
      const given = ["one two", "C:\\some dir\\", "a=b,c", "--flag=x:y", "plain"];

      const result = await run(["argshim", ...given]);

      expect(result.status).toBe("passed");
      expect(JSON.parse(result.outputTail.trim())).toEqual(given);
    });

    it("refuses arguments cmd.exe would interpret, and does not run the command", async () => {
      const result = await run(["squadshim", "a&calc"]);

      expect(result.status).toBe("error");
      expect(result.outputTail).toContain("cmd.exe");
      expect(fs.existsSync(path.join(dir, "ran.marker"))).toBe(false);
    });
  });
});
