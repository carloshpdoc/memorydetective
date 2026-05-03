/**
 * Static-analysis bridge: maps each cycle pattern in the catalog to the
 * SwiftLint rule (or other static analyzer) that *would* have caught it
 * at parse time, OR explicitly notes when no static rule exists yet.
 *
 * Reinforces the differentiator: memorydetective sees the *runtime evidence*
 * (the actual cycle in a memgraph) where compilers and linters miss it
 * because the cycle's existence requires runtime conditions (closure
 * actually outlives owner, AsyncSequence actually never terminates, etc.).
 *
 * Sources:
 * - SwiftLint rules: https://realm.github.io/SwiftLint/rule-directory.html
 * - SwiftLint open-but-unshipped @escaping rule (8 years old):
 *   https://github.com/realm/SwiftLint/issues/776
 * - Swift compiler nested-closure [weak self] warning (partial fix):
 *   https://github.com/swiftlang/swift/issues/72391 — PR #77063
 */

export interface StaticAnalysisHint {
  /** SwiftLint rule identifier, or null when no rule exists. */
  rule: string | null;
  /** URL to the rule docs OR the open issue tracking the gap. */
  url: string | null;
  /** Plain-English explanation of the relationship. */
  explanation: string;
}

/**
 * Pattern-id → static-analysis hint. Every pattern in `classifyCycle.PATTERNS`
 * gets an entry — either a real rule or an explicit `null` rule with reasoning.
 */
const HINTS: Record<string, StaticAnalysisHint> = {
  // ─────────────────────────────────────────────────────────────────────────
  // v1.0 core
  // ─────────────────────────────────────────────────────────────────────────

  "swiftui.tag-index-projection": {
    rule: null,
    url: null,
    explanation:
      "No static rule exists. The cycle is in SwiftUI's internal observation graph (TagIndexProjection), not in the user's closure. Static analyzers don't model SwiftUI internals.",
  },
  "swiftui.dictstorage-weakbox-cycle": {
    rule: null,
    url: null,
    explanation:
      "No static rule exists. SwiftUI's `_DictionaryStorage<...WeakBox<AnyLocationBase>>` is a private observation type; user code never references it directly.",
  },
  "swiftui.foreach-state-tap": {
    rule: null,
    url: null,
    explanation:
      "No static rule exists. The leak appears when a tap-gesture closure captures self and ForEachState outlives the closure — neither side is detectable in isolation.",
  },
  "closure.viewmodel-wrapped-strong": {
    rule: null,
    url: "https://github.com/realm/SwiftLint/issues/776",
    explanation:
      "SwiftLint has an open-but-unshipped rule for `@escaping` closure capture cycles (issue #776, open since 2017). Until that ships, this can only be caught at runtime via the memgraph.",
  },
  "viewcontroller.uinavigationcontroller-host": {
    rule: null,
    url: null,
    explanation:
      "No static rule exists. The cycle requires `UIViewControllerRepresentable` plus a hosting controller plus a `dismantleUIViewController` that doesn't clear the view-controller stack — too contextual for static analysis.",
  },
  "combine.sink-store-self-capture": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "SwiftLint's `weak_self` rule warns on closure bodies that reference `self` without `[weak self]`. Catches the most obvious cases. Doesn't catch nested closures where only the inner one has `[weak self]` (Swift compiler issue #72391, partially fixed in PR #77063).",
  },
  "concurrency.task-without-weak-self": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "SwiftLint `weak_self` flags `Task { self.foo() }` without `[weak self]`. The runtime evidence is still useful when the warning is suppressed or the closure is nested.",
  },
  "notificationcenter.observer-strong": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "Same as `combine.sink-store-self-capture` — `weak_self` catches the closure form. Doesn't help when the observer is stored as `NSObjectProtocol` and never explicitly removed in `deinit`.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.4 expansion
  // ─────────────────────────────────────────────────────────────────────────

  "timer.scheduled-target-strong": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The leak is in the *target/selector* form of `Timer.scheduledTimer` — selector-based APIs aren't analyzable for retain semantics by SwiftLint.",
  },
  "displaylink.target-strong": {
    rule: null,
    url: null,
    explanation:
      "Same as `timer.scheduled-target-strong` — selector-based target retention is opaque to static analysis.",
  },
  "gesture.target-strong": {
    rule: null,
    url: null,
    explanation:
      "No static rule for `addTarget(_:action:)` retention. The closure-style `UIAction` API (iOS 14+) avoids this; promoting it would prevent the leak by construction.",
  },
  "kvo.observation-not-invalidated": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` partially helps (the change-handler closure should `[weak self]`). Doesn't catch the `token.invalidate()` omission — that requires lifecycle analysis.",
  },
  "urlsession.delegate-strong": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `URLSession.init(configuration:delegate:delegateQueue:)`'s strong-delegate semantics is documented Apple behavior, not a closure-capture issue.",
  },
  "dispatch.source-event-handler-self": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` catches `setEventHandler { self.foo() }`. Doesn't catch the missing `setEventHandler {}` clear-out in `deinit`.",
  },
  "notificationcenter.observer-not-removed": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The leak is the *omission* of `removeObserver(_:)` in `deinit` — static analyzers don't reason about lifecycle balance.",
  },
  "delegate.strong-reference": {
    rule: "weak_delegate",
    url: "https://realm.github.io/SwiftLint/weak_delegate.html",
    explanation:
      "SwiftLint's `weak_delegate` rule warns on `var delegate: SomeProtocol?` without `weak`. Catches the canonical case directly.",
  },
  "swiftui.envobject-back-reference": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `@EnvironmentObject` strong back-references to UIKit interop classes require dependency-graph analysis SwiftLint doesn't perform.",
  },
  "combine.assign-to-self": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `.assign(to: \\.x, on: self)` is syntactically valid; the retention is in the Combine internals.",
  },
  "concurrency.task-mainactor-view": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` catches the closure body. Doesn't catch the SwiftUI-view-storage lifetime issue — `.task { ... }` modifier vs `Task { ... }` block can't be told apart by syntax alone.",
  },
  "concurrency.asyncstream-continuation-self": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `AsyncStream` continuation retention is a runtime property — the consuming Task either terminates or it doesn't.",
  },
  "webkit.scriptmessage-handler-strong": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `WKUserContentController.add(_:name:)` has documented strong-retain semantics; the cycle requires the handler to also own the WebView.",
  },
  "coordinator.parent-strong-back-reference": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The Coordinator pattern's `parentCoordinator` property usually isn't named `delegate`, so `weak_delegate` doesn't fire. A custom rule could match `parent*Coordinator` properties — would be a useful SwiftLint contribution.",
  },
  "rxswift.disposebag-self-cycle": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` partially helps for explicit closures. Doesn't catch the unbound-method-reference form: `subscribe(onNext: self.handle)` — Swift auto-captures the instance strongly with no syntax cue.",
  },
  "realm.notificationtoken-retained": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` catches the observe closure. Doesn't catch the `token?.invalidate()` omission in `deinit`.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.5 catalog completion
  // ─────────────────────────────────────────────────────────────────────────

  "coreanimation.animation-delegate-strong": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `CAAnimation.delegate`'s strong-retain is Apple-documented behavior, not detectable from source. A targeted SwiftLint custom rule could flag `anim.delegate = self` patterns near `layer.add(anim, ...)` — has not been written.",
  },
  "coreanimation.layer-delegate-cycle": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The leak depends on whether the layer's delegate is a UIView (auto-paired, safe) or another type (leaks). Runtime-only.",
  },
  "coredata.fetchedresultscontroller-delegate": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `NSFetchedResultsController.delegate` is declared `weak` in modern bridging headers, so `weak_delegate` doesn't fire — but the change-tracker still retains via the ObjC contract. Runtime-only.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.6 catalog expansion
  // ─────────────────────────────────────────────────────────────────────────

  "swiftui.observable-state-modal-leak": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The leak depends on `@Observable` + modal presentation lifecycle interaction — too contextual for SwiftLint.",
  },
  "swiftui.navigationpath-stored-in-viewmodel": {
    rule: null,
    url: null,
    explanation:
      "No static rule. `NavigationPath` is a value type held on a class — perfectly normal syntactically. The leak is in the lifecycle of pushed elements, observable only at runtime.",
  },
  "concurrency.async-sequence-on-self": {
    rule: null,
    url: "https://forums.swift.org/t/memory-leak-issue-while-asynchronously-iterating-over-async-sequence/64584",
    explanation:
      "No static rule, and `[weak self]` does NOT help here — the iteration itself holds self. Documented on Swift Forums (#64584). A future swift-format/SwiftLint rule could warn on `for await ... in <storedSeq> { /* uses self */ }` patterns.",
  },
  "concurrency.notificationcenter-async-observer-task": {
    rule: null,
    url: "https://forums.swift.org/t/asyncsequence-version-of-notifications-is-causing-memory-leaks/77257",
    explanation:
      "Same as `concurrency.async-sequence-on-self` — `[weak self]` is insufficient because the iteration holds the actor isolation context. Specifically called out on Swift Forums (#77257).",
  },
  "swiftui.observations-closure-strong-self": {
    rule: "weak_self",
    url: "https://realm.github.io/SwiftLint/weak_self.html",
    explanation:
      "`weak_self` catches the closure body — same shape as `Combine.sink`. The `Observations { }` API is brand-new (Swift 6.2 / Xcode 26), so most projects haven't enabled the rule for it yet.",
  },
  "webkit.wkscriptmessagehandler-bridge": {
    rule: null,
    url: null,
    explanation:
      "No static rule. The 3-link cycle requires a class to both own a `WKWebView` AND conform to `WKScriptMessageHandler` — detectable at runtime via the memgraph but not via SwiftLint conformance analysis.",
  },
};

/** Returns the static-analysis hint for a given pattern, or null if unknown. */
export function getStaticAnalysisHint(
  patternId: string,
): StaticAnalysisHint | null {
  return HINTS[patternId] ?? null;
}

/** All known pattern ids that have hints. Used in tests for coverage assertion. */
export function knownHintPatternIds(): string[] {
  return Object.keys(HINTS);
}
