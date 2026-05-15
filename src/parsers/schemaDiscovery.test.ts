import { describe, it, expect } from "vitest";
import {
  CANONICAL_SCHEMA_NAME,
  SCHEMA_FAMILIES,
  discoverSchema,
  discoverSchemas,
  extractSchemaNamesFromToc,
} from "./schemaDiscovery.js";

const APPLE_REAL_TOC = `<?xml version="1.0"?>
<trace-toc>
  <run>
    <data>
      <table schema="tick" frequency="1"/>
      <table schema="potential-hangs" target-pid="SINGLE" hangs-threshold="250"/>
      <table schema="hang-risks" target-pid="SINGLE"/>
      <table schema="time-profile" target-pid="SINGLE" needs-kernel-callstack="0"/>
      <table schema="time-sample" sample-rate-micro-seconds="1000"/>
      <table schema="process-info"/>
    </data>
  </run>
</trace-toc>`;

const OPEN_CLOSE_TOC = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <run>
      <data>
        <table schema="animation-hitches">
          <row><start>1</start></row>
        </table>
        <table schema="allocations"></table>
      </data>
    </run>
  </node>
</trace-query-result>`;

describe("extractSchemaNamesFromToc", () => {
  it("returns self-closing schema names in document order", () => {
    const names = extractSchemaNamesFromToc(APPLE_REAL_TOC);
    expect(names).toEqual([
      "tick",
      "potential-hangs",
      "hang-risks",
      "time-profile",
      "time-sample",
      "process-info",
    ]);
  });

  it("returns open-close schema names too", () => {
    const names = extractSchemaNamesFromToc(OPEN_CLOSE_TOC);
    expect(names).toContain("animation-hitches");
    expect(names).toContain("allocations");
  });

  it("returns empty array on malformed XML", () => {
    expect(extractSchemaNamesFromToc("<garbage>not xml</garbage>")).toEqual([]);
  });
});

describe("discoverSchema", () => {
  it("matches `hangs` family to the real Apple potential-hangs name", () => {
    expect(discoverSchema(APPLE_REAL_TOC, "hangs")).toBe("potential-hangs");
  });

  it("matches `hang-risks` family separately from `hangs`", () => {
    expect(discoverSchema(APPLE_REAL_TOC, "hang-risks")).toBe("hang-risks");
  });

  it("matches `time-profile` exactly (does not slurp `time-sample`)", () => {
    // Both schemas are present in the TOC; the time-profile pattern should
    // match the exact name only.
    expect(discoverSchema(APPLE_REAL_TOC, "time-profile")).toBe("time-profile");
    expect(discoverSchema(APPLE_REAL_TOC, "time-sample")).toBe("time-sample");
  });

  it("returns the canonical hardcoded name when nothing in the TOC matches", () => {
    const tocWithoutHitches = `<trace-toc><run><data><table schema="tick"/></data></run></trace-toc>`;
    expect(discoverSchema(tocWithoutHitches, "animation-hitches")).toBe(
      CANONICAL_SCHEMA_NAME["animation-hitches"],
    );
    expect(discoverSchema(tocWithoutHitches, "network")).toBe(
      CANONICAL_SCHEMA_NAME.network,
    );
  });

  it("handles a renamed schema (forward compatibility)", () => {
    // Hypothetical future Xcode rename: `potential-hangs` -> `hangs`.
    // Without discovery the hardcoded xpath returns nothing; with
    // discovery the regex matches the new name and the analyzer works.
    const tocRenamed = `<trace-toc><run><data><table schema="hangs" target-pid="SINGLE"/></data></run></trace-toc>`;
    // `hangs` family regex matches /potential-hangs/i; the simpler
    // `hangs` schema name does NOT match this pattern, so this test
    // documents the bound of our current pattern (we deliberately stay
    // conservative to avoid false positives on unrelated schemas).
    expect(discoverSchema(tocRenamed, "hangs")).toBe(
      CANONICAL_SCHEMA_NAME.hangs,
    );
  });

  it("matches the broader `allocations` pattern against `malloc-allocations`", () => {
    const tocMalloc = `<trace-toc><run><data><table schema="malloc-allocations"/></data></run></trace-toc>`;
    expect(discoverSchema(tocMalloc, "allocations")).toBe("malloc-allocations");
  });

  it("network family matches multiple plausible names", () => {
    const tocNet1 = `<trace-toc><run><data><table schema="network-connections"/></data></run></trace-toc>`;
    expect(discoverSchema(tocNet1, "network")).toBe("network-connections");
    const tocNet2 = `<trace-toc><run><data><table schema="http-transactions"/></data></run></trace-toc>`;
    expect(discoverSchema(tocNet2, "network")).toBe("http-transactions");
  });

  it("first match wins on document order when multiple schemas could match", () => {
    const tocPriority = `<trace-toc><run><data>
      <table schema="memory-footprint"/>
      <table schema="resident-memory"/>
      <table schema="vm-regions"/>
    </data></run></trace-toc>`;
    expect(discoverSchema(tocPriority, "memory")).toBe("memory-footprint");
  });
});

describe("discoverSchemas (bulk)", () => {
  it("resolves multiple families in one pass against the same TOC", () => {
    const out = discoverSchemas(APPLE_REAL_TOC, [
      "hangs",
      "hang-risks",
      "time-profile",
    ] as const);
    expect(out).toEqual({
      hangs: "potential-hangs",
      "hang-risks": "hang-risks",
      "time-profile": "time-profile",
    });
  });

  it("falls back per-family when nothing matches", () => {
    const empty = `<trace-toc><run><data/></run></trace-toc>`;
    const out = discoverSchemas(empty, ["hangs", "network"] as const);
    expect(out).toEqual({
      hangs: CANONICAL_SCHEMA_NAME.hangs,
      network: CANONICAL_SCHEMA_NAME.network,
    });
  });
});

describe("SCHEMA_FAMILIES + CANONICAL_SCHEMA_NAME consistency", () => {
  it("every family in SCHEMA_FAMILIES has a canonical name", () => {
    for (const family of Object.keys(SCHEMA_FAMILIES)) {
      expect(CANONICAL_SCHEMA_NAME).toHaveProperty(family);
    }
  });

  it("every canonical name matches its own family pattern (self-consistency)", () => {
    for (const [family, canonical] of Object.entries(CANONICAL_SCHEMA_NAME)) {
      const patterns =
        SCHEMA_FAMILIES[family as keyof typeof SCHEMA_FAMILIES];
      const matched = patterns.some((p) => p.test(canonical));
      expect(matched, `${canonical} should match its own family pattern`).toBe(
        true,
      );
    }
  });
});
