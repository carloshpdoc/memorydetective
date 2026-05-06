import { describe, it, expect } from "vitest";
import {
  centerOf,
  findElementByLabel,
  parseAxeDescribeUI,
  parseAxFrame,
  type UIElement,
} from "./axe.js";

describe("parseAxFrame", () => {
  it("parses CGRect-style frame strings", () => {
    expect(
      parseAxFrame({ AXFrame: "{{10, 20}, {30, 40}}" }),
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("parses AppKit-style nested dictionary frames", () => {
    expect(
      parseAxFrame({
        frame: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("parses AX-prefixed nested dictionary frames", () => {
    expect(
      parseAxFrame({
        AXFrame: { AXX: 5, AXY: 6, AXWidth: 7, AXHeight: 8 },
      }),
    ).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("returns undefined when no frame data is present", () => {
    expect(parseAxFrame({ label: "no frame" })).toBeUndefined();
  });

  it("handles negative coordinates and floats", () => {
    expect(parseAxFrame({ AXFrame: "{{-1.5, -2.5}, {10.25, 20.75}}" })).toEqual(
      { x: -1.5, y: -2.5, width: 10.25, height: 20.75 },
    );
  });
});

describe("centerOf", () => {
  it("returns the center of a frame, rounded", () => {
    expect(centerOf({ x: 0, y: 0, width: 100, height: 50 })).toEqual({
      x: 50,
      y: 25,
    });
  });

  it("rounds half-pixel coordinates", () => {
    expect(centerOf({ x: 10, y: 10, width: 11, height: 11 })).toEqual({
      x: 16,
      y: 16,
    });
  });
});

describe("findElementByLabel", () => {
  const tree: UIElement = {
    label: "root",
    children: [
      { label: "TabBar", children: [{ label: "Explore" }, { label: "Profile" }] },
      { identifier: "explore-btn", children: [] },
    ],
  };

  it("finds an element by exact label match", () => {
    expect(findElementByLabel(tree, "Explore")?.label).toBe("Explore");
  });

  it("finds an element by exact identifier match", () => {
    expect(findElementByLabel(tree, "explore-btn")?.identifier).toBe(
      "explore-btn",
    );
  });

  it("falls back to substring match when exact fails", () => {
    expect(findElementByLabel(tree, "Profil")?.label).toBe("Profile");
  });

  it("returns null when no match found", () => {
    expect(findElementByLabel(tree, "Missing")).toBeNull();
  });

  it("walks deeply nested children", () => {
    const deep: UIElement = {
      children: [
        {
          children: [
            { children: [{ label: "Deep" }] },
          ],
        },
      ],
    };
    expect(findElementByLabel(deep, "Deep")?.label).toBe("Deep");
  });
});

describe("parseAxeDescribeUI", () => {
  it("parses a simple axe describe-ui JSON", () => {
    const json = JSON.stringify({
      AXLabel: "App",
      AXFrame: "{{0, 0}, {390, 844}}",
      children: [
        {
          AXLabel: "Tab",
          AXFrame: { x: 0, y: 800, width: 390, height: 44 },
          AXIdentifier: "tab-explore",
        },
      ],
    });
    const tree = parseAxeDescribeUI(json);
    expect(tree.label).toBe("App");
    expect(tree.frame).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(tree.children?.length).toBe(1);
    expect(tree.children?.[0].identifier).toBe("tab-explore");
    expect(tree.children?.[0].frame).toEqual({
      x: 0,
      y: 800,
      width: 390,
      height: 44,
    });
  });

  it("tolerates leading and trailing noise around the JSON", () => {
    const json = JSON.stringify({ AXLabel: "Root" });
    const stdout = `info: querying simulator\n${json}\nlog: done\n`;
    expect(parseAxeDescribeUI(stdout).label).toBe("Root");
  });

  it("throws when no JSON value is present", () => {
    expect(() => parseAxeDescribeUI("just a log line")).toThrow(
      /did not contain a JSON/,
    );
  });

  it("throws on malformed JSON", () => {
    expect(() => parseAxeDescribeUI("{ not valid json }")).toThrow(
      /JSON.parse/,
    );
  });
});
