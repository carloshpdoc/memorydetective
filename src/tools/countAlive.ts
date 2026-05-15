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
  sortBy: z
    .enum(["count", "totalBytes"])
    .default("count")
    .describe(
      "v1.14+. Ranks the topN by either instance count (default, preserves v1.13 behavior) or total bytes (FLEX's 'Size' sort). totalBytes is `count * instanceSizeBytes` and is the right rank for 'where is my memory going?' investigations vs 'how many instances are alive?'. Per-class instanceSizeBytes + totalBytes are returned regardless of sort key.",
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
  /**
   * v1.14+. Per-instance size in bytes derived from the memgraph. For
   * fixed-size ObjC classes every instance has the same size; for
   * variable-size classes (NSData with payload, etc.) this is an average
   * (totalBytes / instanceCount, rounded). Absent when neither the
   * cycle-side `[N]` annotation nor the reference-tree parens-size
   * carried a number (rare).
   */
  instanceSizeBytes?: number;
  /**
   * v1.14+. Total bytes attributed to this class: sum of per-instance
   * sizes from the cycle forest plus the reference-tree totals. FLEX
   * surfaces this as the "Size" sort column in its Live Objects view.
   * Useful for "where is my memory going?" investigations.
   */
  totalBytes?: number;
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

/** Pure: count node occurrences by exact className across the cycle forest.
 *  Backwards-compatible API; for v1.14 byte aggregation use
 *  {@link countByClassWithBytes}. */
export function countByClass(report: LeaksReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { node } of walkCycles(report.cycles)) {
    if (!node.className) continue;
    counts.set(node.className, (counts.get(node.className) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pure: aggregate occurrences AND bytes by exact className across the
 * cycle forest. Each node's `instanceSize` is summed into `totalBytes`;
 * the first non-zero `instanceSize` seen is recorded as the canonical
 * `instanceSizeBytes` (ObjC classes are typically fixed-size, so the
 * first value is representative). Nodes without a size annotation
 * contribute to count but not bytes. v1.14.
 */
export function countByClassWithBytes(
  report: LeaksReport,
): Map<string, { count: number; totalBytes: number; instanceSizeBytes?: number }> {
  const acc = new Map<
    string,
    { count: number; totalBytes: number; instanceSizeBytes?: number }
  >();
  for (const { node } of walkCycles(report.cycles)) {
    if (!node.className) continue;
    const cur = acc.get(node.className) ?? { count: 0, totalBytes: 0 };
    cur.count += 1;
    if (node.instanceSize != null) {
      cur.totalBytes += node.instanceSize;
      if (cur.instanceSizeBytes == null) cur.instanceSizeBytes = node.instanceSize;
    }
    acc.set(node.className, cur);
  }
  return acc;
}

/**
 * Spawn `leaks --referenceTree --groupByType --noContent` and parse the
 * stdout. Non-fatal on failure: returns empty array so the cycle-side
 * path still completes. Mirrors the pattern v1.11 introduced in
 * `diffMemgraphs.captureReferenceTree`.
 */
async function captureReferenceTreeCounts(
  path: string,
): Promise<Map<string, { count: number; totalBytes: number }>> {
  const result = await runCommand(
    "leaks",
    ["--referenceTree", "--groupByType", "--noContent", path],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) return new Map();
  const entries = parseReferenceTreeText(result.stdout, 5000);
  return new Map(
    entries.map((e) => [
      e.className,
      { count: e.instanceCount, totalBytes: e.totalBytes },
    ]),
  );
}

export async function countAlive(
  input: CountAliveInput,
): Promise<CountAliveResult> {
  const wantReferenceTree = input.includeReferenceTree ?? false;
  const sortBy = input.sortBy ?? "count";
  const [{ report, resolvedPath }, refTreeCounts] = await Promise.all([
    runLeaksAndParse(input.path),
    wantReferenceTree
      ? captureReferenceTreeCounts(input.path)
      : Promise.resolve(new Map<string, { count: number; totalBytes: number }>()),
  ]);
  const cycleByClass = countByClassWithBytes(report);
  const totalNodes = Array.from(cycleByClass.values()).reduce(
    (a, b) => a + b.count,
    0,
  );

  if (input.className) {
    let cycleMatched = 0;
    let cycleBytesMatched = 0;
    let cycleInstanceSize: number | undefined;
    for (const [name, info] of cycleByClass.entries()) {
      if (!name.includes(input.className)) continue;
      cycleMatched += info.count;
      cycleBytesMatched += info.totalBytes;
      if (cycleInstanceSize == null && info.instanceSizeBytes != null) {
        cycleInstanceSize = info.instanceSizeBytes;
      }
    }
    let refTreeMatched = 0;
    let refTreeBytesMatched = 0;
    for (const [name, info] of refTreeCounts.entries()) {
      if (!name.includes(input.className)) continue;
      refTreeMatched += info.count;
      refTreeBytesMatched += info.totalBytes;
    }
    const totalCount = cycleMatched + refTreeMatched;
    const totalBytes = cycleBytesMatched + refTreeBytesMatched;
    const instanceSizeBytes =
      cycleInstanceSize ??
      (totalCount > 0 && totalBytes > 0
        ? Math.round(totalBytes / totalCount)
        : undefined);
    const entry: CountAliveEntry = wantReferenceTree
      ? {
          className: input.className,
          instanceCount: totalCount,
          byCycle: cycleMatched,
          byReferenceTree: refTreeMatched,
          ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
          ...(totalBytes > 0 ? { totalBytes } : {}),
        }
      : {
          className: input.className,
          instanceCount: cycleMatched,
          ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
          ...(cycleBytesMatched > 0 ? { totalBytes: cycleBytesMatched } : {}),
        };
    return {
      ok: true,
      path: resolvedPath,
      totalNodes,
      counts: [entry],
    };
  }

  // topN path. Merge cycle + reference-tree counts when the flag is on,
  // ordered by sortBy (default 'count', or 'totalBytes' for FLEX-style
  // memory-budget rank).
  const merged = new Map<
    string,
    {
      byCycle: number;
      byReferenceTree: number;
      cycleBytes: number;
      refTreeBytes: number;
      instanceSizeBytes?: number;
    }
  >();
  for (const [name, info] of cycleByClass.entries()) {
    merged.set(name, {
      byCycle: info.count,
      byReferenceTree: 0,
      cycleBytes: info.totalBytes,
      refTreeBytes: 0,
      ...(info.instanceSizeBytes != null
        ? { instanceSizeBytes: info.instanceSizeBytes }
        : {}),
    });
  }
  if (wantReferenceTree) {
    for (const [name, info] of refTreeCounts.entries()) {
      const existing = merged.get(name);
      if (existing) {
        existing.byReferenceTree = info.count;
        existing.refTreeBytes = info.totalBytes;
      } else {
        merged.set(name, {
          byCycle: 0,
          byReferenceTree: info.count,
          cycleBytes: 0,
          refTreeBytes: info.totalBytes,
        });
      }
    }
  }
  const topN = input.topN ?? 20;
  const allEntries: CountAliveEntry[] = Array.from(merged.entries()).map(
    ([name, v]) => {
      const totalCount = v.byCycle + v.byReferenceTree;
      const totalBytes = v.cycleBytes + v.refTreeBytes;
      const instanceSizeBytes =
        v.instanceSizeBytes ??
        (totalCount > 0 && totalBytes > 0
          ? Math.round(totalBytes / totalCount)
          : undefined);
      return wantReferenceTree
        ? {
            className: name,
            instanceCount: totalCount,
            byCycle: v.byCycle,
            byReferenceTree: v.byReferenceTree,
            ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
            ...(totalBytes > 0 ? { totalBytes } : {}),
          }
        : {
            className: name,
            instanceCount: v.byCycle,
            ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
            ...(v.cycleBytes > 0 ? { totalBytes: v.cycleBytes } : {}),
          };
    },
  );
  allEntries.sort((a, b) => {
    if (sortBy === "totalBytes") {
      const ad = (b.totalBytes ?? 0) - (a.totalBytes ?? 0);
      if (ad !== 0) return ad;
    }
    return b.instanceCount - a.instanceCount;
  });

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
