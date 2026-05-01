/**
 * Helpers for building `suggestedNextCalls` arrays. Centralized so multiple
 * tools agree on the same heuristics for "which class is most actionable"
 * and "which followup is most useful".
 */

import type { CycleSummary } from "../tools/analyzeMemgraph.js";
import type { NextCallSuggestion } from "../types.js";

/** Class names that are SwiftUI / Foundation internals; never the user's code. */
const STDLIB_PREFIXES = [
  "Swift.",
  "SwiftUI.",
  "Foundation.",
  "Combine.",
  "_Concurrency.",
  "_DictionaryStorage",
  "Closure",
  "ForEach",
  "Modified",
  "AsyncImage",
  "StoredLocation",
  "LocationBox",
  "TagIndex",
  "AnyHashable",
  "WeakBox",
  "AnyLocation",
  "MutableBox",
  "AGSubgraph",
  "NSURL",
  "NSObject",
  "NSDictionary",
  "NSMutableArray",
  "NSMutableDictionary",
  "NSHashTable",
  "NSLock",
  "CFDictionary",
  "_NSURL",
  "__NS",
];

/** True when this class name looks like the user's own code (not stdlib / system). */
export function looksAppLevel(className: string): boolean {
  if (!className) return false;
  return !STDLIB_PREFIXES.some((p) => className.startsWith(p));
}

/**
 * From a list of class names in a cycle, pick the most likely "the thing the
 * user wrote" — the dominant app-level class. Used to seed swift* followups.
 */
export function pickPrimaryAppClass(classNames: string[]): string | null {
  for (const name of classNames) {
    if (looksAppLevel(name)) return name;
  }
  return null;
}

/** Pull primary app-level class from a CycleSummary's chain. */
export function primaryAppClassFor(summary: CycleSummary): string | null {
  return pickPrimaryAppClass(summary.classesInChain);
}

/**
 * Build a suggestedNextCalls array for `classifyCycle`'s output.
 * Maps the matched pattern + the cycle root to the most useful followups.
 */
export function suggestionsForClassification(opts: {
  patternId: string | null;
  rootClass: string;
  appLevelClass: string | null;
}): NextCallSuggestion[] {
  const out: NextCallSuggestion[] = [];

  // Pattern → likely fix-locator regex.
  const patternToRegex = patternToCodeSearchRegex(opts.patternId);
  if (patternToRegex) {
    out.push({
      tool: "swiftSearchPattern",
      args: {
        pattern: patternToRegex,
        // Caller fills in filePath; we leave a placeholder so the agent
        // notices and substitutes.
        filePath: "<set to a candidate Swift file in your project>",
      },
      why: `Locate the code construct implicated by ${opts.patternId ?? "the matched pattern"}. The regex matches the SwiftUI / Combine signal that produces this cycle.`,
    });
  }

  if (opts.appLevelClass) {
    out.push({
      tool: "swiftGetSymbolDefinition",
      args: {
        symbolName: opts.appLevelClass,
        candidatePaths: ["<set to a Sources/ or app target directory>"],
      },
      why: `Jump to the declaration of ${opts.appLevelClass}, the user-defined type captured in this cycle.`,
    });
  }

  return out;
}

/**
 * Map a pattern id to a Swift regex that surfaces the offending code.
 * Returns `null` when we don't have a clean pattern → regex translation
 * (better to omit a hint than to suggest a broken one).
 */
function patternToCodeSearchRegex(patternId: string | null): string | null {
  switch (patternId) {
    case "swiftui.tag-index-projection":
      return "\\.tag\\(";
    case "swiftui.foreach-state-tap":
      return "ForEach\\b[\\s\\S]{0,200}?\\.onTapGesture";
    case "closure.viewmodel-wrapped-strong":
      return "_viewModel\\.wrappedValue";
    case "viewcontroller.uinavigationcontroller-host":
      return "UIHostingController|dismantleUIViewController";
    case "combine.sink-store-self-capture":
      return "\\.sink\\s*\\{";
    case "concurrency.task-without-weak-self":
      return "Task\\s*\\{";
    case "notificationcenter.observer-strong":
      return "addObserver\\s*\\(\\s*forName";
    case "swiftui.dictstorage-weakbox-cycle":
      // Internal SwiftUI; no user-code surface to point at directly.
      return null;
    default:
      return null;
  }
}

/** Build suggestion to call swiftFindSymbolReferences for a class name. */
export function suggestionFindReferences(opts: {
  symbolName: string;
  filePath?: string;
}): NextCallSuggestion {
  return {
    tool: "swiftFindSymbolReferences",
    args: {
      symbolName: opts.symbolName,
      filePath: opts.filePath ?? "<set to the file where the symbol is declared>",
    },
    why: `Find every callsite of ${opts.symbolName} in the project. Useful to compare capture-list patterns across callsites.`,
  };
}

/** Build suggestion to call swiftGetSymbolDefinition for a class name. */
export function suggestionGetDefinition(opts: {
  symbolName: string;
  candidatePaths?: string[];
}): NextCallSuggestion {
  return {
    tool: "swiftGetSymbolDefinition",
    args: {
      symbolName: opts.symbolName,
      candidatePaths: opts.candidatePaths ?? [
        "<set to Sources/ or app target directories>",
      ],
    },
    why: `Locate where ${opts.symbolName} is declared in the project.`,
  };
}

/** Build suggestion to call classifyCycle (used after analyzeMemgraph). */
export function suggestionClassifyCycle(opts: {
  path: string;
}): NextCallSuggestion {
  return {
    tool: "classifyCycle",
    args: { path: opts.path },
    why: "Match each ROOT CYCLE against the built-in pattern catalog to get a named antipattern + concrete fix hint.",
  };
}

/** Build suggestion to call reachableFromCycle (used after analyzeMemgraph). */
export function suggestionReachableFromCycle(opts: {
  path: string;
  cycleIndex?: number;
}): NextCallSuggestion {
  return {
    tool: "reachableFromCycle",
    args: {
      path: opts.path,
      cycleIndex: opts.cycleIndex ?? 0,
    },
    why: "Confirm which app-level class is the actual culprit (the cycle root) versus collateral retained dependencies.",
  };
}
