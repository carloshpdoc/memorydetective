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
  excludeFrameworkNoise: z
    .boolean()
    .default(true)
    .describe(
      "v1.17 B-10. When `includeReferenceTree: true`, populates `actionableCounts[]` with the framework-noise classes filtered out (NSMutableDictionary, CFString, __DATA __bss, dispatch_queue_t, etc.). Set false to disable the filter and surface the raw counts only via `counts[]`. The curated noise list is calibrated for abandoned-memory investigations; combine with `additionalNoisePatterns` / `unsuppressClassPatterns` to tune.",
    ),
  additionalNoisePatterns: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "v1.17 B-10. Extra regex patterns (one per string) added to the noise filter. Useful when your app's noise classes are not in the curated list (e.g. third-party SDK collection storage that scales with app activity). Patterns are matched case-sensitively against the class name.",
    ),
  unsuppressClassPatterns: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "v1.17 B-10. Regex patterns that override the noise filter. Use when the default filter false-positives an actionable class (e.g. your app's `NSMutableDictionary` subclass is the actual leak site, or you want CFString back on the actionable list for a string-budget investigation).",
    ),
  noiseAuditMode: z
    .boolean()
    .default(false)
    .describe(
      "v1.17 B-10. When true, returns an extra `noiseAudit[]` field listing each class that was filtered out, with the matching reason ('default-list', 'additional-pattern', or 'kept-by-unsuppress'). Lets the caller verify the filter is calibrated for their app before trusting `actionableCounts[]`.",
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
   * v1.17 B-07. Present only for variable-size classes (when observed
   * per-instance sizes are NOT all equal). Reports the actual spread
   * so the caller can tell "every NSData is 32 bytes" from "NSData
   * ranges 32-65536 bytes". Absent for fixed-size classes (the single
   * `instanceSizeBytes` value already tells the full story).
   *
   * `instanceSizeBytesMin` / `instanceSizeBytesMax` / `instanceSizeBytesMedian`
   * are the spread across all observed instances of this class in the
   * memgraph. For variable-size classes, `instanceSizeBytes` is the
   * median (was the first-non-zero observed value pre-v1.17, which
   * misled the caller).
   */
  instanceSizeBytesMin?: number;
  instanceSizeBytesMax?: number;
  instanceSizeBytesMedian?: number;
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
  /**
   * v1.17 B-10. Present when `noiseAuditMode: true`. Lists every class the
   * filter touched with the matching reason: 'default-list' (curated noise),
   * 'additional-pattern' (user-supplied regex), or 'kept-by-unsuppress'
   * (user-supplied override re-included it). Use this to validate that the
   * filter is calibrated for your app before trusting `actionableCounts[]`.
   */
  noiseAudit?: Array<{
    className: string;
    reason: "default-list" | "additional-pattern" | "kept-by-unsuppress";
  }>;
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
 * cycle forest. Each node's `instanceSize` is summed into `totalBytes`.
 *
 * v1.17 B-07: pre-v1.17 we recorded the first-non-zero observed size as
 * `instanceSizeBytes` and called it canonical. That misleads the caller
 * for variable-size classes (NSData, NSString, CFData) where each
 * instance has a payload-dependent size. Now: collect all observed
 * sizes; if they are uniform we report the single value; if they vary
 * we report the median in `instanceSizeBytes` AND surface the spread
 * via `instanceSizeBytesMin / max / median`.
 */
export function countByClassWithBytes(report: LeaksReport): Map<
  string,
  {
    count: number;
    totalBytes: number;
    instanceSizeBytes?: number;
    instanceSizeBytesMin?: number;
    instanceSizeBytesMax?: number;
    instanceSizeBytesMedian?: number;
  }
> {
  const acc = new Map<
    string,
    { count: number; totalBytes: number; sizes: number[] }
  >();
  for (const { node } of walkCycles(report.cycles)) {
    if (!node.className) continue;
    const cur = acc.get(node.className) ?? { count: 0, totalBytes: 0, sizes: [] };
    cur.count += 1;
    if (node.instanceSize != null) {
      cur.totalBytes += node.instanceSize;
      cur.sizes.push(node.instanceSize);
    }
    acc.set(node.className, cur);
  }
  const out = new Map<
    string,
    {
      count: number;
      totalBytes: number;
      instanceSizeBytes?: number;
      instanceSizeBytesMin?: number;
      instanceSizeBytesMax?: number;
      instanceSizeBytesMedian?: number;
    }
  >();
  for (const [name, v] of acc.entries()) {
    if (v.sizes.length === 0) {
      out.set(name, { count: v.count, totalBytes: v.totalBytes });
      continue;
    }
    const min = Math.min(...v.sizes);
    const max = Math.max(...v.sizes);
    if (min === max) {
      out.set(name, {
        count: v.count,
        totalBytes: v.totalBytes,
        instanceSizeBytes: min,
      });
    } else {
      const sorted = [...v.sizes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0
          ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
          : sorted[mid];
      out.set(name, {
        count: v.count,
        totalBytes: v.totalBytes,
        instanceSizeBytes: median,
        instanceSizeBytesMin: min,
        instanceSizeBytesMax: max,
        instanceSizeBytesMedian: median,
      });
    }
  }
  return out;
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
    let cycleSizeMin: number | undefined;
    let cycleSizeMax: number | undefined;
    let cycleSizeMedian: number | undefined;
    for (const [name, info] of cycleByClass.entries()) {
      if (!name.includes(input.className)) continue;
      cycleMatched += info.count;
      cycleBytesMatched += info.totalBytes;
      if (cycleInstanceSize == null && info.instanceSizeBytes != null) {
        cycleInstanceSize = info.instanceSizeBytes;
        cycleSizeMin = info.instanceSizeBytesMin;
        cycleSizeMax = info.instanceSizeBytesMax;
        cycleSizeMedian = info.instanceSizeBytesMedian;
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
    const variableSizeFields =
      cycleSizeMin != null && cycleSizeMax != null && cycleSizeMedian != null
        ? {
            instanceSizeBytesMin: cycleSizeMin,
            instanceSizeBytesMax: cycleSizeMax,
            instanceSizeBytesMedian: cycleSizeMedian,
          }
        : {};
    const entry: CountAliveEntry = wantReferenceTree
      ? {
          className: input.className,
          instanceCount: totalCount,
          byCycle: cycleMatched,
          byReferenceTree: refTreeMatched,
          ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
          ...variableSizeFields,
          ...(totalBytes > 0 ? { totalBytes } : {}),
        }
      : {
          className: input.className,
          instanceCount: cycleMatched,
          ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
          ...variableSizeFields,
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
      instanceSizeBytesMin?: number;
      instanceSizeBytesMax?: number;
      instanceSizeBytesMedian?: number;
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
      ...(info.instanceSizeBytesMin != null
        ? { instanceSizeBytesMin: info.instanceSizeBytesMin }
        : {}),
      ...(info.instanceSizeBytesMax != null
        ? { instanceSizeBytesMax: info.instanceSizeBytesMax }
        : {}),
      ...(info.instanceSizeBytesMedian != null
        ? { instanceSizeBytesMedian: info.instanceSizeBytesMedian }
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
      const variableSize =
        v.instanceSizeBytesMin != null &&
        v.instanceSizeBytesMax != null &&
        v.instanceSizeBytesMedian != null
          ? {
              instanceSizeBytesMin: v.instanceSizeBytesMin,
              instanceSizeBytesMax: v.instanceSizeBytesMax,
              instanceSizeBytesMedian: v.instanceSizeBytesMedian,
            }
          : {};
      return wantReferenceTree
        ? {
            className: name,
            instanceCount: totalCount,
            byCycle: v.byCycle,
            byReferenceTree: v.byReferenceTree,
            ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
            ...variableSize,
            ...(totalBytes > 0 ? { totalBytes } : {}),
          }
        : {
            className: name,
            instanceCount: v.byCycle,
            ...(instanceSizeBytes != null ? { instanceSizeBytes } : {}),
            ...variableSize,
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
  //
  // v1.17 B-10: filter is configurable. `excludeFrameworkNoise: false`
  // skips the filter entirely; `additionalNoisePatterns` extends the
  // curated list; `unsuppressClassPatterns` overrides it (keeps a class
  // in the actionable view even when the default list would filter it).
  if (wantReferenceTree && refTreeCounts.size > 0 && input.excludeFrameworkNoise !== false) {
    const additional = (input.additionalNoisePatterns ?? []).map(compileSafeRegex);
    const unsuppress = (input.unsuppressClassPatterns ?? []).map(compileSafeRegex);
    const audit: NonNullable<CountAliveResult["noiseAudit"]> = [];
    const actionable = allEntries
      .filter((e) => {
        const inDefault = isFrameworkNoise(e.className);
        const inAdditional = additional.some((re) => re.test(e.className));
        const isUnsuppressed = unsuppress.some((re) => re.test(e.className));
        if (inDefault && isUnsuppressed) {
          if (input.noiseAuditMode) audit.push({ className: e.className, reason: "kept-by-unsuppress" });
          return true; // keep
        }
        if (inDefault) {
          if (input.noiseAuditMode) audit.push({ className: e.className, reason: "default-list" });
          return false;
        }
        if (inAdditional && !isUnsuppressed) {
          if (input.noiseAuditMode) audit.push({ className: e.className, reason: "additional-pattern" });
          return false;
        }
        return true;
      })
      .slice(0, topN);
    if (actionable.length > 0) {
      result.actionableCounts = actionable;
    }
    if (input.noiseAuditMode) {
      result.noiseAudit = audit;
    }
  }

  return result;
}

/**
 * v1.17 B-10. Compile a user-supplied regex string safely, falling back to
 * a literal-match regex when the input is not valid regex syntax. Keeps
 * the tool resilient to operators copy-pasting plain class names.
 */
function compileSafeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}
