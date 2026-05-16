/**
 * `analyzeEnergyImpact`: parses xctrace's energy-impact schema. v1.15 item D.
 *
 * The "why is my app draining battery?" investigation. iOS's Energy
 * Log buckets samples into idle / passive / active / high categories
 * and counts wakeups. Background apps that keep CPU active for too long
 * burn battery and get throttled by the OS. wearables / location apps /
 * background-fetch users are the typical audience for this analyzer.
 *
 * Distinct from analyzeTimeProfile (CPU sampling) which tells you which
 * functions are hot but not how that maps to power draw. The energy
 * schema is a different sensor: it reads from the OS power-management
 * subsystem directly.
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

export const analyzeEnergyImpactSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with an Energy Log template that includes the energy-impact instrument.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Return the top N samples ranked by energy cost descending (default 10).",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeEnergyImpactInput = z.infer<
  typeof analyzeEnergyImpactSchema
>;

export type EnergyBucket = "idle" | "passive" | "active" | "high" | "unknown";

export interface EnergySample {
  startNs: number;
  startFmt?: string;
  /** Apple's energy bucket classification. */
  bucket: EnergyBucket;
  /** Wakeups per second when present. */
  wakeups?: number;
  /** Raw energy cost score when xctrace exposes one (varies by Xcode version). */
  cost?: number;
  /** Optional sample-level label / event name. */
  label?: string;
}

export interface AnalyzeEnergyImpactResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    /** Aggregate wakeups across all samples. */
    totalWakeups: number;
    /** Ratio of samples in `active` + `high` buckets vs total. 0 means fully idle. */
    activeRatio: number;
    /** Per-bucket sample counts. */
    bucketCounts: Record<EnergyBucket, number>;
  };
  /** Top N samples by energy cost desc. */
  topByCost: EnergySample[];
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

/** Normalize whatever string xctrace puts in the bucket column to our
 *  canonical enum. v1.15. Exported for testing.
 *
 *  v1.17: priority order fixed. "active" / "foreground" / "passive" /
 *  "background" are checked BEFORE "high" so strings like "highly active"
 *  classify as `active` (per the dominant lexical signal) instead of
 *  `high`. Long-tail edge case from real xctrace output, but observed
 *  enough to warrant the reorder. */
export function normalizeBucket(raw: string | undefined): EnergyBucket {
  if (!raw) return "unknown";
  const lc = raw.toLowerCase();
  if (lc.includes("idle")) return "idle";
  if (lc.includes("active") || lc.includes("foreground")) return "active";
  if (lc.includes("passive") || lc.includes("background")) return "passive";
  if (lc.includes("high")) return "high";
  return "unknown";
}

/** Pure: turn the energy-impact XML into the analyzed result. */
export function analyzeEnergyImpactFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
): AnalyzeEnergyImpactResult {
  const tables = parseXctraceXml(xml);
  const table = tables.find(
    (t) =>
      t.schema === "energy-impact" ||
      /energy-impact/i.test(t.schema) ||
      /power-draw/i.test(t.schema),
  );
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        totalWakeups: 0,
        activeRatio: 0,
        bucketCounts: {
          idle: 0,
          passive: 0,
          active: 0,
          high: 0,
          unknown: 0,
        },
      },
      topByCost: [],
      diagnosis: "No energy-impact table found in the trace.",
      status: "not_present",
      supportStatus: [
        {
          kind: "energy-impact",
          status: "not_present",
          reason: "Schema absent from the trace TOC.",
        },
      ],
    };
  }

  const samples: EnergySample[] = [];
  for (const row of table.rows) {
    const startNs =
      pickNumber(row, ["time", "sample-time", "event-time", "start"]) ?? 0;
    const wakeups = pickNumber(row, [
      "wakeups",
      "wakeups-per-sec",
      "wakeups-rate",
    ]);
    const cost = pickNumber(row, [
      "cost",
      "energy-cost",
      "energy",
      "power",
      "power-cost",
    ]);
    const bucketRaw = pickString(row, [
      "bucket",
      "energy-bucket",
      "category",
      "state",
    ]);
    const label = pickString(row, ["label", "event", "event-type"]);
    samples.push({
      startNs,
      ...(asFormatted(row.time) ? { startFmt: asFormatted(row.time)! } : {}),
      bucket: normalizeBucket(bucketRaw),
      ...(wakeups != null ? { wakeups } : {}),
      ...(cost != null ? { cost } : {}),
      ...(label ? { label } : {}),
    });
  }

  const bucketCounts: Record<EnergyBucket, number> = {
    idle: 0,
    passive: 0,
    active: 0,
    high: 0,
    unknown: 0,
  };
  let totalWakeups = 0;
  for (const s of samples) {
    bucketCounts[s.bucket] += 1;
    if (s.wakeups != null) totalWakeups += s.wakeups;
  }
  const activeRatio =
    samples.length > 0
      ? (bucketCounts.active + bucketCounts.high) / samples.length
      : 0;

  const topByCost = [...samples]
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .slice(0, topN);

  return {
    ok: true,
    tracePath,
    totals: {
      rows: samples.length,
      totalWakeups,
      activeRatio,
      bucketCounts,
    },
    topByCost,
    diagnosis: buildDiagnosis(samples.length, totalWakeups, activeRatio, bucketCounts),
    status: "available",
    supportStatus: [
      {
        kind: "energy-impact",
        status: "available",
        sourceSchemas: ["energy-impact"],
      },
    ],
  };
}

function buildDiagnosis(
  rows: number,
  totalWakeups: number,
  activeRatio: number,
  bucketCounts: Record<EnergyBucket, number>,
): string {
  if (rows === 0) {
    return "No energy-impact samples in the recording.";
  }
  const parts: string[] = [];
  parts.push(`${rows} energy samples.`);
  if (totalWakeups > 0) {
    parts.push(`${totalWakeups.toLocaleString()} total wakeups.`);
  }
  const activePct = (activeRatio * 100).toFixed(1);
  parts.push(`Active+high: ${activePct}% of samples.`);
  if (bucketCounts.high > 0) {
    parts.push(`${bucketCounts.high} sample${bucketCounts.high === 1 ? "" : "s"} in the 'high' bucket.`);
  }
  if (activeRatio > 0.5) {
    parts.push(
      "Over half the recording in active or high power state. Heavy battery drain.",
    );
  } else if (totalWakeups > 500 && bucketCounts.idle / rows > 0.5) {
    parts.push(
      "High wakeup count despite idle bucket dominance. Likely background timer / notification storm.",
    );
  }
  return parts.join(" ");
}

export async function analyzeEnergyImpact(
  input: AnalyzeEnergyImpactInput,
): Promise<AnalyzeEnergyImpactResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const { energy: schemaName } = await fetchDiscoveredSchemas(
    runCommand,
    tracePath,
    ["energy"] as const,
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
      totals: {
        rows: 0,
        totalWakeups: 0,
        activeRatio: 0,
        bucketCounts: {
          idle: 0,
          passive: 0,
          active: 0,
          high: 0,
          unknown: 0,
        },
      },
      topByCost: [],
      diagnosis:
        "Energy-impact schema not exportable from this trace (likely recorded with a non-Energy template).",
      status: "not_present",
      supportStatus: [
        {
          kind: "energy-impact",
          status: "not_exportable",
          reason: "xctrace export failed for the energy schema family.",
          sourceSchemas: [schemaName],
        },
      ],
    };
  }
  return analyzeEnergyImpactFromXml(result.stdout, tracePath, input.topN ?? 10);
}
