import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  analyzeMetricKitPayload,
  analyzeMetricKitPayloadSchema,
  analyzePayloads,
} from "./analyzeMetricKitPayload.js";
import { parseMetricKitPayload } from "../parsers/metricKit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures/metrickit");

const readFixture = (name: string) =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("analyzeMetricKitPayloadSchema (Zod)", () => {
  it("accepts payloadPath alone", () => {
    const v = analyzeMetricKitPayloadSchema.parse({
      payloadPath: "/tmp/x.mxdiagnostic",
    });
    expect(v.payloadPath).toBe("/tmp/x.mxdiagnostic");
    expect(v.topN).toBe(10);
    expect(v.groupBy).toBe("exception-type");
  });

  it("accepts payloadJson alone", () => {
    const v = analyzeMetricKitPayloadSchema.parse({ payloadJson: "{}" });
    expect(v.payloadJson).toBe("{}");
  });

  it("accepts payloadDir alone", () => {
    const v = analyzeMetricKitPayloadSchema.parse({
      payloadDir: "/tmp/payloads/",
    });
    expect(v.payloadDir).toBe("/tmp/payloads/");
  });

  it("at function call time, throws when zero of the three input forms is provided", async () => {
    const parsed = analyzeMetricKitPayloadSchema.parse({});
    await expect(analyzeMetricKitPayload(parsed)).rejects.toThrow(
      /Provide exactly one of: payloadPath, payloadDir, or payloadJson/,
    );
  });

  it("rejects invalid groupBy values", () => {
    expect(() =>
      analyzeMetricKitPayloadSchema.parse({
        payloadJson: "{}",
        groupBy: "alphabetical" as unknown as "exception-type",
      }),
    ).toThrow();
  });
});

describe("analyzePayloads (pure)", () => {
  it("clusters two crashes with the same exception type into one entry", () => {
    const p = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.crashCluster).toHaveLength(1);
    expect(r.crashCluster[0].occurrences).toBe(2);
    expect(r.crashCluster[0].exceptionType).toBe(1);
    expect(r.crashCluster[0].signal).toBe(11);
    expect(r.crashCluster[0].topFrame).toBe("DemoApp 0x68000");
    // Both builds 456 and 457 should appear in affectedBuilds.
    expect(r.crashCluster[0].affectedBuilds).toEqual(
      expect.arrayContaining(["456", "457"]),
    );
  });

  it("splits same-exception crashes into separate clusters when groupBy=top-frame", () => {
    const json = JSON.stringify({
      crashDiagnostics: [
        {
          version: "1.0.0",
          callStackTree: {
            callStacks: [
              {
                callStackRootFrames: [
                  { binaryName: "DemoApp", offsetIntoBinaryTextSegment: 100 },
                ],
              },
            ],
          },
          diagnosticMetaData: { exceptionType: 1, signal: 11 },
        },
        {
          version: "1.0.0",
          callStackTree: {
            callStacks: [
              {
                callStackRootFrames: [
                  { binaryName: "DemoApp", offsetIntoBinaryTextSegment: 200 },
                ],
              },
            ],
          },
          diagnosticMetaData: { exceptionType: 1, signal: 11 },
        },
      ],
    });
    const p = parseMetricKitPayload(json);
    const r = analyzePayloads([p], { topN: 10, groupBy: "top-frame" });
    expect(r.crashCluster).toHaveLength(2);
  });

  it("hangHotspots ranks by localized hangDuration converted to ms", () => {
    const p = parseMetricKitPayload(
      readFixture("hang-localized-duration.mxdiagnostic"),
    );
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.hangHotspots).toHaveLength(2);
    // 20 seconds (Japanese 秒, falls into seconds default) should rank first.
    expect(r.hangHotspots[0].hangDurationMs).toBe(20_000);
    expect(r.hangHotspots[1].hangDurationMs).toBe(5400);
  });

  it("cpu and disk sections populate from the cpu-and-disk fixture", () => {
    const p = parseMetricKitPayload(readFixture("cpu-and-disk.mxdiagnostic"));
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.cpuExceptions).toHaveLength(1);
    expect(r.cpuExceptions[0].totalCPUTimeMs).toBe(8400);
    expect(r.cpuExceptions[0].cpuExceptionLimit).toBe("80 %");
    expect(r.diskWriteExceptions).toHaveLength(1);
    expect(r.diskWriteExceptions[0].writesCausedMB).toBeCloseTo(1228.8);
  });

  it("aggregates timeStampBegin / timeStampEnd across multiple payloads", () => {
    const p1 = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const p2 = parseMetricKitPayload(
      JSON.stringify({
        timeStampBegin: "2026-05-10T00:00:00Z",
        timeStampEnd: "2026-05-11T00:00:00Z",
      }),
    );
    const r = analyzePayloads([p1, p2], {
      topN: 10,
      groupBy: "exception-type",
    });
    expect(r.timeRange).toBeDefined();
    expect(r.timeRange?.start).toBe("2026-05-10T00:00:00Z");
    expect(r.timeRange?.end).toBe("2026-05-16T10:00:00.000Z");
  });

  it("supportStatus emits all 4 kinds + correct status per section", () => {
    const p = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.supportStatus).toHaveLength(4);
    const kinds = r.supportStatus.map((s) => s.kind);
    expect(kinds).toEqual([
      "crash-diagnostics",
      "hang-diagnostics",
      "cpu-exception-diagnostics",
      "disk-write-exception-diagnostics",
    ]);
    expect(r.supportStatus[0].status).toBe("available"); // crashes present
    expect(r.supportStatus[1].status).toBe("not_present"); // no hangs
  });

  it("supportStatus reports `partial` when one payload has the section and another doesn't", () => {
    const p1 = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const p2 = parseMetricKitPayload(
      readFixture("cpu-and-disk.mxdiagnostic"),
    );
    const r = analyzePayloads([p1, p2], {
      topN: 10,
      groupBy: "exception-type",
    });
    const crashes = r.supportStatus.find((s) => s.kind === "crash-diagnostics");
    expect(crashes?.status).toBe("partial");
  });

  it("diagnosis surfaces the top crash cluster with shorthand label", () => {
    const p = parseMetricKitPayload(
      readFixture("crash-exc-bad-access.mxdiagnostic"),
    );
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.diagnosis).toMatch(/2 crashes clustered on EXC_BAD_ACCESS/);
  });

  it("diagnosis surfaces 5s+ hang as user-visible freeze", () => {
    const p = parseMetricKitPayload(
      readFixture("hang-localized-duration.mxdiagnostic"),
    );
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.diagnosis).toMatch(/20\.0s.*user-visible freeze/);
  });

  it("diagnosis explains empty-result case to the user", () => {
    const p = parseMetricKitPayload(JSON.stringify({}));
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.diagnosis).toMatch(/No actionable diagnostics/);
  });

  it("diagnosis handles zero-payload case (empty dir)", () => {
    const r = analyzePayloads([], { topN: 10, groupBy: "exception-type" });
    expect(r.diagnosis).toMatch(/No MetricKit payloads found/);
    expect(r.diagnosis).toMatch(/simulator does not deliver MetricKit/);
  });

  it("suggestedNextCalls fires findCycles hint when top crash frame looks like retain-cycle release", () => {
    const json = JSON.stringify({
      crashDiagnostics: [
        {
          version: "1.0.0",
          callStackTree: {
            callStacks: [
              {
                callStackRootFrames: [
                  {
                    binaryName: "_objc_release",
                    offsetIntoBinaryTextSegment: 100,
                  },
                ],
              },
            ],
          },
          diagnosticMetaData: { exceptionType: 1, signal: 11 },
        },
      ],
    });
    const p = parseMetricKitPayload(json);
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    expect(r.suggestedNextCalls.length).toBeGreaterThan(0);
    expect(r.suggestedNextCalls[0].tool).toBe("findCycles");
  });

  it("suggestedNextCalls fires analyzeHangs chain hint when top hang frame is db-locked", () => {
    const json = JSON.stringify({
      hangDiagnostics: [
        {
          version: "1.0.0",
          callStackTree: {
            callStacks: [
              {
                callStackRootFrames: [
                  {
                    binaryName: "libsqlite3.dylib",
                    offsetIntoBinaryTextSegment: 16384,
                  },
                ],
              },
            ],
          },
          diagnosticMetaData: { hangDuration: "5.4 sec" },
        },
      ],
    });
    const p = parseMetricKitPayload(json);
    const r = analyzePayloads([p], { topN: 10, groupBy: "exception-type" });
    const hint = r.suggestedNextCalls.find((c) => c.tool === "analyzeHangs");
    expect(hint).toBeDefined();
    expect(hint?.why).toMatch(/db-lock/);
  });
});

describe("analyzeMetricKitPayload (I/O wrapper)", () => {
  it("reads a single .mxdiagnostic file via payloadPath", async () => {
    const r = await analyzeMetricKitPayload(
      analyzeMetricKitPayloadSchema.parse({
        payloadPath: resolve(FIXTURES, "crash-exc-bad-access.mxdiagnostic"),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.payloadCount).toBe(1);
    expect(r.crashCluster).toHaveLength(1);
  });

  it("aggregates a directory of payloads via payloadDir", async () => {
    const r = await analyzeMetricKitPayload(
      analyzeMetricKitPayloadSchema.parse({ payloadDir: FIXTURES }),
    );
    // 4 fixtures in the dir: crash + hang + cpu/disk + future-version
    expect(r.payloadCount).toBe(4);
    expect(r.crashCluster.length).toBeGreaterThan(0);
    expect(r.hangHotspots.length).toBeGreaterThan(0);
    expect(r.cpuExceptions.length).toBeGreaterThan(0);
    expect(r.diskWriteExceptions.length).toBeGreaterThan(0);
  });

  it("accepts payloadJson directly (no filesystem)", async () => {
    const r = await analyzeMetricKitPayload(
      analyzeMetricKitPayloadSchema.parse({
        payloadJson: readFixture("cpu-and-disk.mxdiagnostic"),
      }),
    );
    expect(r.cpuExceptions).toHaveLength(1);
  });

  it("throws when payloadPath does not exist", async () => {
    await expect(
      analyzeMetricKitPayload(
        analyzeMetricKitPayloadSchema.parse({
          payloadPath: "/tmp/__does-not-exist__.mxdiagnostic",
        }),
      ),
    ).rejects.toThrow(/not found/);
  });
});
