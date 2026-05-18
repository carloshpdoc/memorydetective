import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseMetricKitPayload,
  extractTopFrameLabel,
  extractLeadingNumber,
  metricKitTimeToMs,
  metricKitDiskToMB,
} from "./metricKit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures/metrickit");

const readFixture = (name: string) =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("parseMetricKitPayload", () => {
  it("parses crash diagnostics with full metadata", () => {
    const payload = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    expect(payload.crashDiagnostics).toHaveLength(2);
    expect(payload.hangDiagnostics).toHaveLength(0);
    expect(payload.timeStampBegin).toBe("2026-05-15T10:00:00.000Z");
    const first = payload.crashDiagnostics[0];
    expect(first.version).toBe("1.0.0");
    expect(first.diagnosticMetaData.signal).toBe(11);
    expect(first.diagnosticMetaData.appBuildVersion).toBe("456");
  });

  it("parses hang diagnostics with localized duration strings", () => {
    const payload = parseMetricKitPayload(
      readFixture("hang-localized-duration.mxdiagnostic"),
    );
    expect(payload.hangDiagnostics).toHaveLength(2);
    expect(payload.hangDiagnostics[0].diagnosticMetaData.hangDuration).toBe(
      "5.4 sec",
    );
    expect(payload.hangDiagnostics[1].diagnosticMetaData.hangDuration).toBe(
      "20秒",
    );
  });

  it("parses cpu + disk exceptions in the same payload", () => {
    const payload = parseMetricKitPayload(
      readFixture("cpu-and-disk.mxdiagnostic"),
    );
    expect(payload.cpuExceptionDiagnostics).toHaveLength(1);
    expect(payload.diskWriteExceptionDiagnostics).toHaveLength(1);
    expect(
      payload.cpuExceptionDiagnostics[0].diagnosticMetaData.totalCPUTime,
    ).toBe("8.4 sec");
    expect(
      payload.diskWriteExceptionDiagnostics[0].diagnosticMetaData.writesCaused,
    ).toBe("1.2 GB");
  });

  it("tolerates future schema versions + unknown top-level keys", () => {
    const payload = parseMetricKitPayload(
      readFixture("empty-and-future-version.mxdiagnostic"),
    );
    expect(payload.crashDiagnostics[0].version).toBe("2.0.0");
    // futureField is preserved in diagnosticMetaData (it's a record).
    expect(payload.crashDiagnostics[0].diagnosticMetaData.futureField).toBe(
      "we should not crash on unknown keys",
    );
    // Empty stack does not throw, just returns an empty frames array.
    expect(
      payload.crashDiagnostics[0].callStackTree.callStacks[0]
        .callStackRootFrames,
    ).toEqual([]);
  });

  it("defaults missing diagnostic arrays to empty (does not throw)", () => {
    const payload = parseMetricKitPayload(JSON.stringify({}));
    expect(payload.crashDiagnostics).toEqual([]);
    expect(payload.hangDiagnostics).toEqual([]);
    expect(payload.cpuExceptionDiagnostics).toEqual([]);
    expect(payload.diskWriteExceptionDiagnostics).toEqual([]);
  });

  it("throws on invalid JSON (not on shape mismatch)", () => {
    expect(() => parseMetricKitPayload("{not json")).toThrow(
      /Failed to parse \.mxdiagnostic as JSON/,
    );
  });

  it("throws on a top-level array (must be object)", () => {
    expect(() => parseMetricKitPayload("[]")).toThrow(
      /top-level to be a JSON object/,
    );
  });
});

describe("extractTopFrameLabel", () => {
  it("returns binaryName + hex offset for the deepest-root frame", () => {
    const payload = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const label = extractTopFrameLabel(payload.crashDiagnostics[0]);
    // 425984 = 0x68000
    expect(label).toBe("DemoApp 0x68000");
  });

  it("returns <unknown> for a diagnostic with no frames", () => {
    const payload = parseMetricKitPayload(
      readFixture("empty-and-future-version.mxdiagnostic"),
    );
    expect(extractTopFrameLabel(payload.crashDiagnostics[0])).toBe(
      "<unknown>",
    );
  });

  it("returns just the binary name when offset is missing", () => {
    const payload = parseMetricKitPayload(
      JSON.stringify({
        crashDiagnostics: [
          {
            version: "1.0.0",
            callStackTree: {
              callStacks: [
                {
                  callStackRootFrames: [{ binaryName: "DemoApp" }],
                },
              ],
            },
            diagnosticMetaData: {},
          },
        ],
      }),
    );
    expect(extractTopFrameLabel(payload.crashDiagnostics[0])).toBe("DemoApp");
  });
});

describe("extractLeadingNumber + unit conversions", () => {
  it("extracts decimal from a typical English string", () => {
    expect(extractLeadingNumber("5.4 sec")).toBe(5.4);
  });

  it("extracts integer from a Japanese-localized string", () => {
    expect(extractLeadingNumber("20秒")).toBe(20);
  });

  it("handles negative values and edge whitespace", () => {
    expect(extractLeadingNumber("-12.5%")).toBe(-12.5);
    expect(extractLeadingNumber("  42 MB  ")).toBe(42);
  });

  it("returns undefined when no number is present", () => {
    expect(extractLeadingNumber("n/a")).toBeUndefined();
    expect(extractLeadingNumber("")).toBeUndefined();
  });

  it("metricKitTimeToMs converts sec / ms / min units, defaults to seconds", () => {
    expect(metricKitTimeToMs("5.4 sec")).toBe(5400);
    expect(metricKitTimeToMs("500 ms")).toBe(500);
    expect(metricKitTimeToMs("2 min")).toBe(120_000);
    // 20 with no parseable unit -> default sec (matches Japanese 秒 case)
    expect(metricKitTimeToMs("20秒")).toBe(20_000);
  });

  it("metricKitDiskToMB converts GB / MB / KB, defaults to MB", () => {
    expect(metricKitDiskToMB("1.2 GB")).toBeCloseTo(1228.8);
    expect(metricKitDiskToMB("500 MB")).toBe(500);
    expect(metricKitDiskToMB("2048 KB")).toBe(2);
    expect(metricKitDiskToMB("12 mb")).toBe(12);
  });
});
