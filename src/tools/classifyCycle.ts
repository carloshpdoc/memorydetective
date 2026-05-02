import { z } from "zod";
import { runLeaksAndParse } from "../runtime/leaks.js";
import { rootCyclesOnly, walkCycles } from "../parsers/leaksOutput.js";
import {
  pickPrimaryAppClass,
  suggestionsForClassification,
} from "../runtime/suggestions.js";
import type { CycleNode, LeaksReport, NextCallSuggestion } from "../types.js";

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
  /**
   * Suggested next tool calls based on the highest-confidence pattern hit.
   * Each entry has pre-populated args and a one-sentence rationale —
   * the orchestrator can chain them without re-reasoning over the result.
   */
  suggestedNextCalls?: NextCallSuggestion[];
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

  // ────────────────────────────────────────────────────────────────────────
  // v1.4 catalog expansion — 12 new patterns sourced from Apple docs,
  // FBRetainCycleDetector heuristics, SwiftLint rules, and well-known
  // community references (Sundell, hackingwithswift, objc.io).
  // ────────────────────────────────────────────────────────────────────────

  {
    id: "combine.assign-to-self",
    name: "Combine `.assign(to: \\.x, on: self)` capturing self",
    fixHint:
      "`.assign(to: \\.x, on: self)` strongly retains `self` for the lifetime of the subscription. Switch to the property-path form `.assign(to: &$publishedProperty)` (auto-cancels with the @Published property), or rewrite as `.sink { [weak self] value in self?.x = value }`.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasAssign = classes.some(
        (c) => c.includes("Combine.Assign") || c.includes("Subscribers.Assign"),
      );
      return hasAssign ? "high" : null;
    },
  },
  {
    id: "concurrency.task-mainactor-view",
    name: "Swift `Task { }` inside a SwiftUI View capturing self",
    fixHint:
      "Inside `View.body`, `Task { await self.foo() }` retains the view's storage for the task's lifetime — including `@StateObject` and `@ObservedObject` references. Use `.task { ... }` modifier (auto-cancelled when the view leaves), or capture properties up front: `let vm = self.viewModel; Task { await vm.foo() }`.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasTask = classes.some(
        (c) =>
          c.includes("_Concurrency.Task") || /\bTask<[^>]+>/.test(c),
      );
      const hasView = classes.some(
        (c) =>
          c.includes("SwiftUI.View") ||
          c.includes("ViewBody") ||
          c.includes("StateObject"),
      );
      return hasTask && hasView ? "high" : hasTask ? "low" : null;
    },
  },
  {
    id: "notificationcenter.observer-not-removed",
    name: "NotificationCenter observer never deregistered",
    fixHint:
      "When you store the `NSObjectProtocol` returned from `addObserver(forName:object:queue:using:)` on `self` but never call `NotificationCenter.default.removeObserver(_:)` in `deinit`, the center keeps the observer block alive forever. Either remove the observer in `deinit`, or use the selector-based form `addObserver(_:selector:name:object:)` which auto-deregisters on deallocation on modern OS releases.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasNotif = classes.some(
        (c) =>
          c.includes("NSNotificationCenter") ||
          c.includes("NotificationCenter"),
      );
      const hasObserverProto = classes.some(
        (c) =>
          c.includes("NSObjectProtocol") || c.includes("__NSObserver"),
      );
      return hasNotif && hasObserverProto ? "medium" : null;
    },
  },
  {
    id: "delegate.strong-reference",
    name: "`delegate` property declared without `weak`",
    fixHint:
      "Cocoa convention is that delegates are declared `weak var delegate: SomeProtocol?`. A strong delegate reference creates a cycle when the delegated object also holds the delegate's owner (e.g. a UIViewController that owns a TableView and is also its delegate). Mark the delegate property `weak`. If the delegate is a struct or value type that can't be `weak`, refactor to a closure-based callback.",
    match: (_root, allClasses) => {
      // Heuristic: any cycle node has an edge labelled `_delegate` or
      // `delegate` with __strong, AND the cycle is a 2-node back-loop.
      // We approximate "delegate" by class name suffix patterns.
      const classes = Array.from(allClasses);
      const hasDelegateName = classes.some(
        (c) => /Delegate$/.test(c) || c.includes("Delegate"),
      );
      return hasDelegateName ? "low" : null;
    },
  },
  {
    id: "timer.scheduled-target-strong",
    name: "Timer.scheduledTimer(target:selector:) retains its target",
    fixHint:
      "`Timer.scheduledTimer(timeInterval:target:selector:userInfo:repeats:)` retains its target until `invalidate()` is called, even after `repeats: false` fires. Switch to the block form `Timer.scheduledTimer(withTimeInterval:repeats:) { [weak self] _ in ... }` and store a reference so you can call `timer.invalidate()` in `deinit`. For long-lived timers on `self`, wrap in a `WeakProxy` target.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasTimer = classes.some(
        (c) =>
          c.includes("__NSCFTimer") ||
          c.includes("NSTimer") ||
          c === "Timer" ||
          /\bTimer\b/.test(c),
      );
      return hasTimer ? "high" : null;
    },
  },
  {
    id: "displaylink.target-strong",
    name: "CADisplayLink retains its target",
    fixHint:
      "`CADisplayLink(target:selector:)` retains its target — same pitfall as `Timer`. Use a `WeakProxy` target wrapper (`class WeakProxy: NSObject { weak var target: NSObject? }`) and forward the selector to `target` weakly. Always call `displayLink.invalidate()` in `deinit` of the owning object.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      return classes.some((c) => c.includes("CADisplayLink")) ? "high" : null;
    },
  },
  {
    id: "gesture.target-strong",
    name: "UIGestureRecognizer / UIControl `addTarget` retains target",
    fixHint:
      "`addTarget(_:action:)` on `UIControl` and `UIGestureRecognizer` adds the target to an internal `_targets` array — strong by default. Either prefer the closure-based `UIAction` API (iOS 14+, UIKit handles weakly), or call `removeTarget(self, action: nil, for: .allEvents)` explicitly in `deinit`. Don't rely on the gesture being deallocated to drop the reference.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasGesture = classes.some(
        (c) =>
          c.includes("UIGestureRecognizer") ||
          c.includes("UITapGesture") ||
          c.includes("UIPanGesture") ||
          c.includes("UIControl"),
      );
      return hasGesture ? "high" : null;
    },
  },
  {
    id: "kvo.observation-not-invalidated",
    name: "`NSKeyValueObservation` token retains its change handler",
    fixHint:
      "`obj.observe(\\.x) { obj, change in ... }` returns a token that strongly retains the change handler — and the handler typically captures `self`. Capture self weakly: `obj.observe(\\.x) { [weak self] _, _ in self?... }`, and call `token.invalidate()` in `deinit`. Storing the token alone won't break the closure capture.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasKvo = classes.some(
        (c) =>
          c.includes("NSKeyValueObservation") ||
          c.includes("_NSKeyValueObservance"),
      );
      return hasKvo ? "high" : null;
    },
  },
  {
    id: "urlsession.delegate-strong",
    name: "URLSession retains its delegate strongly",
    fixHint:
      "`URLSession(configuration:delegate:delegateQueue:)` retains its delegate **strongly** until you call `invalidateAndCancel()` or `finishTasksAndInvalidate()` — this is documented Apple behavior, not a bug. If your owning object stores the session and is also the delegate, you have a cycle. Always invalidate the session in `deinit`.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasSession = classes.some(
        (c) =>
          c.includes("__NSURLSessionLocal") ||
          c.includes("NSURLSession") ||
          c === "URLSession" ||
          /\bURLSession\b/.test(c),
      );
      return hasSession ? "high" : null;
    },
  },
  {
    id: "swiftui.envobject-back-reference",
    name: "SwiftUI `@EnvironmentObject` with back-reference to UIView/UIViewController",
    fixHint:
      "An `ObservableObject` exposed via `@EnvironmentObject` outlives the view tree that consumes it. If the object stores a strong reference back to a `UIView`, `UIViewController`, or a closure that captures one (typical in `UIViewControllerRepresentable` interop), the cycle persists. Wrap UIKit references in a `weak` box, or refactor the dependency direction.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasObservable = classes.some(
        (c) => /ViewModel$|Store$|State$/.test(c) || c.includes("ObservableObject"),
      );
      const hasEnvStorage = classes.some(
        (c) =>
          c.includes("EnvironmentObjectStorage") ||
          c.includes("EnvironmentValues"),
      );
      const hasUIKit = classes.some(
        (c) =>
          c.includes("UIHostingController") ||
          c.includes("UIViewRepresentable") ||
          c.includes("UIViewControllerRepresentable"),
      );
      if (hasObservable && hasEnvStorage && hasUIKit) return "high";
      if (hasEnvStorage && hasUIKit) return "medium";
      return null;
    },
  },
  {
    id: "concurrency.asyncstream-continuation-self",
    name: "`AsyncStream` continuation retains self via producer / onTermination",
    fixHint:
      "`AsyncStream`'s continuation retains its `onTermination` and producer closures. If you `for await ... in stream { /* uses self */ }` and the stream is stored on `self`, the consuming Task pins self until termination is delivered — which never happens. Capture `[weak self]` inside the loop and call `task.cancel()` in `deinit`/`onDisappear`. Nil-ing out the stream is not enough.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasStream = classes.some(
        (c) =>
          c.includes("AsyncStream") ||
          c.includes("_AsyncStreamCriticalRegion"),
      );
      return hasStream ? "high" : null;
    },
  },
  {
    id: "webkit.scriptmessage-handler-strong",
    name: "`WKUserContentController.add(_:name:)` retains the handler",
    fixHint:
      "`WKUserContentController.add(_:name:)` retains its `WKScriptMessageHandler` strongly. When the handler is the same VC that owns the WKWebView, you get `VC → WKWebView → WKUserContentController → handler (VC)`. Either wrap `self` in a `WeakScriptMessageHandler` proxy, or call `userContentController.removeScriptMessageHandler(forName:)` for every name added before the WKWebView is deallocated.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasWK = classes.some(
        (c) =>
          c.includes("WKUserContentController") ||
          c.includes("WKScriptMessageHandler") ||
          c.includes("WKWebView"),
      );
      return hasWK ? "high" : null;
    },
  },
  {
    id: "dispatch.source-event-handler-self",
    name: "DispatchSource event handler closure retains self",
    fixHint:
      "`DispatchSourceTimer.setEventHandler { ... }` (and `setCancelHandler`) stores the closure strongly. When the source is a stored property and the handler captures `self`, you get a 3-node cycle. In `deinit`, call `source.setEventHandler {}` (clear the closure) then `source.cancel()` and `source.resume()` if it was suspended. Always capture `[weak self]` inside the handler.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasDispatch = classes.some(
        (c) =>
          c.includes("OS_dispatch_source") ||
          c.includes("DispatchSource") ||
          c.includes("DispatchWorkItem"),
      );
      return hasDispatch ? "high" : null;
    },
  },
  {
    id: "rxswift.disposebag-self-cycle",
    name: "RxSwift `DisposeBag` retains subscription closures capturing self",
    fixHint:
      "`DisposeBag` is a stored property on `self`; subscriptions added to it retain `self` if `[weak self]` is omitted, or if you pass an unbound method reference (`subscribe(onNext: self.handle)` — Swift auto-captures the instance strongly). Always use `[weak self]` in the closure form, never pass an unbound method reference.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasRx = classes.some(
        (c) =>
          c.includes("RxSwift.DisposeBag") ||
          c.includes("RxSwift.AnonymousDisposable") ||
          c.includes("RxSwift.SinkDisposer") ||
          c.includes("RxSwift."),
      );
      return hasRx ? "high" : null;
    },
  },
  {
    id: "realm.notificationtoken-retained",
    name: "Realm `NotificationToken` retains its change closure",
    fixHint:
      "`Results.observe { ... }` returns a `NotificationToken` that strongly retains the change closure. Same shape as `NSKeyValueObservation`. Use `[weak self]` inside the observe closure and call `token?.invalidate()` in `deinit`.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasRealmToken = classes.some(
        (c) =>
          c.includes("RealmSwift.NotificationToken") ||
          c.includes("RLMNotificationToken"),
      );
      return hasRealmToken ? "high" : null;
    },
  },
  {
    id: "coordinator.parent-strong-back-reference",
    name: "Coordinator pattern: child holds parent strongly",
    fixHint:
      "The Coordinator pattern's canonical bug: parent holds children via `childCoordinators: [Coordinator]`, child holds `parentCoordinator` without `weak`. Mark `var parentCoordinator: Coordinator?` as `weak var parentCoordinator: Coordinator?`, and ensure `parent.childCoordinators.removeAll { $0 === finishedChild }` runs on completion.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const coordinators = classes.filter((c) => /Coordinator$/.test(c));
      // Two distinct *Coordinator nodes in the cycle = strong indicator
      if (coordinators.length >= 2) return "high";
      if (coordinators.length === 1) return "low";
      return null;
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // v1.5 catalog completion — 3 patterns previously triaged from research
  // (Core Animation animation/layer delegate quirks, Core Data FRC).
  // ────────────────────────────────────────────────────────────────────────

  {
    id: "coreanimation.animation-delegate-strong",
    name: "CAAnimation retains its delegate (Apple's documented quirk)",
    fixHint:
      "Unlike most Cocoa delegates, `CAAnimation.delegate` is **strong** — Apple documents this explicitly. When `self` is the delegate and also stores the animation (`self.layer.add(anim, forKey:)` keeps it alive), you get a cycle through the animation's internal handler. Either set the delegate to a `WeakProxy` wrapper, or assign `anim.delegate = nil` before the animation completes/in `deinit`, or use the closure-style `CAAnimationDelegate.animationDidStop` via a separate value-type proxy.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasAnim = classes.some(
        (c) =>
          c.includes("CABasicAnimation") ||
          c.includes("CAKeyframeAnimation") ||
          c.includes("CASpringAnimation") ||
          c.includes("CAAnimationGroup") ||
          c.includes("CAPropertyAnimation") ||
          c.includes("CATransition") ||
          c === "CAAnimation" ||
          /\bCAAnimation\b/.test(c),
      );
      return hasAnim ? "high" : null;
    },
  },
  {
    id: "coreanimation.layer-delegate-cycle",
    name: "Custom CALayer delegate pointing at non-UIView owner",
    fixHint:
      "`CALayer.delegate` is **unowned(unsafe)** in headers but in practice keeps a strong reference until the layer is removed. UIKit's auto-pairing (UIView owns its layer; the layer's delegate is the view) avoids this — but **custom `CALayer` subclasses** (`CAShapeLayer`, `CAGradientLayer`, `CAEmitterLayer`) wired to a non-UIView delegate (a controller, a renderer object) leak. Either keep delegates on `UIView` boundaries only, or wrap the non-view delegate in a `WeakLayerDelegate` proxy and clear `layer.delegate = nil` in `deinit`.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const customLayer = classes.some(
        (c) =>
          c.includes("CAShapeLayer") ||
          c.includes("CAGradientLayer") ||
          c.includes("CAEmitterLayer") ||
          c.includes("CAReplicatorLayer") ||
          c.includes("CATextLayer") ||
          c.includes("CATiledLayer") ||
          c.includes("CAMetalLayer") ||
          c.includes("CAEAGLLayer"),
      );
      const plainLayer = classes.some(
        (c) => c === "CALayer" || /\bCALayer\b/.test(c),
      );
      const hasUIView = classes.some(
        (c) => c.includes("UIView") || c.includes("UIViewController"),
      );
      // Custom layer subclass + cycle without UIView = strong indicator (no
      // UIKit auto-weak pairing). Plain CALayer + no UIView = medium. Any
      // CALayer alongside UIView is normal pairing — skip.
      if (customLayer && !hasUIView) return "high";
      if (customLayer) return "medium";
      if (plainLayer && !hasUIView) return "medium";
      return null;
    },
  },
  {
    id: "coredata.fetchedresultscontroller-delegate",
    name: "NSFetchedResultsController retains its delegate",
    fixHint:
      "`NSFetchedResultsController.delegate` was historically strong (Apple-documented quirk; modern bridging declares it `weak` but the underlying ObjC contract still allows strong retain via the change-tracking machinery). When a `UIViewController` owns the FRC and is also its delegate, the FRC's internal change-tracker pins the VC. Set `frc.delegate = nil` in `viewWillDisappear` / `deinit`, or store the FRC behind a `WeakFRCDelegate` proxy that clears itself on the VC's deallocation signal.",
    match: (_root, allClasses) => {
      const classes = Array.from(allClasses);
      const hasFrc = classes.some(
        (c) =>
          c.includes("NSFetchedResultsController") ||
          c.includes("_PFFetchedResultsController") ||
          c.includes("PFFetchedResultsController"),
      );
      return hasFrc ? "high" : null;
    },
  },
];

/** Pure: classify each ROOT CYCLE in the parsed report. */
export function classifyReport(
  report: LeaksReport,
  maxResults = 20,
): {
  totalCycles: number;
  classified: CycleClassification[];
  classNamesByIndex: string[][];
} {
  const roots = rootCyclesOnly(report.cycles);
  const classNamesByIndex: string[][] = [];
  const classified: CycleClassification[] = roots
    .slice(0, maxResults)
    .map((root) => {
      const allClasses = new Set<string>();
      for (const { node } of walkCycles([root])) {
        if (node.className) allClasses.add(node.className);
      }
      classNamesByIndex.push(Array.from(allClasses));
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
  return { totalCycles: roots.length, classified, classNamesByIndex };
}

export async function classifyCycle(
  input: ClassifyCycleInput,
): Promise<ClassifyCycleResult> {
  const { report, resolvedPath } = await runLeaksAndParse(input.path);
  const { totalCycles, classified, classNamesByIndex } = classifyReport(
    report,
    input.maxResults ?? 20,
  );

  // Build suggestedNextCalls based on the highest-confidence match across
  // all cycles. Picks the first cycle with a primary match (cycles are
  // emitted in descending leak-count order, so this is the dominant one).
  const suggestedNextCalls: NextCallSuggestion[] = [];
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (!c.primaryMatch) continue;
    const appLevel = pickPrimaryAppClass(classNamesByIndex[i] ?? []);
    suggestedNextCalls.push(
      ...suggestionsForClassification({
        patternId: c.primaryMatch.patternId,
        rootClass: c.rootClass,
        appLevelClass: appLevel,
      }),
    );
    break; // one cycle's worth is enough
  }

  return {
    ok: true,
    path: resolvedPath,
    totalCycles,
    classified,
    ...(suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}
