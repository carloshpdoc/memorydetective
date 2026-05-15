/**
 * `recordViaInstrumentsApp`: open Instruments.app, prompt the user to
 * record + save, watch a directory for the resulting `.trace` bundle.
 * v1.16 item G.
 *
 * The macOS 26.x escape hatch. `xcrun xctrace record` is broken on this
 * OS (the regression we documented in v1.14: `--time-limit` ignored,
 * wedge, partial bundle that fails template export). Instruments.app's
 * GUI still produces valid `.trace` bundles. Until Apple fixes the CLI,
 * the only automated path on macOS 26.x sims is "open Instruments,
 * pick a template, hit Record, Stop, Save" - and we wrap that.
 *
 * Why not full AppleScript automation? Instruments.app's AppleScript
 * surface is minimal (queries on the `document` class only, no verbs
 * for start/stop/select-template). Documented in the .sdef file at
 * `Xcode.app/Contents/Applications/Instruments.app/Contents/Resources/
 * Instruments.sdef`. We can query open document file URLs but cannot
 * programmatically drive recording. The user-in-loop step stays.
 */

import { z } from "zod";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { spawn } from "node:child_process";
import { getSecurityFlags } from "../runtime/securityFlags.js";
import { inspectTrace, type InspectTraceResult } from "./inspectTrace.js";

export const recordViaInstrumentsAppSchema = z.object({
  template: z
    .string()
    .default("Time Profiler")
    .describe(
      "The Instruments template the user should pick after the app launches. Surfaced in the response's instructions array. Default 'Time Profiler'. Common alternatives: 'Allocations', 'Animation Hitches', 'Leaks', 'Energy Log', 'Network Profile'.",
    ),
  watchDir: z
    .string()
    .optional()
    .describe(
      "Directory to watch for the saved `.trace` bundle. When omitted, defaults to $MEMORYDETECTIVE_TRACE_ROOT (typically `~/Library/Application Support/memorydetective/traces`). The directory is created if it does not exist.",
    ),
  timeoutSec: z
    .number()
    .int()
    .positive()
    .max(3600)
    .default(600)
    .describe(
      "Maximum seconds to wait for the user to save a `.trace` before returning a timeout. Default 600 (10 minutes). Capped at 3600 (1 hour).",
    ),
  preexistingTraces: z
    .array(z.string())
    .optional()
    .describe(
      "Absolute paths to `.trace` bundles already in `watchDir`. The watcher excludes these so it only matches NEW files. When omitted, the watcher snapshots the directory at start. Optional override for callers who want explicit control.",
    ),
});

export type RecordViaInstrumentsAppInput = z.infer<
  typeof recordViaInstrumentsAppSchema
>;

export interface RecordViaInstrumentsAppResult {
  ok: boolean;
  /** Absolute path to the newly-saved `.trace` bundle. Empty when timed out. */
  tracePath: string;
  watchDir: string;
  /** Step-by-step instructions to show the user before they interact with Instruments. */
  instructions: string[];
  /** True when the watcher gave up before finding a new `.trace`. */
  timedOut?: boolean;
  /** Wall-clock seconds the user spent recording (start of watcher to detection). */
  elapsedSec: number;
  /** Chained inspectTrace summary when the recording was found AND was readable. */
  inspection?: InspectTraceResult;
  /** Plain-English diagnosis (success vs timeout vs unreadable). */
  diagnosis: string;
}

/**
 * Pure: snapshot the set of `.trace` bundle names currently in `dir`.
 * Used as the "existing files" baseline so the watcher only matches
 * NEW traces. Exported for testing.
 */
export function snapshotTracesInDir(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const out = new Set<string>();
    for (const e of entries) {
      if (!e.name.endsWith(".trace")) continue;
      out.add(joinPath(dir, e.name));
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Pure: given the set of trace paths now in `dir` and the baseline
 * snapshot, return paths that are NEW (in current but not in baseline).
 * The order is alphabetical for determinism. Exported for testing.
 */
export function detectNewTraces(
  current: Set<string>,
  baseline: Set<string>,
): string[] {
  const fresh: string[] = [];
  for (const path of current) {
    if (!baseline.has(path)) fresh.push(path);
  }
  return fresh.sort();
}

/**
 * Pure: given a candidate `.trace` bundle path and the current time
 * (in ms since epoch), decide whether the bundle has been "stable" for
 * at least `stableForMs` (the user has finished saving). Returns false
 * when the path does not exist or stat fails. Exported for testing.
 */
export function isStable(
  candidatePath: string,
  nowMs: number,
  stableForMs: number,
  statFn: (p: string) => { mtimeMs: number } = (p) => statSync(p),
): boolean {
  try {
    if (!existsSync(candidatePath)) return false;
    const s = statFn(candidatePath);
    return nowMs - s.mtimeMs >= stableForMs;
  } catch {
    return false;
  }
}

/**
 * Pure: build the step-by-step instruction text the response surfaces.
 * Exported for testing.
 */
export function buildInstructions(template: string, watchDir: string): string[] {
  return [
    `Instruments.app is opening. Wait for the template chooser to appear.`,
    `Pick the **${template}** template from the chooser (if it does not show, File > New > pick the template).`,
    `Choose the target device + app from the toolbar (top-left in the Instruments window).`,
    `Press the **Record** button (red circle). Drive the scenario you want to capture.`,
    `Press **Stop** when finished.`,
    `**File > Save As** the trace to \`${watchDir}\` (this MCP is watching that directory).`,
    `Once saved, this tool detects the new \`.trace\` bundle (within ~10 seconds) and returns its path.`,
  ];
}

/**
 * Spawn `open -a Instruments` fire-and-forget. v1.16. Returns immediately;
 * Instruments.app launch takes a few seconds and the user interacts with
 * it independently of the watcher loop.
 */
function openInstrumentsApp(): void {
  try {
    const child = spawn("open", ["-a", "Instruments"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // The watcher loop will still poll; surfacing the error here would
    // bias toward false-negatives if the open command exited non-zero for
    // a reason that doesn't actually prevent Instruments from launching
    // (e.g. it was already open).
  }
}

/**
 * Async sleep. Tests inject a faster variant; production uses real
 * setTimeout.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 5_000;
const STABLE_FOR_MS = 10_000;

export async function recordViaInstrumentsApp(
  input: RecordViaInstrumentsAppInput,
): Promise<RecordViaInstrumentsAppResult> {
  const security = getSecurityFlags();
  const watchDir = resolvePath(input.watchDir ?? security.traceRoot);
  if (!existsSync(watchDir)) {
    mkdirSync(watchDir, { recursive: true });
  }
  const template = input.template ?? "Time Profiler";
  const timeoutMs = (input.timeoutSec ?? 600) * 1000;
  const instructions = buildInstructions(template, watchDir);
  const baseline =
    input.preexistingTraces && input.preexistingTraces.length > 0
      ? new Set(input.preexistingTraces.map((p) => resolvePath(p)))
      : snapshotTracesInDir(watchDir);

  openInstrumentsApp();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = snapshotTracesInDir(watchDir);
    const fresh = detectNewTraces(current, baseline);
    // Pick the first stable new trace (oldest mtime that is also stable).
    for (const candidate of fresh) {
      if (isStable(candidate, Date.now(), STABLE_FOR_MS)) {
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        // Best-effort: chain into inspectTrace so the caller sees an
        // immediate summary. Failures here do not invalidate the
        // recording itself; we just omit the field.
        let inspection: InspectTraceResult | undefined;
        try {
          inspection = await inspectTrace({ tracePath: candidate });
        } catch {
          // Inspection failure is non-fatal.
        }
        return {
          ok: true,
          tracePath: candidate,
          watchDir,
          instructions,
          elapsedSec,
          ...(inspection ? { inspection } : {}),
          diagnosis: inspection
            ? `Captured \`${candidate}\` after ${elapsedSec}s. ${inspection.schemas.length} schemas in the TOC.`
            : `Captured \`${candidate}\` after ${elapsedSec}s. Inspect failed; pass the path to inspectTrace manually.`,
        };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const elapsedSec = Math.round((Date.now() - start) / 1000);
  return {
    ok: false,
    tracePath: "",
    watchDir,
    instructions,
    timedOut: true,
    elapsedSec,
    diagnosis: `Timed out after ${elapsedSec}s waiting for a \`.trace\` bundle to appear in \`${watchDir}\`. The user may not have saved yet, or saved to a different directory. Re-run with the correct \`watchDir\` if needed.`,
  };
}
