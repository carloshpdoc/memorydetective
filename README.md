# memorydetective

> Diagnose iOS retain cycles and performance regressions from your chat window — no Xcode required.

[![npm](https://img.shields.io/npm/v/memorydetective.svg)](https://www.npmjs.com/package/memorydetective)
[![CI](https://github.com/carloshpdoc/memorydetective/actions/workflows/ci.yml/badge.svg)](https://github.com/carloshpdoc/memorydetective/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/carloshpdoc/memorydetective?style=flat&logo=github)](https://github.com/carloshpdoc/memorydetective/stargazers)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#requirements)

![demo](./examples/demo.gif)

## Highlights

- **CLI-driven leak hunting.** Read `.memgraph` files captured by Xcode (or by `memorydetective` itself on simulators), find ROOT CYCLEs, classify them against known SwiftUI/Combine patterns, and get a one-liner fix hint — all from a script or a chat.
- **MCP-native.** Plugs into Claude Code, Claude Desktop, Cursor, Cline, and any other MCP client. The agent drives the full investigate → classify → suggest-fix loop without you opening Instruments.
- **Honest about its limits.** No mocked outputs, no over-promises. Hangs analysis works clean from `xctrace`; sample-level Time Profile is parsed when `xctrace` symbolicates the trace and returns a structured workaround notice when it can't (the underlying `xctrace` SIGSEGV on heavy unsymbolicated traces is an Apple-side limitation we surface explicitly). Memory Graph capture works on Mac apps and iOS simulator; physical iOS devices still need Xcode.

> **What's new in v1.7** (2026-05-03): catalog grew from 33 to **34 cycle patterns** (`swiftdata.modelcontext-actor-cycle` for the SwiftData `@Actor` pattern), every classification now carries a **`fixTemplate` field** with concrete Swift before/after snippets the agent can adapt directly, and a new **`compareTracesByPattern` tool** does for `.trace` bundles what `verifyFix` does for memgraphs — PASS/PARTIAL/FAIL verdicts on hangs / animation-hitches / app-launch regressions. 27 → 28 MCP tools.
>
> **Also in v1.6** (same day): catalog 27 → 33, MCP Resources + Prompts surface, and the original `staticAnalysisHint` field. Full notes in [CHANGELOG](./CHANGELOG.md).

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

> **You:** I just exported a memory graph at `~/Desktop/example.memgraph`. Something's leaking after I close a detail screen — what is it?
>
> **Claude:** *(calls `analyzeMemgraph` → `classifyCycle`)*
> Found 4 ROOT CYCLE blocks across 60,436 leaks. The dominant one matches **swiftui.tag-index-projection** with high confidence — a closure attached via `.tag()` on a photo carousel `ForEach` is capturing `self` strongly through `_viewModel.wrappedValue`, which keeps `DetailViewModel` and the navigation coordinator alive after dismissal.
>
> **Suggested fix:** replace `[weak self]` capture in the tap handler with a static helper, or weak-capture the view-model via `[weak coord = self.coordinator]`. Want me to find the exact file?

### Verify a fix actually worked

> **You:** I shipped the fix. Compare `~/Desktop/before.memgraph` to `~/Desktop/after.memgraph` and tell me whether `DetailViewModel` count dropped.
>
> **Claude:** *(calls `diffMemgraphs` → `countAlive`)*
> `DetailViewModel`: **12 → 0** (delta `-12`). The `swiftui.tag-index-projection` cycle is gone. Total leak count fell from 60,436 to 55,576 (−4,860). Three other ROOT CYCLEs persist — they're SwiftUI internals, not your code.

### Find the slow path on a real device

> **You:** Profile DemoApp on my iPhone for 90 seconds and tell me where the hangs are.
>
> **Claude:** *(calls `listTraceDevices` → `recordTimeProfile` → `analyzeHangs`)*
> Recorded `~/Desktop/run.trace` (90s, attached to DemoApp on iPhone 17 Pro Max). Found **23 user-visible hangs** (>500 ms each), longest 1.16 s, average 769 ms — severe load. All on the main thread. Sample-level hotspots aren't symbolicated yet; open the trace in Instruments for that step (`analyzeTimeProfile` returns a structured workaround notice when `xctrace` can't symbolicate — see CHANGELOG known limits).

### End-to-end: leak → file → fix suggestion

The full loop, from artifact to code edit. Combines memory-graph analysis with Swift source-bridging.

> **You:** Tem um leak. Memgraph em `~/Desktop/example-leaks.memgraph`. The cycle points at `DetailViewModel`. Find where it lives in the project `~/Development/myapp/` and suggest a fix.
>
> **Claude:** *(calls `analyzeMemgraph` → `classifyCycle` → `reachableFromCycle`)*
> Found **4 ROOT CYCLE blocks**. The dominant one matches `swiftui.tag-index-projection` with high confidence. `reachableFromCycle` confirms 4 `DetailViewModel` instances pinning ~1100 `NSURLSessionConfiguration`s each — the VM is the culprit, the network stack is collateral.
>
> *(calls `swiftSearchPattern` to locate `.tag(` + `onImageSliderTap` patterns in `~/Development/myapp/Sources/`)*
> 1 match in `MyApp/Views/MediaCarousel.swift:142`.
>
> *(calls `swiftGetSymbolDefinition({ symbolName: "DetailViewModel", projectRoot: "...", candidatePaths: ["MyApp/ViewModels/"] })`)*
> Declared at `MyApp/ViewModels/DetailViewModel.swift:18` — `class DetailViewModel: ObservableObject`.
>
> *(calls `swiftFindSymbolReferences` to scope the blast radius — 7 callsites)*
>
> **Suggested fix at `MediaCarousel.swift:142`:**
> ```swift
> // before
> .tag(index)
> .onImageSliderTap { index in
>     self.viewModel.handlePhotoTap(at: index)
> }
>
> // after — static helper + weak captures
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

A real-world retain-cycle investigation, run twice — once with `memorydetective`, once with the agent reading the raw `leaks(1)` output directly:

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

- **Tiny memgraphs** (a single cycle, < 50 KB raw): MCP overhead is roughly token-neutral vs. raw read. The dev-time win still holds (no manual cycle parsing) but the token win shrinks.
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

Copilot's MCP integration moves fast — if this snippet is stale, see the [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

</details>

---

## API

**28 MCP tools + 34 Resources + 5 Prompts**, grouped by purpose. Tool descriptions are tagged with a category prefix (`[mg.memory]`, `[mg.trace]`, `[mg.code]`, `[mg.log]`, `[mg.render]`, `[mg.ci]`, `[mg.discover]`, `[meta]`) so related tools are visible at a glance.

Many tools include a `suggestedNextCalls` field in their response — a typed list of `{ tool, args, why }` entries pre-populated from the current result, so the orchestrating LLM can chain calls without re-reasoning. Start with `getInvestigationPlaybook(kind)` for the canonical sequence — or just type `/investigate-leak` (one of the [Prompts](#prompts-5)) in any client that exposes MCP slash commands.

The cycle classifier ships **34 named antipatterns** spanning SwiftUI (including the Swift 6 / `@Observable` / SwiftData / NavigationStack era), Combine, Swift Concurrency (incl. AsyncSequence-on-self and the new `Observations` API), UIKit (Timer/CADisplayLink/UIGestureRecognizer/KVO/URLSession/WebKit/DispatchSource), Core Animation, Core Data, Coordinator pattern, and the popular third-party libs RxSwift + Realm. Each pattern carries:

- a textual one-line `fixHint`
- a confidence tier (`high` / `medium` / `low`)
- a `staticAnalysisHint` pointing at the SwiftLint rule that complements the runtime evidence (or an explicit gap notice when no rule exists — reinforces the differentiator: memorydetective sees what linters miss at parse time)
- a `fixTemplate` with concrete Swift before/after snippets (new in v1.7) the agent can adapt directly to the user's code via the SourceKit-LSP source-bridging tools

### Read & analyze (13)

| Tool | What |
|---|---|
| `analyzeMemgraph` | Run `leaks` against a `.memgraph` and return summary (totals, ROOT CYCLE blocks, plain-English diagnosis). |
| `findCycles` | Extract just the ROOT CYCLE blocks as flattened chains, with optional `className` substring filter. |
| `findRetainers` | "Who is keeping `<class>` alive?" — returns retain chain paths from a top-level node down to the match. |
| `countAlive` | Count instances by class. Provide `className` for one number, or omit for top-N most-leaked classes. |
| `reachableFromCycle` | Cycle-scoped reachability. "How many `<X>` instances are reachable from the cycle rooted at `<Y>`?" — distinguishes the actual culprit from its retained dependencies. |
| `diffMemgraphs` | Compare two `.memgraph` snapshots: total deltas + class-count changes + cycles new/gone/persisted. |
| `verifyFix` | Cycle-semantic diff: per-pattern PASS/PARTIAL/FAIL verdict + bytes freed. CI-gateable. |
| `classifyCycle` | Match each ROOT CYCLE against a built-in catalog of **34 named antipatterns** (SwiftUI / Combine / Concurrency / UIKit / Core Animation / Core Data / Coordinator / RxSwift / Realm) with confidence + textual `fixHint` + `staticAnalysisHint` (which SwiftLint rule complements this, or explicit gap) + `fixTemplate` (Swift before/after snippet). |
| `analyzeHangs` | Parse `xctrace` `potential-hangs` schema; return Hang vs Microhang counts + top N longest. |
| `analyzeAnimationHitches` | Parse `xctrace` `animation-hitches` schema; report by-type counts and how many hitches crossed Apple's user-perceptible 100ms threshold. |
| `analyzeTimeProfile` | Parse `xctrace` `time-profile` schema; return top symbols by sample count. Reports SIGSEGV with workarounds when xctrace can't symbolicate. |
| `analyzeAllocations` | Parse `xctrace` `allocations` schema; return per-category aggregates (cumulative bytes, allocation count, lifecycle = transient/persistent/mixed) and top allocators. |
| `analyzeAppLaunch` | Parse `xctrace` `app-launch` schema; return cold/warm launch type + per-phase breakdown (process-creation, dyld-init, ObjC-init, AppDelegate, first-frame). |
| `logShow` | One-shot query of macOS unified logging via `log show --style compact` with predicate / process / subsystem filters. Returns parsed entries (timestamp, type, process, subsystem, category, message). |

### Capture / record (3)

| Tool | What | Sim | Device |
|---|---|---|---|
| `recordTimeProfile` | Wrap `xcrun xctrace record --template "Time Profiler" --attach ... --time-limit Ns --output ...`. | ✅ | ✅ |
| `captureMemgraph` | Wrap `leaks --outputGraph <path> <pid>`. Resolves `appName → pid` via `pgrep -x`. | ✅ | ❌ — use Xcode |
| `logStream` | Wrap `log stream --style compact` for a bounded duration (≤ 60 s). Returns parsed entries collected during the window. | n/a | n/a |

### Discover (2)

| Tool | What |
|---|---|
| `listTraceDevices` | Parse `xcrun xctrace list devices` (devices + simulators + UDIDs). |
| `listTraceTemplates` | Parse `xcrun xctrace list templates` (standard + custom). |

### Render (1)

| Tool | What |
|---|---|
| `renderCycleGraph` | Read a `.memgraph`, pick a ROOT CYCLE, and emit a Mermaid graph (markdown-embeddable) or Graphviz DOT. App-level classes highlighted in red; CYCLE BACK terminators amber. |

### CI / test integration (2)

| Tool | What |
|---|---|
| `detectLeaksInXCUITest` | **Experimental.** Build the workspace for testing, run the named XCUITest, capture `.memgraph` baseline + after, diff. Returns `passed: false` when new ROOT CYCLEs appear that aren't in the user's allowlist. CI-runnable. |
| `compareTracesByPattern` | Trace-side counterpart to `verifyFix`. Compares two `.trace` bundles for a perf category (`hangs`, `animation-hitches`, or `app-launch`) and returns PASS/PARTIAL/FAIL with before/after stats and deltas. Apply thresholds: hangs PASS when longest is below `hangsMaxLongestMs`; hitches PASS when longest is below `hitchesMaxLongestMs` (default 100ms — Apple's user-perceptible threshold); app-launch PASS when total is below `appLaunchMaxTotalMs` (default 1000ms). |

### Swift source bridging (5)

Pair the memory-graph diagnosis with source-code lookups via SourceKit-LSP. Closes the loop "found this leak in the cycle → find the file/line in your project".

| Tool | What |
|---|---|
| `swiftGetSymbolDefinition` | Locate the file:line where a Swift symbol is declared. Pre-scans `candidatePaths` (or `hint.filePath`) with a fast regex, then asks SourceKit-LSP for jump-to-definition. |
| `swiftFindSymbolReferences` | Find every reference to a Swift symbol via SourceKit-LSP `textDocument/references`. Requires an `IndexStoreDB` for cross-file results — the response carries a `needsIndex` hint when the index is missing. |
| `swiftGetSymbolsOverview` | List top-level symbols (classes, structs, enums, protocols, free functions) in a Swift file via `documentSymbol`. Cheap orientation when the agent lands in a new file. |
| `swiftGetHoverInfo` | Type info / docs at a (line, character) position. Disambiguates `self` captures: a class self in a closure can leak; a struct self can't. |
| `swiftSearchPattern` | Pure regex search over a Swift file (no LSP, no index). Catches what LSP misses: closure capture lists, `Task { ... self ... }` blocks, custom patterns from a leak chain. |

These tools require macOS + Xcode (full Xcode, not just Command Line Tools — `xcrun sourcekit-lsp` must be available). They start a `sourcekit-lsp` subprocess per project root and reuse it across calls; the subprocess shuts down after a 5-minute idle window.

> **Why `captureMemgraph` doesn't work on physical iOS devices**: `leaks(1)` only attaches to processes running on the local Mac (which includes iOS simulators). Memory Graph capture from a real device goes through Xcode's debugger over USB/lockdownd — different mechanism, no public CLI equivalent.

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

Each prompt fills the canonical playbook's argument templates with the user-provided values, then hands the agent a ready-to-execute brief. Calls the same tools listed in [Read & analyze](#read--analyze-13) — prompts are an orchestration shortcut, not a separate engine.

### CLI mode

The same binary is also a thin CLI for scripting and CI:

```bash
memorydetective analyze   <path-to-.memgraph>    # totals, ROOT CYCLEs, diagnosis
memorydetective classify  <path-to-.memgraph>    # match patterns + render fix hint
memorydetective --help
memorydetective --version
```

When called with no arguments, the binary starts as an MCP server over stdio.

---

## Requirements

- macOS with Xcode Command Line Tools (`xcode-select --install`)
- Node.js ≥ 20

## Develop

```bash
git clone https://github.com/carloshpdoc/memorydetective
cd memorydetective
npm install
npm test                  # 61 unit tests
npm run build             # build → dist/
npm run dev               # tsx, stdio mode (dev mode)
./scripts/demo.sh         # full demo against a real .memgraph (set MEMGRAPH=path)
```

## Contributing

Contributions are welcome — bug reports, feature requests, new cycle patterns, all of it.

- **Bugs / feature requests**: [open an issue](https://github.com/carloshpdoc/memorydetective/issues).
- **PRs**: fork → branch → `npm install` → make changes → `npm test` (206 tests must stay green) → open a PR with a concise description of what changed and why.

### Adding a cycle pattern to `classifyCycle`

`classifyCycle` ships with 34 built-in patterns covering SwiftUI (incl. Swift 6 / `@Observable` / SwiftData / NavigationStack), Combine, Swift Concurrency (incl. AsyncSequence-on-self and `Observations`), UIKit (Timer / CADisplayLink / UIGestureRecognizer / KVO / URLSession / WebKit / DispatchSource), Core Animation, Core Data, the Coordinator pattern, RxSwift, and Realm. To add one:

1. Edit `src/tools/classifyCycle.ts` — add an entry to `PATTERNS` with `id`, `name`, `fixHint`, and a `match` function.
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

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Permits commercial use, modification, distribution, patent use. Includes attribution clause via the `NOTICE` file.

## Why "memorydetective"?

Hunting retain cycles in SwiftUI feels like detective work: you have a body (the leaked instance), a crime scene (the `.memgraph`), and a chain of suspects (the retain chain). The tool helps you read the evidence and name the killer. The brand follows the work.
