import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";

export const analyzeAllocationsSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with the Allocations template (`xcrun xctrace record --template Allocations --attach <app|pid>`).",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(15)
    .describe("Return the top N allocators by aggregated size (default 15)."),
  minBytes: z
    .number()
    .nonnegative()
    .default(0)
    .describe(
      "Filter out individual allocations smaller than this size in bytes (default 0). Use 1024 to focus on >1KB allocations.",
    ),
});

export type AnalyzeAllocationsInput = z.infer<typeof analyzeAllocationsSchema>;

export interface AllocationEntry {
  category: string;
  /** Live count at end of trace for this category (when available). */
  liveCount?: number;
  /** Cumulative count over the whole recording. */
  cumulativeCount: number;
  /** Cumulative bytes allocated for this category. */
  cumulativeBytes: number;
  /** Average allocation size in bytes. */
  averageBytes: number;
  /** Lifetime classification heuristic. */
  lifecycle: "transient" | "persistent" | "mixed";
}

export interface AnalyzeAllocationsResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    cumulativeBytes: number;
    cumulativeAllocations: number;
    persistentBytes: number;
    transientBytes: number;
  };
  /** Top categories by cumulative bytes. */
  topByBytes: AllocationEntry[];
  /** Top categories by allocation count (different signal — small frequent allocations). */
  topByCount: AllocationEntry[];
  diagnosis: string;
}

interface RawAllocationRow {
  category: string;
  size: number;
  liveAtEnd: boolean;
}

/** Pure: turn parsed XML into the analyzed result. */
export function analyzeAllocationsFromXml(
  xml: string,
  tracePath: string,
  topN = 15,
  minBytes = 0,
): AnalyzeAllocationsResult {
  const tables = parseXctraceXml(xml);
  const table = tables.find((t) => t.schema === "allocations");
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        cumulativeBytes: 0,
        cumulativeAllocations: 0,
        persistentBytes: 0,
        transientBytes: 0,
      },
      topByBytes: [],
      topByCount: [],
      diagnosis: "No allocations table found in the trace.",
    };
  }

  // The xctrace `allocations` schema has columns roughly like:
  //   category (mnemonic) / size / event-type (alloc, free)
  // We treat an alloc without a matching free as "persistent" — that's what
  // shows up in the Live Allocations panel in Instruments.
  const rows: RawAllocationRow[] = [];
  let cumulativeBytes = 0;
  let cumulativeAllocations = 0;

  for (const row of table.rows) {
    const category =
      asFormatted(row.category) ??
      asFormatted(row.classname) ??
      asFormatted(row["category-name"]) ??
      "unknown";
    const size =
      asNumber(row.size) ?? asNumber(row["allocated-size"]) ?? 0;
    if (size < minBytes) continue;
    const eventType =
      asFormatted(row["event-type"]) ?? asFormatted(row.type) ?? "alloc";
    rows.push({
      category,
      size,
      liveAtEnd: eventType === "alloc" || eventType === "live",
    });
    cumulativeBytes += size;
    cumulativeAllocations += 1;
  }

  // Aggregate by category.
  type Agg = {
    category: string;
    cumulativeCount: number;
    cumulativeBytes: number;
    liveCount: number;
  };
  const agg = new Map<string, Agg>();
  for (const r of rows) {
    const existing = agg.get(r.category);
    if (existing) {
      existing.cumulativeCount += 1;
      existing.cumulativeBytes += r.size;
      if (r.liveAtEnd) existing.liveCount += 1;
    } else {
      agg.set(r.category, {
        category: r.category,
        cumulativeCount: 1,
        cumulativeBytes: r.size,
        liveCount: r.liveAtEnd ? 1 : 0,
      });
    }
  }

  const entries: AllocationEntry[] = Array.from(agg.values()).map((a) => {
    const avg = a.cumulativeCount > 0 ? a.cumulativeBytes / a.cumulativeCount : 0;
    let lifecycle: "transient" | "persistent" | "mixed";
    if (a.liveCount === 0) lifecycle = "transient";
    else if (a.liveCount === a.cumulativeCount) lifecycle = "persistent";
    else lifecycle = "mixed";
    return {
      category: a.category,
      liveCount: a.liveCount,
      cumulativeCount: a.cumulativeCount,
      cumulativeBytes: a.cumulativeBytes,
      averageBytes: avg,
      lifecycle,
    };
  });

  const persistentBytes = entries
    .filter((e) => e.lifecycle === "persistent")
    .reduce((sum, e) => sum + e.cumulativeBytes, 0);
  const transientBytes = entries
    .filter((e) => e.lifecycle === "transient")
    .reduce((sum, e) => sum + e.cumulativeBytes, 0);

  const topByBytes = [...entries]
    .sort((a, b) => b.cumulativeBytes - a.cumulativeBytes)
    .slice(0, topN);
  const topByCount = [...entries]
    .sort((a, b) => b.cumulativeCount - a.cumulativeCount)
    .slice(0, topN);

  const diagnosis = buildDiagnosis(rows.length, cumulativeBytes, topByBytes);

  return {
    ok: true,
    tracePath,
    totals: {
      rows: rows.length,
      cumulativeBytes,
      cumulativeAllocations,
      persistentBytes,
      transientBytes,
    },
    topByBytes,
    topByCount,
    diagnosis,
  };
}

function buildDiagnosis(
  rows: number,
  cumulativeBytes: number,
  topByBytes: AllocationEntry[],
): string {
  if (rows === 0) {
    return "No allocations found (or all filtered out by minBytes).";
  }
  const top = topByBytes[0];
  const mb = (cumulativeBytes / 1024 / 1024).toFixed(2);
  return `${rows.toLocaleString()} allocations totaling ${mb} MB. Top allocator: ${top.category} (${(top.cumulativeBytes / 1024 / 1024).toFixed(2)} MB across ${top.cumulativeCount.toLocaleString()} allocations, lifecycle=${top.lifecycle}).`;
}

export async function analyzeAllocations(
  input: AnalyzeAllocationsInput,
): Promise<AnalyzeAllocationsResult> {
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
      '/trace-toc/run/data/table[@schema="allocations"]',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeAllocationsFromXml(
    result.stdout,
    tracePath,
    input.topN ?? 15,
    input.minBytes ?? 0,
  );
}
