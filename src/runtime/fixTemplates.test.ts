import { describe, it, expect } from "vitest";
import { PATTERNS } from "../tools/classifyCycle.js";
import { getFixTemplate, knownTemplatePatternIds } from "./fixTemplates.js";

describe("Fix templates — coverage", () => {
  it("every PATTERN has a corresponding fix template (no drift)", () => {
    const patternIds = PATTERNS.map((p) => p.id).sort();
    const templateIds = knownTemplatePatternIds().sort();
    expect(templateIds).toEqual(patternIds);
  });

  it("every template has a non-trivial before AND after Swift snippet", () => {
    for (const id of knownTemplatePatternIds()) {
      const t = getFixTemplate(id)!;
      expect(t.before.length).toBeGreaterThan(20);
      expect(t.after.length).toBeGreaterThan(20);
      // Snippets must differ — otherwise the "fix" is useless
      expect(t.before).not.toBe(t.after);
    }
  });

  it("templates that show before/after retention typically include a [weak self] or related capture-list fix in the after side", () => {
    // Spot-check: most cycle patterns are fixed via weak captures, deinit
    // cleanup, or proxy classes. Verify at least one of those signals
    // appears across the catalog.
    const allAfter = knownTemplatePatternIds()
      .map((id) => getFixTemplate(id)!.after)
      .join("\n\n");
    expect(allAfter).toContain("[weak self]");
    expect(allAfter).toContain("deinit");
    expect(allAfter.toLowerCase()).toContain("weak");
  });

  it("returns null for unknown pattern ids", () => {
    expect(getFixTemplate("does-not-exist")).toBeNull();
  });

  it("`swiftui.tag-index-projection` template includes ForEach + .tag", () => {
    const t = getFixTemplate("swiftui.tag-index-projection")!;
    expect(t.before).toContain("ForEach");
    expect(t.before).toContain(".tag(");
    expect(t.after).toContain("[weak");
  });

  it("`concurrency.async-sequence-on-self` template documents that [weak self] alone is insufficient", () => {
    const t = getFixTemplate("concurrency.async-sequence-on-self")!;
    expect(t.notes).toBeTruthy();
    expect(t.notes!.toLowerCase()).toContain("not sufficient");
    expect(t.after).toContain("task?.cancel()");
  });

  it("`delegate.strong-reference` shows the canonical weak delegate fix", () => {
    const t = getFixTemplate("delegate.strong-reference")!;
    expect(t.before).toContain("var delegate:");
    expect(t.after).toContain("weak var delegate:");
  });

  it("`swiftdata.modelcontext-actor-cycle` template recommends @ModelActor", () => {
    const t = getFixTemplate("swiftdata.modelcontext-actor-cycle")!;
    expect(t.after).toContain("@ModelActor");
  });
});

// Integration with classifyReport (wiring of fixTemplate + staticAnalysisHint
// onto every PatternMatch) is exercised by readTools.test.ts via the
// `makeReport` helper, which builds reports through the public parser API.
// No need for a synthetic-report shortcut here.
