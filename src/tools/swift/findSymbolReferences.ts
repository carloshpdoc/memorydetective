import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { acquireClient, projectRootFor } from "../../runtime/sourcekit/pool.js";
import {
  lspReferences,
  type SourceLocation,
} from "../../runtime/sourcekit/protocol.js";
import { findSymbolDeclaration, snippetAt } from "./_helpers.js";

export const swiftFindSymbolReferencesSchema = z.object({
  symbolName: z
    .string()
    .min(1)
    .describe("Name of the Swift symbol to find references for."),
  filePath: z
    .string()
    .min(1)
    .describe(
      "Path to a Swift file where the symbol is declared. The LSP query needs a position; we locate it in this file via a regex pre-scan.",
    ),
  projectRoot: z
    .string()
    .optional()
    .describe(
      "Override the project root. Default discovers the nearest Package.swift / .xcodeproj / .xcworkspace.",
    ),
  includeDeclaration: z
    .boolean()
    .default(true)
    .describe("Include the declaration site itself in the result set."),
});

export type SwiftFindSymbolReferencesInput = z.infer<
  typeof swiftFindSymbolReferencesSchema
>;

export interface SwiftFindSymbolReferencesResult {
  ok: boolean;
  symbolName: string;
  totalReferences: number;
  references: Array<SourceLocation & { snippet?: string }>;
  /** True when the IndexStoreDB was missing — references are likely incomplete. Build the index with `swift build -Xswiftc -index-store-path -Xswiftc <project>/.build/index/store`. */
  needsIndex?: boolean;
}

export async function swiftFindSymbolReferences(
  input: SwiftFindSymbolReferencesInput,
): Promise<SwiftFindSymbolReferencesResult> {
  const file = resolvePath(input.filePath);
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  const root = input.projectRoot
    ? resolvePath(input.projectRoot)
    : projectRootFor(file);

  const pos = findSymbolDeclaration(file, input.symbolName);
  if (!pos) {
    return {
      ok: true,
      symbolName: input.symbolName,
      totalReferences: 0,
      references: [],
    };
  }

  const client = await acquireClient(root);
  const refs = await lspReferences(
    client,
    file,
    pos.line,
    pos.character,
    input.includeDeclaration ?? true,
  );

  const refsWithSnippets = refs.map((r) => ({
    ...r,
    snippet: snippetAt(r.filePath, r.line),
  }));

  return {
    ok: true,
    symbolName: input.symbolName,
    totalReferences: refs.length,
    references: refsWithSnippets,
    needsIndex: refs.length === 0 ? true : undefined,
  };
}
