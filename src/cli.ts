/**
 * Minimal CLI wrapper around two of the most-used MCP tools, for scripting,
 * CI integration, and demos. The MCP server is the primary interface; this
 * is a convenience layer that calls the same tool functions directly without
 * a stdio roundtrip.
 *
 * Usage:
 *   memorydetective analyze   <path-to-.memgraph> [--json]
 *   memorydetective classify  <path-to-.memgraph> [--json]
 *   memorydetective --help
 *   memorydetective --version
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { analyzeMemgraph } from "./tools/analyzeMemgraph.js";
import { classifyCycle } from "./tools/classifyCycle.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const VERSION = "1.2.1";

const HELP = `${C.bold}memorydetective${C.reset} — iOS leak hunting from the CLI

${C.dim}Usage:${C.reset}
  memorydetective analyze   <path-to-.memgraph> [--json]
  memorydetective classify  <path-to-.memgraph> [--json]
  memorydetective --help                           Show this message
  memorydetective --version                        Print version

${C.dim}Flags:${C.reset}
  --json    Emit machine-readable JSON instead of formatted output.
            Useful for CI scripts and piping into jq.

${C.dim}When called with no arguments, memorydetective starts as an MCP server${C.reset}
${C.dim}over stdio. See https://github.com/carloshpdoc/memorydetective#configure${C.reset}
${C.dim}for full Claude Code / Desktop / Cursor / Cline / Kiro configuration.${C.reset}

${C.dim}⭐ Star: ${C.reset}https://github.com/carloshpdoc/memorydetective
`;

const FIRST_RUN_BANNER = `
${C.bold}👋 First time using memorydetective?${C.reset}

   ${C.green}⭐ Star:${C.reset}    https://github.com/carloshpdoc/memorydetective
   ${C.cyan}📖 Guide:${C.reset}   https://github.com/carloshpdoc/memorydetective/blob/main/USAGE.md
   ${C.yellow}☕ Sponsor:${C.reset} https://buymeacoffee.com/carloshperc

${C.dim}This message shows once.${C.reset}
`;

const FIRST_RUN_MARKER = joinPath(
  homedir(),
  ".config",
  "memorydetective",
  "seen",
);

/** Show the first-time banner once per machine, then create a marker so it
 *  never shows again. Failures (e.g. read-only home) are silent — banner
 *  hygiene shouldn't break the user's actual work. */
function maybeShowFirstRunBanner(): void {
  try {
    if (existsSync(FIRST_RUN_MARKER)) return;
    process.stderr.write(FIRST_RUN_BANNER + "\n");
    mkdirSync(joinPath(homedir(), ".config", "memorydetective"), {
      recursive: true,
    });
    writeFileSync(FIRST_RUN_MARKER, new Date().toISOString());
  } catch {
    // ignore — never fail because of the banner
  }
}

const DIAGNOSIS_FOOTER = `${C.dim}# Found this useful? ⭐ https://github.com/carloshpdoc/memorydetective${C.reset}`;

const KNOWN_COMMANDS = ["analyze", "classify", "--help", "-h", "help", "--version", "-v"];

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function header(label: string): void {
  const bar = "─".repeat(Math.max(0, 64 - label.length - 4));
  console.log(
    `\n${C.cyan}┌─ ${C.bold}${label}${C.reset}${C.cyan} ${bar}┐${C.reset}`,
  );
}

function row(label: string, value: string): void {
  console.log(`${C.cyan}│${C.reset} ${C.dim}${label}:${C.reset} ${value}`);
}

function endHeader(): void {
  console.log(`${C.cyan}└${"─".repeat(67)}┘${C.reset}`);
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else {
      line += " " + word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n" + indent);
}

/** Parse remaining args into a path and known flags. */
interface ParsedArgs {
  path?: string;
  json: boolean;
  unknownFlags: string[];
}

function parseArgs(rest: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, unknownFlags: [] };
  for (const arg of rest) {
    if (arg === "--json") out.json = true;
    else if (arg.startsWith("--")) out.unknownFlags.push(arg);
    else if (!out.path) out.path = arg;
    else out.unknownFlags.push(arg);
  }
  return out;
}

/** Return a friendlier error message for the most common failure modes. */
function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Memgraph file not found/.test(msg)) {
    return msg + "\n  Hint: pass an absolute path. Tab-complete from your shell to avoid typos.";
  }
  if (/leaks failed.*code 71/.test(msg) || /leaks: command not found/.test(msg)) {
    return (
      msg +
      "\n  Hint: `leaks(1)` ships with Xcode Command Line Tools. Run `xcode-select --install` to install them."
    );
  }
  if (/leaks failed.*code 1/.test(msg) && process.platform !== "darwin") {
    return (
      msg + "\n  Hint: memorydetective requires macOS. The `leaks(1)` and `xcrun xctrace` binaries are macOS-only."
    );
  }
  if (/xctrace export failed/.test(msg)) {
    return (
      msg +
      "\n  Hint: heavy time-profile traces can crash xctrace export. Open the trace in Instruments once to symbolicate, then retry."
    );
  }
  return msg;
}

/** Validate a path argument up front so the user gets a clean error
 *  before any subprocess fires. */
function validateMemgraphPath(p: string): void {
  const abs = resolvePath(p);
  if (!existsSync(abs)) {
    throw new Error(`Memgraph file not found: ${abs}`);
  }
  if (!abs.endsWith(".memgraph")) {
    throw new Error(
      `Expected a .memgraph file, got: ${abs}\n  Hint: did you point at a .trace bundle by mistake? memgraphs are exported from Xcode's Memory Graph Debugger.`,
    );
  }
}

/** Levenshtein-ish: simple "did you mean" for unknown commands. */
function suggestCommand(input: string): string | null {
  for (const cmd of KNOWN_COMMANDS) {
    if (cmd.startsWith("--")) continue;
    if (cmd.includes(input) || input.includes(cmd)) return cmd;
  }
  return null;
}

async function runAnalyze(memgraphPath: string, asJson: boolean): Promise<number> {
  validateMemgraphPath(memgraphPath);
  const result = await analyzeMemgraph({
    path: memgraphPath,
    fullChains: false,
    verbosity: "compact",
    maxClassesInChain: 10,
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  header("memorydetective analyze");
  row("Path", result.path);
  if (result.process) row("Process", `${result.process} (pid ${result.pid ?? "?"})`);
  if (result.identifier) row("Bundle", result.identifier);
  endHeader();

  const totals = result.totals;
  console.log(
    `\n  ${C.bold}${totals.leakCount.toLocaleString()}${C.reset} leaks ` +
      `${C.dim}(${(totals.totalLeakedBytes / 1024 / 1024).toFixed(2)} MB)${C.reset}`,
  );
  console.log(
    `  ${C.bold}${result.cycles.length}${C.reset} ROOT CYCLE block${result.cycles.length === 1 ? "" : "s"}\n`,
  );

  if (result.cycles.length > 0) {
    const top = result.cycles[0];
    console.log(`  ${C.bold}Top cycle:${C.reset} ${truncate(top.className || top.address, 70)}`);
    console.log(`    ${C.dim}chain length:${C.reset} ${top.chainLength} nodes`);
    const interesting = top.classesInChain.filter(
      (c) => !c.startsWith("SwiftUI.") && !c.startsWith("Swift."),
    );
    if (interesting.length > 0) {
      console.log(
        `    ${C.dim}app-level classes in chain:${C.reset} ${interesting.slice(0, 5).join(", ")}`,
      );
    }
  }

  console.log(`\n  ${C.bold}Diagnosis:${C.reset}`);
  console.log(`    ${C.green}${result.diagnosis}${C.reset}\n`);
  console.log(DIAGNOSIS_FOOTER + "\n");
  return 0;
}

async function runClassify(memgraphPath: string, asJson: boolean): Promise<number> {
  validateMemgraphPath(memgraphPath);
  const result = await classifyCycle({ path: memgraphPath, maxResults: 5 });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  header("memorydetective classify");
  row("Path", result.path);
  row("Cycles examined", String(result.totalCycles));
  endHeader();

  if (result.classified.length === 0) {
    console.log(`\n  ${C.dim}No cycles to classify.${C.reset}\n`);
    return 0;
  }

  for (const c of result.classified) {
    const root = truncate(c.rootClass || c.rootAddress, 70);
    console.log(`\n  ${C.bold}Root:${C.reset} ${root}`);
    if (c.primaryMatch) {
      const conf = c.primaryMatch.confidence;
      const colorByConf = conf === "high" ? C.green : conf === "medium" ? C.yellow : C.gray;
      console.log(
        `    ${C.bold}Match:${C.reset} ${colorByConf}${c.primaryMatch.patternId}${C.reset} ` +
          `${C.dim}(${conf} confidence)${C.reset}`,
      );
      console.log(
        `    ${C.bold}Fix hint:${C.reset}\n      ${C.dim}${wrapText(c.primaryMatch.fixHint, 70, "      ")}${C.reset}`,
      );
    } else {
      console.log(`    ${C.dim}No catalog match.${C.reset}`);
    }
    if (c.allMatches.length > 1) {
      console.log(
        `    ${C.dim}Also matched:${C.reset} ${c.allMatches.slice(1).map((m) => m.patternId).join(", ")}`,
      );
    }
  }
  console.log("");
  console.log(DIAGNOSIS_FOOTER + "\n");
  return 0;
}

export async function runCli(args: string[]): Promise<number> {
  // Fire the first-run banner before dispatching anything heavy. JSON-mode
  // callers shouldn't see it (might mess with their pipes), so we only show
  // it for human-output commands.
  const isJsonRun = args.includes("--json");
  if (!isJsonRun) maybeShowFirstRunBanner();

  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case "--help":
      case "-h":
      case "help":
        process.stdout.write(HELP);
        return 0;
      case "--version":
      case "-v":
        console.log(VERSION);
        return 0;
      case "analyze": {
        const parsed = parseArgs(rest);
        if (parsed.unknownFlags.length > 0) {
          console.error(`${C.red}error:${C.reset} unknown flag(s): ${parsed.unknownFlags.join(", ")}`);
          return 2;
        }
        if (!parsed.path) {
          console.error(`${C.red}error:${C.reset} analyze requires a .memgraph path`);
          return 2;
        }
        return await runAnalyze(parsed.path, parsed.json);
      }
      case "classify": {
        const parsed = parseArgs(rest);
        if (parsed.unknownFlags.length > 0) {
          console.error(`${C.red}error:${C.reset} unknown flag(s): ${parsed.unknownFlags.join(", ")}`);
          return 2;
        }
        if (!parsed.path) {
          console.error(`${C.red}error:${C.reset} classify requires a .memgraph path`);
          return 2;
        }
        return await runClassify(parsed.path, parsed.json);
      }
      default: {
        const suggestion = suggestCommand(cmd ?? "");
        const tail = suggestion ? `\n  Did you mean: ${C.bold}${suggestion}${C.reset}?` : "";
        console.error(`${C.red}error:${C.reset} unknown command: ${cmd}${tail}\n`);
        process.stdout.write(HELP);
        return 2;
      }
    }
  } catch (err) {
    const friendly = classifyError(err);
    console.error(`${C.red}error:${C.reset} ${friendly}`);
    return 1;
  }
}
