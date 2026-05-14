import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
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
