import { z } from "zod";
import { runCommand } from "../runtime/exec.js";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { walkCycles } from "../parsers/leaksOutput.js";
import {
  parseReferenceTreeText,
  isFrameworkNoise,
} from "../parsers/referenceTree.js";
import type { LeaksReport } from "../types.js";

export const countAliveSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  className: z
    .string()
    .optional()
    .describe(
      "Optional class name (substring). When provided, only that class's count is returned. When omitted, all class counts are returned.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe(
      "When `className` is omitted, return the top N most-leaked classes (default 20).",
    ),
  includeReferenceTree: z
    .boolean()
    .default(false)
    .describe(
      "v1.12+. When true, also parse `leaks --referenceTree --groupByType --noContent` output and surface heap-wide instance counts alongside the cycle-side counts. Required to find classes on memgraphs where `leakCount: 0` and the abandoned-memory shape is what's interesting (e.g. orphaned KVO observers reachable from the global registry). Adds a second `leaks` invocation, run in parallel. Default false preserves v1.11 behavior.",
    ),
});

export type CountAliveInput = z.infer<typeof countAliveSchema>;

export interface CountAliveEntry {
  className: string;
  instanceCount: number;
  /** When `includeReferenceTree: true`, the cycle-side contribution (often 0 for abandoned-memory shapes). */
  byCycle?: number;
  /** When `includeReferenceTree: true`, the reference-tree contribution. Often the only non-zero side on `leakCount: 0` memgraphs. */
  byReferenceTree?: number;
}

export interface CountAliveResult {
  ok: boolean;
  path: string;
  /** Total nodes counted in the cycle forest (across all classes). */
  totalNodes: number;
  /** Per-class counts. When `className` is given, contains a single entry. */
  counts: CountAliveEntry[];
  /**
   * v1.12+. Present when `includeReferenceTree: true` and at least one
   * reference-tree row survived the framework-noise filter. Mirrors the
   * top-N list but with the noise classes (NSMutableDictionary, CFString,
   * `__DATA __bss`, allocator stacks, etc.) filtered out so the actionable
   * classes surface at the top.
   */
  actionableCounts?: CountAliveEntry[];
}

/** Pure: count node occurrences by exact className across the cycle forest. */
export function countByClass(report: LeaksReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { node } of walkCycles(report.cycles)) {
    if (!node.className) continue;
    counts.set(node.className, (counts.get(node.className) ?? 0) + 1);
  }
  return counts;
}

/**
 * Spawn `leaks --referenceTree --groupByType --noContent` and parse the
 * stdout. Non-fatal on failure: returns empty array so the cycle-side
 * path still completes. Mirrors the pattern v1.11 introduced in
 * `diffMemgraphs.captureReferenceTree`.
 */
async function captureReferenceTreeCounts(
  path: string,
): Promise<Map<string, number>> {
  const result = await runCommand(
    "leaks",
    ["--referenceTree", "--groupByType", "--noContent", path],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) return new Map();
  const entries = parseReferenceTreeText(result.stdout, 5000);
  return new Map(entries.map((e) => [e.className, e.instanceCount]));
}

export async function countAlive(
  input: CountAliveInput,
): Promise<CountAliveResult> {
  const wantReferenceTree = input.includeReferenceTree ?? false;
  const [{ report, resolvedPath }, refTreeCounts] = await Promise.all([
    runLeaksAndParse(input.path),
    wantReferenceTree
      ? captureReferenceTreeCounts(input.path)
      : Promise.resolve(new Map<string, number>()),
  ]);
  const cycleCounts = countByClass(report);
  const totalNodes = Array.from(cycleCounts.values()).reduce(
    (a, b) => a + b,
    0,
  );

  if (input.className) {
    let cycleMatched = 0;
    for (const [name, n] of cycleCounts.entries()) {
      if (name.includes(input.className)) cycleMatched += n;
    }
    let refTreeMatched = 0;
    for (const [name, n] of refTreeCounts.entries()) {
      if (name.includes(input.className)) refTreeMatched += n;
    }
    const entry: CountAliveEntry = wantReferenceTree
      ? {
          className: input.className,
          instanceCount: cycleMatched + refTreeMatched,
          byCycle: cycleMatched,
          byReferenceTree: refTreeMatched,
        }
      : { className: input.className, instanceCount: cycleMatched };
    return {
      ok: true,
      path: resolvedPath,
      totalNodes,
      counts: [entry],
    };
  }

  // topN path. Merge cycle + reference-tree counts when the flag is on,
  // ordered by instanceCount desc.
  const merged = new Map<string, { byCycle: number; byReferenceTree: number }>();
  for (const [name, n] of cycleCounts.entries()) {
    merged.set(name, { byCycle: n, byReferenceTree: 0 });
  }
  if (wantReferenceTree) {
    for (const [name, n] of refTreeCounts.entries()) {
      const existing = merged.get(name);
      if (existing) existing.byReferenceTree = n;
      else merged.set(name, { byCycle: 0, byReferenceTree: n });
    }
  }
  const topN = input.topN ?? 20;
  const allEntries = Array.from(merged.entries())
    .map(([name, v]) =>
      wantReferenceTree
        ? {
            className: name,
            instanceCount: v.byCycle + v.byReferenceTree,
            byCycle: v.byCycle,
            byReferenceTree: v.byReferenceTree,
          }
        : { className: name, instanceCount: v.byCycle },
    )
    .sort((a, b) => b.instanceCount - a.instanceCount);

  const top = allEntries.slice(0, topN);

  const result: CountAliveResult = {
    ok: true,
    path: resolvedPath,
    totalNodes,
    counts: top,
  };

  // Actionable view: only meaningful when the reference-tree pass ran and
  // returned data. Same ranking, just framework-noise filtered. Surfaces
  // AV / KVO / app-level classes that would otherwise rank below
  // NSMutableDictionary, CFString, etc.
  if (wantReferenceTree && refTreeCounts.size > 0) {
    const actionable = allEntries
      .filter((e) => !isFrameworkNoise(e.className))
      .slice(0, topN);
    if (actionable.length > 0) {
      result.actionableCounts = actionable;
    }
  }

  return result;
}
