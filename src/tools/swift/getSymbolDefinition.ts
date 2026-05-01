import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { acquireClient, projectRootFor } from "../../runtime/sourcekit/pool.js";
import {
  lspDefinition,
  type SourceLocation,
} from "../../runtime/sourcekit/protocol.js";
import { findSymbolDeclaration } from "./_helpers.js";

export const swiftGetSymbolDefinitionSchema = z.object({
  symbolName: z
    .string()
    .min(1)
    .describe(
      "Name of the Swift symbol to locate (class, struct, enum, protocol, func, var, etc.).",
    ),
  hint: z
    .object({
      filePath: z.string().optional(),
      module: z.string().optional(),
    })
    .optional()
    .describe(
      "Optional hint to speed up the search. `filePath` skips the project scan; `module` is reserved for future multi-module work.",
    ),
  projectRoot: z
    .string()
    .optional()
    .describe(
      "Override the project root. Default discovers the nearest Package.swift / .xcodeproj / .xcworkspace from the cwd.",
    ),
  candidatePaths: z
    .array(z.string())
    .optional()
    .describe(
      "If provided, search these files for the symbol declaration before asking SourceKit-LSP. Speeds up location when the agent already has a guess (e.g. from `findSymbolReferences` or `swift_search_pattern`).",
    ),
});

export type SwiftGetSymbolDefinitionInput = z.infer<
  typeof swiftGetSymbolDefinitionSchema
>;

export interface SwiftGetSymbolDefinitionResult {
  ok: boolean;
  symbolName: string;
  /** Definition locations returned by SourceKit-LSP (or pre-scan when LSP returns nothing). */
  definitions: SourceLocation[];
  /** When set, indicates we located the symbol via filename pre-scan rather than a true LSP query. */
  preScanHit?: { filePath: string; matchedText: string };
}

export async function swiftGetSymbolDefinition(
  input: SwiftGetSymbolDefinitionInput,
): Promise<SwiftGetSymbolDefinitionResult> {
  const root = input.projectRoot
    ? resolvePath(input.projectRoot)
    : projectRootFor(
        input.candidatePaths?.[0] ?? input.hint?.filePath ?? process.cwd(),
      );
  if (!existsSync(root)) {
    throw new Error(`Project root not found: ${root}`);
  }

  const fileCandidates = [
    ...(input.hint?.filePath ? [input.hint.filePath] : []),
    ...(input.candidatePaths ?? []),
  ];

  for (const fp of fileCandidates) {
    const abs = resolvePath(fp);
    if (!existsSync(abs)) continue;
    const pos = findSymbolDeclaration(abs, input.symbolName);
    if (pos) {
      const client = await acquireClient(root);
      const defs = await lspDefinition(client, abs, pos.line, pos.character);
      return {
        ok: true,
        symbolName: input.symbolName,
        definitions:
          defs.length > 0
            ? defs
            : [{ filePath: abs, line: pos.line, character: pos.character }],
        preScanHit: { filePath: abs, matchedText: pos.matchedText.trim() },
      };
    }
  }

  // No candidate found locally. SourceKit-LSP doesn't expose a workspace-wide
  // "find me a symbol named X" endpoint over plain LSP, so we punt and let
  // the agent feed back candidate paths from a prior `searchPattern` or
  // `findCycles` call.
  return {
    ok: true,
    symbolName: input.symbolName,
    definitions: [],
    preScanHit: undefined,
  };
}
