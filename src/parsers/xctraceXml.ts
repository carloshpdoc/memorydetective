import { XMLParser } from "fast-xml-parser";

/**
 * Generic representation of an xctrace exported table.
 *
 * xctrace's XML uses an id/ref deduplication scheme: a value's first occurrence
 * carries `id="N"`, later identical occurrences appear as `<col ref="N"/>`.
 * Our parser resolves all refs so each row is a flat record.
 */
export interface XctraceTable {
  schema: string;
  columns: string[];
  rows: Array<Record<string, XctraceValue>>;
}

/**
 * A column value. The `fmt` field is what Instruments displays in its UI;
 * `raw` is the underlying value (timestamp in ns, duration in ns, etc.).
 * `nested` is present when the value contains structured sub-elements
 * (e.g. a thread cell containing tid + process + pid).
 */
export interface XctraceValue {
  raw?: string;
  fmt?: string;
  nested?: Record<string, XctraceValue>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
  alwaysCreateTextNode: true,
});

interface ParsedNode {
  [key: string]: unknown;
}

/**
 * Walk the parsed XML tree, collecting `id="N"` references into a map so
 * later `ref="N"` markers can be resolved.
 */
function indexById(node: unknown, into: Map<string, ParsedNode>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) indexById(item, into);
    return;
  }
  const obj = node as Record<string, unknown>;
  const id = obj["@_id"];
  if (typeof id === "string" && id) {
    into.set(id, obj as ParsedNode);
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith("@_") || key === "#text") continue;
    indexById(obj[key], into);
  }
}

function resolveRef(
  obj: ParsedNode,
  byId: Map<string, ParsedNode>,
): ParsedNode {
  const ref = obj["@_ref"];
  if (typeof ref === "string" && ref) {
    const target = byId.get(ref);
    if (target) return target;
  }
  return obj;
}

/**
 * Convert a single column-cell ParsedNode into our XctraceValue model.
 * Handles refs and recursive nested children.
 */
function nodeToValue(
  node: ParsedNode,
  byId: Map<string, ParsedNode>,
  depth = 0,
): XctraceValue {
  const resolved = resolveRef(node, byId);
  const value: XctraceValue = {};
  if (typeof resolved["@_fmt"] === "string") value.fmt = resolved["@_fmt"];

  // Body text — appears as #text after parsing.
  const text = resolved["#text"];
  if (typeof text === "string" && text.trim()) value.raw = text.trim();

  if (depth >= 3) return value; // hard recursion limit for safety

  const nested: Record<string, XctraceValue> = {};
  let hasNested = false;
  for (const key of Object.keys(resolved)) {
    if (key.startsWith("@_") || key === "#text") continue;
    const childNode = resolved[key];
    if (childNode && typeof childNode === "object") {
      const items = Array.isArray(childNode) ? childNode : [childNode];
      // For nested values, take the first occurrence as the canonical sub-value.
      nested[key] = nodeToValue(items[0] as ParsedNode, byId, depth + 1);
      hasNested = true;
    }
  }
  if (hasNested) value.nested = nested;
  return value;
}

/**
 * Parse a chunk of xctrace XML output (from `xcrun xctrace export --xpath ...`)
 * into structured tables.
 */
export function parseXctraceXml(xml: string): XctraceTable[] {
  const parsed = parser.parse(xml) as ParsedNode;
  const result = parsed["trace-query-result"] as ParsedNode | undefined;
  if (!result) return [];
  const nodes = Array.isArray(result.node) ? result.node : [result.node];
  const byId = new Map<string, ParsedNode>();
  indexById(parsed, byId);

  const tables: XctraceTable[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as ParsedNode;
    const schemaNode = n.schema as ParsedNode | undefined;
    if (!schemaNode) continue;
    const schemaName =
      typeof schemaNode["@_name"] === "string" ? schemaNode["@_name"] : "";

    const colNodes = schemaNode.col;
    const cols = Array.isArray(colNodes)
      ? (colNodes as ParsedNode[])
      : colNodes
        ? [colNodes as ParsedNode]
        : [];
    /**
     * For each column we capture both the `mnemonic` (the schema's logical key)
     * and the `engineering-type` (the actual XML element name used in <row>).
     * They differ for some columns (e.g. mnemonic="start" but element is <start-time>).
     */
    const columns = cols.map((c) => {
      const m = c.mnemonic as ParsedNode | undefined;
      const e = c["engineering-type"] as ParsedNode | undefined;
      const mnemonic = m?.["#text"] ? String(m["#text"]) : "";
      const eng = e?.["#text"] ? String(e["#text"]) : "";
      return { mnemonic, eng };
    });
    const columnNames = columns.map((c) => c.mnemonic).filter(Boolean);

    const rowNodes = n.row;
    const rows = Array.isArray(rowNodes)
      ? (rowNodes as ParsedNode[])
      : rowNodes
        ? [rowNodes as ParsedNode]
        : [];

    const tableRows: Array<Record<string, XctraceValue>> = [];
    for (const row of rows) {
      const record: Record<string, XctraceValue> = {};
      for (const col of columns) {
        if (!col.mnemonic) continue;
        // Try mnemonic first, fall back to engineering-type element name.
        const cell =
          row[col.mnemonic] ?? (col.eng ? row[col.eng] : undefined);
        if (!cell) continue;
        const cellNode = Array.isArray(cell)
          ? (cell[0] as ParsedNode)
          : (cell as ParsedNode);
        record[col.mnemonic] = nodeToValue(cellNode, byId);
      }
      tableRows.push(record);
    }

    tables.push({
      schema: schemaName,
      columns: columnNames.filter(Boolean),
      rows: tableRows,
    });
  }
  return tables;
}

/** Helper: pull a numeric value from an XctraceValue (raw nanoseconds, ms, etc.). */
export function asNumber(v: XctraceValue | undefined): number | undefined {
  if (!v?.raw) return undefined;
  const n = Number(v.raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Helper: pull a formatted string from an XctraceValue. */
export function asFormatted(v: XctraceValue | undefined): string | undefined {
  return v?.fmt ?? v?.raw;
}
