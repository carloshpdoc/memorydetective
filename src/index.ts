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

const SERVER_NAME = "memorydetective";
const SERVER_VERSION = "0.1.0-dev";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "analyzeMemgraph",
  {
    title: "Analyze a .memgraph file",
    description:
      "Run `leaks(1)` against a `.memgraph` file (exported from Xcode Memory Graph Debugger) and return a structured summary: header info, totals, top-level ROOT CYCLE blocks with chain length, and a plain-English diagnosis. Set `fullChains: true` to also include the full nested retain forest.",
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
      "Extract just the ROOT CYCLE blocks from a `.memgraph` as flattened chains (depth + edge + retainKind + className + address). Optionally filter to cycles touching a specific class name (substring match). Use this when you want to inspect chains without the noise of standalone leaks.",
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
      "Walk the cycle forest from a `.memgraph` and return every retain chain that ends in a node whose className contains the given substring. Useful for answering \"who is keeping <class> alive?\". Returns paths from a top-level node down to the matching node.",
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
      "Count how many times each class appears in a `.memgraph`'s leaked nodes. Provide `className` (substring) for a single number, or omit it to get the top N most-leaked classes. Use this to confirm whether a fix actually reduced instance counts.",
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
      "Compare a baseline `.memgraph` (`before`) against a comparison `.memgraph` (`after`). Returns total leak/byte deltas, classes whose counts increased or decreased, and ROOT CYCLE signatures bucketed into newInAfter / goneFromBefore / persisted. The killer feature for verifying that a fix actually worked.",
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
      "For each ROOT CYCLE in a `.memgraph`, match against a built-in catalog of known SwiftUI/Combine patterns (TagIndexProjection cycle, _DictionaryStorage internal cycle, ForEachState retention, closure capturing _viewModel.wrappedValue strongly, UINavigationController host cycle). Returns patternId, confidence, and a one-line fixHint. v0.1 uses an in-process catalog; v0.2 will pull from a remote signature catalog.",
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
      "Run `xcrun xctrace export` against a `.trace` bundle for the `potential-hangs` schema and return aggregated stats (Hang vs Microhang counts, longest, average, total duration) plus the top N longest hangs sorted by duration. Use `minDurationMs: 250` to filter to user-visible hangs only.",
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
      "Export the `time-profile` schema from a `.trace` bundle and return top symbols by sample count. Note: heavy/unsymbolicated traces may crash xctrace export — when that happens, the tool returns a `notice` field with workarounds (open in Instruments first to symbolicate, or re-record shorter).",
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
      "Run `xcrun xctrace list devices` and return parsed devices/simulators with their UDIDs. The LLM should call this before `recordTimeProfile` to discover the right UDID without asking the user. Set `includeOffline: true` to include disconnected devices.",
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
      "Run `xcrun xctrace list templates` and return parsed standard + custom templates. Useful when picking a template name for `recordTimeProfile` (e.g. \"Time Profiler\", \"Animation Hitches\", \"Allocations\").",
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
      "Wrapper around `xcrun xctrace record`. Capture a `.trace` bundle from a running app on a device or simulator. Required: exactly 1 of `deviceId`/`simulatorId`, exactly 1 of `attachAppName`/`attachPid`/`launchBundleId`, an `output` path ending in `.trace`. Defaults: template = \"Time Profiler\", durationSec = 90.",
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
      "Wrapper around `leaks --outputGraph`. Resolves `appName` to a PID via `pgrep -x` (or accepts `pid` directly), then writes a `.memgraph` snapshot. **Limitation**: only works for processes running on the local Mac (Mac apps + iOS simulator). Does NOT work for physical iOS devices — use Xcode's Memory Graph button there.",
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
      "Parse the `animation-hitches` schema from a `.trace` recorded with the Animation Hitches Instruments template. Returns hitch totals, by-type counts, longest hitches, and how many crossed the user-perceptible 100ms threshold.",
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
      "Parse the `allocations` schema from a `.trace` recorded with the Allocations Instruments template. Returns per-category aggregates (cumulative bytes, allocation count, lifecycle = transient/persistent/mixed), top allocators by size and by count, and a one-liner diagnosis identifying the dominant allocator.",
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
      "Parse the `app-launch` schema from a `.trace` recorded with the App Launch Instruments template. Returns total launch time, launch type (cold/warm), per-phase breakdown (process-creation, dyld-init, ObjC-init, AppDelegate, first-frame), and the slowest phase.",
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
      "Read a `.memgraph`, pick a ROOT CYCLE by index, and emit the chain as a Mermaid graph definition (default — embeddable in markdown / GitHub) or a Graphviz DOT file. App-level classes are highlighted; CYCLE BACK terminators are styled distinctly. Use `cycleIndex` to render cycles other than the first.",
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
      "Wrap `log show --style compact --last <window>` with optional NSPredicate filter, process and subsystem sugar. Returns parsed entries (timestamp, type, process, pid, subsystem, category, message) bounded by `maxEntries`. Use this to look back at app logs without leaving chat.",
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
      "Wrap `log stream --style compact` for a bounded duration (≤60 s — MCP requests should not block longer). Returns parsed entries collected during the window. Useful for capturing a specific user flow without setting up a full Console.app session.",
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
      "Build the workspace for testing, launch the test cycle, capture a baseline `.memgraph` once the app appears, run the test to completion, capture an after `.memgraph`, and diff. Returns `passed: false` when new ROOT CYCLE blocks appear that aren't in the `allowlistPatterns` list. Designed for CI gating — non-zero exit code on failure.",
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
      "Cycle-scoped reachability + class counting. Answers questions like \"how many `NSURLSessionConfiguration` instances are reachable from the cycle rooted at `DetailViewModel`?\" — distinguishing the actual culprit (the cycle root) from its retained dependencies. Pick a cycle by zero-based `cycleIndex` or by `rootClassName` substring. Returns per-class counts ranked by occurrence, plus the total reachable node count.",
    inputSchema: reachableFromCycleSchema.shape,
  },
  async (input) => {
    const result = await reachableFromCycle(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

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
