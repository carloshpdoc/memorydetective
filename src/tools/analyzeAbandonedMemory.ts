/**
 * `analyzeAbandonedMemory(beforePath, afterPath)`
 *
 * Diff two `.memgraph` snapshots on the reference-tree class counts (not the
 * cycle list) and classify the GROWTH shape per class. Surfaces the family
 * of bugs that the standard `diffMemgraphs` (cycle-focused) misses:
 * orphaned KVO observers, never-removed NotificationCenter handlers, caches
 * that never evict, singletons that retain payloads, and the long tail of
 * "unknown growth" that warrants further inspection.
 *
 * The tool is the natural pair for the v1.8 verify-fix loop: capture a
 * `before.memgraph`, ship the fix, capture an `after.memgraph`, then run
 * this to confirm the suspect class went from N to <= 1. Validated end
 * to end on the notelet investigation 2026-05-12 where AVPlayerItem went
 * 342 to 0 across a fix that was invisible in `leaks` output but obvious
 * in the reference tree.
 *
 * The classifier is pattern-catalog driven, same shape as `classifyCycle`:
 * each grown class is matched against a small set of heuristics and tagged
 * with a stable `classification` id + confidence tier. The agent can chain
 * the result into `swiftSearchPattern` with the class name to locate the
 * source.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseReferenceTreeText,
  isFrameworkNoise,
  type ReferenceTreeEntry,
} from "../parsers/referenceTree.js";
import type { NextCallSuggestion } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

export const analyzeAbandonedMemoryShape = {
  beforePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the baseline `.memgraph` (the BEFORE snapshot). Use `captureScenarioState({ label: 'before' })` to produce one in the standard verify-fix flow.",
    ),
  afterPath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the post-fix `.memgraph` (the AFTER snapshot). Same workflow as `beforePath`, after applying the candidate fix.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(25)
    .describe(
      "Cap on `growthByClass[]` length. Default 25, max 200. Classes are ranked by absolute instance-count delta descending.",
    ),
  classFilter: z
    .string()
    .optional()
    .describe(
      "Optional substring filter. When set, only classes whose name contains this substring are included in the response. Useful for verifying a specific class went to baseline without seeing the surrounding noise.",
    ),
  outputFormat: outputFormatField,
} as const;

export const analyzeAbandonedMemorySchema = z.object(
  analyzeAbandonedMemoryShape,
);

export type AnalyzeAbandonedMemoryInput = z.infer<
  typeof analyzeAbandonedMemorySchema
>;

export type AbandonedMemoryClassification =
  | "kvo-observer-orphaned"
  | "notificationcenter-observer-leaked"
  | "cache-too-aggressive"
  | "singleton-retains-payload"
  | "unknown-growth";

export interface AbandonedMemoryEntry {
  className: string;
  beforeCount: number;
  afterCount: number;
  delta: number;
  beforeBytes: number;
  afterBytes: number;
  bytesDelta: number;
  classification: AbandonedMemoryClassification;
  confidence: "high" | "medium" | "low";
  hint?: string;
}

export interface AnalyzeAbandonedMemoryResult {
  ok: boolean;
  beforePath: string;
  afterPath: string;
  totals: {
    classesGrown: number;
    classesShrunk: number;
    classesUnchanged: number;
    netInstancesDelta: number;
    netBytesDelta: number;
  };
  /**
   * Classes that grew between before and after, ranked by absolute delta
   * descending. Each entry carries a `classification` from the catalog plus
   * a `confidence` tier. The agent can branch on `classification` to choose
   * the right `swiftSearchPattern` / fix template.
   *
   * **Raw view.** Includes framework noise (NSMutableDictionary, CFString,
   * libMainThreadChecker bss, etc.). Useful for cache-bloat investigations.
   */
  growthByClass: AbandonedMemoryEntry[];
  /**
   * Classes that shrunk between before and after. Surfaced so the caller
   * can confirm the fix freed the suspect class (e.g. AVPlayerItem in the
   * notelet case went from 342 to 0). Sorted by absolute delta desc.
   *
   * **Raw view.** See `actionableShrinkage` for the filtered "what fix
   * verifiably freed" view.
   */
  shrinkageByClass: AbandonedMemoryEntry[];
  /**
   * `growthByClass` with framework noise filtered out (Foundation collection
   * types, ObjC metadata, __DATA sections, allocator stacks, etc.). The
   * remaining entries are user-actionable classes. New in v1.10.
   *
   * Use this when answering "what new bug just appeared?". Use the raw
   * `growthByClass` when answering "what does the heap look like now?".
   */
  actionableGrowth: AbandonedMemoryEntry[];
  /**
   * `shrinkageByClass` with framework noise filtered out. Use this in the
   * verify-fix loop to confirm which app-level classes the fix actually
   * freed. AVPlayerItem dropping from 342 to 0 shows up here at the top.
   * New in v1.10.
   */
  actionableShrinkage: AbandonedMemoryEntry[];
  /** Plain-English diagnosis tying the highest-confidence growth to a fix hint. */
  diagnosis: string;
  /** Pipeline hints: chain into `swiftSearchPattern` against the top growth class. */
  suggestedNextCalls?: NextCallSuggestion[];
}

/**
 * Pure: diff two reference-tree entry lists by class name, classify each
 * class with a delta != 0, and return the structured result minus the
 * filesystem header fields.
 *
 * Exposed so tests can drive it without subprocess spawning. The async
 * wrapper around it handles the leaks invocations.
 */
export function buildAbandonedMemoryDiff(
  before: ReferenceTreeEntry[],
  after: ReferenceTreeEntry[],
  options: { topN: number; classFilter?: string },
): Omit<AnalyzeAbandonedMemoryResult, "ok" | "beforePath" | "afterPath"> {
  const beforeByName = new Map(before.map((e) => [e.className, e]));
  const afterByName = new Map(after.map((e) => [e.className, e]));
  const allNames = new Set<string>([...beforeByName.keys(), ...afterByName.keys()]);

  // Two-pass: first compute every class's raw delta, then classify with
  // global context (e.g. NSKeyValueObservance co-occurrence requires
  // visibility into both growth sets at once).
  type Raw = {
    className: string;
    beforeCount: number;
    afterCount: number;
    delta: number;
    beforeBytes: number;
    afterBytes: number;
    bytesDelta: number;
  };
  const raw: Raw[] = [];
  for (const name of allNames) {
    if (options.classFilter && !name.includes(options.classFilter)) continue;
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    const beforeCount = b?.instanceCount ?? 0;
    const afterCount = a?.instanceCount ?? 0;
    const beforeBytes = b?.totalBytes ?? 0;
    const afterBytes = a?.totalBytes ?? 0;
    raw.push({
      className: name,
      beforeCount,
      afterCount,
      delta: afterCount - beforeCount,
      beforeBytes,
      afterBytes,
      bytesDelta: afterBytes - beforeBytes,
    });
  }

  // Co-occurrence signal: did the KVO observation infrastructure grow?
  // If yes, the same-direction growth of other large classes is best
  // explained as "those classes are the observed types being retained
  // by orphaned observers", and the classifier should escalate them to
  // `kvo-observer-orphaned` instead of leaving them as `unknown-growth`.
  const kvoObservanceGrowth =
    raw.find((r) => r.className === "NSKeyValueObservance")?.delta ?? 0;
  const kvoObservationInfoGrowth =
    raw.find((r) => r.className === "NSKeyValueObservationInfo")?.delta ?? 0;
  const hasKvoCoOccurrence =
    kvoObservanceGrowth >= 3 || kvoObservationInfoGrowth >= 3;

  const grown = raw.filter((r) => r.delta > 0);
  const shrunk = raw.filter((r) => r.delta < 0);
  const unchanged = raw.filter((r) => r.delta === 0).length;

  const growthByClass: AbandonedMemoryEntry[] = grown
    .map((r) => {
      const { classification, confidence, hint } = classifyGrowth(
        r.className,
        r.delta,
        hasKvoCoOccurrence,
        kvoObservanceGrowth,
      );
      return {
        className: r.className,
        beforeCount: r.beforeCount,
        afterCount: r.afterCount,
        delta: r.delta,
        beforeBytes: r.beforeBytes,
        afterBytes: r.afterBytes,
        bytesDelta: r.bytesDelta,
        classification,
        confidence,
        ...(hint ? { hint } : {}),
      };
    })
    .sort((a, b) => b.delta - a.delta || b.bytesDelta - a.bytesDelta);

  const shrinkageByClass: AbandonedMemoryEntry[] = shrunk
    .map((r) => ({
      className: r.className,
      beforeCount: r.beforeCount,
      afterCount: r.afterCount,
      delta: r.delta,
      beforeBytes: r.beforeBytes,
      afterBytes: r.afterBytes,
      bytesDelta: r.bytesDelta,
      // Shrinkage entries are still classified for symmetry, but the
      // classification reflects what the suspect-shaped class WAS doing
      // before; the fix freed it, which is what we want to confirm.
      classification: classifyGrowth(
        r.className,
        Math.abs(r.delta),
        false,
        0,
      ).classification,
      confidence: "high" as const,
    }))
    .sort((a, b) => a.delta - b.delta || a.bytesDelta - b.bytesDelta);

  const netInstancesDelta = raw.reduce((acc, r) => acc + r.delta, 0);
  const netBytesDelta = raw.reduce((acc, r) => acc + r.bytesDelta, 0);

  const totals = {
    classesGrown: grown.length,
    classesShrunk: shrunk.length,
    classesUnchanged: unchanged,
    netInstancesDelta,
    netBytesDelta,
  };

  const diagnosis = buildDiagnosis(growthByClass, shrinkageByClass);

  const suggestedNextCalls = buildSuggestedNextCalls(growthByClass);

  // Actionable views: drop framework noise so the caller's first-look list
  // surfaces app-level + AV + KVO classes instead of NSMutableDictionary +
  // CFString + ObjC runtime data. Same ranking, just filtered. Falls back
  // to topN, so the actionable list can be SHORTER than the raw view when
  // most of the top entries are noise.
  const actionableGrowth = growthByClass
    .filter((e) => !isFrameworkNoise(e.className))
    .slice(0, options.topN);
  const actionableShrinkage = shrinkageByClass
    .filter((e) => !isFrameworkNoise(e.className))
    .slice(0, options.topN);

  return {
    totals,
    growthByClass: growthByClass.slice(0, options.topN),
    shrinkageByClass: shrinkageByClass.slice(0, options.topN),
    actionableGrowth,
    actionableShrinkage,
    diagnosis,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}

/**
 * Pure: classify a single class's growth shape based on its name + the
 * presence of co-occurring NSKeyValueObservance growth.
 *
 * Heuristics (highest specificity first):
 *
 * - NSKeyValueObservance / NSKeyValueObservationInfo growth: high-confidence
 *   `kvo-observer-orphaned`. The KVO subsystem only allocates these tokens
 *   when `obj.observe(\.x) { ... }` is called; growth here means tokens
 *   never invalidated.
 *
 * - When KVO observation infrastructure grew, escalate any other class
 *   with delta >= 5 to `kvo-observer-orphaned` (medium confidence). These
 *   are typically the observed types being retained by orphaned observers
 *   (AVPlayerItem in the notelet case).
 *
 * - NSCache / NSCountedSet / NSMapTable / NSMutable{Array,Dictionary,Set}
 *   growth: medium-confidence `cache-too-aggressive`. Collection classes
 *   that grow across a workflow typically indicate missing eviction.
 *
 * - NotificationCenter observer block growth (NSConcreteNotification,
 *   __NSObserver, and similar): medium-confidence
 *   `notificationcenter-observer-leaked`.
 *
 * - Everything else: low-confidence `unknown-growth`. The agent should
 *   chain into `swiftSearchPattern` with the class name to confirm.
 */
export function classifyGrowth(
  className: string,
  delta: number,
  hasKvoCoOccurrence: boolean,
  kvoObservanceDelta: number,
): {
  classification: AbandonedMemoryClassification;
  confidence: "high" | "medium" | "low";
  hint?: string;
} {
  if (
    className.includes("NSKeyValueObservance") ||
    className.includes("NSKeyValueObservationInfo")
  ) {
    return {
      classification: "kvo-observer-orphaned",
      confidence: "high",
      hint: "NSKeyValueObservance growth indicates `observe(\\.x) { ... }` tokens that were never invalidated. The token strongly retains the change closure (which usually captures self), and the closure is anchored in the KVO global observer registry. Use `[weak self]` inside the observe closure and call `token?.invalidate()` in `deinit`, or invalidate-then-nil before reassigning the token. See `classifyCycle` pattern `kvo.observation-not-invalidated`.",
    };
  }

  if (hasKvoCoOccurrence && delta >= 5) {
    const confidence: "high" | "medium" = delta >= 50 ? "high" : "medium";
    return {
      classification: "kvo-observer-orphaned",
      confidence,
      hint: `Co-occurring NSKeyValueObservance growth (+${kvoObservanceDelta}) suggests this type is the value being observed via \`observe(\\.x) { ... }\`. The orphaned observer holds the value alive. Fixing the observer (\`token.invalidate()\` on teardown) will free this class too. See \`classifyCycle\` pattern \`kvo.observation-not-invalidated\`.`,
    };
  }

  if (
    /^NS(Cache|CountedSet|MapTable|MutableArray|MutableDictionary|MutableSet|HashTable)/.test(
      className,
    )
  ) {
    return {
      classification: "cache-too-aggressive",
      confidence: "medium",
      hint: "Bulk-storage class is growing across the workflow. Likely a cache or collection without eviction. For `NSCache`, set `countLimit` or `totalCostLimit`. For `NSMutable*`, audit the producer to confirm it is not appending without bounds. For domain caches, prefer `NSCache` over `NSMutableDictionary` when you want OS-driven eviction under memory pressure.",
    };
  }

  if (
    /NotificationToken|NotificationObserver|__NSObserver|NSConcreteNotification|NSNotificationCenterObserver/.test(
      className,
    )
  ) {
    return {
      classification: "notificationcenter-observer-leaked",
      confidence: "medium",
      hint: "NotificationCenter observer block (added via `addObserver(forName:object:queue:using:)`) growth indicates the returned token was never passed to `removeObserver(_:)`. Store the token on `self` and remove it in `deinit`, or use the selector-based variant which auto-deregisters on dealloc.",
    };
  }

  return {
    classification: "unknown-growth",
    confidence: "low",
    hint: "Class grew between before and after but the catalog did not recognize a known abandoned-memory shape. Chain into `swiftSearchPattern` with this class name to locate the allocation sites, then inspect for missing teardown (observers, timers, dispatch sources, weak ownership invariants).",
  };
}

function buildDiagnosis(
  grown: AbandonedMemoryEntry[],
  shrunk: AbandonedMemoryEntry[],
): string {
  if (grown.length === 0 && shrunk.length === 0) {
    return "No class-count changes between before and after. Either the fix had no effect on the heap composition, or the workflow did not exercise the code path.";
  }
  if (grown.length === 0) {
    const top = shrunk[0];
    return `No growth detected. ${shrunk.length} class${shrunk.length === 1 ? "" : "es"} shrunk. Largest: ${top.className} (${top.beforeCount} to ${top.afterCount}, delta ${top.delta}). The fix appears to have closed an abandoned-memory chain.`;
  }
  const highConfidence = grown.filter((e) => e.confidence === "high");
  const top = grown[0];
  if (highConfidence.length > 0) {
    const hc = highConfidence[0];
    return `${grown.length} class${grown.length === 1 ? "" : "es"} grew. Top suspect: ${hc.className} (${hc.beforeCount} to ${hc.afterCount}, delta +${hc.delta}). Classification: ${hc.classification} (high confidence). ${hc.hint ?? ""}`;
  }
  return `${grown.length} class${grown.length === 1 ? "" : "es"} grew. Largest: ${top.className} (${top.beforeCount} to ${top.afterCount}, delta +${top.delta}). Classification: ${top.classification} (${top.confidence} confidence). Chain into swiftSearchPattern with the class name to locate the allocation site.`;
}

function buildSuggestedNextCalls(
  grown: AbandonedMemoryEntry[],
): NextCallSuggestion[] {
  if (grown.length === 0) return [];
  // Prefer the highest-confidence + largest-delta entry for the suggestion.
  const ranked = [...grown].sort((a, b) => {
    const confRank = (c: AbandonedMemoryEntry["confidence"]) =>
      c === "high" ? 2 : c === "medium" ? 1 : 0;
    const diff = confRank(b.confidence) - confRank(a.confidence);
    if (diff !== 0) return diff;
    return b.delta - a.delta;
  });
  const target = ranked[0];
  return [
    {
      tool: "swiftSearchPattern",
      args: {
        pattern: target.className,
        scope: "<your project root>",
      },
      why: `Locate the allocation site for ${target.className} (grew by +${target.delta} between snapshots; classified as ${target.classification}, ${target.confidence} confidence). The class name + a project-wide pattern search usually narrows to one or two files.`,
    },
  ];
}

/**
 * Spawn `leaks --referenceTree --groupByType --noContent` against a .memgraph
 * and return parsed entries. Wide topN here (1000) so the diff has the full
 * picture; the user-facing `topN` only applies to the FINAL response slice.
 */
async function loadReferenceTree(
  path: string,
): Promise<ReferenceTreeEntry[]> {
  const result = await runCommand(
    "leaks",
    [path, "--referenceTree", "--groupByType", "--noContent"],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks --referenceTree failed (code ${result.code}) on ${path}: ${result.stderr || result.stdout}`,
    );
  }
  return parseReferenceTreeText(result.stdout, 1000);
}

export async function analyzeAbandonedMemory(
  input: AnalyzeAbandonedMemoryInput,
): Promise<AnalyzeAbandonedMemoryResult> {
  const beforePath = resolvePath(input.beforePath);
  const afterPath = resolvePath(input.afterPath);
  if (!existsSync(beforePath)) {
    throw new Error(`Before memgraph not found: ${beforePath}`);
  }
  if (!existsSync(afterPath)) {
    throw new Error(`After memgraph not found: ${afterPath}`);
  }

  const [before, after] = await Promise.all([
    loadReferenceTree(beforePath),
    loadReferenceTree(afterPath),
  ]);

  const diff = buildAbandonedMemoryDiff(before, after, {
    topN: input.topN ?? 25,
    ...(input.classFilter ? { classFilter: input.classFilter } : {}),
  });

  return {
    ok: true,
    beforePath,
    afterPath,
    ...diff,
  };
}
