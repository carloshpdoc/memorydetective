import { describe, it, expect } from "vitest";
import { PATTERNS } from "../tools/classifyCycle.js";
import {
  getStaticAnalysisHint,
  knownHintPatternIds,
} from "./staticAnalysisHints.js";

describe("static analysis bridge — hint coverage", () => {
  it("every PATTERN in the catalog has a corresponding hint entry (no drift)", () => {
    const patternIds = PATTERNS.map((p) => p.id).sort();
    const hintIds = knownHintPatternIds().sort();
    expect(hintIds).toEqual(patternIds);
  });

  it("every hint declares either a real rule+url, OR a null rule with non-trivial explanation", () => {
    for (const id of knownHintPatternIds()) {
      const hint = getStaticAnalysisHint(id)!;
      expect(hint.explanation.length).toBeGreaterThan(20);
      if (hint.rule === null) {
        // null rule is allowed, but explanation must justify why.
        expect(hint.explanation.toLowerCase()).toMatch(
          /no static rule|runtime|opaque|contextual|swiftlint|insufficient|brand-new|unbound|lifecycle|undocumented|too\s|unshipped/,
        );
      } else {
        // when rule exists, url should point at it (or at least be non-null).
        expect(hint.url).toBeTruthy();
      }
    }
  });

  it("delegate.strong-reference points at SwiftLint weak_delegate", () => {
    const hint = getStaticAnalysisHint("delegate.strong-reference")!;
    expect(hint.rule).toBe("weak_delegate");
    expect(hint.url).toContain("weak_delegate");
  });

  it("combine.sink-store-self-capture points at SwiftLint weak_self", () => {
    const hint = getStaticAnalysisHint("combine.sink-store-self-capture")!;
    expect(hint.rule).toBe("weak_self");
  });

  it("closure.viewmodel-wrapped-strong points at the open SwiftLint #776 issue", () => {
    const hint = getStaticAnalysisHint("closure.viewmodel-wrapped-strong")!;
    expect(hint.rule).toBe(null);
    expect(hint.url).toContain("realm/SwiftLint/issues/776");
  });

  it("concurrency.async-sequence-on-self explicitly notes [weak self] does NOT help", () => {
    const hint = getStaticAnalysisHint("concurrency.async-sequence-on-self")!;
    expect(hint.explanation.toLowerCase()).toContain("weak self");
    expect(hint.explanation.toLowerCase()).toContain("not help");
    expect(hint.url).toContain("forums.swift.org");
  });

  it("returns null for unknown pattern ids", () => {
    expect(getStaticAnalysisHint("does-not-exist")).toBeNull();
  });
});
