/**
 * `inspectTrace`: orientation tool for `.trace` bundles. Lists which
 * schemas are present, how many rows each carries, the time range, the
 * device model, the template name, and a pre-baked `suggestedNextCalls`
 * pointing at the matching analyzer for each populated schema.
 *
 * The use case is "I have a .trace, what's worth looking at?". Without
 * this tool the caller has to either pick an `analyze*` blindly or
 * read the full xctrace export which is wasteful. The MCP-native
 * agent loop benefits the most: discovery costs 1 call instead of 5.
 *
 * Implementation notes:
 *
 * - Single `xctrace export --xpath '/trace-toc/run'` invocation. Returns
 *   the run metadata + all table schemas in one shot. We parse just enough
 *   to enumerate schemas + count rows; we deliberately do NOT parse row
 *   contents (the downstream `analyze*` tools do that).
 *
 * - Time range: derived from the schema-level `start-time` / `end-time`
 *   attributes when present; falls back to the run's `<recorded-when>`
 *   timestamp string when not parseable.
 *
 * - The 5 known schemas (potential-hangs, animation-hitches, time-profile,
 *   allocations, app-launch) map 1:1 to the existing analyzers. Any
 *   schema NOT in that map is still surfaced in the `schemas[]` list (so
 *   the user sees it) but does not contribute a `suggestedNextCalls`
 *   entry — there's no analyzer to chain into.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath, basename } from "node:path";
import { statSync } from "node:fs";
import { runCommand } from "../runtime/exec.js";
import type { NextCallSuggestion } from "../types.js";

export const inspectTraceSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle (output of `xcrun xctrace record` or Instruments).",
    ),
});

export type InspectTraceInput = z.infer<typeof inspectTraceSchema>;

export interface TraceSchemaSummary {
  /** Schema name (e.g. "potential-hangs", "time-profile"). */
  name: string;
  /** Number of rows in this schema's table. 0 means the schema is present in the trace but carries no data. */
  rowCount: number;
  /** Engineering description when the schema declares one; absent otherwise. */
  description?: string;
}

export interface InspectTraceResult {
  ok: boolean;
  tracePath: string;
  /** All schemas present in the trace TOC, ranked by rowCount desc. */
  schemas: TraceSchemaSummary[];
  /** Convenience: schemaName -> rowCount, same data as `schemas[]` in object form. */
  rowCounts: Record<string, number>;
  /** Trace file size in bytes (the .trace bundle is a directory; reports the directory entry size, not recursive). */
  fileSize?: number;
  /** Device model name when the trace's run metadata exposes one. */
  deviceModel?: string;
  /** OS version when present. */
  osVersion?: string;
  /** Template name (e.g. "Time Profiler", "Allocations"). */
  templateName?: string;
  /** Recording timestamp string (raw, unparsed). */
  recordedWhen?: string;
  /** Plain-English orientation diagnosis. */
  diagnosis: string;
  /** Pipeline hints based on which analyzers have data to chain into. */
  suggestedNextCalls: NextCallSuggestion[];
}

/**
 * Map from xctrace schema name to the analyzer that consumes it. Drives
 * `suggestedNextCalls[]` so the agent doesn't have to know the mapping.
 */
const SCHEMA_TO_ANALYZER: Record<
  string,
  { tool: string; description: string }
> = {
  "potential-hangs": {
    tool: "analyzeHangs",
    description:
      "Parses the hangs table and returns Hang vs Microhang counts plus the longest events. Pair with `topFramesByHangStartNs` to classify main-thread violations.",
  },
  "animation-hitches": {
    tool: "analyzeAnimationHitches",
    description:
      "Parses the hitches table and reports by-type counts plus the count of user-perceptible (>100ms) hitches.",
  },
  "time-profile": {
    tool: "analyzeTimeProfile",
    description:
      "Returns top symbols by sample count. Reports a structured workaroundNotice when xctrace SIGSEGVs on heavy unsymbolicated traces.",
  },
  allocations: {
    tool: "analyzeAllocations",
    description:
      "Returns per-category aggregates (cumulative bytes, allocation count, transient/persistent/mixed lifecycle classification) plus top allocators.",
  },
  "app-launch": {
    tool: "analyzeAppLaunch",
    description:
      "Returns cold/warm launch type plus per-phase breakdown (process-creation, dyld-init, ObjC-init, AppDelegate, first-frame).",
  },
  "network-connections": {
    tool: "analyzeNetworkActivity",
    description:
      "Per-request URL / host / method / status / response time / bytes. Top-N by duration and by bytes plus per-host aggregates.",
  },
  "memory-footprint": {
    tool: "analyzeMemoryFootprint",
    description:
      "Peak resident / dirty / virtual bytes plus per-sample timeline. The OOM-kill discriminator on iOS.",
  },
  "energy-impact": {
    tool: "analyzeEnergyImpact",
    description:
      "Per-sample bucket (idle / passive / active / high), aggregate wakeups, active ratio, top samples by energy cost.",
  },
};

/** Pure: parse the trace-toc XML payload into an inspection result. */
export function parseTraceToc(
  xml: string,
  tracePath: string,
): Omit<InspectTraceResult, "ok" | "fileSize"> {
  const schemas: TraceSchemaSummary[] = [];
  // We use lightweight regex parsing here instead of fast-xml-parser
  // because the TOC XML is simple, well-defined, and the existing
  // parseXctraceXml is row-content focused (parses through schemas).
  // Surfacing only schema metadata + row counts is faster and avoids
  // pulling row payloads into memory for traces that have hundreds of
  // thousands of rows.
  //
  // Apple's `xctrace export --toc` emits self-closing `<table schema="X"/>`
  // elements (the TOC carries column definitions only, no rows). Older
  // synthetic fixtures and some xctrace versions use the open-close form
  // `<table schema="X">...<row/>...</table>`. We match BOTH and fall back
  // to row-counting from the body when present.

  // Open-close form first: `<table schema="X">body</table>`.
  const openCloseRegex = /<table\b[^>]*\bschema="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g;
  const seenRanges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = openCloseRegex.exec(xml)) !== null) {
    const name = match[1];
    const body = match[2];
    seenRanges.push([match.index, match.index + match[0].length]);
    const rowMatches = body.match(/<row\b/g);
    const rowCount = rowMatches ? rowMatches.length : 0;
    const descMatch =
      /<engineering-description>([^<]+)<\/engineering-description>/.exec(body);
    const description = descMatch?.[1]?.trim();
    schemas.push({
      name,
      rowCount,
      ...(description ? { description } : {}),
    });
  }

  // Self-closing form: `<table schema="X" .../>`. Skip ranges already
  // matched by openCloseRegex so we don't double-count when a body contains
  // nested self-closing tables (unlikely but defensive).
  const selfCloseRegex = /<table\b[^>]*\bschema="([^"]+)"[^>]*\/>/g;
  while ((match = selfCloseRegex.exec(xml)) !== null) {
    const start = match.index;
    if (seenRanges.some(([s, e]) => start >= s && start < e)) continue;
    const name = match[1];
    schemas.push({
      name,
      rowCount: 0, // TOC self-closing tables carry no rows; rowCount must be filled by the async row-counting step in inspectTrace().
    });
  }

  schemas.sort((a, b) => b.rowCount - a.rowCount);

  const rowCounts: Record<string, number> = {};
  for (const s of schemas) rowCounts[s.name] = s.rowCount;

  // Run-level metadata extracted from the TOC's <run> attributes / children.
  // Apple's --toc output exposes device + OS as ATTRIBUTES on <device .../>
  // and uses <start-date> instead of <recorded-when>. We try the Apple
  // attribute form first, fall back to legacy text-element form for
  // synthetic fixtures.
  const deviceAttrMatch = /<device\b[^>]*\bmodel="([^"]+)"/.exec(xml);
  const deviceMatch =
    deviceAttrMatch ?? /<device-model>([^<]+)<\/device-model>/.exec(xml);
  const osAttrMatch = /<device\b[^>]*\bos-version="([^"]+)"/.exec(xml);
  const osMatch = osAttrMatch ?? /<os-version>([^<]+)<\/os-version>/.exec(xml);
  const templateMatch = /<template-name>([^<]+)<\/template-name>/.exec(xml);
  const recordedAttrMatch = /<start-date>([^<]+)<\/start-date>/.exec(xml);
  const recordedMatch =
    recordedAttrMatch ?? /<recorded-when>([^<]+)<\/recorded-when>/.exec(xml);

  const suggestedNextCalls: NextCallSuggestion[] = [];
  for (const s of schemas) {
    if (s.rowCount === 0) continue;
    const mapping = SCHEMA_TO_ANALYZER[s.name];
    if (!mapping) continue;
    suggestedNextCalls.push({
      tool: mapping.tool,
      args: { tracePath },
      why: `${s.rowCount.toLocaleString()} rows in the ${s.name} schema. ${mapping.description}`,
    });
  }

  return {
    tracePath,
    schemas,
    rowCounts,
    ...(deviceMatch ? { deviceModel: deviceMatch[1].trim() } : {}),
    ...(osMatch ? { osVersion: osMatch[1].trim() } : {}),
    ...(templateMatch ? { templateName: templateMatch[1].trim() } : {}),
    ...(recordedMatch ? { recordedWhen: recordedMatch[1].trim() } : {}),
    diagnosis: buildDiagnosis(schemas, templateMatch?.[1]?.trim()),
    suggestedNextCalls,
  };
}

function buildDiagnosis(
  schemas: TraceSchemaSummary[],
  templateName: string | undefined,
): string {
  if (schemas.length === 0) {
    return "Trace TOC reports no schemas. The trace may be malformed, empty, or recorded with a custom template the parser does not recognize. Inspect via Instruments.app to confirm.";
  }
  const populated = schemas.filter((s) => s.rowCount > 0);
  const topSchema = populated[0];
  const parts: string[] = [];
  if (templateName) parts.push(`Template: \`${templateName}\`.`);
  parts.push(
    `${schemas.length} schema${schemas.length === 1 ? "" : "s"} in the TOC, ${populated.length} with data.`,
  );
  if (topSchema) {
    parts.push(
      `Heaviest: \`${topSchema.name}\` with ${topSchema.rowCount.toLocaleString()} rows.`,
    );
  }
  if (populated.length === 0) {
    parts.push(
      "All tables are empty. Trace likely recorded zero events; double-check the recording duration and active template.",
    );
  }
  return parts.join(" ");
}

/**
 * Count `<row>` elements for a single schema by running a targeted xpath
 * query. Used by `inspectTrace` to fill in row counts that the bare
 * `--toc` output omits (Apple's TOC emits self-closing `<table/>` elements
 * with column metadata only, no rows).
 *
 * Bounded by a 60s xctrace timeout each. On any failure we treat as zero
 * rows rather than throwing: an empty result is the same semantic outcome
 * as a missing schema, and downstream `summarizeTrace` already handles
 * `rowCount === 0` as "schema-absent".
 */
async function countSchemaRows(
  tracePath: string,
  schemaName: string,
): Promise<number> {
  try {
    const result = await runCommand(
      "xcrun",
      [
        "xctrace",
        "export",
        "--input",
        tracePath,
        "--xpath",
        `/trace-toc/run/data/table[@schema="${schemaName}"]`,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) return 0;
    const rowMatches = result.stdout.match(/<row\b/g);
    return rowMatches ? rowMatches.length : 0;
  } catch {
    return 0;
  }
}

export async function inspectTrace(
  input: InspectTraceInput,
): Promise<InspectTraceResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  let fileSize: number | undefined;
  try {
    fileSize = statSync(tracePath).size;
  } catch {
    // The bundle is a directory on macOS; stat reports the directory inode
    // size, which is fine for orientation. Failures are non-fatal.
  }
  // Apple's `xctrace export --toc` is the canonical schema-discovery surface.
  // The previously-used `--xpath '/trace-toc/run'` returns "no content to
  // export" against real Apple-produced .trace bundles (validated 2026-05-15
  // against wishlist-tti-device.trace). The --toc flag returns the full
  // table-of-contents XML including all `<table schema="..."/>` elements.
  const result = await runCommand(
    "xcrun",
    ["xctrace", "export", "--input", tracePath, "--toc"],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xctrace export --toc failed (code ${result.code}): ${result.stderr || result.stdout || "<no output>"}`,
    );
  }
  const parsed = parseTraceToc(result.stdout, tracePath);

  // The TOC carries schema NAMES + column metadata but no rows. Fill in
  // row counts for the schemas an analyzer can consume (the ones in
  // SCHEMA_TO_ANALYZER) so `summarizeTrace` can decide which analyzers to
  // run. Other schemas (tick, kdebug, life-cycle-period, etc.) are left at
  // rowCount=0; nothing downstream consumes them.
  const knownSchemas = Object.keys(SCHEMA_TO_ANALYZER);
  const schemasInTrace = new Set(parsed.schemas.map((s) => s.name));
  const schemasToCount = knownSchemas.filter((name) => schemasInTrace.has(name));
  const counts = await Promise.all(
    schemasToCount.map(async (name) => [name, await countSchemaRows(tracePath, name)] as const),
  );
  const rowCounts: Record<string, number> = { ...parsed.rowCounts };
  for (const [name, count] of counts) rowCounts[name] = count;
  const updatedSchemas = parsed.schemas.map((s) =>
    rowCounts[s.name] != null && rowCounts[s.name] !== s.rowCount
      ? { ...s, rowCount: rowCounts[s.name] }
      : s,
  );
  updatedSchemas.sort((a, b) => b.rowCount - a.rowCount);

  // Recompute suggestedNextCalls now that row counts are accurate.
  const suggestedNextCalls: NextCallSuggestion[] = [];
  for (const s of updatedSchemas) {
    if (s.rowCount === 0) continue;
    const mapping = SCHEMA_TO_ANALYZER[s.name];
    if (!mapping) continue;
    suggestedNextCalls.push({
      tool: mapping.tool,
      args: { tracePath },
      why: `${s.rowCount.toLocaleString()} rows in the ${s.name} schema. ${mapping.description}`,
    });
  }

  // Recompute diagnosis with accurate row counts.
  const diagnosis = buildDiagnosis(updatedSchemas, parsed.templateName);

  return {
    ok: true,
    ...parsed,
    schemas: updatedSchemas,
    rowCounts,
    suggestedNextCalls,
    diagnosis,
    ...(fileSize != null ? { fileSize } : {}),
  };
}

// Used by tests to verify the bundle name surfaces correctly.
export function _basenameForTests(p: string): string {
  return basename(p);
}
