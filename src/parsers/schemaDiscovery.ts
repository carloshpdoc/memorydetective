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
  const { schemas } = await fetchDiscoveredSchemasWithStatus(
    runCommand,
    tracePath,
    families,
  );
  return schemas;
}

/**
 * v1.18 D-02. Cache-aware schema resolution for the trace analyzers.
 *
 * When the caller already has a `discoveredSchemas` map (typically because
 * a higher-level orchestrator like `summarizeTrace` ran discovery once up
 * front and is fanning out to multiple analyzers in parallel), each analyzer
 * uses the cached entries instead of paying the `xctrace --toc` cost again.
 *
 * Pre-v1.18 every analyzer ran its own `xctrace --toc`. `summarizeTrace`
 * fan-outs to 6 analyzers, so the TOC was fetched 6 times for one trace.
 * Measured penalty: +600-3000ms wall-clock on real Apple traces (xctrace
 * cold-start dominated). With this helper + a single up-front discovery
 * call, the penalty drops to a single fetch.
 *
 * When `cached` is `undefined`, falls back to {@link fetchDiscoveredSchemas}
 * (the cold path) so direct callers that do not orchestrate keep working.
 *
 * When `cached` is provided but missing a family, the canonical name from
 * {@link CANONICAL_SCHEMA_NAME} is used (same fallback as the cold path's
 * pattern-not-matched branch). This keeps the analyzer pipeline working
 * even when the orchestrator forgot to discover a family.
 *
 * Mirrors the optional-input pattern used elsewhere in the codebase
 * (e.g. `analyzeHangs.hangRisksXml`): one path that wraps the
 * runtime call, one that takes pre-fetched data.
 */
export async function resolveSchemasForAnalyzer<F extends SchemaFamily>(
  runCommand: SchemaDiscoveryRunner,
  tracePath: string,
  families: readonly F[],
  cached?: Partial<Record<string, string>>,
): Promise<Record<F, string>> {
  if (cached) {
    const out = {} as Record<F, string>;
    for (const f of families) {
      out[f] = cached[f] ?? CANONICAL_SCHEMA_NAME[f];
    }
    return out;
  }
  return fetchDiscoveredSchemas(runCommand, tracePath, families);
}

/**
 * v1.17 B-06. Same as {@link fetchDiscoveredSchemas} but also returns a
 * discovery status so callers can surface "we fell back" via the unified
 * `supportStatus[]` instead of silently using canonical names.
 *
 * Status values:
 *
 * - `ok`: TOC fetched, pattern match succeeded for at least one family.
 *   (When a specific family does not match, the canonical name is still
 *   returned for it, but the overall status is still `ok` because the TOC
 *   itself was readable.)
 * - `failed`: `xctrace --toc` returned non-zero, or threw, or returned
 *   empty stdout. `schemas` are all canonical fallbacks.
 *
 * The legacy `fetchDiscoveredSchemas` keeps its existing silent-fallback
 * contract for callers that do not care.
 */
export interface SchemaDiscoveryStatus<F extends SchemaFamily> {
  schemas: Record<F, string>;
  status: "ok" | "failed";
  /** When status is `failed`, a short reason suitable for `supportStatus.reason`. */
  reason?: string;
}

export async function fetchDiscoveredSchemasWithStatus<F extends SchemaFamily>(
  runCommand: SchemaDiscoveryRunner,
  tracePath: string,
  families: readonly F[],
): Promise<SchemaDiscoveryStatus<F>> {
  const fallback = (): Record<F, string> => {
    const out = {} as Record<F, string>;
    for (const f of families) out[f] = CANONICAL_SCHEMA_NAME[f];
    return out;
  };
  try {
    const result = await runCommand(
      "xcrun",
      ["xctrace", "export", "--input", tracePath, "--toc"],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      const reason =
        `xctrace --toc failed (code ${result.code}): ` +
        (result.stderr.trim() || result.stdout.trim() || "<no output>");
      warnSchemaDiscoveryOnce(tracePath, reason);
      return { schemas: fallback(), status: "failed", reason };
    }
    if (!result.stdout.trim()) {
      const reason = "xctrace --toc returned empty stdout";
      warnSchemaDiscoveryOnce(tracePath, reason);
      return { schemas: fallback(), status: "failed", reason };
    }
    return { schemas: discoverSchemas(result.stdout, families), status: "ok" };
  } catch (err) {
    const reason = `xctrace --toc threw: ${(err as Error)?.message ?? String(err)}`;
    warnSchemaDiscoveryOnce(tracePath, reason);
    return { schemas: fallback(), status: "failed", reason };
  }
}

const schemaDiscoveryWarnings = new Set<string>();
function warnSchemaDiscoveryOnce(tracePath: string, reason: string): void {
  const key = `${tracePath}:${reason}`;
  if (schemaDiscoveryWarnings.has(key)) return;
  schemaDiscoveryWarnings.add(key);
  // Respect the global stderr-mute used elsewhere in the codebase.
  if (process.env.MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY) return;
  process.stderr.write(
    `[memorydetective] schemaDiscovery: ${reason} (path: ${tracePath}). ` +
      `Analyzers will use canonical schema names; results may be stale on traces that renamed schemas.\n`,
  );
}

/** Test hook — clears the one-time warning dedupe. */
export function _resetSchemaDiscoveryWarningsForTests(): void {
  schemaDiscoveryWarnings.clear();
}
