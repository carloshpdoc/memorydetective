import { describe, it, expect } from "vitest";
import {
  parseCallStackLine,
  pickUserFrame,
  parseLeaksDebugStacks,
} from "./leaksDebugStacks.js";

const SINGLE_BLOCK_FIXTURE = `SCANNING <AVPlayerItem 0x600003e809c0> [16]
\tCall stack: 0x100e97da4 (dyld) start | 0x10188c580 (NoteletDemo.debug.dylib) static NoteletDemoApp.$main | 0x101895474 (NoteletDemo.debug.dylib) MediaNoteItemVideoView.prepareVideo | 0x1018964b8 (NoteletDemo.debug.dylib) AVPlayerItem.init | 0x100d1af18 (libobjc.A.dylib) _objc_rootAllocWithZone | 0x107f43e5c (libsystem_malloc.dylib) _calloc
REFERENCES TO THIS: 8   STRONG: 2  CONSERVATIVE: 6  WEAK UU etc: 0
   <AVPlayerInternal 0x14f024160> [784]   +176: currentItem 0x14f024210
   <AVPlayerInternal 0x14f024160> [784]   +184: lastItem 0x14f024218
   <AVRetainReleaseWeakReference 0x600003c01840> [32]    +16: _weakStorage 0x600003c01850
   <NSMutableSet (Storage) 0x600003c02620> [32]     +8: __strong  0x600003c02628
CONTENTS:
    +8: _playerItem       0x600003e809c8 --> <AVPlayerItemInternal 0x155050a00> [1536]
`;

const MULTI_BLOCK_FIXTURE =
  SINGLE_BLOCK_FIXTURE +
  `SCANNING <AVPlayerItem 0x600003e80f60> [16]
\tCall stack: 0x100e97da4 (dyld) start | 0x10188c580 (NoteletDemo.debug.dylib) static NoteletDemoApp.$main | 0x101895474 (NoteletDemo.debug.dylib) MediaNoteItemVideoView.prepareVideo | 0x1018964b8 (NoteletDemo.debug.dylib) AVPlayerItem.init | 0x100d1af18 (libobjc.A.dylib) _objc_rootAllocWithZone | 0x107f43e5c (libsystem_malloc.dylib) _calloc
REFERENCES TO THIS: 8   STRONG: 2  CONSERVATIVE: 6  WEAK UU etc: 0
   <AVPlayerInternal 0x14f03dd90> [784]   +176: currentItem 0x14f03de40
   <AVRetainReleaseWeakReference 0x600003c59100> [32]    +16: _weakStorage 0x600003c59110
CONTENTS:
    +8: _playerItem       0x600003e80f68 --> <AVPlayerItemInternal 0x15505ba00> [1536]
`;

const DIFFERENT_STACK_FIXTURE =
  SINGLE_BLOCK_FIXTURE +
  `SCANNING <AVPlayerItem 0x600003e90000> [16]
\tCall stack: 0x100e97da4 (dyld) start | 0x10188c580 (NoteletDemo.debug.dylib) static NoteletDemoApp.$main | 0x101896000 (NoteletDemo.debug.dylib) SomeOtherCallSite | 0x1018964b8 (NoteletDemo.debug.dylib) AVPlayerItem.init
REFERENCES TO THIS: 1   STRONG: 1  CONSERVATIVE: 0  WEAK UU etc: 0
   <AVPlayerInternal 0xdeadbeef> [784]   +176: currentItem 0xcafe
CONTENTS:
`;

describe("parseCallStackLine", () => {
  it("parses pipe-separated frames into {address, image, symbol}", () => {
    const frames = parseCallStackLine(
      "\tCall stack: 0x100e97da4 (dyld) start | 0x10188c580 (NoteletDemo.debug.dylib) AVPlayerItem.init",
    );
    expect(frames).toEqual([
      { address: "0x100e97da4", image: "dyld", symbol: "start" },
      { address: "0x10188c580", image: "NoteletDemo.debug.dylib", symbol: "AVPlayerItem.init" },
    ]);
  });

  it("returns empty when the prefix is missing", () => {
    expect(parseCallStackLine("not a call stack line")).toEqual([]);
  });

  it("handles `???` symbols (stripped/unsymbolicated frames)", () => {
    const frames = parseCallStackLine(
      "Call stack: 0x100fb9410 (dyld_sim) ???",
    );
    expect(frames[0]).toEqual({
      address: "0x100fb9410",
      image: "dyld_sim",
      symbol: "???",
    });
  });
});

describe("pickUserFrame", () => {
  it("returns the deepest non-system frame", () => {
    const frames = parseCallStackLine(
      "\tCall stack: 0x100e97da4 (dyld) start | 0x10188c580 (NoteletDemo.debug.dylib) main | 0x101895474 (NoteletDemo.debug.dylib) MediaNoteItemVideoView.prepareVideo | 0x1018964b8 (NoteletDemo.debug.dylib) AVPlayerItem.init | 0x100d1af18 (libobjc.A.dylib) _objc_rootAllocWithZone",
    );
    const user = pickUserFrame(frames);
    expect(user?.symbol).toBe("AVPlayerItem.init");
    expect(user?.image).toBe("NoteletDemo.debug.dylib");
  });

  it("skips system frames (libobjc, libsystem_malloc, dyld, SwiftUI, UIKitCore)", () => {
    const frames = parseCallStackLine(
      "Call stack: 0x100e97da4 (dyld) start | 0x100d1af18 (libobjc.A.dylib) _objc_rootAllocWithZone | 0x107f43e5c (libsystem_malloc.dylib) _calloc",
    );
    expect(pickUserFrame(frames)).toBeUndefined();
  });

  it("skips ??? symbols", () => {
    const frames = parseCallStackLine(
      "Call stack: 0x100fb9410 (dyld_sim) ??? | 0x100d1af18 (NoteletDemo.debug.dylib) ???",
    );
    expect(pickUserFrame(frames)).toBeUndefined();
  });
});

describe("parseLeaksDebugStacks", () => {
  it("parses a single SCANNING block with retainers + call stack", () => {
    const chains = parseLeaksDebugStacks(SINGLE_BLOCK_FIXTURE);
    expect(chains).toHaveLength(1);
    expect(chains[0].instanceCount).toBe(1);
    expect(chains[0].exampleAddress).toBe("0x600003e809c0");
    expect(chains[0].callStack.length).toBe(6);
    expect(chains[0].userFrame?.symbol).toBe("AVPlayerItem.init");
    // Retainers de-duplicated to unique class names.
    const retainerNames = chains[0].retainers.map((r) => r.className);
    expect(retainerNames).toContain("AVPlayerInternal");
    expect(retainerNames).toContain("AVRetainReleaseWeakReference");
    expect(retainerNames).toContain("NSMutableSet (Storage)");
  });

  it("aggregates instances with identical call-stack fingerprints", () => {
    const chains = parseLeaksDebugStacks(MULTI_BLOCK_FIXTURE);
    expect(chains).toHaveLength(1);
    expect(chains[0].instanceCount).toBe(2);
    // exampleAddress is the FIRST instance.
    expect(chains[0].exampleAddress).toBe("0x600003e809c0");
  });

  it("separates instances with different call-stack fingerprints into distinct chains", () => {
    const chains = parseLeaksDebugStacks(DIFFERENT_STACK_FIXTURE);
    expect(chains).toHaveLength(2);
    // Sorted by instanceCount desc.
    expect(chains[0].instanceCount).toBe(1);
    expect(chains[1].instanceCount).toBe(1);
    // Both chains' userFrame is the DEEPEST non-system frame (AVPlayerItem.init).
    // Their call stacks differ in the intermediate frames, which is what
    // produced the distinct fingerprints.
    const intermediates = chains.map((c) =>
      c.callStack.map((f) => f.symbol).join(" | "),
    );
    expect(intermediates[0]).toContain("MediaNoteItemVideoView.prepareVideo");
    expect(intermediates[1]).toContain("SomeOtherCallSite");
  });

  it("returns empty when there are no SCANNING blocks", () => {
    expect(parseLeaksDebugStacks("nothing scanned here")).toEqual([]);
  });

  it("retainer counts aggregate across instances with the same stack", () => {
    const chains = parseLeaksDebugStacks(MULTI_BLOCK_FIXTURE);
    const avpInternal = chains[0].retainers.find(
      (r) => r.className === "AVPlayerInternal",
    );
    // AVPlayerInternal appeared in both instances' retainer sections,
    // so its aggregate count is 2.
    expect(avpInternal?.count).toBe(2);
  });
});
