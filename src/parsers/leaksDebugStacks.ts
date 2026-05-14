/**
 * Parser for `leaks --debug=stacks --debug='<ClassName>$'` output.
 *
 * This is the canonical way to get the allocation stack + retainer list for
 * a specific class without it being part of a strict cycle. The notelet
 * investigation's `342 to 0 AVPlayerItem` count came from running this
 * command directly + grepping `_objc_rootAllocWithZone | wc -l`. v1.12
 * automates the parse + aggregates by call-stack fingerprint so the
 * response is a small structured list instead of 342 verbose blocks.
 *
 * Output shape (per SCANNING block):
 *
 * ```text
 * SCANNING <AVPlayerItem 0xADDR> [size]
 *     Call stack: 0xADDR (dyld) start | 0xADDR (...) ??? | ...
 * REFERENCES TO THIS: N   STRONG: X  CONSERVATIVE: Y  WEAK UU etc: Z
 *    <retainer-class 0xADDR> [size]   +offset: edge-name 0xADDR
 *    ...
 * CONTENTS:
 *    +offset: field-name      0xADDR --> <target-class 0xADDR> [size]
 *    ...
 * ```
 *
 * Multiple SCANNING blocks (one per instance) are aggregated by
 * call-stack fingerprint. Identical stacks count as one chain with
 * `instanceCount: N` instead of N duplicates.
 */

export interface AllocationFrame {
  /** Hex address of the frame, e.g. "0x100e97da4". */
  address: string;
  /** Image/binary name in parentheses, e.g. "(dyld)" or "(NoteletDemo.debug.dylib)". */
  image: string;
  /** Symbol name when symbolicated, e.g. "_objc_rootAllocWithZone" or "MediaNoteItemVideoView.prepareVideo". `???` when stripped. */
  symbol: string;
}

export interface ReferenceTreeChain {
  /** How many instances share this exact call-stack fingerprint. */
  instanceCount: number;
  /**
   * Call-stack frames from outer (root, dyld start) to inner (allocation site).
   * The leaks output emits them in dyld-first order; we preserve that.
   */
  callStack: AllocationFrame[];
  /** A representative instance address for the user to chain into via `leaks <addr>`. */
  exampleAddress: string;
  /** Unique retainer classes referenced from THIS instance with how often each appeared across the aggregation group. */
  retainers: Array<{ className: string; count: number }>;
  /** The "user-actionable" frame: the deepest frame whose image isn't system (dyld, libobjc, libsystem, libdispatch, SwiftUI core runtime). Surfaces the line a developer would inspect. */
  userFrame?: AllocationFrame;
}

/** Image names we treat as "system runtime" when scanning for the user-actionable frame. */
const SYSTEM_IMAGES = new Set([
  "dyld",
  "dyld_sim",
  "libobjc.A.dylib",
  "libsystem_malloc.dylib",
  "libsystem_pthread.dylib",
  "libsystem_c.dylib",
  "libdispatch.dylib",
  "libswift_Concurrency.dylib",
  "libswiftCore.dylib",
  "libswiftFoundation.dylib",
  "com.apple.Foundation",
  "com.apple.CoreFoundation",
  "com.apple.SwiftUI",
  "com.apple.UIKitCore",
  "com.apple.GraphicsServices",
]);

/**
 * Pure: parse a single `Call stack: ...` line into an ordered list of frames.
 * Frames are pipe-separated; each frame is `<hex-addr> (<image>) <symbol>`.
 */
export function parseCallStackLine(line: string): AllocationFrame[] {
  // Strip the leading "Call stack:" prefix and split by " | " separator.
  const m = /Call stack:\s*(.*)$/.exec(line.trim());
  if (!m) return [];
  const raw = m[1];
  const frames: AllocationFrame[] = [];
  for (const part of raw.split("|").map((s) => s.trim())) {
    if (!part) continue;
    // `0xADDR (image) symbol`
    const fm = /^(0x[0-9a-fA-F]+)\s*\(([^)]+)\)\s*(.*)$/.exec(part);
    if (!fm) continue;
    frames.push({
      address: fm[1],
      image: fm[2],
      symbol: fm[3].trim() || "???",
    });
  }
  return frames;
}

/**
 * Heuristic: pick the user-actionable frame from a call stack. The deepest
 * (closest to allocation) frame whose image is NOT a system runtime. For
 * notelet, this resolves to `MediaNoteItemVideoView.prepareVideo` -- the
 * line in the library that called `AVPlayerItem.init`.
 */
export function pickUserFrame(
  frames: AllocationFrame[],
): AllocationFrame | undefined {
  // Walk from innermost (end of array) to outermost (start) looking for
  // the first non-system image. Skip frames whose symbol is `???`.
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (SYSTEM_IMAGES.has(f.image)) continue;
    if (f.symbol === "???") continue;
    return f;
  }
  return undefined;
}

/**
 * Fingerprint a call stack for aggregation. Strips addresses (which differ
 * per instance even when the call site is the same), keeps image + symbol.
 */
function fingerprintCallStack(frames: AllocationFrame[]): string {
  return frames.map((f) => `${f.image}::${f.symbol}`).join("|");
}

/** Pure: parse the full `leaks --debug=stacks` output for a class. */
export function parseLeaksDebugStacks(
  output: string,
): ReferenceTreeChain[] {
  const blocks = output.split(/^SCANNING\s+/m).slice(1);

  // Aggregate per fingerprint.
  interface Bucket {
    instanceCount: number;
    callStack: AllocationFrame[];
    exampleAddress: string;
    retainerCounts: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const block of blocks) {
    // Block header: `<ClassName 0xADDR> [size]\n` followed by indented lines.
    const headerMatch = /^<[^>]+\s+(0x[0-9a-fA-F]+)>\s*\[\d+\]/.exec(block);
    if (!headerMatch) continue;
    const exampleAddress = headerMatch[1];

    const lines = block.split(/\r?\n/);
    let callStack: AllocationFrame[] = [];
    const retainers = new Set<string>();
    let inRetainerSection = false;
    let inContentsSection = false;

    for (const line of lines) {
      if (line.includes("Call stack:")) {
        callStack = parseCallStackLine(line);
        continue;
      }
      if (/^REFERENCES TO THIS:/.test(line.trim())) {
        inRetainerSection = true;
        inContentsSection = false;
        continue;
      }
      if (/^CONTENTS:/.test(line.trim())) {
        inRetainerSection = false;
        inContentsSection = true;
        continue;
      }
      if (inRetainerSection) {
        // Lines look like:
        //   `   <retainer-class 0xADDR> [size]   +N: edge 0xADDR`
        //   `   <NSMutableSet (Storage) 0xADDR> [size]    +N: __strong 0xADDR`
        // The class name can contain spaces and parens (Foundation storage
        // variants); capture everything between the leading `<` and the
        // ` 0xADDR>` suffix. Greedy until the last space-then-hex pattern.
        const rm = /<\s*(.+?)\s+0x[0-9a-fA-F]+\s*>/.exec(line);
        if (rm) {
          const name = rm[1].trim();
          if (name.length > 0) retainers.add(name);
        }
      }
      // We don't currently capture CONTENTS (outgoing edges). Could be
      // surfaced later as a separate field if useful.
      void inContentsSection;
    }

    if (callStack.length === 0) continue;
    const fp = fingerprintCallStack(callStack);
    const existing = buckets.get(fp);
    if (existing) {
      existing.instanceCount += 1;
      for (const r of retainers) {
        existing.retainerCounts.set(
          r,
          (existing.retainerCounts.get(r) ?? 0) + 1,
        );
      }
    } else {
      const retainerCounts = new Map<string, number>();
      for (const r of retainers) retainerCounts.set(r, 1);
      buckets.set(fp, {
        instanceCount: 1,
        callStack,
        exampleAddress,
        retainerCounts,
      });
    }
  }

  const chains: ReferenceTreeChain[] = [];
  for (const b of buckets.values()) {
    const retainers = Array.from(b.retainerCounts.entries())
      .map(([className, count]) => ({ className, count }))
      .sort((x, y) => y.count - x.count);
    const chain: ReferenceTreeChain = {
      instanceCount: b.instanceCount,
      callStack: b.callStack,
      exampleAddress: b.exampleAddress,
      retainers,
    };
    const uf = pickUserFrame(b.callStack);
    if (uf) chain.userFrame = uf;
    chains.push(chain);
  }
  chains.sort((a, b) => b.instanceCount - a.instanceCount);
  return chains;
}
