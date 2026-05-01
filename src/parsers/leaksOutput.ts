import type {
  CycleNode,
  LeaksHeader,
  LeaksReport,
  LeaksTotals,
  RetainKind,
} from "../types.js";

const SEPARATOR = "----";

const HEADER_KEYS: Record<string, keyof LeaksHeader> = {
  "Hardware Model": "hardwareModel",
  Process: "process",
  Identifier: "identifier",
  Version: "version",
  Platform: "platform",
  "OS Version": "osVersion",
  "Date/Time": "dateTime",
  "Physical footprint": "physicalFootprint",
  "Physical footprint (peak)": "physicalFootprintPeak",
};

const TOTAL_LINE_RE = /^\s*(\d+)\s+\([^)]+\)\s+<<\s*TOTAL\s*>>\s*$/;
const SUMMARY_RE =
  /^Process\s+\d+:\s+(\d+)\s+leaks?\s+for\s+(\d+)\s+total\s+leaked\s+bytes\.?\s*$/;
const NODES_RE =
  /^Process\s+\d+:\s+(\d+)\s+nodes\s+malloced\s+for\s+(\d+)\s+KB\s*$/;
const PROCESS_PID_RE = /^(.+?)\s+\[(\d+)\]\s*$/;

/**
 * One line from the cycle/leak section.
 *
 * Matches things like:
 *   543 (56.9K) ROOT CYCLE: <ClassName 0xADDR> [640]
 *   434 (48.3K) __strong value --> ROOT CYCLE: <ClassName 0xADDR> [96]
 *   _rawValues --> CYCLE BACK TO <ClassName 0xADDR> [640]
 *   1 (64 bytes) <CFDictionary 0xADDR> [64]
 *   236 (28.7K) view + 16 --> ROOT CYCLE: 0x1569cafe0 [32]
 */
const COUNT_RE = /^(\d+)\s+\(([^)]+)\)\s+/;

interface ParsedLine {
  indent: number;
  node: CycleNode;
}

/** Detect retain kind from the edge prefix. */
function detectRetainKind(edge: string | undefined): RetainKind {
  if (!edge) return "plain";
  if (/^__strong\b/.test(edge)) return "__strong";
  if (/^weak\b/.test(edge)) return "weak";
  if (/^unowned\b/.test(edge)) return "unowned";
  return "plain";
}

/**
 * Extract `<ClassName 0xADDR> [SIZE]` or `0xADDR [SIZE]` from the tail of a line.
 *
 * Returns className (may be empty), address, instanceSize.
 * Returns null if no class/address pattern found.
 */
function parseClassRef(s: string): {
  className: string;
  address: string;
  instanceSize?: number;
} | null {
  // <ClassName 0xADDR> [SIZE]
  const angled = s.match(/<(.+)\s+(0x[0-9a-fA-F]+)>\s*(?:\[(\d+)\])?\s*$/);
  if (angled) {
    return {
      className: angled[1].trim(),
      address: angled[2],
      instanceSize: angled[3] ? parseInt(angled[3], 10) : undefined,
    };
  }
  // bare 0xADDR [SIZE]
  const bare = s.match(/(0x[0-9a-fA-F]+)\s*(?:\[(\d+)\])?\s*$/);
  if (bare) {
    return {
      className: "",
      address: bare[1],
      instanceSize: bare[2] ? parseInt(bare[2], 10) : undefined,
    };
  }
  return null;
}

/**
 * Parse a single non-empty cycle/leak line.
 * Returns null if the line doesn't match the cycle grammar (e.g. blank lines, summary lines).
 */
function parseCycleLine(rawLine: string): ParsedLine | null {
  const trimmedLeft = rawLine.replace(/\s+$/, "");
  if (!trimmedLeft.trim()) return null;
  const indent = rawLine.length - rawLine.trimStart().length;

  let body = rawLine.trimStart();

  // Skip lines that are summaries / total — caller handles those.
  if (TOTAL_LINE_RE.test(rawLine)) return null;
  if (/^leaks Report Version/i.test(body)) return null;
  if (NODES_RE.test(body) || SUMMARY_RE.test(body)) return null;

  let count: number | undefined;
  let size: string | undefined;
  const countMatch = body.match(COUNT_RE);
  if (countMatch) {
    count = parseInt(countMatch[1], 10);
    size = countMatch[2];
    body = body.slice(countMatch[0].length);
  }

  // Now body starts with one of:
  //   ROOT CYCLE: <...>
  //   CYCLE BACK TO <...>
  //   <edge> --> ROOT CYCLE: <...>
  //   <edge> --> CYCLE BACK TO <...>
  //   <edge> --> <...>
  //   <...>            (bare leak with no edge, no marker)

  let isRootCycle = false;
  let isCycleBack = false;
  let edge: string | undefined;
  let tail = body;

  const arrowIdx = body.indexOf(" --> ");
  if (arrowIdx >= 0) {
    edge = body.slice(0, arrowIdx).trim();
    tail = body.slice(arrowIdx + 5).trim();
  }

  if (/^ROOT CYCLE:\s*/.test(tail)) {
    isRootCycle = true;
    tail = tail.replace(/^ROOT CYCLE:\s*/, "");
  } else if (/^CYCLE BACK TO\s+/.test(tail)) {
    isCycleBack = true;
    tail = tail.replace(/^CYCLE BACK TO\s+/, "");
  }

  const ref = parseClassRef(tail);
  if (!ref) return null;

  const node: CycleNode = {
    count,
    size,
    edge,
    retainKind: detectRetainKind(edge),
    className: ref.className,
    address: ref.address,
    instanceSize: ref.instanceSize,
    isRootCycle,
    isCycleBack,
    indent,
    children: [],
  };

  return { indent, node };
}

function parseHeader(lines: string[]): {
  header: LeaksHeader;
  rest: string[];
} {
  const header: LeaksHeader = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === SEPARATOR) {
      i++;
      break;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "Process") {
      const m = value.match(PROCESS_PID_RE);
      if (m) {
        header.process = m[1].trim();
        header.pid = parseInt(m[2], 10);
        continue;
      }
      header.process = value;
      continue;
    }
    const mapped = HEADER_KEYS[key];
    if (mapped) {
      (header as Record<string, unknown>)[mapped] = value;
    }
  }
  return { header, rest: lines.slice(i) };
}

function parseTotals(
  lines: string[],
): { totals: LeaksTotals; rest: string[] } {
  let nodesMalloced: number | undefined;
  let totalKB: number | undefined;
  let leakCount = 0;
  let totalLeakedBytes = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m1 = line.match(NODES_RE);
    if (m1) {
      nodesMalloced = parseInt(m1[1], 10);
      totalKB = parseInt(m1[2], 10);
      continue;
    }
    const m2 = line.match(SUMMARY_RE);
    if (m2) {
      leakCount = parseInt(m2[1], 10);
      totalLeakedBytes = parseInt(m2[2], 10);
      continue;
    }
    if (TOTAL_LINE_RE.test(line)) {
      // Skip — totals already captured above.
      i++;
      break;
    }
    if (line.trim() === "" || /^leaks Report Version/.test(line)) {
      continue;
    }
    // First non-summary line — body starts here.
    break;
  }
  return {
    totals: { nodesMalloced, totalKB, leakCount, totalLeakedBytes },
    rest: lines.slice(i),
  };
}

/**
 * Build a forest of CycleNodes from a stream of (indent, node) pairs.
 * Indentation strictly increases for children; equal/lower indent pops the stack.
 */
function buildTree(parsed: ParsedLine[]): CycleNode[] {
  const roots: CycleNode[] = [];
  const stack: ParsedLine[] = [];
  for (const item of parsed) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= item.indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(item.node);
    } else {
      stack[stack.length - 1].node.children.push(item.node);
    }
    stack.push(item);
  }
  return roots;
}

/**
 * Parse the full output of `leaks <memgraph>` into a structured report.
 *
 * Tolerates trailing/leading whitespace and unknown header keys. Body lines
 * that don't match the cycle grammar are silently skipped (the leaks(1)
 * format is loose — better to ignore an unknown line than fail the whole parse).
 */
export function parseLeaksOutput(text: string): LeaksReport {
  const allLines = text.split(/\r?\n/);
  const { header, rest: afterHeader } = parseHeader(allLines);
  const { totals, rest: afterTotals } = parseTotals(afterHeader);

  const parsedLines: ParsedLine[] = [];
  for (const line of afterTotals) {
    const parsed = parseCycleLine(line);
    if (parsed) parsedLines.push(parsed);
  }

  const cycles = buildTree(parsedLines);
  const hasNoCycles = !parsedLines.some((p) => p.node.isRootCycle);

  return { header, totals, cycles, hasNoCycles };
}

/**
 * Walk the cycle tree top-down, yielding every node with its depth.
 */
export function* walkCycles(
  cycles: CycleNode[],
  depth = 0,
): Generator<{ node: CycleNode; depth: number }> {
  for (const node of cycles) {
    yield { node, depth };
    yield* walkCycles(node.children, depth + 1);
  }
}

/**
 * Return only the top-level ROOT CYCLE nodes (skipping standalone leaks).
 */
export function rootCyclesOnly(cycles: CycleNode[]): CycleNode[] {
  return cycles.filter((c) => c.isRootCycle);
}

/**
 * Find all class names mentioned in the cycle forest. Useful for `countAlive`
 * and `findRetainers` lookups.
 */
export function classNames(cycles: CycleNode[]): Set<string> {
  const names = new Set<string>();
  for (const { node } of walkCycles(cycles)) {
    if (node.className) names.add(node.className);
  }
  return names;
}
