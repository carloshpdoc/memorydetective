# Changelog

All notable changes to `memorydetective` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.0] - 2026-05-14

### Added

- **Security env flags: `MEMORYDETECTIVE_ALLOW_LAUNCH`, `MEMORYDETECTIVE_MAX_RECORDING_SECONDS`, `MEMORYDETECTIVE_TRACE_ROOT`.** `ALLOW_LAUNCH` gates `bootAndLaunchForLeakInvestigation`. The tool executes `xcodebuild` + `xcrun simctl launch` against caller-supplied paths and bundle ids; without the env var set to literally `"1"`, the tool returns `ok: false` with `state: "launchNotAllowed"` and a clear explanation rather than running. `MAX_RECORDING_SECONDS` caps `recordTimeProfile.durationSec` at the default 300s (configurable, bounded to 3600s hard ceiling) so an unattended agent cannot pile up multi-GB traces; over-cap requests throw with an actionable message. `TRACE_ROOT` becomes the default directory for `.trace` bundles when `recordTimeProfile.output` is a relative path (absolute paths bypass it, preserving v1.8 behavior); the directory is auto-created on first write. The same root will be the default scan path for the upcoming `cleanup_traces` tool. The `launchNotAllowed` state is a new value on the `LaunchState` union: agents that branch on `state` should add a case. 13 new unit tests in `src/runtime/securityFlags.test.ts` cover env-var parsing (defaults, strict literal-`1` for ALLOW_LAUNCH, bounds clamping for MAX_RECORDING_SECONDS, fallback on empty/invalid values for all three) plus the error-message helpers.

- **`MEMORYDETECTIVE_REDACTION` env var: `balanced` / `strict` / `off`.** Output-scrubbing layer applied to every tool response at the formatter boundary. `balanced` (default) collapses home-directory absolute paths to `~/...` and masks token-shaped secrets (AWS access keys, GitHub classic + fine-grained PATs, Stripe live/test secrets, Slack tokens, Bearer auth headers). `strict` additionally masks hostnames, IPv4 addresses, and bundle identifiers (`com.example.app`). `off` disables redaction for local-only debugging. The active mode is logged once on server startup to stderr so an operator running `off` knows responses are unfiltered. Redaction is structural: object keys and non-string scalars (numbers, booleans, null) pass through; only string VALUES and string array items are rewritten, so the response schema is preserved. The host/IP regexes deliberately skip filename-with-extension patterns (`leak.memgraph`, `run.trace`) to avoid false positives on paths. 28 new unit tests cover the mode parsing, the three modes, recursion through objects/arrays, key preservation, scalar pass-through, and the once-per-instance log advisory.

- **`outputFormat: "markdown" | "json" | "both"` on every analyzer.** Optional input field (omitted/`json` preserves v1.8 behavior). When `markdown`, the response is a human-readable view of the same data (H1 title, H2 per top-level field, markdown tables for arrays of uniform objects, bullet lists for scalars, inline JSON for deeply nested values). When `both`, the response carries TWO content items: markdown first (so a UI that picks `content[0]` gets the readable view), then JSON (so an agent looking for the structured data finds it). Useful when the agent wants to display markdown to the user AND parse JSON for the next call without a second round-trip. Applied to: analyzeMemgraph, analyzeTimeProfile, analyzeAllocations, analyzeAnimationHitches, analyzeHangs, analyzeAppLaunch, diffMemgraphs, analyzeAbandonedMemory. Shared formatter at `src/runtime/responseFormatter.ts` (generic JSON-to-markdown renderer with table detection, cell truncation, deep-nesting collapse) keeps the wiring DRY. 14 new unit tests cover all three modes + edge cases (empty arrays, null, deeply nested, long strings, table detection).

- **`timeRangeMs: { startMs, endMs }` scoping on `analyzeHangs` and `analyzeAnimationHitches`.** Optional time-window filter that drops samples whose `startNs` falls outside the window. Lets the agent answer "what hangs happened during this 5-second user-visible jank?" without re-recording. Filter is applied post-parse, reusing the existing parsers. When the window matches zero rows, the response carries `status: "available"` and empty arrays (different from `not_present`, which means the table itself was missing from the trace). 2 new unit tests cover the windowed filter narrowing the baseline result set and the empty-window-still-available case. `analyzeTimeProfile` and `analyzeAllocations` deferred to a follow-up because the existing parsers don't expose per-row timestamps; the window would need a parser extension.

- **`status` field (DataStatus taxonomy) on trace analyzers.** `analyzeTimeProfile`, `analyzeAllocations`, `analyzeAnimationHitches`, and `analyzeHangs` now return a `status` field disambiguating empty arrays into four cases: `available` (data was exported and parsed; empty arrays mean the trace genuinely had no rows for the section), `partial` (export started but did not finish), `not_exportable` (a GUI track exists in Instruments.app but `xcrun xctrace export` has no exportable schema for it; Apple-side limitation), and `not_present` (the requested table schema is not in the trace bundle at all). Agents should branch on this rather than collapsing all empty arrays into a generic "no data" signal. analyzeTimeProfile's existing SIGSEGV-on-xctrace-export path is now tagged `not_exportable`. Shared `DataStatus` type added to `src/types.ts`. Backwards-compatible: existing callers see a new required field on the response, TypeScript consumers that destructure or check the field continue to work; ad-hoc consumers that ignored the response shape are unaffected. 2 new unit tests cover the available + not_present cases.

- **`analyzeAbandonedMemory(beforePath, afterPath)` tool.** New top-level MCP tool that diffs two `.memgraph` snapshots on heap reference-tree class counts (NOT cycle list) and classifies each grown class against a catalog of abandoned-memory shapes: `kvo-observer-orphaned`, `notificationcenter-observer-leaked`, `cache-too-aggressive`, `singleton-retains-payload`, `unknown-growth`. Each entry carries a `confidence` tier (`high` / `medium` / `low`) and a contextual `hint` pointing at the fix. The classifier escalates large co-occurrence growth: when `NSKeyValueObservance` grew, other classes with delta >= 5 are reclassified as `kvo-observer-orphaned` (medium for delta < 50, high for delta >= 50). The natural pair for the v1.8 verify-fix loop: `captureScenarioState({label:'before'})` -> ship fix -> `captureScenarioState({label:'after'})` -> `analyzeAbandonedMemory(before, after)`. Validated end-to-end on the notelet investigation 2026-05-12 where AVPlayerItem went 342 to 0 across a fix invisible in standard `leaks` output (`leakCount: 0` on both sides). 17 new unit tests cover the classifier catalog, co-occurrence escalation, topN slicing, classFilter substring, totals computation, and the empty/identity edge cases. Registered as the 32nd MCP tool (`[mg.memory]`).

- **`analyzeMemgraph` surfaces abandoned-memory top classes when `leakCount` is 0.** Previously a clean leaks count gave `cycles: [], "No leaks detected."` and no further signal, even when the heap was retaining hundreds of orphaned objects via KVO observers, NotificationCenter handlers, or runaway caches. Now `analyzeMemgraph` invokes a second `leaks <path> --referenceTree --groupByType --noContent` pass on the leakCount-0 path and populates a new `abandonedMemoryTop[]` field with the top N classes by live instance count. New optional input parameter `referenceTreeTopN` (default 20, set 0 to skip the second leaks invocation). Reference-tree parser at `src/parsers/referenceTree.ts` aggregates instance counts across the entire tree by class name, drops c-runtime allocator entries (malloc/calloc/realloc), and resolves `--> ClassName` arrows to the value type. 14 new unit tests cover size parsing, class-name extraction, aggregation, sort stability, topN slicing, malloc filtering, and empty-input cases. Surfaced from the notelet investigation 2026-05-12 where the pre-fix memgraph had `leakCount: 0` but 342 alive AVPlayerItem instances visible in the reference tree. Backwards-compatible: existing callers without `referenceTreeTopN` get the default and a new optional field; consumers that ignore the field continue to work unchanged.

- **Catalog: `uikit.viewcontroller-retained-after-pop` pattern.** New cycle-catalog entry covering the case where a UIViewController subclass is alive in the heap but no `_parentViewController` / `_presentingViewController` edge appears in the cycle. The VC was popped from its navigation stack but a closure, Combine sink, NotificationCenter block, or KVO observation is still retaining it. DebugSwift surfaces the same shape via `dealloc` swizzle on-device; the catalog-side equivalent matches the heap residue. Confidence tiers: `high` when the root is a `*ViewController` AND a `Closure context` co-occurs (the classic shape), `medium` when only one of the two signals is present, `low` otherwise. Suppressed when explicit `_parentViewController` / `_presentingViewController` edges appear in the chain (the VC is still owned, the leak is elsewhere). 4 unit tests cover the HIGH match with closure, the MEDIUM match without closure, the parent-edge suppression, and the negative case (non-VC root). Fix-hint chains audit closures captured in `viewDidLoad`, `Task { }` blocks that outlive the screen, KVO observations that never `invalidate()`, and delegate properties declared without `weak`.

- **Catalog: `swiftui.observable-write-on-every-render` pattern.** New cycle-catalog entry for the SwiftUI antipattern of mutating an `@Observable` (or `ObservableObject`) inside `body`, which triggers infinite re-render. Beyond the perf cost, the closure that mutates the observable usually captures the view's `self` (or an enclosing model), pinning a render-graph closure in the heap. DebugSwift detects the perf side via render-frequency analysis; the cycle catalog catches the heap shape it leaves behind. Match signals: `ObservationRegistrar` / `Observation._` / `ObservableObject` co-occurs with a SwiftUI view-graph class (`SwiftUI.ViewGraph`, `SwiftUI._GraphValue`, `SwiftUI._ViewList`, `ViewBodyAccessor`, `DynamicViewProperty`) AND a `Closure context`. Confidence tiers: `high` when all three coexist, `medium` for Observable + ViewGraph, `low` for Observable + Closure without an explicit view-graph signal. 4 unit tests cover each tier and the negative case (Observable alone). Fix-hint chains the canonical "compute in computed property, not in body" or "move side effects to .onChange/.task/.onAppear" guidance.

- **`analyzeHangs`: optional `mainThreadViolations` enrichment.** Each top hang now carries an optional `mainThreadViolations: Array<{ kind: "sync-io" | "db-lock" | "network" | "lock-contention"; topFrame: string; samples: number }>` field populated when the caller supplies a supplemental `topFramesByHangStartNs: Record<string, string>` map. Stringified `startNs` values are the keys so the map survives JSON round-trips. The pure classifier `classifyHangFrame(topFrame)` is exported for programmatic use and matches a four-category catalog inspired by DebugSwift's Thread Checker: `sync-io` (read/write/fsync, NSData blocking initializers, FileManager mutators), `db-lock` (SQLite mutex acquisition, NSPersistentStoreCoordinator lock, NSManagedObjectContext save), `network` (NSURLConnection sendSynchronousRequest, CFReadStreamRead, nw_connection_start/wait), and `lock-contention` (pthread / os_unfair_lock / dispatch_semaphore_wait / dispatch_sync / NSLock). When the frame is supplied but matches no signature, `mainThreadViolations` is set to `[]` (deliberate, "we looked and found nothing actionable"); when no frame is supplied for a given hang, the field stays `undefined`. The typical pipeline: call `analyzeTimeProfile` on the same trace, correlate samples to hang windows by timestamp, then re-call `analyzeHangs` with the resulting map. 11 new unit tests cover the four categories, the no-match null path, the samples threading, the map-key convention, and the three enrichment branches (matched, unmatched-frame, missing-frame).

- **`detectLeaksInXCTest` tool: per-test leak gate for XCTest unit-test schemes.** Sibling to `detectLeaksInXCUITest`. Builds for testing, launches the test bundle with an optional `-only-testing:<TestTarget>/<TestClass>[/<testMethod>]` filter, polls for the runner process (`xctest` by default, overridable via `processName` for app-hosted unit bundles), captures `.memgraph` baseline + after, diffs. Returns `passed: false` when new ROOT CYCLEs appear that are not in the `allowlistPatterns` list. Per-test granularity is achieved by calling the tool once per test method with different `testCaseFilter` values; aggregation stays on the caller side, keeping every response tied to a single well-defined before/after pair. When the runner exits before the after-capture window (common for fast unit tests with no host), the response carries an explicit `failureReason` pointing at the `tearDown` workaround. Registered as the 34th MCP tool (`[mg.ci]`). 15 unit tests cover schema validation (mutually-exclusive workspace/project, default `processName`, custom processName), the allowlist substring check, the descendant counter, and the new-cycles diff (no-change, new-leak, allowlist-matched, mixed, anonymous-root by address, chainLength inclusion).

- **HTML report output for both `detectLeaks*` tools.** Added optional `outputHtmlPath` parameter. When set, the tool writes a self-contained HTML report (inline CSS, no external assets) with verdict pills (PASS/FAIL), baseline/after/delta stat blocks, a new-cycles table tagging each entry as allowlisted or failing, the run-log inside a collapsed `<details>` block, and full HTML-entity escaping so leaked class names cannot inject markup. The response gains an `htmlReportPath` field pointing at the same file. Template lives at `src/templates/leak-report.html` and is copied to `dist/templates/` by the build script. Designed for CI artifact upload + PR-comment bots that link directly to the artifact. 12 unit tests cover the renderer (PASS/FAIL pills, failureReason rendering, allowlist badges, HTML escaping against script/img injection, memgraph path embedding, steps block, multi-section ordering, subtitle, version/timestamp substitution, signed delta formatting) plus the file-write helper.

- **CI recipe: "Add memorydetective to your CI in 5 minutes".** New README subsection under "CI / test integration" with a working `.github/workflows/leaks.yml` template that runs `detectLeaksInXCTest` and uploads the HTML report as an artifact. The same workflow is also available verbatim at `examples/ci/github-actions-leaks.yml`. Walkthrough covers Xcode pinning, simulator boot, allowlist pattern guidance (incl. `_TtC` Swift mangled prefixes), the iOS 18 runtime choice for the macOS 26.x regression, and `actions/cache` + `--skipBuild` for build reuse across chained invocations.

- **`cleanupTraces` tool: preview and delete `.trace` bundles under `MEMORYDETECTIVE_TRACE_ROOT`.** New top-level MCP tool that walks the trace root, finds `.trace` directories produced by `recordTimeProfile`, and returns a sorted (oldest-first) list of candidates with `path`, `sizeMB`, and `ageDays`. `dryRun: true` by default so an accidental call previews instead of destroying. Pass `dryRun: false` to actually delete. Optional `olderThanDays: N` filters to bundles older than the threshold (useful for "delete anything older than a week" workflows); omitted, all bundles are considered regardless of age. **Scope is restricted to `MEMORYDETECTIVE_TRACE_ROOT` by default.** To clean up an arbitrary directory, pass `root: <path>` AND set `MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP=1` in the env; without it, the tool returns `ok: false` with the failure reason and deletes nothing (default-deny on destructive disk operations outside the configured boundary). The walker stops at the `.trace` directory boundary (does NOT descend INTO bundles) so xctrace's `Run1`, `Form1.template`, etc. inside a bundle are not misread as nested bundles. Solves the "trace root fills up after a few profiling sessions" problem that v1.8 left to manual `rm -rf`. 15 new unit tests cover the boundary check (sibling-prefix string false positives), age filter, dryRun preserve-on-disk, dryRun=false deletes, external-root guard, missing-root tolerance, and file/non-`.trace`-directory skipping. Registered as the 33rd MCP tool (`[ops]`).

- **`recordTimeProfile` external timeout wrapper for the macOS 26.x `xctrace --time-limit` regression.** On some macOS 26.x simulator builds, `xctrace record` ignores `--time-limit` and runs indefinitely past its declared deadline. `recordTimeProfile` now wraps the invocation with a soft timeout at `durationSec + 30s` that sends `SIGINT` (so xctrace flushes the trace cleanly), waits up to 10s for graceful exit, then escalates to `SIGKILL` only if necessary. When the wrapper fires, the response gains `recordingTimedOut: true` and a structured `workaroundNotice` with `issue: "xctrace-time-limit-ignored"` listing concrete mitigations (iOS 18 sim runtime, shorter durations, simulator restart for partial-trace recovery). Previously the only outcomes were "xctrace exits cleanly" or "user kills the agent loop manually". Critically, `SIGTERM` (the previous default in `runCommand`) corrupts xctrace traces; this path explicitly uses `SIGINT` so the partial output remains parseable. `runCommand` in `src/runtime/exec.ts` gains two new options to support this: `timeoutSignal: NodeJS.Signals` (default `SIGTERM`, opt in to `SIGINT`) and `gracefulKillAfterMs: number` (default `0`, opt in to "resolve with `timedOut: true` instead of reject"). Default behavior preserved for all existing callers. 6 new unit tests in `src/runtime/exec.test.ts` cover the new paths.

### Changed

- **Docs: macOS 26.x regression and the iOS 18 escape hatch documented prominently.** README gains a "Heads up for macOS 26.x users" callout in the Highlights section, naming the regression and the iOS 18 sim runtime workaround. USAGE.md Troubleshooting section now distinguishes `minimal-corpse` (relaunch with MallocStackLogging fixes) from `macos-26-task-for-pid-broken` (iOS 18 sim is the only reliable path), each with their own recovery checklist. Plus a note on the scheme-level Malloc Stack Logging toggle needed for Xcode's "View Memory Graph Hierarchy" on macOS 26.x.

### Added

- **New `macos-26-task-for-pid-broken` workaround issue.** When `captureMemgraph` detects a `minimal-corpse` failure pattern AND the host is macOS 26.x (Darwin kernel 25.x), the workaround notice now upgrades the `issue` field from `minimal-corpse` to `macos-26-task-for-pid-broken`, swaps in a platform-aware message that names the Apple-side kernel regression as the root cause, and reorders the `fallbacks[]` to put the iOS 18 simulator runtime first. Adjusts `suggestedNextCalls` to chain into `recordTimeProfile` + `analyzeAllocations` on the new issue id the same way it does for `minimal-corpse`. Agents that branch on the issue id should add a case for the new value; the existing `minimal-corpse` branch continues to fire on non-macOS-26 hosts (older macOS, future macOS releases pending verification). 2 new unit tests cover the upgrade path and confirm `permission-denied` / `transient` are unaffected by the platform context. `classifyLeaksFailure` gains an optional `isMacOS26: boolean` parameter (defaults to `false`, so existing callers compile unchanged).

- **Proactive macOS 26.x platform advisory.** `captureMemgraph`, `captureScenarioState`, and `bootAndLaunchForLeakInvestigation` now emit a one-time stderr banner and a structured `platformAdvisory` field on their response when running on macOS 26.x (Darwin kernel 25.x). The advisory documents Apple's `task_for_pid` kernel regression that blocks `leaks --outputGraph`, `heap`, and `xctrace --template Allocations` against simulator processes regardless of `MallocStackLogging=1`, and recommends an iOS 18 simulator runtime as the most reliable workaround. Set `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` to silence. New `src/runtime/platformCheck.ts` with 10 unit tests covering the helper. Reduces wasted time for users hitting the regression for the first time. Surfaced during the notelet investigation 2026-05-12 where three independent CLI memory-introspection paths failed before iOS 18 was identified as the working escape hatch.

### Fixed

- **`replayScenario` and `captureScenarioState`: tap targets by `elementId` now resolve SwiftUI's `accessibilityIdentifier(_:)`.** The internal `normalizeAxeNode` in `src/runtime/axe.ts` previously only read the `AXIdentifier` key when populating `UIElement.identifier`, but `axe describe-ui` (and Apple's accessibility tree) emit the SwiftUI `accessibilityIdentifier` value under `AXUniqueId`. Result: every `tap` targeted by `elementId` failed with "Could not locate element matching ..." even when the element was present in the tree. Now reads both keys in order (`AXIdentifier` first, then `AXUniqueId`). Surfaced from the notelet investigation 2026-05-12 where 20 replay iterations all failed to find a SwiftUI Button identified by `.accessibilityIdentifier("present-button")`. 2 new unit tests cover the AXUniqueId path and the precedence case.

## [1.8.1] - 2026-05-13

Metadata-only release to enable submission to the official MCP Registry (`registry.modelcontextprotocol.io`). Adds the `mcpName` property to `package.json` so the registry can verify that the published npm package matches the registry submission metadata.

### Added

- **`mcpName: "io.github.carloshpdoc/memorydetective"`** in `package.json`. Required by the MCP Registry to verify package ownership. Follows the `io.github.<owner>/<repo>` convention mandated for GitHub-based authentication with `mcp-publisher`.

### Notes

- No code changes, no API changes, no functional changes for existing consumers.
- Existing v1.8.0 installs keep working unchanged.
- The plugin's `^1.7` SPM-style range picks this up automatically; no plugin sync needed for this patch.

## [1.8.0] - 2026-05-06

`leaks --outputGraph` regressed on macOS 26.x and aborts with `Failed to get DYLD info for task` when the target was not launched with malloc-stack-logging. This release fixes that end to end. `captureMemgraph` detects the regression and emits a structured `workaroundNotice`, the new `bootAndLaunchForLeakInvestigation` tool absorbs build + boot + install + launch with `MallocStackLogging=1` so capture works on the first try, and `replayScenario` + `captureScenarioState` close the verify-fix loop with deterministic before/after snapshots. 28 -> 31 MCP tools, 213 -> 287 tests.

### Added

- **`bootAndLaunchForLeakInvestigation` tool** (`[mg.build]`). Single-call orchestration: resolves a simulator (udid, name+os, or whichever is booted), runs `xcodebuild -showBuildSettings -json` to discover BUILT_PRODUCTS_DIR / WRAPPER_NAME / EXECUTABLE_NAME / PRODUCT_BUNDLE_IDENTIFIER, runs `xcodebuild build` (skippable), boots the simulator with `bootstatus -b` waiting for SpringBoard, installs the .app, and launches with `MallocStackLogging=1` propagated via the `SIMCTL_CHILD_*` prefix simctl honors. Returns the host PID + simulator UDID + bundle id ready to chain into `captureMemgraph`. Multi-simulator disambiguation via filtering `ps -Ao pid,command` by the target UDID's CoreSimulator path; long executable names that would silently miss `pgrep -x` (15-char comm truncation) work natively.
- **`replayScenario` tool** (`[mg.scenario]`). Drives the iOS Simulator through tap / swipe / wait / type actions with a `repeat` count, useful for amplifying leaks that only manifest after N iterations of a navigation flow. Tap targets accept `label`, `elementId`, or explicit `coords`. Optional `finalUITreePath` writes the post-replay accessibility tree as JSON for the agent to verify the app ended where expected. Soft dependency on Cameron Cooke's [axe](https://github.com/cameroncooke/AXe) CLI: when missing, returns `ok:false` with a structured workaroundNotice pointing at `brew install cameroncooke/axe/axe` instead of throwing.
- **`captureScenarioState` tool** (`[mg.scenario]`). Composite snapshot for verify-fix: writes a `.memgraph` + `.png` screenshot + `.ui.json` accessibility tree into `outputDir`, all prefixed by `label` (typically `before` / `after`). Sub-captures are best-effort: if leaks fails on macOS 26.x, the screenshot and UI tree still complete and the captureMemgraph workaroundNotice is surfaced via `memgraphWorkaroundNotice` so the agent can fall back to xctrace Allocations or Xcode manual export. `include` parameter lets the caller skip pieces (e.g. `["memgraph", "screenshot"]` when no UI tree is needed).
- **Structured `workaroundNotice` on `captureMemgraph`**. New shape `{ issue, message, fallbacks[] }` with stable issue ids: `minimal-corpse` (the macOS 26.x DYLD info regression), `permission-denied` (task_for_pid failures), `leaks-not-found` (binary missing from PATH), `transient` (unrecognized non-zero exit). Single retry on transient only; deterministic issues skip the retry. New `warnings` field surfaces non-fatal observations (e.g. MallocStackLogging not active on the target). New `suggestedNextCalls` field points at `recordTimeProfile` (Allocations) + `analyzeAllocations` as a structured fallback when leaks cannot capture a memgraph.
- **`troubleshooting` field on Playbook**. The `memgraph-leak` playbook documents the macOS 26.x minimal-corpse and permission-denied recovery paths inline with structured `{ tool, issueId, trigger, recovery[] }` entries the agent can branch on. Includes the Xcode manual export fallback for cases where every automated path fails.
- **`runCommand` env support**. `src/runtime/exec.ts` now accepts an optional `env` parameter that merges on top of `process.env` (preserves PATH, DEVELOPER_DIR, HOME). Required to propagate `SIMCTL_CHILD_*` keys through to the simctl child.
- **Internal infrastructure modules** (not exposed as MCP tools, supports the leak/perf workflow only). `src/runtime/buildSettings.ts` parses `xcodebuild -showBuildSettings -json` defensively (slicing between first `[` and last `]`, filtering targets by `WRAPPER_EXTENSION=app`). `src/runtime/simctl.ts` wraps `xcrun simctl` boot / bootstatus / install / launch / list / io screenshot with idempotent error handling. `src/runtime/axe.ts` wraps the axe CLI for UI tree introspection and tap/swipe/type, with normalized UIElement parsing across CGRect-string and AppKit-dictionary frame formats.

### Changed

- README: new "What's new in v1.8" callout. Tool count `28 -> 31`. New macOS 26.x troubleshooting note. Examples gain a verify-fix loop combining `bootAndLaunchForLeakInvestigation` -> `captureScenarioState({label:"before"})` -> ship fix -> `captureScenarioState({label:"after"})` -> `diffMemgraphs`.
- USAGE.md: documents the 3 new tools with concrete invocation examples plus the new `troubleshooting` field on the memgraph-leak playbook.
- Test count: 213 -> 287 (74 new). 6 buildSettings parser, 12 simctl parsers, 16 boot-and-launch (schema + pickHostPidFromPs across multi-sim and long-name cases), 16 axe parsers (parseAxeDescribeUI, parseAxFrame, findElementByLabel, centerOf), 11 replayScenario (schema + resolveTapTarget), 13 captureScenarioState (schema + sanitizeLabel).

### Notes

- No breaking changes for existing callers. `captureMemgraph` now returns `ok:false` with structured workaroundNotice on known issues instead of throwing, but consumers that read `result.ok` before `result.output` continue to work.
- `output` field on `CaptureMemgraphResult` is now optional (present on success, absent on failure paths). Old code that destructured it without checking `ok` first will see `undefined` instead of a path, which surfaces the failure rather than silently using a broken value.
- `axe` is a soft dependency. The plugin installs and runs without it. Only `replayScenario` and the `uiTree` sub-capture of `captureScenarioState` require it; both return structured install hints when axe is missing instead of failing hard.
- The plugin's public surface stays scoped to leak/perf debug. UI primitives (`describeUI`, `tap`, `swipe`, `typeText`) live in `src/runtime/axe.ts` and are not registered as MCP tools, only `replayScenario` and `captureScenarioState` are exposed, both tied to the verify-fix workflow.

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

[Unreleased]: https://github.com/carloshpdoc/memorydetective/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.8.1...v1.9.0
[1.4.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/carloshpdoc/memorydetective/releases/tag/v1.0.0
