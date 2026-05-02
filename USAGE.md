# Usage guide

Walkthrough of how `memorydetective` actually works in practice — what each tool returns, how fixes flow from diagnosis to your codebase, and the architecture decision behind splitting "diagnose" from "edit".

For a quick API reference, see the [`README.md`](./README.md). For the full changelog, see [`CHANGELOG.md`](./CHANGELOG.md).

---

## 1. Three ways to use it

### 1a. CLI mode — quickest way to see it work

```bash
npm install -g memorydetective
memorydetective --version    # 1.0.0

# Run analyze on any .memgraph file
memorydetective analyze ~/Desktop/myapp.memgraph
```

What you see (terminal output, ANSI-coloured):

```
┌─ memorydetective analyze ──────────────────────────────────────┐
│ Path: /Users/.../myapp.memgraph
│ Process: MyApp (pid 12345)
│ Bundle: com.example.myapp
└────────────────────────────────────────────────────────────────┘

  60,436 leaks (7.89 MB)
  4 ROOT CYCLE blocks

  Top cycle: Swift._DictionaryStorage<SwiftUI.AnyHashable2, SwiftUI…
    chain length: 545 nodes
    app-level classes in chain: Closure context, DetailViewModel,
        ItemRepositoryImpl, ItemGraphQLDataSource, GraphQLClient

  Diagnosis:
    60436 leaks; 4 ROOT CYCLE blocks. Largest top-level cycle:
    Swift._DictionaryStorage… (chain of 545 nodes). App-level
    classes in chains: Closure context, DetailViewModel, …
```

Then ask the classifier for fix advice:

```bash
memorydetective classify ~/Desktop/myapp.memgraph
```

You see one block per ROOT CYCLE, like:

```
  Root: Swift._DictionaryStorage<SwiftUI.AnyHashable2, SwiftUI…
    Match: swiftui.tag-index-projection (high confidence)
    Fix hint:
      Replace `[weak self]` capture in tap closures with a static
      helper, OR weak-capture the coordinator/view-model directly
      with `[weak coord = self.coordinator]`. The `.tag()` modifier
      on photo carousels is the usual culprit.
    Also matched: swiftui.dictstorage-weakbox-cycle,
                  closure.viewmodel-wrapped-strong,
                  swiftui.foreach-state-tap
```

### 1b. JSON mode — for scripts and CI

```bash
memorydetective analyze ~/Desktop/myapp.memgraph --json | jq .totals
memorydetective classify ~/Desktop/myapp.memgraph --json | jq '.classified[0].primaryMatch'
```

The JSON shape mirrors the MCP tool's response — same fields, no ANSI colours, ready to pipe into anything.

### 1c. MCP mode — the actual product UX

This is what we built it for: an LLM agent (Claude Code, Claude Desktop, Cursor, Cline, Kiro, …) drives the investigation by chat.

Add to your MCP client config (Claude Code shown):

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

Open Claude Code in your iOS project and just ask:

> Diagnose `~/Desktop/myapp.memgraph` and find where to fix in this codebase.

Claude orchestrates the full flow (see [section 3](#3-how-fixes-actually-flow-from-diagnosis-to-edit)).

---

## 2. The 27 cycle patterns and their fix hints

`classifyCycle` ships with a built-in catalog of 27 common iOS retain-cycle patterns. Each pattern returns a `fixHint` — a plain-English string describing the fix direction. Patterns are grouped below by the framework / source they target.

### v1.0 core (8) — SwiftUI + Combine + Concurrency + Notifications

| Pattern ID | When it matches | Fix hint (summary) |
|---|---|---|
| `swiftui.tag-index-projection` | `TagIndexProjection<Int>` appears in chain (`.tag()` modifier capturing self) | Replace `[weak self]` capture with a static helper, or weak-capture the coordinator/view-model directly. |
| `swiftui.dictstorage-weakbox-cycle` | Root is `_DictionaryStorage<…WeakBox<AnyLocationBase>>` | SwiftUI internal observation graph cycle. Find your app-level types in the chain and break the strong capture there. |
| `swiftui.foreach-state-tap` | `SwiftUI.ForEachState` in chain | ForEachState held by a tap-gesture closure capturing `self`. Make the tap handler a static function or capture properties weakly. |
| `closure.viewmodel-wrapped-strong` | `__strong` edge with `_viewModel.wrappedValue` in label | Closure captures `_viewModel.wrappedValue` strongly. Capture the underlying ObservableObject weakly: `[weak vm = _viewModel.wrappedValue]`. |
| `viewcontroller.uinavigationcontroller-host` | `UINavigationController` + `UIHostingController` both in chain | Clear `viewControllers = []` in `dismantleUIViewController` to break the host->VC->host cycle. |
| `combine.sink-store-self-capture` | `AnyCancellable` + `Closure context` | `.sink { self.x = … }` keeps self alive through the AnyCancellable that's stored on self. Capture explicitly: `.sink { [weak self] in self?.x = … }`. |
| `concurrency.task-without-weak-self` | `_Concurrency.Task<…>` + `Closure context` | `Task { }` body strongly captures self for the lifetime of the task. `Task { [weak self] in guard let self else { return }; … }`. |
| `notificationcenter.observer-strong` | `NotificationCenter` / `NSNotificationCenter` + `Closure context` | Block-form `addObserver(forName:...)` keeps the block alive in the center. Use `[weak self]` in the block, or store the returned `NSObjectProtocol` and call `removeObserver(_:)` in `deinit`. |

### v1.4 expansion (16) — UIKit, Combine, Concurrency, SwiftUI, WebKit, RxSwift, Realm

| Pattern ID | When it matches | Fix hint (summary) |
|---|---|---|
| `timer.scheduled-target-strong` | `__NSCFTimer` / `NSTimer` in chain | `Timer.scheduledTimer(target:selector:)` retains its target. Use the closure form with `[weak self]` and `invalidate()` in `deinit`. |
| `displaylink.target-strong` | `CADisplayLink` in chain | `CADisplayLink(target:selector:)` retains its target. Wrap with a `WeakProxy` and `invalidate()` in `deinit`. |
| `gesture.target-strong` | `UIGestureRecognizer` / `UIControl` in chain | `addTarget(_:action:)` is strong by default. Prefer `UIAction` (iOS 14+) or `removeTarget(...)` in `deinit`. |
| `kvo.observation-not-invalidated` | `NSKeyValueObservation` in chain | `obj.observe(\.x) { ... }` retains its handler. `[weak self]` inside, `token.invalidate()` in `deinit`. |
| `urlsession.delegate-strong` | `__NSURLSessionLocal` / `NSURLSession` in chain | `URLSession(configuration:delegate:)` retains its delegate strongly (Apple-documented). Call `invalidateAndCancel()` in `deinit`. |
| `dispatch.source-event-handler-self` | `OS_dispatch_source` / `DispatchSource` in chain | `setEventHandler { ... }` retains the closure. Use `[weak self]` and clear with `setEventHandler {}` in `deinit`. |
| `notificationcenter.observer-not-removed` | `NotificationCenter` + `NSObjectProtocol` | Block-form observer never deregistered. Call `removeObserver(_:)` in `deinit` or use the selector form. |
| `delegate.strong-reference` | Class with `Delegate` suffix in chain | `var delegate: ...?` declared without `weak`. Mark `weak`, or refactor to closure-based callback. |
| `swiftui.envobject-back-reference` | `EnvironmentObjectStorage` + UIKit interop class in chain | `@EnvironmentObject` with strong back-reference to `UIView`/`UIViewController`. Wrap UIKit refs in `weak` box. |
| `combine.assign-to-self` | `Combine.Assign` / `Subscribers.Assign` in chain | `.assign(to: \.x, on: self)` retains self. Use `.assign(to: &$published)` or `.sink { [weak self] ... }`. |
| `concurrency.task-mainactor-view` | `_Concurrency.Task<…>` + SwiftUI View signal | `Task { await self.foo() }` inside `View.body` retains storage. Use `.task { ... }` modifier or capture properties up front. |
| `concurrency.asyncstream-continuation-self` | `AsyncStream` + `Closure context` in chain | Continuation retains `onTermination`/producer closures. `[weak self]` inside, `task.cancel()` in `deinit`/`onDisappear`. |
| `webkit.scriptmessage-handler-strong` | `WKUserContentController` / `WKScriptMessageHandler` / `WKWebView` | `add(_:name:)` retains the handler. Wrap in `WeakScriptMessageHandler` proxy or call `removeScriptMessageHandler(forName:)`. |
| `coordinator.parent-strong-back-reference` | Two `*Coordinator` nodes in cycle | Child holds parent without `weak`. `weak var parentCoordinator`, `removeAll { $0 === finishedChild }` on completion. |
| `rxswift.disposebag-self-cycle` | `RxSwift.DisposeBag` / `RxSwift.AnonymousDisposable` in chain | Subscription retains self if `[weak self]` is omitted or unbound method ref is passed. Always use `[weak self]`. |
| `realm.notificationtoken-retained` | `RealmSwift.NotificationToken` / `RLMNotificationToken` | `Results.observe { ... }` retains the closure. `[weak self]` inside, `token?.invalidate()` in `deinit`. |

### v1.5 catalog completion (3) — Core Animation + Core Data

| Pattern ID | When it matches | Fix hint (summary) |
|---|---|---|
| `coreanimation.animation-delegate-strong` | `CABasicAnimation` / `CAKeyframeAnimation` / `CASpringAnimation` / `CAAnimationGroup` / `CATransition` in chain | `CAAnimation.delegate` is **strong** (Apple-documented quirk). Use a `WeakProxy` delegate or `anim.delegate = nil` in `deinit`. |
| `coreanimation.layer-delegate-cycle` | Custom `CALayer` subclass (`CAShapeLayer` / `CAGradientLayer` / `CAEmitterLayer` / `CAMetalLayer` / etc.) in chain without `UIView` auto-pairing | Custom layer wired to non-UIView delegate leaks. Wrap in `WeakLayerDelegate` or clear `layer.delegate = nil` in `deinit`. |
| `coredata.fetchedresultscontroller-delegate` | `NSFetchedResultsController` / `_PFFetchedResultsController` in chain | Apple's historical strong-delegate quirk via the change-tracker. `frc.delegate = nil` in `viewWillDisappear` / `deinit`. |

**Confidence tiers**: each pattern returns `high`, `medium`, or `low` based on how many specific signals match. If multiple patterns fire on the same cycle, all matches are returned — the highest-confidence one is `primaryMatch`, the rest are in `allMatches`.

**The hints are deliberately textual, not code patches.** That's by design — see the next section.

---

## 3. How fixes actually flow from diagnosis to edit

`memorydetective` covers the diagnose side **and the source-bridging side**. It tells you **what** is wrong, **where in the cycle**, **what type of fix** is needed, **where the relevant types live in your project** (via Swift LSP integration), and **every callsite that references them**. It does not edit your code — that final step still belongs to your LLM agent.

So the workflow has two halves:

| Half | Owned by `memorydetective` | Owned by the LLM agent |
|---|---|---|
| **Diagnose** | ✅ memgraph parsing, cycle classification, fix-hint catalog, hangs / allocations / app-launch / animation hitches | |
| **Locate in source** | ✅ `swiftGetSymbolDefinition`, `swiftFindSymbolReferences`, `swiftSearchPattern`, `swiftGetSymbolsOverview`, `swiftGetHoverInfo` (SourceKit-LSP under the hood) | |
| **Decide the actual edit** | | ✅ The agent reads the surrounding code, picks the right capture-list pattern, writes the diff |
| **Apply the edit** | | ✅ The agent's `Edit`/`MultiEdit` tools write to the user's file |

The split between "locate" (us) and "edit" (the agent) is intentional. Locating is a deterministic SourceKit-LSP query; editing requires understanding the user's surrounding code style, naming conventions, and intent — that's the LLM's strength. We give the agent every piece of structured information it needs to make the edit, and step back at the file-write boundary.

### Concrete end-to-end example

Configuration (one-time): `memorydetective` registered as an MCP server in Claude Code, as shown in [section 1c](#1c-mcp-mode--the-actual-product-ux).

You open Claude Code in your iOS project and ask:

> **You:** Tem um leak. Memgraph em `~/Desktop/example-leaks.memgraph`. The cycle points at `DetailViewModel`. Find where it lives in the project `~/Development/myapp/` and suggest a fix.

What Claude does, step by step:

1. **Calls `analyzeMemgraph(path)`**
   - Receives: 60,436 leaks, 4 ROOT CYCLE blocks, top cycle is a `_DictionaryStorage` chain. App-level classes in chain: `DetailViewModel`, `GraphQLClient`, `ItemRepositoryImpl`.

2. **Calls `classifyCycle(path)`**
   - Receives: `swiftui.tag-index-projection` (high confidence) + fix hint pointing at `.tag()` modifier capturing `self`.

3. **Calls `reachableFromCycle({ rootClassName: "DetailViewModel" })`**
   - Confirms 4 `DetailViewModel` instances and ~1100 `NSURLSessionConfiguration`s reachable from each — the VM is the culprit pinning the network stack as collateral, not the other way around.

4. **Calls `swiftSearchPattern({ pattern: "\\.tag\\(", filePath: "..." })` across views**
   - Surfaces 1 match in `MyApp/Views/MediaCarousel.swift:142`.

5. **Calls `swiftGetSymbolDefinition({ symbolName: "DetailViewModel", projectRoot: "~/Development/myapp/", candidatePaths: ["MyApp/ViewModels/"] })`**
   - Returns `MyApp/ViewModels/DetailViewModel.swift:18` — `class DetailViewModel: ObservableObject`.

6. **Calls `swiftFindSymbolReferences({ symbolName: "DetailViewModel", filePath: "..." })`**
   - Lists 7 callsites across the codebase. Helps the agent gauge fix blast radius.

7. **Presents the proposed fix in chat:**

   > **Claude:** Found the cycle. `MediaCarousel.swift:142` passes `onImageSliderTap` as a closure that captures `self`. The `.tag(index)` modifier on the carousel `ForEach` triggers the SwiftUI internal `TagIndexProjection` observation that pins `DetailViewModel`.
   >
   > Suggested fix:
   > ```swift
   > // before
   > onImageSliderTap: { index in
   >     self.viewModel.handlePhotoTap(at: index)
   > }
   >
   > // after — static helper + weak captures
   > onImageSliderTap: { [weak vm = _viewModel.wrappedValue,
   >                      weak coord = self.coordinator] index in
   >     Self.handlePhotoTap(index: index, viewModel: vm, coordinator: coord)
   > }
   >
   > private static func handlePhotoTap(
   >     index: Int,
   >     viewModel: DetailViewModel?,
   >     coordinator: DetailsCoordinator?
   > ) { /* ... */ }
   > ```
   >
   > Want me to apply this?

8. **You accept** → Claude calls its own `Edit` tool → diff appears in your IDE → you review and commit.

9. **(Optional) Verify the fix:** export a fresh `.memgraph` after running the same flow, then ask Claude:

   > **You:** Did the fix work? Compare `~/Desktop/before.memgraph` to `~/Desktop/after.memgraph`.

   Claude calls `diffMemgraphs` — instance counts dropped, the `swiftui.tag-index-projection` cycle is gone from `cycles.persisted`, present in `cycles.goneFromBefore`.

### Why this is better than "memorydetective generates the diff"

If `memorydetective` tried to generate a code patch, it would have to:
- Parse Swift source
- Understand the file's import graph
- Track the actual variable names and types in scope
- Match surrounding code style

That's exactly what an LLM agent already does — and does well. Splitting the responsibility keeps each side simple. `memorydetective` knows **iOS perf**; the agent knows **your codebase**. They compose.

---

## 4. Common follow-up requests

Once you have the diagnosis, here are useful follow-up prompts you can paste into Claude:

| Prompt | What Claude calls |
|---|---|
| "I want to investigate a memgraph leak — what's the canonical sequence?" | `getInvestigationPlaybook({ kind: "memgraph-leak" })` — returns the 6-step pipeline with `argsTemplate` for each tool. |
| "How many `DetailViewModel` instances are leaking?" | `countAlive(path, className: "DetailViewModel")` |
| "How many `NSURLSessionConfiguration`s are *inside* the cycle rooted at `DetailViewModel`?" | `reachableFromCycle(path, rootClassName: "DetailViewModel", className: "NSURLSessionConfiguration")` |
| "Show the retain chain that keeps `DetailViewModel` alive." | `findRetainers(path, className: "DetailViewModel")` |
| "Compare `~/Desktop/before.memgraph` to `~/Desktop/after.memgraph` — did the leak go away?" | `diffMemgraphs(before, after)` |
| "Did my fix actually resolve the `swiftui.tag-index-projection` cycle?" | `verifyFix(before, after, expectedPatternId: "swiftui.tag-index-projection")` — returns PASS/PARTIAL/FAIL |
| "Render the cycle as a Mermaid graph for the PR description." | `renderCycleGraph(path, format: "mermaid")` |
| "Profile this app on my iPhone for 90 seconds and tell me about hangs." | `listTraceDevices` → `recordTimeProfile` → `analyzeHangs` |
| "Pull the last 5 minutes of `error`-level logs from `MyApp`." | `logShow(last: "5m", process: "MyApp", level: "default")` |
| "Run my XCUITest with leak detection." | `detectLeaksInXCUITest(workspace, scheme, testIdentifier, …)` |
| **Source bridging — combine with the memory tools above:** | |
| "Where is `DetailViewModel` declared in this project?" | `swiftGetSymbolDefinition(symbolName, candidatePaths)` |
| "Find every reference to `DetailViewModel` across the codebase." | `swiftFindSymbolReferences(symbolName, filePath)` |
| "What types live in `MediaCarousel.swift`?" | `swiftGetSymbolsOverview(filePath)` |
| "What's the type at this position in this file?" | `swiftGetHoverInfo(filePath, line, character)` |
| "Search for `[weak self]` captures in this file." | `swiftSearchPattern(filePath, pattern: "\\[weak self\\]")` |

The agent decides which tool to call based on your prompt — you don't need to remember the tool names.

---

## 5. Troubleshooting

### `memorydetective: command not found`

The npm global install isn't on your `$PATH`. Check:

```bash
which memorydetective
npm prefix -g
```

If `npm prefix -g` returns something not in your `$PATH`, add it. Or use the binary directly:

```bash
$(npm prefix -g)/bin/memorydetective --version
```

### `analyzeTimeProfile` returns a SIGSEGV notice

Known limit. `xcrun xctrace export` of the `time-profile` schema crashes on heavy unsymbolicated traces. Workarounds (in order of effort):

1. Open the trace once in Instruments.app (forces symbolication), then close it. Re-run `analyzeTimeProfile`.
2. Re-record with a shorter `--time-limit` (try 30 s instead of 90 s).
3. For hang analysis specifically, use `analyzeHangs` instead — it parses a different (lighter) schema that doesn't crash.

### `captureMemgraph` fails on a physical iOS device

By design. `leaks(1)` only attaches to processes on the local Mac (which includes iOS simulators). Memory Graph capture from a physical device goes through Xcode's debugger over USB — different mechanism, no public CLI equivalent. Use Xcode's Memory Graph button + File → Export Memory Graph for physical devices.

### Tests pass locally but fail in CI

The stress test has a wallclock budget that's tighter on slower runners. If you see `expected NNNms to be less than 2000`, bump `PARSE_BUDGET_MS` in `src/stress.test.ts`.

### `detectLeaksInXCUITest` says "after-capture failed"

The app process exited before `leaks --outputGraph` could attach. Configure your XCUITest to keep the app alive at end-of-test (e.g. `XCTAssertTrue(true); _ = XCTWaiter.wait(for: [...], timeout: 1.0)`), or use a longer simulator boot. This tool is **experimental** in v1.0 — feedback welcome.

---

## 6. Pipeline awareness (suggestedNextCalls + playbooks)

Discovery is data, not inference. As of v1.3, the tools that matter most return a `suggestedNextCalls` field with pre-populated arguments and a one-sentence rationale per entry. The orchestrating agent can chain calls without re-reasoning over the result.

### `suggestedNextCalls` — example from `classifyCycle`

```jsonc
{
  "ok": true,
  "totalCycles": 4,
  "classified": [ /* ... */ ],
  "suggestedNextCalls": [
    {
      "tool": "swiftSearchPattern",
      "args": {
        "pattern": "\\.tag\\(",
        "filePath": "<set to a candidate Swift file in your project>"
      },
      "why": "Locate the code construct implicated by swiftui.tag-index-projection. The regex matches the SwiftUI signal that produces this cycle."
    },
    {
      "tool": "swiftGetSymbolDefinition",
      "args": {
        "symbolName": "DetailViewModel",
        "candidatePaths": ["<set to a Sources/ or app target directory>"]
      },
      "why": "Jump to the declaration of DetailViewModel, the user-defined type captured in this cycle."
    }
  ]
}
```

The agent reads `suggestedNextCalls`, fills in the `<...>` placeholders from project context, and chains. No re-reasoning required.

### `getInvestigationPlaybook` — start here for a fresh investigation

For agents that haven't seen the project before, ask for the canonical pipeline first:

```jsonc
{
  "tool": "getInvestigationPlaybook",
  "args": { "kind": "memgraph-leak" }
}
```

Returns a 6-step sequence with `argsTemplate` per step:

```jsonc
{
  "kind": "memgraph-leak",
  "summary": "Diagnose a SwiftUI / Combine retain cycle from a `.memgraph` snapshot, locate the offending code, and propose a fix.",
  "steps": [
    { "step": 1, "tool": "analyzeMemgraph", "purpose": "..." },
    { "step": 2, "tool": "classifyCycle", "purpose": "..." },
    { "step": 3, "tool": "reachableFromCycle", "purpose": "..." },
    { "step": 4, "tool": "swiftSearchPattern", "purpose": "..." },
    { "step": 5, "tool": "swiftGetSymbolDefinition", "purpose": "..." },
    { "step": 6, "tool": "swiftFindSymbolReferences", "purpose": "..." }
  ]
}
```

Five playbooks ship in v1.3:

| Kind | Use when |
|---|---|
| `memgraph-leak` | You have a `.memgraph` and want to find + fix a retain cycle |
| `perf-hangs` | App feels slow; suspect main-thread blocking |
| `ui-jank` | Animations drop frames |
| `app-launch-slow` | Cold-start time is over budget |
| `verify-fix` | Confirm a fix actually resolved the cycle |

### Tool description tags

Every tool description starts with a category tag so related tools are visible as a group:

| Tag | What |
|---|---|
| `[mg.memory]` | memgraph parsing, cycle classification, retainer chains |
| `[mg.trace]` | xctrace schemas (hangs, allocations, app-launch, animation hitches, time-profile) |
| `[mg.code]` | Swift source bridging via SourceKit-LSP |
| `[mg.log]` | macOS unified logging (`log show` / `log stream`) |
| `[mg.discover]` | xctrace device + template listing |
| `[mg.render]` | Cycle visualization (Mermaid + Graphviz) |
| `[mg.ci]` | XCUITest leak detection |
| `[meta]` | Pipeline-discovery tools like `getInvestigationPlaybook` |

The tag is leading text in the MCP description, so it shows up in any tools/list output and inside Claude Code's "deferred tools" list.

## 7. Where to go from here

- **Add a new cycle pattern**: see the *Adding a cycle pattern to `classifyCycle`* section in [`README.md`](./README.md#contributing).
- **Run a custom analysis from scratch**: every tool's input schema is documented via the MCP `tools/list` request. Hit the server with `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` over stdio.
- **Open an issue**: https://github.com/carloshpdoc/memorydetective/issues — bug reports, feature requests, and pattern contributions are all welcome.
