import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  analyzeHangs,
  type AnalyzeHangsResult,
} from "./analyzeHangs.js";
import {
  analyzeAnimationHitches,
  type AnalyzeAnimationHitchesResult,
} from "./analyzeAnimationHitches.js";
import {
  analyzeAppLaunch,
  type AnalyzeAppLaunchResult,
} from "./analyzeAppLaunch.js";
import type { NextCallSuggestion } from "../types.js";

/**
 * Trace-side counterpart to `verifyFix` (which works on `.memgraph`).
 * Compares before/after `.trace` bundles for a specific perf category
 * (hangs, animation-hitches, app-launch) and returns a per-category
 * PASS/PARTIAL/FAIL verdict + numerical deltas.
 *
 * Designed for CI gating: a build script can run a hangs-fix PR's
 * before/after traces through this tool and fail the merge if the
 * regression target isn't met.
 *
 * Composes with the underlying analyzers — same data shape, just
 * surfaced as a diff.
 */

export const compareTracesByPatternSchema = z.object({
  before: z
    .string()
    .min(1)
    .describe("Absolute path to the baseline `.trace` (pre-fix)."),
  after: z
    .string()
    .min(1)
    .describe("Absolute path to the post-fix `.trace`."),
  category: z
    .enum(["hangs", "animation-hitches", "app-launch"])
    .describe(
      "Which perf category to verify. `hangs` parses the `potential-hangs` schema, `animation-hitches` parses `animation-hitches`, `app-launch` parses the launch breakdown.",
    ),
  thresholds: z
    .object({
      hangsMaxLongestMs: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "For `category: hangs` — PASS requires `after.longestMs <= this`. Default 0 (i.e. PASS only when no hangs remain).",
        ),
      hitchesMaxLongestMs: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "For `category: animation-hitches` — PASS requires `after.longestMs <= this`. Default 100 (Apple's user-perceptible threshold).",
        ),
      appLaunchMaxTotalMs: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "For `category: app-launch` — PASS requires `after.totalMs <= this`. Default 1000 (1 second total cold-launch budget).",
        ),
    })
    .optional()
    .default({}),
  hangsMinDurationMs: z
    .number()
    .nonnegative()
    .default(250)
    .describe(
      "For `category: hangs` — only count hangs longer than this. Default 250ms (Apple's user-perceptible threshold for hangs).",
    ),
  hitchesMinDurationMs: z
    .number()
    .nonnegative()
    .default(100)
    .describe(
      "For `category: animation-hitches` — only count hitches longer than this. Default 100ms (Apple's user-perceptible threshold).",
    ),
});

export type CompareTracesByPatternInput = z.infer<
  typeof compareTracesByPatternSchema
>;

export type Verdict = "PASS" | "PARTIAL" | "FAIL";

export interface CategoryComparison {
  count: number;
  longestMs: number;
  averageMs: number;
  totalMs: number;
}

export interface CompareTracesByPatternResult {
  ok: boolean;
  before: string;
  after: string;
  category: "hangs" | "animation-hitches" | "app-launch";
  verdict: Verdict;
  beforeStats: CategoryComparison;
  afterStats: CategoryComparison;
  delta: {
    count: number;
    longestMs: number;
    averageMs: number;
    totalMs: number;
  };
  thresholdApplied: {
    field: string;
    value: number;
  };
  diagnosis: string;
  suggestedNextCalls?: NextCallSuggestion[];
}

/** Pure: build the comparison from two analyzer results. */
export function compareHangs(
  before: AnalyzeHangsResult,
  after: AnalyzeHangsResult,
  thresholdLongestMs: number,
): {
  beforeStats: CategoryComparison;
  afterStats: CategoryComparison;
  delta: CompareTracesByPatternResult["delta"];
  verdict: Verdict;
} {
  const beforeStats: CategoryComparison = {
    count: before.totals.hangs,
    longestMs: before.totals.longestMs,
    averageMs: before.totals.averageMs,
    totalMs: before.totals.totalDurationMs,
  };
  const afterStats: CategoryComparison = {
    count: after.totals.hangs,
    longestMs: after.totals.longestMs,
    averageMs: after.totals.averageMs,
    totalMs: after.totals.totalDurationMs,
  };
  const delta = {
    count: afterStats.count - beforeStats.count,
    longestMs: afterStats.longestMs - beforeStats.longestMs,
    averageMs: afterStats.averageMs - beforeStats.averageMs,
    totalMs: afterStats.totalMs - beforeStats.totalMs,
  };
  const verdict = decideVerdict({
    beforeCount: beforeStats.count,
    afterCount: afterStats.count,
    afterLongestMs: afterStats.longestMs,
    thresholdLongestMs,
  });
  return { beforeStats, afterStats, delta, verdict };
}

/** Pure: same shape as `compareHangs` for animation-hitches. */
export function compareAnimationHitches(
  before: AnalyzeAnimationHitchesResult,
  after: AnalyzeAnimationHitchesResult,
  thresholdLongestMs: number,
): {
  beforeStats: CategoryComparison;
  afterStats: CategoryComparison;
  delta: CompareTracesByPatternResult["delta"];
  verdict: Verdict;
} {
  // For animation-hitches, "count" reflects user-perceptible hitches (>100ms)
  // — the metric users actually feel. The schema's `rows` field is total
  // hitches including the imperceptible ones.
  const beforeStats: CategoryComparison = {
    count: before.totals.perceptible,
    longestMs: before.totals.longestMs,
    averageMs: before.totals.averageMs,
    totalMs: before.totals.totalDurationMs,
  };
  const afterStats: CategoryComparison = {
    count: after.totals.perceptible,
    longestMs: after.totals.longestMs,
    averageMs: after.totals.averageMs,
    totalMs: after.totals.totalDurationMs,
  };
  const delta = {
    count: afterStats.count - beforeStats.count,
    longestMs: afterStats.longestMs - beforeStats.longestMs,
    averageMs: afterStats.averageMs - beforeStats.averageMs,
    totalMs: afterStats.totalMs - beforeStats.totalMs,
  };
  const verdict = decideVerdict({
    beforeCount: beforeStats.count,
    afterCount: afterStats.count,
    afterLongestMs: afterStats.longestMs,
    thresholdLongestMs,
  });
  return { beforeStats, afterStats, delta, verdict };
}

/** Pure: app-launch comparison. The "count" field reflects launch-event count
 *  (typically 1 per trace); the meaningful number is `totalMs`. */
export function compareAppLaunch(
  before: AnalyzeAppLaunchResult,
  after: AnalyzeAppLaunchResult,
  thresholdTotalMs: number,
): {
  beforeStats: CategoryComparison;
  afterStats: CategoryComparison;
  delta: CompareTracesByPatternResult["delta"];
  verdict: Verdict;
} {
  const beforeStats: CategoryComparison = {
    count: 1,
    longestMs: before.totalLaunchMs,
    averageMs: before.totalLaunchMs,
    totalMs: before.totalLaunchMs,
  };
  const afterStats: CategoryComparison = {
    count: 1,
    longestMs: after.totalLaunchMs,
    averageMs: after.totalLaunchMs,
    totalMs: after.totalLaunchMs,
  };
  const delta = {
    count: 0,
    longestMs: afterStats.longestMs - beforeStats.longestMs,
    averageMs: afterStats.averageMs - beforeStats.averageMs,
    totalMs: afterStats.totalMs - beforeStats.totalMs,
  };
  // Verdict semantics for app-launch differ: it's about absolute totalMs
  // crossing the threshold, not "did the count drop".
  let verdict: Verdict;
  if (afterStats.totalMs <= thresholdTotalMs) {
    verdict = "PASS";
  } else if (afterStats.totalMs < beforeStats.totalMs) {
    verdict = "PARTIAL";
  } else {
    verdict = "FAIL";
  }
  return { beforeStats, afterStats, delta, verdict };
}

/** Shared verdict logic for hangs + hitches. */
function decideVerdict({
  beforeCount,
  afterCount,
  afterLongestMs,
  thresholdLongestMs,
}: {
  beforeCount: number;
  afterCount: number;
  afterLongestMs: number;
  thresholdLongestMs: number;
}): Verdict {
  // PASS: nothing left above the threshold.
  if (afterCount === 0 || afterLongestMs <= thresholdLongestMs) {
    return "PASS";
  }
  // PARTIAL: still present but reduced from before.
  if (afterCount < beforeCount) {
    return "PARTIAL";
  }
  // FAIL: same or worse.
  return "FAIL";
}

function buildDiagnosis(
  category: CompareTracesByPatternInput["category"],
  beforeStats: CategoryComparison,
  afterStats: CategoryComparison,
  verdict: Verdict,
  thresholdField: string,
  thresholdValue: number,
): string {
  const verb =
    category === "hangs"
      ? "hangs"
      : category === "animation-hitches"
        ? "hitches"
        : "launch time";
  if (verdict === "PASS") {
    if (category === "app-launch") {
      return `Launch time fell to ${afterStats.totalMs.toFixed(0)}ms (was ${beforeStats.totalMs.toFixed(0)}ms), within the ${thresholdValue}ms budget. PASS.`;
    }
    if (afterStats.count === 0) {
      return `All ${verb} resolved (was ${beforeStats.count}, now 0). PASS.`;
    }
    return `${verb} reduced to ${afterStats.count} (was ${beforeStats.count}); longest ${afterStats.longestMs.toFixed(0)}ms is below the ${thresholdValue}ms threshold. PASS.`;
  }
  if (verdict === "PARTIAL") {
    return `${verb}: ${beforeStats.count}→${afterStats.count} count, ${beforeStats.longestMs.toFixed(0)}ms→${afterStats.longestMs.toFixed(0)}ms longest. Reduced but still above the ${thresholdValue}ms threshold. PARTIAL.`;
  }
  return `${verb}: ${beforeStats.count}→${afterStats.count} count, ${beforeStats.longestMs.toFixed(0)}ms→${afterStats.longestMs.toFixed(0)}ms longest. No improvement vs. before. FAIL — the fix did not address the regression.`;
}

export async function compareTracesByPattern(
  input: CompareTracesByPatternInput,
): Promise<CompareTracesByPatternResult> {
  const beforePath = resolvePath(input.before);
  const afterPath = resolvePath(input.after);
  if (!existsSync(beforePath)) {
    throw new Error(`Trace bundle not found: ${beforePath}`);
  }
  if (!existsSync(afterPath)) {
    throw new Error(`Trace bundle not found: ${afterPath}`);
  }

  const t = input.thresholds ?? {};

  if (input.category === "hangs") {
    const threshold = t.hangsMaxLongestMs ?? 0;
    const [b, a] = await Promise.all([
      analyzeHangs({
        tracePath: beforePath,
        topN: 10,
        minDurationMs: input.hangsMinDurationMs ?? 250,
      }),
      analyzeHangs({
        tracePath: afterPath,
        topN: 10,
        minDurationMs: input.hangsMinDurationMs ?? 250,
      }),
    ]);
    const cmp = compareHangs(b, a, threshold);
    const diagnosis = buildDiagnosis(
      "hangs",
      cmp.beforeStats,
      cmp.afterStats,
      cmp.verdict,
      "hangsMaxLongestMs",
      threshold,
    );
    return {
      ok: true,
      before: beforePath,
      after: afterPath,
      category: "hangs",
      verdict: cmp.verdict,
      beforeStats: cmp.beforeStats,
      afterStats: cmp.afterStats,
      delta: cmp.delta,
      thresholdApplied: { field: "hangsMaxLongestMs", value: threshold },
      diagnosis,
      ...(cmp.verdict !== "PASS"
        ? {
            suggestedNextCalls: [
              {
                tool: "analyzeHangs",
                args: { tracePath: afterPath, minDurationMs: 250 },
                why: "Inspect the remaining post-fix hangs to identify which call sites still need attention.",
              },
            ],
          }
        : {}),
    };
  }

  if (input.category === "animation-hitches") {
    const threshold = t.hitchesMaxLongestMs ?? 100;
    const [b, a] = await Promise.all([
      analyzeAnimationHitches({
        tracePath: beforePath,
        topN: 10,
        minDurationMs: input.hitchesMinDurationMs ?? 100,
      }),
      analyzeAnimationHitches({
        tracePath: afterPath,
        topN: 10,
        minDurationMs: input.hitchesMinDurationMs ?? 100,
      }),
    ]);
    const cmp = compareAnimationHitches(b, a, threshold);
    const diagnosis = buildDiagnosis(
      "animation-hitches",
      cmp.beforeStats,
      cmp.afterStats,
      cmp.verdict,
      "hitchesMaxLongestMs",
      threshold,
    );
    return {
      ok: true,
      before: beforePath,
      after: afterPath,
      category: "animation-hitches",
      verdict: cmp.verdict,
      beforeStats: cmp.beforeStats,
      afterStats: cmp.afterStats,
      delta: cmp.delta,
      thresholdApplied: { field: "hitchesMaxLongestMs", value: threshold },
      diagnosis,
      ...(cmp.verdict !== "PASS"
        ? {
            suggestedNextCalls: [
              {
                tool: "analyzeAnimationHitches",
                args: { tracePath: afterPath, minDurationMs: 100 },
                why: "Identify which views still hitch in the post-fix trace.",
              },
            ],
          }
        : {}),
    };
  }

  // app-launch
  const threshold = t.appLaunchMaxTotalMs ?? 1000;
  const [b, a] = await Promise.all([
    analyzeAppLaunch({ tracePath: beforePath }),
    analyzeAppLaunch({ tracePath: afterPath }),
  ]);
  const cmp = compareAppLaunch(b, a, threshold);
  const diagnosis = buildDiagnosis(
    "app-launch",
    cmp.beforeStats,
    cmp.afterStats,
    cmp.verdict,
    "appLaunchMaxTotalMs",
    threshold,
  );
  return {
    ok: true,
    before: beforePath,
    after: afterPath,
    category: "app-launch",
    verdict: cmp.verdict,
    beforeStats: cmp.beforeStats,
    afterStats: cmp.afterStats,
    delta: cmp.delta,
    thresholdApplied: { field: "appLaunchMaxTotalMs", value: threshold },
    diagnosis,
    ...(cmp.verdict !== "PASS"
      ? {
          suggestedNextCalls: [
            {
              tool: "analyzeAppLaunch",
              args: { tracePath: afterPath },
              why: "Find which launch phase (process-creation / dyld / ObjC-init / AppDelegate / first-frame) still dominates the post-fix launch.",
            },
          ],
        }
      : {}),
  };
}
