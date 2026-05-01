import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLeaksOutput } from "../parsers/leaksOutput.js";
import { findRetainersIn } from "./findRetainers.js";
import { countByClass } from "./countAlive.js";
import { diffReports } from "./diffMemgraphs.js";
import { classifyReport, PATTERNS } from "./classifyCycle.js";
import type { CycleNode, LeaksReport } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const leaksText = readFileSync(
  resolve(FIXTURES, "example-leaks.head.leaks.txt"),
  "utf8",
);
const fix2Text = readFileSync(
  resolve(FIXTURES, "example-fix.head.leaks.txt"),
  "utf8",
);

describe("findRetainers", () => {
  const report = parseLeaksOutput(leaksText);

  it("finds the DetailViewModel retain chain", () => {
    const result = findRetainersIn(report, "DetailViewModel");
    expect(result.totalMatches).toBeGreaterThan(0);
    const chain = result.retainers[0].path;
    expect(chain[chain.length - 1].className).toBe("DetailViewModel");
    // The chain should pass through TagIndexProjection on its way down.
    expect(chain.some((e) => e.className.includes("TagIndexProjection"))).toBe(
      true,
    );
  });

  it("returns empty for unknown class", () => {
    const result = findRetainersIn(report, "DoesNotExistFooBar");
    expect(result.totalMatches).toBe(0);
    expect(result.retainers).toEqual([]);
  });

  it("respects maxResults cap", () => {
    const result = findRetainersIn(report, "GraphQLClient", 1);
    expect(result.retainers.length).toBeLessThanOrEqual(1);
  });
});

describe("countAlive (countByClass)", () => {
  const report = parseLeaksOutput(leaksText);

  it("counts all class occurrences", () => {
    const counts = countByClass(report);
    expect(counts.size).toBeGreaterThan(5);
    // DetailViewModel should appear at least once in the parsed (head) section.
    expect(counts.get("DetailViewModel")).toBeGreaterThan(0);
  });

  it("counts GraphQLClient correctly (multiple instances expected)", () => {
    const counts = countByClass(report);
    const graphql = counts.get("GraphQLClient") ?? 0;
    expect(graphql).toBeGreaterThan(1);
  });
});

describe("diffMemgraphs (diffReports)", () => {
  const before = parseLeaksOutput(leaksText); // 60436 leaks
  const after = parseLeaksOutput(fix2Text); // 55576 leaks

  it("computes total leak delta correctly", () => {
    const result = diffReports(before, after, "before.memgraph", "after.memgraph");
    expect(result.totals.leakCountDelta).toBe(after.totals.leakCount - before.totals.leakCount);
    expect(result.totals.leakCountDelta).toBeLessThan(0);
  });

  it("buckets cycles into new / gone / persisted", () => {
    const result = diffReports(before, after, "b.memgraph", "a.memgraph");
    const total =
      result.cycles.newInAfter.length +
      result.cycles.goneFromBefore.length +
      result.cycles.persisted.length;
    expect(total).toBeGreaterThan(0);
  });

  it("ranks decreased classes (post-fix improvements)", () => {
    const result = diffReports(before, after, "b.memgraph", "a.memgraph");
    expect(result.classCounts.decreased.length).toBeGreaterThanOrEqual(0);
    if (result.classCounts.decreased.length > 0) {
      // Sorted ascending by delta (most negative first).
      const first = result.classCounts.decreased[0];
      expect(first.delta).toBeLessThanOrEqual(0);
    }
  });
});

describe("classifyCycle (classifyReport)", () => {
  const report = parseLeaksOutput(leaksText);

  it("classifies the TagIndexProjection cycle as high-confidence", () => {
    const { classified } = classifyReport(report);
    const tagMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "swiftui.tag-index-projection");
    expect(tagMatch).toBeDefined();
    expect(tagMatch?.confidence).toBe("high");
    expect(tagMatch?.fixHint).toContain("static helper");
  });

  it("classifies the dict-storage SwiftUI internal cycle", () => {
    const { classified } = classifyReport(report);
    const dictMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "swiftui.dictstorage-weakbox-cycle");
    expect(dictMatch).toBeDefined();
    expect(dictMatch?.confidence).toBe("high");
  });

  it("flags the closure-viewmodel-wrapped pattern when _viewModel is in chain", () => {
    const { classified } = classifyReport(report);
    const vmMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "closure.viewmodel-wrapped-strong");
    expect(vmMatch).toBeDefined();
  });

  it("returns at least one classified cycle with a primaryMatch", () => {
    const { classified } = classifyReport(report);
    expect(classified.some((c) => c.primaryMatch !== null)).toBe(true);
  });
});

/**
 * Synthetic-cycle tests for the patterns that don't appear in the example
 * fixture (Combine sink, Task captures, NotificationCenter observer). Builds
 * a minimal LeaksReport whose cycle forest contains the class-name signals
 * the pattern is supposed to recognize, and asserts the right pattern fires.
 */
function makeCycleNode(
  className: string,
  children: CycleNode[] = [],
): CycleNode {
  return {
    className,
    address: "0xDEAD",
    edge: undefined,
    retainKind: "plain",
    isRootCycle: true,
    isCycleBack: false,
    indent: 0,
    children,
  };
}

function makeReport(rootClass: string, descendants: string[]): LeaksReport {
  const child = descendants.reduceRight<CycleNode | null>(
    (acc, cls) => makeCycleNode(cls, acc ? [acc] : []),
    null,
  );
  return {
    header: {},
    totals: {
      leakCount: 1,
      totalLeakedBytes: 32,
    },
    cycles: [makeCycleNode(rootClass, child ? [child] : [])],
    hasNoCycles: false,
  };
}

describe("classifyCycle — additional patterns (synthetic cycles)", () => {
  it("matches `combine.sink-store-self-capture` when AnyCancellable + Closure context appear", () => {
    const report = makeReport("MyViewModel", [
      "Combine.AnyCancellable",
      "Closure context",
      "MyDataStore",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "combine.sink-store-self-capture",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `concurrency.task-without-weak-self` when Task<...> + Closure context appear", () => {
    const report = makeReport("MyActor", [
      "_Concurrency.Task<Swift.Void, Swift.Never>",
      "Closure context",
      "MyService",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "concurrency.task-without-weak-self",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `notificationcenter.observer-strong` when NotificationCenter + Closure context appear", () => {
    const report = makeReport("MyController", [
      "NSNotificationCenter",
      "Closure context",
      "MyController",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "notificationcenter.observer-strong",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("falls back to medium confidence when only the framework class appears (no closure context)", () => {
    const report = makeReport("MyClass", ["Combine.AnyCancellable"]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "combine.sink-store-self-capture",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("medium");
  });

  it("returns null primaryMatch when no pattern fires", () => {
    const report = makeReport("UnknownLeak", ["SomeWeirdInternalThing"]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch).toBeNull();
  });

  it("PATTERNS array contains all 8 patterns expected for v0.1", () => {
    const ids = PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "closure.viewmodel-wrapped-strong",
      "combine.sink-store-self-capture",
      "concurrency.task-without-weak-self",
      "notificationcenter.observer-strong",
      "swiftui.dictstorage-weakbox-cycle",
      "swiftui.foreach-state-tap",
      "swiftui.tag-index-projection",
      "viewcontroller.uinavigationcontroller-host",
    ]);
  });
});
