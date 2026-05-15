/**
 * Pattern-matching schema discovery for `.trace` bundles. v1.14 item B.
 *
 * Pre-v1.14 the trace-side analyzers hardcoded their schema names
 * (`potential-hangs`, `time-profile`, etc.) into the xpath queries
 * (`/trace-toc/run/data/table[@schema="X"]`). Robust as long as Apple
 * never renames a schema. When they DO rename one (or split into
 * `hang-risks` alongside `potential-hangs`, see item F), the analyzer
 * silently returns "schema absent" against a trace that has the data
 * just under a different name.
 *
 * XcodeTraceMCP solves this with a regex-pattern lookup: each schema
 * "family" maps to a list of regex patterns; discovery walks the TOC,
 * matches schema names against the patterns, returns the first hit.
 * Falls through gracefully when nothing matches (callers fall back to
 * the hardcoded canonical name).
 *
 * The patterns mirror XcodeTraceMCP's `SCHEMA_PATTERNS` plus the
 * families memorydetective already analyzes:
 * `hangs`, `animation-hitches`, `time-profile`, `allocations`,
 * `app-launch`, `memory`, `network`, `energy`, `leaks`.
 */

export const SCHEMA_FAMILIES = {
  hangs: [/potential-hangs/i],
  "hang-risks": [/hang-risks?/i],
  "animation-hitches": [/animation-hitches?/i, /hitches?/i],
  "time-profile": [/^time-profile$/i],
  "time-sample": [/^time-samples?$/i],
  allocations: [/^allocations?$/i, /\balloc\b/i, /\bmalloc\b/i],
  "app-launch": [/app-launch/i, /launch-period/i],
  memory: [/memory-footprint/i, /resident-memory/i, /\bvm-regions?\b/i],
  network: [/network-connections?/i, /\bnetwork\b/i, /\bhttp\b/i],
  energy: [/energy-impact/i, /power-draw/i, /\bwakeups?\b/i, /\bbattery\b/i],
  leaks: [/^leaks?$/i, /leak-events?/i],
} as const satisfies Record<string, RegExp[]>;

export type SchemaFamily = keyof typeof SCHEMA_FAMILIES;

/** Canonical schema name we hardcoded before v1.14. Used as the fallback
 *  when discovery does not match anything in the TOC. */
export const CANONICAL_SCHEMA_NAME: Record<SchemaFamily, string> = {
  hangs: "potential-hangs",
  "hang-risks": "hang-risks",
  "animation-hitches": "animation-hitches",
  "time-profile": "time-profile",
  "time-sample": "time-sample",
  allocations: "allocations",
  "app-launch": "app-launch",
  memory: "memory-footprint",
  network: "network-connections",
  energy: "energy-impact",
  leaks: "leaks",
};

/**
 * Pure: extract all `<table schema="X" .../>` names from a TOC XML
 * string. Returns the names in document order, including duplicates
 * (a trace can have the same schema appear with different filter
 * attributes; the caller decides what to do with duplicates).
 *
 * Accepts both self-closing `<table schema="X"/>` (Apple's --toc shape)
 * and open-close `<table schema="X">...</table>` (test fixtures).
 */
export function extractSchemaNamesFromToc(tocXml: string): string[] {
  const out: string[] = [];
  // Self-closing form.
  const selfClose = /<table\b[^>]*\bschema="([^"]+)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = selfClose.exec(tocXml)) !== null) out.push(m[1]);
  // Open-close form. Walk separately; the two regex passes can
  // double-count if the same `<table>` is matched twice, but the
  // patterns are mutually exclusive (`/>` vs `>...</table>`) so this is
  // safe in practice.
  const openClose = /<table\b[^>]*\bschema="([^"]+)"[^>]*>[\s\S]*?<\/table>/g;
  while ((m = openClose.exec(tocXml)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Pure: find the schema name in the TOC that matches the requested
 * family. Returns the FIRST match in document order so deterministic
 * across runs. Falls back to the canonical hardcoded name when no
 * pattern matches; never returns null so callers can plug the result
 * straight into an xpath query.
 *
 * The hardcoded fallback preserves pre-v1.14 behavior: if the trace
 * uses the canonical name, the xpath still works because the canonical
 * name itself matches its own family pattern.
 */
export function discoverSchema(
  tocXml: string,
  family: SchemaFamily,
): string {
  const names = extractSchemaNamesFromToc(tocXml);
  const patterns = SCHEMA_FAMILIES[family];
  for (const name of names) {
    for (const pat of patterns) {
      if (pat.test(name)) return name;
    }
  }
  return CANONICAL_SCHEMA_NAME[family];
}

/**
 * Pure: bulk variant. Resolves multiple families against the same TOC
 * in one pass. Useful when an analyzer needs more than one schema
 * (e.g. `analyzeHangs` reading both `hangs` and `hang-risks`).
 */
export function discoverSchemas<F extends SchemaFamily>(
  tocXml: string,
  families: readonly F[],
): Record<F, string> {
  const out = {} as Record<F, string>;
  const names = extractSchemaNamesFromToc(tocXml);
  for (const family of families) {
    const patterns = SCHEMA_FAMILIES[family];
    let matched: string | null = null;
    for (const name of names) {
      for (const pat of patterns) {
        if (pat.test(name)) {
          matched = name;
          break;
        }
      }
      if (matched) break;
    }
    out[family] = matched ?? CANONICAL_SCHEMA_NAME[family];
  }
  return out;
}

/**
 * Async wrapper for the trace-side analyzers. Runs `xcrun xctrace
 * export --input <trace> --toc` once and applies {@link discoverSchemas}
 * to the result. Failures (xctrace error, parse glitch, missing trace)
 * fall back to the canonical hardcoded names so the analyzer pipeline
 * still works at pre-v1.14 behavior. v1.14 item B.
 *
 * `runCommand` is injected (not imported from runtime/exec) to keep
 * this module dependency-free and unit-testable without spawning
 * processes.
 */
export interface SchemaDiscoveryRunner {
  (
    cmd: string,
    args: string[],
    options: { timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function fetchDiscoveredSchemas<F extends SchemaFamily>(
  runCommand: SchemaDiscoveryRunner,
  tracePath: string,
  families: readonly F[],
): Promise<Record<F, string>> {
  try {
    const result = await runCommand(
      "xcrun",
      ["xctrace", "export", "--input", tracePath, "--toc"],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      // TOC fetch failed; return canonical fallback.
      const out = {} as Record<F, string>;
      for (const f of families) out[f] = CANONICAL_SCHEMA_NAME[f];
      return out;
    }
    return discoverSchemas(result.stdout, families);
  } catch {
    const out = {} as Record<F, string>;
    for (const f of families) out[f] = CANONICAL_SCHEMA_NAME[f];
    return out;
  }
}
