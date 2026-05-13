import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { runCommand, type CommandResult } from "../runtime/exec.js";
import type { NextCallSuggestion } from "../types.js";
import {
  getPlatformAdvisory,
  maybeLogPlatformAdvisoryOnce,
  type PlatformAdvisory,
} from "../runtime/platformCheck.js";

/** Base shape — exposed so the MCP layer can read `.shape`. */
export const captureMemgraphShape = {
  pid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("PID of the running process. Mutually exclusive with `appName`."),
  appName: z
    .string()
    .optional()
    .describe(
      "App name (resolves to PID via `pgrep -x`). Mutually exclusive with `pid`.",
    ),
  output: z
    .string()
    .min(1)
    .describe(
      "Absolute path where the `.memgraph` should be written. Must end in `.memgraph`.",
    ),
} as const;

export const captureMemgraphSchema = z
  .object(captureMemgraphShape)
  .superRefine((val, ctx) => {
    const targets = [val.pid, val.appName].filter(
      (v) => v !== undefined,
    ).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `pid` or `appName`.",
      });
    }
    if (!val.output.endsWith(".memgraph")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "`output` must end in `.memgraph`.",
      });
    }
  });

export type CaptureMemgraphInput = z.infer<typeof captureMemgraphSchema>;

export type WorkaroundIssue =
  | "minimal-corpse"
  | "permission-denied"
  | "leaks-not-found"
  | "transient";

export interface WorkaroundNotice {
  /** Stable identifier the LLM agent can branch on. */
  issue: WorkaroundIssue;
  /** Human-readable explanation of what went wrong. */
  message: string;
  /** Concrete next steps the agent can take to recover. */
  fallbacks: string[];
}

export interface CaptureMemgraphResult {
  ok: boolean;
  pid: number;
  /** Present when `ok:true`. Absent on failure paths. */
  output?: string;
  /**
   * Limitation reminder. Surfaced so callers stay aware of the device-physical caveat.
   */
  notice: string;
  /** Non-fatal observations (e.g. MallocStackLogging not active → backtraces will be incomplete). */
  warnings?: string[];
  /** Structured failure info when `ok:false`. */
  workaroundNotice?: WorkaroundNotice;
  /** HATEOAS-style hints to recover via other tools. Populated on failure paths. */
  suggestedNextCalls?: NextCallSuggestion[];
  /** Raw stderr from `leaks` when capture failed. */
  stderr?: string;
  /**
   * Present on hosts where a platform-side regression affects this capture
   * (today: macOS 26.x `task_for_pid` kernel regression). Agents should
   * surface this to the user before assuming a `workaroundNotice` is a
   * configuration issue specific to their setup.
   */
  platformAdvisory?: PlatformAdvisory;
}

const PHYSICAL_DEVICE_NOTICE =
  "Note: `leaks --outputGraph` only works for processes running on the local Mac (which includes iOS simulators). It does not work for physical iOS devices, use Xcode's Memory Graph button + File > Export Memory Graph for those.";

const MINIMAL_CORPSE_RE =
  /Failed to get DYLD info for task|minimal corpse|task_create_corpse/i;
const PERMISSION_DENIED_RE =
  /Operation not permitted|task_for_pid.*failed|insufficient privileges/i;
const LEAKS_NOT_FOUND_CODE = 127;

const MINIMAL_CORPSE_MESSAGE =
  "leaks --outputGraph could not introspect the target process (known regression on macOS 26.x). The target's task port did not yield DYLD info, so leaks aborted before writing the graph.";

const MINIMAL_CORPSE_FALLBACKS = [
  "Relaunch the app with MallocStackLogging=1 in its environment, then retry capture (Phase 2 tool: bootAndLaunchForLeakInvestigation).",
  "Open Xcode > Debug > View Memory Graph Hierarchy on the running process, then File > Export Memory Graph to save a .memgraph manually.",
  "Record an Allocations trace via recordTimeProfile (template Allocations) and inspect with analyzeAllocations. Not full cycle detection, but reveals top live classes.",
];

const PERMISSION_DENIED_MESSAGE =
  "leaks could not attach to the target process (insufficient privileges or SIP). The capture cannot proceed without elevated access.";

const PERMISSION_DENIED_FALLBACKS = [
  "Run the calling shell with sudo, or grant Developer Tools access to the parent process in System Settings > Privacy & Security.",
  "Confirm the target process is signed with a debuggable entitlement (DEBUG build, not Release).",
  "Use Xcode's Memory Graph button while the app is attached to the debugger.",
];

const LEAKS_NOT_FOUND_MESSAGE =
  "The `leaks` binary was not found in PATH. It ships with the macOS Command Line Tools.";

const LEAKS_NOT_FOUND_FALLBACKS = [
  "Install Xcode Command Line Tools: xcode-select --install",
  "Verify with: which leaks",
];

const TRANSIENT_MESSAGE =
  "leaks --outputGraph failed twice in a row with no recognized error pattern. This may be a transient timing issue or a process that exited mid-capture.";

const TRANSIENT_FALLBACKS = [
  "Confirm the target process is still running (ps -p <pid>) and retry.",
  "Capture a few seconds later, after the app finishes any heavy work.",
  "Fall back to an Allocations trace via recordTimeProfile if leaks keeps failing.",
];

/** Suggested calls that recover from a captureMemgraph failure via xctrace Allocations. */
function buildAllocationsFallbackSuggestions(): NextCallSuggestion[] {
  return [
    {
      tool: "recordTimeProfile",
      args: {
        template: "Allocations",
        simulatorId: "<UDID from listTraceDevices>",
        attachAppName: "<app name>",
        durationSec: 30,
        output: "<absolute path ending in .trace>",
      },
      why: "Record an Allocations trace to identify top live classes when leaks --outputGraph cannot capture a memgraph. Use listTraceDevices first to find the simulator UDID.",
    },
    {
      tool: "analyzeAllocations",
      args: { tracePath: "<output from recordTimeProfile>" },
      why: "Parse the Allocations trace for top allocators by bytes and persistent live counts. Not full cycle detection, but reveals leak suspects.",
    },
  ];
}

/** Resolve an app name to a PID via `pgrep -x`. Errors when zero or multiple matches. */
export async function resolveAppNameToPid(appName: string): Promise<number> {
  const result = await runCommand("pgrep", ["-x", appName], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`No running process named "${appName}".`);
  }
  const pids = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) {
    throw new Error(`pgrep returned no PIDs for "${appName}".`);
  }
  if (pids.length > 1) {
    throw new Error(
      `Multiple processes match "${appName}": ${pids.join(", ")}. Pass \`pid\` directly to disambiguate.`,
    );
  }
  return pids[0];
}

/**
 * Inspect a running process's environment block via `ps eww <pid>`.
 * Returns true when MallocStackLogging is set, false otherwise. Returns null
 * when the env cannot be read (e.g. process exited or restricted).
 */
export async function detectMallocStackLogging(
  pid: number,
): Promise<boolean | null> {
  try {
    const result = await runCommand("ps", ["eww", String(pid)], {
      timeoutMs: 5_000,
    });
    if (result.code !== 0) return null;
    return /\bMallocStackLogging=/.test(result.stdout);
  } catch {
    return null;
  }
}

/** Pure: classify a leaks failure into a stable issue id, given exit + stderr. */
export function classifyLeaksFailure(
  result: CommandResult,
): WorkaroundIssue | null {
  if (result.code === 0 || result.code === 1) return null;
  if (result.code === LEAKS_NOT_FOUND_CODE) return "leaks-not-found";
  const stderr = result.stderr || "";
  if (MINIMAL_CORPSE_RE.test(stderr)) return "minimal-corpse";
  if (PERMISSION_DENIED_RE.test(stderr)) return "permission-denied";
  return "transient";
}

function buildWorkaround(issue: WorkaroundIssue): WorkaroundNotice {
  switch (issue) {
    case "minimal-corpse":
      return {
        issue,
        message: MINIMAL_CORPSE_MESSAGE,
        fallbacks: MINIMAL_CORPSE_FALLBACKS,
      };
    case "permission-denied":
      return {
        issue,
        message: PERMISSION_DENIED_MESSAGE,
        fallbacks: PERMISSION_DENIED_FALLBACKS,
      };
    case "leaks-not-found":
      return {
        issue,
        message: LEAKS_NOT_FOUND_MESSAGE,
        fallbacks: LEAKS_NOT_FOUND_FALLBACKS,
      };
    case "transient":
      return {
        issue,
        message: TRANSIENT_MESSAGE,
        fallbacks: TRANSIENT_FALLBACKS,
      };
  }
}

async function runLeaksOnce(
  pid: number,
  output: string,
): Promise<CommandResult> {
  return runCommand("leaks", ["--outputGraph", output, String(pid)], {
    timeoutMs: 2 * 60_000,
  });
}

export async function captureMemgraph(
  input: CaptureMemgraphInput,
): Promise<CaptureMemgraphResult> {
  const platformAdvisory = getPlatformAdvisory();
  maybeLogPlatformAdvisoryOnce(platformAdvisory);

  const output = resolvePath(input.output);
  const outDir = dirname(output);
  if (!existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}`);
  }
  const pid =
    input.pid ??
    (input.appName ? await resolveAppNameToPid(input.appName) : 0);
  if (!pid) throw new Error("Could not determine a PID to capture.");

  const warnings: string[] = [];
  const hasMallocLogging = await detectMallocStackLogging(pid);
  if (hasMallocLogging === false) {
    warnings.push(
      "MallocStackLogging is not active on the target process. The .memgraph will lack allocation backtraces, which limits findRetainers/reachableFromCycle precision. Relaunch the app with MallocStackLogging=1 (Phase 2: bootAndLaunchForLeakInvestigation) for full fidelity.",
    );
  }

  let result = await runLeaksOnce(pid, output);
  let issue = classifyLeaksFailure(result);

  // Single retry on transient failures only. Deterministic issues (minimal-corpse,
  // permission-denied, leaks-not-found) won't change between attempts.
  if (issue === "transient") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await runLeaksOnce(pid, output);
    issue = classifyLeaksFailure(result);
  }

  if (issue) {
    const workaroundNotice = buildWorkaround(issue);
    const suggestedNextCalls =
      issue === "minimal-corpse" || issue === "transient"
        ? buildAllocationsFallbackSuggestions()
        : undefined;
    return {
      ok: false,
      pid,
      notice: PHYSICAL_DEVICE_NOTICE,
      ...(warnings.length > 0 ? { warnings } : {}),
      workaroundNotice,
      ...(suggestedNextCalls ? { suggestedNextCalls } : {}),
      stderr: result.stderr || result.stdout,
      ...(platformAdvisory ? { platformAdvisory } : {}),
    };
  }

  // `leaks --outputGraph` writes the file even when leaks are present (exit 1).
  if (!existsSync(output)) {
    throw new Error(
      `leaks reported success but output file is missing: ${output}`,
    );
  }
  return {
    ok: true,
    pid,
    output,
    notice: PHYSICAL_DEVICE_NOTICE,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(platformAdvisory ? { platformAdvisory } : {}),
  };
}
