/**
 * Platform-specific advisories surfaced before capture-class tool calls.
 *
 * Today this only handles the macOS 26.x `task_for_pid` regression that
 * blocks `leaks --outputGraph`, `heap`, and `xctrace --template Allocations`
 * against iOS simulator processes regardless of `MallocStackLogging`.
 * Surfaced from the notelet investigation 2026-05-12, where three CLI
 * memory-introspection paths all failed with `Failed to get DYLD info for
 * task` / minimal-corpse, and even Xcode's "View Memory Graph Hierarchy"
 * failed unless Malloc Stack Logging was enabled in the scheme.
 *
 * The advisory is informational and idempotent: emitted once per server
 * instance via {@link maybeLogPlatformAdvisoryOnce} (stderr), and returned
 * as a structured `platformAdvisory` field on capture-class tool responses
 * via {@link getPlatformAdvisory} so agents can surface it to the user
 * before any tool work.
 */

import os from "node:os";

export type PlatformAdvisory = {
  issue: "macos-26-task-for-pid-broken";
  message: string;
  recommendedActions: string[];
};

const ADVISORY_MESSAGE =
  "macOS 26.x has an Apple-side kernel regression in `task_for_pid` against simulator processes. " +
  "`leaks --outputGraph`, `heap`, and `xctrace --template Allocations` all abort with " +
  "`Failed to get DYLD info for task` / minimal-corpse, even with `MallocStackLogging=1` " +
  "applied at launch. memorydetective surfaces this via `workaroundNotice` when capture " +
  "is attempted. The most reliable workaround today is to use an iOS 18 simulator runtime, " +
  "which is pre-regression. Set `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` to silence " +
  "this notice.";

const ADVISORY_ACTIONS = [
  "Install an iOS 18 simulator runtime via Xcode > Settings > Platforms > +iOS 18.x.",
  "When capturing a `.memgraph`, target the iOS 18 simulator rather than a macOS 26.x sim.",
  "If iOS 18 is not feasible, fall back to manual Xcode `Debug > View Memory Graph Hierarchy` with Malloc Stack Logging enabled in the scheme's Diagnostics tab.",
  "Set `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` in the environment to silence this notice.",
];

/**
 * Pure: returns the structured platform advisory for the current host,
 * or `null` when no advisory applies.
 *
 * The advisory is suppressed when:
 *   - Host is not macOS.
 *   - Host is macOS but not in the 26.x range (Darwin kernel 25.x).
 *   - `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` is set in the environment.
 *
 * Conservative: when the Darwin major cannot be parsed, returns `null`
 * (no advisory) rather than emitting a false positive. The macOS 27.x case
 * (Darwin 26.x) is also `null` pending verification of whether Apple
 * shipped a kernel fix; reopen this helper when 27.x lands.
 *
 * @param env - Environment lookup (defaults to `process.env`).
 *              Threaded as a parameter for testability.
 * @param osPlatform - `os.platform()` value (defaults to live).
 * @param osRelease - `os.release()` value (defaults to live).
 */
export function getPlatformAdvisory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  osPlatform: () => NodeJS.Platform = os.platform,
  osRelease: () => string = os.release,
): PlatformAdvisory | null {
  if (env.MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY === "1") return null;
  if (osPlatform() !== "darwin") return null;
  const release = osRelease();
  const majorStr = release.split(".")[0];
  const major = Number.parseInt(majorStr, 10);
  if (!Number.isFinite(major)) return null;
  // Darwin 25.x kernel ships with macOS 26.x. Darwin 24.x = macOS 25 / Sequoia
  // (no regression). Darwin 26.x = macOS 27 (verification pending; no advisory
  // until confirmed).
  if (major !== 25) return null;
  return {
    issue: "macos-26-task-for-pid-broken",
    message: ADVISORY_MESSAGE,
    recommendedActions: ADVISORY_ACTIONS,
  };
}

let advisoryLoggedThisInstance = false;

/**
 * Side-effecting: emits the platform advisory to stderr on the FIRST call
 * per server instance, then no-ops on subsequent calls. Safe to call at
 * the top of every capture-class tool.
 *
 * The once-per-instance flag is module-level so it survives across tool
 * calls within the same server process. Tests can reset via
 * {@link resetPlatformAdvisoryFlagForTests}.
 */
export function maybeLogPlatformAdvisoryOnce(
  advisory: PlatformAdvisory | null,
  writer: (line: string) => void = (line) => process.stderr.write(line),
): void {
  if (advisoryLoggedThisInstance) return;
  if (advisory == null) return;
  writer(`[memorydetective] platform advisory: ${advisory.message}\n`);
  advisoryLoggedThisInstance = true;
}

/** Test-only: reset the once-per-instance flag. */
export function resetPlatformAdvisoryFlagForTests(): void {
  advisoryLoggedThisInstance = false;
}
