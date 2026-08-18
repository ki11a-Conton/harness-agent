// @ar/context public surface.

// CTX-001: hierarchical instruction discovery.
export { HierarchicalInstructionDiscovery } from "./discovery.js";
export type { InstructionDiscoveryOptions, DiscoveredInstruction } from "@ar/contracts";

// CTX-002: budget planning.
export { BudgetPlannerImpl } from "./budget.js";

// CTX-003: context compaction.
export { DefaultCompactor, isCompactable } from "./compaction.js";

// LOOP-001: full-agent-loop context pipeline (discovery + budget + compaction).
export { ContextPipeline, estimateMessageTokens } from "./pipeline.js";
export type {
  ContextPipelineDeps,
  ContextPipelineResult,
  ContextPipelineBuildOptions,
} from "./pipeline.js";
