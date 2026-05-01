# Changelog

All notable changes to `memorydetective` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/carloshpdoc/memorydetective/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/carloshpdoc/memorydetective/releases/tag/v1.0.0
