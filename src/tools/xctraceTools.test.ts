import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { analyzeHangsFromXml } from "./analyzeHangs.js";
import { analyzeTimeProfileFromXml } from "./analyzeTimeProfile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const hangsXml = readFileSync(
  resolve(FIXTURES, "example-potential-hangs.xml"),
  "utf8",
);

describe("analyzeHangsFromXml", () => {
  it("aggregates totals from real fixture", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.ok).toBe(true);
    expect(result.totals.rows).toBe(35);
    expect(result.totals.hangs).toBeGreaterThan(0);
    expect(result.totals.microhangs).toBeGreaterThan(0);
    expect(result.totals.longestMs).toBeGreaterThan(500);
  });

  it("sorts top entries by duration desc", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 5);
    expect(result.top.length).toBe(5);
    for (let i = 0; i + 1 < result.top.length; i++) {
      expect(result.top[i].durationMs).toBeGreaterThanOrEqual(
        result.top[i + 1].durationMs,
      );
    }
  });

  it("filters by minDurationMs", () => {
    const noFilter = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 0);
    const filtered = analyzeHangsFromXml(hangsXml, "/fake/run.trace", 100, 500);
    expect(filtered.totals.rows).toBeLessThan(noFilter.totals.rows);
    for (const e of filtered.top) {
      expect(e.durationMs).toBeGreaterThanOrEqual(500);
    }
  });

  it("produces a diagnosis string", () => {
    const result = analyzeHangsFromXml(hangsXml, "/fake/run.trace");
    expect(result.diagnosis).toMatch(/hangs total/);
  });

  it("returns a clean empty result when no rows match", () => {
    const result = analyzeHangsFromXml(
      hangsXml,
      "/fake/run.trace",
      10,
      999_999,
    );
    expect(result.totals.rows).toBe(0);
    expect(result.top).toEqual([]);
    expect(result.diagnosis).toContain("No hangs detected");
  });
});

describe("analyzeTimeProfileFromXml", () => {
  it("returns a clean empty result when no time-profile table is present", () => {
    // The hangs fixture deliberately does not contain a time-profile schema.
    const result = analyzeTimeProfileFromXml(hangsXml, "/fake/run.trace");
    expect(result.ok).toBe(true);
    expect(result.totalSamples).toBe(0);
    expect(result.diagnosis).toMatch(/No time-profile/);
  });

  it("parses a synthetic time-profile XML", () => {
    const synthetic = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="time-profile">
<col><mnemonic>weight</mnemonic><name>Weight</name></col>
<col><mnemonic>symbol</mnemonic><name>Symbol</name></col>
<col><mnemonic>thread</mnemonic><name>Thread</name></col>
</schema>
<row><weight fmt="42 ms">42</weight><symbol fmt="MyApp.foo()">MyApp.foo()</symbol><thread fmt="Main"/></row>
<row><weight fmt="42 ms">42</weight><symbol fmt="MyApp.foo()">MyApp.foo()</symbol><thread fmt="Main"/></row>
<row><weight fmt="11 ms">11</weight><symbol fmt="MyApp.bar()">MyApp.bar()</symbol><thread fmt="Main"/></row>
</node></trace-query-result>`;
    const result = analyzeTimeProfileFromXml(synthetic, "/fake/run.trace");
    expect(result.totalSamples).toBe(3);
    expect(result.topSymbols[0]).toEqual({
      symbol: "MyApp.foo()",
      samples: 2,
    });
  });
});
