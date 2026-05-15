import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  resolve as resolvePath,
  dirname,
  isAbsolute as isAbsolutePath,
  join as joinPath,
} from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  getSecurityFlags,
  maxRecordingExceededMessage,
} from "../runtime/securityFlags.js";
import { getPlatformAdvisory } from "../runtime/platformCheck.js";

/**
 * Base shape, exposed so the MCP layer can read `.shape` (ZodEffects from
 * `.superRefine()` doesn't expose shape).
 */
export const recordTimeProfileShape = {
  template: z
    .string()
    .default("Time Profiler")
    .describe(
      "xctrace template name (e.g. \"Time Profiler\", \"Animation Hitches\", \"Allocations\"). Default \"Time Profiler\".",
    ),
  deviceId: z
    .string()
    .optional()
    .describe("UDID of a physical device. Mutually exclusive with `simulatorId`."),
  simulatorId: z
    .string()
    .optional()
    .describe(
      "UDID of a simulator. Mutually exclusive with `deviceId`. Use `listTraceDevices` to find UDIDs.",
    ),
  attachAppName: z
    .string()
    .optional()
    .describe(
      "Attach to a running app by name (e.g. \"DemoApp\"). Mutually exclusive with `attachPid` and `launchBundleId`.",
    ),
  attachPid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Attach by PID. Mutually exclusive with `attachAppName` and `launchBundleId`."),
  launchBundleId: z
    .string()
    .optional()
    .describe(
      "Launch app by bundle id and start recording at launch. Mutually exclusive with `attachAppName` and `attachPid`.",
    ),
  durationSec: z
    .number()
    .int()
    .positive()
    .max(600)
    .default(90)
    .describe("Recording duration in seconds (default 90, max 600)."),
  output: z
    .string()
    .min(1)
    .describe(
      "Absolute path where the resulting `.trace` bundle should be written. Must end in `.trace`.",
    ),
} as const;

export const recordTimeProfileSchema = z
  .object(recordTimeProfileShape)
  .superRefine((val, ctx) => {
    const targets = [val.deviceId, val.simulatorId].filter(Boolean).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `deviceId` or `simulatorId`.",
      });
    }
    const attaches = [val.attachAppName, val.attachPid, val.launchBundleId].filter(
      (v) => v !== undefined,
    ).length;
    if (attaches !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of `attachAppName`, `attachPid`, or `launchBundleId`.",
      });
    }
    if (!val.output.endsWith(".trace")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "`output` must end in `.trace`.",
      });
    }
  });

export type RecordTimeProfileInput = z.infer<typeof recordTimeProfileSchema>;

export interface RecordingTimeoutWorkaroundNotice {
  issue: "xctrace-time-limit-ignored";
  message: string;
  fallbacks: string[];
}

export interface RecordTimeProfileResult {
  ok: boolean;
  command: string;
  output: string;
  durationSec: number;
  template: string;
  stderr?: string;
  /**
   * Present and `true` when xctrace ignored `--time-limit` and the external
   * timeout wrapper had to SIGINT it. The `.trace` bundle on disk MAY be
   * usable: xctrace flushes the active template on SIGINT, but if the
   * escalation path had to send SIGKILL (after the graceful window) the
   * trace may be missing template metadata and `analyzeTimeProfile` will
   * fail to export it. Inspect `workaroundNotice` for the recovery path.
   */
  recordingTimedOut?: boolean;
  /**
   * Present when `recordingTimedOut` is true. Documents the
   * `xctrace --time-limit` regression observed on macOS 26.x simulators
   * and the practical mitigations.
   */
  workaroundNotice?: RecordingTimeoutWorkaroundNotice;
  /**
   * v1.14+. `true` when, after a timed-out recording, the wrapper invoked
   * `open -a Instruments <tracePath>` so the user can inspect the partial
   * trace in the GUI (Instruments.app on macOS 26.x can still open and
   * symbolicate traces the CLI export path rejects). Opt-in via
   * `MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS=1`. `false` when the env flag is
   * unset (default) or the trace bundle is missing from disk. Absent when
   * the recording did not time out.
   */
  openedInInstrumentsApp?: boolean;
}

const XCTRACE_TIMEOUT_MESSAGE =
  "xctrace did not exit when `--time-limit` elapsed (a known regression on some macOS 26.x simulators). memorydetective sent SIGINT after a grace window and waited up to 10s for xctrace to flush the trace cleanly. The `.trace` bundle at `output` may still be readable; if `analyzeTimeProfile` later reports a missing-template export error, the SIGKILL escalation fired before the flush completed and the trace is partial.";

const XCTRACE_TIMEOUT_FALLBACKS = [
  "Try recording on an iOS 18 simulator runtime, which does not exhibit the `--time-limit` ignore bug.",
  "Shorten `durationSec` to 30s or less; the ignore behavior is more common on long recordings.",
  "If `analyzeTimeProfile` fails on the partial `.trace`, re-record after restarting the simulator (`xcrun simctl shutdown <udid> && xcrun simctl boot <udid>`).",
];

/**
 * Grace window beyond `--time-limit` before the wrapper SIGINTs xctrace.
 * 30s matches the budget used by `analyzeTimeProfile` for export overhead
 * and keeps the loop responsive when xctrace IS respecting the time limit.
 */
const XCTRACE_TIMEOUT_GRACE_SEC = 30;

/**
 * Time to wait for xctrace to flush the trace after SIGINT before escalating
 * to SIGKILL. 10s is generous: xctrace's normal post-`--time-limit` shutdown
 * takes 2-5 seconds in practice. SIGKILL leaves the trace partial (missing
 * template metadata), but is the only way to guarantee the wrapper unblocks
 * when xctrace is wedged.
 */
const XCTRACE_GRACEFUL_KILL_MS = 10_000;

/**
 * v1.14 item H. Pre-flight probe for the xctrace `--time-limit` ignore
 * regression on macOS 26.x simulators. Runs a 2-second test recording
 * against the same target the user requested. If the probe completes
 * cleanly inside its wrapper window, the user's full recording is
 * expected to behave; if the probe times out, we bail before spending
 * the user's full `durationSec` + 30s grace window on a wedge.
 *
 * Returns `{ healthy: true }` when the probe exited cleanly. Returns
 * `{ healthy: false, reason }` when the probe timed out OR when xctrace
 * exited non-zero (the wedge does not always produce timedOut=true;
 * sometimes xctrace exits early with a misleading error code when the
 * sim is in a bad state). The recordTimeProfile flow treats either as
 * "skip the full recording, return workaroundNotice now".
 *
 * Pre-flight is gated to ATTACH mode only. The `--launch` path would
 * start the user's app a second time (probe launch + full-recording
 * launch), losing first-launch state. For `--launch` callers we skip
 * the probe and fall back to the existing 70s timeout wrapper.
 *
 * Exported so the gating logic can be unit-tested without spawning
 * xctrace.
 */
export interface PreflightResult {
  healthy: boolean;
  reason?: string;
  durationMs: number;
}

const PREFLIGHT_TIME_LIMIT_SEC = 2;
const PREFLIGHT_WRAPPER_TIMEOUT_MS = (PREFLIGHT_TIME_LIMIT_SEC + 6) * 1000;
const PREFLIGHT_GRACEFUL_KILL_MS = 2000;

/**
 * Returns true when a pre-flight probe should run before the user's
 * actual recording. v1.14 item H.
 *
 * - `MEMORYDETECTIVE_PREFLIGHT_XCTRACE=1` forces preflight on.
 * - `MEMORYDETECTIVE_PREFLIGHT_XCTRACE=0` forces it off.
 * - Default: auto-enabled when host is macOS 26.x AND target is a
 *   simulator AND attach mode (`--attach`, not `--launch`). The set of
 *   configurations where the regression is known to fire.
 *
 * The `osPlatform` and `osRelease` params are threaded through to
 * `getPlatformAdvisory` so tests can simulate non-macOS-26 hosts even
 * when running on a real macOS 26.x machine.
 */
export function shouldPreflightXctrace(
  input: RecordTimeProfileInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  osPlatform?: () => NodeJS.Platform,
  osRelease?: () => string,
): boolean {
  const explicit = env.MEMORYDETECTIVE_PREFLIGHT_XCTRACE;
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  // Auto: only when the known-broken combination applies.
  const onMacOS26 = getPlatformAdvisory(env, osPlatform, osRelease) != null;
  const isSimTarget = !!input.simulatorId && !input.deviceId;
  const isAttachMode = !input.launchBundleId;
  return onMacOS26 && isSimTarget && isAttachMode;
}

/**
 * Runs the 2-second probe. Reuses runCommand's timeout wrapper with the
 * same SIGINT-first / SIGKILL-fallback shape that the full recording
 * uses, so the probe's salvage behavior matches the real path.
 *
 * The output bundle is placed at `<output>.preflight` to keep it
 * recognizable in cleanup tools and not collide with the user's actual
 * output path.
 */
export async function preflightXctraceRecord(
  input: RecordTimeProfileInput,
  resolvedOutput: string,
): Promise<PreflightResult> {
  const probeOutput = `${resolvedOutput}.preflight`;
  const probeInput: RecordTimeProfileInput = {
    ...input,
    durationSec: PREFLIGHT_TIME_LIMIT_SEC,
    output: probeOutput,
  };
  const args = buildXctraceArgs(probeInput);
  const probeOutDir = dirname(probeOutput);
  if (!existsSync(probeOutDir)) {
    mkdirSync(probeOutDir, { recursive: true });
  }
  const start = Date.now();
  const result = await runCommand("xcrun", args, {
    timeoutMs: PREFLIGHT_WRAPPER_TIMEOUT_MS,
    timeoutSignal: "SIGINT",
    gracefulKillAfterMs: PREFLIGHT_GRACEFUL_KILL_MS,
  });
  const durationMs = Date.now() - start;
  if (result.timedOut) {
    return {
      healthy: false,
      reason: `Pre-flight probe wedged: 2s recording exceeded ${PREFLIGHT_WRAPPER_TIMEOUT_MS / 1000}s wrapper window without exiting. The same wedge will hit the full recording.`,
      durationMs,
    };
  }
  if (result.code !== 0) {
    return {
      healthy: false,
      reason: `Pre-flight probe exited non-zero (code ${result.code}): ${(result.stderr || result.stdout || "").slice(0, 200)}`,
      durationMs,
    };
  }
  return { healthy: true, durationMs };
}

/**
 * v1.14 item J. When a `recordTimeProfile` call times out, optionally
 * launch the partial `.trace` in Instruments.app so the user has a GUI
 * escape hatch. Returns `true` when `open -a Instruments <tracePath>`
 * was spawned, `false` otherwise.
 *
 * Gated on `MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS=1` to avoid spamming
 * the user's GUI on unattended runs and CI. Also requires the trace
 * bundle to exist on disk (xctrace's SIGINT path may have failed to
 * write anything).
 *
 * The `open` invocation is fire-and-forget: `detached: true` + `unref()`
 * so the recording tool returns immediately. Failures to launch
 * Instruments.app are swallowed; the user is no worse off than without
 * the flag enabled.
 *
 * Exported so the env-gating logic can be tested without spawning
 * Instruments in test runs.
 */
export function maybeOpenInInstruments(tracePath: string): boolean {
  if (process.env.MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS !== "1") return false;
  if (!existsSync(tracePath)) return false;
  try {
    const child = spawn("open", ["-a", "Instruments", tracePath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Pure: build the xctrace argv for the given input. Exposed for testing. */
export function buildXctraceArgs(input: RecordTimeProfileInput): string[] {
  const args = ["xctrace", "record", "--template", input.template];
  if (input.deviceId) args.push("--device", input.deviceId);
  else if (input.simulatorId) args.push("--device", input.simulatorId);
  if (input.attachAppName) args.push("--attach", input.attachAppName);
  else if (input.attachPid) args.push("--attach", String(input.attachPid));
  if (input.launchBundleId) {
    args.push("--launch", "--", input.launchBundleId);
  }
  args.push("--time-limit", `${input.durationSec}s`);
  args.push("--output", resolvePath(input.output));
  return args;
}

export async function recordTimeProfile(
  input: RecordTimeProfileInput,
): Promise<RecordTimeProfileResult> {
  const security = getSecurityFlags();
  // Cap the recording duration so an unattended agent does not pile up
  // multi-GB traces. Default cap is 300s (5 min); override via
  // MEMORYDETECTIVE_MAX_RECORDING_SECONDS, capped at 3600s.
  if (input.durationSec > security.maxRecordingSeconds) {
    throw new Error(
      maxRecordingExceededMessage(input.durationSec, security.maxRecordingSeconds),
    );
  }
  // Resolve the output path against TRACE_ROOT when relative, so the
  // default behavior places traces in a predictable location that
  // cleanup_traces can manage. Absolute paths are preserved verbatim
  // for backwards compat with v1.8 callers that always passed absolute.
  const output = isAbsolutePath(input.output)
    ? resolvePath(input.output)
    : joinPath(security.traceRoot, input.output);
  const outDir = dirname(output);
  if (!existsSync(outDir)) {
    // Auto-create the directory for the TRACE_ROOT case so first-time
    // users do not have to mkdir manually. Same behavior whether the
    // path came from TRACE_ROOT or was an absolute path to a missing
    // parent.
    mkdirSync(outDir, { recursive: true });
  }
  // v1.14 item H. Pre-flight the xctrace `--time-limit` ignore regression
  // before spending the user's durationSec on a wedge. Gated to macOS 26.x
  // simulator targets in attach mode by default; opt-in / opt-out via
  // MEMORYDETECTIVE_PREFLIGHT_XCTRACE.
  if (shouldPreflightXctrace({ ...input, output })) {
    const probe = await preflightXctraceRecord({ ...input, output }, output);
    if (!probe.healthy) {
      return {
        ok: false,
        command: `xcrun ${buildXctraceArgs({ ...input, output }).join(" ")}`,
        output,
        durationSec: input.durationSec,
        template: input.template,
        recordingTimedOut: true,
        workaroundNotice: {
          issue: "xctrace-time-limit-ignored",
          message: `Pre-flight probe detected the xctrace wedge in ${probe.durationMs}ms. Skipping the full ${input.durationSec}s recording so you do not pay the wrapper timeout. ${probe.reason ?? ""}`,
          fallbacks: XCTRACE_TIMEOUT_FALLBACKS,
        },
      };
    }
  }
  const args = buildXctraceArgs({ ...input, output });
  // External timeout wrapper. xctrace itself receives `--time-limit Ns`, so
  // the normal exit path is xctrace finishing on its own at N seconds. The
  // wrapper here is a safety net for the macOS 26.x sim regression where
  // xctrace ignores `--time-limit` and runs indefinitely. We give it a
  // 30s grace beyond its own deadline, then SIGINT (so it flushes the
  // trace), then escalate to SIGKILL after 10s if it is still wedged.
  // SIGTERM specifically corrupts xctrace's output, so we never use it
  // here.
  const result = await runCommand("xcrun", args, {
    timeoutMs: (input.durationSec + XCTRACE_TIMEOUT_GRACE_SEC) * 1_000,
    timeoutSignal: "SIGINT",
    gracefulKillAfterMs: XCTRACE_GRACEFUL_KILL_MS,
  });
  if (result.timedOut) {
    const openedInInstrumentsApp = maybeOpenInInstruments(output);
    return {
      ok: false,
      command: `xcrun ${args.join(" ")}`,
      output,
      durationSec: input.durationSec,
      template: input.template,
      stderr: result.stderr || undefined,
      recordingTimedOut: true,
      workaroundNotice: {
        issue: "xctrace-time-limit-ignored",
        message: XCTRACE_TIMEOUT_MESSAGE,
        fallbacks: XCTRACE_TIMEOUT_FALLBACKS,
      },
      openedInInstrumentsApp,
    };
  }
  if (result.code !== 0) {
    throw new Error(
      `xctrace record failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return {
    ok: true,
    command: `xcrun ${args.join(" ")}`,
    output,
    durationSec: input.durationSec,
    template: input.template,
    stderr: result.stderr || undefined,
  };
}
