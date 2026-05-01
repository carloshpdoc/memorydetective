import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunCommandOptions {
  /** Working directory to run the command in. */
  cwd?: string;
  /** Timeout in ms (kill the child if it exceeds this). */
  timeoutMs?: number;
}

/**
 * Run a command and collect stdout/stderr. Does not throw on non-zero exit code —
 * the caller decides what's acceptable (e.g. `leaks` exits 1 when leaks are found,
 * which is normal).
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        reject(
          new Error(
            `Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(" ")}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
