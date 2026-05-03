#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  analyzeMemgraph,
  analyzeMemgraphSchema,
} from "./tools/analyzeMemgraph.js";
import { findCycles, findCyclesSchema } from "./tools/findCycles.js";
import {
  findRetainers,
  findRetainersSchema,
} from "./tools/findRetainers.js";
import { countAlive, countAliveSchema } from "./tools/countAlive.js";
import {
  diffMemgraphs,
  diffMemgraphsSchema,
} from "./tools/diffMemgraphs.js";
import {
  classifyCycle,
  classifyCycleSchema,
} from "./tools/classifyCycle.js";
import { analyzeHangs, analyzeHangsSchema } from "./tools/analyzeHangs.js";
import {
  analyzeTimeProfile,
  analyzeTimeProfileSchema,
} from "./tools/analyzeTimeProfile.js";
import {
  listTraceDevices,
  listTraceDevicesSchema,
} from "./tools/listTraceDevices.js";
import {
  listTraceTemplates,
  listTraceTemplatesSchema,
} from "./tools/listTraceTemplates.js";
import {
  recordTimeProfile,
  recordTimeProfileShape,
} from "./tools/recordTimeProfile.js";
import {
  captureMemgraph,
  captureMemgraphShape,
} from "./tools/captureMemgraph.js";
import {
  analyzeAnimationHitches,
  analyzeAnimationHitchesSchema,
} from "./tools/analyzeAnimationHitches.js";
import {
  analyzeAllocations,
  analyzeAllocationsSchema,
} from "./tools/analyzeAllocations.js";
import {
  analyzeAppLaunch,
  analyzeAppLaunchSchema,
} from "./tools/analyzeAppLaunch.js";
import {
  renderCycleGraph,
  renderCycleGraphSchema,
} from "./tools/renderCycleGraph.js";
import {
  logShow,
  logShowSchema,
  logStream,
  logStreamSchema,
} from "./tools/logShow.js";
import {
  detectLeaksInXCUITest,
  detectLeaksInXCUITestSchema,
} from "./tools/detectLeaksInXCUITest.js";
import {
  reachableFromCycle,
  reachableFromCycleSchema,
} from "./tools/reachableFromCycle.js";
import {
  getInvestigationPlaybook,
  getInvestigationPlaybookSchema,
} from "./tools/getInvestigationPlaybook.js";
import { verifyFix, verifyFixSchema } from "./tools/verifyFix.js";
import {
  compareTracesByPattern,
  compareTracesByPatternSchema,
} from "./tools/compareTracesByPattern.js";
import {
  swiftGetSymbolDefinition,
  swiftGetSymbolDefinitionSchema,
  swiftFindSymbolReferences,
  swiftFindSymbolReferencesSchema,
  swiftGetSymbolsOverview,
  swiftGetSymbolsOverviewSchema,
  swiftGetHoverInfo,
  swiftGetHoverInfoSchema,
  swiftSearchPattern,
  swiftSearchPatternSchema,
} from "./tools/swift/index.js";

import { VERSION as SERVER_VERSION } from "./version.js";
import {
  listPatternResources,
  patternUri,
  readPatternResource,
} from "./runtime/resources.js";
import { PROMPTS, findPrompt } from "./runtime/prompts.js";
import { z } from "zod";

const SERVER_NAME = "memorydetective";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "analyzeMemgraph",
  {
    title: "Analyze a .memgraph file",
    description:
      "[mg.memory] Run `leaks(1)` against a `.memgraph` file (exported from Xcode Memory Graph Debugger) and return a structured summary: header info, totals, top-level ROOT CYCLE blocks with chain length, plain-English diagnosis. Set `fullChains: true` to also include the full nested retain forest.\n\nPipeline: → `classifyCycle` (named-antipattern + fix hint) → `reachableFromCycle` (scope blame to a single root). The response includes `suggestedNextCalls` so the agent can chain without re-reasoning.",
    inputSchema: analyzeMemgraphSchema.shape,
  },
  async (input) => {
    const result = await analyzeMemgraph(input);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "findCycles",
  {
    title: "Find ROOT CYCLE blocks in a .memgraph",
    description:
      "[mg.memory] Extract just the ROOT CYCLE blocks from a `.memgraph` as flattened chains (depth + edge + retainKind + className + address). Optionally filter to cycles touching a specific class name (substring match). Use this when you want to inspect chains without the noise of standalone leaks.",
    inputSchema: findCyclesSchema.shape,
  },
  async (input) => {
    const result = await findCycles(input);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "findRetainers",
  {
    title: "Find what retains a class",
    description:
      "[mg.memory] Walk the cycle forest from a `.memgraph` and return every retain chain that ends in a node whose className contains the given substring. Useful for answering \"who is keeping <class> alive?\". Returns paths from a top-level node down to the matching node.",
    inputSchema: findRetainersSchema.shape,
  },
  async (input) => {
    const result = await findRetainers(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "countAlive",
  {
    title: "Count instances by class",
    description:
      "[mg.memory] Count how many times each class appears in a `.memgraph`'s leaked nodes. Provide `className` (substring) for a single number, or omit it to get the top N most-leaked classes. Use this to confirm whether a fix actually reduced instance counts.",
    inputSchema: countAliveSchema.shape,
  },
  async (input) => {
    const result = await countAlive(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "diffMemgraphs",
  {
    title: "Diff two memgraph snapshots",
    description:
      "[mg.memory] Compare a baseline `.memgraph` (`before`) against a comparison `.memgraph` (`after`). Returns total leak/byte deltas, classes whose counts increased or decreased, and ROOT CYCLE signatures bucketed into newInAfter / goneFromBefore / persisted. The killer feature for verifying that a fix actually worked.",
    inputSchema: diffMemgraphsSchema.shape,
  },
  async (input) => {
    const result = await diffMemgraphs(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "classifyCycle",
  {
    title: "Classify ROOT CYCLEs against known patterns",
    description:
      "[mg.memory] Match each ROOT CYCLE against a built-in catalog of 8 known antipatterns (TagIndexProjection cycle, ForEachState retention, Combine sink-store-self, Task-without-weak-self, NotificationCenter observer, viewmodel-wrapped-strong closure, UINavigationController host, _DictionaryStorage internal). Returns `patternId`, `confidence`, and a `fixHint` per cycle.\n\nPipeline: this is the killer tool — after the result, **follow `suggestedNextCalls`** which pre-translates each match to a Swift regex (`swiftSearchPattern`) + the captured class name (`swiftGetSymbolDefinition`). Discovery is data, not inference.",
    inputSchema: classifyCycleSchema.shape,
  },
  async (input) => {
    const result = await classifyCycle(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "analyzeHangs",
  {
    title: "Analyze potential hangs from a .trace bundle",
    description:
      "[mg.trace] Run `xcrun xctrace export` against a `.trace` bundle for the `potential-hangs` schema and return aggregated stats (Hang vs Microhang counts, longest, average, total duration) plus the top N longest hangs sorted by duration. Use `minDurationMs: 250` to filter to user-visible hangs only.",
    inputSchema: analyzeHangsSchema.shape,
  },
  async (input) => {
    const result = await analyzeHangs(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "analyzeTimeProfile",
  {
    title: "Analyze a Time Profiler trace",
    description:
      "[mg.trace] Export the `time-profile` schema from a `.trace` bundle and return top symbols by sample count. Note: heavy/unsymbolicated traces may crash xctrace export — when that happens, the tool returns a `notice` field with workarounds (open in Instruments first to symbolicate, or re-record shorter).",
    inputSchema: analyzeTimeProfileSchema.shape,
  },
  async (input) => {
    const result = await analyzeTimeProfile(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "listTraceDevices",
  {
    title: "List physical devices and simulators",
    description:
      "[mg.discover] Run `xcrun xctrace list devices` and return parsed devices/simulators with their UDIDs. The LLM should call this before `recordTimeProfile` to discover the right UDID without asking the user. Set `includeOffline: true` to include disconnected devices.",
    inputSchema: listTraceDevicesSchema.shape,
  },
  async (input) => {
    const result = await listTraceDevices(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "listTraceTemplates",
  {
    title: "List xctrace recording templates",
    description:
      "[mg.discover] Run `xcrun xctrace list templates` and return parsed standard + custom templates. Useful when picking a template name for `recordTimeProfile` (e.g. \"Time Profiler\", \"Animation Hitches\", \"Allocations\").",
    inputSchema: listTraceTemplatesSchema.shape,
  },
  async (input) => {
    const result = await listTraceTemplates(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "recordTimeProfile",
  {
    title: "Record a Time Profiler trace",
    description:
      "[mg.trace] Wrapper around `xcrun xctrace record`. Capture a `.trace` bundle from a running app on a device or simulator. Required: exactly 1 of `deviceId`/`simulatorId`, exactly 1 of `attachAppName`/`attachPid`/`launchBundleId`, an `output` path ending in `.trace`. Defaults: template = \"Time Profiler\", durationSec = 90.",
    inputSchema: recordTimeProfileShape,
  },
  async (input) => {
    const result = await recordTimeProfile(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "captureMemgraph",
  {
    title: "Capture a .memgraph from a running process",
    description:
      "[mg.memory] Wrapper around `leaks --outputGraph`. Resolves `appName` to a PID via `pgrep -x` (or accepts `pid` directly), then writes a `.memgraph` snapshot. **Limitation**: only works for processes running on the local Mac (Mac apps + iOS simulator). Does NOT work for physical iOS devices — use Xcode's Memory Graph button there.",
    inputSchema: captureMemgraphShape,
  },
  async (input) => {
    const result = await captureMemgraph(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "analyzeAnimationHitches",
  {
    title: "Analyze animation hitches from a .trace bundle",
    description:
      "[mg.trace] Parse the `animation-hitches` schema from a `.trace` recorded with the Animation Hitches Instruments template. Returns hitch totals, by-type counts, longest hitches, and how many crossed the user-perceptible 100ms threshold.",
    inputSchema: analyzeAnimationHitchesSchema.shape,
  },
  async (input) => {
    const result = await analyzeAnimationHitches(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "analyzeAllocations",
  {
    title: "Analyze allocations from a .trace bundle",
    description:
      "[mg.trace] Parse the `allocations` schema from a `.trace` recorded with the Allocations Instruments template. Returns per-category aggregates (cumulative bytes, allocation count, lifecycle = transient/persistent/mixed), top allocators by size and by count, and a one-liner diagnosis identifying the dominant allocator.",
    inputSchema: analyzeAllocationsSchema.shape,
  },
  async (input) => {
    const result = await analyzeAllocations(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "analyzeAppLaunch",
  {
    title: "Analyze cold/warm launch breakdown",
    description:
      "[mg.trace] Parse the `app-launch` schema from a `.trace` recorded with the App Launch Instruments template. Returns total launch time, launch type (cold/warm), per-phase breakdown (process-creation, dyld-init, ObjC-init, AppDelegate, first-frame), and the slowest phase.",
    inputSchema: analyzeAppLaunchSchema.shape,
  },
  async (input) => {
    const result = await analyzeAppLaunch(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "renderCycleGraph",
  {
    title: "Render a retain cycle as Mermaid or DOT graph",
    description:
      "[mg.render] Read a `.memgraph`, pick a ROOT CYCLE by index, and emit the chain as a Mermaid graph definition (default — embeddable in markdown / GitHub) or a Graphviz DOT file. App-level classes are highlighted; CYCLE BACK terminators are styled distinctly. Use `cycleIndex` to render cycles other than the first.",
    inputSchema: renderCycleGraphSchema.shape,
  },
  async (input) => {
    const result = await renderCycleGraph(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "logShow",
  {
    title: "Query macOS unified logging (one-shot)",
    description:
      "[mg.log] Wrap `log show --style compact --last <window>` with optional NSPredicate filter, process and subsystem sugar. Returns parsed entries (timestamp, type, process, pid, subsystem, category, message) bounded by `maxEntries`. Use this to look back at app logs without leaving chat.",
    inputSchema: logShowSchema.shape,
  },
  async (input) => {
    const result = await logShow(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "logStream",
  {
    title: "Stream macOS unified logging for a bounded window",
    description:
      "[mg.log] Wrap `log stream --style compact` for a bounded duration (≤60 s — MCP requests should not block longer). Returns parsed entries collected during the window. Useful for capturing a specific user flow without setting up a full Console.app session.",
    inputSchema: logStreamSchema.shape,
  },
  async (input) => {
    const result = await logStream(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "detectLeaksInXCUITest",
  {
    title: "Run an XCUITest with leak detection (CI-runnable)",
    description:
      "[mg.ci] Build the workspace for testing, launch the test cycle, capture a baseline `.memgraph` once the app appears, run the test to completion, capture an after `.memgraph`, and diff. Returns `passed: false` when new ROOT CYCLE blocks appear that aren't in the `allowlistPatterns` list. Designed for CI gating — non-zero exit code on failure.",
    inputSchema: detectLeaksInXCUITestSchema.shape,
  },
  async (input) => {
    const result = await detectLeaksInXCUITest(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "reachableFromCycle",
  {
    title: "Count instances reachable from a specific cycle root",
    description:
      "[mg.memory] Cycle-scoped reachability + class counting. Answers questions like \"how many `NSURLSessionConfiguration` instances are reachable from the cycle rooted at `DetailViewModel`?\" — distinguishing the actual culprit (the cycle root) from its retained dependencies. Pick a cycle by zero-based `cycleIndex` or by `rootClassName` substring. Returns per-class counts ranked by occurrence, plus the total reachable node count.",
    inputSchema: reachableFromCycleSchema.shape,
  },
  async (input) => {
    const result = await reachableFromCycle(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "swiftGetSymbolDefinition",
  {
    title: "Locate a Swift symbol's source declaration",
    description:
      "[mg.code] Find the file:line where a Swift symbol (class, struct, enum, protocol, func, var, etc.) is declared. Pre-scans `candidatePaths` (or `hint.filePath`) with a fast regex first, then asks SourceKit-LSP for jump-to-definition. Returns the position even when LSP can't follow through. Use after `findRetainers` / `classifyCycle` surface a class name from a memgraph cycle to land in the actual source file.",
    inputSchema: swiftGetSymbolDefinitionSchema.shape,
  },
  async (input) => {
    const result = await swiftGetSymbolDefinition(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "swiftFindSymbolReferences",
  {
    title: "Find every reference to a Swift symbol",
    description:
      "[mg.code] Locates the symbol's declaration in `filePath`, then asks SourceKit-LSP for `textDocument/references`. Returns every callsite + capture across the project, with a snippet of each line. **Requires an IndexStoreDB** at `<projectRoot>/.build/index/store` for cross-file references — build it with `swift build -Xswiftc -index-store-path -Xswiftc <projectRoot>/.build/index/store`. The result includes a `needsIndex: true` hint when the index is missing.",
    inputSchema: swiftFindSymbolReferencesSchema.shape,
  },
  async (input) => {
    const result = await swiftFindSymbolReferences(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "swiftGetSymbolsOverview",
  {
    title: "List top-level symbols in a Swift file",
    description:
      "[mg.code] Cheap orientation: returns the top-level symbols (classes, structs, enums, protocols, free functions) declared in a Swift file via SourceKit-LSP's `documentSymbol`. Set `topLevelOnly: false` for nested children too. Useful right after `swiftGetSymbolDefinition` lands you in a new file.",
    inputSchema: swiftGetSymbolsOverviewSchema.shape,
  },
  async (input) => {
    const result = await swiftGetSymbolsOverview(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "swiftGetHoverInfo",
  {
    title: "Get type info / docs at a Swift source position",
    description:
      "[mg.code] SourceKit-LSP `textDocument/hover` at a (line, character) position. Returns the markdown / plaintext hover content plus a best-effort extracted declaration fragment. Use to disambiguate `self` captures: a class self in a closure can leak; a struct self can't.",
    inputSchema: swiftGetHoverInfoSchema.shape,
  },
  async (input) => {
    const result = await swiftGetHoverInfo(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "swiftSearchPattern",
  {
    title: "Regex-search a Swift file (no LSP)",
    description:
      "[mg.code] Pure regex search over a file's contents — no SourceKit-LSP, no IndexStoreDB. Catches what LSP misses: closure capture lists (`[weak self]`, `[unowned self]`), `Task { ... self ... }` blocks, and any other pattern the agent constructs from a leak chain. Returns matches with line/character positions and a trimmed snippet.",
    inputSchema: swiftSearchPatternSchema.shape,
  },
  async (input) => {
    const result = await swiftSearchPattern(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "getInvestigationPlaybook",
  {
    title: "Get the canonical tool sequence for a known investigation kind",
    description:
      "[meta] Returns a versioned, declarative pipeline for a known investigation flow (`memgraph-leak`, `perf-hangs`, `ui-jank`, `app-launch-slow`, `verify-fix`). Each step has a tool name, purpose, and argsTemplate. Use this once at the start of an investigation so any LLM agent can follow the right sequence without rediscovering it from individual tool descriptions.",
    inputSchema: getInvestigationPlaybookSchema.shape,
  },
  async (input) => {
    const result = await getInvestigationPlaybook(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "verifyFix",
  {
    title: "Verify a fix actually closed the targeted retain cycle",
    description:
      "[mg.memory] Cycle-semantic diff. Classifies both `before` and `after` `.memgraph` snapshots and emits a per-pattern PASS/PARTIAL/FAIL verdict plus bytes freed and instances released. Use as a CI gate: if `expectedPatternId` is provided, `expectedPatternVerdict` tells you in one field whether the fix landed.\n\nPipeline: this is the natural followup to `classifyCycle` after you've shipped a fix. Capture a fresh `.memgraph`, point this at the before/after pair.",
    inputSchema: verifyFixSchema.shape,
  },
  async (input) => {
    const result = await verifyFix(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "compareTracesByPattern",
  {
    title: "Compare before/after .trace bundles for a perf regression target",
    description:
      "[mg.trace][mg.ci] Trace-side counterpart to `verifyFix`. Compares two `.trace` bundles for a specific perf category (`hangs`, `animation-hitches`, or `app-launch`) and emits a PASS/PARTIAL/FAIL verdict plus before/after stats and deltas. Apply thresholds: hangs PASS when longest is below `hangsMaxLongestMs` (default 0); hitches PASS when longest is below `hitchesMaxLongestMs` (default 100ms — Apple's user-perceptible threshold); app-launch PASS when total is below `appLaunchMaxTotalMs` (default 1000ms).\n\nPipeline: capture before/after `.trace` (via `recordTimeProfile` or Xcode), then point this at the pair. The natural followup to a hangs/jank/launch fix PR.",
    inputSchema: compareTracesByPatternSchema.shape,
  },
  async (input) => {
    const result = await compareTracesByPattern(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// MCP Resources — the cycle-pattern catalog as browsable URIs
// ─────────────────────────────────────────────────────────────────────────────

for (const res of listPatternResources()) {
  server.registerResource(
    res.name,
    res.uri,
    {
      title: res.name,
      description: res.description,
      mimeType: res.mimeType,
    },
    async (uri) => {
      const body = readPatternResource(uri.href);
      if (!body) {
        throw new Error(`Unknown resource URI: ${uri.href}`);
      }
      return {
        contents: [
          {
            uri: body.uri,
            mimeType: body.mimeType,
            text: body.text,
          },
        ],
      };
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Prompts — investigation playbooks as named slash commands
// ─────────────────────────────────────────────────────────────────────────────

for (const prompt of PROMPTS) {
  const argsSchema: Record<string, z.ZodString> = {};
  for (const arg of prompt.arguments) {
    let schema = z.string().describe(arg.description);
    if (!arg.required) {
      // Optional args still represented as strings; leave required-ness to
      // the prompt definition. (MCP SDK v1.x supports optional via .optional()
      // but our prompts are all-required for now.)
    }
    argsSchema[arg.name] = schema;
  }
  server.registerPrompt(
    prompt.name,
    {
      title: prompt.title,
      description: prompt.description,
      argsSchema,
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: prompt.render(args as Record<string, string>),
          },
        },
      ],
    }),
  );
}

async function main() {
  // CLI mode: when called with arguments, run the synchronous CLI wrapper.
  // No arguments → start the MCP server over stdio (the default and the
  // primary interface).
  if (process.argv.length > 2) {
    const { runCli } = await import("./cli.js");
    const code = await runCli(process.argv.slice(2));
    process.exit(code);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
