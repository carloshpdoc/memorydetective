/**
 * Thin wrappers around `xcrun simctl` for booting, installing, and launching
 * iOS apps on the iOS Simulator. Used by `bootAndLaunchForLeakInvestigation`
 * to set up a leak-investigation environment with `MallocStackLogging=1`.
 *
 * Design notes:
 * - All operations are idempotent where possible (boot ignores "already booted",
 *   launch uses --terminate-running-process to atomically replace any prior instance).
 * - Env vars are propagated to the child via the `SIMCTL_CHILD_*` prefix
 *   convention enforced by simctl. The caller passes plain `MallocStackLogging=1`
 *   and we prefix it before invoking simctl.
 */

import { runCommand } from "./exec.js";

export interface SimulatorDevice {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | string;
  /** OS runtime, e.g. "iOS 17.5" or "iOS-17-5". */
  runtime: string;
}

interface SimctlListJson {
  devices: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Find the first booted simulator. Returns null when none are booted.
 * Used as a fallback when the caller doesn't specify a simulator.
 */
export async function findBootedSimulator(): Promise<SimulatorDevice | null> {
  const result = await runCommand(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xcrun simctl list failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const devices = parseSimctlDevices(result.stdout);
  return devices.find((d) => d.state === "Booted") ?? null;
}

/**
 * Find a simulator by display name (e.g. "iPhone 15"), optionally constrained
 * to a runtime version. Returns null when no match.
 *
 * @param os Either "latest" (highest available runtime), an explicit version
 *           like "17.5", or undefined (any runtime).
 */
export async function findSimulatorByName(
  name: string,
  os?: string,
): Promise<SimulatorDevice | null> {
  const result = await runCommand(
    "xcrun",
    ["simctl", "list", "devices", "--json"],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xcrun simctl list failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const devices = parseSimctlDevices(result.stdout);
  const matches = devices.filter((d) => d.name === name);
  if (matches.length === 0) return null;
  if (!os) return matches[0];
  if (os === "latest") {
    return pickLatestByRuntime(matches);
  }
  // Runtime keys come back like "com.apple.CoreSimulator.SimRuntime.iOS-17-5".
  // Match either "17.5" or "iOS 17.5" from the user.
  const normalized = os.replace(/^iOS\s+/i, "").replace(/\./g, "-");
  return matches.find((d) => d.runtime.includes(normalized)) ?? null;
}

/**
 * Boot a simulator. Idempotent: if the device is already booted, returns
 * cleanly. Then waits via `simctl bootstatus -b` until SpringBoard is ready,
 * which prevents flaky `install` calls right after boot.
 */
export async function bootSimulator(udid: string): Promise<void> {
  const boot = await runCommand("xcrun", ["simctl", "boot", udid], {
    timeoutMs: 60_000,
  });
  // CoreSimulator returns non-zero with "Unable to boot device in current state: Booted"
  // when already booted. Treat that as success.
  const alreadyBooted = /current state:\s*Booted/i.test(
    boot.stderr + boot.stdout,
  );
  if (boot.code !== 0 && !alreadyBooted) {
    throw new Error(
      `simctl boot ${udid} failed (code ${boot.code}): ${boot.stderr || boot.stdout}`,
    );
  }
  // -b blocks until the system is fully booted (SpringBoard up).
  const status = await runCommand(
    "xcrun",
    ["simctl", "bootstatus", udid, "-b"],
    { timeoutMs: 120_000 },
  );
  if (status.code !== 0) {
    throw new Error(
      `simctl bootstatus ${udid} -b failed (code ${status.code}): ${status.stderr || status.stdout}`,
    );
  }
}

/**
 * Install (or reinstall) an app bundle on a simulator. Idempotent by design;
 * simctl overwrites a prior install at the same bundle identifier.
 */
export async function installApp(udid: string, appPath: string): Promise<void> {
  const result = await runCommand(
    "xcrun",
    ["simctl", "install", udid, appPath],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `simctl install ${udid} ${appPath} failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}

export interface LaunchAppResult {
  /** Simulator-internal PID printed by simctl (NOT the host PID). */
  simPid: number;
  bundleId: string;
}

/**
 * Launch an app on a booted simulator with the given env vars and launch args.
 * Uses `--terminate-running-process` so any existing instance is replaced
 * atomically (no race where stale env vars persist).
 *
 * Env vars are propagated to the child via the `SIMCTL_CHILD_*` prefix that
 * simctl honors. Pass plain keys (e.g. `MallocStackLogging`); we prefix.
 */
export async function launchApp(
  udid: string,
  bundleId: string,
  env: Record<string, string> = {},
  launchArgs: string[] = [],
): Promise<LaunchAppResult> {
  const args = [
    "simctl",
    "launch",
    "--terminate-running-process",
    udid,
    bundleId,
    ...launchArgs,
  ];
  const prefixedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    prefixedEnv[`SIMCTL_CHILD_${k}`] = v;
  }
  const result = await runCommand("xcrun", args, {
    timeoutMs: 60_000,
    env: prefixedEnv,
  });
  if (result.code !== 0) {
    throw new Error(
      `simctl launch ${bundleId} on ${udid} failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  // simctl prints "<bundleId>: <pid>" on success.
  const simPid = parseLaunchPid(result.stdout, bundleId);
  if (simPid === null) {
    throw new Error(
      `simctl launch succeeded but PID line was not parseable. stdout: ${result.stdout}`,
    );
  }
  return { simPid, bundleId };
}

/**
 * Take a screenshot of the simulator's screen and write it to `outputPath`.
 * Wraps `xcrun simctl io <udid> screenshot <path>`.
 */
export async function takeScreenshot(
  udid: string,
  outputPath: string,
): Promise<void> {
  const result = await runCommand(
    "xcrun",
    ["simctl", "io", udid, "screenshot", outputPath],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `simctl io ${udid} screenshot failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
}

/** Pure: parse the simulator-internal PID from `simctl launch` stdout. Exposed for tests. */
export function parseLaunchPid(
  stdout: string,
  bundleId: string,
): number | null {
  const escaped = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*:\\s*(\\d+)`);
  const match = stdout.match(re);
  if (!match) return null;
  const pid = parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Pure: parse a `simctl list devices --json` payload into a flat list. Exposed for tests. */
export function parseSimctlDevices(stdout: string): SimulatorDevice[] {
  let parsed: SimctlListJson;
  try {
    parsed = JSON.parse(stdout) as SimctlListJson;
  } catch (err) {
    throw new Error(
      `simctl list devices --json output failed JSON.parse: ${(err as Error).message}`,
    );
  }
  const out: SimulatorDevice[] = [];
  if (!parsed.devices || typeof parsed.devices !== "object") {
    return out;
  }
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    if (!Array.isArray(list)) continue;
    for (const dev of list) {
      const udid = typeof dev.udid === "string" ? dev.udid : null;
      const name = typeof dev.name === "string" ? dev.name : null;
      const state = typeof dev.state === "string" ? dev.state : "Unknown";
      if (!udid || !name) continue;
      out.push({ udid, name, state, runtime });
    }
  }
  return out;
}

/**
 * Pick the simulator with the highest runtime version. Used when the caller
 * asks for `os: "latest"`. Comparison is on the digits inside the runtime
 * key (e.g. "iOS-17-5" → 17.5).
 */
function pickLatestByRuntime(
  devices: SimulatorDevice[],
): SimulatorDevice | null {
  if (devices.length === 0) return null;
  let best: SimulatorDevice = devices[0];
  let bestKey = runtimeSortKey(best.runtime);
  for (const dev of devices.slice(1)) {
    const key = runtimeSortKey(dev.runtime);
    if (key > bestKey) {
      best = dev;
      bestKey = key;
    }
  }
  return best;
}

/** Pure: produce a sortable numeric key from a runtime identifier. */
export function runtimeSortKey(runtime: string): number {
  const match = runtime.match(/(\d+)[-.](\d+)(?:[-.](\d+))?/);
  if (!match) return 0;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = match[3] ? parseInt(match[3], 10) : 0;
  return major * 10_000 + minor * 100 + patch;
}
