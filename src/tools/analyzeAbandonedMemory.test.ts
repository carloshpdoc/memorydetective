import { describe, it, expect } from "vitest";
import {
  buildAbandonedMemoryDiff,
  classifyGrowth,
} from "./analyzeAbandonedMemory.js";
import type { ReferenceTreeEntry } from "../parsers/referenceTree.js";

const entry = (
  className: string,
  instanceCount: number,
  totalBytes = 0,
): ReferenceTreeEntry => ({ className, instanceCount, totalBytes });

describe("classifyGrowth", () => {
  it("flags NSKeyValueObservance growth as kvo-observer-orphaned with high confidence", () => {
    const c = classifyGrowth("NSKeyValueObservance", 12, false, 0);
    expect(c.classification).toBe("kvo-observer-orphaned");
    expect(c.confidence).toBe("high");
    expect(c.hint).toMatch(/observe/);
  });

  it("flags NSKeyValueObservationInfo as kvo-observer-orphaned", () => {
    const c = classifyGrowth("NSKeyValueObservationInfo", 5, false, 0);
    expect(c.classification).toBe("kvo-observer-orphaned");
    expect(c.confidence).toBe("high");
  });

  it("co-occurrence: AVPlayerItem growth with KVO observance growth becomes kvo-observer-orphaned (high confidence at large delta)", () => {
    // The notelet shape: AVPlayerItem grew +342 alongside NSKeyValueObservance.
    const c = classifyGrowth("AVPlayerItem", 342, true, 22);
    expect(c.classification).toBe("kvo-observer-orphaned");
    expect(c.confidence).toBe("high");
    expect(c.hint).toMatch(/Co-occurring NSKeyValueObservance growth/);
  });

  it("co-occurrence: medium confidence when delta is between 5 and 49", () => {
    const c = classifyGrowth("AVPlayerItem", 30, true, 8);
    expect(c.classification).toBe("kvo-observer-orphaned");
    expect(c.confidence).toBe("medium");
  });

  it("co-occurrence threshold: delta < 5 does NOT escalate", () => {
    const c = classifyGrowth("AVPlayerItem", 3, true, 8);
    expect(c.classification).toBe("unknown-growth");
  });

  it("does NOT escalate when KVO co-occurrence is absent", () => {
    const c = classifyGrowth("AVPlayerItem", 342, false, 0);
    // Without KVO context, AVPlayerItem alone is unknown-growth.
    expect(c.classification).toBe("unknown-growth");
    expect(c.confidence).toBe("low");
  });

  it("flags NSCache growth as cache-too-aggressive", () => {
    const c = classifyGrowth("NSCache", 50, false, 0);
    expect(c.classification).toBe("cache-too-aggressive");
    expect(c.confidence).toBe("medium");
  });

  it("flags NSMutableDictionary growth as cache-too-aggressive", () => {
    const c = classifyGrowth("NSMutableDictionary", 100, false, 0);
    expect(c.classification).toBe("cache-too-aggressive");
  });

  it("flags __NSObserver patterns as notificationcenter-observer-leaked", () => {
    const c = classifyGrowth("__NSObserver", 20, false, 0);
    expect(c.classification).toBe("notificationcenter-observer-leaked");
    expect(c.confidence).toBe("medium");
  });

  it("falls back to unknown-growth with low confidence for unrecognized shapes", () => {
    const c = classifyGrowth("MyAppRandomClass", 10, false, 0);
    expect(c.classification).toBe("unknown-growth");
    expect(c.confidence).toBe("low");
  });

  // v1.10 Phase C: tighten the KVO co-occurrence escalation.
  describe("co-occurrence escalation guards (v1.10)", () => {
    it("does NOT escalate framework-noise classes even with KVO co-occurrence", () => {
      // <<TOTAL>> grew alongside KVO; it must not be tagged kvo-observer-orphaned.
      const c = classifyGrowth("<<TOTAL>>", 4926, true, 15);
      expect(c.classification).not.toBe("kvo-observer-orphaned");
    });

    it("does NOT escalate anonymous bracketed instances", () => {
      // Anonymous `<malloc in ... 0xADDR> [size]` rows are not the observed type.
      const c = classifyGrowth(
        "<malloc in WeakTracker<TransportConnection> 0x600003231890> [48]",
        642,
        true,
        15,
      );
      expect(c.classification).not.toBe("kvo-observer-orphaned");
    });

    it("does NOT escalate byte-offset prefixed entries", () => {
      const c = classifyGrowth(
        "8600 bytes into <Swift Metadata 0x156865400> [16896]",
        780,
        true,
        15,
      );
      expect(c.classification).not.toBe("kvo-observer-orphaned");
    });

    it("respects the proportional threshold: small delta vs large KVO delta is rejected", () => {
      // KVO grew +200, candidate only grew +5 (2.5% of KVO). Too small to be the observed type.
      const c = classifyGrowth("MaybeRelated", 5, true, 200);
      expect(c.classification).not.toBe("kvo-observer-orphaned");
    });

    it("escalates a candidate that grew proportionally to KVO", () => {
      // KVO +15, AVPlayerItem +342 → ratio 22.8x, far above the high threshold.
      const c = classifyGrowth("AVPlayerItem", 342, true, 15);
      expect(c.classification).toBe("kvo-observer-orphaned");
      expect(c.confidence).toBe("high");
    });

    it("escalates a moderately-sized candidate to medium when KVO delta is small", () => {
      // KVO +8, MyDataLoader +30 → above mediumThreshold(max(5, 4)=5), below highThreshold(max(50, 40)=50).
      const c = classifyGrowth("MyDataLoader", 30, true, 8);
      expect(c.classification).toBe("kvo-observer-orphaned");
      expect(c.confidence).toBe("medium");
    });

    it("framework noise that is a cache type falls through to cache-too-aggressive", () => {
      // NSMutableDictionary IS framework noise (skipped by KVO escalation),
      // but the cache-detection branch still catches it.
      const c = classifyGrowth("NSMutableDictionary", 5000, true, 15);
      expect(c.classification).toBe("cache-too-aggressive");
    });
  });
});

describe("buildAbandonedMemoryDiff (notelet fixture shape)", () => {
  it("classifies the AVPlayerItem + NSKeyValueObservance co-occurrence as kvo-observer-orphaned", () => {
    // The actual notelet pre-fix vs post-fix shape, mapped down to the
    // relevant classes. AVPlayerItem 342 -> 0, NSKeyValueObservance ~29 -> ~7.
    const before: ReferenceTreeEntry[] = [
      entry("AVPlayerItem", 342, 28_800),
      entry("AVPlayerPlaybackCoordinator", 290, 19_100),
      entry("NSKeyValueObservance", 29, 720),
      entry("NSKeyValueObservationInfo", 9, 400),
    ];
    const after: ReferenceTreeEntry[] = [
      entry("AVPlayerItem", 0, 0),
      entry("AVPlayerPlaybackCoordinator", 0, 0),
      entry("NSKeyValueObservance", 7, 200),
      entry("NSKeyValueObservationInfo", 9, 400),
    ];

    const diff = buildAbandonedMemoryDiff(before, after, { topN: 10 });
    // All four classes shrunk or stayed flat. Nothing in growthByClass.
    expect(diff.growthByClass).toHaveLength(0);
    expect(diff.totals.classesShrunk).toBe(3);
    // Diagnosis should mention the fix closing an abandoned-memory chain.
    expect(diff.diagnosis).toMatch(/shrunk/i);
  });

  it("classifies the pre-fix snapshot (growing) when before=empty after=notelet", () => {
    // Reverse perspective: nothing alive before, full notelet state after.
    // This emulates "ran the leaky workflow with no clean baseline".
    const before: ReferenceTreeEntry[] = [];
    const after: ReferenceTreeEntry[] = [
      entry("AVPlayerItem", 342, 28_800),
      entry("AVPlayerPlaybackCoordinator", 290, 19_100),
      entry("NSKeyValueObservance", 29, 720),
      entry("NSKeyValueObservationInfo", 9, 400),
    ];

    const diff = buildAbandonedMemoryDiff(before, after, { topN: 10 });
    expect(diff.growthByClass.length).toBe(4);

    const byName = new Map(diff.growthByClass.map((e) => [e.className, e]));
    const kvoObservance = byName.get("NSKeyValueObservance")!;
    expect(kvoObservance.classification).toBe("kvo-observer-orphaned");
    expect(kvoObservance.confidence).toBe("high");

    // AVPlayerItem benefits from KVO co-occurrence -> escalated.
    const playerItem = byName.get("AVPlayerItem")!;
    expect(playerItem.classification).toBe("kvo-observer-orphaned");
    expect(playerItem.confidence).toBe("high"); // delta >= 50

    // AVPlayerPlaybackCoordinator same shape, also escalated.
    const coord = byName.get("AVPlayerPlaybackCoordinator")!;
    expect(coord.classification).toBe("kvo-observer-orphaned");
    expect(coord.confidence).toBe("high");

    // Largest delta sorted first.
    expect(diff.growthByClass[0].className).toBe("AVPlayerItem");
  });

  it("respects topN slice on the response", () => {
    const before: ReferenceTreeEntry[] = [];
    const after: ReferenceTreeEntry[] = [
      entry("ClassA", 100),
      entry("ClassB", 80),
      entry("ClassC", 60),
      entry("ClassD", 40),
      entry("ClassE", 20),
    ];
    const diff = buildAbandonedMemoryDiff(before, after, { topN: 2 });
    expect(diff.growthByClass.length).toBe(2);
    expect(diff.growthByClass.map((e) => e.className)).toEqual([
      "ClassA",
      "ClassB",
    ]);
  });

  it("respects classFilter substring", () => {
    const before: ReferenceTreeEntry[] = [];
    const after: ReferenceTreeEntry[] = [
      entry("AVPlayerItem", 100),
      entry("AVPlayerPlaybackCoordinator", 80),
      entry("UnrelatedThing", 60),
    ];
    const diff = buildAbandonedMemoryDiff(before, after, {
      topN: 10,
      classFilter: "AVPlayer",
    });
    expect(diff.growthByClass.length).toBe(2);
    expect(
      diff.growthByClass.every((e) => e.className.includes("AVPlayer")),
    ).toBe(true);
  });

  it("populates suggestedNextCalls when growth exists", () => {
    const before: ReferenceTreeEntry[] = [];
    const after: ReferenceTreeEntry[] = [entry("NSKeyValueObservance", 12)];
    const diff = buildAbandonedMemoryDiff(before, after, { topN: 10 });
    expect(diff.suggestedNextCalls?.length).toBe(1);
    expect(diff.suggestedNextCalls![0].tool).toBe("swiftSearchPattern");
    expect(diff.suggestedNextCalls![0].args.pattern).toBe(
      "NSKeyValueObservance",
    );
  });

  it("returns no growth and no suggestedNextCalls when before == after", () => {
    const both: ReferenceTreeEntry[] = [
      entry("Stable", 10),
      entry("AlsoStable", 5),
    ];
    const diff = buildAbandonedMemoryDiff(both, both, { topN: 10 });
    expect(diff.growthByClass).toHaveLength(0);
    expect(diff.shrinkageByClass).toHaveLength(0);
    expect(diff.totals.classesUnchanged).toBe(2);
    expect(diff.suggestedNextCalls).toBeUndefined();
  });

  it("computes totals correctly", () => {
    const before: ReferenceTreeEntry[] = [
      entry("Grown", 5, 100),
      entry("Shrunk", 10, 200),
    ];
    const after: ReferenceTreeEntry[] = [
      entry("Grown", 15, 300),
      entry("Shrunk", 2, 40),
    ];
    const diff = buildAbandonedMemoryDiff(before, after, { topN: 10 });
    expect(diff.totals.classesGrown).toBe(1);
    expect(diff.totals.classesShrunk).toBe(1);
    expect(diff.totals.netInstancesDelta).toBe(10 + -8);
    expect(diff.totals.netBytesDelta).toBe(200 + -160);
  });
});
