// @ar/context public surface.

// CTX-001: hierarchical instruction discovery.
export { HierarchicalInstructionDiscovery } from "./discovery.js";
export type { InstructionDiscoveryOptions, DiscoveredInstruction } from "@ar/contracts";

// CTX-002: budget planning.
export { BudgetPlannerImpl } from "./budget.js";

// CTX-003: context compaction.
export { DefaultCompactor, isCompactable, MultiStageCompactor, previewMarker, protectedFieldsMissing } from "./compaction.js";
export type { CompactionStageReport, MultiStageCompactorOptions, ProtectedFacts } from "./compaction.js";
export { buildRehydrationBlocks } from "./rehydration.js";
export { CompactionCircuitBreaker } from "./circuit-breaker.js";
export type { BreakerState, CompactionCircuitBreakerOptions, CompactionMetrics } from "./circuit-breaker.js";
export type { RehydrationOptions } from "./rehydration.js";

// LOOP-001: full-agent-loop context pipeline (discovery + budget + compaction).
export { ContextPipeline, estimateMessageTokens } from "./pipeline.js";
export type {
  ContextPipelineDeps,
  ContextPipelineResult,
  ContextPipelineBuildOptions,
} from "./pipeline.js";

// P2-16: versioned system-prompt / runtime-rule registry with rollback.
export { PromptVersionRegistry, hashRuleContent, RuleVersionError } from "./prompt-versioning.js";
export type {
  VersionedRule,
  ProvisionRuleInput,
  RuleChangeEvidence,
} from "./prompt-versioning.js";

// P2-17: versioned policy-config registry (retry/compaction/scheduler/... ) with rollback + trace.
export { PolicyConfigRegistry, hashPolicyConfig, stableSerializeConfig, PolicyVersionError } from "./policy-versioning.js";
export type { PolicyVersion, ProvisionPolicyConfig } from "./policy-versioning.js";
export { HeuristicTokenEstimator, DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";
export type { TokenEstimator } from "./tokenizer.js";
