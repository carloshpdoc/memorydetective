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
import type { DataStatus } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

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
  outputFormat: outputFormatField,
});

export type AnalyzeTimeProfileInput = z.infer<typeof analyzeTimeProfileSchema>;

export interface SampleEntry {
  weight?: number;
  weightFmt?: string;
  threadName?: string;
  symbol?: string;
  /** Binary name for the leaf frame (e.g. "CoreFoundation", "libsystem_kernel.dylib"). Useful when the symbol is an unsymbolicated hex address. */
  binary?: string;
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
  /**
   * Disambiguates empty arrays into "no data in the trace" vs "trace
   * could not be exported" vs "data was exported partially". Agents
   * should branch on this rather than `totalSamples === 0`.
   */
  status: DataStatus;
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
      status: "not_present",
    };
  }

  const rows: SampleEntry[] = [];
  const symbolCounts = new Map<string, number>();
  for (const row of tp.rows) {
    const weight = asNumber(row.weight);
    const weightFmt = asFormatted(row.weight);
    // xctrace's time-profile schema names the backtrace column `stack`
    // (mnemonic), with the underlying engineering-type `backtrace`. The
    // parser keys cells by mnemonic, so the cell is at `row.stack`.
    //
    // The leaf frame's @_name attribute is the symbol when it could be
    // resolved (e.g. `_CFRunLoopRunSpecificWithOptions`) or a raw hex
    // address when unsymbolicated. In the unsymbolicated case we keep
    // the binary name (e.g. `libsystem_kernel.dylib`) so aggregations
    // still cluster by library instead of every sample being a unique
    // address. Pre-2026-05-15 the parser only read `@_fmt` so this whole
    // metadata was invisible and `topSymbols` was just the weight column
    // text repeating "1.00 ms" for every sample.
    const leafFrame = row.stack?.nested?.frame;
    const binary = leafFrame?.nested?.binary?.name;
    const frameName = leafFrame?.name;
    // Real Apple traces expose the symbol on the leaf frame's @_name; some
    // synthetic test fixtures use a dedicated <symbol> column instead. Try
    // the stack first, fall back to the dedicated column.
    const symbol =
      pickSymbol(frameName, binary) ?? asFormatted(row.symbol) ?? undefined;
    const threadName = row.thread?.fmt ?? undefined;
    rows.push({
      weight,
      weightFmt,
      ...(symbol ? { symbol } : {}),
      ...(binary ? { binary } : {}),
      ...(threadName ? { threadName } : {}),
    });
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
    status: "available",
  };
}

/**
 * Pick the most useful identifier for a sample given the leaf frame name +
 * binary. Resolved symbol wins; otherwise we cluster by binary so the
 * aggregation is still meaningful for unsymbolicated traces.
 */
function pickSymbol(
  frameName: string | undefined,
  binary: string | undefined,
): string | undefined {
  if (frameName && !/^0x[0-9a-f]+$/i.test(frameName)) return frameName;
  if (binary) return frameName ? `${binary} (${frameName})` : binary;
  return frameName;
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
  const { "time-profile": schemaName } = await fetchDiscoveredSchemas(
    runCommand,
    tracePath,
    ["time-profile"] as const,
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
        status: "not_exportable",
      };
    }
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeTimeProfileFromXml(result.stdout, tracePath, input.topN ?? 20);
}
