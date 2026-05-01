import { describe, it, expect } from "vitest";
import { parseDeviceListing } from "./listTraceDevices.js";
import { parseTemplateListing } from "./listTraceTemplates.js";
import {
  buildXctraceArgs,
  recordTimeProfileSchema,
} from "./recordTimeProfile.js";
import { captureMemgraphSchema } from "./captureMemgraph.js";

describe("parseDeviceListing", () => {
  it("groups devices, simulators, and offline devices", () => {
    const sample = `== Devices ==
MacBook Pro (D283C622-DE11-5668-8E1F-E6234E85E6C8)
iPhone 17 Pro Max (26.3.1) (00008150-001E449E1E99401C)

== Devices Offline ==
Apple Watch (26.3) (00008310-0005701C0E80E01E)

== Simulators ==
iPhone 11 Simulator (26.2) (4A78B3ED-E522-47D2-85BB-1B8869DEFFC1)
iPhone 17 Simulator (26.2) (0F4D5D74-A4FE-4261-9596-8073565E7927)`;
    const out = parseDeviceListing(sample);
    expect(out.length).toBe(5);
    expect(out.find((d) => d.kind === "device" && d.osVersion === "26.3.1"))
      .toBeDefined();
    expect(out.filter((d) => d.kind === "simulator").length).toBe(2);
    expect(out.filter((d) => d.kind === "device-offline").length).toBe(1);
    const phys = out.find((d) =>
      d.name.startsWith("iPhone 17 Pro Max"),
    );
    expect(phys?.udid).toBe("00008150-001E449E1E99401C");
  });

  it("handles devices without OS version (host Mac)", () => {
    const sample = `== Devices ==
Mac Studio (D283C622-DE11-5668-8E1F-E6234E85E6C8)`;
    const out = parseDeviceListing(sample);
    expect(out.length).toBe(1);
    expect(out[0].osVersion).toBeUndefined();
  });
});

describe("parseTemplateListing", () => {
  it("collects standard template names", () => {
    const sample = `== Standard Templates ==
Activity Monitor
Allocations
Animation Hitches
Time Profiler
== Custom Templates ==
My Custom Template`;
    const out = parseTemplateListing(sample);
    expect(out.length).toBe(5);
    expect(out.filter((t) => t.category === "standard").length).toBe(4);
    expect(out.find((t) => t.name === "Time Profiler")?.category).toBe(
      "standard",
    );
    expect(out.find((t) => t.name === "My Custom Template")?.category).toBe(
      "custom",
    );
  });
});

describe("recordTimeProfile schema validation", () => {
  it("rejects missing target (no deviceId or simulatorId)", () => {
    const r = recordTimeProfileSchema.safeParse({
      attachAppName: "DemoApp",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing both deviceId and simulatorId", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      simulatorId: "4A78B3ED-E522-47D2-85BB-1B8869DEFFC1",
      attachAppName: "DemoApp",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing zero attach options", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects providing two attach options", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      attachPid: 123,
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("rejects output not ending in .trace", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      output: "/tmp/foo.txt",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid input and produces correct argv", () => {
    const r = recordTimeProfileSchema.safeParse({
      deviceId: "00008150-001E449E1E99401C",
      attachAppName: "DemoApp",
      durationSec: 90,
      output: "/tmp/run.trace",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const args = buildXctraceArgs(r.data);
    expect(args).toContain("--template");
    expect(args).toContain("Time Profiler");
    expect(args).toContain("--device");
    expect(args).toContain("00008150-001E449E1E99401C");
    expect(args).toContain("--attach");
    expect(args).toContain("DemoApp");
    expect(args).toContain("--time-limit");
    expect(args).toContain("90s");
    expect(args).toContain("--output");
    expect(args).toContain("/tmp/run.trace");
  });
});

describe("captureMemgraph schema validation", () => {
  it("rejects when neither pid nor appName given", () => {
    const r = captureMemgraphSchema.safeParse({ output: "/tmp/foo.memgraph" });
    expect(r.success).toBe(false);
  });

  it("rejects when both pid and appName given", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      appName: "DemoApp",
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(false);
  });

  it("rejects output not ending in .memgraph", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      output: "/tmp/foo.trace",
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid input with pid", () => {
    const r = captureMemgraphSchema.safeParse({
      pid: 123,
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(true);
  });

  it("accepts valid input with appName", () => {
    const r = captureMemgraphSchema.safeParse({
      appName: "DemoApp",
      output: "/tmp/foo.memgraph",
    });
    expect(r.success).toBe(true);
  });
});
