/**
 * `analyzeMetricKitPayload`: 42nd MCP tool (v1.18). The post-mortem
 * production-diagnostic lane.
 *
 * MetricKit (`MXMetricManager`) delivers `.mxdiagnostic` JSON payloads to a
 * directory readable by the next launch of the app, on real-device
 * TestFlight / App Store builds. Devs typically airdrop the file to their
 * Mac and want a structured summary without uploading to Sentry /
 * Crashlytics. No MCP server in the ecosystem covers this lane today
 * (researched 2026-05-17: XcodeBuildMCP, XcodeTraceMCP, Sentry Cocoa SDK
 * server-side ingestion only — no parser surface for dev tooling).
 *
 * This tool is a POST-MORTEM ANALYZER. It does not generate payloads
 * (simulator does not support MetricKit — Apple-side limitation). Inputs
 * are existing `.mxdiagnostic` files or directories of them.
 *
 * Three actionable outputs, in priority order:
 * 1. `crashCluster` — group by exception type + top frame, count, list
 *    affected app builds.
 * 2. `hangHotspots` — sorted by hang duration with the top frame.
 * 3. `cpuExceptions` + `diskWriteExceptions` — long tail of resource
 *    regressions.
 *
 * No symbolication in v1: ship raw `binaryUUID + offsetIntoBinaryTextSegment
 * + binaryName`. dSYM lookup is the Phase 8 v1.9 deferred item, separate
 * tool, separate release. Mirrors the staging pattern `analyzeMemgraph`
 * evolved through.
 */

import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import {
  parseMetricKitPayload,
  extractTopFrameLabel,
  metricKitTimeToMs,
  metricKitDiskToMB,
  type MetricKitPayload,
  type MetricKitDiagnostic,
} from "../parsers/metricKit.js";
import type {
  NextCallSuggestion,
  SupportStatus,
} from "../types.js";

// Note: kept as a plain z.object (no `.refine()`) so the MCP SDK can read
// `.shape` for tool registration. The "exactly one of payloadPath /
// payloadDir / payloadJson" invariant is enforced inside `readPayloads` at
// call time, where we throw a friendlier error pointing at the three input
// forms by name.
export const analyzeMetricKitPayloadSchema = z.object({
  payloadPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path to a single `.mxdiagnostic` file (the JSON Apple's MetricKit writes to the app's MetricKit directory on real-device builds).",
    ),
  payloadDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path to a directory containing one or more `.mxdiagnostic` files. The tool walks the dir non-recursively and aggregates findings across all payloads.",
    ),
  payloadJson: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Raw `.mxdiagnostic` JSON string. For in-memory callers and tests; if both `payloadPath` and `payloadJson` are provided, `payloadJson` wins.",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Cap on `crashCluster[]` / `hangHotspots[]` / `cpuExceptions[]` / `diskWriteExceptions[]` length. Default 10.",
    ),
  groupBy: z
    .enum(["exception-type", "binary", "top-frame"])
    .default("exception-type")
    .describe(
      "Clustering key for `crashCluster[]`. `exception-type` groups by exceptionType + signal (catches mass-crash on the same OS-level fault). `binary` groups by the top frame's binary name (catches crashes localized to one dylib/framework). `top-frame` groups by binary + offset (the most granular). Default `exception-type`.",
    ),
});

export type AnalyzeMetricKitPayloadInput = z.infer<
  typeof analyzeMetricKitPayloadSchema
>;

export interface CrashClusterEntry {
  /** Cluster key: exceptionType (numeric), signal (numeric), and (when groupBy=binary|top-frame) the binary or top frame string. */
  clusterKey: string;
  exceptionType?: number;
  signal?: number;
  terminationReason?: string;
  topFrame: string;
  /** Number of crash diagnostics that fell into this cluster across all payloads. */
  occurrences: number;
  affectedBuilds: string[];
  /** One representative frame so the caller has the raw `binaryUUID + offset` to symbolicate later if they have a dSYM. */
  sample: {
    binaryUUID?: string;
    binaryName?: string;
    offsetIntoBinaryTextSegment?: number;
  };
  /** Per-cluster schema version: when payloads in this cluster used multiple `version` values, all are listed. */
  payloadVersions: string[];
}

export interface HangHotspotEntry {
  hangDurationMs: number;
  topFrame: string;
  binaryName?: string;
  /** sampleCount on the deepest-root frame — Apple uses this to weight stacks. */
  sampleCount?: number;
  /** Build identifier the diagnostic came from. */
  appBuildVersion?: string;
}

export interface CpuExceptionEntry {
  totalCPUTimeMs?: number;
  totalSampledTimeMs?: number;
  cpuExceptionLimit?: string;
  topFrame: string;
  appBuildVersion?: string;
}

export interface DiskWriteExceptionEntry {
  writesCausedMB?: number;
  topFrame: string;
  appBuildVersion?: string;
}

export interface AnalyzeMetricKitPayloadResult {
  ok: boolean;
  /** Number of `.mxdiagnostic` files (or in-memory payloads) ingested. */
  payloadCount: number;
  timeRange?: { start: string; end: string };
  crashCluster: CrashClusterEntry[];
  hangHotspots: HangHotspotEntry[];
  cpuExceptions: CpuExceptionEntry[];
  diskWriteExceptions: DiskWriteExceptionEntry[];
  /** Per-section availability so callers can branch without inspecting counts. */
  supportStatus: SupportStatus[];
  /** Plain-English headline. */
  diagnosis: string;
  /** Cross-tool chain suggestions (e.g. db-lock-shaped hang -> analyzeHangs hint when caller has a trace). */
  suggestedNextCalls: NextCallSuggestion[];
}

/**
 * Pure: aggregate one or more parsed payloads into the analyzer result.
 * Split from the I/O wrapper so unit tests can drive it from JSON strings
 * without touching the filesystem.
 */
export function analyzePayloads(
  payloads: MetricKitPayload[],
  options: { topN: number; groupBy: "exception-type" | "binary" | "top-frame" },
): AnalyzeMetricKitPayloadResult {
  const { topN, groupBy } = options;
  const crashCluster = clusterCrashes(payloads, groupBy, topN);
  const hangHotspots = collectHangs(payloads, topN);
  const cpuExceptions = collectCpuExceptions(payloads, topN);
  const diskWriteExceptions = collectDiskWrites(payloads, topN);

  const supportStatus: SupportStatus[] = [
    buildKindStatus("crash-diagnostics", payloads, (p) => p.crashDiagnostics),
    buildKindStatus("hang-diagnostics", payloads, (p) => p.hangDiagnostics),
    buildKindStatus(
      "cpu-exception-diagnostics",
      payloads,
      (p) => p.cpuExceptionDiagnostics,
    ),
    buildKindStatus(
      "disk-write-exception-diagnostics",
      payloads,
      (p) => p.diskWriteExceptionDiagnostics,
    ),
  ];

  const timeRange = aggregateTimeRange(payloads);
  const diagnosis = buildDiagnosis(
    payloads.length,
    crashCluster,
    hangHotspots,
    cpuExceptions,
    diskWriteExceptions,
  );
  const suggestedNextCalls = buildSuggestedNextCalls(
    crashCluster,
    hangHotspots,
  );

  return {
    ok: true,
    payloadCount: payloads.length,
    ...(timeRange ? { timeRange } : {}),
    crashCluster,
    hangHotspots,
    cpuExceptions,
    diskWriteExceptions,
    supportStatus,
    diagnosis,
    suggestedNextCalls,
  };
}

function buildKindStatus(
  kind: string,
  payloads: MetricKitPayload[],
  pick: (p: MetricKitPayload) => MetricKitDiagnostic[],
): SupportStatus {
  const present = payloads.some((p) => pick(p).length > 0);
  const partial =
    present && payloads.some((p) => pick(p).length === 0) && payloads.length > 1;
  return {
    kind,
    status: present ? (partial ? "partial" : "available") : "not_present",
  };
}

function clusterCrashes(
  payloads: MetricKitPayload[],
  groupBy: "exception-type" | "binary" | "top-frame",
  topN: number,
): CrashClusterEntry[] {
  const map = new Map<string, CrashClusterEntry>();
  for (const p of payloads) {
    for (const d of p.crashDiagnostics) {
      const topFrame = extractTopFrameLabel(d);
      const root = d.callStackTree.callStacks[0]?.callStackRootFrames[0];
      const exceptionType =
        typeof d.diagnosticMetaData.exceptionType === "number"
          ? d.diagnosticMetaData.exceptionType
          : undefined;
      const signal =
        typeof d.diagnosticMetaData.signal === "number"
          ? d.diagnosticMetaData.signal
          : undefined;
      const terminationReason =
        typeof d.diagnosticMetaData.terminationReason === "string"
          ? d.diagnosticMetaData.terminationReason
          : undefined;
      const appBuildVersion =
        typeof d.diagnosticMetaData.appBuildVersion === "string"
          ? d.diagnosticMetaData.appBuildVersion
          : undefined;

      const key = buildClusterKey(groupBy, {
        exceptionType,
        signal,
        binaryName: root?.binaryName,
        topFrame,
      });

      const existing = map.get(key);
      if (existing) {
        existing.occurrences += 1;
        if (
          appBuildVersion &&
          !existing.affectedBuilds.includes(appBuildVersion)
        ) {
          existing.affectedBuilds.push(appBuildVersion);
        }
        if (d.version && !existing.payloadVersions.includes(d.version)) {
          existing.payloadVersions.push(d.version);
        }
      } else {
        map.set(key, {
          clusterKey: key,
          ...(exceptionType != null ? { exceptionType } : {}),
          ...(signal != null ? { signal } : {}),
          ...(terminationReason ? { terminationReason } : {}),
          topFrame,
          occurrences: 1,
          affectedBuilds: appBuildVersion ? [appBuildVersion] : [],
          sample: {
            ...(root?.binaryUUID ? { binaryUUID: root.binaryUUID } : {}),
            ...(root?.binaryName ? { binaryName: root.binaryName } : {}),
            ...(root?.offsetIntoBinaryTextSegment != null
              ? { offsetIntoBinaryTextSegment: root.offsetIntoBinaryTextSegment }
              : {}),
          },
          payloadVersions: d.version ? [d.version] : [],
        });
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, topN);
}

function buildClusterKey(
  groupBy: "exception-type" | "binary" | "top-frame",
  parts: {
    exceptionType?: number;
    signal?: number;
    binaryName?: string;
    topFrame: string;
  },
): string {
  if (groupBy === "binary") {
    return `${parts.binaryName ?? "<unknown>"}|sig=${parts.signal ?? "?"}`;
  }
  if (groupBy === "top-frame") {
    return `${parts.topFrame}|sig=${parts.signal ?? "?"}`;
  }
  return `exc=${parts.exceptionType ?? "?"}|sig=${parts.signal ?? "?"}`;
}

function collectHangs(
  payloads: MetricKitPayload[],
  topN: number,
): HangHotspotEntry[] {
  const all: HangHotspotEntry[] = [];
  for (const p of payloads) {
    for (const d of p.hangDiagnostics) {
      const durRaw = d.diagnosticMetaData.hangDuration;
      const hangDurationMs =
        typeof durRaw === "string" ? metricKitTimeToMs(durRaw) ?? 0 : 0;
      const root = d.callStackTree.callStacks[0]?.callStackRootFrames[0];
      all.push({
        hangDurationMs,
        topFrame: extractTopFrameLabel(d),
        ...(root?.binaryName ? { binaryName: root.binaryName } : {}),
        ...(root?.sampleCount != null ? { sampleCount: root.sampleCount } : {}),
        ...(typeof d.diagnosticMetaData.appBuildVersion === "string"
          ? { appBuildVersion: d.diagnosticMetaData.appBuildVersion }
          : {}),
      });
    }
  }
  return all
    .sort((a, b) => b.hangDurationMs - a.hangDurationMs)
    .slice(0, topN);
}

function collectCpuExceptions(
  payloads: MetricKitPayload[],
  topN: number,
): CpuExceptionEntry[] {
  const all: CpuExceptionEntry[] = [];
  for (const p of payloads) {
    for (const d of p.cpuExceptionDiagnostics) {
      const cpuTime =
        typeof d.diagnosticMetaData.totalCPUTime === "string"
          ? metricKitTimeToMs(d.diagnosticMetaData.totalCPUTime)
          : undefined;
      const sampledTime =
        typeof d.diagnosticMetaData.totalSampledTime === "string"
          ? metricKitTimeToMs(d.diagnosticMetaData.totalSampledTime)
          : undefined;
      const cpuExceptionLimit =
        typeof d.diagnosticMetaData.cpuExceptionLimit === "string"
          ? d.diagnosticMetaData.cpuExceptionLimit
          : undefined;
      all.push({
        ...(cpuTime != null ? { totalCPUTimeMs: cpuTime } : {}),
        ...(sampledTime != null ? { totalSampledTimeMs: sampledTime } : {}),
        ...(cpuExceptionLimit ? { cpuExceptionLimit } : {}),
        topFrame: extractTopFrameLabel(d),
        ...(typeof d.diagnosticMetaData.appBuildVersion === "string"
          ? { appBuildVersion: d.diagnosticMetaData.appBuildVersion }
          : {}),
      });
    }
  }
  return all
    .sort((a, b) => (b.totalCPUTimeMs ?? 0) - (a.totalCPUTimeMs ?? 0))
    .slice(0, topN);
}

function collectDiskWrites(
  payloads: MetricKitPayload[],
  topN: number,
): DiskWriteExceptionEntry[] {
  const all: DiskWriteExceptionEntry[] = [];
  for (const p of payloads) {
    for (const d of p.diskWriteExceptionDiagnostics) {
      const writesMB =
        typeof d.diagnosticMetaData.writesCaused === "string"
          ? metricKitDiskToMB(d.diagnosticMetaData.writesCaused)
          : undefined;
      all.push({
        ...(writesMB != null ? { writesCausedMB: writesMB } : {}),
        topFrame: extractTopFrameLabel(d),
        ...(typeof d.diagnosticMetaData.appBuildVersion === "string"
          ? { appBuildVersion: d.diagnosticMetaData.appBuildVersion }
          : {}),
      });
    }
  }
  return all
    .sort((a, b) => (b.writesCausedMB ?? 0) - (a.writesCausedMB ?? 0))
    .slice(0, topN);
}

function aggregateTimeRange(
  payloads: MetricKitPayload[],
): { start: string; end: string } | undefined {
  const starts: string[] = [];
  const ends: string[] = [];
  for (const p of payloads) {
    if (p.timeStampBegin) starts.push(p.timeStampBegin);
    if (p.timeStampEnd) ends.push(p.timeStampEnd);
  }
  if (starts.length === 0 || ends.length === 0) return undefined;
  starts.sort();
  ends.sort();
  return { start: starts[0], end: ends[ends.length - 1] };
}

function buildDiagnosis(
  payloadCount: number,
  crashes: CrashClusterEntry[],
  hangs: HangHotspotEntry[],
  cpu: CpuExceptionEntry[],
  disk: DiskWriteExceptionEntry[],
): string {
  if (payloadCount === 0) {
    return "No MetricKit payloads found. Ensure your TestFlight / App Store build calls `MXMetricManager.shared.add(_:)` and that you have a payload from a real device (simulator does not deliver MetricKit).";
  }
  if (
    crashes.length === 0 &&
    hangs.length === 0 &&
    cpu.length === 0 &&
    disk.length === 0
  ) {
    return `No actionable diagnostics. ${payloadCount} payload${payloadCount === 1 ? "" : "s"} ingested, all sections empty (this is typical when the recent app run had no faults).`;
  }
  const parts: string[] = [];
  if (crashes.length > 0) {
    const top = crashes[0];
    parts.push(
      `${top.occurrences} crash${top.occurrences === 1 ? "" : "es"} clustered on ${describeExceptionShort(top)} at \`${top.topFrame}\`${top.affectedBuilds.length > 0 ? `, across build${top.affectedBuilds.length === 1 ? "" : "s"} ${top.affectedBuilds.join(", ")}` : ""}.`,
    );
  }
  if (hangs.length > 0) {
    const top = hangs[0];
    if (top.hangDurationMs >= 1000) {
      parts.push(
        `1 hang ${(top.hangDurationMs / 1000).toFixed(1)}s on \`${top.topFrame}\` — likely user-visible freeze.`,
      );
    } else if (top.hangDurationMs > 0) {
      parts.push(
        `Hang at \`${top.topFrame}\` (${Math.round(top.hangDurationMs)}ms).`,
      );
    }
  }
  if (cpu.length > 0 && cpu[0].totalCPUTimeMs != null) {
    parts.push(
      `CPU exception: ${(cpu[0].totalCPUTimeMs / 1000).toFixed(1)}s at \`${cpu[0].topFrame}\`.`,
    );
  }
  if (disk.length > 0 && disk[0].writesCausedMB != null) {
    parts.push(
      `Disk-write exception: ${disk[0].writesCausedMB.toFixed(0)}MB at \`${disk[0].topFrame}\`.`,
    );
  }
  return parts.join(" ");
}

function describeExceptionShort(c: CrashClusterEntry): string {
  // Map common Mach exception types + signals to legible labels.
  // The list is the v1 baseline; we can expand with `mach/exception_types.h`
  // mappings as users report mismatches.
  const sigMap: Record<number, string> = {
    11: "SIGSEGV",
    6: "SIGABRT",
    9: "SIGKILL",
    4: "SIGILL",
    5: "SIGTRAP",
    10: "SIGBUS",
  };
  if (c.exceptionType === 1) return "EXC_BAD_ACCESS";
  if (c.signal != null && sigMap[c.signal]) return sigMap[c.signal];
  if (c.exceptionType != null && c.signal != null) {
    return `exceptionType=${c.exceptionType}, signal=${c.signal}`;
  }
  return "unclassified exception";
}

function buildSuggestedNextCalls(
  crashes: CrashClusterEntry[],
  hangs: HangHotspotEntry[],
): NextCallSuggestion[] {
  const out: NextCallSuggestion[] = [];

  // Cross-tool chain: a top crash frame whose binary name we can recognize
  // hints at a memgraph-side investigation. We don't have the memgraph path
  // here, so we just nudge the agent.
  if (crashes.length > 0) {
    const top = crashes[0];
    const isRetainCycleShape =
      /objc_msgSend|_dispatch_block_invoke|_NS\w+release|_objc_release/.test(
        top.topFrame,
      );
    if (isRetainCycleShape) {
      out.push({
        tool: "findCycles",
        args: {},
        why: `Top crash frame "${top.topFrame}" matches a retain-cycle-shaped symbol (objc_msgSend / dispatch_block / release). Capture a memgraph of the affected scenario and chain into findCycles.`,
      });
    }
  }

  // Hang-shape chain: if a hang's top frame names a known db / network /
  // lock symbol, surface the main-thread-violation classifier hint.
  if (hangs.length > 0) {
    const top = hangs[0];
    const hangClass = classifyHangFrame(top.topFrame, top.binaryName);
    if (hangClass) {
      out.push({
        tool: "analyzeHangs",
        args: { includeStackClassification: true },
        why: `Top hang frame "${top.topFrame}" looks like a ${hangClass} blocker. When you have a .trace from a repro of the same scenario, analyzeHangs with includeStackClassification will surface mainThreadViolations[] with this classifier.`,
      });
    }
  }

  return out;
}

function classifyHangFrame(
  topFrame: string,
  binaryName?: string,
): string | undefined {
  const lower = topFrame.toLowerCase();
  const bin = (binaryName ?? "").toLowerCase();
  if (lower.includes("sqlite") || bin.includes("sqlite")) return "db-lock";
  if (lower.includes("nsurlconnection") || lower.includes("nw_connection")) {
    return "network";
  }
  if (
    lower.includes("pthread") ||
    lower.includes("os_unfair_lock") ||
    lower.includes("dispatch_semaphore_wait") ||
    lower.includes("dispatch_sync")
  ) {
    return "lock-contention";
  }
  if (lower.includes("read") || lower.includes("write") || lower.includes("fsync")) {
    return "sync-io";
  }
  return undefined;
}

/**
 * Resolve the input shape into an array of parsed payloads. The order of
 * precedence is `payloadJson` -> `payloadPath` -> `payloadDir`.
 */
function readPayloads(input: AnalyzeMetricKitPayloadInput): MetricKitPayload[] {
  if (input.payloadJson) {
    return [parseMetricKitPayload(input.payloadJson)];
  }
  if (input.payloadPath) {
    const abs = resolvePath(input.payloadPath);
    if (!existsSync(abs)) {
      throw new Error(`MetricKit payload not found: ${abs}`);
    }
    return [parseMetricKitPayload(readFileSync(abs, "utf8"))];
  }
  if (input.payloadDir) {
    const abs = resolvePath(input.payloadDir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`MetricKit payload directory not found: ${abs}`);
    }
    const files = readdirSync(abs).filter((f) =>
      f.endsWith(".mxdiagnostic"),
    );
    if (files.length === 0) {
      throw new Error(
        `No .mxdiagnostic files in ${abs}. The directory exists but is empty (typical when the app has not delivered any payload yet — MetricKit on iOS 18 has a 24-48h delay and a "new bundle id probation" window).`,
      );
    }
    return files.map((f) =>
      parseMetricKitPayload(readFileSync(join(abs, f), "utf8")),
    );
  }
  throw new Error(
    "Provide exactly one of: payloadPath, payloadDir, or payloadJson.",
  );
}

export async function analyzeMetricKitPayload(
  input: AnalyzeMetricKitPayloadInput,
): Promise<AnalyzeMetricKitPayloadResult> {
  const payloads = readPayloads(input);
  return analyzePayloads(payloads, {
    topN: input.topN,
    groupBy: input.groupBy,
  });
}
