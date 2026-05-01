import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly, walkCycles } from "../parsers/leaksOutput.js";
import {
  shortenForVerbosity,
  type Verbosity,
} from "../parsers/shortenClassName.js";
import { classifyReport } from "./classifyCycle.js";
import { countByClass } from "./countAlive.js";
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

export async function verifyFix(input: VerifyFixInput): Promise<VerifyFixResult> {
  const [
    { report: beforeReport, resolvedPath: bp },
    { report: afterReport, resolvedPath: ap },
  ] = await Promise.all([
    runLeaksAndParse(input.before),
    runLeaksAndParse(input.after),
  ]);
  return verifyFromReports(beforeReport, afterReport, bp, ap, input);
}
