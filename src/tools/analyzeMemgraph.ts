import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { parseLeaksOutput, rootCyclesOnly } from "../parsers/leaksOutput.js";
import {
  parseReferenceTreeText,
  type ReferenceTreeEntry,
} from "../parsers/referenceTree.js";
import { outputFormatField } from "../runtime/responseFormatter.js";
import {
  shortenForVerbosity,
  type Verbosity,
} from "../parsers/shortenClassName.js";
import {
  suggestionClassifyCycle,
  suggestionReachableFromCycle,
} from "../runtime/suggestions.js";
import type { CycleNode, LeaksReport, NextCallSuggestion } from "../types.js";

export const analyzeMemgraphSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.memgraph` file (export from Xcode Memory Graph Debugger).",
    ),
  fullChains: z
    .boolean()
    .default(false)
    .describe(
      "When true, include the full nested retain chains in the response. Default false returns only top-level ROOT CYCLE summaries to keep payloads small.",
    ),
  verbosity: z
    .enum(["compact", "normal", "full"])
    .default("compact")
    .describe(
      "Class-name verbosity. `compact` (default) drops module prefixes, collapses nested SwiftUI ModifiedContent into `+N modifiers`, and truncates deep generics with a hash placeholder. `normal` keeps more detail. `full` returns Swift demangled names verbatim.",
    ),
  maxClassesInChain: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe(
      "Cap on how many unique class names to surface per cycle's `classesInChain` array. Default 10, enough to identify app-level types without flooding the response.",
    ),
  referenceTreeTopN: z
    .number()
    .int()
    .nonnegative()
    .max(200)
    .default(20)
    .describe(
      "When `leakCount` is 0 (the typical abandoned-memory case), also run `leaks --referenceTree --groupByType --noContent` and surface the top N classes by live instance count in `abandonedMemoryTop[]`. Set to 0 to skip the second leaks invocation. Default 20.",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeMemgraphInput = z.infer<typeof analyzeMemgraphSchema>;

export interface CycleSummary {
  className: string;
  address: string;
  count?: number;
  size?: string;
  instanceSize?: number;
  /** Number of descendant nodes in the retain chain. */
  chainLength: number;
  /** Top-ranked class names appearing in the chain (capped, app-level priority). */
  classesInChain: string[];
  /** Total unique class names found in the chain (the cap-aware count for context). */
  classesInChainTotal: number;
  /**
   * Total instance size in bytes summed across every node reachable from
   * this cycle's root. Useful for prioritizing cycles: "breaking this one
   * frees X bytes" — bigger first.
   */
  transitiveBytes: number;
  /** Total node count reachable from this root. Heavier than `chainLength` when the cycle has wide branches. */
  transitiveInstanceCount: number;
}

export interface AnalyzeMemgraphResult {
  ok: boolean;
  path: string;
  process?: string;
  pid?: number;
  identifier?: string;
  platform?: string;
  totals: {
    leakCount: number;
    totalLeakedBytes: number;
    nodesMalloced?: number;
  };
  /** Top-level ROOT CYCLE summaries. */
  cycles: CycleSummary[];
  /** Present only when `fullChains: true`. The full forest including standalone leaks. */
  fullReport?: LeaksReport;
  /** Plain-English diagnosis (one liner). */
  diagnosis: string;
  /** Pipeline hints. Chain `classifyCycle` next, then `reachableFromCycle` to scope blame. */
  suggestedNextCalls?: NextCallSuggestion[];
  /**
   * Top live classes by instance count from the heap reference tree.
   * Populated when `leakCount` is 0 and `referenceTreeTopN > 0`. Surfaces
   * the abandoned-memory shape that the standard `leaks` count misses:
   * objects that are technically reachable (so not "leaked" in the strict
   * sense) but whose growth across repeated workflows indicates a real
   * accumulation bug (KVO observers not invalidated, NotificationCenter
   * observers leaked, caches that never evict, etc.). These classes are
   * not formal leaks; they are reachable-but-suspicious and worth diffing
   * against a baseline via `analyzeAbandonedMemory(before, after)` for
   * the verdict.
   */
  abandonedMemoryTop?: ReferenceTreeEntry[];
}

/**
 * Pure function: take a `leaks` stdout string and a source path, produce a structured analysis.
 * Split out so it can be tested without spawning a subprocess.
 */
export function summarizeLeaks(
  leaksText: string,
  path: string,
  fullChains = false,
  verbosity: Verbosity = "compact",
  maxClassesInChain = 10,
): AnalyzeMemgraphResult {
  const report = parseLeaksOutput(leaksText);
  const roots = rootCyclesOnly(report.cycles);
  const cycles: CycleSummary[] = roots.map((c) =>
    summarizeCycle(c, verbosity, maxClassesInChain),
  );

  const diagnosis = buildDiagnosis(report, cycles);

  const suggestedNextCalls: NextCallSuggestion[] =
    cycles.length > 0
      ? [
          suggestionClassifyCycle({ path }),
          suggestionReachableFromCycle({ path, cycleIndex: 0 }),
        ]
      : [];

  return {
    ok: true,
    path,
    process: report.header.process,
    pid: report.header.pid,
    identifier: report.header.identifier,
    platform: report.header.platform,
    totals: {
      leakCount: report.totals.leakCount,
      totalLeakedBytes: report.totals.totalLeakedBytes,
      nodesMalloced: report.totals.nodesMalloced,
    },
    cycles,
    ...(fullChains ? { fullReport: report } : {}),
    diagnosis,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}

function summarizeCycle(
  node: CycleNode,
  verbosity: Verbosity,
  maxClassesInChain: number,
): CycleSummary {
  const classCounts = new Map<string, number>();
  let chainLength = 0;
  let transitiveBytes = 0;
  const visit = (n: CycleNode) => {
    chainLength += 1;
    if (typeof n.instanceSize === "number") transitiveBytes += n.instanceSize;
    if (n.className) {
      const short = shortenForVerbosity(n.className, verbosity);
      classCounts.set(short, (classCounts.get(short) ?? 0) + 1);
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
  // Rank classes by occurrence count, take top N. App-level classes (those
  // that don't start with a stdlib prefix even in compact form) get
  // priority since they're the ones the user actually wrote.
  const ranked = Array.from(classCounts.entries())
    .sort((a, b) => {
      const aIsApp = !/^(_DictionaryStorage|Closure|ForEach|Modified|AsyncImage|StoredLocation|LocationBox|TagIndex|AnyHashable|WeakBox|AnyLocation)/.test(a[0]);
      const bIsApp = !/^(_DictionaryStorage|Closure|ForEach|Modified|AsyncImage|StoredLocation|LocationBox|TagIndex|AnyHashable|WeakBox|AnyLocation)/.test(b[0]);
      if (aIsApp !== bIsApp) return aIsApp ? -1 : 1;
      return b[1] - a[1];
    })
    .slice(0, maxClassesInChain)
    .map(([name]) => name);

  return {
    className: shortenForVerbosity(node.className, verbosity),
    address: node.address,
    count: node.count,
    size: node.size,
    instanceSize: node.instanceSize,
    chainLength,
    classesInChain: ranked,
    classesInChainTotal: classCounts.size,
    transitiveBytes,
    transitiveInstanceCount: chainLength,
  };
}

function buildDiagnosis(
  report: LeaksReport,
  cycles: CycleSummary[],
): string {
  if (report.totals.leakCount === 0) {
    return "No leaks detected.";
  }
  if (cycles.length === 0) {
    return `${report.totals.leakCount} leaks detected, no ROOT CYCLE blocks (likely standalone leaks, not retain cycles).`;
  }
  const top = cycles[0];
  const interesting = cycles
    .flatMap((c) => c.classesInChain)
    .filter((n) => !n.startsWith("SwiftUI.") && !n.startsWith("Swift."));
  const dedupedInteresting = Array.from(new Set(interesting)).slice(0, 5);
  const interestingTxt =
    dedupedInteresting.length > 0
      ? ` App-level classes in chains: ${dedupedInteresting.join(", ")}.`
      : "";
  return `${report.totals.leakCount} leaks; ${cycles.length} ROOT CYCLE block${cycles.length === 1 ? "" : "s"}. Largest top-level cycle: ${top.className || top.address} (${top.size ?? "?"}, chain of ${top.chainLength} nodes).${interestingTxt}`;
}

export async function analyzeMemgraph(
  input: AnalyzeMemgraphInput,
): Promise<AnalyzeMemgraphResult> {
  const path = resolvePath(input.path);
  if (!existsSync(path)) {
    throw new Error(`Memgraph file not found: ${path}`);
  }

  const result = await runCommand("leaks", [path], {
    timeoutMs: 5 * 60_000,
  });
  // `leaks` exits 0 when clean, 1 when leaks are found. Anything else is a real error.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  const summary = summarizeLeaks(
    result.stdout,
    path,
    input.fullChains ?? false,
    input.verbosity ?? "compact",
    input.maxClassesInChain ?? 10,
  );

  // Abandoned-memory surface: when `leaks` finds zero leaks, the reference
  // tree still carries information about what the heap is holding alive.
  // This is the only signal for the "orphaned KVO observer" / "abandoned
  // cache" class of bugs that don't form a closed cycle. We invoke a second
  // leaks pass with `--referenceTree --groupByType --noContent` and rank
  // classes by live instance count. The caller can then chain into
  // `analyzeAbandonedMemory(before, after)` to confirm growth shape across
  // a workflow.
  const topN = input.referenceTreeTopN ?? 20;
  if (summary.totals.leakCount === 0 && topN > 0) {
    const abandonedMemoryTop = await captureReferenceTreeTop(path, topN);
    if (abandonedMemoryTop.length > 0) {
      summary.abandonedMemoryTop = abandonedMemoryTop;
    }
  }

  return summary;
}

/**
 * Spawn a second `leaks` invocation with the reference-tree flags and parse
 * the top N classes by instance count. Exposed as a helper so the
 * integration is testable without spawning, by passing a precomputed
 * stdout via the pure `parseReferenceTreeText` directly.
 *
 * Failure here is non-fatal: if leaks fails on the second invocation, we
 * return an empty array rather than throwing, so the main analyze result
 * is still returned to the caller. The most likely failure path is the
 * same macOS 26.x kernel regression that hit the first invocation, which
 * would already be surfaced via the earlier captureMemgraph step.
 */
async function captureReferenceTreeTop(
  path: string,
  topN: number,
): Promise<ReferenceTreeEntry[]> {
  try {
    const result = await runCommand(
      "leaks",
      [path, "--referenceTree", "--groupByType", "--noContent"],
      { timeoutMs: 5 * 60_000 },
    );
    if (result.code !== 0 && result.code !== 1) {
      return [];
    }
    return parseReferenceTreeText(result.stdout, topN);
  } catch {
    return [];
  }
}
