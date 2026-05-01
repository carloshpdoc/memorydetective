import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
} from "../parsers/xctraceXml.js";

export const analyzeAppLaunchSchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with the App Launch template (`xcrun xctrace record --template 'App Launch' --launch <bundleId>`).",
    ),
});

export type AnalyzeAppLaunchInput = z.infer<typeof analyzeAppLaunchSchema>;

/** Phases Apple breaks app launch into, ordered by occurrence. */
const PHASE_ORDER = [
  "process-creation",
  "dyld-init",
  "static-runtime-init",
  "objc-init",
  "appdelegate-init",
  "uikit-init",
  "first-frame-render",
] as const;

export interface PhaseEntry {
  /** Mnemonic phase name; matches PHASE_ORDER above when known. */
  phase: string;
  /** Display label as Instruments would render it. */
  label: string;
  durationMs: number;
  /** Percentage of total launch time spent in this phase. */
  percentOfTotal: number;
}

export interface AnalyzeAppLaunchResult {
  ok: boolean;
  tracePath: string;
  /** Total app launch time as reported by xctrace. */
  totalLaunchMs: number;
  /** "cold" or "warm" launch when discriminable; otherwise "unknown". */
  launchType: "cold" | "warm" | "unknown";
  /** Per-phase breakdown sorted by Apple's canonical order. */
  phases: PhaseEntry[];
  /** Phase that took the largest share of launch time. */
  slowestPhase?: PhaseEntry;
  diagnosis: string;
}

/** Pure: turn parsed XML into the structured result. */
export function analyzeAppLaunchFromXml(
  xml: string,
  tracePath: string,
): AnalyzeAppLaunchResult {
  const tables = parseXctraceXml(xml);
  const table = tables.find((t) => t.schema === "app-launch");
  if (!table) {
    return {
      ok: true,
      tracePath,
      totalLaunchMs: 0,
      launchType: "unknown",
      phases: [],
      diagnosis: "No app-launch table found in the trace.",
    };
  }

  // The app-launch schema can include rows describing per-phase durations and
  // a summary row with the total. xctrace varies the field shape across iOS
  // versions, so we cope with whichever fields turn up.
  const rawPhases: Array<{ phase: string; label: string; durationNs: number }> = [];
  let totalNs = 0;
  let launchType: AnalyzeAppLaunchResult["launchType"] = "unknown";

  for (const row of table.rows) {
    const phase =
      asFormatted(row.phase) ??
      asFormatted(row["phase-name"]) ??
      asFormatted(row.category) ??
      "unknown";
    const label =
      asFormatted(row["display-label"]) ??
      asFormatted(row.label) ??
      phase;
    const dn =
      asNumber(row.duration) ??
      asNumber(row["phase-duration"]) ??
      0;
    if (phase === "total" || phase === "launch-total") {
      totalNs = dn;
      const t = asFormatted(row["launch-type"]);
      if (t === "cold" || t === "warm") launchType = t;
      continue;
    }
    if (dn === 0) continue;
    rawPhases.push({ phase, label, durationNs: dn });
  }

  // If no explicit total row, sum the phases.
  if (totalNs === 0) {
    totalNs = rawPhases.reduce((sum, p) => sum + p.durationNs, 0);
  }

  const totalMs = totalNs / 1_000_000;

  const phases: PhaseEntry[] = rawPhases
    .map((p) => ({
      phase: p.phase,
      label: p.label,
      durationMs: p.durationNs / 1_000_000,
      percentOfTotal: totalNs > 0 ? (p.durationNs / totalNs) * 100 : 0,
    }))
    .sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase));

  const slowestPhase = phases.length === 0
    ? undefined
    : [...phases].sort((a, b) => b.durationMs - a.durationMs)[0];

  const diagnosis = buildDiagnosis(totalMs, launchType, slowestPhase);

  return {
    ok: true,
    tracePath,
    totalLaunchMs: totalMs,
    launchType,
    phases,
    slowestPhase,
    diagnosis,
  };
}

function phaseOrder(phase: string): number {
  const idx = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);
  return idx === -1 ? 999 : idx;
}

function buildDiagnosis(
  totalMs: number,
  launchType: AnalyzeAppLaunchResult["launchType"],
  slowest?: PhaseEntry,
): string {
  if (totalMs === 0) {
    return "No launch data found (recording may have started after launch completed).";
  }
  const typeLabel = launchType !== "unknown" ? `${launchType} launch` : "Launch";
  const parts = [`${typeLabel}: ${totalMs.toFixed(0)}ms total.`];
  if (slowest) {
    parts.push(
      `Slowest phase: ${slowest.label} (${slowest.durationMs.toFixed(0)}ms, ${slowest.percentOfTotal.toFixed(1)}% of total).`,
    );
  }
  if (totalMs > 1500) {
    parts.push("Total launch >1.5s — Apple's threshold for user-perceptible slowness.");
  }
  return parts.join(" ");
}

export async function analyzeAppLaunch(
  input: AnalyzeAppLaunchInput,
): Promise<AnalyzeAppLaunchResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const result = await runCommand(
    "xcrun",
    [
      "xctrace",
      "export",
      "--input",
      tracePath,
      "--xpath",
      '/trace-toc/run/data/table[@schema="app-launch"]',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `xctrace export failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return analyzeAppLaunchFromXml(result.stdout, tracePath);
}
