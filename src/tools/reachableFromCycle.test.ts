import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLeaksOutput } from "../parsers/leaksOutput.js";
import { reachableFromReport } from "./reachableFromCycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const leaksText = readFileSync(
  resolve(FIXTURES, "example-leaks.head.leaks.txt"),
  "utf8",
);
const report = parseLeaksOutput(leaksText);

describe("reachableFromCycle", () => {
  it("returns counts scoped to the first cycle by default", () => {
    const result = reachableFromReport(report, "/fake.memgraph", {
      path: "/fake.memgraph",
      verbosity: "compact",
      topN: 20,
    });
    expect(result.cycle.index).toBe(0);
    expect(result.cycle.totalReachable).toBeGreaterThan(0);
    expect(result.counts.length).toBeGreaterThan(0);
  });

  it("filters by className when provided", () => {
    const result = reachableFromReport(report, "/fake.memgraph", {
      path: "/fake.memgraph",
      className: "GraphQLClient",
      topN: 20,
      verbosity: "compact",
    });
    expect(result.counts.every((c) => c.className.includes("GraphQLClient"))).toBe(
      true,
    );
  });

  it("can pick cycle by rootClassName substring", () => {
    const roots = report.cycles;
    if (roots.length === 0) return;
    const firstRootName = roots[0].className;
    const substring = firstRootName.split(/[<.]/).find((s) => s.length > 5) ?? "";
    if (!substring) return;
    const result = reachableFromReport(report, "/fake.memgraph", {
      path: "/fake.memgraph",
      rootClassName: substring,
      topN: 5,
      verbosity: "compact",
    });
    expect(result.cycle.rootClass.length).toBeGreaterThan(0);
  });

  it("ranks classes by descending count", () => {
    const result = reachableFromReport(report, "/fake.memgraph", {
      path: "/fake.memgraph",
      topN: 50,
      verbosity: "compact",
    });
    for (let i = 0; i + 1 < result.counts.length; i++) {
      expect(result.counts[i].count).toBeGreaterThanOrEqual(
        result.counts[i + 1].count,
      );
    }
  });

  it("respects topN cap", () => {
    const result = reachableFromReport(report, "/fake.memgraph", {
      path: "/fake.memgraph",
      topN: 3,
      verbosity: "compact",
    });
    expect(result.counts.length).toBeLessThanOrEqual(3);
  });

  it("throws when rootClassName matches no cycle", () => {
    expect(() =>
      reachableFromReport(report, "/fake.memgraph", {
        path: "/fake.memgraph",
        rootClassName: "DoesNotExistXYZ",
        topN: 5,
        verbosity: "compact",
      }),
    ).toThrow(/No ROOT CYCLE found/);
  });

  it("throws when cycleIndex is out of range", () => {
    expect(() =>
      reachableFromReport(report, "/fake.memgraph", {
        path: "/fake.memgraph",
        cycleIndex: 999,
        topN: 5,
        verbosity: "compact",
      }),
    ).toThrow(/No ROOT CYCLE at index/);
  });
});
