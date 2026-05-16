/**
 * `analyzeLeakTimeline`: parses xctrace's leaks schema (the time-series
 * instrument), distinct from `leaks(1)` CLI which is a snapshot. v1.15
 * item E.
 *
 * The xctrace `leaks` instrument samples the heap periodically during
 * recording and emits one row per leak event. Unlike leaks(1) (which
 * gives you "what is leaked NOW") this gives you "when did the leak
 * first appear, how did it grow, when did it peak?" Useful for fixing
 * leaks that only fire under certain user flows.
 *
 * Output:
 * - per-class first-seen-at timestamp
 * - growth rate (instances over time)
 * - peak instance count
 * - aggregate event count
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { fetchDiscoveredSchemas } from "../parsers/schemaDiscovery.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
  type XctraceValue,
} from "../parsers/xctraceXml.js";
import type { DataStatus, SupportStatus } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

export const analyzeLeakTimelineSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with a Leaks template.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Return the top N leaked classes ranked by peak instance count (default 10).",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeLeakTimelineInput = z.infer<
  typeof analyzeLeakTimelineSchema
>;

export interface LeakEvent {
  startNs: number;
  startFmt?: string;
  className: string;
  /** Cumulative count of this class at this point in the recording. */
  cumulativeCount?: number;
  /** Bytes leaked at this point when xctrace exposes a size column. */
  totalBytes?: number;
}

export interface LeakClassSummary {
  className: string;
  /** Timestamp the class first appeared as a leak. */
  firstSeenAtNs: number;
  firstSeenAtFmt?: string;
  /** Highest cumulativeCount observed across all events. */
  peakCount: number;
  /** Highest totalBytes observed across all events. */
  peakBytes: number;
  /** Total events emitted for this class. */
  eventCount: number;
}

export interface AnalyzeLeakTimelineResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    /** Distinct class count across the timeline. */
    classes: number;
    /** Latest timestamp seen, useful as a "leaks were still growing" check. */
    lastEventNs?: number;
  };
  /** Top N classes ranked by peakCount desc. */
  topClasses: LeakClassSummary[];
  diagnosis: string;
  /** @deprecated v1.14 item I. Use `supportStatus[]`. */
  status: DataStatus;
  /** v1.14+. Unified per-area status. */
  supportStatus: SupportStatus[];
}

function pickNumber(
  row: Record<string, XctraceValue>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = asNumber(row[k]);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickString(
  row: Record<string, XctraceValue>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = asFormatted(row[k]);
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Pure: turn the leaks XML into the timeline analysis. */
export function analyzeLeakTimelineFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
): AnalyzeLeakTimelineResult {
  const tables = parseXctraceXml(xml);
  // xctrace's Leaks instrument typically labels the schema "leaks" or
  // "leak-events". Match conservatively against both.
  const table = tables.find(
    (t) => /^leaks?$/i.test(t.schema) || /leak-events?/i.test(t.schema),
  );
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: { rows: 0, classes: 0 },
      topClasses: [],
      diagnosis: "No leaks table found in the trace.",
      status: "not_present",
      supportStatus: [
        {
          kind: "leak-events",
          status: "not_present",
          reason: "Schema absent from the trace TOC.",
        },
      ],
    };
  }

  const events: LeakEvent[] = [];
  let rowsSkippedNoClass = 0;
  for (const row of table.rows) {
    const startNs = pickNumber(row, ["time", "event-time", "start", "sample-time"]) ?? 0;
    const className = pickString(row, [
      "class",
      "class-name",
      "type",
      "type-name",
      "leak-type",
    ]) ?? "";
    if (!className) {
      rowsSkippedNoClass += 1;
      continue;
    }
    const cumulativeCount = pickNumber(row, [
      "count",
      "cumulative-count",
      "instances",
    ]);
    const totalBytes = pickNumber(row, [
      "bytes",
      "size",
      "total-bytes",
      "leaked-bytes",
    ]);
    events.push({
      startNs,
      ...(asFormatted(row.time) ? { startFmt: asFormatted(row.time)! } : {}),
      className,
      ...(cumulativeCount != null ? { cumulativeCount } : {}),
      ...(totalBytes != null ? { totalBytes } : {}),
    });
  }

  // Group events by class. Track first-seen-at, peakCount, peakBytes,
  // event count per class.
  const byClass = new Map<string, LeakClassSummary>();
  for (const ev of events) {
    const cur =
      byClass.get(ev.className) ??
      ({
        className: ev.className,
        firstSeenAtNs: ev.startNs,
        firstSeenAtFmt: ev.startFmt,
        peakCount: 0,
        peakBytes: 0,
        eventCount: 0,
      } as LeakClassSummary);
    if (ev.startNs < cur.firstSeenAtNs) {
      cur.firstSeenAtNs = ev.startNs;
      if (ev.startFmt) cur.firstSeenAtFmt = ev.startFmt;
    }
    if (ev.cumulativeCount != null && ev.cumulativeCount > cur.peakCount) {
      cur.peakCount = ev.cumulativeCount;
    }
    if (ev.totalBytes != null && ev.totalBytes > cur.peakBytes) {
      cur.peakBytes = ev.totalBytes;
    }
    cur.eventCount += 1;
    byClass.set(ev.className, cur);
  }

  const topClasses = Array.from(byClass.values())
    .sort((a, b) => {
      const peakDiff = b.peakCount - a.peakCount;
      if (peakDiff !== 0) return peakDiff;
      return b.eventCount - a.eventCount;
    })
    .slice(0, topN);

  const lastEventNs = events.reduce((max, e) => Math.max(max, e.startNs), 0);

  // v1.17 B-14: detect parser mismatch. If the schema had rows but every
  // single row was skipped because no className column matched any of our
  // candidate field names, surface that as `partial` status + diagnostic
  // reason instead of letting it look like genuine absence.
  const totalRowsInSchema = events.length + rowsSkippedNoClass;
  const allRowsLackedClassName =
    totalRowsInSchema > 0 && events.length === 0;
  const supportEntry: SupportStatus = allRowsLackedClassName
    ? {
        kind: "leak-events",
        status: "partial",
        sourceSchemas: ["leaks"],
        reason: `${rowsSkippedNoClass} rows in schema but none had a parseable className. Expected one of: class / class-name / type / type-name / leak-type. The xctrace schema may use a different column name on your iOS / Xcode version.`,
      }
    : {
        kind: "leak-events",
        status: "available",
        sourceSchemas: ["leaks"],
      };

  return {
    ok: true,
    tracePath,
    totals: {
      rows: events.length,
      classes: byClass.size,
      ...(lastEventNs > 0 ? { lastEventNs } : {}),
    },
    topClasses,
    diagnosis: allRowsLackedClassName
      ? `${rowsSkippedNoClass} leak events in the schema but the className column was not in the expected set (class / class-name / type / type-name / leak-type). Likely a column-name drift on your iOS / Xcode version.`
      : buildDiagnosis(events.length, byClass.size, topClasses),
    status: allRowsLackedClassName ? "partial" : "available",
    supportStatus: [supportEntry],
  };
}

function buildDiagnosis(
  rows: number,
  classes: number,
  topClasses: LeakClassSummary[],
): string {
  if (rows === 0) {
    return "No leak events in the recording.";
  }
  const parts: string[] = [];
  parts.push(
    `${rows} leak event${rows === 1 ? "" : "s"} across ${classes} class${classes === 1 ? "" : "es"}.`,
  );
  if (topClasses.length > 0) {
    const top = topClasses[0];
    parts.push(
      `Top leaked: \`${top.className}\` (peak ${top.peakCount} instances, first seen at ${(top.firstSeenAtNs / 1e9).toFixed(2)}s).`,
    );
  }
  if (classes >= 5) {
    parts.push(
      "Multiple class signatures leaking. Suggests a shared cause (e.g. notification observer not removed) rather than a single one-off.",
    );
  }
  return parts.join(" ");
}

export async function analyzeLeakTimeline(
  input: AnalyzeLeakTimelineInput,
): Promise<AnalyzeLeakTimelineResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const { leaks: schemaName } = await fetchDiscoveredSchemas(
    runCommand,
    tracePath,
    ["leaks"] as const,
  );
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
  if (result.code !== 0) {
    return {
      ok: true,
      tracePath,
      totals: { rows: 0, classes: 0 },
      topClasses: [],
      diagnosis:
        "Leaks schema not exportable from this trace (likely recorded with a non-Leaks template).",
      status: "not_present",
      supportStatus: [
        {
          kind: "leak-events",
          status: "not_exportable",
          reason: "xctrace export failed for the leaks schema family.",
          sourceSchemas: [schemaName],
        },
      ],
    };
  }
  return analyzeLeakTimelineFromXml(result.stdout, tracePath, input.topN ?? 10);
}
