/**
 * Shorten verbose Swift / SwiftUI class names so MCP tool responses fit in
 * an LLM context budget.
 *
 * Real SwiftUI demangled types nest 8+ generic levels deep and run 1000+ chars.
 * Example input (one node, one chain):
 *
 *   SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<
 *     SwiftUI._ConditionalContent<SwiftUI.ModifiedContent<SwiftUI.ModifiedContent<
 *       SwiftUI.AsyncImage<SwiftUI._ConditionalContent<...>>>, ...>>, ...>>
 *
 * Three layers of shortening, in order:
 *   1. Drop standard module prefixes (Swift., SwiftUI., Foundation., Combine.)
 *   2. Collapse nested ModifiedContent chains into "BaseType +N modifiers"
 *   3. Truncate any remaining generic depth past `maxDepth` with a hash
 *      placeholder, e.g. `…<#1a2b3c>` (so equal generics still hash equal).
 *
 * Output for the example above might be:
 *   `ModifiedContent<…<#a3f1>> +12 modifiers`
 *
 * The full original is preserved on the caller side; this function never
 * mutates the underlying CycleNode — it only returns a shortened display string.
 */

const MODULE_PREFIXES = [
  "Swift.",
  "SwiftUI.",
  "Foundation.",
  "Combine.",
  "_Concurrency.",
];

const MODIFIED_CONTENT_RE = /SwiftUI\.ModifiedContent<|ModifiedContent</g;

interface ShortenOptions {
  /** Hard cap on the final string length (default 200). */
  maxLength?: number;
  /** Truncate generic angle-bracket depth past this (default 3). */
  maxDepth?: number;
  /** Drop module prefixes like `Swift.`, `SwiftUI.` (default true). */
  dropModules?: boolean;
  /** Collapse nested `ModifiedContent<…>` chains (default true). */
  collapseModifiers?: boolean;
}

/**
 * Cheap deterministic hash of a string for hash-truncation placeholders.
 * Identical inputs produce identical short codes — useful for diffing two
 * memgraph dumps where a class name appears in both.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).slice(0, 6);
}

function dropModules(s: string): string {
  let out = s;
  for (const prefix of MODULE_PREFIXES) {
    out = out.split(prefix).join("");
  }
  return out;
}

/**
 * Count nested ModifiedContent occurrences and produce a `+N modifiers` summary.
 * Heuristic but reliable for real SwiftUI dumps.
 */
function collapseModifiedContent(s: string): string {
  const matches = s.match(MODIFIED_CONTENT_RE);
  const count = matches ? matches.length : 0;
  if (count === 0) return s;

  // Find the innermost non-ModifiedContent type. We walk past every
  // `ModifiedContent<` pair, ignoring its arguments.
  let i = 0;
  while (i < s.length) {
    const remainder = s.slice(i);
    const m = remainder.match(/^(SwiftUI\.)?ModifiedContent</);
    if (!m) break;
    i += m[0].length;
  }

  // From `i`, take the first nested type up to its first `,` or `>`.
  const tail = s.slice(i);
  const inner = tail.match(/^([\w._]+)(?:<[^,>]*>)?/);
  const baseType = inner ? inner[1] : "ModifiedContent";

  return `${baseType} +${count} modifiers`;
}

/**
 * Truncate generic depth past `maxDepth`. Replaces deeper generics with a
 * hash placeholder so semantically-distinct types stay distinguishable.
 */
function truncateDepth(s: string, maxDepth: number): string {
  let depth = 0;
  let out = "";
  let i = 0;
  let truncatedFragment = "";
  let truncating = false;
  let truncationDepth = 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === "<") {
      depth += 1;
      if (!truncating && depth > maxDepth) {
        truncating = true;
        truncationDepth = depth - 1;
        out += "<";
        i += 1;
        continue;
      }
    } else if (ch === ">") {
      depth -= 1;
      if (truncating && depth === truncationDepth) {
        out += `…<#${shortHash(truncatedFragment)}>>`;
        truncatedFragment = "";
        truncating = false;
        i += 1;
        continue;
      }
    }
    if (truncating) {
      truncatedFragment += ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/** Public API: produce a shortened display string for a class name. */
export function shortenClassName(
  className: string,
  opts: ShortenOptions = {},
): string {
  const {
    maxLength = 200,
    maxDepth = 3,
    dropModules: doDrop = true,
    collapseModifiers = true,
  } = opts;

  if (!className) return "";
  if (className.length <= maxLength && !className.includes("<")) {
    return className;
  }

  let s = className;
  if (doDrop) s = dropModules(s);
  if (collapseModifiers) s = collapseModifiedContent(s);
  s = truncateDepth(s, maxDepth);

  // Final hard cap: middle-truncate.
  if (s.length > maxLength) {
    const half = Math.floor((maxLength - 1) / 2);
    s = s.slice(0, half) + "…" + s.slice(s.length - half);
  }
  return s;
}

/**
 * Verbosity levels accepted by tools that surface class names.
 *
 * - `compact`: aggressive shortening (default for high-signal/low-token output).
 * - `normal`: drop modules, collapse modifiers, but keep depth.
 * - `full`: return the original Swift demangled name verbatim.
 */
export type Verbosity = "compact" | "normal" | "full";

export function shortenForVerbosity(
  className: string,
  verbosity: Verbosity,
): string {
  switch (verbosity) {
    case "full":
      return className;
    case "normal":
      return shortenClassName(className, {
        maxLength: 400,
        maxDepth: 6,
        collapseModifiers: false,
      });
    case "compact":
    default:
      return shortenClassName(className, { maxLength: 200, maxDepth: 3 });
  }
}
