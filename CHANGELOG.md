# Changelog

All notable changes to `memorydetective` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/carloshpdoc/memorydetective/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/carloshpdoc/memorydetective/releases/tag/v1.0.0
