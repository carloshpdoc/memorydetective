/**
 * Types shared across parsers and tools.
 */

export interface LeaksHeader {
  hardwareModel?: string;
  process?: string;
  pid?: number;
  identifier?: string;
  version?: string;
  platform?: string;
  osVersion?: string;
  dateTime?: string;
  physicalFootprint?: string;
  physicalFootprintPeak?: string;
}

export interface LeaksTotals {
  nodesMalloced?: number;
  totalKB?: number;
  leakCount: number;
  totalLeakedBytes: number;
}

export type RetainKind = "__strong" | "weak" | "unowned" | "plain";

export interface CycleNode {
  /** Live count attached to this node (may be undefined for CYCLE BACK terminators). */
  count?: number;
  /** Human-readable size, e.g. "56.9K" / "32 bytes". */
  size?: string;
  /** Property/path that points to this object from its parent (e.g. "__strong _viewModel.wrappedValue"). */
  edge?: string;
  /** Strong/weak/unowned hint when explicit; otherwise "plain". */
  retainKind: RetainKind;
  /** Class name without `<...>` brackets, e.g. "DetailViewModel". May be empty for `0xADDR [SIZE]` style. */
  className: string;
  /** Hex address as it appeared, e.g. "0x15a9f1e00". */
  address: string;
  /** Instance size in bytes if shown in `[N]`. */
  instanceSize?: number;
  /** True when the line begins/contains "ROOT CYCLE". */
  isRootCycle: boolean;
  /** True when the line is a "CYCLE BACK TO" terminator. */
  isCycleBack: boolean;
  /** Indentation level (raw leading-space count) — useful for diagnostics. */
  indent: number;
  /** Children nested at deeper indentation. */
  children: CycleNode[];
}

export interface LeaksReport {
  header: LeaksHeader;
  totals: LeaksTotals;
  /** Top-level cycles (and standalone leaks) as parsed. */
  cycles: CycleNode[];
  /** True if the report contains zero ROOT CYCLE entries (independent of leakCount, since plain leaks may exist). */
  hasNoCycles: boolean;
}

/**
 * Disambiguation of why a data section is empty or missing on a tool
 * response. Replaces the older convention of "empty = no data found" which
 * collapses three very different cases together.
 *
 * - `available`: data was exported and parsed. Empty arrays under this status
 *   mean the trace genuinely had no rows for the section (e.g. no hang
 *   events during the recording window).
 * - `partial`: export started but did not finish. Typical cause is the Phase
 *   1.4 xctrace timeout wrapper firing on a wedged recording. The data in
 *   the response is a partial snapshot of what was flushed.
 * - `not_exportable`: a GUI track exists in Instruments.app but `xcrun
 *   xctrace export` has no exportable table schema for it on this OS. This
 *   is an Apple-side limitation; the only recovery is to use Instruments.app
 *   directly for that data family. Surfaced specifically so the agent does
 *   not branch on "empty" as "no problem".
 * - `not_present`: the requested table schema is simply not in the trace
 *   bundle. Either the recording did not include that instrument template,
 *   or the section is genuinely empty at the trace-bundle level. Different
 *   from `not_exportable` because the data does not exist in the trace at
 *   all, not just "exists but cannot be read".
 */
export type DataStatus =
  | "available"
  | "partial"
  | "not_exportable"
  | "not_present";

/**
 * v1.14 item I. Unified per-area status surface across trace analyzers.
 *
 * Pre-v1.14 each analyzer had its own variation: `status: DataStatus`,
 * an optional `notice` string for the SIGSEGV path, and ad-hoc fields
 * for things like time-profile's workaround text. Agents had to know
 * each shape to branch correctly. The unified `supportStatus[]` puts
 * everything in one array of records so an LLM driver can iterate over
 * the result without knowing the analyzer's history.
 *
 * Mirrors XcodeTraceMCP's `supportStatus[]` shape so cross-tool
 * tooling can be consistent. Old `status` / `notice` fields stay on
 * each analyzer's result as deprecated aliases for backwards compat;
 * we'll drop them in a future major bump.
 *
 * `failed` is reserved for hard exceptions caught during the analyze
 * step, distinct from `not_exportable` (xctrace ran but refused) and
 * `not_present` (schema absent from the trace TOC).
 */
/**
 * Known kinds memorydetective emits today. Exported as a runtime constant
 * so callers can iterate or validate; in TypeScript context, prefer the
 * `SupportStatusKind` type alias below (which is open to arbitrary strings
 * so downstream consumers can add their own kinds without a memorydetective
 * type bump).
 *
 * v1.18 D-01: pre-v1.18 `SupportStatusKind` was a closed TS literal union,
 * which forced a breaking type change every time we added a kind (e.g.
 * v1.18 adds 4 MetricKit kinds). The open-enum pattern below keeps inline
 * literal autocomplete + typo detection (via the `Known` alias used by all
 * internal call sites) while letting external code pass any string.
 */
export const SUPPORT_STATUS_KINDS = [
  "potential-hangs",
  "hang-risks",
  "animation-hitches",
  "time-profile",
  "allocations",
  "app-launch",
  "network-connections",
  "memory-footprint",
  "energy-impact",
  "leak-events",
] as const;

/** Tight union of the kinds memorydetective itself emits. Used internally so
 *  a typo on a literal still fails the build. */
export type KnownSupportStatusKind = (typeof SUPPORT_STATUS_KINDS)[number];

/**
 * The kind tag on a {@link SupportStatus} entry. Open by design: known
 * memorydetective kinds (see {@link SUPPORT_STATUS_KINDS}) get autocomplete
 * and typo-checking; arbitrary strings (e.g. a future analyzer not yet
 * registered, or a downstream tool extending the surface) are accepted
 * without a memorydetective type bump.
 *
 * The `(string & {})` intersection is the canonical TS pattern that
 * preserves union autocomplete while widening to plain `string`.
 */
export type SupportStatusKind = KnownSupportStatusKind | (string & {});

/**
 * v1.18 D-02. Optional second argument shared by every trace-side analyzer.
 *
 * The orchestrator pattern: a higher-level caller (e.g. `summarizeTrace`)
 * runs `xctrace --toc` once via `fetchDiscoveredSchemasWithStatus`, then
 * passes the resulting schemas map to every analyzer it fans out to.
 * Each analyzer skips its own TOC fetch when this is present.
 *
 * Direct callers (the MCP tool surface, single-tool invocations) leave
 * this unset and pay the one-shot TOC fetch as before. No behavior change
 * for them.
 *
 * The `discoveredSchemas` keys are {@link SchemaFamily} values from
 * `src/parsers/schemaDiscovery.ts` (declared as `string` here to avoid
 * coupling the types layer to the parsers layer). Missing keys fall back
 * to canonical schema names so partial caches still work.
 */
export interface AnalyzeTraceOptions {
  discoveredSchemas?: Partial<Record<string, string>>;
}

export interface SupportStatus {
  kind: SupportStatusKind;
  status: "available" | "partial" | "not_exportable" | "not_present" | "failed";
  /** Free-text reason: workaround tip, xctrace stderr snippet, etc. */
  reason?: string;
  /** Schema names this entry sourced from (e.g. ["potential-hangs", "hang-risks"]). */
  sourceSchemas?: string[];
}

/**
 * HATEOAS-style hint that an LLM agent can chain after the current tool's
 * result. We pre-populate `args` from the current response so the agent can
 * call the next tool with one fewer inference step. The agent is free to
 * adapt or ignore. These are suggestions, not commands.
 */
export interface NextCallSuggestion {
  /** Name of the tool to call next. */
  tool: string;
  /** Pre-populated arguments based on the current result. */
  args: Record<string, unknown>;
  /** One-sentence rationale: why this next call advances the investigation. */
  why: string;
}
