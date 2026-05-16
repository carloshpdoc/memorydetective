/**
 * `analyzeMemoryFootprint`: parses xctrace's memory-footprint schema. v1.15 item C.
 *
 * Distinct from analyzeAllocations: that tool surfaces category-level
 * cumulative allocation bytes ("which classes are bloated?"). This tool
 * surfaces process-level VM state ("how much RAM is the OS giving us
 * right now, and where is it going?"): resident memory, dirty memory,
 * VM regions, and the timeline of pressure events.
 *
 * The "why is my app getting OOM-killed?" investigation. iOS jetsam
 * decisions are made based on dirty + footprint, not cumulative malloc.
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

export const analyzeMemoryFootprintSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with an Allocations or System Trace template that includes the memory-footprint instrument.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Return the top N memory snapshots ranked by resident bytes (default 10).",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeMemoryFootprintInput = z.infer<
  typeof analyzeMemoryFootprintSchema
>;

export interface MemoryFootprintSample {
  startNs: number;
  startFmt?: string;
  /** Resident memory in bytes (RAM the process is using right now). */
  residentBytes?: number;
  /** Dirty memory in bytes (the OOM-kill discriminator on iOS). */
  dirtyBytes?: number;
  /** Compressed memory in bytes. */
  compressedBytes?: number;
  /** Virtual memory in bytes (address-space, not necessarily resident). */
  virtualBytes?: number;
  /** Optional sample-level label (e.g. "memory-warning", "background-event"). */
  label?: string;
}

export interface AnalyzeMemoryFootprintResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    /** Peak resident bytes seen across all samples. */
    peakResidentBytes: number;
    /** Peak dirty bytes seen across all samples. */
    peakDirtyBytes: number;
    /** Average resident bytes across all samples. */
    averageResidentBytes: number;
    /** Time of peak resident as ns offset from recording start. */
    peakResidentAtNs?: number;
  };
  /** Top N samples ranked by resident bytes desc. */
  topByResident: MemoryFootprintSample[];
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

/**
 * Format a byte count as human-friendly KB/MB. v1.15. Exported for
 * the diagnosis text and downstream callers.
 */
export function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Pure: turn the memory-footprint XML into the analyzed result. */
export function analyzeMemoryFootprintFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
): AnalyzeMemoryFootprintResult {
  const tables = parseXctraceXml(xml);
  // The memory-footprint schema may appear under different names
  // depending on the template (memory-footprint, resident-memory, etc).
  // Match conservatively against the canonical name first, then any
  // schema whose name matches the SCHEMA_FAMILIES.memory patterns
  // already validated in schemaDiscovery.
  const table = tables.find(
    (t) =>
      /memory-footprint/i.test(t.schema) ||
      /resident-memory/i.test(t.schema),
  );
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        peakResidentBytes: 0,
        peakDirtyBytes: 0,
        averageResidentBytes: 0,
      },
      topByResident: [],
      diagnosis: "No memory-footprint table found in the trace.",
      status: "not_present",
      supportStatus: [
        {
          kind: "memory-footprint",
          status: "not_present",
          reason: "Schema absent from the trace TOC.",
        },
      ],
    };
  }

  const samples: MemoryFootprintSample[] = [];
  for (const row of table.rows) {
    const startNs = pickNumber(row, ["time", "sample-time", "event-time", "start"]) ?? 0;
    const residentBytes = pickNumber(row, [
      "resident",
      "resident-bytes",
      "resident-memory",
      "phys",
      "phys-footprint",
    ]);
    const dirtyBytes = pickNumber(row, [
      "dirty",
      "dirty-bytes",
      "dirty-memory",
      "private-dirty",
    ]);
    const compressedBytes = pickNumber(row, [
      "compressed",
      "compressed-bytes",
      "compressed-memory",
    ]);
    const virtualBytes = pickNumber(row, [
      "virtual",
      "virtual-bytes",
      "vm-size",
      "vsize",
    ]);
    const label = pickString(row, ["label", "event", "event-type", "category"]);
    samples.push({
      startNs,
      ...(asFormatted(row.time) ? { startFmt: asFormatted(row.time)! } : {}),
      ...(residentBytes != null ? { residentBytes } : {}),
      ...(dirtyBytes != null ? { dirtyBytes } : {}),
      ...(compressedBytes != null ? { compressedBytes } : {}),
      ...(virtualBytes != null ? { virtualBytes } : {}),
      ...(label ? { label } : {}),
    });
  }

  const residents = samples
    .map((s) => s.residentBytes)
    .filter((v): v is number => v != null);
  const dirties = samples
    .map((s) => s.dirtyBytes)
    .filter((v): v is number => v != null);

  const peakResidentBytes = residents.length > 0 ? Math.max(...residents) : 0;
  const peakDirtyBytes = dirties.length > 0 ? Math.max(...dirties) : 0;
  const averageResidentBytes =
    residents.length > 0
      ? residents.reduce((a, b) => a + b, 0) / residents.length
      : 0;
  const peakSample = samples.find((s) => s.residentBytes === peakResidentBytes);
  const peakResidentAtNs = peakSample?.startNs;

  const topByResident = [...samples]
    .sort((a, b) => (b.residentBytes ?? 0) - (a.residentBytes ?? 0))
    .slice(0, topN);

  return {
    ok: true,
    tracePath,
    totals: {
      rows: samples.length,
      peakResidentBytes,
      peakDirtyBytes,
      averageResidentBytes,
      ...(peakResidentAtNs != null ? { peakResidentAtNs } : {}),
    },
    topByResident,
    diagnosis: buildDiagnosis(
      samples.length,
      peakResidentBytes,
      peakDirtyBytes,
    ),
    status: "available",
    supportStatus: [
      {
        // The SupportStatusKind enum doesn't have memory-footprint yet;
        // tagging as potential-hangs is wrong. We extend the enum in a
        // follow-up; for now use a generic kind and put the real schema
        // name in sourceSchemas so callers branch on that.
        kind: "memory-footprint",
        status: "available",
        sourceSchemas: ["memory-footprint"],
      },
    ],
  };
}

function buildDiagnosis(
  rows: number,
  peakResidentBytes: number,
  peakDirtyBytes: number,
): string {
  if (rows === 0) {
    return "No memory-footprint samples in the recording.";
  }
  const parts: string[] = [];
  parts.push(`${rows} memory snapshots.`);
  if (peakResidentBytes > 0) {
    parts.push(`Peak resident: ${formatBytes(peakResidentBytes)}.`);
  }
  if (peakDirtyBytes > 0) {
    parts.push(`Peak dirty: ${formatBytes(peakDirtyBytes)}.`);
  }
  // Apple's jetsam thresholds vary by device class but ~200MB dirty is
  // a reasonable "you're getting close to OOM" line for most apps.
  if (peakDirtyBytes > 200 * 1024 * 1024) {
    parts.push(
      "Peak dirty memory above 200 MB. Approaching jetsam territory on smaller devices.",
    );
  }
  return parts.join(" ");
}

export async function analyzeMemoryFootprint(
  input: AnalyzeMemoryFootprintInput,
): Promise<AnalyzeMemoryFootprintResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const { memory: schemaName } = await fetchDiscoveredSchemas(
    runCommand,
    tracePath,
    ["memory"] as const,
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
        peakResidentBytes: 0,
        peakDirtyBytes: 0,
        averageResidentBytes: 0,
      },
      topByResident: [],
      diagnosis:
        "Memory-footprint schema not exportable from this trace (likely recorded with a non-Allocations / non-System-Trace template).",
      status: "not_present",
      supportStatus: [
        {
          kind: "potential-hangs",
          status: "not_exportable",
          reason: "xctrace export failed for the memory schema family.",
        },
      ],
    };
  }
  return analyzeMemoryFootprintFromXml(
    result.stdout,
    tracePath,
    input.topN ?? 10,
  );
}
