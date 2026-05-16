/**
 * Security and resource-limit flags read from the environment.
 *
 * These flags exist to make memorydetective safer to install in shared
 * setups (CI runners, teammate's machine, automation pipelines) by
 * gating operations that can execute arbitrary local programs, bound
 * recording durations so an unattended agent does not pile up
 * multi-GB traces, and centralize where `.trace` bundles get written
 * by default so cleanup is predictable.
 *
 * The flags are read from `process.env` lazily (each tool call calls
 * `getSecurityFlags()` fresh). Defaults preserve the v1.8 behavior
 * for every existing caller; the new behavior is opt-in via the env
 * var.
 *
 * - `MEMORYDETECTIVE_ALLOW_LAUNCH=1`: gates
 *   `bootAndLaunchForLeakInvestigation`. Without it, the tool returns
 *   `ok: false` with an explanation. With it, the tool runs normally.
 *   Default is OFF because that tool executes `xcodebuild` and
 *   `xcrun simctl launch`, which are "run arbitrary local program"
 *   in a trusted-input sense.
 *
 * - `MEMORYDETECTIVE_MAX_RECORDING_SECONDS=300` (default 300): caps
 *   `durationSec` for `recordTimeProfile`. A caller asking for a
 *   recording longer than this gets a clear error rather than the
 *   tool silently agreeing to a 10-minute trace.
 *
 * - `MEMORYDETECTIVE_TRACE_ROOT=<path>` (default
 *   `~/Library/Application Support/memorydetective/traces`):
 *   directory where `.trace` bundles are written when the caller
 *   provides a relative `output` path. Absolute `output` paths
 *   bypass this default, preserving existing behavior. Also used by
 *   the upcoming `cleanup_traces` tool as the default scan path.
 */

import os from "node:os";
import { join as joinPath } from "node:path";
import { parseBooleanEnv } from "./parseBooleanEnv.js";

export interface SecurityFlags {
  allowLaunch: boolean;
  maxRecordingSeconds: number;
  traceRoot: string;
}

export const DEFAULT_MAX_RECORDING_SECONDS = 300;

export function defaultTraceRoot(homeDir: string = os.homedir()): string {
  return joinPath(
    homeDir,
    "Library",
    "Application Support",
    "memorydetective",
    "traces",
  );
}

/**
 * Pure: read the security flags from an env-like object. Threaded as
 * a parameter for testability; production callers omit it and get
 * `process.env`.
 *
 * Parse rules:
 *
 * - `MEMORYDETECTIVE_ALLOW_LAUNCH` is truthy only when the value is
 *   literally `"1"`. Any other value (including `"true"` and `"yes"`)
 *   leaves it off, to keep the gate explicit.
 *
 * - `MEMORYDETECTIVE_MAX_RECORDING_SECONDS` accepts a positive
 *   integer string; anything else (missing, zero, negative, NaN)
 *   falls back to the default 300. The cap is bounded at 3600s (1h)
 *   to prevent obviously-bad configs from disabling the gate via
 *   absurd values.
 *
 * - `MEMORYDETECTIVE_TRACE_ROOT` accepts any non-empty string; empty
 *   or missing values fall back to the default location.
 */
export function getSecurityFlags(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir(),
): SecurityFlags {
  // v1.17 B-03: accept the strtobool truthy set.
  const allowLaunch = parseBooleanEnv(
    env.MEMORYDETECTIVE_ALLOW_LAUNCH,
    false,
    "MEMORYDETECTIVE_ALLOW_LAUNCH",
  );

  const rawMax = env.MEMORYDETECTIVE_MAX_RECORDING_SECONDS;
  let maxRecordingSeconds = DEFAULT_MAX_RECORDING_SECONDS;
  if (rawMax != null && rawMax !== "") {
    const parsed = Number.parseInt(rawMax, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxRecordingSeconds = Math.min(parsed, 3600);
    }
  }

  const rawRoot = env.MEMORYDETECTIVE_TRACE_ROOT;
  const traceRoot =
    rawRoot != null && rawRoot.length > 0 ? rawRoot : defaultTraceRoot(homeDir);

  return { allowLaunch, maxRecordingSeconds, traceRoot };
}

/**
 * Build the error message returned when `bootAndLaunchForLeakInvestigation`
 * is invoked without `MEMORYDETECTIVE_ALLOW_LAUNCH=1`. Exposed as a
 * named export so the same wording is used everywhere (and so the
 * unit tests can assert on it).
 */
export const ALLOW_LAUNCH_REQUIRED_MESSAGE =
  "bootAndLaunchForLeakInvestigation requires MEMORYDETECTIVE_ALLOW_LAUNCH=1 in the environment, because this tool executes xcodebuild + xcrun simctl launch against the host. Set the env var only when you trust the inputs (workspace/project paths and bundle ids) the agent will pass.";

/**
 * Build the error message returned when `recordTimeProfile` is asked
 * for a duration above the cap.
 */
export function maxRecordingExceededMessage(
  requested: number,
  cap: number,
): string {
  return (
    `recordTimeProfile durationSec=${requested} exceeds the configured cap of ${cap}s ` +
    `(MEMORYDETECTIVE_MAX_RECORDING_SECONDS). Lower durationSec, or raise the cap with the env var.`
  );
}
