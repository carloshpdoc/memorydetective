import { describe, it, expect } from "vitest";
import {
  replayScenarioSchema,
  resolveTapTarget,
} from "./replayScenario.js";

describe("replayScenario schema", () => {
  it("accepts a minimal valid input", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [{ type: "tap", label: "Explore" }],
    });
    expect(r.success).toBe(true);
  });

  it("requires at least one action", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [],
    });
    expect(r.success).toBe(false);
  });

  it("applies repeat default of 1 and settle default of 500ms", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [{ type: "tap", coords: [10, 20] }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.repeat).toBe(1);
    expect(r.data.settleBetweenActionsMs).toBe(500);
  });

  it("clamps repeat upper bound", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [{ type: "tap", coords: [10, 20] }],
      repeat: 9999,
    });
    expect(r.success).toBe(false);
  });

  it("accepts swipe, wait, and type actions", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [
        { type: "swipe", from: [0, 0], to: [100, 100] },
        { type: "wait", seconds: 2 },
        { type: "type", text: "hello" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects swipe with non-tuple coordinates", () => {
    const r = replayScenarioSchema.safeParse({
      simulatorUDID: "AAAA-1111",
      actions: [
        {
          type: "swipe",
          from: [0],
          to: [100, 100],
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("resolveTapTarget", () => {
  it("converts label-only input to TapTarget", () => {
    expect(resolveTapTarget({ label: "Explore" })).toEqual({
      kind: "label",
      value: "Explore",
    });
  });

  it("converts elementId-only input to TapTarget", () => {
    expect(resolveTapTarget({ elementId: "explore-btn" })).toEqual({
      kind: "elementId",
      value: "explore-btn",
    });
  });

  it("converts coords-only input to TapTarget", () => {
    expect(resolveTapTarget({ coords: [50, 100] })).toEqual({
      kind: "coords",
      x: 50,
      y: 100,
    });
  });

  it("throws when no target provided", () => {
    expect(() => resolveTapTarget({})).toThrow(/exactly one of/);
  });

  it("throws when multiple targets provided", () => {
    expect(() =>
      resolveTapTarget({ label: "Explore", coords: [10, 20] }),
    ).toThrow(/exactly one of/);
  });
});
