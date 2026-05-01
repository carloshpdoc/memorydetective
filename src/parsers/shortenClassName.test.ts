import { describe, it, expect } from "vitest";
import {
  shortenClassName,
  shortenForVerbosity,
} from "./shortenClassName.js";

describe("shortenClassName", () => {
  it("leaves short names alone", () => {
    expect(shortenClassName("DetailViewModel")).toBe("DetailViewModel");
  });

  it("drops standard module prefixes", () => {
    expect(
      shortenClassName(
        "Swift._DictionaryStorage<SwiftUI.AnyHashable2, SwiftUI.WeakBox<SwiftUI.AnyLocationBase>>",
      ),
    ).toMatch(/_DictionaryStorage/);
  });

  it("collapses nested ModifiedContent into a +N modifiers summary", () => {
    const huge =
      "SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<SwiftUI.AsyncImage<Foo>, SwiftUI._FrameLayout>, SwiftUI._BackgroundStyleModifier<SwiftUI.Color>>, SwiftUI._TagTraitWritingModifier<Swift.Int>>";
    const out = shortenClassName(huge);
    expect(out).toMatch(/AsyncImage/);
    expect(out).toMatch(/\+\d+ modifiers/);
    expect(out.length).toBeLessThan(200);
  });

  it("truncates deep generics with a hash placeholder", () => {
    const deep =
      "Container<Layer1<Layer2<Layer3<Layer4<Layer5<Inner>>>>>>";
    const out = shortenClassName(deep, {
      dropModules: false,
      collapseModifiers: false,
      maxDepth: 2,
    });
    expect(out).toMatch(/…<#[0-9a-f]+>/);
    expect(out).not.toContain("Layer5");
  });

  it("hash placeholder is deterministic for the same input", () => {
    const a = shortenClassName(
      "Container<Layer1<Layer2<Layer3<Inner>>>>",
      { dropModules: false, collapseModifiers: false, maxDepth: 2 },
    );
    const b = shortenClassName(
      "Container<Layer1<Layer2<Layer3<Inner>>>>",
      { dropModules: false, collapseModifiers: false, maxDepth: 2 },
    );
    expect(a).toBe(b);
  });

  it("respects maxLength as a final hard cap", () => {
    const ridiculous = "A".repeat(500);
    expect(shortenClassName(ridiculous, { maxLength: 60 }).length).toBeLessThanOrEqual(60);
  });

  it("middle-truncates with an ellipsis when over maxLength", () => {
    const ridiculous = "A".repeat(500);
    const out = shortenClassName(ridiculous, { maxLength: 21 });
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("handles empty input gracefully", () => {
    expect(shortenClassName("")).toBe("");
  });
});

describe("shortenForVerbosity", () => {
  const huge =
    "SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<SwiftUI.AsyncImage<Inner>, SwiftUI._FrameLayout>, SwiftUI._BackgroundStyleModifier<SwiftUI.Color>>";

  it("compact aggressively shortens", () => {
    const out = shortenForVerbosity(huge, "compact");
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/\+\d+ modifiers/);
  });

  it("full returns the original verbatim", () => {
    expect(shortenForVerbosity(huge, "full")).toBe(huge);
  });

  it("normal is between compact and full", () => {
    const compact = shortenForVerbosity(huge, "compact");
    const normal = shortenForVerbosity(huge, "normal");
    const full = shortenForVerbosity(huge, "full");
    expect(normal.length).toBeGreaterThan(compact.length);
    expect(normal.length).toBeLessThan(full.length);
  });
});
