# memorydetective

> Diagnose iOS retain cycles and performance regressions from your chat window. No Xcode required.

[![npm](https://img.shields.io/npm/v/memorydetective.svg)](https://www.npmjs.com/package/memorydetective)
[![CI](https://github.com/carloshpdoc/memorydetective/actions/workflows/ci.yml/badge.svg)](https://github.com/carloshpdoc/memorydetective/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/carloshpdoc/memorydetective?style=flat&logo=github)](https://github.com/carloshpdoc/memorydetective/stargazers)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#requirements)

![demo](./examples/demo.gif)

## Highlights

- **CLI-driven leak hunting.** Read `.memgraph` files captured by Xcode (or by `memorydetective` itself on simulators), find ROOT CYCLEs, classify them against known SwiftUI/Combine patterns, and get a one-liner fix hint. All from a script or a chat.
- **MCP-native.** Plugs into Claude Code, Claude Desktop, Cursor, Cline, and any other MCP client. The agent drives the full investigate → classify → suggest-fix loop without you opening Instruments.
- **Honest about its limits.** No mocked outputs, no over-promises. Hangs analysis works clean from `xctrace`; sample-level Time Profile is parsed when `xctrace` symbolicates the trace and returns a structured workaround notice when it can't (the underlying `xctrace` SIGSEGV on heavy unsymbolicated traces is an Apple-side limitation we surface explicitly). Memory Graph capture works on Mac apps and iOS simulator; physical iOS devices still need Xcode.

> **What's new in v1.18** (2026-05-17): MetricKit + audit-close. **`analyzeMetricKitPayload` is the 42nd MCP tool**: ingests Apple MetricKit `.mxdiagnostic` JSON payloads from real-device TestFlight / App Store builds (post-mortem production diagnostics — no MCP competitor covers this lane today). Three actionable outputs: crash clusters by exception type / binary / top frame, hang hotspots with localized-duration parsing (`"5.4 sec"` / `"20秒"`), CPU + disk exceptions. Cross-tool chain hints (e.g. `objc_release`-style top frame surfaces a `findCycles` suggestion). Plus three audit-close items: open-enum `SupportStatusKind` (downstream consumers add kinds without a breaking type bump), invocation-scoped `schemaDiscovery` cache (`summarizeTrace` end-to-end shaved from ~28s to ~15s on real Apple traces via single up-front TOC fetch), and local-only integration tests against real Apple `.trace` bundles (closes the v1.14 P+O drift class for good). 701 → 757 tests. 41 → 42 MCP tools.
>
> **Also recent (v1.17)**: reliability pass. 14 bug fixes across three tiers. Headlines: strtobool env truthy parsing, `verifyFix` whitelist match modes (exact / substring / regex), `recordViaInstrumentsApp` catches traces saved outside `watchDir`, `inspectTrace` fault-tolerant fallback, configurable `countAlive` framework-noise filter, variable-size class min/max/median.
>
> **And v1.16**: macOS 26.x recording-unblock release. New `recordViaInstrumentsApp` MCP tool wraps the Instruments.app GUI flow: opens the app, surfaces step-by-step instructions, watches a directory for the saved `.trace`, and chains into `inspectTrace` on success. Until Apple fixes the `xcrun xctrace record` regression on macOS 26.x sims, this is the automated path.
>
> **And v1.15**: schema coverage + verify-fix UX. Three new MCP trace tools filled the remaining schema gap: `analyzeMemoryFootprint` (38th, VM resident / dirty / virtual + jetsam diagnosis), `analyzeEnergyImpact` (39th, battery drain investigation), `analyzeLeakTimeline` (40th, xctrace's leaks instrument as a time series). `summarizeTrace` now chains `analyzeNetworkActivity`. `replayScenario` captures simulator screenshots per step.
>
> **Earlier**: v1.14 trace-side reliability, `analyzeNetworkActivity`, unified `supportStatus[]`, FLEX-inspired `countAlive` size view, MLeaksFinder + DebugSwift-inspired `verifyFix` whitelist. v1.13 shipped `summarizeTrace` + `/summarize-trace` MCP prompt. v1.12 completed reference-tree propagation. v1.11 added inspectTrace, diffMemgraphs reference-tree. v1.9 shipped analyzeAbandonedMemory, detectLeaksInXCTest, cleanupTraces, mainThreadViolations. Full notes in [CHANGELOG](./CHANGELOG.md).

> **Heads up for macOS 26.x users:** Apple shipped a `task_for_pid` kernel regression on macOS 26.x that blocks `leaks --outputGraph`, `heap`, AND `xctrace --template Allocations` against iOS simulator processes regardless of `MallocStackLogging`. Even Xcode's "View Memory Graph Hierarchy" hits it unless `Malloc Stack Logging` is enabled in the scheme's Diagnostics tab. memorydetective surfaces this as a proactive `platformAdvisory` on the first capture-class tool call, plus a `workaroundNotice` with `issue: "macos-26-task-for-pid-broken"` if `leaks` is invoked. **The most reliable workaround today is to target an iOS 18 simulator runtime** (install via Xcode > Settings > Platforms > +iOS 18.x). Empirically validated in the [notelet investigation](https://github.com/carloshpdoc/memorydetective/blob/main/CHANGELOG.md#unreleased) 2026-05-12 where three independent CLI memory-introspection paths all failed before iOS 18 was identified as the working escape hatch. Set `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY=1` to silence the notice once you have settled on a workaround.

> **Also on macOS 26.x: `xctrace record` is broken for simulator targets.** Independent from the `task_for_pid` regression above, `xcrun xctrace record --time-limit Ns` against iOS simulator processes wedges past the time limit, eventually exits when killed, and the resulting `.trace` bundle is missing template metadata. `xctrace export --toc` then fails with `Document Missing Template Error`. Re-validated against Xcode 26.5 (build 17F42, xctrace 16.0) 2026-05-15: regression survives the update. This hits the entire `xctrace`-based ecosystem the same way (`memorydetective.recordTimeProfile`, XcodeTraceMCP, and naked `xcrun xctrace record` calls all fail identically). **Workarounds:** (1) **use `recordViaInstrumentsApp`** (v1.16, hardened in v1.17), which opens Instruments.app for you, prompts you to record + save the `.trace`, then chains into `inspectTrace` automatically once the bundle appears. v1.17 also catches saves outside the watch directory via an Instruments.app AppleScript document query, returning `savedOutsideWatchDir: true` plus the actual path; (2) record from an older macOS host with Xcode 26.0 if you have one; (3) record against a physical device (the regression appears to be simulator-specific). v1.17 added a viability probe on `recordTimeProfile` (`bundleStatus: "wedged"` when the on-disk bundle is the 52K stub) and on `inspectTrace` (returns `ok: true` with diagnosis text instead of throwing). USAGE.md > Troubleshooting has a step-by-step.

## Quickstart

```bash
npm install -g memorydetective
```

Add to your MCP client config (Claude Code shown):

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

Or use it directly from the command line:

```bash
memorydetective analyze   ~/Desktop/myapp.memgraph
memorydetective classify  ~/Desktop/myapp.memgraph
```

→ See [Examples](#examples) for chat-driven flows · [API](#api) for the full tool reference · [Configure](#configure) for Claude Desktop / Cursor / Cline · [USAGE.md](./USAGE.md) for the full walkthrough including how fixes flow from diagnosis to your codebase.

---

## Examples

> Realistic chat snippets. The agent calls the MCP tools listed in [API](#api).

### Diagnose a leak from a memgraph

> **You:** I just exported a memory graph at `~/Desktop/example.memgraph`. Something's leaking after I close a detail screen. What is it?
>
> **Claude:** *(calls `analyzeMemgraph` → `classifyCycle`)*
> Found 4 ROOT CYCLE blocks across 60,436 leaks. The dominant one matches **swiftui.tag-index-projection** with high confidence. A closure attached via `.tag()` on a photo carousel `ForEach` is capturing `self` strongly through `_viewModel.wrappedValue`, which keeps `DetailViewModel` and the navigation coordinator alive after dismissal.
>
> **Suggested fix:** replace `[weak self]` capture in the tap handler with a static helper, or weak-capture the view-model via `[weak coord = self.coordinator]`. Want me to find the exact file?

### Verify a fix actually worked

> **You:** I shipped the fix. Compare `~/Desktop/before.memgraph` to `~/Desktop/after.memgraph` and tell me whether `DetailViewModel` count dropped.
>
> **Claude:** *(calls `diffMemgraphs` → `countAlive`)*
> `DetailViewModel`: **12 → 0** (delta `-12`). The `swiftui.tag-index-projection` cycle is gone. Total leak count fell from 60,436 to 55,576 (−4,860). Three other ROOT CYCLEs persist. They're SwiftUI internals, not your code.

### Self-contained verify-fix loop (v1.8)

When `leaks --outputGraph` fails on macOS 26.x (`Failed to get DYLD info for task`), the cause is usually that the app was not launched with `MallocStackLogging=1`. The new orchestration tools handle this end to end without you wiring up xcodebuild + simctl + axe yourself.

> **You:** Reproduce the leak in `MyApp` for me. Build, launch with the right env vars, repeat the photo carousel flow 5 times to amplify it, capture before, then I'll ship the fix and you capture after.
>
> **Claude:** *(calls `bootAndLaunchForLeakInvestigation`)*
> Built + booted iPhone 15 (UDID `ABCD-...`). Launched `MyApp` (PID `49581`) with `MallocStackLogging=1`. Bundle id `com.example.MyApp`.
>
> *(calls `replayScenario` with 5 taps on the carousel + back-button cycle, repeat 5)*
> Executed 25 actions in 12.3s. No failures.
>
> *(calls `captureScenarioState({label:"before"})`)*
> Wrote `before.memgraph` (63,201 leaks), `before.png`, `before.ui.json`. `MallocStackLogging` active, no workaroundNotice.
>
> *(you ship the fix and rebuild)*
>
> *(calls `bootAndLaunchForLeakInvestigation` + replay + `captureScenarioState({label:"after"})`)*
>
> *(calls `diffMemgraphs` → `verifyFix`)*
> `DetailViewModel`: **15 → 0**. `swiftui.tag-index-projection` PASS. Bytes freed: 28.4 MB.

### Find the slow path on a real device

> **You:** Profile DemoApp on my iPhone for 90 seconds and tell me where the hangs are.
>
> **Claude:** *(calls `listTraceDevices` → `recordTimeProfile` → `analyzeHangs`)*
> Recorded `~/Desktop/run.trace` (90s, attached to DemoApp on iPhone 17 Pro Max). Found **23 user-visible hangs** (>500 ms each), longest 1.16 s, average 769 ms. Severe load. All on the main thread. Sample-level hotspots aren't symbolicated yet; open the trace in Instruments for that step (`analyzeTimeProfile` returns a structured workaround notice when `xctrace` can't symbolicate. See CHANGELOG known limits).

### Analyze MetricKit payloads from real-user crashes (v1.18)

> **You:** I have a folder of `.mxdiagnostic` files from the last 30 days of TestFlight at `~/Downloads/metrickit-may/`. What's catching real users?
>
> **Claude:** *(calls `analyzeMetricKitPayload({ payloadDir: "~/Downloads/metrickit-may/" })`)*
> 47 payloads, 2026-04-15 → 2026-05-15. Top: **18 crashes EXC_BAD_ACCESS** clustered on the same top frame, all in builds 456 and 457 (clean on 458 + earlier). Pattern matches retain-cycle release — chain hint surfaces `findCycles` next.
>
> Second: **5.4s hang** on `libsqlite3.dylib` (3 samples). Pattern `db-lock`. If you reproduce locally, chain into `analyzeHangs` with `includeStackClassification: true` for the `mainThreadViolations[]` classifier.
>
> No symbolicated frames in v1.18 (raw `binaryUUID + offset` shipped — dSYM lookup is a separate tool, future release). Localized hang strings handled: input was `"5.4 sec"`, normalized to 5400ms; one diagnostic carried `"20秒"` (Japanese), normalized to 20000ms.

See [USAGE.md § MetricKit production post-mortem](./USAGE.md#end-to-end-example-metrickit-production-post-mortem-v118) for the full end-to-end including how to wire `analyzeMetricKitPayload` into a verify-fix loop across multiple TestFlight builds.

### End-to-end: leak → file → fix suggestion

The full loop, from artifact to code edit. Combines memory-graph analysis with Swift source-bridging.

> **You:** Tem um leak. Memgraph em `~/Desktop/example-leaks.memgraph`. The cycle points at `DetailViewModel`. Find where it lives in the project `~/Development/myapp/` and suggest a fix.
>
> **Claude:** *(calls `analyzeMemgraph` → `classifyCycle` → `reachableFromCycle`)*
> Found **4 ROOT CYCLE blocks**. The dominant one matches `swiftui.tag-index-projection` with high confidence. `reachableFromCycle` confirms 4 `DetailViewModel` instances pinning ~1100 `NSURLSessionConfiguration`s each. The VM is the culprit, the network stack is collateral.
>
> *(calls `swiftSearchPattern` to locate `.tag(` + `onImageSliderTap` patterns in `~/Development/myapp/Sources/`)*
> 1 match in `MyApp/Views/MediaCarousel.swift:142`.
>
> *(calls `swiftGetSymbolDefinition({ symbolName: "DetailViewModel", projectRoot: "...", candidatePaths: ["MyApp/ViewModels/"] })`)*
> Declared at `MyApp/ViewModels/DetailViewModel.swift:18`. `class DetailViewModel: ObservableObject`.
>
> *(calls `swiftFindSymbolReferences` to scope the blast radius. 7 callsites)*
>
> **Suggested fix at `MediaCarousel.swift:142`:**
> ```swift
> // before
> .tag(index)
> .onImageSliderTap { index in
>     self.viewModel.handlePhotoTap(at: index)
> }
>
> // after. Static helper + weak captures
> .tag(index)
> .onImageSliderTap { [weak vm = _viewModel.wrappedValue,
>                      weak coord = self.coordinator] index in
>     Self.handlePhotoTap(index: index, viewModel: vm, coordinator: coord)
> }
> ```
> Want me to apply this and verify with a fresh `.memgraph`?

---

## What it saves you

The pitch in one sentence: **`memorydetective` turns a 50–500 MB binary memgraph (or a 200 KB `leaks(1)` text dump) into a 2–5 KB structured summary your AI agent can actually reason about.** That changes the economics of using an LLM for iOS perf investigation.

### Tokens (when paired with an AI agent like Claude / Cursor / Cline)

A real-world retain-cycle investigation, run twice. Once with `memorydetective`, once with the agent reading the raw `leaks(1)` output directly:

| Step | Without MCP (agent reads raw output) | With `memorydetective` |
|---|---|---|
| Load `leaks` text dump (~280 KB) | ~70,000 input tokens | n/a |
| `analyzeMemgraph` summary | n/a | ~750 input tokens |
| `classifyCycle` + fix hint | agent re-reasons over the dump per follow-up (3–4 extra turns) | 1 turn, structured `patternId` + `fixHint` |
| `findRetainers` / `reachableFromCycle` | agent re-scans the dump | ~500 tokens, scoped query |
| **Net per investigation** | ~85,000 tokens, ~6 turns | ~3,000 tokens, ~2 turns |

**Translates to roughly $0.40–$1.20 per investigation** depending on the model (Claude Opus / Sonnet / Haiku). Compounds linearly with file size and investigation depth.

### Developer time

The same investigation, measured by the developer:

| Step | Without MCP | With `memorydetective` |
|---|---|---|
| Capture memgraph + run `leaks` | 5 min | 5 min (same) |
| Read & interpret `leaks` text dump | 15–30 min (skim 200 KB of repetitive frames) | 30 sec (read 3 KB summary) |
| Identify the responsible pattern | 10–20 min (recognize the cycle shape from experience) | instant (classifier returns `patternId` + fix hint) |
| Locate the suspect type in source | 10–15 min (grep + manual navigation) | 30 sec (`swiftGetSymbolDefinition` returns `file:line`) |
| Find every callsite to gauge fix blast radius | 5–10 min (Xcode / grep) | 10 sec (`swiftFindSymbolReferences`) |
| **Net wall-clock** | **45–80 min** | **~10 min** |

Numbers are rounded from a single anonymized real investigation (a SwiftUI retain cycle over a tagged `ForEach` that pinned ~28 MB of network-stack state). Your mileage will vary with cycle complexity and codebase size.

### When the win is marginal

Be honest about where this **doesn't** help much:

- **Tiny memgraphs** (a single cycle, < 50 KB raw): MCP overhead is roughly token-neutral vs. Raw read. The dev-time win still holds (no manual cycle parsing) but the token win shrinks.
- **One-shot symbol lookups** without a leak attached: just use `grep`, you don't need this.
- **First-time investigations on a new codebase**: the agent still needs orientation turns regardless of MCP. The compounding wins kick in on the *second* and later investigations once the agent has cached the project's shape.

The win compounds with **(a)** file size, **(b)** investigation depth (multi-turn), and **(c)** how many leaks you investigate per quarter. For a single dev fixing one leak per year, the value is mostly the dev-time saving. For a team running CI gates with `verifyFix` across every PR, the token + time savings stack across hundreds of runs.

---

## Configure

The `memorydetective` binary speaks MCP over stdio. Point any MCP-compatible client at it.

<details>
<summary><b>Claude Code</b></summary>

```jsonc
// ~/.claude/settings.json (global) or .mcp.json (per-project)
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

Restart Claude Desktop after editing.

</details>

<details>
<summary><b>Cursor</b></summary>

```jsonc
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

</details>

<details>
<summary><b>Cline (VS Code)</b></summary>

```jsonc
// VS Code settings.json
{
  "cline.mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

</details>

<details>
<summary><b>Kiro</b></summary>

Kiro supports MCP servers via its global config. The block mirrors Claude Desktop's:

```jsonc
{
  "mcpServers": {
    "memorydetective": { "command": "memorydetective" }
  }
}
```

Consult Kiro's MCP setup docs for the exact config file path on your system.

</details>

<details>
<summary><b>GitHub Copilot</b> (experimental)</summary>

GitHub Copilot supports MCP servers in Agent mode (VS Code 1.94+). Add to `.vscode/mcp.json` in your repo:

```jsonc
{
  "servers": {
    "memorydetective": {
      "type": "stdio",
      "command": "memorydetective"
    }
  }
}
```

Copilot's MCP integration moves fast. If this snippet is stale, see the [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

</details>

### Environment variables

Every boolean `MEMORYDETECTIVE_*` flag below accepts the **strtobool** truthy set (case-insensitive): `1 / true / t / yes / y / on` (truthy) and `0 / false / f / no / n / off` (falsy). Unrecognized values emit a one-time stderr warning per variable and fall back to the documented default. Pre-v1.17 the parser was `1`-only, which caused silent no-ops when operators exported `=true` or `=yes`. The advisory warning is gated on `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY`.

| Variable | Default | Effect |
|---|---|---|
| `MEMORYDETECTIVE_REDACTION` | `balanced` | Output scrubbing applied to every tool response. `balanced` collapses home-directory paths to `~/...` and masks token-shaped secrets (AWS keys, GitHub PATs, Stripe, Slack, Bearer auth). `strict` adds hostname, IPv4, and bundle-identifier masking. `off` disables redaction (useful for local-only debugging). Mode is logged once at server startup. |
| `MEMORYDETECTIVE_ALLOW_LAUNCH` | unset | Boolean (strtobool). Allows `bootAndLaunchForLeakInvestigation`. The tool executes `xcodebuild` and `xcrun simctl launch` against caller-supplied paths and bundle ids, so opt-in is required. Without the gate, the tool returns `ok: false` with `state: launchNotAllowed` and a clear explanation. Set this only when you trust the inputs the agent is producing. |
| `MEMORYDETECTIVE_MAX_RECORDING_SECONDS` | `300` | Cap on `recordTimeProfile.durationSec`. Requests above the cap are rejected with a clear error. Bounded internally to a 3600s (1h) hard ceiling so a misconfigured env var cannot disable the gate. |
| `MEMORYDETECTIVE_TRACE_ROOT` | `~/Library/Application Support/memorydetective/traces` | Directory used when `recordTimeProfile.output` is a relative path. Absolute paths bypass this default for v1.8 backwards-compat. Also the default scan path for `cleanupTraces`. The directory is auto-created on first write. |
| `MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP` | unset | Boolean (strtobool). Allows `cleanupTraces` to scan and delete `.trace` bundles OUTSIDE `MEMORYDETECTIVE_TRACE_ROOT`. Without it, requests that resolve outside the configured root return `ok: false` with the failure reason and delete nothing. Default-deny on destructive disk operations outside the configured boundary. |
| `MEMORYDETECTIVE_SUPPRESS_PLATFORM_ADVISORY` | unset | Boolean (strtobool). Silences the macOS 26.x platform advisory that captureMemgraph, captureScenarioState, and bootAndLaunchForLeakInvestigation emit on first use. Also silences the v1.17 stderr warnings emitted on unrecognized boolean values (any `MEMORYDETECTIVE_*` flag) and on `schemaDiscovery` TOC fetch failures. Useful once you have an iOS 18 sim runtime installed and do not need the reminders. |
| `MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS` | unset | Boolean (strtobool). Makes `recordTimeProfile` invoke `open -a Instruments <tracePath>` as a fire-and-forget escape hatch when xctrace times out (the macOS 26.x regression). v1.17 adds a `MANIFEST.plist` viability check before opening so the auto-open path skips wedged 52K stub bundles (which would otherwise present a "Document Missing Template Error" dialog in Instruments.app). The response's `openedInInstrumentsApp` field reports whether the open was invoked; `bundleStatus` (v1.17) reports whether the bundle on disk is `unknown` / `salvageable` / `wedged`. |
| `MEMORYDETECTIVE_PREFLIGHT_XCTRACE` | unset (auto) | Boolean (strtobool) + `auto`. Controls the pre-flight probe in `recordTimeProfile` that detects the macOS 26.x xctrace wedge in ~3-5 seconds instead of paying the user's full `durationSec` plus 30s grace. Truthy forces on regardless of platform / target. Falsy forces off. When unset, the probe auto-enables on macOS 26.x simulator attach (the known-broken combo) and stays off elsewhere. Pre-flight is skipped for `--launch` mode to avoid double-launching the app. Side-effect of auto-enable: 2-second probe runs before the full recording starts. |

---

## API

**36 MCP tools + 34 Resources + 6 Prompts**, grouped by purpose. Tool descriptions are tagged with a category prefix (`[mg.memory]`, `[mg.trace]`, `[mg.build]`, `[mg.scenario]`, `[mg.code]`, `[mg.log]`, `[mg.render]`, `[mg.ci]`, `[mg.discover]`, `[ops]`, `[meta]`) so related tools are visible at a glance.

Many tools include a `suggestedNextCalls` field in their response. A typed list of `{ tool, args, why }` entries pre-populated from the current result, so the orchestrating LLM can chain calls without re-reasoning. Start with `getInvestigationPlaybook(kind)` for the canonical sequence. Or just type `/investigate-leak` (one of the [Prompts](#prompts-5)) in any client that exposes MCP slash commands.

The cycle classifier ships **36 named antipatterns** spanning SwiftUI (including the Swift 6 / `@Observable` / SwiftData / NavigationStack era, plus the v1.9 `swiftui.observable-write-on-every-render` shape), Combine, Swift Concurrency (incl. AsyncSequence-on-self and the new `Observations` API), UIKit (Timer/CADisplayLink/UIGestureRecognizer/KVO/URLSession/WebKit/DispatchSource, plus the v1.9 `uikit.viewcontroller-retained-after-pop` shape), Core Animation, Core Data, Coordinator pattern, and the popular third-party libs RxSwift + Realm. Each pattern carries:

- a textual one-line `fixHint`
- a confidence tier (`high` / `medium` / `low`)
- a `staticAnalysisHint` pointing at the SwiftLint rule that complements the runtime evidence (or an explicit gap notice when no rule exists. Reinforces the differentiator: memorydetective sees what linters miss at parse time)
- a `fixTemplate` with concrete Swift before/after snippets (new in v1.7) the agent can adapt directly to the user's code via the SourceKit-LSP source-bridging tools

### Read & analyze (14)

> All 9 trace-side analyzers below accept an optional second argument `AnalyzeTraceOptions` (v1.18 D-02). When called by `summarizeTrace` (which runs schema discovery once up front), the cache is forwarded so the per-analyzer `xctrace --toc` calls are skipped. Direct callers leave the option unset and behavior is identical to v1.17.

| Tool | What |
|---|---|
| `analyzeMemgraph` | Run `leaks` against a `.memgraph` and return summary (totals, ROOT CYCLE blocks, plain-English diagnosis). |
| `findCycles` | Extract just the ROOT CYCLE blocks as flattened chains, with optional `className` substring filter. |
| `findRetainers` | "Who is keeping `<class>` alive?". Returns retain chain paths from a top-level node down to the match. |
| `countAlive` | Count instances by class. Provide `className` for one number, or omit for top-N most-leaked classes. v1.17: configurable noise filter (`excludeFrameworkNoise`, `additionalNoisePatterns`, `unsuppressClassPatterns`, `noiseAuditMode`) so the actionable view is tunable per app. Variable-size classes report `instanceSizeBytesMin / Max / Median` (was first-observed value pre-v1.17). |
| `reachableFromCycle` | Cycle-scoped reachability. "How many `<X>` instances are reachable from the cycle rooted at `<Y>`?". Distinguishes the actual culprit from its retained dependencies. |
| `diffMemgraphs` | Compare two `.memgraph` snapshots: total deltas + class-count changes + cycles new/gone/persisted. |
| `analyzeAbandonedMemory` | Diff two `.memgraph` snapshots on heap reference-tree class counts (not cycle list) and classify each grown class as `kvo-observer-orphaned`, `notificationcenter-observer-leaked`, `cache-too-aggressive`, `singleton-retains-payload`, or `unknown-growth`. Surfaces the family of bugs `leaks(1)` reports as `leakCount: 0` because no strict cycle exists. v1.10 adds `actionableGrowth[]` + `actionableShrinkage[]` (framework-noise-filtered views) and supports `outputFormat: "verify-fix-table"` which emits a focused Class \| Before \| After \| Delta markdown table directly. |
| `verifyFix` | Cycle-semantic diff: per-pattern PASS/PARTIAL/FAIL verdict + bytes freed. CI-gateable. `expectedAliveClasses` whitelist (v1.14) carves out singletons / caches / OS-retained windows so they do not vote FAIL; v1.17 extends each entry to per-mode matching (`{ pattern, mode: "exact" \| "substring" \| "regex" }`), with bare strings keeping the substring default. |
| `classifyCycle` | Match each ROOT CYCLE against a built-in catalog of **36 named antipatterns** (SwiftUI / Combine / Concurrency / UIKit / Core Animation / Core Data / Coordinator / RxSwift / Realm) with confidence + textual `fixHint` + `staticAnalysisHint` (which SwiftLint rule complements this, or explicit gap) + `fixTemplate` (Swift before/after snippet). |
| `analyzeHangs` | Parse `xctrace` `potential-hangs` schema; return Hang vs Microhang counts + top N longest. Pass `topFramesByHangStartNs` (typically from a chained `analyzeTimeProfile` correlation) to enrich each top hang with `mainThreadViolations[]` classifying the blocker as `sync-io`, `db-lock`, `network`, or `lock-contention`. |
| `analyzeAnimationHitches` | Parse `xctrace` `animation-hitches` schema; report by-type counts and how many hitches crossed Apple's user-perceptible 100ms threshold. |
| `analyzeTimeProfile` | Parse `xctrace` `time-profile` schema; return top symbols by sample count. Reports SIGSEGV with workarounds when xctrace can't symbolicate. |
| `analyzeAllocations` | Parse `xctrace` `allocations` schema; return per-category aggregates (cumulative bytes, allocation count, lifecycle = transient/persistent/mixed) and top allocators. |
| `analyzeAppLaunch` | Parse `xctrace` `app-launch` schema; return cold/warm launch type + per-phase breakdown (process-creation, dyld-init, ObjC-init, AppDelegate, first-frame). |
| `logShow` | One-shot query of macOS unified logging via `log show --style compact` with predicate / process / subsystem filters. Returns parsed entries (timestamp, type, process, subsystem, category, message). |

### Capture / record (4)

| Tool | What | Sim | Device |
|---|---|---|---|
| `recordTimeProfile` | Wrap `xcrun xctrace record --template "Time Profiler" --attach ... --time-limit Ns --output ...`. Returns `bundleStatus: "unknown" \| "salvageable" \| "wedged"` (v1.17) so callers can branch on on-disk reality after a timeout instead of trusting the `tracePath` blindly. Auto-open path (`MEMORYDETECTIVE_AUTO_OPEN_INSTRUMENTS`) probes `MANIFEST.plist` before launching Instruments.app to skip wedged 52K stubs. | ✅ | ✅ |
| `recordViaInstrumentsApp` | macOS 26.x escape hatch (v1.16). Opens Instruments.app via `open -a Instruments`, returns an `instructions[]` array telling the user which template to pick + when to hit Record / Stop / Save, then polls `watchDir` every 5s for new `.trace` bundles (mtime-stable for 10s). v1.17: also queries running Instruments.app via AppleScript every poll for any saved document outside `watchDir`. On match, returns the path with `savedOutsideWatchDir: true` so users who hit Save and accepted the Desktop default no longer time out. Chains into `inspectTrace` on success. | ✅ | ✅ |
| `captureMemgraph` | Wrap `leaks --outputGraph <path> <pid>`. Resolves `appName → pid` via `pgrep -x`. Returns a structured `workaroundNotice` on the macOS 26.x `Failed to get DYLD info for task` regression with stable issue ids (`minimal-corpse`, `permission-denied`, `leaks-not-found`, `transient`) and a fallback path to `recordTimeProfile` (Allocations) + `analyzeAllocations`. | ✅ | ❌. Use Xcode |
| `logStream` | Wrap `log stream --style compact` for a bounded duration (≤ 60 s). Returns parsed entries collected during the window. | n/a | n/a |

### Verify-fix orchestration (3, v1.8)

These three tools combine into a single deterministic verify-fix loop: launch the app with `MallocStackLogging=1` so leaks works, drive the UI to amplify the suspected leak, snapshot before, ship the fix, snapshot after, then `diffMemgraphs`.

| Tool | What |
|---|---|
| `bootAndLaunchForLeakInvestigation` | Single-call build + boot + install + launch with `MallocStackLogging=1` propagated via `SIMCTL_CHILD_*`. Resolves the simulator (udid, name+os, or whichever is booted), discovers `BUILT_PRODUCTS_DIR` / `WRAPPER_NAME` / `EXECUTABLE_NAME` / `PRODUCT_BUNDLE_IDENTIFIER` from `xcodebuild -showBuildSettings -json`, and returns the host PID + UDID + bundle id ready to chain into `captureMemgraph`. Required because `leaks --outputGraph` regressed on macOS 26.x and only works when the target was launched with malloc-stack-logging in its environment. |
| `replayScenario` | Drive the iOS Simulator through tap / swipe / wait / type actions with a `repeat` count to amplify leaks that only manifest after N iterations. Tap targets accept `label`, `elementId`, or `coords`. Soft dependency on Cameron Cooke's [axe](https://github.com/cameroncooke/AXe) CLI. |
| `captureScenarioState` | Composite snapshot for verify-fix: writes `.memgraph` + `.png` screenshot + `.ui.json` accessibility tree into `outputDir`, all prefixed by `label` (typically `before` / `after`). Sub-captures are best-effort: if leaks fails on macOS 26.x the screenshot + UI tree still complete and the `captureMemgraph` workaroundNotice is surfaced via `memgraphWorkaroundNotice`. |

### Discover (3)

| Tool | What |
|---|---|
| `listTraceDevices` | Parse `xcrun xctrace list devices` (devices + simulators + UDIDs). |
| `listTraceTemplates` | Parse `xcrun xctrace list templates` (standard + custom). |
| `inspectTrace` | Orientation tool for `.trace` bundles. Returns schemas present + row counts + device/OS/template metadata + `suggestedNextCalls[]` mapping each populated known schema to its analyzer. Use this as the FIRST call on any `.trace`. New in v1.11. v1.17: fault-tolerant — returns `ok: true` with `schemas: []` and a diagnosis string when `xctrace export --toc` fails on wedged 52K bundles, instead of throwing. |

### Synthesize (1)

| Tool | What |
|---|---|
| `summarizeTrace` | Single call that chains `inspectTrace` + the 5 analyzers in parallel + cross-correlates findings (hangs overlapping with hitches, etc.) + pre-renders a compact (<10 KB) markdown summary card with a 1-sentence headline, per-area sub-sections, and suggestedNextCalls. The "trace-to-summary-card-in-one-call" play. Use this when you want one synthesis pass instead of chaining 5-6 analyzers manually. New in v1.13. v1.18 D-02: runs schema discovery once up front and shares the cache with all 6 analyzers, shaving 600-3000ms of wall-clock on real Apple traces. |

### Production diagnostics (1, v1.18)

| Tool | What |
|---|---|
| `analyzeMetricKitPayload` | Ingest Apple MetricKit `.mxdiagnostic` JSON payloads from real-device TestFlight / App Store builds (no MCP competitor covers this lane today). Three input forms: `payloadPath` (single file), `payloadDir` (aggregate across all `.mxdiagnostic` files in a directory), `payloadJson` (raw, in-memory). Three output sections: `crashCluster[]` (grouped by `exception-type` / `binary` / `top-frame`, each entry carries `topFrame` + `affectedBuilds[]` + raw `binaryUUID + offset` for downstream dSYM symbolication), `hangHotspots[]` (sorted by `hangDurationMs` with localized-duration parsing: `"5.4 sec"` / `"20秒"` / etc.), `cpuExceptions[]` + `diskWriteExceptions[]`. Emits 4 new `SupportStatusKind` values. Cross-tool chain hints fire automatically (`objc_release`-style top frame → `findCycles`; `libsqlite3` top frame → `analyzeHangs` with main-thread-violation classifier). NO symbolication in v1; raw bytes only. Simulator does NOT generate MetricKit payloads (Apple-side limitation); positioned as **post-mortem** analyzer, not live capture. New in v1.18. |

### Render (1)

| Tool | What |
|---|---|
| `renderCycleGraph` | Read a `.memgraph`, pick a ROOT CYCLE, and emit a Mermaid graph (markdown-embeddable) or Graphviz DOT. App-level classes highlighted in red; CYCLE BACK terminators amber. |

### Ops (1)

| Tool | What |
|---|---|
| `cleanupTraces` | Preview and delete `.trace` bundles under `MEMORYDETECTIVE_TRACE_ROOT`. `dryRun: true` by default (the agent has to opt into deletion). Stops at the `.trace` boundary (does NOT descend INTO bundles). External roots require `MEMORYDETECTIVE_ALLOW_EXTERNAL_CLEANUP=1` (default-deny). Useful as a periodic call once a few `recordTimeProfile` sessions have accumulated tens to hundreds of MB of traces. |

### CI / test integration (3)

| Tool | What |
|---|---|
| `detectLeaksInXCTest` | Build the unit-test scheme, run with an optional `-only-testing:` filter, capture `.memgraph` baseline + after against the `xctest` runner (or a custom `processName` for app-hosted bundles), diff. Returns `passed: false` when new ROOT CYCLEs appear that aren't in the user's allowlist. Set `outputHtmlPath` to also write a self-contained HTML report. CI-runnable. |
| `detectLeaksInXCUITest` | XCUITest sibling: build the workspace, run the named XCUITest, capture `.memgraph` baseline + after against the host app, diff. Returns `passed: false` when new ROOT CYCLEs appear that aren't in the user's allowlist. Set `outputHtmlPath` to also write a self-contained HTML report. CI-runnable. |
| `compareTracesByPattern` | Trace-side counterpart to `verifyFix`. Compares two `.trace` bundles for a perf category (`hangs`, `animation-hitches`, or `app-launch`) and returns PASS/PARTIAL/FAIL with before/after stats and deltas. Apply thresholds: hangs PASS when longest is below `hangsMaxLongestMs`; hitches PASS when longest is below `hitchesMaxLongestMs` (default 100ms. Apple's user-perceptible threshold); app-launch PASS when total is below `appLaunchMaxTotalMs` (default 1000ms). |

#### Add memorydetective to your CI in 5 minutes

`detectLeaksInXCTest` + `outputHtmlPath` are the building blocks for a per-PR leak gate. The job below runs the named unit-test scheme on every push and PR, uploads the HTML report as a workflow artifact, and fails when new ROOT CYCLEs appear outside the allowlist. Copy the file into `.github/workflows/leaks.yml` and adjust the workspace + scheme + test identifier:

```yaml
name: leaks
on: [push, pull_request]
jobs:
  detect-leaks:
    runs-on: macos-14
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: sudo xcode-select -s /Applications/Xcode_15.4.app
      - run: npm install -g memorydetective
      - run: |
          xcrun simctl boot "iPhone 15" || true
          xcrun simctl bootstatus "iPhone 15" -b
      - run: |
          cat > leaks.json <<EOF
          {
            "workspace": "DemoApp.xcworkspace",
            "scheme": "DemoAppTests",
            "destination": "platform=iOS Simulator,name=iPhone 15,OS=18.0",
            "testCaseFilter": "DemoTests/LeakSensitiveCase",
            "outputHtmlPath": "${GITHUB_WORKSPACE}/leak-report.html",
            "allowlistPatterns": ["SwiftUI", "_TtC"]
          }
          EOF
          memorydetective tool detectLeaksInXCTest --input leaks.json
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: leak-report
          path: leak-report.html
          retention-days: 14
```

The same file is in [`examples/ci/github-actions-leaks.yml`](examples/ci/github-actions-leaks.yml) if you want to copy it verbatim. Notes:

- **Simulator runtime:** pin to iOS 18 on `macos-14` runners. The macOS 26.x kernel regression (`task_for_pid`) breaks `leaks` against iOS 26 sims; iOS 18 is the canonical escape hatch (see the Highlights callout above).
- **Allowlist patterns:** substrings matched against the leaking ROOT CYCLE's root class. Use them to mask known pre-existing leaks while you work the backlog. `_TtC` covers Swift mangled class prefixes that occasionally show up in SwiftUI internals.
- **HTML artifact:** the report is self-contained (inline CSS, no external assets), so PR-comment bots and reviewers can preview it directly from the artifact URL.
- **Build cache:** add `actions/cache@v4` keyed on `Package.resolved` + `*.xcconfig` to skip `build-for-testing` rebuilds across runs. Then pass `--skipBuild` to the second invocation when chaining multiple `detectLeaksInXCTest` calls on the same job.

### Swift source bridging (5)

Pair the memory-graph diagnosis with source-code lookups via SourceKit-LSP. Closes the loop "found this leak in the cycle → find the file/line in your project".

| Tool | What |
|---|---|
| `swiftGetSymbolDefinition` | Locate the file:line where a Swift symbol is declared. Pre-scans `candidatePaths` (or `hint.filePath`) with a fast regex, then asks SourceKit-LSP for jump-to-definition. |
| `swiftFindSymbolReferences` | Find every reference to a Swift symbol via SourceKit-LSP `textDocument/references`. Requires an `IndexStoreDB` for cross-file results. The response carries a `needsIndex` hint when the index is missing. |
| `swiftGetSymbolsOverview` | List top-level symbols (classes, structs, enums, protocols, free functions) in a Swift file via `documentSymbol`. Cheap orientation when the agent lands in a new file. |
| `swiftGetHoverInfo` | Type info / docs at a (line, character) position. Disambiguates `self` captures: a class self in a closure can leak; a struct self can't. |
| `swiftSearchPattern` | Pure regex search over a Swift file (no LSP, no index). Catches what LSP misses: closure capture lists, `Task { ... self ... }` blocks, custom patterns from a leak chain. |

These tools require macOS + Xcode (full Xcode, not just Command Line Tools. `xcrun sourcekit-lsp` must be available). They start a `sourcekit-lsp` subprocess per project root and reuse it across calls; the subprocess shuts down after a 5-minute idle window.

> **Why `captureMemgraph` doesn't work on physical iOS devices**: `leaks(1)` only attaches to processes running on the local Mac (which includes iOS simulators). Memory Graph capture from a real device goes through Xcode's debugger over USB/lockdownd. Different mechanism, no public CLI equivalent.

### Resources (34)

The cycle-pattern catalog is also surfaced as MCP resources, browsable at `memorydetective://patterns/{patternId}`. Each resource is a markdown body with the pattern name, a longer description, and the fix hint. Use this to let an agent (or a human in a UI-aware MCP client) browse the catalog without burning a `classifyCycle` call.

```
memorydetective://patterns/swiftui.tag-index-projection
memorydetective://patterns/concurrency.async-sequence-on-self
memorydetective://patterns/webkit.wkscriptmessagehandler-bridge
memorydetective://patterns/swiftdata.modelcontext-actor-cycle
…
```

`resources/list` returns all 34 entries. `resources/read` resolves any `memorydetective://patterns/{id}` URI to its markdown body.

### Prompts (5)

Investigation playbooks are exposed as MCP prompts (slash commands in clients that surface them, e.g. Claude Code).

| Slash command | What it does | Args |
|---|---|---|
| `/investigate-leak` | Runs the canonical 6-step memgraph-leak investigation: `analyzeMemgraph` → `classifyCycle` → `reachableFromCycle` → `swiftSearchPattern` → `swiftGetSymbolDefinition` → `swiftFindSymbolReferences`. | `memgraphPath` |
| `/investigate-hangs` | Diagnose user-visible main-thread hangs from a `.trace`. | `tracePath` |
| `/investigate-jank` | Diagnose dropped frames / animation hitches from a `.trace`. | `tracePath` |
| `/investigate-launch` | Diagnose cold/warm launch slowness from a `.trace`. | `tracePath` |
| `/verify-cycle-fix` | Diff a before/after pair of `.memgraph` snapshots to confirm a fix landed. | `before`, `after` |

Each prompt fills the canonical playbook's argument templates with the user-provided values, then hands the agent a ready-to-execute brief. Calls the same tools listed in [Read & analyze](#read--analyze-14). Prompts are an orchestration shortcut, not a separate engine.

### CLI mode

The same binary is also a thin CLI for scripting and CI:

```bash
memorydetective analyze   <path-to-.memgraph>          # totals, ROOT CYCLEs, diagnosis
memorydetective classify  <path-to-.memgraph>          # match patterns + render fix hint
memorydetective tool      <toolName> --input <json>    # generic dispatcher for any MCP tool
memorydetective --help
memorydetective --version
```

When called with no arguments, the binary starts as an MCP server over stdio.

The `tool` subcommand dispatches to any registered MCP tool by name, reading inputs from a JSON file. Exit code is `0` when the tool returns `ok && passed !== false`, `1` otherwise, so it slots cleanly into CI gates. Currently supported tool names: `detectLeaksInXCTest`, `detectLeaksInXCUITest` (the [CI recipe](#add-memorydetective-to-your-ci-in-5-minutes) above uses this).

---

## Requirements

- macOS with Xcode Command Line Tools (`xcode-select --install`)
- Node.js ≥ 20

## Develop

```bash
git clone https://github.com/carloshpdoc/memorydetective
cd memorydetective
npm install
npm test                  # 546 unit tests
npm run build             # build → dist/
npm run dev               # tsx, stdio mode (dev mode)
./scripts/demo.sh         # full demo against a real .memgraph (set MEMGRAPH=path)
```

## Contributing

Contributions are welcome. Bug reports, feature requests, new cycle patterns, all of it.

- **Bugs / feature requests**: [open an issue](https://github.com/carloshpdoc/memorydetective/issues).
- **PRs**: fork → branch → `npm install` → make changes → `npm test` (546 tests must stay green) → open a PR with a concise description of what changed and why.

### Adding a cycle pattern to `classifyCycle`

`classifyCycle` ships with 36 built-in patterns covering SwiftUI (incl. Swift 6 / `@Observable` / SwiftData / NavigationStack / the v1.9 `observable-write-on-every-render` and `viewcontroller-retained-after-pop` shapes), Combine, Swift Concurrency (incl. AsyncSequence-on-self and `Observations`), UIKit (Timer / CADisplayLink / UIGestureRecognizer / KVO / URLSession / WebKit / DispatchSource), Core Animation, Core Data, the Coordinator pattern, RxSwift, and Realm. To add one:

1. Edit `src/tools/classifyCycle.ts`. Add an entry to `PATTERNS` with `id`, `name`, `fixHint`, and a `match` function.
2. Add a test in `src/tools/readTools.test.ts` that asserts the new pattern fires against a representative memgraph fixture.
3. Add a `staticAnalysisHint` entry in `src/runtime/staticAnalysisHints.ts` (the test in that file enforces 1:1 coverage with `PATTERNS`).
4. Add a `fixTemplate` entry in `src/runtime/fixTemplates.ts` (same 1:1 coverage guard).
5. Open a PR.

## Support this project

If `memorydetective` saves you time, you can support continued development:

- ☕ [Buy me a coffee](https://buymeacoffee.com/carloshperc)
- 💖 [Sponsor on GitHub](https://github.com/sponsors/carloshpdoc)

Every contribution helps keep this maintained and documented.

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Permits commercial use, modification, distribution, patent use. Includes attribution clause via the `NOTICE` file.

## Why "memorydetective"?

Hunting retain cycles in SwiftUI feels like detective work: you have a body (the leaked instance), a crime scene (the `.memgraph`), and a chain of suspects (the retain chain). The tool helps you read the evidence and name the killer. The brand follows the work.
