import { describe, it, expect } from "vitest";
import {
  compareHangs,
  compareAnimationHitches,
  compareAppLaunch,
} from "./compareTracesByPattern.js";
import type { AnalyzeHangsResult } from "./analyzeHangs.js";
import type { AnalyzeAnimationHitchesResult } from "./analyzeAnimationHitches.js";
import type { AnalyzeAppLaunchResult } from "./analyzeAppLaunch.js";

function hangsResult(opts: {
  hangs: number;
  longestMs: number;
  averageMs: number;
  totalMs: number;
}): AnalyzeHangsResult {
  return {
    ok: true,
    tracePath: "/fake.trace",
    totals: {
      rows: opts.hangs,
      hangs: opts.hangs,
      microhangs: 0,
      longestMs: opts.longestMs,
      averageMs: opts.averageMs,
      totalDurationMs: opts.totalMs,
    },
    top: [],
    diagnosis: "",
  };
}

function hitchesResult(opts: {
  perceptible: number;
  longestMs: number;
  averageMs: number;
  totalMs: number;
}): AnalyzeAnimationHitchesResult {
  return {
    ok: true,
    tracePath: "/fake.trace",
    totals: {
      rows: opts.perceptible,
      totalDurationMs: opts.totalMs,
      longestMs: opts.longestMs,
      averageMs: opts.averageMs,
      perceptible: opts.perceptible,
    },
    byType: {},
    top: [],
    diagnosis: "",
  };
}

function launchResult(totalMs: number): AnalyzeAppLaunchResult {
  return {
    ok: true,
    tracePath: "/fake.trace",
    totalLaunchMs: totalMs,
    launchType: "cold",
    phases: [],
    diagnosis: "",
  };
}

describe("compareHangs", () => {
  it("PASS when after has zero hangs", () => {
    const before = hangsResult({ hangs: 5, longestMs: 1200, averageMs: 600, totalMs: 3000 });
    const after = hangsResult({ hangs: 0, longestMs: 0, averageMs: 0, totalMs: 0 });
    const cmp = compareHangs(before, after, 0);
    expect(cmp.verdict).toBe("PASS");
    expect(cmp.delta.count).toBe(-5);
  });

  it("PASS when longest is below threshold even if some hangs remain", () => {
    const before = hangsResult({ hangs: 5, longestMs: 1200, averageMs: 600, totalMs: 3000 });
    const after = hangsResult({ hangs: 2, longestMs: 100, averageMs: 80, totalMs: 200 });
    const cmp = compareHangs(before, after, 250);
    expect(cmp.verdict).toBe("PASS");
  });

  it("PARTIAL when count reduced but longest still above threshold", () => {
    const before = hangsResult({ hangs: 5, longestMs: 1200, averageMs: 600, totalMs: 3000 });
    const after = hangsResult({ hangs: 2, longestMs: 800, averageMs: 600, totalMs: 1400 });
    const cmp = compareHangs(before, after, 0);
    expect(cmp.verdict).toBe("PARTIAL");
    expect(cmp.delta.count).toBe(-3);
  });

  it("FAIL when count is the same or more", () => {
    const before = hangsResult({ hangs: 5, longestMs: 1200, averageMs: 600, totalMs: 3000 });
    const after = hangsResult({ hangs: 5, longestMs: 1300, averageMs: 700, totalMs: 3500 });
    const cmp = compareHangs(before, after, 0);
    expect(cmp.verdict).toBe("FAIL");
  });
});

describe("compareAnimationHitches", () => {
  it("PASS when after has zero perceptible hitches", () => {
    const before = hitchesResult({
      perceptible: 8,
      longestMs: 250,
      averageMs: 150,
      totalMs: 1200,
    });
    const after = hitchesResult({
      perceptible: 0,
      longestMs: 0,
      averageMs: 0,
      totalMs: 0,
    });
    const cmp = compareAnimationHitches(before, after, 100);
    expect(cmp.verdict).toBe("PASS");
  });

  it("PARTIAL when reduced but still above threshold", () => {
    const before = hitchesResult({
      perceptible: 8,
      longestMs: 250,
      averageMs: 150,
      totalMs: 1200,
    });
    const after = hitchesResult({
      perceptible: 3,
      longestMs: 180,
      averageMs: 130,
      totalMs: 400,
    });
    const cmp = compareAnimationHitches(before, after, 100);
    expect(cmp.verdict).toBe("PARTIAL");
  });

  it("counts perceptible hitches (>100ms), not raw rows", () => {
    // Even if there are 50 sub-100ms hitches, count uses perceptible only.
    const before = hitchesResult({
      perceptible: 2,
      longestMs: 200,
      averageMs: 150,
      totalMs: 300,
    });
    const cmp = compareAnimationHitches(before, before, 100);
    expect(cmp.beforeStats.count).toBe(2);
  });
});

describe("compareAppLaunch", () => {
  it("PASS when after totalMs is below threshold", () => {
    const before = launchResult(1800);
    const after = launchResult(800);
    const cmp = compareAppLaunch(before, after, 1000);
    expect(cmp.verdict).toBe("PASS");
    expect(cmp.delta.totalMs).toBe(-1000);
  });

  it("PARTIAL when reduced but still above threshold", () => {
    const before = launchResult(1800);
    const after = launchResult(1200);
    const cmp = compareAppLaunch(before, after, 1000);
    expect(cmp.verdict).toBe("PARTIAL");
  });

  it("FAIL when no improvement", () => {
    const before = launchResult(1800);
    const after = launchResult(1900);
    const cmp = compareAppLaunch(before, after, 1000);
    expect(cmp.verdict).toBe("FAIL");
  });

  it("verdict semantics differ from hangs/hitches — based on absolute totalMs, not count", () => {
    // count is always 1 for app-launch since each trace has one launch event.
    const before = launchResult(1500);
    const after = launchResult(900);
    const cmp = compareAppLaunch(before, after, 1000);
    expect(cmp.beforeStats.count).toBe(1);
    expect(cmp.afterStats.count).toBe(1);
    expect(cmp.verdict).toBe("PASS"); // because afterStats.totalMs <= threshold
  });
});
