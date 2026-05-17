/**
 * v1.14 item I. Cross-analyzer assertions on the unified `supportStatus[]`
 * surface. Each analyzer should return a populated array regardless of
 * outcome; the per-area `kind` should be set; the canonical fallback
 * status names should be used; old `status` / `notice` aliases should
 * still work for backwards compatibility.
 */

import { describe, it, expect } from "vitest";
import { analyzeHangsFromXml } from "./analyzeHangs.js";
import { analyzeAnimationHitchesFromXml } from "./analyzeAnimationHitches.js";
import { analyzeAllocationsFromXml } from "./analyzeAllocations.js";
import { analyzeAppLaunchFromXml } from "./analyzeAppLaunch.js";
import { analyzeTimeProfileFromXml } from "./analyzeTimeProfile.js";
import { analyzeNetworkActivityFromXml } from "./analyzeNetworkActivity.js";
import { SUPPORT_STATUS_KINDS, type SupportStatus } from "../types.js";

const EMPTY_XML = `<?xml version="1.0"?><trace-query-result><node/></trace-query-result>`;

describe("supportStatus[] unified surface (v1.14 item I)", () => {
  it("analyzeHangs returns supportStatus with kind=potential-hangs", () => {
    const r = analyzeHangsFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus).toBeDefined();
    expect(r.supportStatus.length).toBeGreaterThan(0);
    expect(r.supportStatus[0].kind).toBe("potential-hangs");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("analyzeAnimationHitches returns supportStatus with kind=animation-hitches", () => {
    const r = analyzeAnimationHitchesFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("animation-hitches");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("analyzeAllocations returns supportStatus with kind=allocations", () => {
    const r = analyzeAllocationsFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("allocations");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("analyzeAppLaunch returns supportStatus with kind=app-launch", () => {
    const r = analyzeAppLaunchFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("app-launch");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("analyzeTimeProfile returns supportStatus with kind=time-profile", () => {
    const r = analyzeTimeProfileFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("time-profile");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("analyzeNetworkActivity returns supportStatus with kind=network-connections", () => {
    const r = analyzeNetworkActivityFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].kind).toBe("network-connections");
    expect(r.supportStatus[0].status).toBe("not_present");
  });

  it("reason field carries the workaround tip on not_present", () => {
    const r = analyzeHangsFromXml(EMPTY_XML, "/fake.trace");
    expect(r.supportStatus[0].reason).toMatch(/Schema absent/);
  });

  it("status: available is set on the happy path", () => {
    const hangsXml = `<?xml version="1.0"?>
<trace-query-result><node><schema name="potential-hangs">
<col><mnemonic>start</mnemonic><name>Start</name><engineering-type>start-time</engineering-type></col>
<col><mnemonic>duration</mnemonic><name>Duration</name><engineering-type>duration</engineering-type></col>
<col><mnemonic>hang-type</mnemonic><name>Hang Type</name><engineering-type>hang-type</engineering-type></col>
</schema>
<row><start id="1" fmt="00:01.000">1000000000</start><duration id="2" fmt="500 ms">500000000</duration><hang-type id="3" fmt="Hang">Hang</hang-type></row>
</node></trace-query-result>`;
    const r = analyzeHangsFromXml(hangsXml, "/fake.trace");
    expect(r.supportStatus[0].status).toBe("available");
    expect(r.supportStatus[0].sourceSchemas).toEqual(["potential-hangs"]);
  });

  it("hang-risks adds a second supportStatus entry when its XML is provided", () => {
    const hangsXml = `<?xml version="1.0"?>
<trace-query-result><node><schema name="potential-hangs">
<col><mnemonic>start</mnemonic><name>Start</name><engineering-type>start-time</engineering-type></col>
<col><mnemonic>duration</mnemonic><name>Duration</name><engineering-type>duration</engineering-type></col>
<col><mnemonic>hang-type</mnemonic><name>Hang Type</name><engineering-type>hang-type</engineering-type></col>
</schema>
<row><start id="1" fmt="00:01.000">1000000000</start><duration id="2" fmt="500 ms">500000000</duration><hang-type id="3" fmt="Hang">Hang</hang-type></row>
</node></trace-query-result>`;
    const risksXml = `<?xml version="1.0"?>
<trace-query-result><node><schema name="hang-risks">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>severity</mnemonic><name>Severity</name><engineering-type>short-string</engineering-type></col>
</schema>
<row><time id="1" fmt="00:00:01">1000000000</time><severity id="2" fmt="Hang Risk">Hang Risk</severity></row>
</node></trace-query-result>`;
    const r = analyzeHangsFromXml(
      hangsXml,
      "/fake.trace",
      10,
      0,
      undefined,
      undefined,
      risksXml,
    );
    expect(r.supportStatus.length).toBe(2);
    expect(r.supportStatus[0].kind).toBe("potential-hangs");
    expect(r.supportStatus[1].kind).toBe("hang-risks");
    expect(r.supportStatus[1].status).toBe("available");
  });

  it("legacy status alias is still populated for backwards compat", () => {
    const r = analyzeHangsFromXml(EMPTY_XML, "/fake.trace");
    expect(r.status).toBe("not_present");
    // Both alias and new field should agree.
    expect(r.status).toBe(r.supportStatus[0].status);
  });
});

describe("v1.18 D-01: SUPPORT_STATUS_KINDS open-enum surface", () => {
  it("SUPPORT_STATUS_KINDS includes every kind emitted by the trace analyzers today", () => {
    // The 10 kinds the v1.14/v1.15 analyzers emit. If a new analyzer adds
    // a kind, append to SUPPORT_STATUS_KINDS in src/types.ts and to this list.
    expect(SUPPORT_STATUS_KINDS).toEqual([
      "potential-hangs",
      "hang-risks",
      "animation-hitches",
      "time-profile",
      "allocations",
      "app-launch",
      "network-connections",
      "memory-footprint",
      "energy-impact",
      "leak-events",
    ]);
  });

  it("SupportStatus.kind accepts strings outside SUPPORT_STATUS_KINDS (open-enum)", () => {
    // The whole point of D-01: downstream code authors new kinds (e.g. the
    // v1.18 MetricKit lane) without a memorydetective type bump. The pre-v1.18
    // closed union would fail to type-check this assignment.
    const fake: SupportStatus = {
      kind: "crash-diagnostics",
      status: "available",
    };
    expect(fake.kind).toBe("crash-diagnostics");
  });

  it("known kinds still get inline-literal autocomplete + typo detection", () => {
    // Compile-time intent: assigning a literal that LOOKS LIKE a known kind
    // but is misspelled should still be acceptable at runtime (open enum)
    // but the codebase relies on KnownSupportStatusKind internally to keep
    // typo-safety. Smoke test: every internal kind we emit is in the known list.
    const knownSet = new Set<string>(SUPPORT_STATUS_KINDS);
    for (const kind of [
      "potential-hangs",
      "hang-risks",
      "animation-hitches",
      "time-profile",
      "allocations",
      "app-launch",
      "network-connections",
      "memory-footprint",
      "energy-impact",
      "leak-events",
    ]) {
      expect(knownSet.has(kind)).toBe(true);
    }
  });
});
