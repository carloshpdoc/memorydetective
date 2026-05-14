import { z } from "zod";
import { runCommand } from "../runtime/exec.js";
import { runLeaksAndParse } from "../runtime/leaks.js";
import {
  parseLeaksDebugStacks,
  type ReferenceTreeChain,
} from "../parsers/leaksDebugStacks.js";
import { suggestionGetDefinition } from "../runtime/suggestions.js";
import type { CycleNode, LeaksReport, NextCallSuggestion } from "../types.js";

export const findRetainersSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  className: z
    .string()
    .min(1)
    .describe(
      "Class name (or substring) to find retainers for, e.g. \"DetailViewModel\".",
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Cap on how many retain chains to return (default 10)."),
  includeReferenceTree: z
    .boolean()
    .default(false)
    .describe(
      "v1.12+. When true, also run `leaks --debug=stacks --debug='<className>$'` to surface per-instance allocation stacks aggregated by call-stack fingerprint. Required on memgraphs where `leakCount: 0` and the class is reachable from KVO/NotificationCenter/caches (abandoned-memory shape). Each chain returns the allocation call stack + the unique retainer classes + a representative instance address. **Note:** `leaks --debug=stacks` only emits blocks for instances whose allocation stack was recorded, which requires the target was launched with `MallocStackLogging=1`. Xcode's Memory Graph Debugger export does NOT enable MSL by default, so memgraphs captured that way may surface fewer chains than the total instance count from `analyzeMemgraph.abandonedMemorySuspects[]`. Default false preserves v1.11 behavior.",
    ),
});

export type FindRetainersInput = z.infer<typeof findRetainersSchema>;

export interface RetainerChainEntry {
  className: string;
  address: string;
  edge?: string;
  retainKind: string;
  count?: number;
}

export interface RetainerChain {
  /** Path from a top-level node down to the matching node — entry[0] is the root, last entry is the match. */
  path: RetainerChainEntry[];
  matchAddress: string;
  matchClassName: string;
}

export interface FindRetainersResult {
  ok: boolean;
  path: string;
  className: string;
  totalMatches: number;
  retainers: RetainerChain[];
  /**
   * v1.12+. Populated when `includeReferenceTree: true` and `leaks
   * --debug=stacks` returned data. Each chain aggregates instances that
   * share the same allocation call stack (the 342 notelet AVPlayerItem
   * instances collapse to 1 chain with `instanceCount: 342`). The
   * `userFrame` field surfaces the deepest non-system frame, which is
   * the line a developer would inspect (e.g. `MediaNoteItemVideoView.prepareVideo`
   * for the notelet case).
   */
  referenceTreeChains?: ReferenceTreeChain[];
  /** Pipeline hint: once you know who retains the class, locate it in source. */
  suggestedNextCalls?: NextCallSuggestion[];
}

/**
 * Walk the cycle forest and collect every parent-path that ends in a node whose
 * className contains `needle`. Pure function for testing.
 */
export function findRetainersIn(
  report: LeaksReport,
  needle: string,
  maxResults = 10,
): { totalMatches: number; retainers: RetainerChain[] } {
  const matches: RetainerChain[] = [];
  let total = 0;

  const visit = (
    node: CycleNode,
    ancestors: RetainerChainEntry[],
  ): void => {
    const here: RetainerChainEntry = {
      className: node.className,
      address: node.address,
      edge: node.edge,
      retainKind: node.retainKind,
      count: node.count,
    };
    const trail = [...ancestors, here];
    if (node.className && node.className.includes(needle)) {
      total += 1;
      if (matches.length < maxResults) matches.push({
        path: trail,
        matchAddress: node.address,
        matchClassName: node.className,
      });
    }
    for (const child of node.children) visit(child, trail);
  };

  for (const root of report.cycles) visit(root, []);
  return { totalMatches: total, retainers: matches };
}

/**
 * Spawn `leaks --debug=stacks --debug='<ClassName>$'` and parse the stdout
 * into per-stack-fingerprint aggregated chains. Failure is non-fatal:
 * returns an empty array so the cycle-side path still completes.
 *
 * leaks(1) `--debug=` predicate rejects `^` (`cannot match the start of
 * a class name`); only the `$` trailing anchor is supported. The
 * resulting semantic is "ends with X", which matches AVPlayerItem
 * exactly but also things like MyAVPlayerItem (rare; intentionally
 * permissive over over-restrictive). Class-name regex metacharacters
 * are escaped so substrings like "Player.Item" stay literal.
 */
async function captureReferenceTreeChains(
  path: string,
  className: string,
  maxResults: number,
): Promise<ReferenceTreeChain[]> {
  // Escape regex metacharacters in the user-supplied class name so a
  // substring like "AVPlayerItem" stays literal under leaks's regex
  // predicate. `^` and `$` aren't escaped (leaks treats them specially).
  const escaped = className.replace(/[.*+?{}()|[\]\\]/g, "\\$&");
  const predicate = `${escaped}$`;
  const result = await runCommand(
    "leaks",
    ["--debug=stacks", `--debug=${predicate}`, path],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) return [];
  const all = parseLeaksDebugStacks(result.stdout);
  return all.slice(0, maxResults);
}

export async function findRetainers(
  input: FindRetainersInput,
): Promise<FindRetainersResult> {
  const wantReferenceTree = input.includeReferenceTree ?? false;
  const maxResults = input.maxResults ?? 10;
  const [
    { report, resolvedPath },
    referenceTreeChains,
  ] = await Promise.all([
    runLeaksAndParse(input.path),
    wantReferenceTree
      ? captureReferenceTreeChains(input.path, input.className, maxResults)
      : Promise.resolve([] as ReferenceTreeChain[]),
  ]);
  const { totalMatches, retainers } = findRetainersIn(
    report,
    input.className,
    maxResults,
  );

  // Update totalMatches to include reference-tree side if it found instances
  // the cycle path missed. Instance counts aggregate across the per-stack
  // chains; cycle matches count each path separately, so we don't double-add.
  const referenceTreeInstanceTotal =
    referenceTreeChains.reduce((s, c) => s + c.instanceCount, 0);
  const effectiveTotal =
    totalMatches > 0 ? totalMatches : referenceTreeInstanceTotal;

  const suggestedNextCalls: NextCallSuggestion[] =
    effectiveTotal > 0
      ? [suggestionGetDefinition({ symbolName: input.className })]
      : [];

  const result: FindRetainersResult = {
    ok: true,
    path: resolvedPath,
    className: input.className,
    totalMatches: effectiveTotal,
    retainers,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
  if (referenceTreeChains.length > 0) {
    result.referenceTreeChains = referenceTreeChains;
  }
  return result;
}
