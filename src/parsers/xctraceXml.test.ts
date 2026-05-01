import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseXctraceXml, asNumber, asFormatted } from "./xctraceXml.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

describe("parseXctraceXml — potential-hangs fixture", () => {
  const xml = readFileSync(
    resolve(FIXTURES, "example-potential-hangs.xml"),
    "utf8",
  );
  const tables = parseXctraceXml(xml);

  it("parses one table with the right schema", () => {
    expect(tables.length).toBe(1);
    expect(tables[0].schema).toBe("potential-hangs");
  });

  it("parses all expected columns", () => {
    expect(tables[0].columns).toEqual([
      "start",
      "duration",
      "hang-type",
      "thread",
      "process",
    ]);
  });

  it("captures every row in the trace", () => {
    expect(tables[0].rows.length).toBe(35);
  });

  it("resolves id/ref deduplication in subsequent rows", () => {
    const first = tables[0].rows[0];
    const second = tables[0].rows[1];
    expect(first["hang-type"]?.fmt).toBe("Microhang");
    // Row 2 uses ref="3" pointing back at row 1's hang-type. After resolution
    // it should resolve to the same display value.
    expect(second["hang-type"]?.fmt).toBe("Microhang");
  });

  it("parses durations as numeric nanoseconds (raw) plus formatted string", () => {
    const row = tables[0].rows[0];
    const ns = asNumber(row.duration);
    expect(ns).toBeGreaterThan(100_000_000); // > 100ms
    expect(asFormatted(row.duration)).toMatch(/ms$/);
  });

  it("falls back to engineering-type element name when mnemonic differs (start → start-time)", () => {
    const row = tables[0].rows[0];
    const startFmt = asFormatted(row.start);
    expect(startFmt).toBeDefined();
    expect(startFmt).toMatch(/^\d{2}:\d{2}/);
  });

  it("identifies Hang vs Microhang rows", () => {
    const types = tables[0].rows.map((r) => r["hang-type"]?.fmt);
    expect(new Set(types)).toEqual(new Set(["Microhang", "Hang"]));
    const microCount = types.filter((t) => t === "Microhang").length;
    const hangCount = types.filter((t) => t === "Hang").length;
    expect(microCount).toBeGreaterThan(0);
    expect(hangCount).toBeGreaterThan(0);
  });

  it("survives an empty xctrace export gracefully", () => {
    const empty = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'><schema name="potential-hangs"><col><mnemonic>start</mnemonic><name>Start</name><engineering-type>start-time</engineering-type></col></schema></node></trace-query-result>`;
    const out = parseXctraceXml(empty);
    expect(out.length).toBe(1);
    expect(out[0].schema).toBe("potential-hangs");
    expect(out[0].rows.length).toBe(0);
  });
});
