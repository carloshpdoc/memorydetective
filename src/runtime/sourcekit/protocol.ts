/**
 * Typed wrappers around the LSP methods we use.
 *
 * Imports types from `vscode-languageserver-protocol` and converts to/from
 * the file:// URI format LSP servers expect. All paths in the public API
 * are absolute filesystem paths; LSP URIs only show up internally.
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  type DefinitionParams,
  type Definition,
  type Location,
  type LocationLink,
  type ReferenceParams,
  type Hover,
  type HoverParams,
  type DocumentSymbol,
  type DocumentSymbolParams,
  type SymbolInformation,
  SymbolKind,
} from "vscode-languageserver-protocol";
import type { InitializedClient } from "./client.js";

export interface SourceLocation {
  filePath: string;
  line: number;
  character: number;
  /** Optional end position when the LSP server returns a range. */
  endLine?: number;
  endCharacter?: number;
}

export interface ResolvedSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  /** Children symbols (methods inside a class, properties, etc.) when hierarchical. */
  children?: ResolvedSymbol[];
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [SymbolKind.File]: "file",
  [SymbolKind.Module]: "module",
  [SymbolKind.Namespace]: "namespace",
  [SymbolKind.Package]: "package",
  [SymbolKind.Class]: "class",
  [SymbolKind.Method]: "method",
  [SymbolKind.Property]: "property",
  [SymbolKind.Field]: "field",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Enum]: "enum",
  [SymbolKind.Interface]: "interface",
  [SymbolKind.Function]: "function",
  [SymbolKind.Variable]: "variable",
  [SymbolKind.Constant]: "constant",
  [SymbolKind.String]: "string",
  [SymbolKind.Number]: "number",
  [SymbolKind.Boolean]: "boolean",
  [SymbolKind.Array]: "array",
  [SymbolKind.Object]: "object",
  [SymbolKind.Key]: "key",
  [SymbolKind.Null]: "null",
  [SymbolKind.EnumMember]: "enum-member",
  [SymbolKind.Struct]: "struct",
  [SymbolKind.Event]: "event",
  [SymbolKind.Operator]: "operator",
  [SymbolKind.TypeParameter]: "type-parameter",
};

function uriOf(filePath: string): string {
  return pathToFileURL(resolvePath(filePath)).href;
}

function pathOf(uri: string): string {
  return fileURLToPath(uri);
}

/** LSP `textDocument/definition` — returns 0+ source locations. */
export async function lspDefinition(
  client: InitializedClient,
  filePath: string,
  line: number,
  character: number,
): Promise<SourceLocation[]> {
  client.didOpen(filePath);
  const params: DefinitionParams = {
    textDocument: { uri: uriOf(filePath) },
    position: { line, character },
  };
  const result = await client.sendRequest<Definition | LocationLink[] | null>(
    "textDocument/definition",
    params,
  );
  return locationsToArray(result);
}

/** LSP `textDocument/references` — returns all references in indexed projects. */
export async function lspReferences(
  client: InitializedClient,
  filePath: string,
  line: number,
  character: number,
  includeDeclaration = true,
): Promise<SourceLocation[]> {
  client.didOpen(filePath);
  const params: ReferenceParams = {
    textDocument: { uri: uriOf(filePath) },
    position: { line, character },
    context: { includeDeclaration },
  };
  const result = await client.sendRequest<Location[] | null>(
    "textDocument/references",
    params,
  );
  return locationsToArray(result);
}

/** LSP `textDocument/hover` — returns type info / docs at a position. */
export async function lspHover(
  client: InitializedClient,
  filePath: string,
  line: number,
  character: number,
): Promise<{ contents: string } | null> {
  client.didOpen(filePath);
  const params: HoverParams = {
    textDocument: { uri: uriOf(filePath) },
    position: { line, character },
  };
  const result = await client.sendRequest<Hover | null>(
    "textDocument/hover",
    params,
  );
  if (!result) return null;
  const contents = hoverContentsToString(result.contents);
  return { contents };
}

/** LSP `textDocument/documentSymbol` — returns top-level + nested symbols. */
export async function lspDocumentSymbol(
  client: InitializedClient,
  filePath: string,
): Promise<ResolvedSymbol[]> {
  client.didOpen(filePath);
  const params: DocumentSymbolParams = {
    textDocument: { uri: uriOf(filePath) },
  };
  const result = await client.sendRequest<
    DocumentSymbol[] | SymbolInformation[] | null
  >("textDocument/documentSymbol", params);
  if (!result) return [];

  // Hierarchical case (DocumentSymbol[]).
  if (result.length > 0 && "range" in result[0] && "children" in result[0]) {
    return (result as DocumentSymbol[]).map((s) =>
      docSymbolToResolved(s, filePath),
    );
  }
  // Flat case (SymbolInformation[]).
  return (result as SymbolInformation[]).map((s) =>
    symInfoToResolved(s),
  );
}

function docSymbolToResolved(
  s: DocumentSymbol,
  filePath: string,
): ResolvedSymbol {
  return {
    name: s.name,
    kind: SYMBOL_KIND_NAMES[s.kind] ?? `kind-${s.kind}`,
    filePath,
    startLine: s.range.start.line,
    startCharacter: s.range.start.character,
    endLine: s.range.end.line,
    endCharacter: s.range.end.character,
    children: s.children?.map((c) => docSymbolToResolved(c, filePath)),
  };
}

function symInfoToResolved(s: SymbolInformation): ResolvedSymbol {
  return {
    name: s.name,
    kind: SYMBOL_KIND_NAMES[s.kind] ?? `kind-${s.kind}`,
    filePath: pathOf(s.location.uri),
    startLine: s.location.range.start.line,
    startCharacter: s.location.range.start.character,
    endLine: s.location.range.end.line,
    endCharacter: s.location.range.end.character,
  };
}

function locationsToArray(
  result: Definition | LocationLink[] | null,
): SourceLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out: SourceLocation[] = [];
  for (const item of arr) {
    if ("targetUri" in item) {
      // LocationLink
      out.push({
        filePath: pathOf(item.targetUri),
        line: item.targetSelectionRange.start.line,
        character: item.targetSelectionRange.start.character,
        endLine: item.targetSelectionRange.end.line,
        endCharacter: item.targetSelectionRange.end.character,
      });
    } else {
      // Location
      out.push({
        filePath: pathOf(item.uri),
        line: item.range.start.line,
        character: item.range.start.character,
        endLine: item.range.end.line,
        endCharacter: item.range.end.character,
      });
    }
  }
  return out;
}

function hoverContentsToString(c: Hover["contents"]): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === "string" ? part : part.value))
      .join("\n");
  }
  if ("value" in c) return c.value;
  return "";
}
