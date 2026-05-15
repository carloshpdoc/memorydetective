/**
 * `summarizeTrace`: the trace-to-summary-card-in-one-call feature.
 *
 * Today an agent handed a `.trace` chains inspectTrace + up to 5
 * analyzers + reasons over tens of KB of JSON. That's 6 round-trips
 * and ~$0.10-0.20 in tokens, most of which get thrown away after the
 * agent identifies the one user-visible finding.
 *
 * summarizeTrace does it all in one call:
 *
 *  1. Inspects the TOC via inspectTrace (reuses the v1.11 path).
 *  2. For each populated known schema, runs the matching analyzer in
 *     parallel with smart defaults tuned for "what would a user care
 *     about?" (Apple's 100ms hitch threshold, top-10 hangs, top-15
 *     time-profile symbols, etc).
 *  3. Cross-correlates findings (v1.13 Phase 2): hangs overlapping
 *     with hitches, allocation spikes preceding hangs, etc.
 *  4. Produces a structured result PLUS a pre-rendered compact
 *     markdown card (< 10 KB target) suitable for direct presentation
 *     to the user without further reasoning.
 *
 * Strategic positioning: this is memorydetective's "synthesis over
 * raw-query" play vs trace-MCPs that go deep on single-schema access.
 * See `~/Desktop/internal/v1.9-notelet-retro-market.md` §4.5 for the
 * full framing.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath, basename } from "node:path";
import { inspectTrace, type InspectTraceResult } from "./inspectTrace.js";
import {
  analyzeHangs,
  type AnalyzeHangsResult,
} from "./analyzeHangs.js";
import {
  analyzeAnimationHitches,
  type AnalyzeAnimationHitchesResult,
} from "./analyzeAnimationHitches.js";
import {
  analyzeTimeProfile,
  type AnalyzeTimeProfileResult,
} from "./analyzeTimeProfile.js";
import {
  analyzeAllocations,
  type AnalyzeAllocationsResult,
} from "./analyzeAllocations.js";
import {
  analyzeAppLaunch,
  type AnalyzeAppLaunchResult,
} from "./analyzeAppLaunch.js";

export const summarizeTraceSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle (output of `xcrun xctrace record` or Instruments).",
    ),
  focus: z
    .enum(["hangs", "hitches", "allocations", "launch", "all"])
    .default("all")
    .describe(
      "When set to a specific area, the summary card emphasizes that area and downplays others. Useful for piping into more focused agent loops. Default `all`.",
    ),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      "When true, the markdown card includes the full top-N per area (15+ rows per section) instead of the default 5. Trade-off: card grows from <10 KB to potentially 30+ KB.",
    ),
});

export type SummarizeTraceInput = z.infer<typeof summarizeTraceSchema>;

/**
 * Per-analyzer entry on the structured result. `status` distinguishes
 * "ran successfully", "schema absent in trace", and "ran but failed".
 * Callers branching on the summary can decide whether to retry / refine.
 */
export interface SummarizeAreaSummary<TResult> {
  status: "ok" | "schema-absent" | "failed";
  /** Why the status is what it is (one sentence). Surfaces SIGSEGV / missing-schema / parser-error reasons. */
  diagnosis: string;
  /** Full analyzer result when status === "ok". Useful when a caller wants to drill in without re-running the analyzer. */
  result?: TResult;
}

/**
 * v1.13 Phase 2: cross-area correlation. Each entry is a finding
 * tying TWO areas together via timestamp overlap. The narrative
 * field is the human-scannable string that goes into the markdown
 * card; the structured fields (`kind`, `confidence`, evidence ids)
 * are what callers can branch on programmatically.
 */
export interface Correlation {
  /** Which two areas this correlation ties together. Currently only `hangs+hitches` is supported; `hangs+allocations` and `hitches+allocations` are deferred to v1.14+ because the analyzer doesn't currently expose per-timestamp allocation rows. */
  kind: "hangs+hitches";
  /** `high` when the overlap is substantial (both events > 100ms and the windows overlap significantly); `medium` when one event is short; `low` when timestamps are only adjacent. */
  confidence: "high" | "medium" | "low";
  /** Pre-formatted human-scannable narrative. Goes into the markdown card. */
  narrative: string;
  /** Start time in seconds (for the hang event). Used to rank correlations by user-relevance (earliest first). */
  atSec: number;
}

export interface SummarizeTraceResult {
  ok: boolean;
  tracePath: string;
  /** TOC + suggestedNextCalls from inspectTrace. Always present. */
  inspection: InspectTraceResult;
  /** Per-area summaries. Each section is independent; absence of one doesn't fail the call. */
  areas: {
    hangs: SummarizeAreaSummary<AnalyzeHangsResult>;
    hitches: SummarizeAreaSummary<AnalyzeAnimationHitchesResult>;
    timeProfile: SummarizeAreaSummary<AnalyzeTimeProfileResult>;
    allocations: SummarizeAreaSummary<AnalyzeAllocationsResult>;
    appLaunch: SummarizeAreaSummary<AnalyzeAppLaunchResult>;
  };
  /** Cross-area correlations (v1.13 Phase 2). Empty when areas don't have enough data to correlate. */
  correlations: Correlation[];
  /** Headline string: 1-2 sentences naming the biggest user-impact finding across all areas. */
  headline: string;
  /** Pre-rendered markdown summary card. Target < 10 KB at default `verbose: false`. */
  markdown: string;
}

const DEFAULT_HITCH_THRESHOLD_MS = 100; // Apple's user-perceptible threshold.
const DEFAULT_HANG_MIN_MS = 100;
const DEFAULT_TOP_N_HANGS = 10;
const DEFAULT_TOP_N_HITCHES = 10;
const DEFAULT_TOP_N_TIME_PROFILE = 15;
const DEFAULT_TOP_N_ALLOCATIONS = 10;

/**
 * Build a per-area summary by running an analyzer with smart defaults
 * and wrapping the outcome (success / schema-absent / failed) into a
 * status-tagged struct. The schema-absent branch reads the inspectTrace
 * `rowCounts` so we don't spawn xctrace for empty schemas.
 */
async function buildAreaSummary<TResult>(
  schemaName: string,
  inspection: InspectTraceResult,
  runner: () => Promise<TResult>,
  schemaAbsentDiagnosis: string,
): Promise<SummarizeAreaSummary<TResult>> {
  const rowCount = inspection.rowCounts[schemaName] ?? 0;
  if (rowCount === 0) {
    return {
      status: "schema-absent",
      diagnosis: schemaAbsentDiagnosis,
    };
  }
  try {
    const result = await runner();
    return {
      status: "ok",
      diagnosis: `${rowCount.toLocaleString()} rows analyzed.`,
      result,
    };
  } catch (err) {
    return {
      status: "failed",
      diagnosis: `Analyzer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Pure: detect hangs whose window overlaps with animation hitches.
 * When a user sees a hang AND a hitch in the same time window,
 * they almost certainly perceived the impact (the main-thread block
 * delayed render commits, dropping frames).
 *
 * The overlap check is symmetric: a hitch can fall within a hang's
 * window OR a hang can fall within a hitch's window. Both directions
 * are treated equally.
 *
 * Confidence:
 *
 * - `high`: both events >= 250ms AND the overlap span >= 100ms.
 * - `medium`: at least one event >= 250ms.
 * - `low`: neither event >= 250ms but the windows touch.
 *
 * Results are sorted by `atSec` ascending so the markdown card lists
 * correlations in trace order.
 */
export function correlateHangsAndHitches(
  hangs: Array<{ startNs: number; durationNs: number; durationMs: number }>,
  hitches: Array<{ startNs: number; durationNs: number; durationMs: number; hitchType?: string }>,
): Correlation[] {
  const results: Correlation[] = [];
  for (const hang of hangs) {
    const hangEnd = hang.startNs + hang.durationNs;
    for (const hitch of hitches) {
      const hitchEnd = hitch.startNs + hitch.durationNs;
      // Half-open interval overlap: max(starts) < min(ends).
      const overlapStart = Math.max(hang.startNs, hitch.startNs);
      const overlapEnd = Math.min(hangEnd, hitchEnd);
      if (overlapEnd <= overlapStart) continue;
      const overlapMs = (overlapEnd - overlapStart) / 1e6;
      const atSec = Math.min(hang.startNs, hitch.startNs) / 1e9;
      let confidence: Correlation["confidence"];
      if (
        hang.durationMs >= 250 &&
        hitch.durationMs >= 250 &&
        overlapMs >= 100
      ) {
        confidence = "high";
      } else if (hang.durationMs >= 250 || hitch.durationMs >= 250) {
        confidence = "medium";
      } else {
        confidence = "low";
      }
      const hitchKind = hitch.hitchType ? `${hitch.hitchType} ` : "";
      const narrative = `Hang at t=${(hang.startNs / 1e9).toFixed(2)}s (${hang.durationMs.toFixed(0)}ms) overlaps with ${hitchKind}hitch at t=${(hitch.startNs / 1e9).toFixed(2)}s (${hitch.durationMs.toFixed(0)}ms). Main-thread block likely caused the dropped frames.`;
      results.push({ kind: "hangs+hitches", confidence, narrative, atSec });
    }
  }
  results.sort((a, b) => a.atSec - b.atSec);
  return results;
}

/**
 * Pure: build all cross-area correlations from per-area summaries.
 * Currently only `hangs+hitches` produces entries; allocation-based
 * correlations need per-timestamp allocation data the existing
 * analyzeAllocations doesn't expose (v1.14+ candidate).
 */
export function buildCorrelations(
  areas: SummarizeTraceResult["areas"],
): Correlation[] {
  const hangs = areas.hangs.result?.top ?? [];
  const hitches = areas.hitches.result?.top ?? [];
  if (hangs.length === 0 || hitches.length === 0) return [];
  return correlateHangsAndHitches(hangs, hitches);
}

/**
 * Pure: produce the one-or-two-sentence headline that goes at the top
 * of the markdown card. Picks the most user-visible finding across
 * all areas. Order of priority: longest hang above 250ms > worst
 * launch phase > worst hitch > largest allocation spike.
 */
export function buildHeadline(
  areas: SummarizeTraceResult["areas"],
): string {
  const hang = areas.hangs.result?.top?.[0];
  if (hang && hang.durationMs >= 250) {
    const violation = hang.mainThreadViolations?.[0];
    const causedBy = violation
      ? ` (caused by \`${violation.topFrame}\` -> ${violation.kind})`
      : "";
    return `${hang.durationMs.toFixed(0)}ms hang at t=${(hang.startNs / 1e9).toFixed(2)}s${causedBy}. Likely user-visible freeze.`;
  }
  const launch = areas.appLaunch.result;
  if (launch && launch.totalLaunchMs > 1000) {
    return `Launch took ${launch.totalLaunchMs.toFixed(0)}ms (${launch.launchType} launch). Above the 1s user-visible threshold.`;
  }
  const hitchesPerceptible = areas.hitches.result?.totals?.perceptible ?? 0;
  if (hitchesPerceptible > 0) {
    return `${hitchesPerceptible} animation hitch${hitchesPerceptible === 1 ? "" : "es"} above the 100ms user-perceptible threshold. Investigate render-server commits and main-thread work during scroll.`;
  }
  if (hang) {
    return `${hang.durationMs.toFixed(0)}ms hang at t=${(hang.startNs / 1e9).toFixed(2)}s. Below the 250ms user-visible threshold but still worth investigating.`;
  }
  return "No user-perceptible perf events detected in the analyzed schemas.";
}

/**
 * Pure: assemble the compact markdown summary card. Designed to be
 * <10 KB at default settings. The structured `areas` field carries
 * the full data for callers who need it; this is the human view.
 */
export function buildMarkdownCard(
  result: Omit<SummarizeTraceResult, "markdown">,
  verbose: boolean,
): string {
  const sections: string[] = [];
  const inspection = result.inspection;
  const traceName = basename(result.tracePath);
  sections.push(`# Trace summary: ${traceName}`);
  sections.push("");

  const meta: string[] = [];
  if (inspection.deviceModel) meta.push(inspection.deviceModel);
  if (inspection.osVersion) meta.push(inspection.osVersion);
  if (inspection.templateName) meta.push(`Template: \`${inspection.templateName}\``);
  if (meta.length > 0) sections.push(`**${meta.join("  ·  ")}**`);
  sections.push("");

  sections.push(`> **Headline:** ${result.headline}`);
  sections.push("");

  const topNHangs = verbose ? DEFAULT_TOP_N_HANGS : 5;
  const topNHitches = verbose ? DEFAULT_TOP_N_HITCHES : 5;
  const topNAllocations = verbose ? DEFAULT_TOP_N_ALLOCATIONS : 5;
  const topNTimeProfile = verbose ? DEFAULT_TOP_N_TIME_PROFILE : 5;

  // Hangs section.
  if (result.areas.hangs.status === "ok" && result.areas.hangs.result) {
    const h = result.areas.hangs.result;
    const totalHangs = h.totals?.hangs ?? 0;
    const totalMicrohangs = h.totals?.microhangs ?? 0;
    const userVisible = (h.top ?? []).filter((e) => e.durationMs >= 250).length;
    sections.push(
      `## Hangs (${totalHangs}, ${userVisible} user-visible, ${totalMicrohangs} microhang${totalMicrohangs === 1 ? "" : "s"})`,
    );
    sections.push("");
    if ((h.top ?? []).length > 0) {
      for (const entry of (h.top ?? []).slice(0, topNHangs)) {
        const at = (entry.startNs / 1e9).toFixed(2);
        const violation = entry.mainThreadViolations?.[0];
        const classification = violation
          ? ` → ${violation.kind} (\`${violation.topFrame}\`)`
          : "";
        sections.push(
          `- ${entry.durationMs.toFixed(0)}ms at t=${at}s${classification}`,
        );
      }
    } else {
      sections.push("_No hang events above the minimum threshold._");
    }
    sections.push("");
  } else if (result.areas.hangs.status === "schema-absent") {
    // Suppressed when no hangs data; reduces card clutter.
  } else {
    sections.push(`## Hangs`);
    sections.push("");
    sections.push(`_${result.areas.hangs.diagnosis}_`);
    sections.push("");
  }

  // Animation hitches section.
  if (result.areas.hitches.status === "ok" && result.areas.hitches.result) {
    const h = result.areas.hitches.result;
    const totalHitches = h.totals?.rows ?? 0;
    const perceptible = h.totals?.perceptible ?? 0;
    sections.push(
      `## Animation hitches (${totalHitches}, ${perceptible} above 100ms)`,
    );
    sections.push("");
    if ((h.top ?? []).length > 0) {
      sections.push("| At | Duration | Type |");
      sections.push("|---|---:|---|");
      for (const entry of (h.top ?? []).slice(0, topNHitches)) {
        const at = `t=${(entry.startNs / 1e9).toFixed(2)}s`;
        sections.push(
          `| ${at} | ${entry.durationMs.toFixed(0)}ms | ${entry.hitchType || "—"} |`,
        );
      }
    }
    sections.push("");
  } else if (result.areas.hitches.status === "failed") {
    sections.push(`## Animation hitches`);
    sections.push("");
    sections.push(`_${result.areas.hitches.diagnosis}_`);
    sections.push("");
  }

  // Time profile section. analyzeTimeProfile may surface a workaround
  // notice (xctrace SIGSEGV) via `notice`; we surface it inline so the
  // summary card flags the partial-data situation.
  if (
    result.areas.timeProfile.status === "ok" &&
    result.areas.timeProfile.result
  ) {
    const tp = result.areas.timeProfile.result;
    sections.push(
      `## Time profile (${tp.totalSamples.toLocaleString()} samples, top ${topNTimeProfile} symbols)`,
    );
    sections.push("");
    if (tp.notice) {
      sections.push(`> _${tp.notice}_`);
      sections.push("");
    }
    const symbols = tp.topSymbols ?? [];
    if (symbols.length > 0) {
      for (const s of symbols.slice(0, topNTimeProfile)) {
        const pct = tp.totalSamples > 0
          ? `${((s.samples / tp.totalSamples) * 100).toFixed(1)}%`
          : `${s.samples} samples`;
        sections.push(`- ${pct} \`${s.symbol || "???"}\``);
      }
    } else {
      sections.push("_No symbols above the noise threshold._");
    }
    sections.push("");
  } else if (result.areas.timeProfile.status === "failed") {
    sections.push(`## Time profile`);
    sections.push("");
    sections.push(`_${result.areas.timeProfile.diagnosis}_`);
    sections.push("");
  }

  // Allocations section.
  if (
    result.areas.allocations.status === "ok" &&
    result.areas.allocations.result
  ) {
    const a = result.areas.allocations.result;
    const cumulativeBytes = a.totals.cumulativeBytes;
    const persistentBytes = a.totals.persistentBytes;
    sections.push(
      `## Allocations (${(cumulativeBytes / 1024 / 1024).toFixed(1)} MB cumulative, ${(persistentBytes / 1024 / 1024).toFixed(1)} MB persistent)`,
    );
    sections.push("");
    const top = a.topByBytes ?? [];
    if (top.length > 0) {
      sections.push("| Category | Lifecycle | Bytes (cumulative) | Count |");
      sections.push("|---|---|---:|---:|");
      for (const entry of top.slice(0, topNAllocations)) {
        const mb = (entry.cumulativeBytes / 1024 / 1024).toFixed(2);
        sections.push(
          `| \`${entry.category}\` | ${entry.lifecycle} | ${mb} MB | ${entry.cumulativeCount.toLocaleString()} |`,
        );
      }
    }
    sections.push("");
  }

  // App launch section.
  if (
    result.areas.appLaunch.status === "ok" &&
    result.areas.appLaunch.result
  ) {
    const al = result.areas.appLaunch.result;
    sections.push(
      `## App launch (${al.launchType}, ${al.totalLaunchMs.toFixed(0)}ms total)`,
    );
    sections.push("");
    if ((al.phases ?? []).length > 0) {
      sections.push("| Phase | Duration | % of total |");
      sections.push("|---|---:|---:|");
      for (const p of al.phases ?? []) {
        sections.push(
          `| ${p.label || p.phase} | ${p.durationMs.toFixed(0)}ms | ${p.percentOfTotal.toFixed(1)}% |`,
        );
      }
    }
    sections.push("");
  }

  // Cross-correlations (v1.13 Phase 2). High and medium go straight
  // into the card; low-confidence entries collapsed into a single
  // "plus N more" line to keep the card compact.
  const correlations = result.correlations ?? [];
  if (correlations.length > 0) {
    const highMedium = correlations.filter(
      (c) => c.confidence === "high" || c.confidence === "medium",
    );
    const low = correlations.filter((c) => c.confidence === "low");
    if (highMedium.length > 0 || verbose) {
      sections.push("## Cross-correlations");
      sections.push("");
      const visible = verbose ? correlations : highMedium;
      for (const c of visible) {
        const confidenceBadge =
          c.confidence === "high"
            ? "**HIGH**"
            : c.confidence === "medium"
              ? "MEDIUM"
              : "low";
        sections.push(`- (${confidenceBadge}) ${c.narrative}`);
      }
      if (!verbose && low.length > 0) {
        sections.push(
          `- _${low.length} low-confidence overlap${low.length === 1 ? "" : "s"} omitted; pass \`verbose: true\` to see them._`,
        );
      }
      sections.push("");
    }
  }

  // Suggested next calls from inspectTrace (carries them already).
  if (inspection.suggestedNextCalls.length > 0) {
    sections.push("## Suggested next calls");
    sections.push("");
    for (const call of inspection.suggestedNextCalls.slice(0, 5)) {
      sections.push(`- \`${call.tool}\` — ${call.why}`);
    }
    sections.push("");
  }

  return sections.join("\n").trim();
}

export async function summarizeTrace(
  input: SummarizeTraceInput,
): Promise<SummarizeTraceResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const verbose = input.verbose ?? false;

  // Step 1: TOC.
  const inspection = await inspectTrace({ tracePath });

  // Step 2: chain analyzers in parallel. Each branch is fault-tolerant
  // via buildAreaSummary so one failure doesn't tank the whole summary.
  const [hangs, hitches, timeProfile, allocations, appLaunch] = await Promise.all([
    buildAreaSummary(
      "potential-hangs",
      inspection,
      () =>
        analyzeHangs({
          tracePath,
          topN: DEFAULT_TOP_N_HANGS,
          minDurationMs: DEFAULT_HANG_MIN_MS,
          includeStackClassification: true,
        }),
      "potential-hangs schema absent from this trace.",
    ),
    buildAreaSummary(
      "animation-hitches",
      inspection,
      () =>
        analyzeAnimationHitches({
          tracePath,
          topN: DEFAULT_TOP_N_HITCHES,
          minDurationMs: DEFAULT_HITCH_THRESHOLD_MS,
        }),
      "animation-hitches schema absent from this trace.",
    ),
    buildAreaSummary(
      "time-profile",
      inspection,
      () =>
        analyzeTimeProfile({
          tracePath,
          topN: DEFAULT_TOP_N_TIME_PROFILE,
        }),
      "time-profile schema absent from this trace.",
    ),
    buildAreaSummary(
      "allocations",
      inspection,
      () =>
        analyzeAllocations({
          tracePath,
          topN: DEFAULT_TOP_N_ALLOCATIONS,
          minBytes: 0,
        }),
      "allocations schema absent from this trace.",
    ),
    buildAreaSummary(
      "app-launch",
      inspection,
      () => analyzeAppLaunch({ tracePath }),
      "app-launch schema absent from this trace.",
    ),
  ]);

  const areas: SummarizeTraceResult["areas"] = {
    hangs,
    hitches,
    timeProfile,
    allocations,
    appLaunch,
  };
  const correlations = buildCorrelations(areas);
  const headline = buildHeadline(areas);

  const base: Omit<SummarizeTraceResult, "markdown"> = {
    ok: true,
    tracePath,
    inspection,
    areas,
    correlations,
    headline,
  };
  const markdown = buildMarkdownCard(base, verbose);

  return { ...base, markdown };
}

// Helper for tests: ensure the keys in `areas` stay aligned with the
// implementation. Imported by the test file.
export const SUMMARIZE_AREA_KEYS = [
  "hangs",
  "hitches",
  "timeProfile",
  "allocations",
  "appLaunch",
] as const;
