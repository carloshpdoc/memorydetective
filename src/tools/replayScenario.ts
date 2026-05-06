/**
 * Drive the iOS Simulator through a sequence of UI actions to amplify a
 * suspected leak before capturing a memgraph. Tied to the leak/perf workflow:
 * the only reason this tool exists is to make verify-fix loops reproducible
 * (same scenario before/after a fix) and to surface leaks that only manifest
 * after N iterations of a flow.
 *
 * Soft dependency on `axe` (https://github.com/cameroncooke/AXe). When axe is
 * not on PATH, this tool returns ok:false with a structured workaroundNotice
 * pointing the caller at the install instructions, instead of throwing.
 */

import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  checkAxeAvailable,
  describeUI,
  swipe,
  tap,
  typeText,
  type TapTarget,
} from "../runtime/axe.js";

const tapActionSchema = z.object({
  type: z.literal("tap"),
  label: z
    .string()
    .optional()
    .describe(
      "Match an element by its accessibility label or identifier. Mutually exclusive with `coords` and `elementId`.",
    ),
  elementId: z
    .string()
    .optional()
    .describe(
      "Match an element by its accessibility identifier. Mutually exclusive with `label` and `coords`.",
    ),
  coords: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      "Tap at explicit [x, y] coordinates. Mutually exclusive with `label` and `elementId`.",
    ),
});

const swipeActionSchema = z.object({
  type: z.literal("swipe"),
  from: z.tuple([z.number(), z.number()]),
  to: z.tuple([z.number(), z.number()]),
  durationMs: z.number().int().positive().max(5000).default(250),
});

const waitActionSchema = z.object({
  type: z.literal("wait"),
  seconds: z.number().nonnegative().max(60),
});

const typeActionSchema = z.object({
  type: z.literal("type"),
  text: z.string(),
});

const actionSchema = z.discriminatedUnion("type", [
  tapActionSchema,
  swipeActionSchema,
  waitActionSchema,
  typeActionSchema,
]);

export type ReplayAction = z.infer<typeof actionSchema>;

export const replayScenarioShape = {
  simulatorUDID: z
    .string()
    .min(1)
    .describe("UDID of the booted simulator. Use listTraceDevices to find one."),
  actions: z
    .array(actionSchema)
    .min(1)
    .describe(
      "Ordered list of UI actions: { type: 'tap', label|elementId|coords }, { type: 'swipe', from, to }, { type: 'wait', seconds }, or { type: 'type', text }.",
    ),
  repeat: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(1)
    .describe(
      "Run the entire actions sequence this many times. Default 1. Use 5-10 to amplify subtle leaks that accumulate per repetition.",
    ),
  settleBetweenActionsMs: z
    .number()
    .int()
    .nonnegative()
    .max(10_000)
    .default(500)
    .describe(
      "Pause between consecutive actions in milliseconds. Default 500. Increase for animation-heavy flows.",
    ),
  finalUITreePath: z
    .string()
    .optional()
    .describe(
      "When provided, after the scenario completes the final UI tree is written here as JSON for the caller to verify the app ended in the expected state.",
    ),
} as const;

export const replayScenarioSchema = z.object(replayScenarioShape);

export type ReplayScenarioInput = z.infer<typeof replayScenarioSchema>;

export interface ReplayScenarioFailure {
  iteration: number;
  stepIndex: number;
  reason: string;
}

export interface ReplayScenarioWorkaroundNotice {
  issue: "axe-not-found";
  message: string;
}

export interface ReplayScenarioResult {
  ok: boolean;
  executedSteps: number;
  failures: ReplayScenarioFailure[];
  totalDurationMs: number;
  finalUITreePath?: string;
  workaroundNotice?: ReplayScenarioWorkaroundNotice;
}

export async function replayScenario(
  input: ReplayScenarioInput,
): Promise<ReplayScenarioResult> {
  const availability = await checkAxeAvailable();
  if (!availability.available) {
    return {
      ok: false,
      executedSteps: 0,
      failures: [],
      totalDurationMs: 0,
      workaroundNotice: {
        issue: "axe-not-found",
        message:
          availability.installHint ??
          "axe CLI not found. Required for replayScenario.",
      },
    };
  }

  const start = Date.now();
  const failures: ReplayScenarioFailure[] = [];
  let executedSteps = 0;

  for (let iteration = 0; iteration < input.repeat; iteration++) {
    for (let i = 0; i < input.actions.length; i++) {
      const action = input.actions[i];
      try {
        await executeAction(input.simulatorUDID, action);
        executedSteps++;
      } catch (err) {
        failures.push({
          iteration,
          stepIndex: i,
          reason: (err as Error).message,
        });
        // Continue with remaining actions in this iteration so the agent
        // gets the full picture instead of one early failure masking the rest.
      }
      if (input.settleBetweenActionsMs > 0) {
        await sleep(input.settleBetweenActionsMs);
      }
    }
  }

  let finalUITreePath: string | undefined;
  if (input.finalUITreePath) {
    try {
      const tree = await describeUI(input.simulatorUDID);
      ensureParentDir(input.finalUITreePath);
      await writeFile(
        input.finalUITreePath,
        JSON.stringify(tree, null, 2),
        "utf8",
      );
      finalUITreePath = input.finalUITreePath;
    } catch (err) {
      failures.push({
        iteration: input.repeat,
        stepIndex: input.actions.length,
        reason: `Failed to capture final UI tree: ${(err as Error).message}`,
      });
    }
  }

  return {
    ok: failures.length === 0,
    executedSteps,
    failures,
    totalDurationMs: Date.now() - start,
    ...(finalUITreePath ? { finalUITreePath } : {}),
  };
}

async function executeAction(
  udid: string,
  action: ReplayAction,
): Promise<void> {
  switch (action.type) {
    case "tap": {
      const target = resolveTapTarget(action);
      await tap(udid, target);
      return;
    }
    case "swipe":
      await swipe(
        udid,
        { x: action.from[0], y: action.from[1] },
        { x: action.to[0], y: action.to[1] },
        action.durationMs,
      );
      return;
    case "wait":
      await sleep(action.seconds * 1000);
      return;
    case "type":
      await typeText(udid, action.text);
      return;
  }
}

/** Pure: convert a tap-action input shape into the runtime TapTarget union. Exposed for tests. */
export function resolveTapTarget(action: {
  label?: string;
  elementId?: string;
  coords?: [number, number];
}): TapTarget {
  const provided = [action.label, action.elementId, action.coords].filter(
    (v) => v !== undefined,
  ).length;
  if (provided !== 1) {
    throw new Error(
      "tap action must provide exactly one of: label, elementId, coords.",
    );
  }
  if (action.coords) {
    return { kind: "coords", x: action.coords[0], y: action.coords[1] };
  }
  if (action.label) {
    return { kind: "label", value: action.label };
  }
  return { kind: "elementId", value: action.elementId! };
}

function ensureParentDir(filePath: string): void {
  const slash = filePath.lastIndexOf("/");
  if (slash === -1) return;
  const dir = filePath.slice(0, slash);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
