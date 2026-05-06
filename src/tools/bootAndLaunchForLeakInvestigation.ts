/**
 * Build, boot, install, and launch an iOS app on the iOS Simulator with
 * `MallocStackLogging=1` (and any caller-supplied env vars) applied. Returns
 * the host PID + simulator UDID + bundle id ready to chain into
 * `captureMemgraph`.
 *
 * Why this exists: `leaks --outputGraph` regressed on macOS 26.x and aborts
 * with `Failed to get DYLD info for task` when the target was not launched
 * with malloc-stack-logging in its environment. Capturing a memgraph after
 * the fact does not work; the env vars must be set at launch. This tool
 * gives users a single MCP call that produces a leak-investigable process
 * without requiring them to wire up xcodebuild + simctl manually.
 *
 * Out of scope: UI driving (Phase 3), composite snapshots (Phase 3), physical
 * iOS devices (`leaks --outputGraph` does not support them).
 */

import { z } from "zod";
import { join as joinPath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseBuildSettingsJson,
  type BuildSettings,
} from "../runtime/buildSettings.js";
import {
  bootSimulator,
  findBootedSimulator,
  findSimulatorByName,
  installApp,
  launchApp,
} from "../runtime/simctl.js";
import type { NextCallSuggestion } from "../types.js";

const simulatorSelectorSchema = z.object({
  udid: z.string().optional(),
  name: z.string().optional(),
  os: z.string().optional(),
});

export const bootAndLaunchForLeakInvestigationShape = {
  workspace: z
    .string()
    .optional()
    .describe(
      "Absolute path to a .xcworkspace. Mutually exclusive with `project`.",
    ),
  project: z
    .string()
    .optional()
    .describe(
      "Absolute path to a .xcodeproj. Mutually exclusive with `workspace`.",
    ),
  scheme: z
    .string()
    .min(1)
    .describe("Xcode scheme that builds the iOS application bundle."),
  configuration: z
    .string()
    .default("Debug")
    .describe("xcodebuild configuration. Default \"Debug\"."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Override the bundle identifier. By default it is discovered from `xcodebuild -showBuildSettings`.",
    ),
  derivedDataPath: z
    .string()
    .optional()
    .describe(
      "Custom -derivedDataPath. Useful to avoid collisions when multiple investigations run in parallel.",
    ),
  simulator: simulatorSelectorSchema
    .optional()
    .describe(
      "Pick a simulator by `udid`, by `name` (with optional `os`), or omit to use whichever simulator is currently booted.",
    ),
  envVars: z
    .record(z.string())
    .optional()
    .describe(
      "Extra env vars to apply to the launched app (propagated via SIMCTL_CHILD_*). Default already includes MallocStackLogging=1.",
    ),
  launchArgs: z
    .array(z.string())
    .default([])
    .describe("Extra arguments passed to the app on launch."),
  buildBeforeLaunch: z
    .boolean()
    .default(true)
    .describe(
      "Run `xcodebuild build` before installing. Set false when you've already built and want to skip straight to install/launch.",
    ),
  warmupSeconds: z
    .number()
    .nonnegative()
    .max(60)
    .default(3)
    .describe(
      "How long to wait after launch before resolving the host PID. Default 3 seconds.",
    ),
} as const;

export const bootAndLaunchForLeakInvestigationSchema = z
  .object(bootAndLaunchForLeakInvestigationShape)
  .superRefine((val, ctx) => {
    const projectsCount = [val.workspace, val.project].filter(Boolean).length;
    if (projectsCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `workspace` or `project`.",
      });
    }
  });

export type BootAndLaunchForLeakInvestigationInput = z.infer<
  typeof bootAndLaunchForLeakInvestigationSchema
>;

export type LaunchState =
  | "launched"
  | "buildFailed"
  | "installFailed"
  | "launchFailed"
  | "pidNotFound"
  | "noSimulatorAvailable";

export interface BootAndLaunchForLeakInvestigationResult {
  ok: boolean;
  state: LaunchState;
  simulatorUDID?: string;
  pid?: number;
  bundleId?: string;
  appName?: string;
  appPath?: string;
  appliedEnvVars: Record<string, string>;
  steps: string[];
  warnings?: string[];
  failureReason?: string;
  suggestedNextCalls?: NextCallSuggestion[];
}

const DEFAULT_ENV_VARS: Record<string, string> = {
  MallocStackLogging: "1",
};

export async function bootAndLaunchForLeakInvestigation(
  input: BootAndLaunchForLeakInvestigationInput,
): Promise<BootAndLaunchForLeakInvestigationResult> {
  const steps: string[] = [];
  const warnings: string[] = [];
  const mergedEnv: Record<string, string> = {
    ...DEFAULT_ENV_VARS,
    ...(input.envVars ?? {}),
  };

  let udid: string;
  try {
    udid = await resolveSimulator(input, steps);
  } catch (err) {
    return {
      ok: false,
      state: "noSimulatorAvailable",
      appliedEnvVars: mergedEnv,
      steps,
      failureReason: (err as Error).message,
    };
  }

  let buildSettings: BuildSettings;
  try {
    buildSettings = await fetchBuildSettings(input, udid, steps);
  } catch (err) {
    return {
      ok: false,
      state: "buildFailed",
      simulatorUDID: udid,
      appliedEnvVars: mergedEnv,
      steps,
      failureReason: `xcodebuild -showBuildSettings: ${(err as Error).message}`,
    };
  }

  const bundleId = input.bundleId ?? buildSettings.productBundleIdentifier;
  const appPath = joinPath(
    buildSettings.builtProductsDir,
    buildSettings.wrapperName,
  );
  const appName = buildSettings.executableName;

  if (input.buildBeforeLaunch !== false) {
    try {
      await runBuild(input, udid, steps);
    } catch (err) {
      return {
        ok: false,
        state: "buildFailed",
        simulatorUDID: udid,
        bundleId,
        appName,
        appPath,
        appliedEnvVars: mergedEnv,
        steps,
        failureReason: (err as Error).message,
      };
    }
  }

  try {
    steps.push(`$ xcrun simctl boot ${udid} (idempotent) && bootstatus -b`);
    await bootSimulator(udid);
  } catch (err) {
    return {
      ok: false,
      state: "noSimulatorAvailable",
      simulatorUDID: udid,
      bundleId,
      appName,
      appPath,
      appliedEnvVars: mergedEnv,
      steps,
      failureReason: (err as Error).message,
    };
  }

  try {
    steps.push(`$ xcrun simctl install ${udid} ${appPath}`);
    await installApp(udid, appPath);
  } catch (err) {
    return {
      ok: false,
      state: "installFailed",
      simulatorUDID: udid,
      bundleId,
      appName,
      appPath,
      appliedEnvVars: mergedEnv,
      steps,
      failureReason: (err as Error).message,
    };
  }

  try {
    steps.push(
      `$ xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`,
    );
    await launchApp(udid, bundleId, mergedEnv, input.launchArgs);
  } catch (err) {
    return {
      ok: false,
      state: "launchFailed",
      simulatorUDID: udid,
      bundleId,
      appName,
      appPath,
      appliedEnvVars: mergedEnv,
      steps,
      failureReason: (err as Error).message,
    };
  }

  if (input.warmupSeconds > 0) {
    steps.push(`(warmup ${input.warmupSeconds}s)`);
    await sleep(input.warmupSeconds * 1000);
  }

  let hostPid: number | null = null;
  try {
    hostPid = await resolveHostPid(udid, appName);
  } catch (err) {
    warnings.push(
      `Host PID resolution failed: ${(err as Error).message}. The app may still be launching, or `
      + `another simulator is running the same app. Retry the call with a longer warmupSeconds, `
      + `or pass the PID explicitly to captureMemgraph.`,
    );
  }

  if (hostPid === null) {
    return {
      ok: false,
      state: "pidNotFound",
      simulatorUDID: udid,
      bundleId,
      appName,
      appPath,
      appliedEnvVars: mergedEnv,
      steps,
      warnings: warnings.length > 0 ? warnings : undefined,
      failureReason:
        "App was launched but the host process ID could not be resolved. captureMemgraph will not be able to attach by appName alone reliably.",
    };
  }

  const suggestedNextCalls: NextCallSuggestion[] = [
    {
      tool: "captureMemgraph",
      args: {
        pid: hostPid,
        output: "<absolute path ending in .memgraph>",
      },
      why: "The app was just launched with MallocStackLogging=1, which is the env var leaks --outputGraph needs on macOS 26.x. Capture the .memgraph now while the target process is still alive.",
    },
  ];

  return {
    ok: true,
    state: "launched",
    simulatorUDID: udid,
    pid: hostPid,
    bundleId,
    appName,
    appPath,
    appliedEnvVars: mergedEnv,
    steps,
    warnings: warnings.length > 0 ? warnings : undefined,
    suggestedNextCalls,
  };
}

async function resolveSimulator(
  input: BootAndLaunchForLeakInvestigationInput,
  steps: string[],
): Promise<string> {
  const sel = input.simulator;
  if (sel?.udid) {
    steps.push(`(simulator selected by udid: ${sel.udid})`);
    return sel.udid;
  }
  if (sel?.name) {
    steps.push(`$ xcrun simctl list devices --json (filter name=${sel.name})`);
    const dev = await findSimulatorByName(sel.name, sel.os);
    if (!dev) {
      throw new Error(
        `No simulator named "${sel.name}"${sel.os ? ` with os ${sel.os}` : ""}. Use \`xcrun simctl list devices\` to inspect available simulators.`,
      );
    }
    return dev.udid;
  }
  steps.push(`$ xcrun simctl list devices booted --json`);
  const booted = await findBootedSimulator();
  if (!booted) {
    throw new Error(
      "No booted simulator and no `simulator` selector provided. Either boot a simulator manually or pass `simulator: { name: \"iPhone 15\" }`.",
    );
  }
  return booted.udid;
}

async function fetchBuildSettings(
  input: BootAndLaunchForLeakInvestigationInput,
  udid: string,
  steps: string[],
): Promise<BuildSettings> {
  const args = ["-scheme", input.scheme, "-configuration", input.configuration];
  if (input.workspace) args.unshift("-workspace", input.workspace);
  else if (input.project) args.unshift("-project", input.project);
  args.push("-destination", `platform=iOS Simulator,id=${udid}`);
  if (input.derivedDataPath)
    args.push("-derivedDataPath", input.derivedDataPath);
  args.push("-showBuildSettings", "-json");
  steps.push(`$ xcodebuild ${args.join(" ")}`);
  const result = await runCommand("xcodebuild", args, {
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `xcodebuild -showBuildSettings exited ${result.code}: ${result.stderr || result.stdout}`,
    );
  }
  return parseBuildSettingsJson(result.stdout);
}

async function runBuild(
  input: BootAndLaunchForLeakInvestigationInput,
  udid: string,
  steps: string[],
): Promise<void> {
  const args: string[] = [];
  if (input.workspace) args.push("-workspace", input.workspace);
  else if (input.project) args.push("-project", input.project);
  args.push("-scheme", input.scheme);
  args.push("-configuration", input.configuration);
  args.push("-destination", `platform=iOS Simulator,id=${udid}`);
  if (input.derivedDataPath)
    args.push("-derivedDataPath", input.derivedDataPath);
  args.push("-quiet", "build");
  steps.push(`$ xcodebuild ${args.join(" ")}`);
  const result = await runCommand("xcodebuild", args, {
    timeoutMs: 30 * 60_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `xcodebuild build exited ${result.code}: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Resolve the host-side PID for an app running inside the target simulator.
 *
 * Strategy: list every host process with `ps -Ao pid,command`, then pick lines
 * whose command path includes the simulator UDID (i.e. lives under
 * `~/Library/Developer/CoreSimulator/Devices/<UDID>/...`) AND whose path ends
 * with `/<EXECUTABLE_NAME>`. This handles two cases natively:
 *   1. Multi-simulator: filtering by UDID disambiguates from same-named apps in other simulators.
 *   2. Long executable names: we match on full path, so the 15-char `comm` truncation that breaks `pgrep -x` is irrelevant.
 *
 * Returns the PID, or null when nothing matched (the typical reasons: app
 * still launching, or executable name does not appear in the path because
 * the user passed a custom override).
 */
export async function resolveHostPid(
  udid: string,
  executableName: string,
): Promise<number | null> {
  const result = await runCommand("ps", ["-Ao", "pid=,command="], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `ps -Ao failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return pickHostPidFromPs(result.stdout, udid, executableName);
}

/** Pure: filter `ps` output for the simulator's app process. Exposed for tests. */
export function pickHostPidFromPs(
  psOutput: string,
  udid: string,
  executableName: string,
): number | null {
  const exeSuffix = `/${executableName}`;
  const matches: number[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.includes(udid)) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const command = trimmed.slice(spaceIdx + 1).trim();
    // The actual binary path is the first token of the command (handles cases
    // where the OS appends launch arguments).
    const firstToken = command.split(/\s+/)[0];
    if (!firstToken.endsWith(exeSuffix)) continue;
    const pid = parseInt(pidStr, 10);
    if (Number.isInteger(pid) && pid > 0) {
      matches.push(pid);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // Multiple host processes for the same UDID + executable shouldn't happen
    // in practice (only one app instance per simulator), but if it does, the
    // safest move is to return null and surface the ambiguity rather than
    // attach to a stale PID.
    return null;
  }
  return matches[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
