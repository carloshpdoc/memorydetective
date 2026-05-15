import { describe, it, expect } from "vitest";
import { parseTraceToc } from "./inspectTrace.js";

const FIXTURE_FULL_TOC = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <run>
      <device-model>iPhone 15 Pro Max</device-model>
      <os-version>iOS 18.0</os-version>
      <template-name>Time Profiler</template-name>
      <recorded-when>2026-05-14 14:22:01</recorded-when>
      <data>
        <table schema="potential-hangs">
          <engineering-description>Main-thread hang events</engineering-description>
          <row><start>1</start></row>
          <row><start>2</start></row>
          <row><start>3</start></row>
        </table>
        <table schema="time-profile">
          <row><sample>1</sample></row>
          <row><sample>2</sample></row>
          <row><sample>3</sample></row>
          <row><sample>4</sample></row>
          <row><sample>5</sample></row>
        </table>
        <table schema="allocations">
        </table>
        <table schema="custom-private-schema">
          <row><x>1</x></row>
        </table>
      </data>
    </run>
  </node>
</trace-query-result>`;

const FIXTURE_EMPTY = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <run>
      <template-name>Time Profiler</template-name>
    </run>
  </node>
</trace-query-result>`;

describe("inspectTrace.parseTraceToc", () => {
  it("enumerates all schemas with their row counts", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    expect(r.schemas).toHaveLength(4);
    // Ranked by rowCount desc.
    expect(r.schemas[0]).toMatchObject({ name: "time-profile", rowCount: 5 });
    expect(r.schemas[1]).toMatchObject({ name: "potential-hangs", rowCount: 3 });
    expect(r.schemas[2]).toMatchObject({ name: "custom-private-schema", rowCount: 1 });
    expect(r.schemas[3]).toMatchObject({ name: "allocations", rowCount: 0 });
  });

  it("preserves engineering-description when present", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    const hangs = r.schemas.find((s) => s.name === "potential-hangs");
    expect(hangs?.description).toBe("Main-thread hang events");
  });

  it("builds rowCounts map mirroring schemas[]", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    expect(r.rowCounts).toEqual({
      "time-profile": 5,
      "potential-hangs": 3,
      "custom-private-schema": 1,
      allocations: 0,
    });
  });

  it("extracts device + OS + template + recordedWhen from the run node", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    expect(r.deviceModel).toBe("iPhone 15 Pro Max");
    expect(r.osVersion).toBe("iOS 18.0");
    expect(r.templateName).toBe("Time Profiler");
    expect(r.recordedWhen).toBe("2026-05-14 14:22:01");
  });

  it("suggests the matching analyzer for each KNOWN schema with rows", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    const tools = r.suggestedNextCalls.map((c) => c.tool);
    expect(tools).toContain("analyzeHangs");
    expect(tools).toContain("analyzeTimeProfile");
    // allocations schema is in the TOC but has 0 rows -> no suggestion.
    expect(tools).not.toContain("analyzeAllocations");
    // custom-private-schema has no analyzer mapping -> no suggestion.
    expect(r.suggestedNextCalls.find((c) => c.tool.includes("custom"))).toBeUndefined();
  });

  it("each suggestedNextCalls entry includes the tracePath in args + a rationale", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    for (const c of r.suggestedNextCalls) {
      expect(c.args).toMatchObject({ tracePath: "/tmp/run.trace" });
      expect(c.why.length).toBeGreaterThan(20);
    }
  });

  it("empty trace returns no schemas + a helpful diagnosis", () => {
    const r = parseTraceToc(FIXTURE_EMPTY, "/tmp/empty.trace");
    expect(r.schemas).toEqual([]);
    expect(r.suggestedNextCalls).toEqual([]);
    expect(r.diagnosis).toMatch(/no schemas|empty|malformed/i);
  });

  it("diagnosis mentions the template name when present", () => {
    const r = parseTraceToc(FIXTURE_FULL_TOC, "/tmp/run.trace");
    expect(r.diagnosis).toContain("Time Profiler");
    expect(r.diagnosis).toMatch(/4 schemas/);
    expect(r.diagnosis).toContain("time-profile");
  });

  it("returns empty schemas for malformed XML (graceful degradation)", () => {
    const r = parseTraceToc("<garbage>not a trace</garbage>", "/tmp/bad.trace");
    expect(r.schemas).toEqual([]);
    expect(r.suggestedNextCalls).toEqual([]);
  });
});

// Real `xctrace export --toc` output captured from
// ~/Desktop/wishlist-tti-device.trace (Xcode 26.0, physical iPhone 17 Pro
// Max, Time Profiler template, 2026-04-27). Validation reference for the
// 2026-05-15 parser fix: previous xpath-based discovery returned schemas:[]
// against this exact bundle, cascading into summarizeTrace reporting
// "no events detected" even with 35 hangs present.
const FIXTURE_APPLE_TOC = `<?xml version="1.0"?>
<trace-toc>
    <run number="1">
        <info>
            <target>
                <device platform="iOS" model="iPhone 17 Pro Max" name="iPhone 17 Pro Max" os-version="26.3.1 (23D771330a)" uuid="00008150-001E449E1E99401C"/>
                <host-device platform="macOS" model="MacBook Pro" name="MacBook Pro" os-version="26.4 (25E246)" uuid="D283C622-DE11-5668-8E1F-E6234E85E6C8"/>
                <process type="attached" return-exit-status="0" name="AmiGo" pid="26535" termination-reason="exit(0)"/>
            </target>
            <summary>
                <start-date>2026-04-27T23:34:02.002-03:00</start-date>
                <end-date>2026-04-27T23:35:33.577-03:00</end-date>
                <duration>91.574574</duration>
                <end-reason>Time limit reached</end-reason>
                <instruments-version>26.0 (17C519)</instruments-version>
                <template-name>Time Profiler</template-name>
                <recording-mode>Deferred</recording-mode>
                <time-limit>1 minute, 30 seconds</time-limit>
            </summary>
        </info>
        <data>
            <table schema="tick" frequency="10"/>
            <table schema="life-cycle-period" target-pid="SINGLE"/>
            <table schema="hang-risks" detect-priority-inversions="0" target-pid="SINGLE"/>
            <table hangs-threshold="250" schema="potential-hangs" target-pid="SINGLE"/>
            <table target-pid="SINGLE" schema="time-profile" needs-kernel-callstack="0" record-waiting-threads="0"/>
            <table schema="process-info"/>
            <table schema="dyld-library-load" target-pid="SINGLE"/>
            <table schema="thread-info"/>
        </data>
        <tracks/>
    </run>
</trace-toc>`;

describe("inspectTrace.parseTraceToc — real Apple --toc output", () => {
  it("enumerates self-closing table elements as schemas", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    const names = r.schemas.map((s) => s.name).sort();
    expect(names).toEqual([
      "dyld-library-load",
      "hang-risks",
      "life-cycle-period",
      "potential-hangs",
      "process-info",
      "thread-info",
      "tick",
      "time-profile",
    ]);
  });

  it("assigns rowCount: 0 to all schemas (the TOC itself carries no rows)", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    for (const s of r.schemas) {
      expect(s.rowCount).toBe(0);
    }
  });

  it("extracts deviceModel from the <device> element's model attribute", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    expect(r.deviceModel).toBe("iPhone 17 Pro Max");
  });

  it("extracts osVersion from the <device> element's os-version attribute", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    expect(r.osVersion).toBe("26.3.1 (23D771330a)");
  });

  it("extracts recordedWhen from <start-date> (Apple uses start-date, not recorded-when)", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    expect(r.recordedWhen).toBe("2026-04-27T23:34:02.002-03:00");
  });

  it("extracts templateName as before", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    expect(r.templateName).toBe("Time Profiler");
  });

  it("emits no suggestedNextCalls when all schemas have rowCount: 0 (rows live elsewhere; inspectTrace fills them async)", () => {
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    expect(r.suggestedNextCalls).toEqual([]);
  });

  it("handles schemas with attributes in any order (schema= can be at any attribute position)", () => {
    // hangs-threshold appears BEFORE schema= in the real TOC; this caused
    // the original regex (which assumed schema= was first) to fail on real
    // traces in some edge cases. Real fixture has both orderings.
    const r = parseTraceToc(FIXTURE_APPLE_TOC, "/tmp/real.trace");
    const hangs = r.schemas.find((s) => s.name === "potential-hangs");
    expect(hangs).toBeDefined();
    const hangRisks = r.schemas.find((s) => s.name === "hang-risks");
    expect(hangRisks).toBeDefined();
  });
});
