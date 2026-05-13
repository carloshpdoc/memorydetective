/**
 * Composite snapshot for verify-fix loops: capture a memgraph + screenshot +
 * UI tree from the current simulator state into one labeled bundle. The
 * intended workflow is `captureScenarioState({label:"before"})` → run a fix
 * (or further repro via replayScenario) → `captureScenarioState({label:"after"})`
 * → diffMemgraphs across the two outputs.
 *
 * Each sub-capture (memgraph, screenshot, uiTree) is best-effort: if one
 * fails, the others still proceed and the failure is surfaced via
 * `subFailures` so the caller has partial state instead of nothing.
 */

import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";
import {
  captureMemgraph,
  type CaptureMemgraphResult,
  type WorkaroundNotice,
} from "./captureMemgraph.js";
import { takeScreenshot } from "../runtime/simctl.js";
import { checkAxeAvailable, describeUI } from "../runtime/axe.js";
import {
  getPlatformAdvisory,
  maybeLogPlatformAdvisoryOnce,
  type PlatformAdvisory,
} from "../runtime/platformCheck.js";

export const captureScenarioStateShape = {
  simulatorUDID: z
    .string()
    .min(1)
    .describe(
      "UDID of the booted simulator hosting the target app. Used for screenshot + UI tree captures.",
    ),
  pid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "PID of the host-side app process. Mutually exclusive with `appName`. Pass the value returned by bootAndLaunchForLeakInvestigation.",
    ),
  appName: z
    .string()
    .optional()
    .describe(
      "App executable name as visible in pgrep. Mutually exclusive with `pid`.",
    ),
  outputDir: z
    .string()
    .min(1)
    .describe(
      "Absolute directory where the snapshot files are written. Created if it does not exist.",
    ),
  label: z
    .string()
    .min(1)
    .default("snapshot")
    .describe(
      "Filename prefix for the captured artifacts. Use \"before\" / \"after\" for verify-fix flows.",
    ),
  include: z
    .array(z.enum(["memgraph", "screenshot", "uiTree"]))
    .default(["memgraph", "screenshot", "uiTree"])
    .describe(
      "Which artifacts to capture. Default captures all three.",
    ),
} as const;

export const captureScenarioStateSchema = z
  .object(captureScenarioStateShape)
  .superRefine((val, ctx) => {
    const targets = [val.pid, val.appName].filter((v) => v !== undefined).length;
    if (targets !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `pid` or `appName`.",
      });
    }
  });

export type CaptureScenarioStateInput = z.infer<
  typeof captureScenarioStateSchema
>;

export interface CaptureScenarioSubFailure {
  kind: "memgraph" | "screenshot" | "uiTree";
  reason: string;
}

export interface CaptureScenarioStateResult {
  ok: boolean;
  label: string;
  outputDir: string;
  memgraphPath?: string;
  screenshotPath?: string;
  uiTreePath?: string;
  /** Surfaced from captureMemgraph when leaks fails with a known issue. */
  memgraphWorkaroundNotice?: WorkaroundNotice;
  subFailures: CaptureScenarioSubFailure[];
  warnings?: string[];
  /**
   * Present on hosts where a platform-side regression affects the memgraph
   * sub-capture (today: macOS 26.x `task_for_pid` kernel regression).
   * Surfaced even when the screenshot + uiTree sub-captures succeed, so the
   * caller knows the memgraph failure is not a misconfiguration on their end.
   */
  platformAdvisory?: PlatformAdvisory;
}

export async function captureScenarioState(
  input: CaptureScenarioStateInput,
): Promise<CaptureScenarioStateResult> {
  const platformAdvisory = getPlatformAdvisory();
  maybeLogPlatformAdvisoryOnce(platformAdvisory);

  const outputDir = resolvePath(input.outputDir);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const subFailures: CaptureScenarioSubFailure[] = [];
  const warnings: string[] = [];

  const safeLabel = sanitizeLabel(input.label);

  let memgraphPath: string | undefined;
  let memgraphWorkaroundNotice: WorkaroundNotice | undefined;
  if (input.include.includes("memgraph")) {
    const target = joinPath(outputDir, `${safeLabel}.memgraph`);
    try {
      const result: CaptureMemgraphResult = await captureMemgraph({
        ...(input.pid ? { pid: input.pid } : {}),
        ...(input.appName ? { appName: input.appName } : {}),
        output: target,
      } as Parameters<typeof captureMemgraph>[0]);
      if (result.ok && result.output) {
        memgraphPath = result.output;
      } else {
        memgraphWorkaroundNotice = result.workaroundNotice;
        subFailures.push({
          kind: "memgraph",
          reason:
            result.workaroundNotice?.message ??
            result.stderr ??
            "captureMemgraph reported ok:false without a workaroundNotice.",
        });
      }
      if (result.warnings) {
        warnings.push(...result.warnings);
      }
    } catch (err) {
      subFailures.push({
        kind: "memgraph",
        reason: (err as Error).message,
      });
    }
  }

  let screenshotPath: string | undefined;
  if (input.include.includes("screenshot")) {
    const target = joinPath(outputDir, `${safeLabel}.png`);
    try {
      await takeScreenshot(input.simulatorUDID, target);
      screenshotPath = target;
    } catch (err) {
      subFailures.push({
        kind: "screenshot",
        reason: (err as Error).message,
      });
    }
  }

  let uiTreePath: string | undefined;
  if (input.include.includes("uiTree")) {
    const target = joinPath(outputDir, `${safeLabel}.ui.json`);
    const availability = await checkAxeAvailable();
    if (!availability.available) {
      subFailures.push({
        kind: "uiTree",
        reason:
          availability.installHint ??
          "axe CLI not found. uiTree capture requires axe.",
      });
    } else {
      try {
        const tree = await describeUI(input.simulatorUDID);
        await writeFile(target, JSON.stringify(tree, null, 2), "utf8");
        uiTreePath = target;
      } catch (err) {
        subFailures.push({
          kind: "uiTree",
          reason: (err as Error).message,
        });
      }
    }
  }

  const ok = subFailures.length === 0;
  return {
    ok,
    label: input.label,
    outputDir,
    ...(memgraphPath ? { memgraphPath } : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(uiTreePath ? { uiTreePath } : {}),
    ...(memgraphWorkaroundNotice ? { memgraphWorkaroundNotice } : {}),
    subFailures,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(platformAdvisory ? { platformAdvisory } : {}),
  };
}

/** Pure: replace filesystem-unsafe characters in a label. Exposed for tests. */
export function sanitizeLabel(label: string): string {
  return label
    .replace(/[\/\\:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "snapshot";
}
