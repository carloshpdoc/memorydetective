import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly } from "../parsers/leaksOutput.js";
import type { CycleNode } from "../types.js";

export const renderCycleGraphSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  cycleIndex: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      "Zero-based index of the ROOT CYCLE to render (default 0 = the first cycle, usually the largest).",
    ),
  format: z
    .enum(["mermaid", "dot"])
    .default("mermaid")
    .describe(
      "Output format: `mermaid` (GitHub-renderable, embeddable in markdown) or `dot` (Graphviz format).",
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .default(8)
    .describe("Truncate the rendered graph beyond this chain depth (default 8)."),
  truncateClassName: z
    .number()
    .int()
    .positive()
    .default(60)
    .describe(
      "Truncate long generic SwiftUI class names to this many characters (default 60). The full name still appears in node IDs.",
    ),
});

export type RenderCycleGraphInput = z.infer<typeof renderCycleGraphSchema>;

export interface RenderCycleGraphResult {
  ok: boolean;
  path: string;
  cycleIndex: number;
  format: "mermaid" | "dot";
  /** The rendered graph as a string. For Mermaid, embed inside ```mermaid ... ``` fences. */
  graph: string;
  /** A few notes about what got truncated, useful for review. */
  notes: string[];
}

interface NodeMeta {
  id: string;
  label: string;
  isCycleBack: boolean;
  isAppLevel: boolean;
}

function safeIdFromAddress(address: string): string {
  return address.replace(/^0x/, "n").replace(/[^a-zA-Z0-9_]/g, "_");
}

function shortLabel(className: string, max: number): string {
  // SwiftUI generic names like ModifiedContent<...> blow up readability.
  // Strip everything after the first `<` for the rendered label.
  const generic = className.indexOf("<");
  const head = generic > 0 ? className.slice(0, generic) : className;
  if (head.length <= max) return head;
  return head.slice(0, max - 1) + "…";
}

function isAppLevel(className: string): boolean {
  return (
    !className.startsWith("Swift.") &&
    !className.startsWith("SwiftUI.") &&
    !className.startsWith("Combine.") &&
    !className.startsWith("_Concurrency.") &&
    !className.startsWith("Foundation.") &&
    !className.startsWith("__") &&
    !className.startsWith("NS")
  );
}

function walk(
  node: CycleNode,
  depth: number,
  maxDepth: number,
  parents: NodeMeta[],
  edges: Array<{ from: string; to: string; label?: string }>,
  truncate: number,
  notes: string[],
): NodeMeta {
  const id = safeIdFromAddress(node.address);
  const label = shortLabel(node.className || node.address, truncate);
  const meta: NodeMeta = {
    id,
    label,
    isCycleBack: node.isCycleBack,
    isAppLevel: isAppLevel(node.className),
  };

  if (parents.length > 0) {
    const parent = parents[parents.length - 1];
    edges.push({
      from: parent.id,
      to: id,
      label: node.edge,
    });
  }

  if (depth >= maxDepth) {
    if (node.children.length > 0) {
      notes.push(
        `Truncated ${node.children.length} child node(s) at depth ${maxDepth} under ${label}.`,
      );
    }
    return meta;
  }

  for (const child of node.children) {
    walk(child, depth + 1, maxDepth, [...parents, meta], edges, truncate, notes);
  }
  return meta;
}

/** Pure: render a single cycle node into Mermaid graph syntax. */
export function renderCycleAsMermaid(
  cycle: CycleNode,
  maxDepth = 8,
  truncate = 60,
): { graph: string; notes: string[] } {
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const notes: string[] = [];
  const allNodes = new Map<string, NodeMeta>();

  const collect = (n: CycleNode, parents: NodeMeta[], depth: number): void => {
    if (depth > maxDepth) return;
    const id = safeIdFromAddress(n.address);
    const label = shortLabel(n.className || n.address, truncate);
    const meta: NodeMeta = {
      id,
      label,
      isCycleBack: n.isCycleBack,
      isAppLevel: isAppLevel(n.className),
    };
    allNodes.set(id, meta);
    if (parents.length > 0) {
      const parent = parents[parents.length - 1];
      edges.push({ from: parent.id, to: id, label: n.edge });
    }
    if (depth === maxDepth && n.children.length > 0) {
      notes.push(
        `Truncated ${n.children.length} child node(s) at depth ${maxDepth} under ${label}.`,
      );
      return;
    }
    for (const c of n.children) collect(c, [...parents, meta], depth + 1);
  };
  collect(cycle, [], 0);

  const lines: string[] = [];
  lines.push("graph TD");

  // Node declarations with styling.
  for (const meta of allNodes.values()) {
    const safeLabel = meta.label.replace(/"/g, "'");
    const shape = meta.isCycleBack ? `(("${safeLabel}"))` : `["${safeLabel}"]`;
    lines.push(`  ${meta.id}${shape}`);
  }

  // Edges with optional labels.
  for (const e of edges) {
    if (e.label) {
      const safe = e.label.replace(/"/g, "'").replace(/\|/g, "/");
      lines.push(`  ${e.from} -- "${safe}" --> ${e.to}`);
    } else {
      lines.push(`  ${e.from} --> ${e.to}`);
    }
  }

  // Style: app-level nodes red, SwiftUI/Foundation nodes default, cycle-back nodes amber.
  lines.push("");
  for (const meta of allNodes.values()) {
    if (meta.isCycleBack) {
      lines.push(`  style ${meta.id} fill:#ffd54f,stroke:#856404,stroke-width:2px`);
    } else if (meta.isAppLevel) {
      lines.push(`  style ${meta.id} fill:#ffcdd2,stroke:#b71c1c,stroke-width:2px`);
    }
  }

  return { graph: lines.join("\n"), notes };
}

/** Pure: render a single cycle as Graphviz DOT. */
export function renderCycleAsDot(
  cycle: CycleNode,
  maxDepth = 8,
  truncate = 60,
): { graph: string; notes: string[] } {
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const notes: string[] = [];
  const allNodes = new Map<string, NodeMeta>();

  const collect = (n: CycleNode, parents: NodeMeta[], depth: number): void => {
    if (depth > maxDepth) return;
    const id = safeIdFromAddress(n.address);
    const label = shortLabel(n.className || n.address, truncate);
    const meta: NodeMeta = {
      id,
      label,
      isCycleBack: n.isCycleBack,
      isAppLevel: isAppLevel(n.className),
    };
    allNodes.set(id, meta);
    if (parents.length > 0) {
      const parent = parents[parents.length - 1];
      edges.push({ from: parent.id, to: id, label: n.edge });
    }
    if (depth === maxDepth && n.children.length > 0) {
      notes.push(
        `Truncated ${n.children.length} child node(s) at depth ${maxDepth} under ${label}.`,
      );
      return;
    }
    for (const c of n.children) collect(c, [...parents, meta], depth + 1);
  };
  collect(cycle, [], 0);

  const lines: string[] = [];
  lines.push("digraph cycle {");
  lines.push("  rankdir=TB;");
  lines.push("  node [shape=box, style=rounded];");

  for (const meta of allNodes.values()) {
    const safeLabel = meta.label.replace(/"/g, "'");
    const fill = meta.isCycleBack
      ? "fillcolor=\"#ffd54f\", style=\"rounded,filled\""
      : meta.isAppLevel
        ? "fillcolor=\"#ffcdd2\", style=\"rounded,filled\""
        : "";
    const attrs = [`label="${safeLabel}"`];
    if (fill) attrs.push(fill);
    lines.push(`  ${meta.id} [${attrs.join(", ")}];`);
  }

  for (const e of edges) {
    const labelAttr = e.label ? ` [label="${e.label.replace(/"/g, "'")}"]` : "";
    lines.push(`  ${e.from} -> ${e.to}${labelAttr};`);
  }
  lines.push("}");

  return { graph: lines.join("\n"), notes };
}

export async function renderCycleGraph(
  input: RenderCycleGraphInput,
): Promise<RenderCycleGraphResult> {
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  const roots = rootCyclesOnly(report.cycles);
  const idx = input.cycleIndex ?? 0;
  if (roots.length === 0) {
    throw new Error("No ROOT CYCLE blocks found in the memgraph.");
  }
  if (idx >= roots.length) {
    throw new Error(
      `cycleIndex ${idx} out of range: only ${roots.length} ROOT CYCLE block(s) present.`,
    );
  }
  const cycle = roots[idx];
  const renderer = (input.format ?? "mermaid") === "dot"
    ? renderCycleAsDot
    : renderCycleAsMermaid;
  const { graph, notes } = renderer(
    cycle,
    input.maxDepth ?? 8,
    input.truncateClassName ?? 60,
  );
  return {
    ok: true,
    path: resolvedPath,
    cycleIndex: idx,
    format: input.format ?? "mermaid",
    graph,
    notes,
  };
}
