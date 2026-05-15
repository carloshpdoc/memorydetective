/**
 * `analyzeNetworkActivity`: parses xctrace's network-connections schema
 * from a `.trace` recorded with the Network Profile template. v1.14 item A.
 *
 * "The network is slow" / "my SDK is chatty" / "slow launch because of
 * one API call" are top-3 iOS perf complaints. Pre-v1.14 we had zero
 * coverage of the network family. XcodeTraceMCP's regex map listed it
 * as one of their five instrument families. This analyzer closes the
 * gap with the same shape as analyzeHangs / analyzeAnimationHitches:
 *
 * - Bytes-in/out, duration, status-code, and URL/host extracted per
 *   connection.
 * - Aggregates: total bytes, slowest response, average response, count
 *   per HTTP status bucket.
 * - Top-N by duration (the "which calls blocked the user?" view) and
 *   top-N by bytes (the "which calls are bloating my budget?" view).
 * - Per-host aggregates surfacing chatty SDKs without manually grouping.
 *
 * Resilient to column-name drift across xctrace versions: each field
 * is looked up under multiple plausible mnemonics, falling back to the
 * one that yields data.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "../runtime/exec.js";
import { fetchDiscoveredSchemas } from "../parsers/schemaDiscovery.js";
import {
  parseXctraceXml,
  asNumber,
  asFormatted,
  type XctraceValue,
} from "../parsers/xctraceXml.js";
import type { DataStatus, SupportStatus } from "../types.js";
import { outputFormatField } from "../runtime/responseFormatter.js";

export const analyzeNetworkActivitySchema = z.object({
  tracePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a `.trace` bundle recorded with a Network template (`xcrun xctrace record --template 'Network Profile' --attach <app|pid>`).",
    ),
  topN: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Return the top N rows for each ranking dimension (by-duration + by-bytes). Default 10.",
    ),
  minBytes: z
    .number()
    .nonnegative()
    .default(0)
    .describe(
      "Filter out connections that transferred fewer than this many bytes (in + out combined). Useful for cutting tiny pings out of the by-bytes view.",
    ),
  outputFormat: outputFormatField,
});

export type AnalyzeNetworkActivityInput = z.infer<
  typeof analyzeNetworkActivitySchema
>;

export interface NetworkConnectionEntry {
  /** Start timestamp in nanoseconds since recording start. */
  startNs: number;
  startFmt?: string;
  /** Response/transaction duration in nanoseconds when available. */
  durationNs?: number;
  durationMs?: number;
  durationFmt?: string;
  /** URL or hostname (whichever the trace exposed). */
  url?: string;
  /** Host portion of the URL, when parseable. */
  host?: string;
  /** HTTP method (GET, POST, etc.) when present. */
  method?: string;
  /** HTTP response status code. */
  statusCode?: number;
  /** Bytes received from the server (response body + headers). */
  bytesIn?: number;
  /** Bytes sent to the server (request body + headers). */
  bytesOut?: number;
}

export interface NetworkHostAggregate {
  host: string;
  count: number;
  bytesIn: number;
  bytesOut: number;
  longestMs: number;
}

export interface AnalyzeNetworkActivityResult {
  ok: boolean;
  tracePath: string;
  totals: {
    rows: number;
    totalBytesIn: number;
    totalBytesOut: number;
    longestMs: number;
    averageMs: number;
    /** Status-code bucket counts. Example: `{ "2xx": 47, "4xx": 3, "5xx": 1, "n/a": 12 }`. */
    statusBuckets: Record<string, number>;
  };
  /** Top N connections ranked by `durationMs` desc. */
  topByDuration: NetworkConnectionEntry[];
  /** Top N connections ranked by `bytesIn + bytesOut` desc. */
  topByBytes: NetworkConnectionEntry[];
  /** Per-host aggregates, ranked by request count desc. */
  byHost: NetworkHostAggregate[];
  diagnosis: string;
  /** @deprecated v1.14 item I. Use `supportStatus[]` instead. */
  status: DataStatus;
  /** v1.14+. Unified per-area status. See {@link SupportStatus}. */
  supportStatus: SupportStatus[];
}

/**
 * Helper: pull a string field from a row trying multiple plausible
 * column names. xctrace varies network column mnemonics across iOS
 * versions and templates; we try them all rather than failing on a
 * single canonical name.
 */
function pickString(row: Record<string, XctraceValue>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = asFormatted(row[k]);
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Same idea as pickString but for numeric fields. */
function pickNumber(row: Record<string, XctraceValue>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = asNumber(row[k]);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Extract a host string from a URL-or-host value. Falls back to the
 *  raw input when it does not look like a URL (already a host). */
export function extractHost(urlOrHost: string | undefined): string | undefined {
  if (!urlOrHost) return undefined;
  // Strip scheme + path. Accepts http://host:port/path, host:port/path, bare host.
  const stripped = urlOrHost
    .replace(/^https?:\/\//i, "")
    .replace(/^.*?:\/\//, "");
  const slash = stripped.indexOf("/");
  const hostPort = slash >= 0 ? stripped.slice(0, slash) : stripped;
  // Drop the trailing :port for cleaner aggregation.
  const colon = hostPort.indexOf(":");
  return colon >= 0 ? hostPort.slice(0, colon) : hostPort;
}

function statusBucket(code: number | undefined): string {
  if (code == null) return "n/a";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

/** Pure: turn the network-connections XML into the analyzed result. */
export function analyzeNetworkActivityFromXml(
  xml: string,
  tracePath: string,
  topN = 10,
  minBytes = 0,
): AnalyzeNetworkActivityResult {
  const tables = parseXctraceXml(xml);
  // The Network template historically uses "network-connections"; some
  // older builds use plain "network". Both are covered by SCHEMA_FAMILIES
  // network -> the discovered schema name was passed by the caller, but
  // the table here may carry either canonical name when synthetic
  // fixtures are in play. Accept whichever matches.
  const table = tables.find(
    (t) => /network/i.test(t.schema) || /connection/i.test(t.schema) || /^http/i.test(t.schema),
  );
  if (!table) {
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        totalBytesIn: 0,
        totalBytesOut: 0,
        longestMs: 0,
        averageMs: 0,
        statusBuckets: {},
      },
      topByDuration: [],
      topByBytes: [],
      byHost: [],
      diagnosis: "No network-connections table found in the trace.",
      status: "not_present",
      supportStatus: [
        {
          kind: "network-connections",
          status: "not_present",
          reason: "Schema absent from the trace TOC.",
        },
      ],
    };
  }

  const entries: NetworkConnectionEntry[] = [];
  for (const row of table.rows) {
    const startNs = pickNumber(row, ["start", "time", "connect-time", "event-time"]) ?? 0;
    const durationNs = pickNumber(row, [
      "duration",
      "response-time",
      "transaction-duration",
      "elapsed",
    ]);
    const url =
      pickString(row, ["url", "host", "endpoint", "connect-event-host", "request-url"]);
    const method = pickString(row, ["method", "http-method", "request-method"]);
    const statusCode = pickNumber(row, [
      "status-code",
      "http-status",
      "response-code",
      "status",
    ]);
    const bytesIn = pickNumber(row, [
      "bytes-in",
      "response-bytes",
      "received-bytes",
      "bytes-received",
      "rx-bytes",
    ]);
    const bytesOut = pickNumber(row, [
      "bytes-out",
      "request-bytes",
      "sent-bytes",
      "bytes-sent",
      "tx-bytes",
    ]);

    const totalBytes = (bytesIn ?? 0) + (bytesOut ?? 0);
    if (totalBytes < minBytes) continue;

    entries.push({
      startNs,
      ...(asFormatted(row.start) ? { startFmt: asFormatted(row.start)! } : {}),
      ...(durationNs != null ? { durationNs, durationMs: durationNs / 1_000_000 } : {}),
      ...(asFormatted(row.duration) ? { durationFmt: asFormatted(row.duration)! } : {}),
      ...(url ? { url, host: extractHost(url) } : {}),
      ...(method ? { method } : {}),
      ...(statusCode != null ? { statusCode } : {}),
      ...(bytesIn != null ? { bytesIn } : {}),
      ...(bytesOut != null ? { bytesOut } : {}),
    });
  }

  const totalBytesIn = entries.reduce((s, e) => s + (e.bytesIn ?? 0), 0);
  const totalBytesOut = entries.reduce((s, e) => s + (e.bytesOut ?? 0), 0);
  const durations = entries
    .map((e) => e.durationMs ?? 0)
    .filter((d) => d > 0);
  const longestMs = durations.length > 0 ? Math.max(...durations) : 0;
  const averageMs =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

  const statusBuckets: Record<string, number> = {};
  for (const e of entries) {
    const bucket = statusBucket(e.statusCode);
    statusBuckets[bucket] = (statusBuckets[bucket] ?? 0) + 1;
  }

  const topByDuration = [...entries]
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, topN);

  const topByBytes = [...entries]
    .sort(
      (a, b) =>
        (b.bytesIn ?? 0) + (b.bytesOut ?? 0) - ((a.bytesIn ?? 0) + (a.bytesOut ?? 0)),
    )
    .slice(0, topN);

  const hostMap = new Map<string, NetworkHostAggregate>();
  for (const e of entries) {
    if (!e.host) continue;
    const cur = hostMap.get(e.host) ?? {
      host: e.host,
      count: 0,
      bytesIn: 0,
      bytesOut: 0,
      longestMs: 0,
    };
    cur.count += 1;
    cur.bytesIn += e.bytesIn ?? 0;
    cur.bytesOut += e.bytesOut ?? 0;
    if (e.durationMs != null && e.durationMs > cur.longestMs) {
      cur.longestMs = e.durationMs;
    }
    hostMap.set(e.host, cur);
  }
  const byHost = Array.from(hostMap.values()).sort((a, b) => b.count - a.count);

  return {
    ok: true,
    tracePath,
    totals: {
      rows: entries.length,
      totalBytesIn,
      totalBytesOut,
      longestMs,
      averageMs,
      statusBuckets,
    },
    topByDuration,
    topByBytes,
    byHost,
    diagnosis: buildDiagnosis(entries.length, longestMs, totalBytesIn, totalBytesOut, byHost),
    status: "available",
    supportStatus: [
      {
        kind: "network-connections",
        status: "available",
        sourceSchemas: ["network-connections"],
      },
    ],
  };
}

function buildDiagnosis(
  rows: number,
  longestMs: number,
  totalBytesIn: number,
  totalBytesOut: number,
  byHost: NetworkHostAggregate[],
): string {
  if (rows === 0) {
    return "No network activity in the recording window (or all rows were filtered out by minBytes).";
  }
  const parts: string[] = [];
  parts.push(`${rows} network requests captured.`);
  const totalKB = (totalBytesIn + totalBytesOut) / 1024;
  if (totalKB >= 1) {
    parts.push(
      `${totalKB.toFixed(1)} KB total (${(totalBytesIn / 1024).toFixed(1)} KB in, ${(totalBytesOut / 1024).toFixed(1)} KB out).`,
    );
  }
  if (longestMs > 0) {
    parts.push(`Slowest: ${longestMs.toFixed(0)}ms.`);
  }
  if (byHost.length > 0) {
    const top = byHost[0];
    parts.push(`Chattiest host: \`${top.host}\` (${top.count} requests).`);
  }
  if (longestMs > 3000) {
    parts.push(
      "At least one request over 3s. Likely the user-visible perf gap.",
    );
  }
  return parts.join(" ");
}

export async function analyzeNetworkActivity(
  input: AnalyzeNetworkActivityInput,
): Promise<AnalyzeNetworkActivityResult> {
  const tracePath = resolvePath(input.tracePath);
  if (!existsSync(tracePath)) {
    throw new Error(`Trace bundle not found: ${tracePath}`);
  }
  const { network: schemaName } = await fetchDiscoveredSchemas(
    runCommand,
    tracePath,
    ["network"] as const,
  );
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
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    // Schema may simply not be present in this trace (e.g. Time Profiler
    // template without Network instrument). Surface as "not_present"
    // rather than throwing so summarizeTrace can branch on status.
    return {
      ok: true,
      tracePath,
      totals: {
        rows: 0,
        totalBytesIn: 0,
        totalBytesOut: 0,
        longestMs: 0,
        averageMs: 0,
        statusBuckets: {},
      },
      topByDuration: [],
      topByBytes: [],
      byHost: [],
      diagnosis:
        "Network schema not exportable from this trace (likely recorded with a non-Network template).",
      status: "not_present",
      supportStatus: [
        {
          kind: "network-connections",
          status: "not_exportable",
          reason: "xctrace export failed; likely recorded with a non-Network template.",
        },
      ],
    };
  }
  return analyzeNetworkActivityFromXml(
    result.stdout,
    tracePath,
    input.topN ?? 10,
    input.minBytes ?? 0,
  );
}
