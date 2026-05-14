import { describe, it, expect } from "vitest";
import {
  parseSizeBytes,
  extractClassName,
  isFrameworkNoise,
  parseReferenceTreeText,
} from "./referenceTree.js";

describe("parseSizeBytes", () => {
  it("parses bytes literal", () => {
    expect(parseSizeBytes("832 bytes")).toBe(832);
    expect(parseSizeBytes("48 bytes")).toBe(48);
    expect(parseSizeBytes("1 byte")).toBe(1);
  });

  it("parses K (kilobyte) literal", () => {
    expect(parseSizeBytes("28.8K")).toBe(Math.round(28.8 * 1024));
    expect(parseSizeBytes("19.1K")).toBe(Math.round(19.1 * 1024));
  });

  it("parses M (megabyte) literal", () => {
    expect(parseSizeBytes("1.5M")).toBe(Math.round(1.5 * 1024 * 1024));
  });

  it("returns 0 on unrecognized format", () => {
    expect(parseSizeBytes("garbage")).toBe(0);
    expect(parseSizeBytes("")).toBe(0);
  });
});

describe("extractClassName", () => {
  it("returns the value type after --> when present", () => {
    expect(extractClassName("_playerItem --> AVPlayerItemInternal")).toBe(
      "AVPlayerItemInternal",
    );
    expect(extractClassName("__strong _object --> NSKeyValueObservance")).toBe(
      "NSKeyValueObservance",
    );
  });

  it("returns the label itself when no --> is present", () => {
    expect(extractClassName("AVPlayerItem")).toBe("AVPlayerItem");
    expect(extractClassName("NSKeyValueObservationInfo")).toBe(
      "NSKeyValueObservationInfo",
    );
  });

  it("returns null for c-runtime entries (malloc / calloc / realloc)", () => {
    expect(extractClassName("malloc in FigSimpleMutexCreateWithAttr")).toBeNull();
    expect(extractClassName("calloc in _dispatch_introspection_queue_create")).toBeNull();
  });

  it("returns null for empty labels", () => {
    expect(extractClassName("")).toBeNull();
    expect(extractClassName("   ")).toBeNull();
  });
});

describe("parseReferenceTreeText", () => {
  it("aggregates instance counts across the tree by class name", () => {
    // Synthetic fixture modeled on the real notelet pre-fix shape: AVPlayerItem
    // shows up at multiple tree depths, all should sum into one entry.
    const text = `
      + ! : 342 (28.8K) AVPlayerItem
      + ! : | 334 (28.7K) _playerItem --> AVPlayerItemInternal
      + ! : 290 (19.1K) AVPlayerPlaybackCoordinator
      + !   1 (48 bytes) __strong _object --> NSKeyValueObservance
      + !     15 (720 bytes) __strong _object --> NSKeyValueObservance
      + !       8 (384 bytes) NSKeyValueObservance
      + !   9 (400 bytes) NSKeyValueObservationInfo
    `;
    const entries = parseReferenceTreeText(text, 10);
    const byName = new Map(entries.map((e) => [e.className, e]));
    expect(byName.get("AVPlayerItem")?.instanceCount).toBe(342);
    expect(byName.get("AVPlayerItemInternal")?.instanceCount).toBe(334);
    expect(byName.get("AVPlayerPlaybackCoordinator")?.instanceCount).toBe(290);
    expect(byName.get("NSKeyValueObservance")?.instanceCount).toBe(1 + 15 + 8);
    expect(byName.get("NSKeyValueObservationInfo")?.instanceCount).toBe(9);
  });

  it("sorts by instanceCount desc, then bytes desc, then alphabetic", () => {
    const text = `
      + ! 100 (1K) Beta
      + ! 100 (2K) Alpha
      + ! 50 (1K) Gamma
    `;
    const entries = parseReferenceTreeText(text, 10);
    expect(entries.map((e) => e.className)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("respects topN slice", () => {
    const text = `
      + ! 5 (10 bytes) One
      + ! 4 (10 bytes) Two
      + ! 3 (10 bytes) Three
      + ! 2 (10 bytes) Four
      + ! 1 (10 bytes) Five
    `;
    const entries = parseReferenceTreeText(text, 3);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.className)).toEqual(["One", "Two", "Three"]);
  });

  it("returns empty array on empty input", () => {
    expect(parseReferenceTreeText("", 10)).toEqual([]);
    expect(parseReferenceTreeText("just some prose without tree data\n", 10)).toEqual([]);
  });

  it("returns empty array when topN <= 0", () => {
    const text = `+ ! 100 (1K) Alpha`;
    expect(parseReferenceTreeText(text, 0)).toEqual([]);
    expect(parseReferenceTreeText(text, -5)).toEqual([]);
  });

  it("ignores malloc-prefixed allocator entries", () => {
    const text = `
      + ! 10 (200 bytes) AVPlayerItem
      + ! 8 (640 bytes) malloc in FigSimpleMutexCreateWithAttr
      + ! 5 (120 bytes) calloc in _dispatch_introspection_queue_create
    `;
    const entries = parseReferenceTreeText(text, 10);
    expect(entries.map((e) => e.className)).toEqual(["AVPlayerItem"]);
  });
});

describe("extractClassName: bracket-address normalization (v1.10)", () => {
  it("normalizes `<ClassName 0xADDR> [size]` to ClassName", () => {
    expect(extractClassName("<CFDictionary 0x6000029c4840> [64]")).toBe(
      "CFDictionary",
    );
    expect(extractClassName("<NSMutableDictionary 0x600003ccf5c0> [32]")).toBe(
      "NSMutableDictionary",
    );
  });

  it("normalizes `<ClassName 0xADDR>` (no size suffix) to ClassName", () => {
    expect(extractClassName("<NSObject 0x14f100>")).toBe("NSObject");
  });

  it("normalizes the bracket form when it follows an arrow", () => {
    expect(
      extractClassName("_object --> <NSObject 0x14f100> [16]"),
    ).toBe("NSObject");
    expect(
      extractClassName("__strong target --> <AVCMNotificationDispatcher 0x600003c09a00> [32]"),
    ).toBe("AVCMNotificationDispatcher");
  });

  it("filters bracketed allocator entries (`<malloc in ...>`)", () => {
    expect(
      extractClassName("<malloc in invocation function 0x15192b120> [48]"),
    ).toBeNull();
    expect(
      extractClassName("<calloc in CGFontDBCreate 0x14f85b8b0> [112]"),
    ).toBeNull();
  });

  it("filters allocator entries that appear AFTER an arrow", () => {
    // Real leaks output: the value type can resolve to an allocator entry
    // when leaks shows the underlying alloc-stack origin instead of a class.
    expect(
      extractClassName("unaligned +1375:  --> calloc in quic_stream_allocate"),
    ).toBeNull();
    expect(
      extractClassName("_buffer --> malloc in some_internal_helper"),
    ).toBeNull();
  });

  it("preserves namespaced class names inside brackets", () => {
    // Names with dots (Swift module-qualified) survive the normalizer.
    expect(extractClassName("<SwiftUI.ViewGraph 0x14f700> [128]")).toBe(
      "SwiftUI.ViewGraph",
    );
  });
});

describe("isFrameworkNoise", () => {
  it("flags the <<TOTAL>> summary row", () => {
    expect(isFrameworkNoise("<<TOTAL>>")).toBe(true);
    expect(isFrameworkNoise("<< TOTAL >>")).toBe(true);
  });

  it("flags Foundation collection types", () => {
    expect(isFrameworkNoise("NSMutableDictionary")).toBe(true);
    expect(isFrameworkNoise("NSMutableDictionary (Storage)")).toBe(true);
    expect(isFrameworkNoise("CFString")).toBe(true);
    expect(isFrameworkNoise("NSMutableArray (Storage)")).toBe(true);
    expect(isFrameworkNoise("CFSet (Value Storage)")).toBe(true);
  });

  it("flags ObjC runtime + metadata classes", () => {
    expect(isFrameworkNoise("Class.data (class_rw_t)")).toBe(true);
    expect(isFrameworkNoise("Class.methodCache._buckets (bucket_t)")).toBe(true);
    expect(isFrameworkNoise("OBJC_METACLASS_$_NSKeyValueObservation")).toBe(true);
  });

  it("flags __DATA sections (bss / data / common / objc_data / objc_const)", () => {
    expect(
      isFrameworkNoise("libMainThreadChecker.dylib __DATA __bss: 'data[]'"),
    ).toBe(true);
    expect(
      isFrameworkNoise("Foundation __DATA __bss: '_MergedGlobals.9[]'"),
    ).toBe(true);
    // ObjC class data section: framework runtime metadata that scales
    // with how many classes are loaded, NOT actionable user state.
    expect(isFrameworkNoise("UIKitCore __DATA __objc_data")).toBe(true);
    expect(isFrameworkNoise("Foundation __DATA __objc_data")).toBe(true);
    // _DIRTY variant for the same family.
    expect(
      isFrameworkNoise("dyld __DATA_DIRTY __common: '_main_thread[]'"),
    ).toBe(true);
  });

  it("flags block infrastructure", () => {
    expect(isFrameworkNoise("__NSMallocBlock__")).toBe(true);
    expect(isFrameworkNoise("__NSConcreteMallocBlock")).toBe(true);
    expect(isFrameworkNoise("__NSStackBlock__")).toBe(true);
  });

  it("flags Swift Metadata + GCD + C++ stdlib internals", () => {
    expect(isFrameworkNoise("Swift Metadata")).toBe(true);
    expect(isFrameworkNoise("dispatch_queue_t (serial)")).toBe(true);
    expect(isFrameworkNoise("dispatch_semaphore_t")).toBe(true);
    expect(isFrameworkNoise("std::__shared_ptr_emplace<NWIOConnection>")).toBe(
      true,
    );
  });

  it("flags Stack of thread N / non-object / VM regions", () => {
    expect(isFrameworkNoise("Stack of thread 4")).toBe(true);
    expect(isFrameworkNoise("non-object with no stack backtrace")).toBe(true);
    expect(isFrameworkNoise("non-object in zone DefaultMallocZone_0x102194000")).toBe(true);
    expect(
      isFrameworkNoise("VM: AttributeGraph Data  0x14f700000-0x14f800000"),
    ).toBe(true);
  });

  it("flags anonymous bracketed instances that slipped past normalization", () => {
    // If extractClassName didn't catch a bracketed form (e.g. malformed),
    // these still get filtered out at this layer so they don't pollute the
    // actionable list.
    expect(isFrameworkNoise("<calloc in foo 0x1500> [16]")).toBe(true);
    expect(isFrameworkNoise("<NSMutableDictionary 0xabcd> [32]")).toBe(true);
  });

  it("does NOT flag actionable AV / KVO / SwiftUI classes", () => {
    expect(isFrameworkNoise("AVPlayerItem")).toBe(false);
    expect(isFrameworkNoise("AVPlayerInternal")).toBe(false);
    expect(isFrameworkNoise("AVPlayerPlaybackCoordinator")).toBe(false);
    expect(isFrameworkNoise("NSKeyValueObservance")).toBe(false);
    expect(isFrameworkNoise("NSKeyValueObservationInfo")).toBe(false);
    expect(isFrameworkNoise("SwiftUI.ViewGraph")).toBe(false);
    expect(
      isFrameworkNoise("SwiftUI.StoredLocation<Swift.Optional<__C.AVPlayerLooper>>"),
    ).toBe(false);
  });

  it("does NOT flag user app-level class names", () => {
    expect(isFrameworkNoise("FeedViewController")).toBe(false);
    expect(isFrameworkNoise("MyAppViewModel")).toBe(false);
    expect(isFrameworkNoise("DetailViewModel")).toBe(false);
  });
});
