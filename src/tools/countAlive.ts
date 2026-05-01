import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { walkCycles } from "../parsers/leaksOutput.js";
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
});

export type CountAliveInput = z.infer<typeof countAliveSchema>;

export interface CountAliveResult {
  ok: boolean;
  path: string;
  /** Total nodes counted in the cycle forest (across all classes). */
  totalNodes: number;
  /** Per-class counts. When `className` is given, contains a single entry. */
  counts: Array<{ className: string; instanceCount: number }>;
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

export async function countAlive(
  input: CountAliveInput,
): Promise<CountAliveResult> {
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  const counts = countByClass(report);
  const totalNodes = Array.from(counts.values()).reduce((a, b) => a + b, 0);

  if (input.className) {
    let matched = 0;
    for (const [name, n] of counts.entries()) {
      if (name.includes(input.className)) matched += n;
    }
    return {
      ok: true,
      path: resolvedPath,
      totalNodes,
      counts: [{ className: input.className, instanceCount: matched }],
    };
  }

  const top = Array.from(counts.entries())
    .map(([name, n]) => ({ className: name, instanceCount: n }))
    .sort((a, b) => b.instanceCount - a.instanceCount)
    .slice(0, input.topN ?? 20);

  return { ok: true, path: resolvedPath, totalNodes, counts: top };
}
