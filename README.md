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
- **Honest about its limits.** No mocked outputs, no over-promises. Hangs analysis works clean from `xctrace`; sample-level Time Profile still needs Instruments today (planned for v0.2). Memory Graph capture works on Mac apps and iOS simulator; physical iOS devices still need Xcode.

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
> Recorded `~/Desktop/run.trace` (90s, attached to DemoApp on iPhone 17 Pro Max). Found **23 user-visible hangs** (>500 ms each), longest 1.16 s, average 769 ms — severe load. All on the main thread. Sample-level hotspots aren't symbolicated yet; open the trace in Instruments for that step (or wait for `analyzeTimeProfile` v0.2).

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

25 MCP tools, grouped by purpose.

### Read & analyze (13)

| Tool | What |
|---|---|
| `analyzeMemgraph` | Run `leaks` against a `.memgraph` and return summary (totals, ROOT CYCLE blocks, plain-English diagnosis). |
| `findCycles` | Extract just the ROOT CYCLE blocks as flattened chains, with optional `className` substring filter. |
| `findRetainers` | "Who is keeping `<class>` alive?" — returns retain chain paths from a top-level node down to the match. |
| `countAlive` | Count instances by class. Provide `className` for one number, or omit for top-N most-leaked classes. |
| `reachableFromCycle` | Cycle-scoped reachability. "How many `<X>` instances are reachable from the cycle rooted at `<Y>`?" — distinguishes the actual culprit from its retained dependencies. |
| `diffMemgraphs` | Compare two `.memgraph` snapshots: total deltas + class-count changes + cycles new/gone/persisted. |
| `classifyCycle` | Match each ROOT CYCLE against a built-in catalog of 8 known patterns (TagIndexProjection, ForEachState, Combine sink, Task captures, NotificationCenter observer, etc.) with confidence + fix hint. |
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

### CI / test integration (1)

| Tool | What |
|---|---|
| `detectLeaksInXCUITest` | **Experimental.** Build the workspace for testing, run the named XCUITest, capture `.memgraph` baseline + after, diff. Returns `passed: false` when new ROOT CYCLEs appear that aren't in the user's allowlist. CI-runnable. |

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
- **PRs**: fork → branch → `npm install` → make changes → `npm test` (61 tests must stay green) → open a PR with a concise description of what changed and why.

### Adding a cycle pattern to `classifyCycle`

`classifyCycle` ships with 8 built-in patterns (TagIndexProjection, dict-storage WeakBox, ForEachState tap, closure-viewmodel-strong, UINavigationController host, Combine sink, Task captures, NotificationCenter observer). To add one:

1. Edit `src/tools/classifyCycle.ts` — add an entry to `PATTERNS` with `id`, `name`, `fixHint`, and a `match` function.
2. Add a test in `src/tools/readTools.test.ts` that asserts the new pattern fires against a representative memgraph fixture.
3. Open a PR.

In v0.2 the catalog moves to a separate repo so patterns can be added without modifying the server code.

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
