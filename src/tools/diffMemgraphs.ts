import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import { countByClass } from "./countAlive.js";
import type { LeaksReport, CycleNode } from "../types.js";

export const diffMemgraphsSchema = z.object({
  before: z
    .string()
    .min(1)
    .describe("Absolute path to the baseline `.memgraph` file."),
  after: z
    .string()
    .min(1)
    .describe("Absolute path to the comparison `.memgraph` file."),
});

export type DiffMemgraphsInput = z.infer<typeof diffMemgraphsSchema>;

export interface CycleSignature {
  /** Top-level class of the cycle, used as a stable identity across snapshots. */
  rootClass: string;
  /** First few descendant class names — fingerprints the chain shape. */
  shape: string[];
}

export interface CycleDiffEntry {
  signature: CycleSignature;
  beforeCount: number;
  afterCount: number;
  delta: number;
}

export interface DiffMemgraphsResult {
  ok: boolean;
  before: { path: string; leakCount: number };
  after: { path: string; leakCount: number };
  totals: {
    leakCountDelta: number;
    bytesLeakedDelta: number;
  };
  classCounts: {
    /** Classes whose count went up (potential new leaks). */
    increased: Array<{ className: string; before: number; after: number; delta: number }>;
    /** Classes whose count went down (fixed leaks or just gone). */
    decreased: Array<{ className: string; before: number; after: number; delta: number }>;
  };
  cycles: {
    /** ROOT CYCLE signatures present only in `after`. */
    newInAfter: CycleDiffEntry[];
    /** Signatures present only in `before` (cycle disappeared). */
    goneFromBefore: CycleDiffEntry[];
    /** Signatures present in both — count change is what matters. */
    persisted: CycleDiffEntry[];
  };
}

function fingerprint(node: CycleNode, maxShapeDepth = 4): CycleSignature {
  const shape: string[] = [];
  const collect = (n: CycleNode, depth: number): void => {
    if (depth >= maxShapeDepth) return;
    if (n.className) shape.push(n.className);
    for (const child of n.children) collect(child, depth + 1);
  };
  for (const child of node.children) collect(child, 0);
  return { rootClass: node.className || node.address, shape: shape.slice(0, maxShapeDepth) };
}

function signatureKey(sig: CycleSignature): string {
  return `${sig.rootClass}::${sig.shape.join("|")}`;
}

interface SignatureBucket {
  signature: CycleSignature;
  count: number;
}

function bucketCycles(report: LeaksReport): Map<string, SignatureBucket> {
  const buckets = new Map<string, SignatureBucket>();
  for (const root of rootCyclesOnly(report.cycles)) {
    const sig = fingerprint(root);
    const key = signatureKey(sig);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += root.count ?? 1;
    } else {
      buckets.set(key, { signature: sig, count: root.count ?? 1 });
    }
  }
  return buckets;
}

/** Pure: compare two parsed reports and return a structured diff. */
export function diffReports(
  before: LeaksReport,
  after: LeaksReport,
  beforePath: string,
  afterPath: string,
): DiffMemgraphsResult {
  const beforeBuckets = bucketCycles(before);
  const afterBuckets = bucketCycles(after);
  const allKeys = new Set([...beforeBuckets.keys(), ...afterBuckets.keys()]);

  const newInAfter: CycleDiffEntry[] = [];
  const goneFromBefore: CycleDiffEntry[] = [];
  const persisted: CycleDiffEntry[] = [];

  for (const key of allKeys) {
    const b = beforeBuckets.get(key);
    const a = afterBuckets.get(key);
    const sig = (a ?? b)!.signature;
    const beforeCount = b?.count ?? 0;
    const afterCount = a?.count ?? 0;
    const entry: CycleDiffEntry = {
      signature: sig,
      beforeCount,
      afterCount,
      delta: afterCount - beforeCount,
    };
    if (!b && a) newInAfter.push(entry);
    else if (b && !a) goneFromBefore.push(entry);
    else persisted.push(entry);
  }

  const beforeClassCounts = countByClass(before);
  const afterClassCounts = countByClass(after);
  const allClasses = new Set([
    ...beforeClassCounts.keys(),
    ...afterClassCounts.keys(),
  ]);
  const increased: DiffMemgraphsResult["classCounts"]["increased"] = [];
  const decreased: DiffMemgraphsResult["classCounts"]["decreased"] = [];
  for (const cls of allClasses) {
    const b = beforeClassCounts.get(cls) ?? 0;
    const a = afterClassCounts.get(cls) ?? 0;
    const delta = a - b;
    if (delta > 0) increased.push({ className: cls, before: b, after: a, delta });
    else if (delta < 0)
      decreased.push({ className: cls, before: b, after: a, delta });
  }
  increased.sort((x, y) => y.delta - x.delta);
  decreased.sort((x, y) => x.delta - y.delta);

  return {
    ok: true,
    before: { path: beforePath, leakCount: before.totals.leakCount },
    after: { path: afterPath, leakCount: after.totals.leakCount },
    totals: {
      leakCountDelta: after.totals.leakCount - before.totals.leakCount,
      bytesLeakedDelta:
        after.totals.totalLeakedBytes - before.totals.totalLeakedBytes,
    },
    classCounts: { increased, decreased },
    cycles: { newInAfter, goneFromBefore, persisted },
  };
}

export async function diffMemgraphs(
  input: DiffMemgraphsInput,
): Promise<DiffMemgraphsResult> {
  const [{ report: before, resolvedPath: bp }, { report: after, resolvedPath: ap }] =
    await Promise.all([
      runLeaksAndParse(input.before),
      runLeaksAndParse(input.after),
    ]);
  return diffReports(before, after, bp, ap);
}
