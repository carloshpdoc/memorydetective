import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { summarizeLeaks } from "./analyzeMemgraph.js";
import { extractCycles } from "./findCycles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const leaksText = readFileSync(
  resolve(FIXTURES, "example-leaks.head.leaks.txt"),
  "utf8",
);

describe("summarizeLeaks (analyzeMemgraph pure path)", () => {
  it("produces a top-level summary with diagnosis", () => {
    const result = summarizeLeaks(leaksText, "/fake/path.memgraph");
    expect(result.ok).toBe(true);
    expect(result.process).toBe("DemoApp");
    expect(result.totals.leakCount).toBe(60436);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.diagnosis).toContain("ROOT CYCLE");
  });

  it("omits fullReport by default and includes when asked", () => {
    const compact = summarizeLeaks(leaksText, "/fake/path.memgraph", false);
    expect(compact.fullReport).toBeUndefined();
    const full = summarizeLeaks(leaksText, "/fake/path.memgraph", true);
    expect(full.fullReport).toBeDefined();
    expect(full.fullReport?.cycles.length).toBeGreaterThan(0);
  });

  it("flags DetailViewModel as an app-level class in chain", () => {
    const result = summarizeLeaks(leaksText, "/fake/path.memgraph");
    // Top-N capping in classesInChain (default 10) may exclude single-occurrence
    // names when many app-level classes share the cycle. Verify with `full`
    // verbosity and a higher cap, where DetailViewModel must surface.
    const full = summarizeLeaks(
      leaksText,
      "/fake/path.memgraph",
      false,
      "full",
      50,
    );
    const allClasses = full.cycles.flatMap((c) => c.classesInChain);
    expect(allClasses.some((c) => c.includes("DetailViewModel"))).toBe(true);
  });

  it("reports zero cycles cleanly", () => {
    const cleanText = `Process:         Demo [1]
Identifier:      com.example
----

leaks Report Version: 4.0
Process 1: 0 nodes malloced for 0 KB
Process 1: 0 leaks for 0 total leaked bytes.

    0 (0) << TOTAL >>
`;
    const result = summarizeLeaks(cleanText, "/fake/clean.memgraph");
    expect(result.totals.leakCount).toBe(0);
    expect(result.cycles.length).toBe(0);
    expect(result.diagnosis).toBe("No leaks detected.");
  });
});

describe("extractCycles (findCycles pure path)", () => {
  it("returns flattened chains for every ROOT CYCLE", () => {
    const result = extractCycles(leaksText, "/fake/path.memgraph");
    expect(result.totalCycles).toBeGreaterThan(0);
    expect(result.cycles[0].chain.length).toBeGreaterThan(1);
    expect(result.cycles[0].rootClass).toContain("_DictionaryStorage");
  });

  it("filters by className when provided", () => {
    const filtered = extractCycles(
      leaksText,
      "/fake/path.memgraph",
      "DetailViewModel",
    );
    expect(filtered.filterApplied).toBe("DetailViewModel");
    expect(filtered.cycles.length).toBeGreaterThan(0);
    for (const c of filtered.cycles) {
      expect(
        c.chain.some((e) => e.className.includes("DetailViewModel")),
      ).toBe(true);
    }
  });

  it("returns empty list when filter doesn't match", () => {
    const filtered = extractCycles(
      leaksText,
      "/fake/path.memgraph",
      "ThisClassDoesNotExist",
    );
    expect(filtered.cycles.length).toBe(0);
    expect(filtered.totalCycles).toBeGreaterThan(0); // total ignores filter
  });

  it("respects maxDepth", () => {
    const shallow = extractCycles(
      leaksText,
      "/fake/path.memgraph",
      undefined,
      2,
    );
    for (const c of shallow.cycles) {
      for (const entry of c.chain) {
        expect(entry.depth).toBeLessThanOrEqual(2);
      }
    }
  });
});
