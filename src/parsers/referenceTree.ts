/**
 * Parser for `leaks <memgraph> --referenceTree --groupByType --noContent`.
 *
 * `leaks --referenceTree` walks the heap reachability graph and prints
 * per-class instance counts plus total bytes. With `--groupByType`, instances
 * of the same class are aggregated into a single entry; with `--noContent`,
 * the inline ivar dumps are suppressed so the tree stays compact.
 *
 * Example input (excerpt from a real run on a notelet-like target):
 *
 * ```text
 *       + ! : 342 (28.8K) AVPlayerItem
 *       + ! : | 334 (28.7K) _playerItem --> AVPlayerItemInternal
 *       + ! : 290 (19.1K) AVPlayerPlaybackCoordinator
 *       + !   1 (48 bytes) __strong _object --> NSKeyValueObservance
 *       + !     15 (720 bytes) __strong _object --> NSKeyValueObservance
 *       + !       8 (384 bytes) NSKeyValueObservance
 *       + !   9 (400 bytes) NSKeyValueObservationInfo
 * ```
 *
 * Each data line has the shape:
 *
 *     <tree indent> <count> (<size>) <name> [--> <className>]
 *
 * - When `--> ClassName` is present, the class name is the part AFTER the
 *   arrow (the value's type). The text before the arrow is the property /
 *   ivar name pointing at it.
 * - When no arrow is present, the trailing token IS the class name.
 *
 * memorydetective's abandoned-memory surface aggregates by class name across
 * the entire tree, summing counts and bytes, and returns the top N by
 * instance count. The use case is "show me classes that are alive in the
 * heap that the agent should suspect", which is orthogonal to leak count.
 */

export interface ReferenceTreeEntry {
  className: string;
  instanceCount: number;
  totalBytes: number;
}

const LINE_RE =
  // Tree indent prefix is arbitrary, just match anything up to a sequence of digits at the start of the value column.
  // Capture: 1=count, 2=size literal (e.g. "832 bytes", "28.8K", "1.5M")
  // Then the trailing label, optionally containing "-->".
  /(?:^|\s)(\d+)\s+\(([^)]+)\)\s+(.+?)\s*$/;

const KILO = 1024;

/**
 * Pure: parse a size literal from leaks output like "832 bytes", "28.8K", "1.5M".
 * Returns the value in BYTES. Unrecognized formats return 0 (parser is
 * conservative; the aggregation that consumes this still produces a usable
 * count even if the size is missing).
 */
export function parseSizeBytes(raw: string): number {
  const trimmed = raw.trim();
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(bytes?|K|M|G)?$/.exec(trimmed);
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] ?? "bytes").toLowerCase();
  switch (unit) {
    case "byte":
    case "bytes":
      return Math.round(value);
    case "k":
      return Math.round(value * KILO);
    case "m":
      return Math.round(value * KILO * KILO);
    case "g":
      return Math.round(value * KILO * KILO * KILO);
    default:
      return 0;
  }
}

/**
 * Pure: extract the class name from a leaks reference-tree line value.
 *
 * - "AVPlayerItem"                       -> "AVPlayerItem"
 * - "_playerItem --> AVPlayerItemInternal" -> "AVPlayerItemInternal"
 * - "__strong _object --> NSKeyValueObservance" -> "NSKeyValueObservance"
 * - ""                                   -> null (caller skips)
 *
 * Excludes c-runtime allocations like "malloc in FigSimpleMutex..." that
 * leaks emits alongside Obj-C/Swift classes; those are not actionable for
 * abandoned-memory triage and would inflate the top-N list with low-signal
 * entries.
 */
export function extractClassName(rawLabel: string): string | null {
  const label = rawLabel.trim();
  if (label.length === 0) return null;
  if (/^(malloc|calloc|realloc)\b/i.test(label)) return null;
  const arrowIdx = label.indexOf("-->");
  const candidate = arrowIdx >= 0 ? label.slice(arrowIdx + 3).trim() : label;
  if (candidate.length === 0) return null;
  return candidate;
}

/**
 * Pure: parse `leaks --referenceTree --groupByType --noContent` stdout,
 * aggregate instance counts + bytes by class name, return the top N by
 * instance count.
 *
 * Returned entries are sorted by `instanceCount` desc, ties broken by
 * `totalBytes` desc, ties broken by alphabetic class name for stability.
 *
 * The caller passes `topN` so very large heaps do not produce massive
 * responses; the default in the tool is 20 but the parser does not impose
 * a default to keep the function pure.
 */
export function parseReferenceTreeText(
  text: string,
  topN: number,
): ReferenceTreeEntry[] {
  if (topN <= 0) return [];
  const counts = new Map<string, { instanceCount: number; totalBytes: number }>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const count = Number.parseInt(m[1], 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    const sizeBytes = parseSizeBytes(m[2]);
    const className = extractClassName(m[3]);
    if (className == null) continue;
    const existing = counts.get(className);
    if (existing) {
      existing.instanceCount += count;
      existing.totalBytes += sizeBytes;
    } else {
      counts.set(className, { instanceCount: count, totalBytes: sizeBytes });
    }
  }
  const entries: ReferenceTreeEntry[] = Array.from(counts, ([className, v]) => ({
    className,
    instanceCount: v.instanceCount,
    totalBytes: v.totalBytes,
  }));
  entries.sort((a, b) => {
    if (b.instanceCount !== a.instanceCount)
      return b.instanceCount - a.instanceCount;
    if (b.totalBytes !== a.totalBytes) return b.totalBytes - a.totalBytes;
    return a.className.localeCompare(b.className);
  });
  return entries.slice(0, topN);
}
