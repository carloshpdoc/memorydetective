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
