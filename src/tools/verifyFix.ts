import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly, walkCycles } from "../parsers/leaksOutput.js";
import {
  shortenForVerbosity,
  type Verbosity,
} from "../parsers/shortenClassName.js";
import { classifyReport } from "./classifyCycle.js";
import { countByClass } from "./countAlive.js";
import {
  analyzeAbandonedMemory,
  type AbandonedMemoryEntry,
} from "./analyzeAbandonedMemory.js";
import type { LeaksReport, NextCallSuggestion } from "../types.js";

/**
 * Cycle-semantic diff. Answers: "did the antipattern I targeted actually
 * resolve, and how many instances/bytes were freed?"
 *
 * Where `diffMemgraphs` returns a structural diff (new/gone/persisted
 * cycle signatures + class-count deltas), `verifyFix` returns a
 * **classifier-aware** diff: each known antipattern is checked for in
 * both snapshots, and a per-pattern PASS/FAIL verdict is emitted along
 * with the bytes freed and instances released.
 *
 * Designed for CI gating: a build script can check `overallVerdict` and
 * fail the merge if the pattern resolved by the PR has regressed.
 */

/**
 * v1.14 item M. Default list of classes that legitimately stay alive
 * across before/after snapshots in normal iOS app activity. Sourced from
 * DebugSwift's `Performance.LeakDetector.swift` `_ignoredViewControllerClassNames`,
 * `_ignoredViewClassNames`, and `_ignoredWindowClassNames` curated lists
 * (FLEXTool fork lineage via Janneman84/LeakedViewControllerDetector).
 *
 * When these appear in `regressionClasses[]` we surface them under
 * `expectedAlive[]` for transparency but don't let them flip the verdict
 * to FAIL. Users can extend via `expectedAliveClasses` input or disable
 * with `disableDefaultWhitelist: true` for strict matching.
 */
export const DEFAULT_EXPECTED_ALIVE_CLASSES: readonly string[] = [
  // ViewControllers Apple keeps alive for system functions.
  "UICompatibilityInputViewController",
  "_SFAppPasswordSavingViewController",
  "UIKeyboardHiddenViewController_Save",
  "_UIAlertControllerTextFieldViewController",
  "UISystemInputAssistantViewController",
  "UIPredictionViewController",
  // Internal views with persistent backing.
  "PLTileContainerView",
  "CAMPreviewView",
  "_UIPointerInteractionAssistantEffectContainerView",
  // Windows the OS retains.
  "UIRemoteKeyboardWindow",
  "UITextEffectsWindow",
];

export const verifyFixSchema = z.object({
  before: z
    .string()
    .min(1)
    .describe("Absolute path to the baseline `.memgraph` (pre-fix)."),
  after: z
    .string()
    .min(1)
    .describe("Absolute path to the post-fix `.memgraph`."),
  expectedPatternId: z
    .string()
    .optional()
    .describe(
      "If provided, the verdict is gated on whether this specific patternId disappeared from `after`. Defaults to checking every classified pattern.",
    ),
  expectedAliveClasses: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "v1.14+. Class names (substrings) that legitimately stay alive across the before/after snapshots. Singletons, framework registrars, persistent caches. When a class in this list appears in regressionClasses[], it is moved to expectedAlive[] and does not flip the verdict to FAIL. Merged with the curated default list (DebugSwift's ignoredViewControllerClassNames + ignoredViewClassNames + ignoredWindowClassNames) unless `disableDefaultWhitelist: true`.",
    ),
  disableDefaultWhitelist: z
    .boolean()
    .default(false)
    .describe(
      "v1.14+. When true, the curated DEFAULT_EXPECTED_ALIVE_CLASSES list is NOT applied. Only the user-supplied expectedAliveClasses (if any) is used. Useful for strict regression mode in tests where every alive class should be evaluated.",
    ),
  verbosity: z
    .enum(["compact", "normal", "full"])
    .default("compact"),
});

export type VerifyFixInput = z.infer<typeof verifyFixSchema>;

export interface PatternResolution {
  patternId: string;
  before: { count: number; rootAddresses: string[] };
  after: { count: number; rootAddresses: string[] };
  /** PASS = pattern entirely gone from `after`. PARTIAL = present but reduced. FAIL = same or more. */
  verdict: "PASS" | "PARTIAL" | "FAIL";
  /** Estimated bytes freed (sum of `instanceSize` across nodes in the disappeared cycles). */
  bytesFreed: number;
  /** Class-level instance count changes for classes that appeared in this pattern's cycles. */
  instancesFreed: Record<string, number>;
}

export interface VerifyFixResult {
  ok: boolean;
  before: { path: string; leakCount: number; totalBytes: number };
  after: { path: string; leakCount: number; totalBytes: number };
  totals: {
    leakCountDelta: number;
    bytesDelta: number;
  };
  patternResolution: PatternResolution[];
  /** Top-line verdict. PASS = everything resolved or improved. FAIL = at least one pattern got worse. PARTIAL = mixed. */
  overallVerdict: "PASS" | "PARTIAL" | "FAIL";
  /** When the user supplied `expectedPatternId`, this is the verdict for that one specifically. */
  expectedPatternVerdict?: PatternResolution["verdict"];
  diagnosis: string;
  suggestedNextCalls?: NextCallSuggestion[];
  /**
   * v1.12+. Where the overall verdict came from. `cycle-pattern` is the
   * v1.11 behavior (classified cycles). `abandoned-memory` is the new
   * fallback path: when zero cycle patterns fire on either side,
   * verifyFix internally chains into `analyzeAbandonedMemory` and bases
   * the verdict on `actionableShrinkage` / `actionableGrowth` instead.
   * Branch on this field if you need to know which signal the verdict
   * is based on.
   */
  verdictSource?: "cycle-pattern" | "abandoned-memory";
  /**
   * v1.12+. Populated when `verdictSource` is `abandoned-memory` and the
   * fix freed at least one actionable class. The top-N entries (by
   * absolute delta) of `analyzeAbandonedMemory.actionableShrinkage[]`.
   */
  freedClasses?: AbandonedMemoryEntry[];
  /**
   * v1.12+. Populated when `verdictSource` is `abandoned-memory` and
   * something grew between the snapshots (regression or unrelated). Top-N
   * entries of `analyzeAbandonedMemory.actionableGrowth[]`.
   */
  regressionClasses?: AbandonedMemoryEntry[];
  /**
   * v1.14+. Class names from the effective whitelist
   * (DEFAULT_EXPECTED_ALIVE_CLASSES + user-supplied) that DID appear in
   * the raw regression set before filtering. Surfaced for transparency:
   * the agent can see which "regressions" were intentionally ignored.
   * Empty array when nothing was filtered. Absent when no fallback ran.
   */
  expectedAlive?: string[];
}

interface CycleByPattern {
  patternId: string;
  rootAddress: string;
  bytes: number;
  classCounts: Map<string, number>;
}

function classifyAndIndex(
  report: LeaksReport,
  verbosity: Verbosity,
): Map<string, CycleByPattern[]> {
  const out = new Map<string, CycleByPattern[]>();
  const { classified } = classifyReport(report, 100);
  const roots = rootCyclesOnly(report.cycles);

  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    const root = roots[i];
    if (!c.primaryMatch || !root) continue;

    let bytes = 0;
    const classCounts = new Map<string, number>();
    for (const { node } of walkCycles([root])) {
      if (typeof node.instanceSize === "number") bytes += node.instanceSize;
      if (node.className) {
        const short = shortenForVerbosity(node.className, verbosity);
        classCounts.set(short, (classCounts.get(short) ?? 0) + 1);
      }
    }

    const arr = out.get(c.primaryMatch.patternId) ?? [];
    arr.push({
      patternId: c.primaryMatch.patternId,
      rootAddress: root.address,
      bytes,
      classCounts,
    });
    out.set(c.primaryMatch.patternId, arr);
  }
  return out;
}

/** Pure function: compute verifyFix result from two parsed reports. */
export function verifyFromReports(
  beforeReport: LeaksReport,
  afterReport: LeaksReport,
  beforePath: string,
  afterPath: string,
  input: VerifyFixInput,
): VerifyFixResult {
  const verbosity = input.verbosity ?? "compact";
  const beforeByPattern = classifyAndIndex(beforeReport, verbosity);
  const afterByPattern = classifyAndIndex(afterReport, verbosity);

  const allIds = new Set<string>([
    ...beforeByPattern.keys(),
    ...afterByPattern.keys(),
  ]);

  const patternResolution: PatternResolution[] = [];
  let worstVerdict: PatternResolution["verdict"] = "PASS";

  for (const id of allIds) {
    const beforeArr = beforeByPattern.get(id) ?? [];
    const afterArr = afterByPattern.get(id) ?? [];

    const beforeBytes = beforeArr.reduce((s, c) => s + c.bytes, 0);
    const afterBytes = afterArr.reduce((s, c) => s + c.bytes, 0);
    const bytesFreed = Math.max(0, beforeBytes - afterBytes);

    // Compute per-class instance deltas across cycles of this pattern.
    const beforeClassTotals = new Map<string, number>();
    for (const c of beforeArr)
      for (const [cls, n] of c.classCounts) {
        beforeClassTotals.set(cls, (beforeClassTotals.get(cls) ?? 0) + n);
      }
    const afterClassTotals = new Map<string, number>();
    for (const c of afterArr)
      for (const [cls, n] of c.classCounts) {
        afterClassTotals.set(cls, (afterClassTotals.get(cls) ?? 0) + n);
      }
    const instancesFreed: Record<string, number> = {};
    for (const [cls, beforeN] of beforeClassTotals) {
      const afterN = afterClassTotals.get(cls) ?? 0;
      const delta = beforeN - afterN;
      if (delta > 0) instancesFreed[cls] = delta;
    }

    let verdict: PatternResolution["verdict"];
    if (afterArr.length === 0 && beforeArr.length > 0) verdict = "PASS";
    else if (afterArr.length < beforeArr.length) verdict = "PARTIAL";
    else if (afterArr.length === beforeArr.length && beforeArr.length === 0)
      verdict = "PASS"; // never present, never an issue
    else verdict = "FAIL"; // same or more

    patternResolution.push({
      patternId: id,
      before: {
        count: beforeArr.length,
        rootAddresses: beforeArr.map((c) => c.rootAddress),
      },
      after: {
        count: afterArr.length,
        rootAddresses: afterArr.map((c) => c.rootAddress),
      },
      verdict,
      bytesFreed,
      instancesFreed,
    });

    if (verdict === "FAIL") worstVerdict = "FAIL";
    else if (verdict === "PARTIAL" && worstVerdict !== "FAIL")
      worstVerdict = "PARTIAL";
  }

  // Sort patternResolution: failures first, then partials, then passes; within
  // each group, descending bytesFreed so the impactful ones lead.
  const verdictRank = { FAIL: 0, PARTIAL: 1, PASS: 2 };
  patternResolution.sort((a, b) => {
    const v = verdictRank[a.verdict] - verdictRank[b.verdict];
    if (v !== 0) return v;
    return b.bytesFreed - a.bytesFreed;
  });

  const expectedPatternVerdict = input.expectedPatternId
    ? patternResolution.find((p) => p.patternId === input.expectedPatternId)
        ?.verdict ?? "PASS"
    : undefined;

  const diagnosis = buildDiagnosis(
    patternResolution,
    expectedPatternVerdict,
    input.expectedPatternId,
  );

  const suggestedNextCalls: NextCallSuggestion[] = [];
  const failures = patternResolution.filter((p) => p.verdict === "FAIL");
  if (failures.length > 0) {
    suggestedNextCalls.push({
      tool: "classifyCycle",
      args: { path: afterPath },
      why: `${failures.length} pattern(s) regressed. Re-classify the after-snapshot to inspect remaining cycles.`,
    });
  }

  return {
    ok: true,
    before: {
      path: beforePath,
      leakCount: beforeReport.totals.leakCount,
      totalBytes: beforeReport.totals.totalLeakedBytes,
    },
    after: {
      path: afterPath,
      leakCount: afterReport.totals.leakCount,
      totalBytes: afterReport.totals.totalLeakedBytes,
    },
    totals: {
      leakCountDelta:
        afterReport.totals.leakCount - beforeReport.totals.leakCount,
      bytesDelta:
        afterReport.totals.totalLeakedBytes -
        beforeReport.totals.totalLeakedBytes,
    },
    patternResolution,
    overallVerdict: worstVerdict,
    ...(expectedPatternVerdict
      ? { expectedPatternVerdict }
      : {}),
    diagnosis,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}

function buildDiagnosis(
  resolutions: PatternResolution[],
  expectedVerdict: PatternResolution["verdict"] | undefined,
  expectedId: string | undefined,
): string {
  if (resolutions.length === 0) {
    return "No classified patterns in either snapshot.";
  }
  const fails = resolutions.filter((r) => r.verdict === "FAIL");
  const partials = resolutions.filter((r) => r.verdict === "PARTIAL");
  const passes = resolutions.filter((r) => r.verdict === "PASS");
  const totalBytesFreed = resolutions.reduce(
    (s, r) => s + r.bytesFreed,
    0,
  );

  const parts: string[] = [];
  parts.push(
    `${passes.length} pass · ${partials.length} partial · ${fails.length} fail.`,
  );
  if (totalBytesFreed > 0) {
    parts.push(
      `Freed approximately ${(totalBytesFreed / 1024).toFixed(1)} KB across resolved cycles.`,
    );
  }
  if (expectedId) {
    parts.push(
      `Targeted pattern \`${expectedId}\`: ${expectedVerdict ?? "not present in either snapshot"}.`,
    );
  }
  if (fails.length > 0) {
    parts.push(
      `Regressions: ${fails.map((f) => f.patternId).slice(0, 3).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

/**
 * Threshold below which a class-count change is treated as cosmetic
 * noise and excluded from the abandoned-memory verdict. Mirrors the
 * threshold used by the `verify-fix-table` markdown renderer in
 * `responseFormatter.renderVerifyFixTable`.
 */
const ACTIONABLE_DELTA_THRESHOLD = 10;

/** Cap on freedClasses[] / regressionClasses[] length on the response.
 *  100 is large enough that the magnitude check below sees a representative
 *  slice of the deltas, not just the top-25 outliers. The response is
 *  capped further by callers if they pass through `formatMcpResponse`. */
const ABANDONED_MEMORY_TOPN = 100;

/**
 * v1.12 fallback path: when classified-cycle data is absent from BOTH
 * snapshots, the v1.11 verifyFix returned `overallVerdict: "PASS"` with
 * no patterns. Useless for the user. Now we chain into
 * `analyzeAbandonedMemory` and emit a verdict based on heap-wide class
 * deltas:
 *
 * - At least one actionableShrinkage entry with |delta| >= 10 AND
 *   actionableGrowth empty (or below threshold): PASS with freedClasses.
 * - actionableGrowth non-empty AND actionableShrinkage below threshold:
 *   FAIL with regressionClasses.
 * - Both non-empty above threshold: PARTIAL with both.
 * - Both empty / below threshold: PASS with empty freedClasses (clean
 *   state, no measurable change).
 *
 * Returns null when even the abandoned-memory path can't run (paths
 * inaccessible, etc.); the caller falls back to the cycle-pattern result.
 */
/**
 * Build the effective expected-alive whitelist by merging the curated
 * default list (unless disabled) with the user-supplied set. Returns a
 * lowercase Set for case-insensitive substring matching. v1.14.
 */
function buildExpectedAliveSet(
  userSupplied: readonly string[] | undefined,
  disableDefault: boolean,
): Set<string> {
  const base = disableDefault ? [] : DEFAULT_EXPECTED_ALIVE_CLASSES;
  const all = [...base, ...(userSupplied ?? [])];
  return new Set(all.map((s) => s.toLowerCase()));
}

/**
 * Returns true when the className matches any entry in the whitelist
 * (substring match, case-insensitive). v1.14.
 */
function isExpectedAlive(
  className: string,
  whitelist: Set<string>,
): boolean {
  if (whitelist.size === 0) return false;
  const lc = className.toLowerCase();
  for (const w of whitelist) if (lc.includes(w)) return true;
  return false;
}

async function buildAbandonedMemoryFallback(
  beforePath: string,
  afterPath: string,
  expectedAliveWhitelist: Set<string>,
): Promise<
  | {
      verdict: "PASS" | "PARTIAL" | "FAIL";
      freedClasses: AbandonedMemoryEntry[];
      regressionClasses: AbandonedMemoryEntry[];
      expectedAlive: string[];
      diagnosis: string;
    }
  | null
> {
  let amResult: Awaited<ReturnType<typeof analyzeAbandonedMemory>>;
  try {
    amResult = await analyzeAbandonedMemory({
      beforePath,
      afterPath,
      topN: ABANDONED_MEMORY_TOPN,
    });
  } catch {
    return null;
  }
  const freedClasses = (amResult.actionableShrinkage ?? []).filter(
    (e) => Math.abs(e.delta) >= ACTIONABLE_DELTA_THRESHOLD,
  );
  // Partition raw regression set into "really regressed" vs "in the
  // expected-alive whitelist" so the verdict ignores the latter while
  // surfacing them on the response for transparency.
  const rawRegressions = (amResult.actionableGrowth ?? []).filter(
    (e) => Math.abs(e.delta) >= ACTIONABLE_DELTA_THRESHOLD,
  );
  const regressionClasses: AbandonedMemoryEntry[] = [];
  const expectedAlive: string[] = [];
  for (const entry of rawRegressions) {
    if (isExpectedAlive(entry.className, expectedAliveWhitelist)) {
      expectedAlive.push(entry.className);
    } else {
      regressionClasses.push(entry);
    }
  }
  // Magnitude check: a fix that frees thousands of instances and incidentally
  // grows a hundred Swift Metadata / pthread_mutex_t / ObjC class table
  // entries (these scale with app activity, not user code) should be PASS,
  // not PARTIAL. The magnitude ratio decides:
  //
  // - freed magnitude >= 3x growth magnitude: PASS with a residual-growth note
  // - growth magnitude >= 3x freed magnitude: FAIL
  // - otherwise: PARTIAL
  //
  // Threshold of 2x is moderate; the notelet case has ratios above 2x
  // because the fix freed ~8k actionable instances while the residual
  // growth (Swift runtime + font cache + ObjC class table that scale
  // with app activity, not user code) is ~3-4k. Tighter than 2x would
  // demand near-perfect cleanups; looser would call ambiguous mixed
  // results as PASS.
  const freedMagnitude = freedClasses.reduce(
    (s, e) => s + Math.abs(e.delta),
    0,
  );
  const growthMagnitude = regressionClasses.reduce(
    (s, e) => s + Math.abs(e.delta),
    0,
  );
  const MAGNITUDE_DOMINANCE_RATIO = 2;

  let verdict: "PASS" | "PARTIAL" | "FAIL";
  let diagnosis: string;
  if (freedClasses.length > 0 && regressionClasses.length === 0) {
    verdict = "PASS";
    const topFreed = freedClasses[0];
    diagnosis = `Fix verified via abandoned-memory shrinkage: ${freedClasses.length} class${freedClasses.length === 1 ? "" : "es"} freed, leading with \`${topFreed.className}\` (${topFreed.delta}).`;
  } else if (freedClasses.length === 0 && regressionClasses.length > 0) {
    verdict = "FAIL";
    const topGrew = regressionClasses[0];
    diagnosis = `Regression detected: ${regressionClasses.length} class${regressionClasses.length === 1 ? "" : "es"} grew, leading with \`${topGrew.className}\` (+${topGrew.delta}). No actionable shrinkage to balance it.`;
  } else if (freedClasses.length > 0 && regressionClasses.length > 0) {
    if (freedMagnitude >= growthMagnitude * MAGNITUDE_DOMINANCE_RATIO) {
      verdict = "PASS";
      const topFreed = freedClasses[0];
      diagnosis = `Fix verified via abandoned-memory shrinkage: ${freedMagnitude.toLocaleString()} instances freed dominates the residual ${growthMagnitude.toLocaleString()}-instance growth (typically Swift runtime / font cache / ObjC class table that scales with app activity). Top freed: \`${topFreed.className}\` (${topFreed.delta}). The \`regressionClasses\` field carries the residual growth for inspection.`;
    } else if (
      growthMagnitude >= freedMagnitude * MAGNITUDE_DOMINANCE_RATIO
    ) {
      verdict = "FAIL";
      const topGrew = regressionClasses[0];
      diagnosis = `Regression: ${growthMagnitude.toLocaleString()}-instance growth dominates the ${freedMagnitude.toLocaleString()}-instance shrinkage. Top grew: \`${topGrew.className}\` (+${topGrew.delta}).`;
    } else {
      verdict = "PARTIAL";
      diagnosis = `Mixed result: ${freedClasses.length} class${freedClasses.length === 1 ? "" : "es"} freed (${freedMagnitude.toLocaleString()} instances) AND ${regressionClasses.length} grew (${growthMagnitude.toLocaleString()} instances). Neither side dominates; the fix may have addressed one path while introducing another, or the workflow exercised different code in the two snapshots.`;
    }
  } else {
    verdict = "PASS";
    diagnosis =
      "No actionable class-count changes between snapshots (|delta| < 10). Either both snapshots are clean or the workflow did not exercise the targeted code.";
  }
  return { verdict, freedClasses, regressionClasses, expectedAlive, diagnosis };
}

export async function verifyFix(input: VerifyFixInput): Promise<VerifyFixResult> {
  const [
    { report: beforeReport, resolvedPath: bp },
    { report: afterReport, resolvedPath: ap },
  ] = await Promise.all([
    runLeaksAndParse(input.before),
    runLeaksAndParse(input.after),
  ]);
  const result = verifyFromReports(beforeReport, afterReport, bp, ap, input);

  // v1.12 fallback: when the cycle-pattern path found zero patterns in
  // either snapshot, the result is informationally empty. Chain into
  // analyzeAbandonedMemory to produce a useful verdict instead. The
  // cycle-pattern path takes precedence when patterns DO fire, so this
  // is a strict fallback.
  if (result.patternResolution.length === 0) {
    const whitelist = buildExpectedAliveSet(
      input.expectedAliveClasses,
      input.disableDefaultWhitelist ?? false,
    );
    const fallback = await buildAbandonedMemoryFallback(
      input.before,
      input.after,
      whitelist,
    );
    if (fallback) {
      result.verdictSource = "abandoned-memory";
      result.freedClasses = fallback.freedClasses;
      result.regressionClasses = fallback.regressionClasses;
      result.expectedAlive = fallback.expectedAlive;
      result.overallVerdict = fallback.verdict;
      result.diagnosis = fallback.diagnosis;
    } else {
      result.verdictSource = "cycle-pattern";
    }
  } else {
    result.verdictSource = "cycle-pattern";
  }

  return result;
}
