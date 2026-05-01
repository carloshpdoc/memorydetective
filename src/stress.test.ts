import { describe, it, expect } from "vitest";
import { parseLeaksOutput } from "./parsers/leaksOutput.js";
import { findRetainersIn } from "./tools/findRetainers.js";
import { countByClass } from "./tools/countAlive.js";
import { diffReports } from "./tools/diffMemgraphs.js";
import { classifyReport } from "./tools/classifyCycle.js";

/**
 * Stress tests guard against accidental O(n²) or worse complexity. Real-world
 * memgraphs of mid-size apps produce ~60k leaks and tens of thousands of cycle
 * nodes; these tests build synthetic inputs of similar magnitude and assert
 * the analyzers complete in low-hundreds of milliseconds.
 *
 * Bounds are loose enough to accommodate slow CI runners; tighten only when
 * a regression bites.
 */

/** Build a synthetic `leaks(1)` output string with `numCycles` ROOT CYCLE blocks,
 *  each carrying a chain of `chainDepth` descendants. Mirrors the real format
 *  (header → `----` separator → totals → tree). */
function makeStressLeaksText(numCycles: number, chainDepth: number): string {
  const lines: string[] = [];

  // Header section.
  lines.push("Process:         StressApp [1]");
  lines.push("Identifier:      com.example.stress");
  lines.push("Platform:        iOS");
  lines.push("----");
  lines.push("");

  // Totals.
  lines.push("leaks Report Version: 4.0");
  lines.push("Process 1: 999999 nodes malloced for 100000 KB");
  lines.push(
    `Process 1: ${numCycles * chainDepth} leaks for ${numCycles * chainDepth * 32} total leaked bytes.`,
  );
  lines.push("");
  lines.push(`    ${numCycles * chainDepth} (1M) << TOTAL >>`);
  lines.push("");

  // Cycle tree.
  for (let i = 0; i < numCycles; i++) {
    let indent = 6;
    const rootHex = (i + 1).toString(16).padStart(8, "0");
    lines.push(
      `${" ".repeat(indent)}100 (1K) ROOT CYCLE: <RootClass${i} 0x1${rootHex}> [32]`,
    );
    for (let d = 0; d < chainDepth; d++) {
      indent += 3;
      const childHex = (i * 1000 + d).toString(16).padStart(8, "0");
      const className = d % 5 === 0 ? "Combine.AnyCancellable" : `Child${i}_${d}`;
      lines.push(
        `${" ".repeat(indent)}50 (500 bytes) __strong prop --> <${className} 0x2${childHex}> [32]`,
      );
    }
  }
  return lines.join("\n");
}

describe("stress: parser + analyzers (synthetic 1k cycles × 50 deep)", () => {
  const NUM_CYCLES = 1000;
  const CHAIN_DEPTH = 50;
  const stressText = makeStressLeaksText(NUM_CYCLES, CHAIN_DEPTH);

  // Loose CI-friendly bound. Real wallclock on an M-series Mac is ~470ms for
  // parsing this; GitHub Actions Ubuntu runners measured ~830ms in practice.
  // 2000ms gives 2-3x headroom on top of that for noisy runners while still
  // catching genuine O(n²) regressions (which would push this past 5+ seconds).
  const PARSE_BUDGET_MS = 2000;
  const ANALYZER_BUDGET_MS = 500;

  it(`parses ${NUM_CYCLES} cycles × ${CHAIN_DEPTH} depth in under ${PARSE_BUDGET_MS}ms`, () => {
    const t0 = performance.now();
    const report = parseLeaksOutput(stressText);
    const elapsed = performance.now() - t0;
    expect(report.cycles.length).toBe(NUM_CYCLES);
    expect(elapsed).toBeLessThan(PARSE_BUDGET_MS);
  });

  it("countByClass scales linearly", () => {
    const report = parseLeaksOutput(stressText);
    const t0 = performance.now();
    const counts = countByClass(report);
    const elapsed = performance.now() - t0;
    expect(counts.size).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(ANALYZER_BUDGET_MS);
  });

  it("findRetainersIn handles a substring filter against deep chains", () => {
    const report = parseLeaksOutput(stressText);
    const t0 = performance.now();
    const result = findRetainersIn(report, "Combine.AnyCancellable", 50);
    const elapsed = performance.now() - t0;
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(ANALYZER_BUDGET_MS);
  });

  it("classifyReport runs every pattern over every cycle", () => {
    const report = parseLeaksOutput(stressText);
    const t0 = performance.now();
    const { classified } = classifyReport(report, 100);
    const elapsed = performance.now() - t0;
    expect(classified.length).toBe(100);
    expect(elapsed).toBeLessThan(ANALYZER_BUDGET_MS);
  });

  it("diffReports compares two large reports", () => {
    const before = parseLeaksOutput(stressText);
    // "After" snapshot: same shape but half the cycles (simulating a fix).
    const afterText = makeStressLeaksText(NUM_CYCLES / 2, CHAIN_DEPTH);
    const after = parseLeaksOutput(afterText);
    const t0 = performance.now();
    const diff = diffReports(before, after, "before", "after");
    const elapsed = performance.now() - t0;
    expect(diff.totals.leakCountDelta).toBeLessThan(0);
    // Plenty of cycle signatures should bucket into goneFromBefore.
    expect(diff.cycles.goneFromBefore.length + diff.cycles.persisted.length)
      .toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(ANALYZER_BUDGET_MS);
  });
});
