import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { acquireClient, projectRootFor } from "../../runtime/sourcekit/pool.js";
import {
  lspDocumentSymbol,
  type ResolvedSymbol,
} from "../../runtime/sourcekit/protocol.js";

export const swiftGetSymbolsOverviewSchema = z.object({
  filePath: z.string().min(1).describe("Absolute path to a Swift source file."),
  projectRoot: z.string().optional(),
  topLevelOnly: z
    .boolean()
    .default(true)
    .describe(
      "Return only top-level symbols (classes, structs, enums, protocols, free functions). When false, returns nested children too. Default true keeps responses small.",
    ),
});

export type SwiftGetSymbolsOverviewInput = z.infer<
  typeof swiftGetSymbolsOverviewSchema
>;

export interface SwiftGetSymbolsOverviewResult {
  ok: boolean;
  filePath: string;
  symbols: ResolvedSymbol[];
}

export async function swiftGetSymbolsOverview(
  input: SwiftGetSymbolsOverviewInput,
): Promise<SwiftGetSymbolsOverviewResult> {
  const file = resolvePath(input.filePath);
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  const root = input.projectRoot
    ? resolvePath(input.projectRoot)
    : projectRootFor(file);

  const client = await acquireClient(root);
  const symbols = await lspDocumentSymbol(client, file);

  if (input.topLevelOnly ?? true) {
    return {
      ok: true,
      filePath: file,
      symbols: symbols.map((s) => ({ ...s, children: undefined })),
    };
  }
  return { ok: true, filePath: file, symbols };
}
