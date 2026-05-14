/**
 * Shared response formatter for MCP tool outputs.
 *
 * Tools can declare `outputFormat?: "markdown" | "json" | "both"` (defaults to
 * `"json"`, preserving v1.8 behavior). When the caller asks for a different
 * shape, the registration wrapper in `src/index.ts` calls
 * {@link formatMcpResponse} to produce the actual response content.
 *
 * Two audiences are served at once:
 *   - **AI agents** (the typical caller) want raw JSON they can parse and chain
 *     into the next call without re-reasoning.
 *   - **Humans reading the same response** (the typical second audience: the
 *     dev pasting the result into a PR comment, a Slack thread, or a Jira
 *     ticket) want a markdown view that highlights the key fields.
 *
 * `outputFormat: "both"` returns BOTH content items in a single response, so a
 * client can display the markdown to the user AND parse the JSON for the
 * agent loop without an extra round-trip.
 */

import { z } from "zod";
import { getRedactionMode, redact } from "./redact.js";

export const outputFormatField = z
  .enum(["markdown", "json", "both", "verify-fix-table"])
  .optional()
  .describe(
    "Response format. Omitted or `json` (default, preserves v1.8 behavior) returns JSON.stringify of the result. `markdown` renders a human-readable view of the same data. `both` returns both content items in one response, so a client can display markdown to the user and parse JSON for the agent loop without a second call. `verify-fix-table` (v1.10, applies to `analyzeAbandonedMemory` and `diffMemgraphs`) emits a focused 4-column markdown comparison table (Class | Before | After | Delta) of the actionable rows; other tools fall back to `markdown` for this value.",
  );

export type OutputFormat = z.infer<typeof outputFormatField>;

export interface McpContentItem {
  type: "text";
  text: string;
}

/**
 * Shape of the MCP tool response. Matches the SDK's expected type
 * (which has an open index signature for arbitrary extension fields like
 * `_meta`); we model it explicitly here so the formatter's return type
 * can flow through `server.registerTool` without a cast.
 */
export interface McpResponse {
  content: McpContentItem[];
  [key: string]: unknown;
}

/**
 * Pure: shape the MCP response based on the caller's `outputFormat`.
 *
 * For `json` and `both`, the JSON is `JSON.stringify(result, null, 2)`. For
 * `markdown` and `both`, the markdown is rendered via {@link renderAsMarkdown}.
 */
export function formatMcpResponse(
  result: unknown,
  toolName: string,
  format: OutputFormat | undefined,
): McpResponse {
  const mode: OutputFormat = format ?? "json";
  // Redaction happens at the structured-value level so both the JSON
  // and the markdown views are scrubbed consistently. `off` short-circuits
  // and returns the input unchanged; `balanced` (default) masks home-dir
  // paths and common secret-shaped tokens; `strict` also masks hostnames,
  // IPs, and bundle identifiers. See src/runtime/redact.ts.
  const redacted = redact(result, getRedactionMode());
  const json = JSON.stringify(redacted, null, 2);
  if (mode === "json") {
    return { content: [{ type: "text", text: json }] };
  }
  // `verify-fix-table` is a focused renderer that takes precedence over
  // the generic markdown one. Falls back to standard markdown when the
  // tool does not implement a verify-fix view.
  if (mode === "verify-fix-table") {
    const focused = renderVerifyFixTable(redacted, toolName);
    if (focused != null) {
      return { content: [{ type: "text", text: focused }] };
    }
    // Fall through to markdown for tools that don't implement it.
    const fallback = renderAsMarkdown(redacted, toolName);
    return { content: [{ type: "text", text: fallback }] };
  }
  const markdown = renderAsMarkdown(redacted, toolName);
  if (mode === "markdown") {
    return { content: [{ type: "text", text: markdown }] };
  }
  // "both": markdown first so a UI that picks content[0] gets the readable
  // view, then JSON so an agent looking for the structured data finds it
  // without having to parse the markdown.
  return {
    content: [
      { type: "text", text: markdown },
      { type: "text", text: json },
    ],
  };
}

interface VerifyFixRow {
  className: string;
  beforeCount: number;
  afterCount: number;
  delta: number;
}

/**
 * Pure: render a verify-fix focused markdown table for tools that support
 * it. Returns `null` if the tool's result does not match the expected
 * verify-fix shape, signaling the caller to fall back to standard markdown.
 *
 * Supported tools:
 *
 * - `analyzeAbandonedMemory`: reads `actionableShrinkage[]` (the v1.10
 *   verify-fix-default direction: classes that the fix freed) and
 *   `actionableGrowth[]` (regressions the fix didn't address). Emits one
 *   table for shrinkage and, when non-empty, a second smaller table for
 *   growth. Threshold: |delta| >= 10 by default to filter cosmetic noise.
 *
 * - `diffMemgraphs`: reads `classCountChanges[]` (positive + negative).
 *   Future expansion; for now returns null and falls back to standard
 *   markdown.
 *
 * The 4-column layout is deliberately compact (Class | Before | After |
 * Delta) so it renders cleanly in GitHub's markdown preview, dev.to, and
 * agent chat contexts. A trailing `> Diagnosis: ...` blockquote carries
 * the structured `diagnosis` field when present.
 */
export function renderVerifyFixTable(
  result: unknown,
  toolName: string,
): string | null {
  if (toolName !== "analyzeAbandonedMemory") {
    return null;
  }
  if (result == null || typeof result !== "object") {
    return null;
  }
  const obj = result as Record<string, unknown>;
  const shrinkage = extractVerifyFixRows(obj["actionableShrinkage"]);
  const growth = extractVerifyFixRows(obj["actionableGrowth"]);
  const diagnosis = typeof obj["diagnosis"] === "string" ? (obj["diagnosis"] as string) : null;
  // Threshold: filter cosmetic noise.
  const DELTA_THRESHOLD = 10;
  const filteredShrinkage = shrinkage.filter((r) => Math.abs(r.delta) >= DELTA_THRESHOLD);
  const filteredGrowth = growth.filter((r) => Math.abs(r.delta) >= DELTA_THRESHOLD);
  if (filteredShrinkage.length === 0 && filteredGrowth.length === 0) {
    return [
      "# analyzeAbandonedMemory: verify-fix",
      "",
      "_No class counts crossed the actionable threshold (|delta| >= 10)._",
      diagnosis ? `\n> ${diagnosis}` : "",
    ]
      .join("\n")
      .trim();
  }
  const sections: string[] = ["# analyzeAbandonedMemory: verify-fix", ""];
  if (filteredShrinkage.length > 0) {
    sections.push("## What the fix freed");
    sections.push("");
    sections.push("| Class | Before | After | Delta |");
    sections.push("|---|---:|---:|---:|");
    for (const row of filteredShrinkage) {
      sections.push(
        `| \`${row.className}\` | ${row.beforeCount} | ${row.afterCount} | ${row.delta} |`,
      );
    }
    sections.push("");
  }
  if (filteredGrowth.length > 0) {
    sections.push("## Classes that grew (regressions or unrelated)");
    sections.push("");
    sections.push("| Class | Before | After | Delta |");
    sections.push("|---|---:|---:|---:|");
    for (const row of filteredGrowth) {
      sections.push(
        `| \`${row.className}\` | ${row.beforeCount} | ${row.afterCount} | +${row.delta} |`,
      );
    }
    sections.push("");
  }
  if (diagnosis) {
    sections.push(`> ${diagnosis}`);
  }
  return sections.join("\n").trim();
}

function extractVerifyFixRows(value: unknown): VerifyFixRow[] {
  if (!Array.isArray(value)) return [];
  const rows: VerifyFixRow[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r["className"] === "string" &&
      typeof r["beforeCount"] === "number" &&
      typeof r["afterCount"] === "number" &&
      typeof r["delta"] === "number"
    ) {
      rows.push({
        className: r["className"] as string,
        beforeCount: r["beforeCount"] as number,
        afterCount: r["afterCount"] as number,
        delta: r["delta"] as number,
      });
    }
  }
  return rows;
}

/**
 * Pure: render an arbitrary JSON-shaped value as markdown.
 *
 * The rendering is intentionally generic: it does not have per-tool
 * templates. A `# Tool name` header, a `## Key` for each top-level field, and
 * smart formatting for arrays of objects (tables when the rows share a
 * schema) and scalars. Per-tool overrides can land in v1.9.1+ if any
 * specific tool's output deserves a more curated view.
 *
 * Exposed for tests.
 */
export function renderAsMarkdown(value: unknown, toolName: string): string {
  const lines: string[] = [`# ${toolName}`, ""];
  if (value == null || typeof value !== "object") {
    lines.push(formatScalar(value));
    return lines.join("\n");
  }
  const obj = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    lines.push(`## ${key}`);
    lines.push("");
    lines.push(formatValue(val, 0));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function formatValue(value: unknown, depth: number): string {
  if (value == null) return "_(null)_";
  if (typeof value === "string") return value || "_(empty)_";
  if (typeof value === "number" || typeof value === "boolean")
    return formatScalar(value);
  if (Array.isArray(value)) return formatArray(value, depth);
  if (typeof value === "object") return formatObject(value as Record<string, unknown>, depth);
  return String(value);
}

function formatArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return "_(empty array)_";
  // Table if all entries are objects with a shared key set.
  if (
    arr.length > 0 &&
    arr.every(
      (e) => e != null && typeof e === "object" && !Array.isArray(e),
    )
  ) {
    const objects = arr as Record<string, unknown>[];
    const cols = collectCommonKeys(objects);
    if (cols.length > 0 && cols.length <= 8) {
      const header = `| ${cols.join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const rows = objects.slice(0, 50).map((o) => {
        const cells = cols.map((c) => formatCell(o[c]));
        return `| ${cells.join(" | ")} |`;
      });
      const tail = objects.length > 50 ? `\n_(${objects.length - 50} more rows omitted)_` : "";
      return [header, sep, ...rows].join("\n") + tail;
    }
  }
  // Otherwise bullet list of scalars / mixed.
  return arr
    .slice(0, 50)
    .map((e) => `- ${formatCell(e)}`)
    .join("\n");
}

function formatObject(obj: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "_(empty object)_";
  if (depth >= 2) {
    // Deeply nested: collapse to inline JSON to keep the markdown tidy.
    return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
  }
  return entries
    .map(([k, v]) => `- **${k}**: ${formatInline(v, depth + 1)}`)
    .join("\n");
}

function formatInline(value: unknown, depth: number): string {
  if (value == null) return "_(null)_";
  if (typeof value === "string") return value || "_(empty)_";
  if (typeof value === "number" || typeof value === "boolean")
    return formatScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "_(empty array)_";
    if (value.length <= 5 && value.every((e) => typeof e !== "object" || e == null)) {
      return `[${value.map((e) => formatCell(e)).join(", ")}]`;
    }
    return `\n${formatArray(value, depth)}`;
  }
  if (typeof value === "object") {
    return `\n${formatObject(value as Record<string, unknown>, depth)}`;
  }
  return String(value);
}

function formatScalar(value: unknown): string {
  if (value == null) return "_(null)_";
  if (typeof value === "boolean") return value ? "`true`" : "`false`";
  if (typeof value === "number") return `\`${value}\``;
  return String(value);
}

function formatCell(value: unknown): string {
  if (value == null) return "_";
  if (typeof value === "string") {
    // Escape pipes for table safety, truncate long strings.
    const escaped = value.replace(/\|/g, "\\|");
    return escaped.length > 80 ? escaped.slice(0, 77) + "..." : escaped;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return formatScalar(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") {
    // Compact inline JSON, truncated.
    const s = JSON.stringify(value);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  }
  return String(value);
}

function collectCommonKeys(objects: Record<string, unknown>[]): string[] {
  // Use the keys of the FIRST object as the column set, filtered to those
  // present in at least half of the rows. Keeps the table compact when rows
  // have optional fields.
  if (objects.length === 0) return [];
  const firstKeys = Object.keys(objects[0]);
  const threshold = Math.ceil(objects.length / 2);
  return firstKeys.filter((k) => {
    let hits = 0;
    for (const o of objects) {
      if (Object.prototype.hasOwnProperty.call(o, k)) hits += 1;
    }
    return hits >= threshold;
  });
}
