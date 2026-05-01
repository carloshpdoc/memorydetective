/**
 * Shared utilities for the Swift source-bridging tools.
 *
 * Position-finding via local regex pre-scan is the load-bearing trick: we
 * locate the symbol's declaration in a candidate file with a quick regex
 * before sending its position to SourceKit-LSP. This avoids LSP's
 * comparatively slow workspace symbol search.
 */

import { readFileSync } from "node:fs";

export interface SymbolPosition {
  line: number;
  character: number;
  matchedText: string;
}

/**
 * Find the first declaration of `symbolName` in the file.
 *
 * Looks for the symbol after one of Swift's declaration keywords
 * (`class`, `struct`, `enum`, `protocol`, `func`, `var`, `let`,
 * `actor`, `extension`). Falls back to the first standalone-word
 * occurrence so we still surface a position when the name is referenced
 * but not declared in the file (e.g. an extension method on a type
 * declared elsewhere).
 *
 * Returns 0-based positions matching LSP's convention.
 */
export function findSymbolDeclaration(
  filePath: string,
  symbolName: string,
): SymbolPosition | null {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);

  const declRe = new RegExp(
    `\\b(?:class|struct|enum|protocol|func|var|let|actor|extension)\\s+${escapeRegex(symbolName)}\\b`,
  );
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(declRe);
    if (m) {
      const ch = lines[i].indexOf(symbolName, m.index ?? 0);
      if (ch >= 0) {
        return { line: i, character: ch, matchedText: lines[i] };
      }
    }
  }

  const wordRe = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(wordRe);
    if (m) {
      return {
        line: i,
        character: m.index ?? 0,
        matchedText: lines[i],
      };
    }
  }
  return null;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract a few lines of context around `line` for snippet display. */
export function snippetAt(filePath: string, line: number, padding = 1): string {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, line - padding);
    const end = Math.min(lines.length - 1, line + padding);
    return lines.slice(start, end + 1).join("\n");
  } catch {
    return "";
  }
}
