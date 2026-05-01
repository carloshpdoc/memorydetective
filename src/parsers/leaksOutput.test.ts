import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseLeaksOutput,
  rootCyclesOnly,
  walkCycles,
  classNames,
} from "./leaksOutput.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

describe("parseLeaksOutput — example-leaks (pre-fix)", () => {
  const text = loadFixture("example-leaks.head.leaks.txt");
  const report = parseLeaksOutput(text);

  it("parses header fields", () => {
    expect(report.header.process).toBe("DemoApp");
    expect(report.header.pid).toBe(12345);
    expect(report.header.identifier).toBe("com.example.app");
    expect(report.header.platform).toBe("iOS");
    expect(report.header.physicalFootprint).toBe("960.1M");
  });

  it("parses totals", () => {
    expect(report.totals.leakCount).toBe(60436);
    expect(report.totals.totalLeakedBytes).toBe(8277184);
    expect(report.totals.nodesMalloced).toBe(3070004);
  });

  it("finds at least one ROOT CYCLE (the TagIndexProjection one)", () => {
    expect(report.hasNoCycles).toBe(false);
    const roots = rootCyclesOnly(report.cycles);
    expect(roots.length).toBeGreaterThan(0);
    const top = roots[0];
    expect(top.isRootCycle).toBe(true);
    expect(top.className).toContain("_DictionaryStorage");
    expect(top.address).toMatch(/^0x[0-9a-f]+$/i);
    expect(top.instanceSize).toBe(640);
  });

  it("captures the DetailViewModel leaked instance somewhere in the tree", () => {
    const names = classNames(report.cycles);
    expect(names.has("DetailViewModel")).toBe(true);
  });

  it("captures a CYCLE BACK node", () => {
    const all = Array.from(walkCycles(report.cycles)).map((x) => x.node);
    const back = all.find((n) => n.isCycleBack);
    expect(back).toBeDefined();
    expect(back?.className).toContain("_DictionaryStorage");
  });

  it("recognizes __strong retain edges", () => {
    const strongs = Array.from(walkCycles(report.cycles))
      .map((x) => x.node)
      .filter((n) => n.retainKind === "__strong");
    expect(strongs.length).toBeGreaterThan(5);
    expect(strongs.some((n) => n.edge?.includes("_viewModel"))).toBe(true);
  });

  it("preserves indentation-based hierarchy (nested children)", () => {
    const root = rootCyclesOnly(report.cycles)[0];
    expect(root.children.length).toBeGreaterThan(1);
    const maxDepthOf = (n: typeof root): number =>
      n.children.length === 0
        ? 0
        : 1 + Math.max(...n.children.map(maxDepthOf));
    expect(maxDepthOf(root)).toBeGreaterThan(3);
  });

  it("parses bare-address ROOT CYCLE entries (no class name in <...>)", () => {
    const all = Array.from(walkCycles(report.cycles)).map((x) => x.node);
    const bareRootCycles = all.filter(
      (n) => n.isRootCycle && n.className === "",
    );
    // The line `view + 16 --> ROOT CYCLE: 0x1569cafe0 [32]` should land here.
    expect(bareRootCycles.length).toBeGreaterThan(0);
    expect(bareRootCycles[0].address).toMatch(/^0x[0-9a-f]+$/i);
  });
});

describe("parseLeaksOutput — example-fix (post-fix)", () => {
  const text = loadFixture("example-fix.head.leaks.txt");
  const report = parseLeaksOutput(text);

  it("parses smaller leak total", () => {
    expect(report.totals.leakCount).toBe(55576);
  });

  it("still has ROOT CYCLEs (SwiftUI internals always do)", () => {
    expect(rootCyclesOnly(report.cycles).length).toBeGreaterThan(0);
  });
});

describe("parseLeaksOutput — synthetic edge cases", () => {
  it("handles an output with zero ROOT CYCLE entries", () => {
    const text = `Process:         Demo [123]
Identifier:      com.example.demo
Platform:        iOS
----

leaks Report Version: 4.0
Process 123: 100 nodes malloced for 50 KB
Process 123: 0 leaks for 0 total leaked bytes.

    0 (0) << TOTAL >>
`;
    const report = parseLeaksOutput(text);
    expect(report.totals.leakCount).toBe(0);
    expect(report.cycles.length).toBe(0);
    expect(report.hasNoCycles).toBe(true);
  });

  it("survives totally empty input gracefully", () => {
    const report = parseLeaksOutput("");
    expect(report.totals.leakCount).toBe(0);
    expect(report.cycles.length).toBe(0);
    expect(report.hasNoCycles).toBe(true);
  });
});
