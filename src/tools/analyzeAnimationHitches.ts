import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";

export const analyzeAnimationHitchesSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with the Animation Hitches template (`xcrun xctrace record --template 'Animation Hitches' --attach <app|pid>`).",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Return the top N longest hitches in the response (default 10)."),
  minDurationMs: z
    .number()
    .nonnegative()
    .default(0)
    .describe(
      "Filter out hitches shorter than this duration in milliseconds. Apple categorizes hitches >100ms as user-perceptible — pass 100 to focus on those.",
    ),
});

export type AnalyzeAnimationHitchesInput = z.infer<
  typeof analyzeAnimationHitchesSchema
>;

export interface HitchEntry {
  startNs: number;
  startFmt: string;
  durationNs: number;
  durationMs: number;
  durationFmt: string;
  hitchType: string;
  /** Short identifier for the source (CommitTime, RenderServerCommit, etc.) when present. */
  source?: string;
}

export interface AnalyzeAnimationHitchesResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    totalDurationMs: number;
    longestMs: number;
    averageMs: number;
    /** Hitches above 100ms (user-perceptible per Apple's framing). */
    perceptible: number;
  };
  byType: Record<string, number>;
  top: HitchEntry[];
  diagnosis: string;
}

const PERCEPTIBLE_MS = 100;

/** Pure: turn parsed XML into the analyzed result. */
export function analyzeAnimationHitchesFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
  minDurationMs = 0,
): AnalyzeAnimationHitchesResult {
  const tables = parseXctraceXml(xml);
  const table = tables.find((t) => t.schema === "animation-hitches");
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        totalDurationMs: 0,
        longestMs: 0,
        averageMs: 0,
        perceptible: 0,
      },
      byType: {},
      top: [],
      diagnosis: "No animation-hitches table found in the trace.",
    };
  }

  const all: HitchEntry[] = [];
  for (const row of table.rows) {
    const startNs = asNumber(row.start) ?? 0;
    const durationNs = asNumber(row.duration) ?? 0;
    all.push({
      startNs,
      startFmt: asFormatted(row.start) ?? "",
      durationNs,
      durationMs: durationNs / 1_000_000,
      durationFmt: asFormatted(row.duration) ?? "",
      hitchType:
        asFormatted(row["hitch-type"]) ??
        asFormatted(row.type) ??
        "unknown",
      source: asFormatted(row.source),
    });
  }

  const filtered = all.filter((e) => e.durationMs >= minDurationMs);
  const byType: Record<string, number> = {};
  for (const e of filtered) {
    byType[e.hitchType] = (byType[e.hitchType] ?? 0) + 1;
  }
  const totalDurationMs = filtered.reduce((sum, e) => sum + e.durationMs, 0);
  const longestMs = filtered.reduce((m, e) => Math.max(m, e.durationMs), 0);
  const averageMs = filtered.length > 0 ? totalDurationMs / filtered.length : 0;
  const perceptible = filtered.filter((e) => e.durationMs >= PERCEPTIBLE_MS).length;
  const top = [...filtered]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, topN);

  const diagnosis = buildDiagnosis(filtered.length, perceptible, longestMs, averageMs);

  return {
    ok: true,
    tracePath,
    totals: {
      rows: filtered.length,
      totalDurationMs,
      longestMs,
      averageMs,
      perceptible,
    },
    byType,
    top,
    diagnosis,
  };
}

function buildDiagnosis(
  rows: number,
  perceptible: number,
  longestMs: number,
  averageMs: number,
): string {
  if (rows === 0) {
    return "No animation hitches detected (or all filtered out by minDurationMs).";
  }
  const parts: string[] = [];
  parts.push(`${rows} hitches (${perceptible} user-perceptible, >100ms).`);
  parts.push(`Longest: ${longestMs.toFixed(0)}ms, average: ${averageMs.toFixed(0)}ms.`);
  if (perceptible >= 5) {
    parts.push("Severe hitch load — investigate main-thread work during animation frames.");
  } else if (longestMs > 250) {
    parts.push("At least one >250ms hitch — likely visible stutter on user paths.");
  }
  return parts.join(" ");
}

export async function analyzeAnimationHitches(
  input: AnalyzeAnimationHitchesInput,
): Promise<AnalyzeAnimationHitchesResult> {
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
      '/trace-toc/run/data/table[@schema="animation-hitches"]',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeAnimationHitchesFromXml(
    result.stdout,
    tracePath,
    input.topN ?? 10,
    input.minDurationMs ?? 0,
  );
}
