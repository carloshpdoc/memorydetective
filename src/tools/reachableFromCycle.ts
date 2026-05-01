import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import {
  shortenForVerbosity,
  type Verbosity,
} from "../parsers/shortenClassName.js";
import type { CycleNode, LeaksReport } from "../types.js";

/**
 * Cycle-scoped reachability + class counting.
 *
 * Answers questions like:
 *   "How many `NSURLSessionConfiguration` instances are reachable from the
 *    cycle rooted at `DetailViewModel`?"
 *
 * Where global `countAlive` would say "4495 NSURLSessionConfiguration", this
 * tool says "1100 reachable from each of the 4 cycles, so the cycle root is
 * the actual culprit pinning them in memory."
 *
 * API shape inspired by Meta's `memlab` predicate-based queries.
 */

export const reachableFromCycleSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  cycleIndex: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Zero-based index of the ROOT CYCLE to scope to. Mutually exclusive with `rootClassName`. When neither is given, defaults to cycle index 0.",
    ),
  rootClassName: z
    .string()
    .optional()
    .describe(
      "Substring of the root cycle's class name (e.g. \"DetailViewModel\"). Picks the first ROOT CYCLE whose root matches. Mutually exclusive with `cycleIndex`.",
    ),
  className: z
    .string()
    .optional()
    .describe(
      "Optional filter — only count nodes whose className contains this substring. When omitted, returns the full per-class breakdown.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Cap on per-class entries returned (default 20)."),
  verbosity: z
    .enum(["compact", "normal", "full"])
    .default("compact")
    .describe(
      "Class-name verbosity for the response. See analyzeMemgraph for the same flag.",
    ),
});

export type ReachableFromCycleInput = z.infer<typeof reachableFromCycleSchema>;

export interface ClassCount {
  className: string;
  count: number;
}

export interface ReachableFromCycleResult {
  ok: boolean;
  path: string;
  /** The cycle that was scoped to. */
  cycle: {
    index: number;
    rootClass: string;
    rootAddress: string;
    /** Total reachable nodes from this cycle root (including descendants). */
    totalReachable: number;
  };
  /** When `className` filter is provided, only that class shows up. Otherwise top N. */
  counts: ClassCount[];
  /** Total unique classes in the cycle's reachable set. */
  uniqueClasses: number;
}

/** Pure: walk the tree from root, count nodes by className. */
function countReachableFromNode(
  root: CycleNode,
  verbosity: Verbosity,
): { byClass: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  const visit = (n: CycleNode) => {
    total += 1;
    if (n.className) {
      const short = shortenForVerbosity(n.className, verbosity);
      counts.set(short, (counts.get(short) ?? 0) + 1);
    }
    for (const child of n.children) visit(child);
  };
  visit(root);
  return { byClass: counts, total };
}

function pickCycle(
  report: LeaksReport,
  input: ReachableFromCycleInput,
): { node: CycleNode; index: number } | null {
  const roots = rootCyclesOnly(report.cycles);
  if (roots.length === 0) return null;
  if (input.rootClassName) {
    const idx = roots.findIndex((r) =>
      r.className.includes(input.rootClassName!),
    );
    if (idx >= 0) return { node: roots[idx], index: idx };
    return null;
  }
  const idx = input.cycleIndex ?? 0;
  if (idx >= roots.length) return null;
  return { node: roots[idx], index: idx };
}

/** Pure: compute the result from a parsed report. Exposed for testing. */
export function reachableFromReport(
  report: LeaksReport,
  path: string,
  input: ReachableFromCycleInput,
): ReachableFromCycleResult {
  const picked = pickCycle(report, input);
  if (!picked) {
    throw new Error(
      input.rootClassName
        ? `No ROOT CYCLE found whose root class contains "${input.rootClassName}".`
        : `No ROOT CYCLE at index ${input.cycleIndex ?? 0}. Available roots: ${rootCyclesOnly(report.cycles).length}.`,
    );
  }

  const verbosity = input.verbosity ?? "compact";
  const { byClass, total } = countReachableFromNode(picked.node, verbosity);

  let entries: ClassCount[] = Array.from(byClass.entries()).map(([n, c]) => ({
    className: n,
    count: c,
  }));

  if (input.className) {
    entries = entries.filter((e) =>
      e.className.includes(input.className!),
    );
  }
  entries.sort((a, b) => b.count - a.count);
  entries = entries.slice(0, input.topN ?? 20);

  return {
    ok: true,
    path,
    cycle: {
      index: picked.index,
      rootClass: shortenForVerbosity(picked.node.className, verbosity),
      rootAddress: picked.node.address,
      totalReachable: total,
    },
    counts: entries,
    uniqueClasses: byClass.size,
  };
}

export async function reachableFromCycle(
  input: ReachableFromCycleInput,
): Promise<ReachableFromCycleResult> {
  if (input.cycleIndex !== undefined && input.rootClassName !== undefined) {
    throw new Error(
      "Provide either `cycleIndex` or `rootClassName`, not both.",
    );
  }
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  return reachableFromReport(report, resolvedPath, input);
}
