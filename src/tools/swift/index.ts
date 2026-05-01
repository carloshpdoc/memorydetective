/**
 * Swift source-bridging tools. Pair with the memory-graph tools so the
 * LLM agent can go from "found this leak in the cycle" to "find it in the
 * codebase" without leaving chat.
 *
 * One tool per file, all backed by a shared SourceKit-LSP client pool
 * (`src/runtime/sourcekit/`). This file is purely a re-export aggregator
 * for callers that want a single import point.
 */

export {
  swiftGetSymbolDefinition,
  swiftGetSymbolDefinitionSchema,
  type SwiftGetSymbolDefinitionInput,
  type SwiftGetSymbolDefinitionResult,
} from "./getSymbolDefinition.js";

export {
  swiftFindSymbolReferences,
  swiftFindSymbolReferencesSchema,
  type SwiftFindSymbolReferencesInput,
  type SwiftFindSymbolReferencesResult,
} from "./findSymbolReferences.js";

export {
  swiftGetSymbolsOverview,
  swiftGetSymbolsOverviewSchema,
  type SwiftGetSymbolsOverviewInput,
  type SwiftGetSymbolsOverviewResult,
} from "./getSymbolsOverview.js";

export {
  swiftGetHoverInfo,
  swiftGetHoverInfoSchema,
  type SwiftGetHoverInfoInput,
  type SwiftGetHoverInfoResult,
} from "./getHoverInfo.js";

export {
  swiftSearchPattern,
  swiftSearchPatternSchema,
  type SwiftSearchPatternInput,
  type SwiftSearchPatternResult,
  type SwiftSearchPatternMatch,
} from "./searchPattern.js";
