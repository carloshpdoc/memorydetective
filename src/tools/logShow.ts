import { z } from "zod";
import { runCommand } from "../runtime/exec.js";

/**
 * Wrappers around the macOS unified logging CLI (`log(1)`):
 * - `logShow`: one-shot historical query, returns parsed entries.
 * - `logStream`: bounded live stream, returns parsed entries collected over a
 *   time window (we explicitly bound this since MCP requests are request/response).
 *
 * Output of `log show --style compact` looks like:
 *   2026-05-01 00:48:14.521 Df rapportd[697:531b42] [com.apple.rapport:cat] message...
 *
 * Where Ty is one of: Df (default), Er (error), In (info), Fa (fault), Ac (activity).
 */

export const logShowSchema = z.object({
  last: z
    .string()
    .default("5m")
    .describe(
      "Time window to look back from now (e.g. \"30s\", \"5m\", \"1h\", \"2d\"). Default 5m.",
    ),
  predicate: z
    .string()
    .optional()
    .describe(
      "NSPredicate-style filter passed to `log show --predicate`. Examples: `process == \"DemoApp\"`, `subsystem == \"com.example.app\"`, `messageType == error`.",
    ),
  process: z
    .string()
    .optional()
    .describe("Filter to a single process name. Sugar over `--predicate process == \"<name>\"`."),
  subsystem: z
    .string()
    .optional()
    .describe("Filter to a single subsystem identifier."),
  level: z
    .enum(["default", "info", "debug"])
    .default("default")
    .describe(
      "Minimum log level. `default` = default+error+fault. `info` adds info-level. `debug` adds info+debug.",
    ),
  maxEntries: z
    .number()
    .int()
    .positive()
    .default(500)
    .describe("Cap on parsed entries returned (default 500). Output is truncated to the first N matching."),
});

export type LogShowInput = z.infer<typeof logShowSchema>;

export const logStreamSchema = z.object({
  durationSec: z
    .number()
    .int()
    .positive()
    .max(60)
    .default(10)
    .describe(
      "How long to listen for log entries (max 60 seconds — MCP requests should not block longer). Default 10.",
    ),
  predicate: z.string().optional(),
  process: z.string().optional(),
  subsystem: z.string().optional(),
  level: z.enum(["default", "info", "debug"]).default("default"),
  maxEntries: z.number().int().positive().default(500),
});

export type LogStreamInput = z.infer<typeof logStreamSchema>;

export interface LogEntry {
  timestamp: string;
  type: "default" | "info" | "debug" | "error" | "fault" | "activity" | "unknown";
  process: string;
  pid: number;
  tid?: string;
  subsystem?: string;
  category?: string;
  message: string;
}

const TYPE_CODE_MAP: Record<string, LogEntry["type"]> = {
  Df: "default",
  Ac: "activity",
  In: "info",
  De: "debug",
  Er: "error",
  Fa: "fault",
};

/**
 * Compact-style log line:
 *   2026-05-01 00:48:14.521 Df rapportd[697:531b42] [com.apple.foo:bar] message
 *
 * Subsystem/category bracket is optional; many lines lack it.
 */
const LINE_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+([A-Z][a-z])\s+(\S+?)\[(\d+)(?::([0-9a-fA-F]+))?\]\s+(?:\[([^:\]]+):([^\]]+)\]\s+)?(.*)$/;

/** Pure: parse `log show` output (one entry per line) into structured records. */
export function parseLogOutput(text: string, max: number): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (entries.length >= max) break;
    if (!line.trim()) continue;
    if (line.startsWith("Timestamp")) continue; // header
    if (/^Filtering the log data/.test(line)) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, timestamp, typeCode, process, pidStr, tid, subsystem, category, message] = m;
    entries.push({
      timestamp,
      type: TYPE_CODE_MAP[typeCode] ?? "unknown",
      process,
      pid: parseInt(pidStr, 10),
      tid,
      subsystem,
      category,
      message,
    });
  }
  return entries;
}

function buildPredicate(opts: {
  predicate?: string;
  process?: string;
  subsystem?: string;
}): string | undefined {
  const parts: string[] = [];
  if (opts.predicate) parts.push(`(${opts.predicate})`);
  if (opts.process) parts.push(`process == "${opts.process}"`);
  if (opts.subsystem) parts.push(`subsystem == "${opts.subsystem}"`);
  if (parts.length === 0) return undefined;
  return parts.join(" AND ");
}

function levelArgs(level: "default" | "info" | "debug"): string[] {
  if (level === "info") return ["--info"];
  if (level === "debug") return ["--info", "--debug"];
  return [];
}

export interface LogShowResult {
  ok: boolean;
  command: string;
  totalParsed: number;
  byType: Record<string, number>;
  entries: LogEntry[];
  truncated: boolean;
}

export async function logShow(input: LogShowInput): Promise<LogShowResult> {
  const args = ["show", "--style", "compact", "--last", input.last];
  args.push(...levelArgs(input.level ?? "default"));
  const predicate = buildPredicate(input);
  if (predicate) args.push("--predicate", predicate);

  const result = await runCommand("log", args, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(
      `log show failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const max = input.maxEntries ?? 500;
  const entries = parseLogOutput(result.stdout, max);

  const byType: Record<string, number> = {};
  for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;

  // If parser saw fewer lines than the raw stream produced, flag truncation.
  const totalLines = result.stdout.split(/\r?\n/).filter((l) => l.trim()).length;

  return {
    ok: true,
    command: `log ${args.join(" ")}`,
    totalParsed: entries.length,
    byType,
    entries,
    truncated: totalLines > entries.length,
  };
}

export async function logStream(input: LogStreamInput): Promise<LogShowResult> {
  const args = ["stream", "--style", "compact"];
  args.push(...levelArgs(input.level ?? "default"));
  const predicate = buildPredicate(input);
  if (predicate) args.push("--predicate", predicate);

  // `log stream` runs forever; we kill it after durationSec via the runner's
  // timeout, then parse whatever was collected.
  const ms = (input.durationSec ?? 10) * 1000;
  let result;
  try {
    result = await runCommand("log", args, { timeoutMs: ms });
  } catch (err) {
    // Timeout is expected — collect partial output via a fallback mode.
    // Our runCommand currently throws on timeout; we need a slightly different
    // approach: spawn directly and collect output until the deadline.
    return await logStreamWithTimer(args, ms, input.maxEntries ?? 500);
  }
  const max = input.maxEntries ?? 500;
  const entries = parseLogOutput(result.stdout, max);
  const byType: Record<string, number> = {};
  for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return {
    ok: true,
    command: `log ${args.join(" ")}`,
    totalParsed: entries.length,
    byType,
    entries,
    truncated: false,
  };
}

async function logStreamWithTimer(
  args: string[],
  ms: number,
  max: number,
): Promise<LogShowResult> {
  // Use spawn directly here so we can capture stdout up to the deadline
  // without throwing.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("log", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, ms);
    child.on("close", () => {
      clearTimeout(timer);
      const entries = parseLogOutput(stdout, max);
      const byType: Record<string, number> = {};
      for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
      const totalLines = stdout.split(/\r?\n/).filter((l) => l.trim()).length;
      resolve({
        ok: true,
        command: `log ${args.join(" ")}`,
        totalParsed: entries.length,
        byType,
        entries,
        truncated: totalLines > entries.length,
      });
    });
  });
}
