import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";

export const analyzeTimeProfileSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe("Absolute path to a `.trace` bundle."),
  topN: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Return the top N hottest stacks by sample count (default 20)."),
});

export type AnalyzeTimeProfileInput = z.infer<typeof analyzeTimeProfileSchema>;

export interface SampleEntry {
  weight?: number;
  weightFmt?: string;
  threadName?: string;
  symbol?: string;
}

export interface AnalyzeTimeProfileResult {
  ok: boolean;
  tracePath: string;
  totalSamples: number;
  /** Per-symbol aggregation, sorted by sample count descending. */
  topSymbols: Array<{ symbol: string; samples: number }>;
  /** Top N rows after the aggregation step (raw view). */
  topRows: SampleEntry[];
  /**
   * Optional notice explaining a known limitation
   * (e.g. xctrace crashed exporting the time-profile schema).
   */
  notice?: string;
  diagnosis: string;
}

/**
 * Pure analysis from a chunk of xctrace XML. Aggregates sample counts per
 * symbol when symbols are available; otherwise reports raw row count.
 */
export function analyzeTimeProfileFromXml(
  xml: string,
  tracePath: string,
  topN = 20,
): AnalyzeTimeProfileResult {
  const tables = parseXctraceXml(xml);
  const tp = tables.find((t) => t.schema === "time-profile");
  if (!tp) {
    return {
      ok: true,
      tracePath,
      totalSamples: 0,
      topSymbols: [],
      topRows: [],
      diagnosis: "No time-profile table found in the export.",
    };
  }

  const rows: SampleEntry[] = [];
  const symbolCounts = new Map<string, number>();
  for (const row of tp.rows) {
    const weight = asNumber(row.weight);
    const weightFmt = asFormatted(row.weight);
    // Symbol may live under 'backtrace' or 'symbol' or as a nested cell.
    const symbol =
      asFormatted(row.symbol) ??
      asFormatted(row["weight"]) ??
      row.backtrace?.fmt ??
      row.backtrace?.raw ??
      undefined;
    const threadName = row.thread?.fmt ?? undefined;
    rows.push({ weight, weightFmt, symbol, threadName });
    if (symbol) {
      symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
    }
  }

  const topSymbols = Array.from(symbolCounts.entries())
    .map(([symbol, samples]) => ({ symbol, samples }))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, topN);

  const topRows = [...rows]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, topN);

  return {
    ok: true,
    tracePath,
    totalSamples: rows.length,
    topSymbols,
    topRows,
    diagnosis:
      rows.length === 0
        ? "No samples found in the time-profile table."
        : `${rows.length} samples; top symbol: ${topSymbols[0]?.symbol ?? "unknown"} (${topSymbols[0]?.samples ?? 0} samples).`,
  };
}

const SIGSEGV_NOTICE = `xctrace crashed exporting the time-profile schema (SIGSEGV). This is a known issue with heavy time-profile data and unsymbolicated traces.

Workarounds:
1. Open the trace once in Instruments.app to symbolicate it, then close — the symbolicated trace usually exports cleanly afterward.
2. Re-record with a shorter --time-limit (e.g. 30s instead of 90s) to keep the sample volume manageable.
3. For hangs analysis, use \`analyzeHangs\` instead — it parses a different (and lighter) schema that doesn't crash.`;

export async function analyzeTimeProfile(
  input: AnalyzeTimeProfileInput,
): Promise<AnalyzeTimeProfileResult> {
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
      '/trace-toc/run/data/table[@schema="time-profile"]',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    // SIGSEGV typically reports as 139 (128 + 11). Surface a useful message.
    if (result.code === 139 || /Segmentation/i.test(result.stderr)) {
      return {
        ok: false,
        tracePath,
        totalSamples: 0,
        topSymbols: [],
        topRows: [],
        notice: SIGSEGV_NOTICE,
        diagnosis:
          "Could not export time-profile schema (xctrace crashed). See `notice` for workarounds.",
      };
    }
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeTimeProfileFromXml(result.stdout, tracePath, input.topN ?? 20);
}
