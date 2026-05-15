import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { fetchDiscoveredSchemas } from "../parsers/schemaDiscovery.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";
import type { DataStatus, SupportStatus } from "../types.js";
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
      "Optional supplemental map from a hang's `startNs` (as a string) to the top frame seen during that hang. When provided, each matching hang in `top[]` is enriched with `mainThreadViolations[]` that catalog the kind of work happening on the main thread (sync-io, db-lock, network, lock-contention). Typical pipeline: call `analyzeTimeProfile` separately on the same `.trace`, correlate samples to hang windows by timestamp, then re-call `analyzeHangs` with the resulting map. Omit to skip the enrichment. SUPERSEDED in v1.12 by `includeStackClassification: true`, which builds this map internally.",
    ),
  includeStackClassification: z
    .boolean()
    .default(false)
    .describe(
      "v1.12+. When true, analyzeHangs internally exports the `time-profile` schema in parallel with `potential-hangs`, correlates samples to hang windows by timestamp, picks the dominant top frame per hang, and runs `classifyHangFrame` on it. The `mainThreadViolations[]` field on each top hang is populated automatically. Replaces the v1.9 caller-built `topFramesByHangStartNs` map: most callers should set this flag instead of building the map manually. Adds a second xctrace export call, run in parallel with the hangs export so wall-clock is unchanged when the trace export succeeds. Falls back gracefully (empty violations, no error) when the time-profile schema is absent or xctrace SIGSEGVs on it.",
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

/**
 * Entry from the `hang-risks` schema. v1.14.
 *
 * Different shape from `HangEntry`: `hang-risks` reports point-in-time RISK
 * annotations emitted by the iOS runtime (e.g. "Hang Risk", "Severe Hang
 * Risk" narrative events) rather than measured durations. No `durationNs`
 * field exists because risks have no duration. The Severity column buckets
 * the annotation; `backtrace` is a stringified stack at the moment the
 * risk was annotated.
 */
export interface HangRiskEntry {
  timestampNs: number;
  timestampFmt: string;
  severity: string;
  eventType: string;
  message: string;
  threadName?: string;
  backtrace?: string;
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
  /**
   * v1.14: hang-risks schema events. Apple-runtime risk annotations
   * complementary to the measured potential-hangs above. Absent when
   * the schema was not present in the trace OR when xctrace failed to
   * export it; present (possibly empty array) when the schema was
   * exported successfully.
   */
  risks?: HangRiskEntry[];
  /** v1.14: hang-risks aggregates. Mirrors `totals` for `top[]`. Absent when the schema was not exported. */
  risksTotals?: {
    rows: number;
    bySeverity: Record<string, number>;
  };
  diagnosis: string;
  /**
   * Disambiguates empty arrays into "no data in the trace" vs "trace could
   * not be exported" vs "data was exported partially". See {@link DataStatus}.
   *
   * @deprecated v1.14 item I. Use `supportStatus[]` instead. Kept for
   * backwards compatibility with v1.13 callers.
   */
  status: DataStatus;
  /**
   * v1.14+. Unified per-area status surface. For analyzeHangs this
   * contains one entry for the `potential-hangs` schema and a second
   * for `hang-risks` when that schema was discovered. See {@link
   * SupportStatus}.
   */
  supportStatus: SupportStatus[];
}

/** Pure: turn parsed XML rows into our analyzed result. The optional
 *  `hangRisksXml` (v1.14) is parsed via {@link analyzeHangRisksFromXml}
 *  and surfaced on `result.risks[]` + `result.risksTotals`. */
export function analyzeHangsFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
  minDurationMs = 0,
  timeRangeMs?: { startMs: number; endMs: number },
  topFramesByHangStartNs?: Readonly<Record<string, string>>,
  hangRisksXml?: string,
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
      supportStatus: [
        {
          kind: "potential-hangs",
          status: "not_present",
          reason: "Schema absent from the trace TOC.",
        },
      ],
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

  const risksAnalysis = hangRisksXml
    ? analyzeHangRisksFromXml(hangRisksXml, topN)
    : null;
  const severeRisksCount = risksAnalysis
    ? Object.entries(risksAnalysis.bySeverity)
        .filter(([sev]) => /severe/i.test(sev))
        .reduce((sum, [, n]) => sum + n, 0)
    : undefined;

  const diagnosis = buildHangDiagnosis(
    filtered.length,
    hangs.length,
    microhangs.length,
    longestMs,
    averageMs,
    risksAnalysis?.total,
    severeRisksCount,
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
    ...(risksAnalysis
      ? {
          risks: risksAnalysis.rows,
          risksTotals: {
            rows: risksAnalysis.total,
            bySeverity: risksAnalysis.bySeverity,
          },
        }
      : {}),
    diagnosis,
    status: "available",
    supportStatus: [
      {
        kind: "potential-hangs",
        status: "available",
        sourceSchemas: ["potential-hangs"],
      },
      ...(risksAnalysis
        ? ([
            {
              kind: "hang-risks",
              status: risksAnalysis.total > 0 ? "available" : "not_present",
              sourceSchemas: ["hang-risks"],
              ...(risksAnalysis.total === 0
                ? { reason: "Schema exported but no rows present." }
                : {}),
            },
          ] as SupportStatus[])
        : []),
    ],
  };
}

function buildHangDiagnosis(
  rows: number,
  hangs: number,
  microhangs: number,
  longestMs: number,
  averageMs: number,
  risksCount?: number,
  severeRisksCount?: number,
): string {
  const parts: string[] = [];
  if (rows === 0) {
    parts.push("No hangs detected (or all were filtered out by minDurationMs).");
  } else {
    parts.push(`${rows} hangs total (${hangs} Hang, ${microhangs} Microhang).`);
    parts.push(`Longest: ${longestMs.toFixed(0)}ms, average: ${averageMs.toFixed(0)}ms.`);
    if (hangs >= 10) {
      parts.push("Severe hang load: investigate main-thread work on the slow path.");
    } else if (hangs > 0 && longestMs > 1000) {
      parts.push("At least one hang over 1s. Likely user-visible freeze.");
    }
  }
  if (risksCount != null && risksCount > 0) {
    const severeNote =
      severeRisksCount != null && severeRisksCount > 0
        ? `, ${severeRisksCount} severe`
        : "";
    parts.push(`${risksCount} hang risk annotations${severeNote} from the iOS runtime.`);
  }
  return parts.join(" ");
}

/**
 * Pure: parse `hang-risks` schema XML into structured risk entries.
 *
 * v1.14. The hang-risks schema is complementary to potential-hangs: it
 * carries runtime-emitted "Hang Risk" / "Severe Hang Risk" annotations
 * with a backtrace at the moment of risk detection but NO measured
 * duration. Output is sorted by timestamp ascending so callers can see
 * the chronological order of risks during the recording.
 *
 * Returns `{ rows: [], bySeverity: {} }` when the schema is absent.
 */
export function analyzeHangRisksFromXml(
  xml: string,
  topN = 10,
): { rows: HangRiskEntry[]; total: number; bySeverity: Record<string, number> } {
  const tables = parseXctraceXml(xml);
  const table = tables.find((t) => t.schema === "hang-risks");
  if (!table) return { rows: [], total: 0, bySeverity: {} };
  const entries: HangRiskEntry[] = [];
  const bySeverity: Record<string, number> = {};
  for (const row of table.rows) {
    const timestampNs = asNumber(row.time) ?? 0;
    const severity = asFormatted(row.severity) ?? "";
    const eventType = asFormatted(row["event-type"]) ?? "";
    const message = asFormatted(row.message) ?? "";
    const threadName = asFormatted(row.thread) ?? undefined;
    const backtrace = asFormatted(row.backtrace) ?? undefined;
    entries.push({
      timestampNs,
      timestampFmt: asFormatted(row.time) ?? "",
      severity,
      eventType,
      message,
      ...(threadName ? { threadName } : {}),
      ...(backtrace ? { backtrace } : {}),
    });
    if (severity) {
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    }
  }
  entries.sort((a, b) => a.timestampNs - b.timestampNs);
  return {
    rows: entries.slice(0, topN),
    total: entries.length,
    bySeverity,
  };
}

/**
 * Pure: walk parsed time-profile rows + hang entries, correlate samples
 * to hang windows by timestamp, return a `startNs -> topFrame` map.
 *
 * Algorithm: for each hang H with [startNs, startNs+durationNs], find all
 * samples whose `weight` timestamp falls in that window. Per hang, pick
 * the top frame by aggregate sample weight (or by sample count if weight
 * is absent). The result map keys are stringified `startNs` values to
 * match the existing `topFramesByHangStartNs` shape that v1.9 exposed.
 *
 * Returns an empty map when the time-profile rows are absent or none
 * correlate. Failure modes degrade silently so the cycle-side path
 * still completes.
 *
 * Exposed for testing.
 */
export function correlateTimeProfileToHangs(
  hangs: Array<{ startNs: number; durationNs: number }>,
  timeProfileRows: Array<{
    startNs: number;
    weight?: number;
    backtrace?: string;
    topFrame?: string;
  }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (hangs.length === 0 || timeProfileRows.length === 0) return result;
  for (const hang of hangs) {
    const windowEnd = hang.startNs + hang.durationNs;
    // Per-frame aggregate score within this hang's window.
    const scores = new Map<string, number>();
    for (const sample of timeProfileRows) {
      if (sample.startNs < hang.startNs || sample.startNs > windowEnd) continue;
      const frame =
        sample.topFrame ??
        // First non-empty line of backtrace, when topFrame isn't pre-parsed.
        sample.backtrace?.split(/\r?\n/).find((l) => l.trim().length > 0) ??
        "";
      if (!frame) continue;
      const weight = sample.weight ?? 1;
      scores.set(frame, (scores.get(frame) ?? 0) + weight);
    }
    if (scores.size === 0) continue;
    // Pick the frame with the highest aggregate score.
    let topFrame = "";
    let topScore = -Infinity;
    for (const [frame, score] of scores) {
      if (score > topScore) {
        topScore = score;
        topFrame = frame;
      }
    }
    if (topFrame) result[hangFrameMapKey(hang.startNs)] = topFrame;
  }
  return result;
}

/**
 * Spawn `xctrace export` for the `time-profile` schema. Non-fatal on
 * failure: returns an empty array so the caller can degrade gracefully.
 * Returns parsed rows with at minimum `startNs` + a `topFrame` string.
 */
async function captureTimeProfileRows(
  tracePath: string,
  schemaName: string,
): Promise<
  Array<{ startNs: number; weight?: number; topFrame?: string }>
> {
  const result = await runCommand(
    "xcrun",
    [
      "xctrace",
      "export",
      "--input",
      tracePath,
      "--xpath",
      `/trace-toc/run/data/table[@schema="${schemaName}"]`,
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) return [];
  try {
    const tables = parseXctraceXml(result.stdout);
    const tp = tables.find((t) => t.schema === schemaName);
    if (!tp) return [];
    const rows: Array<{ startNs: number; weight?: number; topFrame?: string }> =
      [];
    for (const row of tp.rows) {
      const startNs = asNumber(row.start);
      if (startNs == null) continue;
      const weight = asNumber(row.weight) ?? undefined;
      // The "top frame" field name varies (`backtrace`, `top-frame`, etc.).
      // Pick the first non-empty stringified candidate.
      const candidates = [
        asFormatted(row["top-frame"]),
        asFormatted(row.backtrace),
        asFormatted(row.symbol),
        asFormatted(row["leaf-symbol"]),
      ];
      const topFrame = candidates.find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      rows.push({ startNs, weight, topFrame });
    }
    return rows;
  } catch {
    return [];
  }
}

export async function analyzeHangs(
  input: AnalyzeHangsInput,
): Promise<AnalyzeHangsResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const wantStackClassification = input.includeStackClassification ?? false;
  // v1.14 item B. Resolve the three schema names from the trace's TOC
  // in one pass so a renamed schema does not break the analyzer. Falls
  // back to canonical pre-v1.14 names when the TOC fetch or pattern
  // match fails. Cost: one extra xctrace --toc invocation (~100-500ms
  // on real traces). Cached per analyze call.
  const discovered = await fetchDiscoveredSchemas(runCommand, tracePath, [
    "hangs",
    "hang-risks",
    "time-profile",
  ] as const);
  const [hangsResult, hangRisksResult, timeProfileRows] = await Promise.all([
    runCommand(
      "xcrun",
      [
        "xctrace",
        "export",
        "--input",
        tracePath,
        "--xpath",
        `/trace-toc/run/data/table[@schema="${discovered.hangs}"]`,
      ],
      { timeoutMs: 5 * 60_000 },
    ),
    // v1.14: fetch the complementary hang-risks schema in parallel. The
    // schema is optional (some templates omit it). Failure here is non-
    // fatal: the result is rolled into `risks?` only when xctrace returned
    // a parseable export.
    runCommand(
      "xcrun",
      [
        "xctrace",
        "export",
        "--input",
        tracePath,
        "--xpath",
        `/trace-toc/run/data/table[@schema="${discovered["hang-risks"]}"]`,
      ],
      { timeoutMs: 5 * 60_000 },
    ),
    wantStackClassification
      ? captureTimeProfileRows(tracePath, discovered["time-profile"])
      : Promise.resolve(
          [] as Array<{
            startNs: number;
            weight?: number;
            topFrame?: string;
          }>,
        ),
  ]);
  if (hangsResult.code !== 0) {
    throw new Error(
      `xctrace export failed (code ${hangsResult.code}): ${hangsResult.stderr || hangsResult.stdout}`,
    );
  }
  // hang-risks: only surface when the export succeeded. Anything else
  // (xctrace error, parse failure, empty schema) -> drop without error.
  const hangRisksXml =
    hangRisksResult.code === 0 && hangRisksResult.stdout ? hangRisksResult.stdout : undefined;

  // Build the supplemental top-frames map. Caller-supplied map takes
  // precedence over the v1.12 auto-correlation so users who pre-built a
  // map can override the heuristic. The auto path runs only when the
  // user didn't supply a map AND opted into stack classification.
  let topFramesMap = input.topFramesByHangStartNs;
  if (!topFramesMap && wantStackClassification && timeProfileRows.length > 0) {
    // Parse the hangs table once to drive correlation; analyzeHangsFromXml
    // re-parses internally so we get a clean separation between the
    // correlation step and the final render.
    const tables = parseXctraceXml(hangsResult.stdout);
    const hangsTable = tables.find((t) => t.schema === "potential-hangs");
    if (hangsTable) {
      const hangsForCorrelation: Array<{ startNs: number; durationNs: number }> =
        [];
      for (const row of hangsTable.rows) {
        const startNs = asNumber(row.start) ?? 0;
        const durationNs = asNumber(row.duration) ?? 0;
        hangsForCorrelation.push({ startNs, durationNs });
      }
      topFramesMap = correlateTimeProfileToHangs(
        hangsForCorrelation,
        timeProfileRows,
      );
    }
  }

  return analyzeHangsFromXml(
    hangsResult.stdout,
    tracePath,
    input.topN ?? 10,
    input.minDurationMs ?? 0,
    input.timeRangeMs,
    topFramesMap,
    hangRisksXml,
  );
}
