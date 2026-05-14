import { z } from "zod";
import { runCommand } from "../runtime/exec.js";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import {
  parseReferenceTreeText,
  isFrameworkNoise,
  type ReferenceTreeEntry,
} from "../parsers/referenceTree.js";
import { countByClass } from "./countAlive.js";
import type { LeaksReport, CycleNode } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

export const diffMemgraphsSchema = z.object({
  before: z
    .string()
    .min(1)
    .describe("Absolute path to the baseline `.memgraph` file."),
  after: z
    .string()
    .min(1)
    .describe("Absolute path to the comparison `.memgraph` file."),
  outputFormat: outputFormatField,
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

export interface ReferenceTreeDiffEntry {
  className: string;
  before: number;
  after: number;
  delta: number;
  beforeBytes: number;
  afterBytes: number;
  bytesDelta: number;
}

export interface DiffMemgraphsResult {
  ok: boolean;
  before: { path: string; leakCount: number };
  after: { path: string; leakCount: number };
  totals: {
    leakCountDelta: number;
    bytesLeakedDelta: number;
    /**
     * Net instance-count delta from the reference-tree (heap-wide) view.
     * Sum of all `referenceTreeChanges` deltas. Useful for "did the heap
     * shrink overall?" without scrolling per-class. New in v1.11.
     */
    referenceTreeInstanceDelta?: number;
    /** Net bytes delta from the reference-tree view. New in v1.11. */
    referenceTreeBytesDelta?: number;
  };
  classCounts: {
    /** Classes whose count went up (potential new leaks). Cycle-based view. */
    increased: Array<{ className: string; before: number; after: number; delta: number }>;
    /** Classes whose count went down (fixed leaks or just gone). Cycle-based view. */
    decreased: Array<{ className: string; before: number; after: number; delta: number }>;
  };
  /**
   * Heap-wide class-count changes from the reference-tree pass. Populated
   * even when `leakCount` is 0 in both snapshots (which is exactly when
   * cycle-only `classCounts` returns empty and the user wants this view).
   * Includes framework noise (NSMutableDictionary, CFString, etc.); see
   * `actionableReferenceTreeChanges` for the filtered view. New in v1.11.
   */
  referenceTreeChanges?: {
    increased: ReferenceTreeDiffEntry[];
    decreased: ReferenceTreeDiffEntry[];
  };
  /**
   * `referenceTreeChanges` with framework noise filtered out via
   * `isFrameworkNoise`. Surfaces AV / KVO / app-level classes for the
   * verify-fix loop without scrolling past Foundation collection growth.
   * New in v1.11.
   */
  actionableReferenceTreeChanges?: {
    increased: ReferenceTreeDiffEntry[];
    decreased: ReferenceTreeDiffEntry[];
  };
  cycles: {
    /** ROOT CYCLE signatures present only in `after`. */
    newInAfter: CycleDiffEntry[];
    /** Signatures present only in `before` (cycle disappeared). */
    goneFromBefore: CycleDiffEntry[];
    /** Signatures present in both; count change is what matters. */
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

/**
 * Pure: diff two reference-tree entry lists by class name and return
 * increased / decreased buckets. Each entry carries before/after counts,
 * bytes, and delta values. Sorted: increased by delta desc, decreased by
 * delta asc (most-negative first).
 *
 * Returns null when both inputs are empty. The async wrapper uses this
 * absence to suppress the `referenceTreeChanges` field on the result so
 * cycle-only callers see no change vs v1.10. New in v1.11.
 */
export function diffReferenceTrees(
  before: ReferenceTreeEntry[],
  after: ReferenceTreeEntry[],
): {
  increased: ReferenceTreeDiffEntry[];
  decreased: ReferenceTreeDiffEntry[];
} | null {
  if (before.length === 0 && after.length === 0) return null;
  const beforeByClass = new Map(before.map((e) => [e.className, e]));
  const afterByClass = new Map(after.map((e) => [e.className, e]));
  const allClasses = new Set([
    ...beforeByClass.keys(),
    ...afterByClass.keys(),
  ]);
  const increased: ReferenceTreeDiffEntry[] = [];
  const decreased: ReferenceTreeDiffEntry[] = [];
  for (const cls of allClasses) {
    const b = beforeByClass.get(cls);
    const a = afterByClass.get(cls);
    const beforeCount = b?.instanceCount ?? 0;
    const afterCount = a?.instanceCount ?? 0;
    const delta = afterCount - beforeCount;
    if (delta === 0) continue;
    const beforeBytes = b?.totalBytes ?? 0;
    const afterBytes = a?.totalBytes ?? 0;
    const entry: ReferenceTreeDiffEntry = {
      className: cls,
      before: beforeCount,
      after: afterCount,
      delta,
      beforeBytes,
      afterBytes,
      bytesDelta: afterBytes - beforeBytes,
    };
    if (delta > 0) increased.push(entry);
    else decreased.push(entry);
  }
  increased.sort((x, y) => y.delta - x.delta || y.bytesDelta - x.bytesDelta);
  decreased.sort((x, y) => x.delta - y.delta || x.bytesDelta - y.bytesDelta);
  return { increased, decreased };
}

/**
 * Wide capture pool for the reference-tree pass. Mirrors analyzeMemgraph's
 * 10x heuristic from v1.10: the actionable view filters out framework
 * noise (NSMutableDictionary, CFString, libMainThreadChecker bss, etc.)
 * so we need enough headroom for app-level classes ranked below the
 * noise leaders to survive into the post-filter top.
 */
const REFERENCE_TREE_DIFF_TOPN = 1000;

/** Spawn `leaks --referenceTree --groupByType --noContent` against a
 *  `.memgraph` and return parsed entries. Failure is non-fatal: returns
 *  an empty array so the cycle-side diff still completes. */
async function captureReferenceTree(
  path: string,
): Promise<ReferenceTreeEntry[]> {
  const result = await runCommand(
    "leaks",
    ["--referenceTree", "--groupByType", "--noContent", path],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) {
    return [];
  }
  return parseReferenceTreeText(result.stdout, REFERENCE_TREE_DIFF_TOPN);
}

export async function diffMemgraphs(
  input: DiffMemgraphsInput,
): Promise<DiffMemgraphsResult> {
  const [
    { report: before, resolvedPath: bp },
    { report: after, resolvedPath: ap },
    beforeRefTree,
    afterRefTree,
  ] = await Promise.all([
    runLeaksAndParse(input.before),
    runLeaksAndParse(input.after),
    captureReferenceTree(input.before),
    captureReferenceTree(input.after),
  ]);

  const result = diffReports(before, after, bp, ap);

  const referenceTreeChanges = diffReferenceTrees(beforeRefTree, afterRefTree);
  if (referenceTreeChanges) {
    result.referenceTreeChanges = referenceTreeChanges;
    // Actionable view: same diff with framework noise filtered out. Same
    // ordering preserved (no re-rank). Provides the verify-fix view for
    // the notelet-shape case where AVPlayerItem 342 to 0 needs to surface
    // above NSMutableDictionary 12k to 11k noise.
    result.actionableReferenceTreeChanges = {
      increased: referenceTreeChanges.increased.filter(
        (e) => !isFrameworkNoise(e.className),
      ),
      decreased: referenceTreeChanges.decreased.filter(
        (e) => !isFrameworkNoise(e.className),
      ),
    };
    // Heap-wide totals so callers can branch on a single number.
    let instanceDelta = 0;
    let bytesDelta = 0;
    for (const e of referenceTreeChanges.increased) {
      instanceDelta += e.delta;
      bytesDelta += e.bytesDelta;
    }
    for (const e of referenceTreeChanges.decreased) {
      instanceDelta += e.delta;
      bytesDelta += e.bytesDelta;
    }
    result.totals.referenceTreeInstanceDelta = instanceDelta;
    result.totals.referenceTreeBytesDelta = bytesDelta;
  }

  return result;
}
