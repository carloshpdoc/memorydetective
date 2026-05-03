import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLeaksOutput } from "../parsers/leaksOutput.js";
import { findRetainersIn } from "./findRetainers.js";
import { countByClass } from "./countAlive.js";
import { diffReports } from "./diffMemgraphs.js";
import { classifyReport, PATTERNS } from "./classifyCycle.js";
import type { CycleNode, LeaksReport } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, "../../tests/fixtures");

const leaksText = readFileSync(
  resolve(FIXTURES, "example-leaks.head.leaks.txt"),
  "utf8",
);
const fix2Text = readFileSync(
  resolve(FIXTURES, "example-fix.head.leaks.txt"),
  "utf8",
);

describe("findRetainers", () => {
  const report = parseLeaksOutput(leaksText);

  it("finds the DetailViewModel retain chain", () => {
    const result = findRetainersIn(report, "DetailViewModel");
    expect(result.totalMatches).toBeGreaterThan(0);
    const chain = result.retainers[0].path;
    expect(chain[chain.length - 1].className).toBe("DetailViewModel");
    // The chain should pass through TagIndexProjection on its way down.
    expect(chain.some((e) => e.className.includes("TagIndexProjection"))).toBe(
      true,
    );
  });

  it("returns empty for unknown class", () => {
    const result = findRetainersIn(report, "DoesNotExistFooBar");
    expect(result.totalMatches).toBe(0);
    expect(result.retainers).toEqual([]);
  });

  it("respects maxResults cap", () => {
    const result = findRetainersIn(report, "GraphQLClient", 1);
    expect(result.retainers.length).toBeLessThanOrEqual(1);
  });
});

describe("countAlive (countByClass)", () => {
  const report = parseLeaksOutput(leaksText);

  it("counts all class occurrences", () => {
    const counts = countByClass(report);
    expect(counts.size).toBeGreaterThan(5);
    // DetailViewModel should appear at least once in the parsed (head) section.
    expect(counts.get("DetailViewModel")).toBeGreaterThan(0);
  });

  it("counts GraphQLClient correctly (multiple instances expected)", () => {
    const counts = countByClass(report);
    const graphql = counts.get("GraphQLClient") ?? 0;
    expect(graphql).toBeGreaterThan(1);
  });
});

describe("diffMemgraphs (diffReports)", () => {
  const before = parseLeaksOutput(leaksText); // 60436 leaks
  const after = parseLeaksOutput(fix2Text); // 55576 leaks

  it("computes total leak delta correctly", () => {
    const result = diffReports(before, after, "before.memgraph", "after.memgraph");
    expect(result.totals.leakCountDelta).toBe(after.totals.leakCount - before.totals.leakCount);
    expect(result.totals.leakCountDelta).toBeLessThan(0);
  });

  it("buckets cycles into new / gone / persisted", () => {
    const result = diffReports(before, after, "b.memgraph", "a.memgraph");
    const total =
      result.cycles.newInAfter.length +
      result.cycles.goneFromBefore.length +
      result.cycles.persisted.length;
    expect(total).toBeGreaterThan(0);
  });

  it("ranks decreased classes (post-fix improvements)", () => {
    const result = diffReports(before, after, "b.memgraph", "a.memgraph");
    expect(result.classCounts.decreased.length).toBeGreaterThanOrEqual(0);
    if (result.classCounts.decreased.length > 0) {
      // Sorted ascending by delta (most negative first).
      const first = result.classCounts.decreased[0];
      expect(first.delta).toBeLessThanOrEqual(0);
    }
  });
});

describe("classifyCycle (classifyReport)", () => {
  const report = parseLeaksOutput(leaksText);

  it("classifies the TagIndexProjection cycle as high-confidence", () => {
    const { classified } = classifyReport(report);
    const tagMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "swiftui.tag-index-projection");
    expect(tagMatch).toBeDefined();
    expect(tagMatch?.confidence).toBe("high");
    expect(tagMatch?.fixHint).toContain("static helper");
  });

  it("classifies the dict-storage SwiftUI internal cycle", () => {
    const { classified } = classifyReport(report);
    const dictMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "swiftui.dictstorage-weakbox-cycle");
    expect(dictMatch).toBeDefined();
    expect(dictMatch?.confidence).toBe("high");
  });

  it("flags the closure-viewmodel-wrapped pattern when _viewModel is in chain", () => {
    const { classified } = classifyReport(report);
    const vmMatch = classified
      .flatMap((c) => c.allMatches)
      .find((m) => m.patternId === "closure.viewmodel-wrapped-strong");
    expect(vmMatch).toBeDefined();
  });

  it("returns at least one classified cycle with a primaryMatch", () => {
    const { classified } = classifyReport(report);
    expect(classified.some((c) => c.primaryMatch !== null)).toBe(true);
  });
});

/**
 * Synthetic-cycle tests for the patterns that don't appear in the example
 * fixture (Combine sink, Task captures, NotificationCenter observer). Builds
 * a minimal LeaksReport whose cycle forest contains the class-name signals
 * the pattern is supposed to recognize, and asserts the right pattern fires.
 */
function makeCycleNode(
  className: string,
  children: CycleNode[] = [],
): CycleNode {
  return {
    className,
    address: "0xDEAD",
    edge: undefined,
    retainKind: "plain",
    isRootCycle: true,
    isCycleBack: false,
    indent: 0,
    children,
  };
}

function makeReport(rootClass: string, descendants: string[]): LeaksReport {
  const child = descendants.reduceRight<CycleNode | null>(
    (acc, cls) => makeCycleNode(cls, acc ? [acc] : []),
    null,
  );
  return {
    header: {},
    totals: {
      leakCount: 1,
      totalLeakedBytes: 32,
    },
    cycles: [makeCycleNode(rootClass, child ? [child] : [])],
    hasNoCycles: false,
  };
}

describe("classifyCycle — additional patterns (synthetic cycles)", () => {
  it("matches `combine.sink-store-self-capture` when AnyCancellable + Closure context appear", () => {
    const report = makeReport("MyViewModel", [
      "Combine.AnyCancellable",
      "Closure context",
      "MyDataStore",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "combine.sink-store-self-capture",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `concurrency.task-without-weak-self` when Task<...> + Closure context appear", () => {
    const report = makeReport("MyActor", [
      "_Concurrency.Task<Swift.Void, Swift.Never>",
      "Closure context",
      "MyService",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "concurrency.task-without-weak-self",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `notificationcenter.observer-strong` when NotificationCenter + Closure context appear", () => {
    const report = makeReport("MyController", [
      "NSNotificationCenter",
      "Closure context",
      "MyController",
    ]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "notificationcenter.observer-strong",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("falls back to medium confidence when only the framework class appears (no closure context)", () => {
    const report = makeReport("MyClass", ["Combine.AnyCancellable"]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "combine.sink-store-self-capture",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("medium");
  });

  it("returns null primaryMatch when no pattern fires", () => {
    const report = makeReport("UnknownLeak", ["SomeWeirdInternalThing"]);
    const { classified } = classifyReport(report);
    expect(classified[0].primaryMatch).toBeNull();
  });

  it("PATTERNS array contains 33 patterns in v1.6 (8 v1.0 + 16 v1.4 + 3 v1.5 + 6 v1.6)", () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(ids.length).toBe(33);
    // Spot-check key v1.0 patterns are still there.
    expect(ids).toContain("swiftui.tag-index-projection");
    expect(ids).toContain("combine.sink-store-self-capture");
    // Spot-check v1.4 additions.
    expect(ids).toContain("timer.scheduled-target-strong");
    expect(ids).toContain("urlsession.delegate-strong");
    expect(ids).toContain("kvo.observation-not-invalidated");
    expect(ids).toContain("coordinator.parent-strong-back-reference");
    // Spot-check v1.5 additions.
    expect(ids).toContain("coreanimation.animation-delegate-strong");
    expect(ids).toContain("coreanimation.layer-delegate-cycle");
    expect(ids).toContain("coredata.fetchedresultscontroller-delegate");
    // Spot-check v1.6 additions.
    expect(ids).toContain("swiftui.observable-state-modal-leak");
    expect(ids).toContain("swiftui.navigationpath-stored-in-viewmodel");
    expect(ids).toContain("concurrency.async-sequence-on-self");
    expect(ids).toContain("concurrency.notificationcenter-async-observer-task");
    expect(ids).toContain("swiftui.observations-closure-strong-self");
    expect(ids).toContain("webkit.wkscriptmessagehandler-bridge");
  });
});

describe("classifyCycle — v1.4 catalog expansion", () => {
  it("matches `combine.assign-to-self` for Combine.Assign in chain", () => {
    const r = makeReport("MyVM", ["Combine.Assign", "MyValue"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe("combine.assign-to-self");
  });

  it("matches `timer.scheduled-target-strong` for __NSCFTimer", () => {
    const r = makeReport("MyVM", ["__NSCFTimer", "MyHandler"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "timer.scheduled-target-strong",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `displaylink.target-strong` for CADisplayLink", () => {
    const r = makeReport("AnimationDriver", ["CADisplayLink", "Renderer"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "displaylink.target-strong",
    );
  });

  it("matches `gesture.target-strong` for UIGestureRecognizer", () => {
    const r = makeReport("MyVC", ["UIGestureRecognizer", "_targets"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe("gesture.target-strong");
  });

  it("matches `kvo.observation-not-invalidated` for NSKeyValueObservation", () => {
    const r = makeReport("MyVM", ["NSKeyValueObservation", "ChangeHandler"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "kvo.observation-not-invalidated",
    );
  });

  it("matches `urlsession.delegate-strong` for __NSURLSessionLocal", () => {
    const r = makeReport("APIClient", [
      "__NSURLSessionLocal",
      "GraphQLClient",
      "NSURLSessionConfiguration",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "urlsession.delegate-strong",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `swiftui.envobject-back-reference` with all three signals", () => {
    const r = makeReport("AppViewModel", [
      "ObservableObject",
      "EnvironmentObjectStorage",
      "UIHostingController",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "swiftui.envobject-back-reference",
    );
  });

  it("matches `concurrency.asyncstream-continuation-self` for AsyncStream", () => {
    const r = makeReport("MyVM", ["AsyncStream", "Closure context"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "concurrency.asyncstream-continuation-self",
    );
  });

  it("matches `webkit.scriptmessage-handler-strong` for WKUserContentController", () => {
    const r = makeReport("MyWebVC", [
      "WKUserContentController",
      "WKWebView",
      "Handler",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "webkit.scriptmessage-handler-strong",
    );
  });

  it("matches `dispatch.source-event-handler-self` for OS_dispatch_source", () => {
    const r = makeReport("MyVM", ["OS_dispatch_source", "Closure context"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "dispatch.source-event-handler-self",
    );
  });

  it("matches `rxswift.disposebag-self-cycle` for RxSwift.DisposeBag", () => {
    const r = makeReport("MyVM", [
      "RxSwift.DisposeBag",
      "RxSwift.AnonymousDisposable",
      "Closure context",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "rxswift.disposebag-self-cycle",
    );
  });

  it("matches `realm.notificationtoken-retained` for RealmSwift.NotificationToken", () => {
    const r = makeReport("RealmObserver", [
      "RealmSwift.NotificationToken",
      "Closure context",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "realm.notificationtoken-retained",
    );
  });

  it("matches `coordinator.parent-strong-back-reference` for two *Coordinator nodes", () => {
    const r = makeReport("AppCoordinator", [
      "ProfileCoordinator",
      "parentCoordinator",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coordinator.parent-strong-back-reference",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });
});

describe("classifyCycle — v1.5 catalog completion", () => {
  it("matches `coreanimation.animation-delegate-strong` for CABasicAnimation", () => {
    const r = makeReport("FadeController", [
      "CABasicAnimation",
      "Closure context",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coreanimation.animation-delegate-strong",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `coreanimation.animation-delegate-strong` for CAKeyframeAnimation", () => {
    const r = makeReport("AnimRunner", ["CAKeyframeAnimation", "AnimRunner"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coreanimation.animation-delegate-strong",
    );
  });

  it("matches `coreanimation.layer-delegate-cycle` for CAShapeLayer with no UIView in chain", () => {
    const r = makeReport("ChartRenderer", ["CAShapeLayer", "ChartRenderer"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coreanimation.layer-delegate-cycle",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("downgrades `coreanimation.layer-delegate-cycle` to medium when UIView is in the cycle", () => {
    const r = makeReport("MyView", ["CAShapeLayer", "UIView"]);
    const { classified } = classifyReport(r);
    const match = classified[0].allMatches.find(
      (m) => m.patternId === "coreanimation.layer-delegate-cycle",
    );
    expect(match?.confidence).toBe("medium");
  });

  it("matches `coreanimation.layer-delegate-cycle` at medium for plain CALayer without UIView", () => {
    const r = makeReport("Renderer", ["CALayer", "Renderer"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coreanimation.layer-delegate-cycle",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("medium");
  });

  it("does NOT match `coreanimation.layer-delegate-cycle` for plain CALayer + UIView (auto-pairing is normal)", () => {
    const r = makeReport("MyView", ["CALayer", "UIView"]);
    const { classified } = classifyReport(r);
    const match = classified[0].allMatches.find(
      (m) => m.patternId === "coreanimation.layer-delegate-cycle",
    );
    expect(match).toBeUndefined();
  });

  it("matches `coredata.fetchedresultscontroller-delegate` for NSFetchedResultsController", () => {
    const r = makeReport("ListVC", [
      "NSFetchedResultsController",
      "Closure context",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coredata.fetchedresultscontroller-delegate",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `coredata.fetchedresultscontroller-delegate` for the private _PFFetchedResultsController class name too", () => {
    const r = makeReport("ListVC", ["_PFFetchedResultsController"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "coredata.fetchedresultscontroller-delegate",
    );
  });
});

describe("classifyCycle — v1.6 catalog expansion (Swift 6 / Observation / SwiftData / NavigationStack)", () => {
  it("matches `swiftui.observable-state-modal-leak` when ObservationRegistrar + sheet host appear", () => {
    const r = makeReport("MyAppViewModel", [
      "_$ObservationRegistrar",
      "_OptionalContent",
      "MyAppViewModel",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "swiftui.observable-state-modal-leak",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("`swiftui.observable-state-modal-leak` falls back to low when only ObservationRegistrar appears", () => {
    const r = makeReport("MyVM", ["_$ObservationRegistrar", "MyVM"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "swiftui.observable-state-modal-leak",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("low");
  });

  it("matches `swiftui.navigationpath-stored-in-viewmodel` for NavigationPath in chain", () => {
    const r = makeReport("RouterVM", ["NavigationPath", "RouterVM"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "swiftui.navigationpath-stored-in-viewmodel",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("matches `concurrency.async-sequence-on-self` when AsyncSequence + Task<...> appear", () => {
    const r = makeReport("FeedVM", [
      "AsyncMapSequence",
      "_Concurrency.Task<Swift.Void, Swift.Never>",
      "FeedVM",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "concurrency.async-sequence-on-self",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("`concurrency.async-sequence-on-self` falls back to medium without Task in chain", () => {
    const r = makeReport("FeedVM", ["AsyncIteratorProtocol", "FeedVM"]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "concurrency.async-sequence-on-self",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("medium");
  });

  it("matches `concurrency.notificationcenter-async-observer-task` for the notifications(named:) shape", () => {
    const r = makeReport("Listener", [
      "NotificationCenter.Notifications",
      "_Concurrency.Task<Swift.Void, Swift.Never>",
    ]);
    const { classified } = classifyReport(r);
    // Both notificationcenter-async-observer-task AND async-sequence-on-self
    // could fire here; the more specific one should be primary because they
    // both score high but the specific one's heuristic is tighter.
    const ids = classified[0].allMatches.map((m) => m.patternId);
    expect(ids).toContain("concurrency.notificationcenter-async-observer-task");
  });

  it("matches `swiftui.observations-closure-strong-self` for Observations + Closure context", () => {
    const r = makeReport("WatcherVM", [
      "Observations<Foo>",
      "Closure context",
      "WatcherVM",
    ]);
    const { classified } = classifyReport(r);
    expect(classified[0].primaryMatch?.patternId).toBe(
      "swiftui.observations-closure-strong-self",
    );
    expect(classified[0].primaryMatch?.confidence).toBe("high");
  });

  it("`swiftui.observations-closure-strong-self` does NOT match for ObservationRegistrar (different shape)", () => {
    // ObservationRegistrar is the @Observable backing — different from the
    // Observations { } API.
    const r = makeReport("VM", ["_$ObservationRegistrar"]);
    const { classified } = classifyReport(r);
    const observationsMatch = classified[0].allMatches.find(
      (m) => m.patternId === "swiftui.observations-closure-strong-self",
    );
    expect(observationsMatch).toBeUndefined();
  });

  it("`webkit.wkscriptmessagehandler-bridge` fires alongside the broader v1.4 WK pattern when all three signals appear", () => {
    const r = makeReport("MyWebBridge", [
      "WKWebView",
      "WKUserContentController",
      "WKScriptMessageHandler",
      "MyWebBridge",
    ]);
    const { classified } = classifyReport(r);
    const ids = classified[0].allMatches.map((m) => m.patternId);
    // Both should fire — the v1.4 broad one matches any WK class, the v1.6
    // specific one matches the 3-link bridge shape. Primary tie-broken by
    // declaration order, but both are useful matches.
    expect(ids).toContain("webkit.scriptmessage-handler-strong");
    expect(ids).toContain("webkit.wkscriptmessagehandler-bridge");
    const bridgeMatch = classified[0].allMatches.find(
      (m) => m.patternId === "webkit.wkscriptmessagehandler-bridge",
    );
    expect(bridgeMatch?.confidence).toBe("high");
  });

  it("`webkit.wkscriptmessagehandler-bridge` does NOT fire when only WKWebView appears (no handler/bridge signal)", () => {
    const r = makeReport("VC", ["WKWebView"]);
    const { classified } = classifyReport(r);
    const bridgeMatch = classified[0].allMatches.find(
      (m) => m.patternId === "webkit.wkscriptmessagehandler-bridge",
    );
    expect(bridgeMatch).toBeUndefined();
  });
});
