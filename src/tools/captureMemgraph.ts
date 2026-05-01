import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { runCommand } from "../runtime/exec.js";

/** Base shape — exposed so the MCP layer can read `.shape`. */
export const captureMemgraphShape = {
  pid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("PID of the running process. Mutually exclusive with `appName`."),
  appName: z
    .string()
    .optional()
    .describe(
      "App name (resolves to PID via `pgrep -x`). Mutually exclusive with `pid`.",
    ),
  output: z
    .string()
    .min(1)
    .describe(
      "Absolute path where the `.memgraph` should be written. Must end in `.memgraph`.",
    ),
} as const;

export const captureMemgraphSchema = z
  .object(captureMemgraphShape)
  .superRefine((val, ctx) => {
    const targets = [val.pid, val.appName].filter(
      (v) => v !== undefined,
    ).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `pid` or `appName`.",
      });
    }
    if (!val.output.endsWith(".memgraph")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "`output` must end in `.memgraph`.",
      });
    }
  });

export type CaptureMemgraphInput = z.infer<typeof captureMemgraphSchema>;

export interface CaptureMemgraphResult {
  ok: boolean;
  pid: number;
  output: string;
  /**
   * Limitation reminder. Surfaced so callers stay aware of the device-physical caveat.
   */
  notice: string;
}

const PHYSICAL_DEVICE_NOTICE =
  "Note: `leaks --outputGraph` only works for processes running on the local Mac (which includes iOS simulators). It does not work for physical iOS devices — use Xcode's Memory Graph button + File > Export Memory Graph for those.";

/** Resolve an app name to a PID via `pgrep -x`. Errors when zero or multiple matches. */
export async function resolveAppNameToPid(appName: string): Promise<number> {
  const result = await runCommand("pgrep", ["-x", appName], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`No running process named "${appName}".`);
  }
  const pids = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) {
    throw new Error(`pgrep returned no PIDs for "${appName}".`);
  }
  if (pids.length > 1) {
    throw new Error(
      `Multiple processes match "${appName}": ${pids.join(", ")}. Pass \`pid\` directly to disambiguate.`,
    );
  }
  return pids[0];
}

export async function captureMemgraph(
  input: CaptureMemgraphInput,
): Promise<CaptureMemgraphResult> {
  const output = resolvePath(input.output);
  const outDir = dirname(output);
  if (!existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}`);
  }
  const pid =
    input.pid ??
    (input.appName ? await resolveAppNameToPid(input.appName) : 0);
  if (!pid) throw new Error("Could not determine a PID to capture.");

  const result = await runCommand(
    "leaks",
    ["--outputGraph", output, String(pid)],
    { timeoutMs: 2 * 60_000 },
  );
  // `leaks --outputGraph` writes the file even when leaks are present (exit 1).
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leaks --outputGraph failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(output)) {
    throw new Error(
      `leaks reported success but output file is missing: ${output}`,
    );
  }
  return { ok: true, pid, output, notice: PHYSICAL_DEVICE_NOTICE };
}
