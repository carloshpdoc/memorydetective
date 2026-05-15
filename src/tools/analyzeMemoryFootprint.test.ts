import { describe, it, expect } from "vitest";
import {
  analyzeMemoryFootprintFromXml,
  formatBytes,
} from "./analyzeMemoryFootprint.js";

const MEMORY_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="memory-footprint">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>resident</mnemonic><name>Resident</name><engineering-type>byte-count</engineering-type></col>
<col><mnemonic>dirty</mnemonic><name>Dirty</name><engineering-type>byte-count</engineering-type></col>
<col><mnemonic>compressed</mnemonic><name>Compressed</name><engineering-type>byte-count</engineering-type></col>
<col><mnemonic>virtual</mnemonic><name>Virtual</name><engineering-type>byte-count</engineering-type></col>
</schema>
<row>
<time id="1" fmt="00:00.500">500000000</time>
<resident id="2" fmt="50 MB">52428800</resident>
<dirty id="3" fmt="30 MB">31457280</dirty>
<compressed id="4" fmt="10 MB">10485760</compressed>
<virtual id="5" fmt="200 MB">209715200</virtual>
</row>
<row>
<time id="6" fmt="00:01.500">1500000000</time>
<resident id="7" fmt="120 MB">125829120</resident>
<dirty id="8" fmt="80 MB">83886080</dirty>
<compressed id="9" fmt="15 MB">15728640</compressed>
<virtual id="10" fmt="300 MB">314572800</virtual>
</row>
<row>
<time id="11" fmt="00:02.500">2500000000</time>
<resident id="12" fmt="250 MB">262144000</resident>
<dirty id="13" fmt="220 MB">230686720</dirty>
<compressed id="14" fmt="25 MB">26214400</compressed>
<virtual id="15" fmt="500 MB">524288000</virtual>
</row>
</node></trace-query-result>`;

describe("analyzeMemoryFootprintFromXml", () => {
  it("parses row count and peak/avg resident", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.totals.rows).toBe(3);
    expect(r.totals.peakResidentBytes).toBe(262144000); // 250 MB
    const expectedAvg = (52428800 + 125829120 + 262144000) / 3;
    expect(r.totals.averageResidentBytes).toBeCloseTo(expectedAvg, 2);
  });

  it("peakDirty captures the largest dirty value", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.totals.peakDirtyBytes).toBe(230686720); // 220 MB
  });

  it("peakResidentAtNs points at the timestamp of the peak sample", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.totals.peakResidentAtNs).toBe(2500000000);
  });

  it("topByResident is ranked descending by residentBytes", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.topByResident[0].residentBytes).toBe(262144000);
    expect(r.topByResident[1].residentBytes).toBe(125829120);
    expect(r.topByResident[2].residentBytes).toBe(52428800);
  });

  it("diagnosis flags 220 MB dirty as jetsam territory", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.diagnosis).toContain("Peak dirty: 220.0 MB");
    expect(r.diagnosis).toContain("jetsam");
  });

  it("supportStatus carries kind=memory-footprint", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("memory-footprint");
    expect(r.supportStatus[0].status).toBe("available");
    expect(r.supportStatus[0].sourceSchemas).toEqual(["memory-footprint"]);
  });

  it("returns status not_present when schema is absent", () => {
    const empty = `<?xml version="1.0"?><trace-query-result><node><schema name="tick"/></node></trace-query-result>`;
    const r = analyzeMemoryFootprintFromXml(empty, "/fake.trace");
    expect(r.status).toBe("not_present");
    expect(r.totals.rows).toBe(0);
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("respects topN limit", () => {
    const r = analyzeMemoryFootprintFromXml(MEMORY_FIXTURE, "/fake.trace", 2);
    expect(r.topByResident).toHaveLength(2);
  });
});

describe("formatBytes helper", () => {
  it("formats <1KB in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats <1MB in KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats <1GB in MB", () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 MB");
  });

  it("formats >=1GB in GB", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });

  it("returns n/a for undefined / NaN", () => {
    expect(formatBytes(undefined)).toBe("n/a");
    expect(formatBytes(NaN)).toBe("n/a");
  });
});
