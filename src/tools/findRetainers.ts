import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
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
  /** Pipeline hint — once you know who retains the class, locate it in source. */
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

export async function findRetainers(
  input: FindRetainersInput,
): Promise<FindRetainersResult> {
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  const { totalMatches, retainers } = findRetainersIn(
    report,
    input.className,
    input.maxResults ?? 10,
  );

  const suggestedNextCalls: NextCallSuggestion[] =
    totalMatches > 0
      ? [suggestionGetDefinition({ symbolName: input.className })]
      : [];

  return {
    ok: true,
    path: resolvedPath,
    className: input.className,
    totalMatches,
    retainers,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}
