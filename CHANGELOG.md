# Changelog

All notable changes to `memorydetective` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/carloshpdoc/memorydetective/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/carloshpdoc/memorydetective/releases/tag/v1.0.0
