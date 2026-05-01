import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { runCommand } from "../runtime/exec.js";

/**
 * Base shape — exposed so the MCP layer can read `.shape` (ZodEffects from
 * `.superRefine()` doesn't expose shape).
 */
export const recordTimeProfileShape = {
  template: z
    .string()
    .default("Time Profiler")
    .describe(
      "xctrace template name (e.g. \"Time Profiler\", \"Animation Hitches\", \"Allocations\"). Default \"Time Profiler\".",
    ),
  deviceId: z
    .string()
    .optional()
    .describe("UDID of a physical device. Mutually exclusive with `simulatorId`."),
  simulatorId: z
    .string()
    .optional()
    .describe(
      "UDID of a simulator. Mutually exclusive with `deviceId`. Use `listTraceDevices` to find UDIDs.",
    ),
  attachAppName: z
    .string()
    .optional()
    .describe(
      "Attach to a running app by name (e.g. \"DemoApp\"). Mutually exclusive with `attachPid` and `launchBundleId`.",
    ),
  attachPid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Attach by PID. Mutually exclusive with `attachAppName` and `launchBundleId`."),
  launchBundleId: z
    .string()
    .optional()
    .describe(
      "Launch app by bundle id and start recording at launch. Mutually exclusive with `attachAppName` and `attachPid`.",
    ),
  durationSec: z
    .number()
    .int()
    .positive()
    .max(600)
    .default(90)
    .describe("Recording duration in seconds (default 90, max 600)."),
  output: z
    .string()
    .min(1)
    .describe(
      "Absolute path where the resulting `.trace` bundle should be written. Must end in `.trace`.",
    ),
} as const;

export const recordTimeProfileSchema = z
  .object(recordTimeProfileShape)
  .superRefine((val, ctx) => {
    const targets = [val.deviceId, val.simulatorId].filter(Boolean).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `deviceId` or `simulatorId`.",
      });
    }
    const attaches = [val.attachAppName, val.attachPid, val.launchBundleId].filter(
      (v) => v !== undefined,
    ).length;
    if (attaches !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of `attachAppName`, `attachPid`, or `launchBundleId`.",
      });
    }
    if (!val.output.endsWith(".trace")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "`output` must end in `.trace`.",
      });
    }
  });

export type RecordTimeProfileInput = z.infer<typeof recordTimeProfileSchema>;

export interface RecordTimeProfileResult {
  ok: boolean;
  command: string;
  output: string;
  durationSec: number;
  template: string;
  stderr?: string;
}

/** Pure: build the xctrace argv for the given input. Exposed for testing. */
export function buildXctraceArgs(input: RecordTimeProfileInput): string[] {
  const args = ["xctrace", "record", "--template", input.template];
  if (input.deviceId) args.push("--device", input.deviceId);
  else if (input.simulatorId) args.push("--device", input.simulatorId);
  if (input.attachAppName) args.push("--attach", input.attachAppName);
  else if (input.attachPid) args.push("--attach", String(input.attachPid));
  if (input.launchBundleId) {
    args.push("--launch", "--", input.launchBundleId);
  }
  args.push("--time-limit", `${input.durationSec}s`);
  args.push("--output", resolvePath(input.output));
  return args;
}

export async function recordTimeProfile(
  input: RecordTimeProfileInput,
): Promise<RecordTimeProfileResult> {
  const output = resolvePath(input.output);
  const outDir = dirname(output);
  if (!existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}`);
  }
  const args = buildXctraceArgs({ ...input, output });
  const result = await runCommand("xcrun", args, {
    // Allow 30s grace beyond the recording duration for export/finalization.
    timeoutMs: (input.durationSec + 60) * 1_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `xctrace record failed (code ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return {
    ok: true,
    command: `xcrun ${args.join(" ")}`,
    output,
    durationSec: input.durationSec,
    template: input.template,
    stderr: result.stderr || undefined,
  };
}
