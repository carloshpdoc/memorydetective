import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { parseLeaksOutput, rootCyclesOnly } from "../parsers/leaksOutput.js";
import type { CycleNode, LeaksReport } from "../types.js";

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
  /** Class names appearing anywhere in the chain (deduped). */
  classesInChain: string[];
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
}

/**
 * Pure function: take a `leaks` stdout string and a source path, produce a structured analysis.
 * Split out so it can be tested without spawning a subprocess.
 */
export function summarizeLeaks(
  leaksText: string,
  path: string,
  fullChains = false,
): AnalyzeMemgraphResult {
  const report = parseLeaksOutput(leaksText);
  const roots = rootCyclesOnly(report.cycles);
  const cycles: CycleSummary[] = roots.map((c) => summarizeCycle(c));

  const diagnosis = buildDiagnosis(report, cycles);

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
  };
}

function summarizeCycle(node: CycleNode): CycleSummary {
  const classes = new Set<string>();
  let chainLength = 0;
  const visit = (n: CycleNode) => {
    chainLength += 1;
    if (n.className) classes.add(n.className);
    for (const child of n.children) visit(child);
  };
  visit(node);
  return {
    className: node.className,
    address: node.address,
    count: node.count,
    size: node.size,
    instanceSize: node.instanceSize,
    chainLength,
    classesInChain: Array.from(classes),
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

  return summarizeLeaks(result.stdout, path, input.fullChains ?? false);
}
