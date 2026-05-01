import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseLeaksOutput,
  rootCyclesOnly,
  walkCycles,
} from "../parsers/leaksOutput.js";
import type { CycleNode } from "../types.js";

export const findCyclesSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  className: z
    .string()
    .optional()
    .describe(
      "Optional substring filter — only return cycles where this class name appears in the chain (e.g. \"DetailViewModel\").",
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Truncate chains beyond this depth (default 10)."),
});

export type FindCyclesInput = z.infer<typeof findCyclesSchema>;

export interface CycleChainEntry {
  depth: number;
  edge?: string;
  retainKind: string;
  className: string;
  address: string;
  count?: number;
  size?: string;
  isRootCycle: boolean;
  isCycleBack: boolean;
}

export interface CycleResult {
  rootClass: string;
  rootAddress: string;
  count?: number;
  size?: string;
  chain: CycleChainEntry[];
  /** True if some node in the chain matched the optional className filter. */
  matched: boolean;
}

export interface FindCyclesResult {
  ok: boolean;
  path: string;
  totalCycles: number;
  filterApplied?: string;
  cycles: CycleResult[];
}

function flattenChain(
  node: CycleNode,
  maxDepth: number,
): CycleChainEntry[] {
  const out: CycleChainEntry[] = [];
  for (const { node: n, depth } of walkCycles([node])) {
    if (depth > maxDepth) continue;
    out.push({
      depth,
      edge: n.edge,
      retainKind: n.retainKind,
      className: n.className,
      address: n.address,
      count: n.count,
      size: n.size,
      isRootCycle: n.isRootCycle,
      isCycleBack: n.isCycleBack,
    });
  }
  return out;
}

/** Pure function: parse `leaks` output and return the cycles array. */
export function extractCycles(
  leaksText: string,
  path: string,
  filter?: string,
  maxDepth = 10,
): FindCyclesResult {
  const report = parseLeaksOutput(leaksText);
  const roots = rootCyclesOnly(report.cycles);

  const cycles: CycleResult[] = roots.map((c) => {
    const chain = flattenChain(c, maxDepth);
    const matched = filter
      ? chain.some((entry) => entry.className.includes(filter))
      : true;
    return {
      rootClass: c.className,
      rootAddress: c.address,
      count: c.count,
      size: c.size,
      chain,
      matched,
    };
  });

  const filtered = filter ? cycles.filter((c) => c.matched) : cycles;

  return {
    ok: true,
    path,
    totalCycles: roots.length,
    filterApplied: filter,
    cycles: filtered,
  };
}

export async function findCycles(
  input: FindCyclesInput,
): Promise<FindCyclesResult> {
  const path = resolvePath(input.path);
  if (!existsSync(path)) {
    throw new Error(`Memgraph file not found: ${path}`);
  }
  const result = await runCommand("leaks", [path], {
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return extractCycles(
    result.stdout,
    path,
    input.className,
    input.maxDepth ?? 10,
  );
}
