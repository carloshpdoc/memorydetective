import { describe, it, expect } from "vitest";
import {
  analyzeEnergyImpactFromXml,
  normalizeBucket,
} from "./analyzeEnergyImpact.js";

const ENERGY_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="energy-impact">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>bucket</mnemonic><name>Bucket</name><engineering-type>short-string</engineering-type></col>
<col><mnemonic>wakeups</mnemonic><name>Wakeups</name><engineering-type>integer</engineering-type></col>
<col><mnemonic>cost</mnemonic><name>Cost</name><engineering-type>integer</engineering-type></col>
</schema>
<row>
<time id="1" fmt="00:00.500">500000000</time>
<bucket id="2" fmt="idle">idle</bucket>
<wakeups id="3" fmt="10">10</wakeups>
<cost id="4" fmt="5">5</cost>
</row>
<row>
<time id="5" fmt="00:01.500">1500000000</time>
<bucket id="6" fmt="active">active</bucket>
<wakeups id="7" fmt="120">120</wakeups>
<cost id="8" fmt="80">80</cost>
</row>
<row>
<time id="9" fmt="00:02.500">2500000000</time>
<bucket id="10" fmt="high">high</bucket>
<wakeups id="11" fmt="500">500</wakeups>
<cost id="12" fmt="350">350</cost>
</row>
<row>
<time id="13" fmt="00:03.500">3500000000</time>
<bucket id="14" fmt="active">active</bucket>
<wakeups id="15" fmt="200">200</wakeups>
<cost id="16" fmt="150">150</cost>
</row>
</node></trace-query-result>`;

describe("analyzeEnergyImpactFromXml", () => {
  it("parses row count + totalWakeups", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace");
    expect(r.totals.rows).toBe(4);
    expect(r.totals.totalWakeups).toBe(10 + 120 + 500 + 200);
  });

  it("bucketCounts tally each canonical bucket separately", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace");
    expect(r.totals.bucketCounts).toEqual({
      idle: 1,
      passive: 0,
      active: 2,
      high: 1,
      unknown: 0,
    });
  });

  it("activeRatio is (active + high) / total", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace");
    expect(r.totals.activeRatio).toBeCloseTo(3 / 4, 2);
  });

  it("topByCost is sorted desc and respects topN", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace", 2);
    expect(r.topByCost).toHaveLength(2);
    expect(r.topByCost[0].cost).toBe(350);
    expect(r.topByCost[0].bucket).toBe("high");
    expect(r.topByCost[1].cost).toBe(150);
  });

  it("diagnosis names the high bucket count + heavy drain narrative", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace");
    expect(r.diagnosis).toContain("1 sample in the 'high' bucket");
    expect(r.diagnosis).toContain("Heavy battery drain");
  });

  it("returns status not_present when schema absent", () => {
    const empty = `<?xml version="1.0"?><trace-query-result><node><schema name="tick"/></node></trace-query-result>`;
    const r = analyzeEnergyImpactFromXml(empty, "/fake.trace");
    expect(r.status).toBe("not_present");
    expect(r.totals.rows).toBe(0);
    expect(r.supportStatus[0].kind).toBe("energy-impact");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("supportStatus carries sourceSchemas on the happy path", () => {
    const r = analyzeEnergyImpactFromXml(ENERGY_FIXTURE, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("energy-impact");
    expect(r.supportStatus[0].sourceSchemas).toEqual(["energy-impact"]);
  });
});

describe("normalizeBucket", () => {
  it("maps idle / passive / active / high to canonical names", () => {
    expect(normalizeBucket("idle")).toBe("idle");
    expect(normalizeBucket("Passive")).toBe("passive");
    expect(normalizeBucket("active")).toBe("active");
    expect(normalizeBucket("HIGH")).toBe("high");
  });

  it("maps foreground -> active and background -> passive", () => {
    expect(normalizeBucket("foreground")).toBe("active");
    expect(normalizeBucket("background")).toBe("passive");
  });

  it("falls through to unknown for unrecognized strings", () => {
    expect(normalizeBucket("flying-cars")).toBe("unknown");
    expect(normalizeBucket("")).toBe("unknown");
    expect(normalizeBucket(undefined)).toBe("unknown");
  });
});
