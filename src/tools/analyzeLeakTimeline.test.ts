import { describe, it, expect } from "vitest";
import { analyzeLeakTimelineFromXml } from "./analyzeLeakTimeline.js";

const LEAKS_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="leaks">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>class</mnemonic><name>Class</name><engineering-type>short-string</engineering-type></col>
<col><mnemonic>count</mnemonic><name>Count</name><engineering-type>integer</engineering-type></col>
<col><mnemonic>bytes</mnemonic><name>Bytes</name><engineering-type>byte-count</engineering-type></col>
</schema>
<row>
<time id="1" fmt="00:01.000">1000000000</time>
<class id="2" fmt="AVPlayerItem">AVPlayerItem</class>
<count id="3" fmt="3">3</count>
<bytes id="4" fmt="2 KB">2048</bytes>
</row>
<row>
<time id="5" fmt="00:02.000">2000000000</time>
<class id="6" fmt="AVPlayerItem">AVPlayerItem</class>
<count id="7" fmt="15">15</count>
<bytes id="8" fmt="10 KB">10240</bytes>
</row>
<row>
<time id="9" fmt="00:03.000">3000000000</time>
<class id="10" fmt="DetailViewModel">DetailViewModel</class>
<count id="11" fmt="5">5</count>
<bytes id="12" fmt="1 KB">1024</bytes>
</row>
<row>
<time id="13" fmt="00:04.500">4500000000</time>
<class id="14" fmt="AVPlayerItem">AVPlayerItem</class>
<count id="15" fmt="50">50</count>
<bytes id="16" fmt="34 KB">34816</bytes>
</row>
</node></trace-query-result>`;

describe("analyzeLeakTimelineFromXml", () => {
  it("parses rows + class count", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    expect(r.totals.rows).toBe(4);
    expect(r.totals.classes).toBe(2);
  });

  it("AVPlayerItem peakCount tracks the maximum count seen", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    const avp = r.topClasses.find((c) => c.className === "AVPlayerItem");
    expect(avp?.peakCount).toBe(50);
    expect(avp?.peakBytes).toBe(34816);
    expect(avp?.eventCount).toBe(3);
  });

  it("firstSeenAtNs is the earliest timestamp per class", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    const avp = r.topClasses.find((c) => c.className === "AVPlayerItem");
    expect(avp?.firstSeenAtNs).toBe(1000000000);
    const vm = r.topClasses.find((c) => c.className === "DetailViewModel");
    expect(vm?.firstSeenAtNs).toBe(3000000000);
  });

  it("topClasses is sorted by peakCount desc", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    expect(r.topClasses[0].className).toBe("AVPlayerItem");
    expect(r.topClasses[1].className).toBe("DetailViewModel");
  });

  it("respects topN limit", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace", 1);
    expect(r.topClasses).toHaveLength(1);
  });

  it("lastEventNs captures the latest timestamp", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    expect(r.totals.lastEventNs).toBe(4500000000);
  });

  it("diagnosis names the top leaked class + first-seen-at", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    expect(r.diagnosis).toContain("AVPlayerItem");
    expect(r.diagnosis).toContain("peak 50");
    expect(r.diagnosis).toMatch(/first seen at \d+\.\d+s/);
  });

  it("returns status not_present when schema absent", () => {
    const empty = `<?xml version="1.0"?><trace-query-result><node><schema name="tick"/></node></trace-query-result>`;
    const r = analyzeLeakTimelineFromXml(empty, "/fake.trace");
    expect(r.status).toBe("not_present");
    expect(r.totals.rows).toBe(0);
    expect(r.supportStatus[0].kind).toBe("leak-events");
  });

  it("supportStatus carries kind=leak-events on the happy path", () => {
    const r = analyzeLeakTimelineFromXml(LEAKS_FIXTURE, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("leak-events");
    expect(r.supportStatus[0].status).toBe("available");
    expect(r.supportStatus[0].sourceSchemas).toEqual(["leaks"]);
  });

  it("v1.17 B-14: surfaces partial status when all rows lack a parseable className (column drift detection)", () => {
    const driftedSchema = `<?xml version="1.0"?>
<trace-query-result><node><schema name="leaks">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>weird-column-name</mnemonic><name>Class</name><engineering-type>short-string</engineering-type></col>
</schema>
<row><time id="1" fmt="00:01.000">1000000000</time><weird-column-name id="2" fmt="AVPlayerItem">AVPlayerItem</weird-column-name></row>
<row><time id="3" fmt="00:02.000">2000000000</time><weird-column-name id="4" fmt="DetailViewModel">DetailViewModel</weird-column-name></row>
</node></trace-query-result>`;
    const r = analyzeLeakTimelineFromXml(driftedSchema, "/fake.trace");
    expect(r.status).toBe("partial");
    expect(r.supportStatus[0].status).toBe("partial");
    expect(r.supportStatus[0].reason).toMatch(/column-name drift|column name|parseable className/i);
    expect(r.diagnosis).toMatch(/drift|expected/i);
    // Schema absence vs parser mismatch: this is mismatch.
    expect(r.totals.rows).toBe(0);
  });

  it("rows without a className are skipped (defensive)", () => {
    const skip = `<?xml version="1.0"?>
<trace-query-result><node><schema name="leaks">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>class</mnemonic><name>Class</name><engineering-type>short-string</engineering-type></col>
</schema>
<row><time id="1" fmt="00:01.000">1000000000</time><class id="2" fmt="">  </class></row>
<row><time id="3" fmt="00:02.000">2000000000</time><class id="4" fmt="Foo">Foo</class></row>
</node></trace-query-result>`;
    const r = analyzeLeakTimelineFromXml(skip, "/fake.trace");
    expect(r.totals.rows).toBe(1);
    expect(r.totals.classes).toBe(1);
  });
});
