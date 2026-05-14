import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";
import type { DataStatus } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

export const analyzeHangsSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle (output of `xctrace record` with the Time Profiler or Hangs template).",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Return the top N longest hangs in the response (default 10)."),
  minDurationMs: z
    .number()
    .nonnegative()
    .default(0)
    .describe(
      "Filter out hangs shorter than this duration in milliseconds (default 0, include all). Use 250 to focus on 'real' hangs only.",
    ),
  timeRangeMs: z
    .object({
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
    })
    .optional()
    .describe(
      "Optional time-window filter. Only hangs whose `startNs` falls within `[startMs, endMs]` (milliseconds since recording start) are included. Use this to answer 'what hangs happened between t=2s and t=7s?' without re-recording.",
    ),
  topFramesByHangStartNs: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Optional supplemental map from a hang's `startNs` (as a string) to the top frame seen during that hang. When provided, each matching hang in `top[]` is enriched with `mainThreadViolations[]` that catalog the kind of work happening on the main thread (sync-io, db-lock, network, lock-contention). Typical pipeline: call `analyzeTimeProfile` separately on the same `.trace`, correlate samples to hang windows by timestamp, then re-call `analyzeHangs` with the resulting map. Omit to skip the enrichment.",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeHangsInput = z.infer<typeof analyzeHangsSchema>;

/**
 * Catalog of main-thread-violation signatures. Each entry classifies a
 * top-frame symbol pattern into one of four kinds that map onto the most
 * common iOS user-perceived freezes:
 *
 *  - `sync-io`: a blocking POSIX read/write or Foundation file API the
 *    runtime cannot async away from the main queue.
 *  - `db-lock`: SQLite mutex acquisition (the underlying primitive for
 *    Core Data, GRDB, and most Swift ORMs).
 *  - `network`: a blocking Network.framework/NSURLConnection sync call.
 *  - `lock-contention`: pthread/os_unfair_lock acquisition on the main
 *    thread, which serializes us against another thread.
 *
 * The matchers are case-sensitive substring checks. They deliberately
 * stay close to the symbol name DebugSwift's Thread Checker flags so the
 * coverage gap between the on-device tool and the offline catalog stays
 * small. Adding new symbols later is a one-line append.
 */
export type MainThreadViolationKind =
  | "sync-io"
  | "db-lock"
  | "network"
  | "lock-contention";

export interface MainThreadViolation {
  kind: MainThreadViolationKind;
  topFrame: string;
  samples: number;
}

interface ViolationSignature {
  kind: MainThreadViolationKind;
  matches: (frame: string) => boolean;
}

const MAIN_THREAD_VIOLATION_SIGNATURES: ViolationSignature[] = [
  // sync-io: POSIX read/write and Foundation/NSData blocking APIs.
  // Foundation often calls through to the libsystem symbols below, but
  // dSYM symbolication can land on either, so match both.
  {
    kind: "sync-io",
    matches: (f) =>
      /\b(read|pread|readv|write|pwrite|writev|fsync|fdatasync|aio_read|aio_write)\b/.test(
        f,
      ) ||
      f.includes("Data initWithContentsOfFile") ||
      f.includes("NSData _initWithContentsOfURL") ||
      f.includes("FileHandle readDataOfLength") ||
      f.includes("FileManager createFileAtPath") ||
      f.includes("FileManager removeItem"),
  },
  // db-lock: SQLite mutex acquisition. Triggers under Core Data, GRDB,
  // SQLite.swift, FMDB - any client that funnels through libsqlite3.
  {
    kind: "db-lock",
    matches: (f) =>
      f.includes("sqlite3_step") ||
      f.includes("sqlite3_prepare") ||
      f.includes("sqlite3_mutex_enter") ||
      f.includes("sqlite3LockAndPrepare") ||
      f.includes("pagerSharedLock") ||
      f.includes("NSPersistentStoreCoordinator lock") ||
      f.includes("NSManagedObjectContext save"),
  },
  // network: blocking Network.framework / legacy NSURLConnection sync
  // call, or +[NSURLConnection sendSynchronousRequest:returningResponse:].
  {
    kind: "network",
    matches: (f) =>
      f.includes("sendSynchronousRequest") ||
      f.includes("NSURLConnection sendSynchronousRequest") ||
      f.includes("URLSession dataTaskWithRequest") ||
      // CFNetwork sync path.
      f.includes("CFReadStreamRead") ||
      // Network.framework sync wait.
      /\bnw_connection_(start|wait)\b/.test(f),
  },
  // lock-contention: pthread / os_unfair_lock acquisition on the main
  // thread that blocks waiting for another thread.
  {
    kind: "lock-contention",
    matches: (f) =>
      f.includes("pthread_mutex_lock") ||
      f.includes("pthread_rwlock_wrlock") ||
      f.includes("pthread_rwlock_rdlock") ||
      f.includes("os_unfair_lock_lock") ||
      f.includes("dispatch_semaphore_wait") ||
      f.includes("dispatch_sync") ||
      f.includes("NSConditionLock lockWhenCondition") ||
      f.includes("NSLock lock"),
  },
];

/**
 * Pure: classify a top-frame symbol into a `MainThreadViolation`. Returns
 * `null` when nothing in the catalog matches. The `samples` count comes
 * from the caller; with only a top-frame string available we set it to 1.
 *
 * Multiple signatures can match a single frame (e.g. a sync I/O call that
 * also holds an unfair lock). We return the FIRST match in catalog order,
 * which puts more user-actionable categories ahead of generic locks.
 */
export function classifyHangFrame(
  topFrame: string,
  samples = 1,
): MainThreadViolation | null {
  for (const sig of MAIN_THREAD_VIOLATION_SIGNATURES) {
    if (sig.matches(topFrame)) {
      return { kind: sig.kind, topFrame, samples };
    }
  }
  return null;
}

/** Stable key used to correlate the supplemental `topFramesByHangStartNs`
 *  map. Hang startNs values are nanoseconds (integers when xctrace exports
 *  them cleanly), so the key is just `String(startNs)`. Centralized so
 *  callers building the map use the same convention. */
export function hangFrameMapKey(startNs: number): string {
  return String(startNs);
}

export interface HangEntry {
  startNs: number;
  startFmt: string;
  durationNs: number;
  durationMs: number;
  durationFmt: string;
  hangType: string;
  /** Main-thread violations detected from the supplemental top-frame map.
   *  Empty array when the caller provided a frame but no signature matched;
   *  undefined when no frame was provided for this hang at all. */
  mainThreadViolations?: MainThreadViolation[];
}

export interface AnalyzeHangsResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    hangs: number;
    microhangs: number;
    longestMs: number;
    averageMs: number;
    totalDurationMs: number;
  };
  /** Filtered + sorted hangs, capped to topN. */
  top: HangEntry[];
  diagnosis: string;
  /**
   * Disambiguates empty arrays into "no data in the trace" vs "trace could
   * not be exported" vs "data was exported partially". See {@link DataStatus}.
   */
  status: DataStatus;
}

/** Pure: turn parsed XML rows into our analyzed result. */
export function analyzeHangsFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
  minDurationMs = 0,
  timeRangeMs?: { startMs: number; endMs: number },
  topFramesByHangStartNs?: Readonly<Record<string, string>>,
): AnalyzeHangsResult {
  const tables = parseXctraceXml(xml);
  const hangsTable = tables.find((t) => t.schema === "potential-hangs");
  if (!hangsTable) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        hangs: 0,
        microhangs: 0,
        longestMs: 0,
        averageMs: 0,
        totalDurationMs: 0,
      },
      top: [],
      diagnosis: "No potential-hangs table found in the trace.",
      status: "not_present",
    };
  }

  const allEntries: HangEntry[] = [];
  for (const row of hangsTable.rows) {
    const startNs = asNumber(row.start) ?? 0;
    const durationNs = asNumber(row.duration) ?? 0;
    allEntries.push({
      startNs,
      startFmt: asFormatted(row.start) ?? "",
      durationNs,
      durationMs: durationNs / 1_000_000,
      durationFmt: asFormatted(row.duration) ?? "",
      hangType: asFormatted(row["hang-type"]) ?? "",
    });
  }

  const filtered = allEntries.filter((e) => {
    if (e.durationMs < minDurationMs) return false;
    if (timeRangeMs) {
      const startMs = e.startNs / 1_000_000;
      if (startMs < timeRangeMs.startMs || startMs > timeRangeMs.endMs) {
        return false;
      }
    }
    return true;
  });
  const hangs = filtered.filter((e) => e.hangType === "Hang");
  const microhangs = filtered.filter((e) => e.hangType === "Microhang");
  const totalDurationMs = filtered.reduce((sum, e) => sum + e.durationMs, 0);
  const longestMs = filtered.reduce(
    (max, e) => Math.max(max, e.durationMs),
    0,
  );
  const averageMs = filtered.length > 0 ? totalDurationMs / filtered.length : 0;

  const top = [...filtered]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, topN);

  // Enrich each top hang with main-thread violation classifications when
  // the supplemental top-frame map was supplied. We mutate the cloned
  // entries in `top` because they are not aliased back into `filtered`
  // after the spread above.
  if (topFramesByHangStartNs) {
    for (const entry of top) {
      const frame = topFramesByHangStartNs[hangFrameMapKey(entry.startNs)];
      if (frame == null) continue;
      const violation = classifyHangFrame(frame);
      entry.mainThreadViolations = violation ? [violation] : [];
    }
  }

  const diagnosis = buildHangDiagnosis(
    filtered.length,
    hangs.length,
    microhangs.length,
    longestMs,
    averageMs,
  );

  return {
    ok: true,
    tracePath,
    totals: {
      rows: filtered.length,
      hangs: hangs.length,
      microhangs: microhangs.length,
      longestMs,
      averageMs,
      totalDurationMs,
    },
    top,
    diagnosis,
    status: "available",
  };
}

function buildHangDiagnosis(
  rows: number,
  hangs: number,
  microhangs: number,
  longestMs: number,
  averageMs: number,
): string {
  if (rows === 0) {
    return "No hangs detected (or all were filtered out by minDurationMs).";
  }
  const parts: string[] = [];
  parts.push(`${rows} hangs total (${hangs} Hang, ${microhangs} Microhang).`);
  parts.push(`Longest: ${longestMs.toFixed(0)}ms, average: ${averageMs.toFixed(0)}ms.`);
  if (hangs >= 10) {
    parts.push("Severe hang load — investigate main-thread work on the slow path.");
  } else if (hangs > 0 && longestMs > 1000) {
    parts.push("At least one hang over 1s — likely user-visible freeze.");
  }
  return parts.join(" ");
}

export async function analyzeHangs(
  input: AnalyzeHangsInput,
): Promise<AnalyzeHangsResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const result = await runCommand(
    "xcrun",
    [
      "xctrace",
      "export",
      "--input",
      tracePath,
      "--xpath",
      '/trace-toc/run/data/table[@schema="potential-hangs"]',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeHangsFromXml(
    result.stdout,
    tracePath,
    input.topN ?? 10,
    input.minDurationMs ?? 0,
    input.timeRangeMs,
    input.topFramesByHangStartNs,
  );
}
