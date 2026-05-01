import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { runCommand } from "./exec.js";
import { parseLeaksOutput } from "../parsers/leaksOutput.js";
import type { LeaksReport } from "../types.js";

/**
 * Resolve `path`, run `leaks` against it, and return the parsed report.
 * Handles the `leaks` exit-code-1-when-leaks-found convention.
 */
export async function runLeaksAndParse(
  path: string,
): Promise<{ report: LeaksReport; resolvedPath: string }> {
  const resolvedPath = resolvePath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Memgraph file not found: ${resolvedPath}`);
  }
  const result = await runCommand("leaks", [resolvedPath], {
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const report = parseLeaksOutput(result.stdout);
  return { report, resolvedPath };
}
