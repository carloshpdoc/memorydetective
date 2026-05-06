import { describe, it, expect } from "vitest";
import {
  captureScenarioStateSchema,
  sanitizeLabel,
} from "./captureScenarioState.js";

describe("captureScenarioState schema", () => {
  it("accepts a valid input with pid", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      pid: 12345,
      outputDir: "/tmp/snapshots",
      label: "before",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid input with appName", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      appName: "DemoApp",
      outputDir: "/tmp/snapshots",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when neither pid nor appName given", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      outputDir: "/tmp/snapshots",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when both pid and appName given", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      pid: 12345,
      appName: "DemoApp",
      outputDir: "/tmp/snapshots",
    });
    expect(r.success).toBe(false);
  });

  it("applies default label and include array", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      pid: 12345,
      outputDir: "/tmp/snapshots",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.label).toBe("snapshot");
    expect(r.data.include).toEqual(["memgraph", "screenshot", "uiTree"]);
  });

  it("accepts a custom include subset", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      pid: 12345,
      outputDir: "/tmp/snapshots",
      include: ["memgraph", "screenshot"],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.include).toEqual(["memgraph", "screenshot"]);
  });

  it("rejects unknown include kinds", () => {
    const r = captureScenarioStateSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      pid: 12345,
      outputDir: "/tmp/snapshots",
      include: ["memgraph", "logs"],
    });
    expect(r.success).toBe(false);
  });
});

describe("sanitizeLabel", () => {
  it("keeps simple labels intact", () => {
    expect(sanitizeLabel("before")).toBe("before");
    expect(sanitizeLabel("after-fix")).toBe("after-fix");
  });

  it("replaces unsafe characters with dashes", () => {
    expect(sanitizeLabel("path/to:file")).toBe("path-to-file");
    expect(sanitizeLabel('weird "name" *')).toBe("weird-name");
  });

  it("collapses runs of whitespace", () => {
    expect(sanitizeLabel("two   spaces")).toBe("two-spaces");
  });

  it("trims leading/trailing dashes", () => {
    expect(sanitizeLabel("--ok--")).toBe("ok");
  });

  it("falls back to 'snapshot' when result is empty", () => {
    expect(sanitizeLabel("///")).toBe("snapshot");
  });

  it("clamps length to 64 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeLabel(long).length).toBeLessThanOrEqual(64);
  });
});
