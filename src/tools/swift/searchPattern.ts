import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/**
 * Pure regex search over a Swift file. No SourceKit-LSP involvement, no
 * IndexStoreDB. Useful for catching what LSP misses: closure capture lists
 * (`[weak self]`, `[unowned self]`), `Task { ... self ... }` blocks, custom
 * patterns the agent comes up with from a leak chain.
 */

export const swiftSearchPatternSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe("Absolute path to a Swift source file."),
  pattern: z
    .string()
    .min(1)
    .describe(
      "Regex pattern (JavaScript flavour). The `g` flag is implied — every match is returned.",
    ),
  flags: z
    .string()
    .optional()
    .describe('Additional RegExp flags ("i", "m", "s", "im", etc.).'),
  maxMatches: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(50)
    .describe("Cap on matches returned (default 50)."),
});

export type SwiftSearchPatternInput = z.infer<typeof swiftSearchPatternSchema>;

export interface SwiftSearchPatternMatch {
  line: number;
  character: number;
  text: string;
  /** Trimmed source line for context. */
  snippet?: string;
}

export interface SwiftSearchPatternResult {
  ok: boolean;
  filePath: string;
  matches: SwiftSearchPatternMatch[];
  truncated: boolean;
}

export async function swiftSearchPattern(
  input: SwiftSearchPatternInput,
): Promise<SwiftSearchPatternResult> {
  const file = resolvePath(input.filePath);
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  const flags = `g${input.flags ?? ""}`.replace(/g+/g, "g");
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, flags);
  } catch (err) {
    throw new Error(
      `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const matches: SwiftSearchPatternMatch[] = [];
  let truncated = false;
  const max = input.maxMatches ?? 50;

  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      if (matches.length >= max) {
        truncated = true;
        break;
      }
      matches.push({
        line: i,
        character: m.index,
        text: m[0],
        snippet: lines[i].trim(),
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
    if (truncated) break;
  }

  return { ok: true, filePath: file, matches, truncated };
}
