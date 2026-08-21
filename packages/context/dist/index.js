// @ar/context public surface.
// CTX-001: hierarchical instruction discovery.
export { HierarchicalInstructionDiscovery } from "./discovery.js";
// CTX-002: budget planning.
export { BudgetPlannerImpl } from "./budget.js";
// CTX-003: context compaction.
export { DefaultCompactor, isCompactable } from "./compaction.js";
// LOOP-001: full-agent-loop context pipeline (discovery + budget + compaction).
export { ContextPipeline, estimateMessageTokens } from "./pipeline.js";
// P2-16: versioned system-prompt / runtime-rule registry with rollback.
export { PromptVersionRegistry, hashRuleContent, RuleVersionError } from "./prompt-versioning.js";
// P2-17: versioned policy-config registry (retry/compaction/scheduler/... ) with rollback + trace.
export { PolicyConfigRegistry, hashPolicyConfig, stableSerializeConfig, PolicyVersionError } from "./policy-versioning.js";
export { HeuristicTokenEstimator, DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";
//# sourceMappingURL=index.js.map