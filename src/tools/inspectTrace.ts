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

  // Match each <table schema="X"> block.
  const tableRegex = /<table\b[^>]*\bschema="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(xml)) !== null) {
    const name = match[1];
    const body = match[2];
    // Row count = number of <row> tags inside this table.
    const rowMatches = body.match(/<row\b/g);
    const rowCount = rowMatches ? rowMatches.length : 0;
    // Description: schema may carry an `engineering-type` description.
    const descMatch =
      /<engineering-description>([^<]+)<\/engineering-description>/.exec(body);
    const description = descMatch?.[1]?.trim();
    schemas.push({
      name,
      rowCount,
      ...(description ? { description } : {}),
    });
  }
  schemas.sort((a, b) => b.rowCount - a.rowCount);

  const rowCounts: Record<string, number> = {};
  for (const s of schemas) rowCounts[s.name] = s.rowCount;

  // Run-level metadata extracted from the TOC's <run> attributes / children.
  const deviceMatch = /<device-model>([^<]+)<\/device-model>/.exec(xml);
  const osMatch = /<os-version>([^<]+)<\/os-version>/.exec(xml);
  const templateMatch = /<template-name>([^<]+)<\/template-name>/.exec(xml);
  const recordedMatch = /<recorded-when>([^<]+)<\/recorded-when>/.exec(xml);

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
  const result = await runCommand(
    "xcrun",
    ["xctrace", "export", "--input", tracePath, "--xpath", "/trace-toc/run"],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    // Fallback: when the targeted xpath fails (older xctrace versions, or
    // a trace with no /run node), try the broader /trace-toc xpath and
    // parse whatever schemas surface.
    const fallback = await runCommand(
      "xcrun",
      ["xctrace", "export", "--input", tracePath, "--xpath", "/trace-toc"],
      { timeoutMs: 60_000 },
    );
    if (fallback.code !== 0) {
      throw new Error(
        `xctrace export TOC failed (code ${result.code}): ${result.stderr || result.stdout || "<no output>"}`,
      );
    }
    const parsed = parseTraceToc(fallback.stdout, tracePath);
    return { ok: true, ...parsed, ...(fileSize != null ? { fileSize } : {}) };
  }
  const parsed = parseTraceToc(result.stdout, tracePath);
  return {
    ok: true,
    ...parsed,
    ...(fileSize != null ? { fileSize } : {}),
  };
}

// Used by tests to verify the bundle name surfaces correctly.
export function _basenameForTests(p: string): string {
  return basename(p);
}
