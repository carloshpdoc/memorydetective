import { z } from "zod";

/**
 * Meta-tool: returns the canonical investigation sequence for a known
 * problem class. Lets a fresh LLM agent jump straight to the right pipeline
 * without rediscovering the order from tool descriptions.
 *
 * Each playbook is a versioned, declarative sequence of tool calls with a
 * stable `step` number, a `purpose` line, and `argsTemplate` showing which
 * args matter most. The agent fills in concrete values from the user's
 * context (file paths, class names, etc.).
 */

export const PlaybookKindEnum = z.enum([
  "memgraph-leak",
  "perf-hangs",
  "ui-jank",
  "app-launch-slow",
  "verify-fix",
]);

export const getInvestigationPlaybookSchema = z.object({
  kind: PlaybookKindEnum.describe(
    "Which investigation flow to return. `memgraph-leak` is the most common — diagnose a SwiftUI/Combine retain cycle from a `.memgraph` and locate it in source.",
  ),
});

export type GetInvestigationPlaybookInput = z.infer<
  typeof getInvestigationPlaybookSchema
>;

export type PlaybookKind = z.infer<typeof PlaybookKindEnum>;

export interface PlaybookStep {
  step: number;
  tool: string;
  purpose: string;
  argsTemplate: Record<string, unknown>;
  /** Optional notes about how to interpret the result before moving to the next step. */
  resultGuidance?: string;
}

export interface Playbook {
  kind: PlaybookKind;
  summary: string;
  steps: PlaybookStep[];
  /** Pointers to alternative playbooks the agent might want next. */
  seeAlso?: PlaybookKind[];
}

const PLAYBOOKS: Record<PlaybookKind, Playbook> = {
  "memgraph-leak": {
    kind: "memgraph-leak",
    summary:
      "Diagnose a SwiftUI / Combine retain cycle from a `.memgraph` snapshot, locate the offending code, and propose a fix.",
    steps: [
      {
        step: 1,
        tool: "analyzeMemgraph",
        purpose:
          "Run leaks(1) and get totals + top-level ROOT CYCLE summaries with class chains in compact form.",
        argsTemplate: { path: "<absolute path to the .memgraph>" },
        resultGuidance:
          "Note the count of ROOT CYCLEs and the dominant class chain. The response includes `suggestedNextCalls` — follow them.",
      },
      {
        step: 2,
        tool: "classifyCycle",
        purpose:
          "Match each ROOT CYCLE against the built-in catalog of known antipatterns. Returns a fix hint and pre-populated `suggestedNextCalls` for source-code lookup.",
        argsTemplate: { path: "<same path as step 1>" },
        resultGuidance:
          "If `primaryMatch` is `null`, the cycle is novel — use `findRetainers` to walk the chain manually instead.",
      },
      {
        step: 3,
        tool: "reachableFromCycle",
        purpose:
          "Confirm which app-level class is the actual culprit (cycle root) versus collateral retained instances.",
        argsTemplate: {
          path: "<same path>",
          rootClassName: "<class from step 2's primaryMatch>",
        },
        resultGuidance:
          "If a single app-level class dominates `counts`, that's the leak. If many compete, the cycle may be deeper than a single owner.",
      },
      {
        step: 4,
        tool: "swiftSearchPattern",
        purpose:
          "Locate the code construct the classifier flagged (e.g. `.tag(`, `.sink {`, `Task {`).",
        argsTemplate: {
          filePath: "<a candidate Swift file in the project>",
          pattern: "<from step 2's suggestedNextCalls>",
        },
      },
      {
        step: 5,
        tool: "swiftGetSymbolDefinition",
        purpose: "Jump to the declaration of the cycle's app-level class.",
        argsTemplate: {
          symbolName: "<class from step 3>",
          candidatePaths: ["<Sources/, app target dirs>"],
        },
      },
      {
        step: 6,
        tool: "swiftFindSymbolReferences",
        purpose:
          "List every callsite — useful to compare capture-list patterns across them and detect inconsistencies.",
        argsTemplate: {
          symbolName: "<class from step 3>",
          filePath: "<from step 5 result>",
        },
      },
    ],
    seeAlso: ["verify-fix"],
  },

  "perf-hangs": {
    kind: "perf-hangs",
    summary:
      "Diagnose user-visible main-thread hangs from a `.trace` recorded with the Time Profiler or Hangs template.",
    steps: [
      {
        step: 1,
        tool: "listTraceDevices",
        purpose: "Find the simulator or device UDID to attach to.",
        argsTemplate: {},
      },
      {
        step: 2,
        tool: "recordTimeProfile",
        purpose: "Capture a fresh `.trace` while reproducing the slow path.",
        argsTemplate: {
          template: "Time Profiler",
          deviceId: "<from step 1>",
          attachAppName: "<your app name>",
          durationSec: 90,
          output: "<absolute path ending in .trace>",
        },
      },
      {
        step: 3,
        tool: "analyzeHangs",
        purpose:
          "Parse the `potential-hangs` schema; report Hang vs Microhang counts plus the top N longest.",
        argsTemplate: {
          tracePath: "<from step 2>",
          minDurationMs: 250,
        },
      },
      {
        step: 4,
        tool: "swiftSearchPattern",
        purpose:
          "If hangs are dominated by a specific call site (visible in `top` entries), grep for likely main-thread offenders: `Task { ... }` blocks without `[weak self]`, synchronous I/O on the main queue, etc.",
        argsTemplate: {
          filePath: "<candidate file>",
          pattern: "DispatchQueue\\.main\\.sync|Task\\s*\\{",
        },
      },
    ],
    seeAlso: ["ui-jank", "app-launch-slow"],
  },

  "ui-jank": {
    kind: "ui-jank",
    summary:
      "Diagnose dropped frames / animation hitches from a `.trace` recorded with the Animation Hitches template.",
    steps: [
      {
        step: 1,
        tool: "recordTimeProfile",
        purpose:
          "Capture a `.trace` with the Animation Hitches template active.",
        argsTemplate: {
          template: "Animation Hitches",
          deviceId: "<UDID>",
          attachAppName: "<app>",
          durationSec: 60,
          output: "<.trace path>",
        },
      },
      {
        step: 2,
        tool: "analyzeAnimationHitches",
        purpose:
          "Parse the `animation-hitches` schema; report by-type counts and the count of user-perceptible hitches (>100ms).",
        argsTemplate: { tracePath: "<from step 1>", minDurationMs: 100 },
      },
      {
        step: 3,
        tool: "swiftFindSymbolReferences",
        purpose:
          "Once a suspected `View` is identified, find callsites to scope which screens render with this view.",
        argsTemplate: { symbolName: "<View name>", filePath: "<source>" },
      },
    ],
  },

  "app-launch-slow": {
    kind: "app-launch-slow",
    summary:
      "Diagnose cold/warm launch slowness from a `.trace` recorded with the App Launch template.",
    steps: [
      {
        step: 1,
        tool: "recordTimeProfile",
        purpose: "Capture a launch trace.",
        argsTemplate: {
          template: "App Launch",
          deviceId: "<UDID>",
          launchBundleId: "<com.example.app>",
          durationSec: 30,
          output: "<.trace path>",
        },
      },
      {
        step: 2,
        tool: "analyzeAppLaunch",
        purpose:
          "Get cold/warm classification + per-phase breakdown (process-creation, dyld, ObjC init, AppDelegate, first-frame).",
        argsTemplate: { tracePath: "<from step 1>" },
      },
      {
        step: 3,
        tool: "swiftSearchPattern",
        purpose:
          "If `appdelegate-init` dominates, grep for synchronous work in `application(_:didFinishLaunchingWithOptions:)`.",
        argsTemplate: {
          filePath: "<AppDelegate.swift>",
          pattern: "didFinishLaunchingWithOptions",
        },
      },
    ],
  },

  "verify-fix": {
    kind: "verify-fix",
    summary:
      "Confirm a fix actually closed a known cycle by diffing a before/after pair of `.memgraph` snapshots.",
    steps: [
      {
        step: 1,
        tool: "diffMemgraphs",
        purpose:
          "Compare totals + class-count deltas + cycle signatures across before/after snapshots.",
        argsTemplate: {
          before: "<path to before.memgraph>",
          after: "<path to after.memgraph>",
        },
        resultGuidance:
          "Look for the originally-classified cycle in `cycles.goneFromBefore`. If still in `cycles.persisted`, the fix didn't address the right capture.",
      },
      {
        step: 2,
        tool: "classifyCycle",
        purpose:
          "Re-classify the after snapshot to confirm no new patterns appeared.",
        argsTemplate: { path: "<path to after.memgraph>" },
      },
    ],
    seeAlso: ["memgraph-leak"],
  },
};

export interface GetInvestigationPlaybookResult {
  ok: boolean;
  playbook: Playbook;
}

export async function getInvestigationPlaybook(
  input: GetInvestigationPlaybookInput,
): Promise<GetInvestigationPlaybookResult> {
  const playbook = PLAYBOOKS[input.kind];
  if (!playbook) {
    throw new Error(
      `Unknown playbook kind: ${input.kind}. Known: ${Object.keys(PLAYBOOKS).join(", ")}`,
    );
  }
  return { ok: true, playbook };
}

/** Exposed for tests + the prompts surface. */
export const PLAYBOOK_KINDS = Object.keys(PLAYBOOKS) as PlaybookKind[];

/** Exposed for the prompts surface (see src/runtime/prompts.ts). */
export { PLAYBOOKS };
