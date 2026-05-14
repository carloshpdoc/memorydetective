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
});

export type AnalyzeHangsInput = z.infer<typeof analyzeHangsSchema>;

export interface HangEntry {
  startNs: number;
  startFmt: string;
  durationNs: number;
  durationMs: number;
  durationFmt: string;
  hangType: string;
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
  );
}
