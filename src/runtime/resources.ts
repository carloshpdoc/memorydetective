/**
 * MCP Resources surface — exposes the cycle-pattern catalog as browsable
 * read-only resources. Clients can list / read patterns without burning a
 * tool call (cheaper than `classifyCycle`'s incidental output).
 *
 * URI shape: `memorydetective://patterns/{patternId}`
 *
 * Each resource body is markdown — clients render it directly in the UI.
 */

import { PATTERNS } from "../tools/classifyCycle.js";

const URI_SCHEME = "memorydetective";
const PATTERNS_HOST = "patterns";

export interface PatternResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "text/markdown";
}

export interface PatternResourceBody {
  uri: string;
  mimeType: "text/markdown";
  text: string;
}

/** Build the resource list shown to clients via `resources/list`. */
export function listPatternResources(): PatternResource[] {
  return PATTERNS.map((p) => ({
    uri: patternUri(p.id),
    name: p.name,
    description: oneLineDescription(p),
    mimeType: "text/markdown" as const,
  }));
}

/** Resolve a pattern URI to a markdown body, or return null if unknown. */
export function readPatternResource(uri: string): PatternResourceBody | null {
  const id = patternIdFromUri(uri);
  if (!id) return null;
  const pattern = PATTERNS.find((p) => p.id === id);
  if (!pattern) return null;
  return {
    uri,
    mimeType: "text/markdown",
    text: renderPatternMarkdown(pattern),
  };
}

export function patternUri(patternId: string): string {
  return `${URI_SCHEME}://${PATTERNS_HOST}/${patternId}`;
}

export function patternIdFromUri(uri: string): string | null {
  const prefix = `${URI_SCHEME}://${PATTERNS_HOST}/`;
  if (!uri.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/** Single-line summary used as the resource list description. */
function oneLineDescription(p: { id: string; name: string }): string {
  // The full fixHint can be long; the list view should be scannable.
  return p.name;
}

/** Markdown body for `resources/read` responses. */
function renderPatternMarkdown(p: {
  id: string;
  name: string;
  fixHint: string;
}): string {
  return [
    `# ${p.name}`,
    "",
    `**Pattern ID:** \`${p.id}\``,
    "",
    "## Fix hint",
    "",
    p.fixHint,
    "",
    "---",
    "",
    "*This is a built-in pattern from the `memorydetective` cycle classifier. " +
      "When a `.memgraph` cycle matches this pattern, `classifyCycle` returns this fix hint " +
      "in its `primaryMatch.fixHint` field, and `verifyFix` can gate a cycle-semantic diff " +
      `against \`expectedPatternId: "${p.id}"\`.*`,
    "",
  ].join("\n");
}
