import { describe, it, expect } from "vitest";
import {
  formatMcpResponse,
  renderAsMarkdown,
  renderVerifyFixTable,
} from "./responseFormatter.js";

describe("formatMcpResponse", () => {
  it("returns single JSON content by default", () => {
    const response = formatMcpResponse({ ok: true, value: 42 }, "demo", undefined);
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe("text");
    expect(JSON.parse(response.content[0].text)).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("returns single JSON content when outputFormat is 'json'", () => {
    const response = formatMcpResponse({ a: 1 }, "demo", "json");
    expect(response.content.length).toBe(1);
    expect(JSON.parse(response.content[0].text)).toEqual({ a: 1 });
  });

  it("returns single markdown content when outputFormat is 'markdown'", () => {
    const response = formatMcpResponse({ a: 1 }, "demo", "markdown");
    expect(response.content.length).toBe(1);
    expect(response.content[0].text).toContain("# demo");
    expect(response.content[0].text).toContain("## a");
  });

  it("returns markdown FIRST then JSON when outputFormat is 'both'", () => {
    const response = formatMcpResponse({ a: 1 }, "demo", "both");
    expect(response.content.length).toBe(2);
    expect(response.content[0].text).toContain("# demo");
    expect(JSON.parse(response.content[1].text)).toEqual({ a: 1 });
  });
});

describe("renderAsMarkdown", () => {
  it("emits the tool name as an H1 header", () => {
    const md = renderAsMarkdown({}, "analyzeFoo");
    expect(md).toMatch(/^# analyzeFoo/);
  });

  it("emits a H2 per top-level field", () => {
    const md = renderAsMarkdown({ foo: 1, bar: "hello" }, "x");
    expect(md).toMatch(/## foo/);
    expect(md).toMatch(/## bar/);
  });

  it("renders an array of uniform objects as a markdown table", () => {
    const md = renderAsMarkdown(
      {
        rows: [
          { className: "A", count: 10 },
          { className: "B", count: 5 },
        ],
      },
      "demo",
    );
    expect(md).toMatch(/\| className \| count \|/);
    expect(md).toMatch(/\| A \| `10` \|/);
    expect(md).toMatch(/\| B \| `5` \|/);
  });

  it("renders array of scalars as a bullet list", () => {
    const md = renderAsMarkdown({ items: [1, 2, 3] }, "demo");
    expect(md).toMatch(/^- `1`/m);
    expect(md).toMatch(/^- `2`/m);
    expect(md).toMatch(/^- `3`/m);
  });

  it("renders nested object as bullet list of fields", () => {
    const md = renderAsMarkdown(
      { totals: { hangs: 3, microhangs: 7 } },
      "demo",
    );
    expect(md).toMatch(/- \*\*hangs\*\*:/);
    expect(md).toMatch(/- \*\*microhangs\*\*:/);
  });

  it("handles empty arrays explicitly", () => {
    const md = renderAsMarkdown({ list: [] }, "demo");
    expect(md).toMatch(/_\(empty array\)_/);
  });

  it("handles null and undefined gracefully without crashing", () => {
    const md = renderAsMarkdown({ x: null, y: undefined }, "demo");
    expect(md).toContain("## x");
    expect(md).toContain("## y");
    expect(md).toMatch(/_\(null\)_/);
  });

  it("truncates long table cells to stay readable", () => {
    const longValue = "a".repeat(200);
    const md = renderAsMarkdown(
      { rows: [{ name: longValue, ok: true }] },
      "demo",
    );
    expect(md).toMatch(/a{77}\.\.\./);
    expect(md).not.toMatch(/a{100}/);
  });

  it("collapses deeply nested objects to inline JSON", () => {
    const md = renderAsMarkdown(
      {
        outer: {
          middle: {
            inner: { deep: { value: 1 } },
          },
        },
      },
      "demo",
    );
    expect(md).toContain("```json");
  });

  it("table has a separator row when columns are detected", () => {
    const md = renderAsMarkdown(
      { rows: [{ a: 1 }, { a: 2 }] },
      "demo",
    );
    expect(md).toMatch(/\| --- \|/);
  });
});

describe("renderVerifyFixTable (v1.10)", () => {
  it("returns null for tools other than analyzeAbandonedMemory", () => {
    expect(renderVerifyFixTable({}, "diffMemgraphs")).toBeNull();
    expect(renderVerifyFixTable({}, "analyzeMemgraph")).toBeNull();
  });

  it("renders the actionableShrinkage table for the notelet-shape result", () => {
    const result = {
      diagnosis: "AVPlayerItem dropped 342 to 0; KVO observer-orphan fixed.",
      actionableShrinkage: [
        { className: "AVPlayerItem", beforeCount: 342, afterCount: 0, delta: -342 },
        { className: "AVPlayerInternal", beforeCount: 297, afterCount: 0, delta: -297 },
      ],
      actionableGrowth: [],
    };
    const md = renderVerifyFixTable(result, "analyzeAbandonedMemory");
    expect(md).toContain("# analyzeAbandonedMemory: verify-fix");
    expect(md).toContain("## What the fix freed");
    expect(md).toContain("| `AVPlayerItem` | 342 | 0 | -342 |");
    expect(md).toContain("| `AVPlayerInternal` | 297 | 0 | -297 |");
    expect(md).toContain("> AVPlayerItem dropped 342 to 0");
  });

  it("filters rows whose |delta| is below the actionable threshold (10)", () => {
    const result = {
      actionableShrinkage: [
        { className: "Big", beforeCount: 100, afterCount: 0, delta: -100 },
        { className: "Small", beforeCount: 5, afterCount: 0, delta: -5 },
      ],
      actionableGrowth: [],
    };
    const md = renderVerifyFixTable(result, "analyzeAbandonedMemory");
    expect(md).toContain("`Big`");
    expect(md).not.toContain("`Small`");
  });

  it("renders both shrinkage and growth sections when both exist", () => {
    const result = {
      actionableShrinkage: [
        { className: "FixedClass", beforeCount: 100, afterCount: 0, delta: -100 },
      ],
      actionableGrowth: [
        { className: "NewLeak", beforeCount: 0, afterCount: 50, delta: 50 },
      ],
    };
    const md = renderVerifyFixTable(result, "analyzeAbandonedMemory");
    expect(md).toContain("## What the fix freed");
    expect(md).toContain("## Classes that grew (regressions or unrelated)");
    expect(md).toContain("`FixedClass`");
    expect(md).toContain("`NewLeak`");
    // Growth row uses +N delta sign.
    expect(md).toContain("| +50 |");
  });

  it("returns an empty-message when no actionable rows cross the threshold", () => {
    const result = {
      diagnosis: "Nothing changed in this run.",
      actionableShrinkage: [],
      actionableGrowth: [],
    };
    const md = renderVerifyFixTable(result, "analyzeAbandonedMemory");
    expect(md).toContain("No class counts crossed the actionable threshold");
    expect(md).toContain("> Nothing changed in this run.");
  });

  it("formatMcpResponse(verify-fix-table) routes to the focused renderer", () => {
    const result = {
      actionableShrinkage: [
        { className: "AVPlayerItem", beforeCount: 342, afterCount: 0, delta: -342 },
      ],
      actionableGrowth: [],
    };
    const resp = formatMcpResponse(result, "analyzeAbandonedMemory", "verify-fix-table");
    expect(resp.content).toHaveLength(1);
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("## What the fix freed");
    expect(text).toContain("`AVPlayerItem`");
  });

  it("formatMcpResponse(verify-fix-table) falls back to markdown for other tools", () => {
    const resp = formatMcpResponse({ ok: true }, "analyzeMemgraph", "verify-fix-table");
    expect(resp.content).toHaveLength(1);
    const text = (resp.content[0] as { text: string }).text;
    // Generic markdown header for the tool.
    expect(text).toContain("# analyzeMemgraph");
  });
});
