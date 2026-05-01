import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly, walkCycles } from "../parsers/leaksOutput.js";
import type { CycleNode, LeaksReport } from "../types.js";

export const classifyCycleSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a `.memgraph` file."),
  maxResults: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Cap on classifications returned (default 20)."),
});

export type ClassifyCycleInput = z.infer<typeof classifyCycleSchema>;

export type Confidence = "high" | "medium" | "low";

export interface PatternMatch {
  /** Stable ID, used for catalog lookups in v0.2. */
  patternId: string;
  /** Human-readable name. */
  name: string;
  confidence: Confidence;
  /** Why we matched (which substrings/conditions hit). */
  reason: string;
  /** Suggested fix direction (one-liner). */
  fixHint: string;
}

export interface CycleClassification {
  rootClass: string;
  rootAddress: string;
  count?: number;
  /** Most likely match, or null when nothing recognized. */
  primaryMatch: PatternMatch | null;
  /** All matches that fired (a single cycle can match multiple patterns). */
  allMatches: PatternMatch[];
}

export interface ClassifyCycleResult {
  ok: boolean;
  path: string;
  totalCycles: number;
  classified: CycleClassification[];
}

interface PatternDefinition {
  id: string;
  name: string;
  fixHint: string;
  match: (root: CycleNode, allClasses: Set<string>) => Confidence | null;
}

/** Exposed for unit tests. Each entry is a concrete cycle signature plus the
 *  fix hint we'd suggest if the LLM is asked "how do I unstick this?". */
export const PATTERNS: PatternDefinition[] = [
  {
    id: "swiftui.tag-index-projection",
    name: "SwiftUI .tag(...) closure-over-self cycle",
    fixHint:
      "Replace `[weak self]` capture in tap closures with a static helper, OR weak-capture the coordinator/view-model directly with `[weak coord = self.coordinator]`. The `.tag()` modifier on photo carousels is the usual culprit.",
    match: (_root, allClasses) =>
      Array.from(allClasses).some((c) => c.includes("TagIndexProjection"))
        ? "high"
        : null,
  },
  {
    id: "swiftui.dictstorage-weakbox-cycle",
    name: "SwiftUI _DictionaryStorage<…WeakBox<AnyLocationBase>> internal cycle",
    fixHint:
      "This is a SwiftUI internal observation graph cycle. Triggered when a custom `@State`/`@Binding` chain is captured by a closure that outlives the view. Look up the chain for your app-level types and break the strong capture there.",
    match: (root) =>
      root.className.includes("_DictionaryStorage") &&
      root.className.includes("WeakBox<SwiftUI.AnyLocationBase>")
        ? "high"
        : null,
  },
  {
    id: "swiftui.foreach-state-tap",
    name: "SwiftUI ForEachState retained by tap-gesture closure",
    fixHint:
      "ForEachState is being kept alive by a tap-gesture closure that captures `self`. Make the tap handler a static function, or capture the necessary properties weakly.",
    match: (_root, allClasses) =>
      Array.from(allClasses).some((c) => c.startsWith("SwiftUI.ForEachState"))
        ? "medium"
        : null,
  },
  {
    id: "closure.viewmodel-wrapped-strong",
    name: "Closure capturing `_viewModel.wrappedValue` strongly",
    fixHint:
      "Closure context references `_viewModel.wrappedValue` via __strong. Capture the underlying ObservableObject weakly: `[weak vm = _viewModel.wrappedValue]` OR use a static helper that takes the VM as a parameter.",
    match: (root) => {
      for (const { node } of walkCycles([root])) {
        if (
          node.retainKind === "__strong" &&
          (node.edge?.includes("_viewModel.wrappedValue") ?? false)
        ) {
          return "high";
        }
      }
      return null;
    },
  },
  {
    id: "viewcontroller.uinavigationcontroller-host",
    name: "UIViewControllerRepresentable + UINavigationController host cycle",
    fixHint:
      "When wrapping a UIKit nav stack inside SwiftUI via UIViewControllerRepresentable, clear `viewControllers = []` in `dismantleUIViewController` to break the host->VC->host cycle.",
    match: (_root, allClasses) =>
      Array.from(allClasses).some((c) => c.includes("UINavigationController")) &&
      Array.from(allClasses).some((c) => c.includes("UIHostingController"))
        ? "medium"
        : null,
  },
  {
    id: "combine.sink-store-self-capture",
    name: "Combine .sink/.assign closure capturing self via AnyCancellable",
    fixHint:
      "Combine `.sink { self.x = ... }` (or `.assign(to:on:)` with `on: self`) keeps `self` alive through the AnyCancellable that's stored on `self`. Capture explicitly: `.sink { [weak self] in self?.x = ... }`. For property-path assignment prefer `.assign(to: \\$publisher)` (the `Published` form), which auto-cancels.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasCombine = classes.some(
        (c) => c.includes("AnyCancellable") || c.includes("Combine.Sink") || c.includes("Combine.Subscribers"),
      );
      const hasClosure = classes.some((c) => c.includes("Closure context"));
      return hasCombine && hasClosure ? "high" : hasCombine ? "medium" : null;
    },
  },
  {
    id: "concurrency.task-without-weak-self",
    name: "Swift `Task { }` body strongly capturing self",
    fixHint:
      "`Task { }` and `Task.detached { }` capture `self` strongly for the lifetime of the task. If the task outlives the owner (long-running loop, infinite stream), it pins `self`. Capture explicitly: `Task { [weak self] in guard let self else { return }; ... }`. For one-shot work, prefer making the closure body a method on a different actor.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasTask = classes.some(
        (c) =>
          c.includes("_Concurrency.Task") ||
          c.includes("TaskGroup") ||
          /\bTask<.+>/.test(c),
      );
      const hasClosure = classes.some((c) => c.includes("Closure context"));
      return hasTask && hasClosure ? "high" : hasTask ? "medium" : null;
    },
  },
  {
    id: "notificationcenter.observer-strong",
    name: "NotificationCenter observer block capturing self",
    fixHint:
      "`NotificationCenter.default.addObserver(forName:object:queue:using:)` (the block-based form) keeps the block alive in the center until you remove it; the block strongly captures whatever it touches. Either capture `[weak self]` in the block, or store the returned `NSObjectProtocol` and call `removeObserver(_:)` in `deinit`. Use the selector-based form (`addObserver(_:selector:...)`) — it auto-deregisters on deallocation in modern macOS/iOS, but the block form does not.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasNotif = classes.some(
        (c) =>
          c.includes("NSNotificationCenter") ||
          c.includes("NotificationCenter") ||
          c.includes("__NSObserver"),
      );
      const hasClosure = classes.some((c) => c.includes("Closure context"));
      return hasNotif && hasClosure ? "high" : hasNotif ? "medium" : null;
    },
  },
];

/** Pure: classify each ROOT CYCLE in the parsed report. */
export function classifyReport(
  report: LeaksReport,
  maxResults = 20,
): { totalCycles: number; classified: CycleClassification[] } {
  const roots = rootCyclesOnly(report.cycles);
  const classified: CycleClassification[] = roots
    .slice(0, maxResults)
    .map((root) => {
      const allClasses = new Set<string>();
      for (const { node } of walkCycles([root])) {
        if (node.className) allClasses.add(node.className);
      }
      const matches: PatternMatch[] = [];
      for (const p of PATTERNS) {
        const conf = p.match(root, allClasses);
        if (conf) {
          matches.push({
            patternId: p.id,
            name: p.name,
            confidence: conf,
            reason: `Pattern ${p.id} matched`,
            fixHint: p.fixHint,
          });
        }
      }
      const ranking = { high: 3, medium: 2, low: 1 } as const;
      matches.sort((a, b) => ranking[b.confidence] - ranking[a.confidence]);
      return {
        rootClass: root.className,
        rootAddress: root.address,
        count: root.count,
        primaryMatch: matches[0] ?? null,
        allMatches: matches,
      };
    });
  return { totalCycles: roots.length, classified };
}

export async function classifyCycle(
  input: ClassifyCycleInput,
): Promise<ClassifyCycleResult> {
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  const { totalCycles, classified } = classifyReport(
    report,
    input.maxResults ?? 20,
  );
  return { ok: true, path: resolvedPath, totalCycles, classified };
}
