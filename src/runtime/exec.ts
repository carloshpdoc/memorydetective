import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * Present and `true` when the command was terminated by the
   * `gracefulKillAfterMs` timeout-escalation path. Tools that wrote
   * partial output before the timeout (e.g. `xctrace record` which
   * incrementally flushes the `.trace` bundle) can return that output
   * to the caller alongside this flag, rather than the caller having
   * to choose between "throw on timeout" and "no timeout protection".
   */
  timedOut?: boolean;
}

export interface RunCommandOptions {
  /** Working directory to run the command in. */
  cwd?: string;
  /** Timeout in ms (kill the child if it exceeds this). */
  timeoutMs?: number;
  /**
   * Extra environment variables to expose to the child process. When provided,
   * these are MERGED on top of `process.env` (PATH, DEVELOPER_DIR, HOME and
   * other inherited vars are preserved). Pass an empty object to inherit
   * unchanged; pass `undefined` (or omit) for the same default.
   */
  env?: Record<string, string>;
  /**
   * Signal to send when the command exceeds `timeoutMs`. Defaults to
   * `SIGTERM`. Pass `SIGINT` for processes that flush partial output on
   * graceful interruption (e.g. xctrace writes the `.trace` bundle
   * incrementally and needs SIGINT to finalize template metadata; SIGTERM
   * leaves a corrupt trace that fails on export).
   */
  timeoutSignal?: NodeJS.Signals;
  /**
   * When `> 0`, switches the timeout path from "kill + reject" to
   * "graceful kill + resolve with partial output". On timeout: send
   * `timeoutSignal`, wait this many ms for the child to exit, then
   * escalate to SIGKILL if still alive. The promise resolves with the
   * partial stdout/stderr + `timedOut: true` on the response, instead
   * of rejecting with a timeout error.
   *
   * Use when partial output is meaningful (xctrace traces, long-running
   * recordings, etc.). Default `0` preserves the historical
   * "reject-on-timeout" behavior for all existing callers.
   */
  gracefulKillAfterMs?: number;
}

/**
 * Run a command and collect stdout/stderr. Does not throw on non-zero exit code,
 * the caller decides what's acceptable (e.g. `leaks` exits 1 when leaks are found,
 * which is normal).
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env = opts.env
      ? { ...process.env, ...opts.env }
      : undefined;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let timer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const timeoutSignal: NodeJS.Signals = opts.timeoutSignal ?? "SIGTERM";
    const graceful =
      opts.gracefulKillAfterMs != null && opts.gracefulKillAfterMs > 0;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill(timeoutSignal);
        if (graceful) {
          // SIGKILL escalation: if the child does not exit cleanly within
          // the grace window after the soft signal, force it down so the
          // promise still settles. SIGKILL is irrecoverable but guarantees
          // termination even if the process is wedged on a kernel call.
          escalationTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // Child may already be gone between the check and the kill;
              // ignore. The `close` handler will still fire.
            }
          }, opts.gracefulKillAfterMs);
        }
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
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (killedByTimeout && !graceful) {
        reject(
          new Error(
            `Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(" ")}`,
          ),
        );
        return;
      }
      resolve({
        stdout,
        stderr,
        code: code ?? -1,
        ...(killedByTimeout ? { timedOut: true } : {}),
      });
    });
  });
}
