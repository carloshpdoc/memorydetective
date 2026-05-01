import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { acquireClient, projectRootFor } from "../../runtime/sourcekit/pool.js";
import { lspHover } from "../../runtime/sourcekit/protocol.js";

export const swiftGetHoverInfoSchema = z.object({
  filePath: z.string().min(1).describe("Absolute path to a Swift source file."),
  line: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based line number (LSP convention)."),
  character: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based UTF-16 character offset within the line."),
  projectRoot: z.string().optional(),
});

export type SwiftGetHoverInfoInput = z.infer<typeof swiftGetHoverInfoSchema>;

export interface SwiftGetHoverInfoResult {
  ok: boolean;
  filePath: string;
  /** Markdown / plaintext hover content from SourceKit-LSP. */
  contents: string;
  /** Best-effort extracted declaration fragment (e.g. "class DetailViewModel : ObservableObject"). */
  typeName?: string;
}

export async function swiftGetHoverInfo(
  input: SwiftGetHoverInfoInput,
): Promise<SwiftGetHoverInfoResult> {
  const file = resolvePath(input.filePath);
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  const root = input.projectRoot
    ? resolvePath(input.projectRoot)
    : projectRootFor(file);
  const client = await acquireClient(root);
  const result = await lspHover(client, file, input.line, input.character);
  const contents = result?.contents ?? "";
  const typeName = extractTypeName(contents);
  return { ok: true, filePath: file, contents, typeName };
}

function extractTypeName(hover: string): string | undefined {
  // Hover output usually leads with a code fence containing the
  // declaration line (e.g. "let foo: Bar" or "class Baz : Quux").
  const m = hover.match(
    /\b(class|struct|enum|protocol|actor|func|var|let)\s+\S+/,
  );
  return m ? m[0] : undefined;
}
