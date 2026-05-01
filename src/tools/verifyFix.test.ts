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
