import { describe, it, expect } from "vitest";
import {
  parseSizeBytes,
  extractClassName,
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
