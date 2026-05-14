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
 * - "AVPlayerItem"                                      -> "AVPlayerItem"
 * - "_playerItem --> AVPlayerItemInternal"              -> "AVPlayerItemInternal"
 * - "__strong _object --> NSKeyValueObservance"         -> "NSKeyValueObservance"
 * - "<CFDictionary 0x6000029c4840> [64]"                -> "CFDictionary"
 * - "<NSMutableDictionary 0x600003ccf5c0> [32]"         -> "NSMutableDictionary"
 * - "_object --> <NSObject 0x14f100> [16]"              -> "NSObject"
 * - ""                                                  -> null (caller skips)
 *
 * The `<ClassName 0xADDR> [size]` form is what `leaks --referenceTree` emits
 * for arrow-targeted instances (e.g. `_object --> <NSObject 0xADDR>`).
 * Without normalization, each address becomes its own aggregation key and
 * the same logical class shows up as N separate rows in the top-N list.
 * Normalizing to the base class name (the token inside the `<...>`) folds
 * those rows back together. This is the v1.10 fix for the gap where
 * AVPlayerItem-style classes appeared aggregated at the root level but
 * NSMutableDictionary-style classes appeared per-address in arrow targets.
 *
 * Excludes c-runtime allocations like `malloc in FigSimpleMutex...` AND the
 * bracketed form `<malloc in ...>` / `<calloc in ...>` / `<realloc in ...>`
 * that leaks emits alongside Obj-C/Swift classes; those are not actionable
 * for abandoned-memory triage and would inflate the top-N list with
 * low-signal entries.
 */
export function extractClassName(rawLabel: string): string | null {
  const label = rawLabel.trim();
  if (label.length === 0) return null;
  // Resolve `--> Target` arrows first: the class name is the value's type,
  // not the property name that points at it. Then run the allocator + size
  // filters against the resolved candidate so entries like
  // `unaligned --> calloc in quic_stream_allocate` are correctly dropped.
  const arrowIdx = label.indexOf("-->");
  let candidate = arrowIdx >= 0 ? label.slice(arrowIdx + 3).trim() : label;
  if (candidate.length === 0) return null;
  // Raw allocator entries (`malloc in ...`, `calloc in ...`) are dropped.
  // Same for the bracketed form: `<malloc in ...>` / `<calloc in ...>`.
  if (/^(malloc|calloc|realloc)\b/i.test(candidate)) return null;
  if (/^<\s*(malloc|calloc|realloc)\b/i.test(candidate)) return null;
  // Normalize `<ClassName 0xADDR> [size]` and `<ClassName 0xADDR>` to
  // `ClassName`. The base-class name is the leading token inside `<...>`,
  // before the first space (which separates it from the address).
  const bracketMatch = /^<\s*([^\s<>]+)\s+0x[0-9a-fA-F]+\s*>(?:\s*\[[^\]]+\])?\s*$/.exec(candidate);
  if (bracketMatch) {
    candidate = bracketMatch[1];
  }
  return candidate;
}

/**
 * Pure: returns true when the class name is framework-noise that crowds out
 * actionable classes in the abandoned-memory top-N list. Used by the
 * `analyzeMemgraph` and `analyzeAbandonedMemory` tools to populate a
 * `*Suspects[]` / `actionable*[]` field alongside the raw `*Top[]` field.
 *
 * The list catalogs:
 * - Foundation collection types (`NSMutableDictionary`, `CFString`, etc.)
 *   that grow with normal app activity and are rarely the leak itself
 * - ObjC runtime / metadata classes (`Class.data`, `OBJC_METACLASS_$...`)
 * - Apple system frameworks' static data sections (`__DATA __bss`,
 *   `__DATA __data`, `__DATA __common`)
 * - `<<TOTAL>>` summary row
 * - "Stack of thread N" and similar meta-rows
 * - Non-object zone descriptors and memory-zone metadata
 *
 * Deliberately NOT noise: AV*, NSKeyValueObserv*, SwiftUI app-level types,
 * Combine, RxSwift, app-named classes, anonymous closures (`<closure ...>`).
 *
 * The default behavior of `analyzeMemgraph` continues to return the raw
 * `abandonedMemoryTop[]` so callers who need framework-collection counts
 * (e.g. cache-bloat investigations) still see them. The actionable field
 * is parallel data, not a replacement.
 */
export function isFrameworkNoise(className: string): boolean {
  // Summary / meta-rows
  if (className === "<<TOTAL>>" || className === "<< TOTAL >>") return true;
  if (/^Stack of thread\b/i.test(className)) return true;
  if (/^non-object\b/i.test(className)) return true;
  // Memory zones / VM regions
  if (/^VM:\s/.test(className)) return true;
  if (/(DefaultMallocZone|QuartzCore_0x|MALLOC_)/.test(className)) return true;
  // ObjC runtime + metadata
  if (/^Class\.(data|methodCache)/.test(className)) return true;
  if (/^OBJC_METACLASS_/.test(className)) return true;
  if (/^OBJC_CLASS_/.test(className)) return true;
  // Apple framework static-data sections
  if (/__DATA\s+__(bss|data|common|objc_data|objc_const)/.test(className)) return true;
  if (/__DATA_DIRTY\b/.test(className)) return true;
  if (/dylib\s+__DATA/.test(className)) return true;
  // Block infrastructure (closures, GCD work items)
  if (className === "__NSMallocBlock__") return true;
  if (className === "__NSConcreteMallocBlock") return true;
  if (className === "__NSStackBlock__") return true;
  if (className === "__NSGlobalBlock__") return true;
  // Swift runtime metadata
  if (className === "Swift Metadata") return true;
  if (/^Swift\.OpaqueExistentialContainer\b/.test(className)) return true;
  // GCD infrastructure (queue + group + semaphore types accumulate naturally).
  // No word-boundary because `dispatch_queue_t` / `dispatch_semaphore_t`
  // continue with `_t` after the type name (no `\b` between word chars).
  if (/^dispatch_(queue|group|semaphore|source|io)(_t)?\b/.test(className)) return true;
  // C++ stdlib bookkeeping
  if (/^std::__shared_ptr_emplace</.test(className)) return true;
  if (/^std::__1::shared_ptr</.test(className)) return true;
  // Foundation key/value/map collections (scale with app activity, rarely
  // the actionable leak site)
  if (/^NSMapTable\b/.test(className)) return true;
  if (/^NSHashTable\b/.test(className)) return true;
  // Bundle metadata (loads + caches grow naturally with app activity)
  if (className === "NSBundle" || className === "CFBundle") return true;
  // Network.framework / XPC / BackBoardServices internal types
  if (/^OS_(nw|xpc|os_lock|object)_/.test(className)) return true;
  if (/^NWConcrete_/.test(className)) return true;
  if (/^nw_/.test(className)) return true;
  if (/^BSObjC/.test(className)) return true;
  // Font cache infrastructure (CoreText)
  if (className === "UICTFont" || className === "TTenuousComponentFont") return true;
  // Block/closure infrastructure that leaks(1) labels generically
  if (className === "Closure context (unknown layout)") return true;
  // Array storage (Foundation/CoreFoundation backing storage)
  if (/^NSArray\._list/.test(className)) return true;
  // SwiftUI internal anonymized buffers (private namespaces ending in dollar-tagged module ids).
  // Real app-level SwiftUI types use module-qualified names like `MyApp.MyView`;
  // these anonymized SwiftUI internals scale with view-graph activity.
  if (/^SwiftUI\.\(.+ in \$[0-9a-f]+\)</.test(className)) return true;
  // Foundation collection types that grow with normal app activity
  const noiseCollections = new Set([
    "NSMutableDictionary",
    "NSMutableDictionary (Storage)",
    "NSDictionary",
    "NSDictionary (Storage)",
    "NSMutableArray",
    "NSMutableArray (Storage)",
    "NSArray",
    "NSArray (Storage)",
    "NSMutableSet",
    "NSSet",
    "CFString",
    "CFString (Storage)",
    "CFDictionary",
    "CFDictionary (Storage)",
    "CFDictionary (Value Storage)",
    "CFArray",
    "CFSet",
    "CFSet (Value Storage)",
    "CFData",
    "NSData",
    "NSConcreteMutableData",
    "__NSCFString",
    "__NSCFData",
    "__NSCFDictionary",
    "__NSCFArray",
    "NSConcreteAttributedString",
  ]);
  if (noiseCollections.has(className)) return true;
  // Closure contexts and Swift internal storage that scale with app activity
  if (/^Swift\._ContiguousArrayStorage</.test(className)) return true;
  if (/^Swift\._SwiftDeferredNSDictionary</.test(className)) return true;
  // Anonymous bracketed instances that still leaked through (extractClassName
  // missed them, e.g. closures with no class name).
  if (/^<[^>]*0x[0-9a-fA-F]+>/.test(className)) return true;
  // "N bytes into <SomeClass 0xADDR> [size]" form. These are heap offsets,
  // not class instances; they represent partial allocations and scale with
  // app activity (Swift runtime growing, ObjC class table loading, etc.).
  if (/^\d+ bytes into\b/.test(className)) return true;
  // Foundation observer registry internals (these grow with KVO activity but
  // are not the actionable site; the user's class is what to fix).
  if (className === "CFXNotificationRegistrar") return true;
  if (/^_realloc in/.test(className)) return true;
  return false;
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
