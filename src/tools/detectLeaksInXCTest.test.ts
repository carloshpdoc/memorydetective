import { describe, it, expect } from "vitest";
import {
  detectLeaksInXCTestSchema,
  summarizeNewCycles,
  isAllowlisted,
  countDescendants,
} from "./detectLeaksInXCTest.js";
import type { LeaksReport, CycleNode } from "../types.js";

function makeNode(className: string, children: CycleNode[] = []): CycleNode {
  return {
    retainKind: "__strong",
    className,
    address: "0x" + className.toLowerCase(),
    isRootCycle: true,
    isCycleBack: false,
    indent: 0,
    children,
  };
}

function makeReport(rootClasses: string[], chains: CycleNode[][] = []): LeaksReport {
  const cycles: CycleNode[] = rootClasses.map((name, i) =>
    makeNode(name, chains[i] ?? []),
  );
  return {
    header: {},
    totals: { leakCount: rootClasses.length, totalLeakedBytes: 0 },
    cycles,
    hasNoCycles: rootClasses.length === 0,
  };
}

describe("detectLeaksInXCTest schema", () => {
  it("requires exactly one of workspace or project", () => {
    expect(() =>
      detectLeaksInXCTestSchema.parse({
        scheme: "Tests",
        destination: "platform=iOS Simulator,name=iPhone 11",
      }),
    ).toThrow(/Provide exactly one of/);

    expect(() =>
      detectLeaksInXCTestSchema.parse({
        workspace: "/tmp/a.xcworkspace",
        project: "/tmp/a.xcodeproj",
        scheme: "Tests",
      }),
    ).toThrow(/Provide exactly one of/);
  });

  it("accepts a workspace-only invocation with defaults", () => {
    const parsed = detectLeaksInXCTestSchema.parse({
      workspace: "/tmp/a.xcworkspace",
      scheme: "Tests",
    });
    expect(parsed.workspace).toBe("/tmp/a.xcworkspace");
    expect(parsed.processName).toBe("xctest");
    expect(parsed.skipBuild).toBe(false);
    expect(parsed.allowlistPatterns).toEqual([]);
    expect(parsed.outputDir).toBe("/tmp/memorydetective-xctest");
    expect(parsed.runnerStartTimeoutMs).toBe(5 * 60_000);
  });

  it("accepts a project-only invocation", () => {
    const parsed = detectLeaksInXCTestSchema.parse({
      project: "/tmp/a.xcodeproj",
      scheme: "Tests",
    });
    expect(parsed.project).toBe("/tmp/a.xcodeproj");
  });

  it("preserves a custom processName for app-hosted tests", () => {
    const parsed = detectLeaksInXCTestSchema.parse({
      project: "/tmp/a.xcodeproj",
      scheme: "Tests",
      processName: "DemoAppUnitHost",
    });
    expect(parsed.processName).toBe("DemoAppUnitHost");
  });
});

describe("isAllowlisted", () => {
  it("returns true when any pattern is a substring of the class name", () => {
    expect(isAllowlisted("SwiftUI.ViewGraph", ["SwiftUI"])).toBe(true);
  });

  it("returns false when no patterns match", () => {
    expect(isAllowlisted("DemoAppViewModel", ["SwiftUI"])).toBe(false);
  });

  it("returns false on empty patterns array", () => {
    expect(isAllowlisted("DemoAppViewModel", [])).toBe(false);
  });
});

describe("countDescendants", () => {
  it("counts the entire subtree, not just direct children", () => {
    const tree = [
      { children: [{ children: [{ children: [] }] }, { children: [] }] },
    ];
    expect(countDescendants(tree)).toBe(4);
  });

  it("returns 0 for a leaf", () => {
    expect(countDescendants([])).toBe(0);
  });
});

describe("summarizeNewCycles", () => {
  it("returns no new cycles when baseline and after match", () => {
    const baseline = makeReport(["A", "B"]);
    const after = makeReport(["A", "B"]);
    const r = summarizeNewCycles(baseline, after, []);
    expect(r.newCycles).toEqual([]);
    expect(r.failingCount).toBe(0);
  });

  it("flags genuinely new cycles introduced after the test", () => {
    const baseline = makeReport(["A"]);
    const after = makeReport(["A", "LeakingViewModel"]);
    const r = summarizeNewCycles(baseline, after, []);
    expect(r.newCycles).toHaveLength(1);
    expect(r.newCycles[0].rootClass).toBe("LeakingViewModel");
    expect(r.failingCount).toBe(1);
  });

  it("marks allowlisted classes as non-failing", () => {
    const baseline = makeReport(["A"]);
    const after = makeReport(["A", "SwiftUI.Internal"]);
    const r = summarizeNewCycles(baseline, after, ["SwiftUI"]);
    expect(r.newCycles).toHaveLength(1);
    expect(r.newCycles[0].allowlisted).toBe(true);
    expect(r.failingCount).toBe(0);
  });

  it("mixes allowlisted and failing entries in one diff", () => {
    const baseline = makeReport([]);
    const after = makeReport(["AppLeak", "SwiftUI.Internal", "OtherLeak"]);
    const r = summarizeNewCycles(baseline, after, ["SwiftUI"]);
    expect(r.newCycles).toHaveLength(3);
    expect(r.failingCount).toBe(2);
    const allowlistedNames = r.newCycles
      .filter((c) => c.allowlisted)
      .map((c) => c.rootClass);
    expect(allowlistedNames).toEqual(["SwiftUI.Internal"]);
  });

  it("uses the address as a fallback when className is empty", () => {
    const anonRoot: CycleNode = {
      retainKind: "__strong",
      className: "",
      address: "0xdeadbeef",
      isRootCycle: true,
      isCycleBack: false,
      indent: 0,
      children: [],
    };
    const baseline: LeaksReport = {
      header: {},
      totals: { leakCount: 0, totalLeakedBytes: 0 },
      cycles: [],
      hasNoCycles: true,
    };
    const after: LeaksReport = {
      header: {},
      totals: { leakCount: 1, totalLeakedBytes: 0 },
      cycles: [anonRoot],
      hasNoCycles: false,
    };
    const r = summarizeNewCycles(baseline, after, []);
    expect(r.newCycles).toHaveLength(1);
    expect(r.newCycles[0].rootClass).toBe("0xdeadbeef");
  });

  it("includes the chain length in the result", () => {
    const after = makeReport(
      ["RootClass"],
      [[makeNode("Child1"), makeNode("Child2")]],
    );
    const baseline = makeReport([]);
    const r = summarizeNewCycles(baseline, after, []);
    expect(r.newCycles[0].chainLength).toBeGreaterThanOrEqual(3);
  });
});
