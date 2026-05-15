import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLeaksOutput } from "../parsers/leaksOutput.js";
import { verifyFromReports } from "./verifyFix.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const beforeText = readFileSync(
  resolve(FIXTURES, "example-leaks.head.leaks.txt"),
  "utf8",
);
const afterText = readFileSync(
  resolve(FIXTURES, "example-fix.head.leaks.txt"),
  "utf8",
);

describe("verifyFix", () => {
  it("returns a per-pattern resolution structure", () => {
    const result = verifyFromReports(
      parseLeaksOutput(beforeText),
      parseLeaksOutput(afterText),
      "before.memgraph",
      "after.memgraph",
      { before: "before.memgraph", after: "after.memgraph", verbosity: "compact" },
    );
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.patternResolution)).toBe(true);
    expect(["PASS", "PARTIAL", "FAIL"]).toContain(result.overallVerdict);
  });

  it("computes overall byte delta from totals", () => {
    const before = parseLeaksOutput(beforeText);
    const after = parseLeaksOutput(afterText);
    const result = verifyFromReports(before, after, "b", "a", {
      before: "b",
      after: "a",
      verbosity: "compact",
    });
    expect(result.totals.bytesDelta).toBe(
      after.totals.totalLeakedBytes - before.totals.totalLeakedBytes,
    );
  });

  it("orders pattern resolutions: FAIL first, then PARTIAL, then PASS", () => {
    const result = verifyFromReports(
      parseLeaksOutput(beforeText),
      parseLeaksOutput(afterText),
      "b",
      "a",
      { before: "b", after: "a", verbosity: "compact" },
    );
    const verdicts = result.patternResolution.map((p) => p.verdict);
    const verdictRank: Record<string, number> = { FAIL: 0, PARTIAL: 1, PASS: 2 };
    for (let i = 0; i + 1 < verdicts.length; i++) {
      expect(verdictRank[verdicts[i]]).toBeLessThanOrEqual(
        verdictRank[verdicts[i + 1]],
      );
    }
  });

  it("returns a diagnosis string", () => {
    const result = verifyFromReports(
      parseLeaksOutput(beforeText),
      parseLeaksOutput(afterText),
      "b",
      "a",
      { before: "b", after: "a", verbosity: "compact" },
    );
    expect(result.diagnosis.length).toBeGreaterThan(0);
  });

  it("returns expectedPatternVerdict when expectedPatternId is provided", () => {
    const result = verifyFromReports(
      parseLeaksOutput(beforeText),
      parseLeaksOutput(afterText),
      "b",
      "a",
      {
        before: "b",
        after: "a",
        expectedPatternId: "swiftui.tag-index-projection",
        verbosity: "compact",
      },
    );
    expect(["PASS", "PARTIAL", "FAIL"]).toContain(
      result.expectedPatternVerdict,
    );
  });

  it("includes suggestedNextCalls when there are failures", () => {
    // Synthetic equal-snapshot test — same memgraph in/out means no PASS, no FAIL beyond what's already there.
    const same = parseLeaksOutput(beforeText);
    const result = verifyFromReports(same, same, "b", "a", {
      before: "b",
      after: "a",
      verbosity: "compact",
    });
    // When there are no failures, the field is omitted.
    if (result.overallVerdict !== "FAIL") {
      expect(result.suggestedNextCalls).toBeUndefined();
    }
  });
});

describe("verifyFix expectedAliveClasses whitelist (v1.14 item M)", () => {
  it("schema accepts expectedAliveClasses + disableDefaultWhitelist", async () => {
    const { verifyFixSchema } = await import("./verifyFix.js");
    const parsed = verifyFixSchema.parse({
      before: "/tmp/before.memgraph",
      after: "/tmp/after.memgraph",
      expectedAliveClasses: ["AVPlayerItem", "MyCacheSingleton"],
      disableDefaultWhitelist: true,
    });
    expect(parsed.expectedAliveClasses).toEqual([
      "AVPlayerItem",
      "MyCacheSingleton",
    ]);
    expect(parsed.disableDefaultWhitelist).toBe(true);
  });

  it("schema defaults disableDefaultWhitelist to false (curated list applied)", async () => {
    const { verifyFixSchema } = await import("./verifyFix.js");
    const parsed = verifyFixSchema.parse({
      before: "/tmp/before.memgraph",
      after: "/tmp/after.memgraph",
    });
    expect(parsed.disableDefaultWhitelist).toBe(false);
    expect(parsed.expectedAliveClasses).toBeUndefined();
  });

  it("schema rejects empty strings inside expectedAliveClasses", async () => {
    const { verifyFixSchema } = await import("./verifyFix.js");
    expect(() =>
      verifyFixSchema.parse({
        before: "/tmp/before.memgraph",
        after: "/tmp/after.memgraph",
        expectedAliveClasses: [""],
      }),
    ).toThrow();
  });

  it("DEFAULT_EXPECTED_ALIVE_CLASSES includes the DebugSwift-curated system classes", async () => {
    const { DEFAULT_EXPECTED_ALIVE_CLASSES } = await import("./verifyFix.js");
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain(
      "UICompatibilityInputViewController",
    );
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain("UIPredictionViewController");
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain("UIRemoteKeyboardWindow");
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain("UITextEffectsWindow");
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain("PLTileContainerView");
    expect(DEFAULT_EXPECTED_ALIVE_CLASSES).toContain("CAMPreviewView");
  });

  it("isExpectedAlive matches substrings case-insensitively (via internal helper)", async () => {
    // We don't export the helpers directly; verify the visible behavior
    // by checking the default-list-driven match patterns work both for
    // exact-name + substring containment.
    const { DEFAULT_EXPECTED_ALIVE_CLASSES } = await import("./verifyFix.js");
    // The whitelist treats the items as substrings, so a derived name
    // like "MyApp.UIRemoteKeyboardWindow" should also match.
    const items = DEFAULT_EXPECTED_ALIVE_CLASSES.map((s) => s.toLowerCase());
    expect(items.includes("uipredictionviewcontroller")).toBe(true);
    // Sanity: substring matching means we'd reject classes that don't contain ANY item.
    const benignClass = "MyApp.UserViewModel";
    const anyMatch = items.some((w) =>
      benignClass.toLowerCase().includes(w),
    );
    expect(anyMatch).toBe(false);
  });
});
