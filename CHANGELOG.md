# Changelog

All notable changes to `memorydetective` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] — 2026-05-03

Catalog grows from 33 to **34 patterns** (SwiftData `@Actor` cycle), every classification now ships a **`fixTemplate` field** with Swift before/after snippets the agent can adapt directly, and a new **`compareTracesByPattern` tool** does for `.trace` bundles what `verifyFix` does for memgraphs. 27 → 28 MCP tools.

### Added

- **`swiftdata.modelcontext-actor-cycle`** cycle pattern. Fires when a `ModelContext` + `DefaultSerialModelExecutor` (or `ModelExecutor`) + `Actor` appear together in the chain. Apple-documented quirk (FB13844786) — fixed at the framework level in iOS 18 beta 1, but the user-code shape persists on older targets and on hand-rolled executors. Sourced from [Apple Developer Forums #748042](https://developer.apple.com/forums/thread/748042). Confidence-tiered: `high` when all three signals coexist, `medium` for ModelContext + Executor without an Actor in chain, `low` when only ModelContext is visible.
- **`fixTemplate` field** on every `PatternMatch`. Each pattern now carries a Swift code snippet showing the typical before/after. The agent reads the template and adapts type/method names to the user's codebase via the SourceKit-LSP source-bridging tools. Implemented in `src/runtime/fixTemplates.ts` with a 1:1-coverage test guard against `PATTERNS`. Where `staticAnalysisHint` (v1.6) says *which* linter rule would catch a pattern, `fixTemplate` shows *what* the fix looks like in code. Both ride alongside the original textual `fixHint`.
- **`compareTracesByPattern` tool** — trace-side counterpart to `verifyFix`. Takes a before/after pair of `.trace` bundles + a category (`hangs`, `animation-hitches`, or `app-launch`) + optional thresholds, and returns a PASS/PARTIAL/FAIL verdict plus before/after stats and deltas. Threshold semantics: hangs PASS when longest is below `hangsMaxLongestMs` (default 0); hitches PASS when longest is below `hitchesMaxLongestMs` (default 100ms — Apple's user-perceptible threshold); app-launch PASS when total is below `appLaunchMaxTotalMs` (default 1000ms). Designed for CI gating: a hangs-fix PR's before/after traces gate the merge. Tagged `[mg.trace][mg.ci]`.

### Changed

- README: new "What's new in v1.7" callout. Pattern catalog count `33 → 34`. Tool count `27 → 28`. CI / test integration subsection grows from 1 to 2 tools. Resources section now lists 34 entries. The "Adding a cycle pattern" workflow gains a 4th step: add a `fixTemplate` entry alongside the `staticAnalysisHint`.
- USAGE.md section 2 gains a v1.7 sub-table with the new SwiftData+Actor pattern + a paragraph explaining the new `fixTemplate` field with a concrete JSON example. Updated header note describes the per-pattern triple now returned: `fixHint` (prose), `staticAnalysisHint` (linter rule or gap), and `fixTemplate` (code).
- Test count: 183 → 206 (23 new — 4 for the swiftdata pattern + edge cases, 8 for `fixTemplates` coverage and content, 11 for `compareTracesByPattern` verdict logic).

### Notes

- No breaking changes — `fixTemplate` is an optional new field on `PatternMatch`. Old callers that ignore it continue to work.
- Catalog now covers 34 distinct cycle shapes; the `fixTemplate` content is the most user-visible upgrade. Each template is intentionally minimal (just enough to demonstrate the shape of the fix); the agent fills in real type/method names from the surrounding code.
- The `@ModelActor` recommendation in the SwiftData fix template only applies on iOS 17+ where the macro is available. The fallback (custom executor with weak ModelContext) is provided for older targets.

## [1.6.0] — 2026-05-03

Catalog grows from 27 to **33 patterns** (Swift 6 / Observation / SwiftData / NavigationStack era), the server adopts MCP **Resources** + **Prompts** beyond raw Tools, every classification now carries a `staticAnalysisHint` bridging to SwiftLint, and the `--version` drift bug from earlier is fixed.

### Added

- **6 new cycle patterns** in `classifyCycle`, sourced from Apple Developer Forums (#736110, #716804, #748042, #22795), Swift Forums (#64584, #77257), Donny Wals on the Swift 6.2 `Observations` API, and the Embrace WKWebView memory-leak writeup:
  - `swiftui.observable-state-modal-leak` — `@Observable` model held as `@State` across modal presentation
  - `swiftui.navigationpath-stored-in-viewmodel` — `NavigationPath` retains every element ever pushed (FB11643551, unfixed)
  - `concurrency.async-sequence-on-self` — `for await ... in seq` pins self via the consuming Task; `[weak self]` does NOT help
  - `concurrency.notificationcenter-async-observer-task` — special case of the above for `NotificationCenter.notifications(named:)`
  - `swiftui.observations-closure-strong-self` — Swift 6.2 `Observations { }` closure retains self like `Combine.sink`
  - `webkit.wkscriptmessagehandler-bridge` — handler ↔ webview ↔ contentController 3-link bridge cycle
- **MCP Resources surface** — all 33 catalog patterns are now browsable as MCP resources at `memorydetective://patterns/{patternId}`. Each resource is a markdown body. Implemented in `src/runtime/resources.ts`. `resources/list` returns all 33; `resources/read` resolves any pattern URI to its markdown body.
- **MCP Prompts surface** — 5 investigation playbooks exposed as MCP prompts (slash commands in clients that surface them, e.g. Claude Code): `/investigate-leak`, `/investigate-hangs`, `/investigate-jank`, `/investigate-launch`, `/verify-cycle-fix`. Each prompt fills the canonical playbook's argument templates with user-provided values and hands the agent a ready-to-execute brief. Implemented in `src/runtime/prompts.ts`.
- **`staticAnalysisHint` field** on every `PatternMatch` — bridges runtime evidence to static analysis. Per-pattern entries point at the SwiftLint rule that would catch this at parse time (`weak_self`, `weak_delegate`) OR explicitly note the gap (with a link to e.g. SwiftLint #776 for `@escaping` retain cycles, or Swift Forums #64584 for AsyncSequence). The `swiftui.tag-index-projection` original-investigation pattern explicitly notes "no rule exists; this is a SwiftUI-internal observation issue, not a closure-capture issue." Implemented in `src/runtime/staticAnalysisHints.ts` with a 1:1-coverage test guard against `PATTERNS`.

### Fixed

- `memorydetective --version` now reports the actually-installed version. Previously the CLI string was hardcoded (last bumped to `"1.4.0"` in v1.4.0; never bumped for `1.5.0`). The MCP server's `SERVER_VERSION` was even staler — it had been `"0.1.0-dev"` since the v1.0.0 release. Both surfaces now read from `package.json` at runtime via `src/version.ts`, so they can never drift again. (Originally caught while dogfooding the new release script — bundled into 1.6.0 since 1.5.x didn't ship.)

### Changed

- README: new "What's new in v1.6" callout. New "Resources (33)" and "Prompts (5)" subsections in the API section. The opening API line now reads "27 MCP tools + 33 Resources + 5 Prompts" instead of "27 MCP tools". Pattern-count and tool-description cells updated.
- USAGE.md section 2 gains a v1.6 sub-table with the 6 new patterns + a paragraph explaining the new `staticAnalysisHint` field. New section 7 ("MCP Resources + Prompts") documents the catalog-as-resources and slash-command surfaces; the old section 7 is renumbered to 8.
- Release process is now automated: `scripts/release.sh` orchestrates preflight → build/test → tag → npm publish → GitHub Release in one command. `.github/workflows/release.yml` re-validates on every `vX.Y.Z` tag push (build, tests, version match, CLI smoke). See the maintainer-facing checklist for the full process.
- Test count: 152 → 183 (31 new — 14 for resources + prompts, 10 for the 6 new patterns + edge cases, 7 for the static-analysis-hint coverage guard).

### Notes

- No breaking changes — all additions are catalog entries or new optional fields. Old callers that ignore Resources/Prompts continue to work.
- The `webkit.wkscriptmessagehandler-bridge` pattern is intentionally additive: it fires *alongside* the broader v1.4 `webkit.scriptmessage-handler-strong` pattern when all three signals (WKWebView + WKUserContentController + handler/bridge class) coexist. Different fix templates apply to each — the new specific one tells you to wrap in a `WeakScriptMessageHandler` proxy; the old broad one just notes that `WKUserContentController.add(_:name:)` retains strongly.
- Catalog now covers 33 distinct cycle shapes across SwiftUI (incl. Swift 6 / `@Observable` / SwiftData / NavigationStack), Combine, Swift Concurrency (incl. AsyncSequence), UIKit (Timer / CADisplayLink / UIGestureRecognizer / KVO / URLSession / WebKit / DispatchSource), Core Animation, Core Data, the Coordinator pattern, RxSwift, and Realm.

## [1.5.0] — 2026-05-02

Catalog completion + cost transparency. **24 → 27 patterns** (Core Animation animation/layer delegate quirks, Core Data `NSFetchedResultsController`), and the README now documents what `memorydetective` saves you in tokens and developer time, including the cases where the win is marginal.

### Added

- **3 new cycle patterns** in `classifyCycle`, completing the catalog triage from the v1.4 research review:
  - `coreanimation.animation-delegate-strong` — `CAAnimation.delegate` is **strong** (Apple-documented quirk). Catches `CABasicAnimation`, `CAKeyframeAnimation`, `CASpringAnimation`, `CAAnimationGroup`, `CATransition`. Fix hint: use a `WeakProxy` delegate or set `anim.delegate = nil` in `deinit`.
  - `coreanimation.layer-delegate-cycle` — Custom `CALayer` subclass (`CAShapeLayer`, `CAGradientLayer`, `CAEmitterLayer`, `CAMetalLayer`, etc.) wired to a non-UIView delegate. UIKit's auto-weak pairing only protects `UIView`-owned layers. Confidence is `high` when the cycle has no `UIView`, `medium` otherwise; plain `CALayer + UIView` is treated as normal pairing and skipped to avoid false positives.
  - `coredata.fetchedresultscontroller-delegate` — `NSFetchedResultsController` (and the private `_PFFetchedResultsController`) historically retained its delegate via the change-tracking machinery. Fix hint: clear `frc.delegate = nil` in `viewWillDisappear`/`deinit` or store behind a `WeakFRCDelegate` proxy.
- **README "What it saves you" section** — concrete token-cost and developer-time comparison for a real-world retain-cycle investigation, with explicit acknowledgement of when the win is marginal (tiny memgraphs, one-shot lookups, first-time investigations on a new codebase). Anonymized numbers from a real investigation, not synthetic.

### Changed

- `USAGE.md` section 2 now lists all 27 patterns, grouped by release wave (v1.0 core / v1.4 expansion / v1.5 completion). Previously stale at "8 cycle patterns" since v1.4 — fixed in this release.
- README "Adding a cycle pattern" section updated for the current catalog shape and dropped the outdated "v0.2 catalog repo" plan (the catalog stayed in-process via `PATTERNS`, that aspirational split never happened).
- Test count: 144 → 152 (8 new tests covering the 3 v1.5 patterns and the catalog count assertion).

### Notes

- No breaking changes — all additions are catalog entries plus documentation.
- The 27-pattern catalog now covers SwiftUI, Combine, Swift Concurrency, UIKit (Timer / CADisplayLink / UIGestureRecognizer / KVO / URLSession / WebKit / DispatchSource), Core Animation, Core Data, the Coordinator pattern, RxSwift, and Realm — broadly the leak families that account for ~95% of real-world iOS retain cycles per the FBRetainCycleDetector + SwiftLint + Apple-docs research review.

## [1.4.0] — 2026-05-01

Deeper diagnostics. Catalog **triples** in size (8 → 24 patterns), cycles report transitive impact, and a new `verifyFix` tool gates fixes in CI by classifier-aware diff. 26 → 27 tools.

### Added

- **16 new cycle patterns** in `classifyCycle`. Sourced from Apple developer docs, FBRetainCycleDetector heuristics, SwiftLint rules, and well-known community references. Each pattern carries a fix hint and a confidence tier.

  **UIKit / Foundation:**
  - `timer.scheduled-target-strong` — `Timer.scheduledTimer(target:selector:)` retains its target
  - `displaylink.target-strong` — `CADisplayLink` retains its target
  - `gesture.target-strong` — `UIGestureRecognizer` / `UIControl` `addTarget` retains
  - `kvo.observation-not-invalidated` — `NSKeyValueObservation` retains its change handler
  - `urlsession.delegate-strong` — `URLSession` strongly retains its delegate (Apple-documented)
  - `dispatch.source-event-handler-self` — `DispatchSource.setEventHandler` retains the closure
  - `notificationcenter.observer-not-removed` — block-form observer never deregistered
  - `delegate.strong-reference` — `var delegate: Foo?` declared without `weak`

  **SwiftUI / Combine / Concurrency:**
  - `swiftui.envobject-back-reference` — `@EnvironmentObject` with back-reference to UIView/UIViewController
  - `combine.assign-to-self` — `.assign(to: \\.x, on: self)` retains self
  - `concurrency.task-mainactor-view` — `Task { await self.foo() }` inside a SwiftUI View
  - `concurrency.asyncstream-continuation-self` — `AsyncStream` consumer never cancelled

  **WebKit / Architecture / Third-party:**
  - `webkit.scriptmessage-handler-strong` — `WKUserContentController` retains the message handler
  - `coordinator.parent-strong-back-reference` — Coordinator pattern: child holds parent strongly
  - `rxswift.disposebag-self-cycle` — RxSwift DisposeBag + method reference armadilha
  - `realm.notificationtoken-retained` — Realm `NotificationToken` retains the change closure

- **`verifyFix` tool** — cycle-semantic diff. Classifies both before/after `.memgraph` snapshots and emits a per-pattern `PASS` / `PARTIAL` / `FAIL` verdict plus bytes freed and instances released. Use as a CI gate: pass `expectedPatternId` and check `expectedPatternVerdict === "PASS"`.

- **Transitive bytes per cycle.** `analyzeMemgraph`'s `CycleSummary` now includes `transitiveBytes` (sum of `instanceSize` across reachable nodes) and `transitiveInstanceCount`. Useful for prioritization: "breaking this one frees 8.2 MB" vs "this one frees 200 bytes".

### Changed

- `classifyReport` (pure function) now also returns `classNamesByIndex` so callers can build typed suggestions without re-walking the cycle forest. (Internal — already used by v1.3.0's `suggestedNextCalls` plumbing.)
- README + USAGE.md updated to reflect the 24-pattern catalog and new `verifyFix` tool.
- Tool count badge: 26 → 27.

### Notes

- No breaking changes — new fields are additive, all new patterns are classifier additions.
- The catalog is now broad enough to cover the Foundation/UIKit/Combine/Concurrency/SwiftUI/WebKit/RxSwift/Realm leak families that account for ~95% of real-world iOS retain cycles per the research review (FBRetainCycleDetector + SwiftLint + Apple docs).

## [1.3.1] — 2026-05-01

### Added

- USAGE.md: new section 6 "Pipeline awareness" documenting `suggestedNextCalls` (with a full JSON example), `getInvestigationPlaybook` (with the five playbook kinds), and the tool-description tag taxonomy. Establishes the workflow norm: every release ships with USAGE updates.
- USAGE.md section 4: row for `getInvestigationPlaybook` added at the top of the follow-up requests table.
- README API section: opening paragraph documents the namespace tags + `suggestedNextCalls` mechanism.

### Changed

- No code changes from `1.3.0` — this is a documentation catch-up release.

## [1.3.0] — 2026-05-01

Pipeline-aware release. Addresses real-user feedback that the Swift tools were "an attachment" rather than part of the investigation chain. **Discovery is now data, not inference.** 25 → 26 tools.

### Added

- **`suggestedNextCalls` field** on `analyzeMemgraph`, `classifyCycle`, `findRetainers`, and `reachableFromCycle` results. Each entry is a typed `{ tool, args, why }` triple with pre-populated arguments based on the current result. The orchestrating LLM can chain calls without re-reasoning over the response.
  - `analyzeMemgraph` → suggests `classifyCycle` + `reachableFromCycle`.
  - `classifyCycle` → suggests `swiftSearchPattern` (with a regex pre-translated from the matched pattern) + `swiftGetSymbolDefinition` (with the cycle's app-level class name extracted).
  - `findRetainers` → suggests `swiftGetSymbolDefinition` for the class.
  - `reachableFromCycle` → suggests `swiftGetSymbolDefinition` + `swiftFindSymbolReferences` for the dominant app-level class.
- **`getInvestigationPlaybook` meta-tool** — returns a versioned, declarative pipeline for a known investigation kind. Five playbooks shipped: `memgraph-leak`, `perf-hangs`, `ui-jank`, `app-launch-slow`, `verify-fix`. Use this once at the start of an investigation to give a fresh agent the canonical sequence without rediscovering it.
- **Tool-name namespaces in descriptions**: every tool description now opens with a category tag (`[mg.memory]`, `[mg.trace]`, `[mg.code]`, `[mg.log]`, `[mg.discover]`, `[mg.render]`, `[mg.ci]`, `[meta]`). Makes related tools visible as a group at a glance, especially when the agent is browsing the deferred-tools list.
- **Pipeline lines in key tool descriptions** (`analyzeMemgraph` and `classifyCycle`): each description ends with a "Pipeline: → X (purpose) → Y (purpose)" sentence. Even when the agent only reads the description (not the result), the chain is visible.
- New `src/runtime/suggestions.ts` helper module so multiple tools agree on the same heuristics for "which class is most actionable" and "which followup is most useful".

### Changed

- No breaking changes. All `suggestedNextCalls` fields are optional; old callers that ignore them continue to work.
- `classifyReport` (pure function) now also returns `classNamesByIndex` so the caller can build typed suggestions without re-walking the cycle forest.

### Notes

- Inspired by the HATEOAS pattern (Hypermedia as the Engine of Application State) — each response telegraphs the next valid actions. Keeps tool boundaries clean while making the workflow self-documenting.

## [1.2.1] — 2026-05-01

### Added

- README: new fourth example "End-to-end: leak → file → fix suggestion" walking through the complete chat-driven workflow with v1.2's Swift source-bridging tools.
- USAGE.md: section 4 ("Common follow-up requests") expanded with prompts that exercise `swiftGetSymbolDefinition`, `swiftFindSymbolReferences`, `swiftGetSymbolsOverview`, `swiftGetHoverInfo`, `swiftSearchPattern`. New `reachableFromCycle` row added.
- USAGE.md: section 3 ("How fixes flow") rewritten to reflect the new responsibility split — `memorydetective` now covers diagnose **and** source bridging; the agent owns "decide and apply the edit".

### Changed

- USAGE.md concrete end-to-end example replaced with a richer 9-step flow that exercises memgraph analysis + `reachableFromCycle` + Swift LSP tools end-to-end.

### Notes

- Doc-only release. No code changes from `1.2.0`.

## [1.2.0] — 2026-05-01

Swift source-bridging. The agent can now go from "found a leak in the cycle" to "find the file/line in this project" without leaving chat. 20 → 25 tools.

### Added

- **5 Swift source-bridging tools** backed by a `sourcekit-lsp` subprocess pool:
  - `swiftGetSymbolDefinition` — locate a class/struct/enum/etc. declaration. Pre-scans candidate paths with a fast regex, then asks SourceKit-LSP for jump-to-definition.
  - `swiftFindSymbolReferences` — every reference to a Swift symbol via `textDocument/references`. Includes a `needsIndex` hint when the IndexStoreDB is missing.
  - `swiftGetSymbolsOverview` — top-level symbols in a file (cheap orientation when landing in a new file).
  - `swiftGetHoverInfo` — type info / docs at a position. Useful to disambiguate class vs struct `self` captures.
  - `swiftSearchPattern` — pure regex search over a Swift file (no LSP, no index). Catches closure capture lists and other patterns LSP can't see.
- **`src/runtime/sourcekit/` infrastructure**: `client.ts` (LSP subprocess + JSON-RPC stdio via `vscode-jsonrpc`), `pool.ts` (per-project-root client pool with 5-minute idle shutdown), `protocol.ts` (typed wrappers for the LSP methods we use, using `vscode-languageserver-protocol` types).
- New deps: `vscode-jsonrpc`, `vscode-languageserver-protocol`. Both MIT.
- 13 new unit tests for the Swift tools (mostly `searchPattern` + helper coverage; LSP-backed tools require a live SourceKit-LSP and are smoke-tested out-of-band).

### Notes

- The Swift tools require macOS + a full Xcode install (`xcrun sourcekit-lsp` must be available). Command Line Tools alone is not enough.
- For cross-file references, the project needs an `IndexStoreDB` at `<projectRoot>/.build/index/store`. Build it with `swift build -Xswiftc -index-store-path -Xswiftc <projectRoot>/.build/index/store`.
- `sourcekit-lsp` cold start is ~2s; the pool amortizes that across calls within a project.

## [1.1.0] — 2026-05-01

Response-size + cycle-scoped queries + license switch + first-run engagement.

### Added

- **`reachableFromCycle` tool** — cycle-scoped reachability + per-class counting. Pick a cycle by `cycleIndex` or `rootClassName` substring, get instance counts of every class reachable from that cycle root. Distinguishes the actual culprit (the cycle root) from its retained dependencies. API shape inspired by Meta's `memlab` predicate-based queries. Tool count: 19 → 20.
- **`verbosity` parameter** on `analyzeMemgraph`, `findCycles`, and `reachableFromCycle`. Three levels: `compact` (default — drops module prefixes, collapses nested SwiftUI `ModifiedContent` into `+N modifiers`, truncates deep generics with a hash placeholder), `normal` (lighter shortening, depth preserved), `full` (Swift demangled names verbatim).
- **`maxClassesInChain` parameter** on `analyzeMemgraph` (default 10). Caps the per-cycle `classesInChain` array to the top N unique classes ranked by occurrence count, with app-level types prioritized over SwiftUI internals. The full unique-class total is reported in a new `classesInChainTotal` field for context.
- **Class-name shortener** (`src/parsers/shortenClassName.ts`) — three layers (drop modules, collapse `ModifiedContent` chains, truncate deep generics) with deterministic hash placeholders so the same nested type produces the same short code across runs (useful for diffing two memgraphs).
- **First-run CLI banner** — first time `memorydetective` runs in non-JSON mode on a machine, prints a one-time message pointing at the GitHub repo, `USAGE.md`, and the sponsor link. Marker stored at `~/.config/memorydetective/seen` so it never re-prints.
- **Help / output footers** — `--help` and `analyze`/`classify` non-JSON output append a discreet `# ⭐ github.com/carloshpdoc/memorydetective` line. JSON output is untouched (won't break pipes / CI).

### Changed

- **License: MIT → Apache 2.0.** Permissions are unchanged for users (commercial use, modification, distribution all allowed). Apache 2.0 adds an explicit patent grant + a `NOTICE` file mechanism; the `NOTICE` file ships in the npm tarball and surfaces project attribution in downstream "About" / acknowledgements screens.
- `analyzeMemgraph` default response is now ~80% smaller for SwiftUI-heavy memgraphs (the per-cycle `classesInChain` no longer floods with hundreds of demangled SwiftUI generics; class names per node compress from 1000+ chars to ~200). Full-fidelity output is still available via `verbosity: "full"`.
- README: license badge updated to Apache 2.0; tool count updated 19 → 20.

### Notes

- No breaking changes — all new parameters have sensible defaults. Old callers continue to work; they just receive smaller, more readable responses.

## [1.0.1] — 2026-05-01

### Added

- `USAGE.md` walkthrough covering the three usage modes (CLI, `--json`, MCP), the 8 cycle patterns and their fix hints, the end-to-end flow of how fixes go from diagnosis to a code edit (memorydetective diagnoses; the LLM agent applies the edit using its own code-editing tools), common follow-up prompts, and troubleshooting. README links to it from the Quickstart pointer line.
- `USAGE.md` is included in the npm tarball (added to `package.json` `files` whitelist).

### Changed

- No code changes from `1.0.0` — this is a documentation bump.

## [1.0.0] — 2026-05-01

First public release. **19 MCP tools** for iOS leak hunting and performance investigation, plus a thin CLI mode for scripting and CI.

### Tools

**Read & analyze (12)** — `analyzeMemgraph`, `findCycles`, `findRetainers`, `countAlive`, `diffMemgraphs`, `classifyCycle`, `analyzeHangs`, `analyzeAnimationHitches`, `analyzeTimeProfile`, `analyzeAllocations`, `analyzeAppLaunch`, `logShow`.

**Capture / record (3)** — `recordTimeProfile`, `captureMemgraph`, `logStream`.

**Discover (2)** — `listTraceDevices`, `listTraceTemplates`.

**Render (1)** — `renderCycleGraph` (Mermaid + Graphviz DOT).

**CI / test integration (1, experimental)** — `detectLeaksInXCUITest`.

### Cycle classifier

`classifyCycle` ships with an in-process catalog of 8 cycle patterns:

- `swiftui.tag-index-projection`
- `swiftui.dictstorage-weakbox-cycle`
- `swiftui.foreach-state-tap`
- `closure.viewmodel-wrapped-strong`
- `viewcontroller.uinavigationcontroller-host`
- `combine.sink-store-self-capture`
- `concurrency.task-without-weak-self`
- `notificationcenter.observer-strong`

Each pattern carries a one-line fix hint; matches are surfaced with high/medium confidence.

### CLI mode

The `memorydetective` binary doubles as a thin CLI:

```bash
memorydetective analyze   <path-to-.memgraph> [--json]
memorydetective classify  <path-to-.memgraph> [--json]
memorydetective --help
memorydetective --version
```

When called with no arguments it starts the MCP server over stdio.

### Quality

- **89 unit tests** across parsers and tools.
- Stress test guards against accidental O(n²) regressions on large memgraphs.
- CI runs Ubuntu Node 20+22 plus macOS smoke on every push.
- Strict zod input validation across every tool.

### Known limits

- **`analyzeTimeProfile`** is fragile: `xcrun xctrace export` of the `time-profile` schema crashes (SIGSEGV) on heavy unsymbolicated traces. The tool returns a structured workaround notice. Hangs analysis (`analyzeHangs`) is unaffected.
- **`captureMemgraph`** does not work on physical iOS devices — `leaks(1)` only attaches to processes on the local Mac (which includes iOS simulators). Memory Graph capture from a physical device still requires Xcode.
- **`detectLeaksInXCUITest`** is flagged experimental: orchestration logic is implemented but not yet validated against a wide set of production XCUITest runs.

[Unreleased]: https://github.com/carloshpdoc/memorydetective/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/carloshpdoc/memorydetective/releases/tag/v1.0.0
