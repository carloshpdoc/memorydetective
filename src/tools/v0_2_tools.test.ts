import { describe, it, expect } from "vitest";
import { analyzeAnimationHitchesFromXml } from "./analyzeAnimationHitches.js";
import { analyzeAllocationsFromXml } from "./analyzeAllocations.js";
import { analyzeAppLaunchFromXml } from "./analyzeAppLaunch.js";
import {
  renderCycleAsMermaid,
  renderCycleAsDot,
} from "./renderCycleGraph.js";
import { parseLogOutput } from "./logShow.js";
import type { CycleNode } from "../types.js";

/**
 * Tests for the v0.2 batch of tools. Each uses synthetic XML / output samples
 * to exercise pure-function paths without spawning subprocesses.
 */

function n(
  className: string,
  edge?: string,
  children: CycleNode[] = [],
): CycleNode {
  return {
    className,
    address: `0x${Math.random().toString(16).slice(2, 10)}`,
    edge,
    retainKind: edge?.startsWith("__strong") ? "__strong" : "plain",
    isRootCycle: true,
    isCycleBack: false,
    indent: 0,
    children,
  };
}

describe("analyzeAnimationHitchesFromXml", () => {
  const xml = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="animation-hitches">
  <col><mnemonic>start</mnemonic><name>Start</name></col>
  <col><mnemonic>duration</mnemonic><name>Duration</name></col>
  <col><mnemonic>hitch-type</mnemonic><name>Hitch Type</name></col>
</schema>
<row><start fmt="00:01.000">1000000000</start><duration fmt="50 ms">50000000</duration><hitch-type fmt="CommitTime">CommitTime</hitch-type></row>
<row><start fmt="00:02.000">2000000000</start><duration fmt="150 ms">150000000</duration><hitch-type fmt="RenderServerCommit">RenderServerCommit</hitch-type></row>
<row><start fmt="00:03.000">3000000000</start><duration fmt="220 ms">220000000</duration><hitch-type fmt="CommitTime">CommitTime</hitch-type></row>
</node></trace-query-result>`;

  it("aggregates totals and identifies user-perceptible hitches", () => {
    const result = analyzeAnimationHitchesFromXml(xml, "/fake.trace");
    expect(result.totals.rows).toBe(3);
    expect(result.totals.perceptible).toBe(2); // 150ms + 220ms
    expect(result.totals.longestMs).toBeCloseTo(220, 0);
    expect(result.byType.CommitTime).toBe(2);
    expect(result.byType.RenderServerCommit).toBe(1);
  });

  it("filters by minDurationMs", () => {
    const result = analyzeAnimationHitchesFromXml(xml, "/fake.trace", 10, 100);
    expect(result.totals.rows).toBe(2);
    expect(result.top.every((e) => e.durationMs >= 100)).toBe(true);
  });

  it("returns empty result when schema absent", () => {
    const empty = `<?xml version="1.0"?><trace-query-result></trace-query-result>`;
    const result = analyzeAnimationHitchesFromXml(empty, "/fake.trace");
    expect(result.totals.rows).toBe(0);
    expect(result.diagnosis).toContain("No animation-hitches");
  });
});

describe("analyzeAllocationsFromXml", () => {
  const xml = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="allocations">
  <col><mnemonic>category</mnemonic><name>Category</name></col>
  <col><mnemonic>size</mnemonic><name>Size</name></col>
  <col><mnemonic>event-type</mnemonic><name>Event</name></col>
</schema>
<row><category fmt="MyClass">MyClass</category><size fmt="1024">1024</size><event-type fmt="alloc">alloc</event-type></row>
<row><category fmt="MyClass">MyClass</category><size fmt="2048">2048</size><event-type fmt="alloc">alloc</event-type></row>
<row><category fmt="OtherClass">OtherClass</category><size fmt="512">512</size><event-type fmt="alloc">alloc</event-type></row>
</node></trace-query-result>`;

  it("aggregates by category and ranks", () => {
    const result = analyzeAllocationsFromXml(xml, "/fake.trace");
    expect(result.totals.rows).toBe(3);
    expect(result.totals.cumulativeBytes).toBe(3584);
    expect(result.topByBytes[0].category).toBe("MyClass");
    expect(result.topByBytes[0].cumulativeBytes).toBe(3072);
    expect(result.topByBytes[0].cumulativeCount).toBe(2);
  });

  it("filters by minBytes", () => {
    const result = analyzeAllocationsFromXml(xml, "/fake.trace", 15, 1000);
    expect(result.totals.rows).toBe(2); // 1024 + 2048 only
    expect(result.totals.cumulativeBytes).toBe(3072);
  });
});

describe("analyzeAppLaunchFromXml", () => {
  const xml = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="app-launch">
  <col><mnemonic>phase</mnemonic><name>Phase</name></col>
  <col><mnemonic>display-label</mnemonic><name>Label</name></col>
  <col><mnemonic>duration</mnemonic><name>Duration</name></col>
  <col><mnemonic>launch-type</mnemonic><name>Type</name></col>
</schema>
<row><phase fmt="dyld-init">dyld-init</phase><display-label fmt="dyld">dyld</display-label><duration fmt="50 ms">50000000</duration></row>
<row><phase fmt="objc-init">objc-init</phase><display-label fmt="ObjC init">ObjC init</display-label><duration fmt="100 ms">100000000</duration></row>
<row><phase fmt="appdelegate-init">appdelegate-init</phase><display-label fmt="AppDelegate">AppDelegate</display-label><duration fmt="500 ms">500000000</duration></row>
<row><phase fmt="first-frame-render">first-frame-render</phase><display-label fmt="First frame">First frame</display-label><duration fmt="200 ms">200000000</duration></row>
<row><phase fmt="total">total</phase><duration fmt="850 ms">850000000</duration><launch-type fmt="cold">cold</launch-type></row>
</node></trace-query-result>`;

  it("identifies launch type and slowest phase", () => {
    const result = analyzeAppLaunchFromXml(xml, "/fake.trace");
    expect(result.launchType).toBe("cold");
    expect(result.totalLaunchMs).toBeCloseTo(850, 0);
    expect(result.slowestPhase?.phase).toBe("appdelegate-init");
    expect(result.slowestPhase?.percentOfTotal).toBeGreaterThan(50);
  });

  it("orders phases by Apple's canonical sequence", () => {
    const result = analyzeAppLaunchFromXml(xml, "/fake.trace");
    const phaseNames = result.phases.map((p) => p.phase);
    expect(phaseNames).toEqual([
      "dyld-init",
      "objc-init",
      "appdelegate-init",
      "first-frame-render",
    ]);
  });
});

describe("renderCycleAsMermaid", () => {
  const cycle = n("Root", undefined, [
    n("Closure context", "__strong onTap", [
      n("DetailViewModel", "__strong _viewModel"),
    ]),
  ]);

  it("emits a graph TD definition with all nodes", () => {
    const { graph } = renderCycleAsMermaid(cycle);
    expect(graph).toContain("graph TD");
    expect(graph).toContain("Root");
    expect(graph).toContain("Closure context");
    expect(graph).toContain("DetailViewModel");
  });

  it("highlights app-level nodes with red styling", () => {
    const { graph } = renderCycleAsMermaid(cycle);
    expect(graph).toMatch(/style \w+ fill:#ffcdd2/); // app-level red
  });

  it("includes edge labels for properties", () => {
    const { graph } = renderCycleAsMermaid(cycle);
    expect(graph).toContain('"__strong _viewModel"');
  });

  it("respects maxDepth and notes truncation", () => {
    const deep = n(
      "L0",
      undefined,
      [n("L1", "e", [n("L2", "e", [n("L3", "e", [n("L4", "e")])])])],
    );
    const { graph, notes } = renderCycleAsMermaid(deep, 2, 60);
    expect(graph).not.toContain("L4");
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("renderCycleAsDot", () => {
  const cycle = n("Root", undefined, [n("Child", "__strong x")]);
  it("emits valid digraph syntax", () => {
    const { graph } = renderCycleAsDot(cycle);
    expect(graph).toContain("digraph cycle {");
    expect(graph).toContain("rankdir=TB;");
    expect(graph).toMatch(/-> /);
    expect(graph).toContain("}");
  });
});

describe("parseLogOutput (logShow / logStream)", () => {
  const sample = `Timestamp               Ty Process[PID:TID]
2026-05-01 00:48:14.521 Df rapportd[697:531b42] [com.apple.rapport:RPRemoteDisplayDaemon] BLE device changed
2026-05-01 00:48:14.522 Er ContinuityCaptureAgent[748:531b47] [com.apple.CMContinuityCapture:default] error message
2026-05-01 00:48:14.523 In MyApp[12345:abcd] just an info line
2026-05-01 00:48:14.524 De DebugApp[111:222] [com.example:cat] debug-level entry`;

  it("parses each line into a structured entry", () => {
    const entries = parseLogOutput(sample, 100);
    expect(entries.length).toBe(4);
    expect(entries[0].process).toBe("rapportd");
    expect(entries[0].pid).toBe(697);
    expect(entries[0].subsystem).toBe("com.apple.rapport");
    expect(entries[0].category).toBe("RPRemoteDisplayDaemon");
    expect(entries[0].type).toBe("default");
  });

  it("recognizes log type codes", () => {
    const entries = parseLogOutput(sample, 100);
    expect(entries[1].type).toBe("error");
    expect(entries[2].type).toBe("info");
    expect(entries[3].type).toBe("debug");
  });

  it("respects max cap", () => {
    const entries = parseLogOutput(sample, 2);
    expect(entries.length).toBe(2);
  });

  it("skips header line", () => {
    const entries = parseLogOutput(sample, 100);
    expect(entries.find((e) => e.process === "Timestamp")).toBeUndefined();
  });

  it("handles entries without a subsystem bracket", () => {
    const entries = parseLogOutput(sample, 100);
    const noBracket = entries.find((e) => e.process === "MyApp");
    expect(noBracket?.subsystem).toBeUndefined();
    expect(noBracket?.message).toBe("just an info line");
  });
});
