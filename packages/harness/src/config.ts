import type {
  ContextBudget,
  ModelProvider,
  ModelRef,
  PermissionPolicy,
  RunLimits,
  SandboxPolicy,
  McpServerConfig,
} from "@ar/contracts";
import type { MemoryScope, MemoryType } from "@ar/contracts";

/** Feature toggles of the production composition root (plan.md P0-3). */
export interface HarnessFeatureFlags {
  context: boolean;
  checkpoint: boolean;
  artifacts: boolean;
  memory: boolean;
  learning: boolean;
  skills: boolean;
  delegation: boolean;
  mcp: boolean;
  plugins: boolean;
  observability: boolean;
}

export type HarnessProfile = "interactive" | "batch" | "benchmark" | "test";

export interface HarnessMemoryConfig {
  enabled: boolean;
  /** SQLite store when provided; JSONL store otherwise. */
  dbPath?: string;
  scope?: MemoryScope;
  topK?: number;
}

export interface HarnessDelegationConfig {
  enabled: boolean;
  maxGlobalAgents?: number;
  maxAgentsPerRoot?: number;
  maxDepth?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
}

export interface HarnessConfig {
  cwd: string;
  dataDir?: string;

  profile: HarnessProfile;

  modelProvider: ModelProvider;
  model: ModelRef;

  featureFlags?: Partial<HarnessFeatureFlags>;
  limits?: Partial<RunLimits>;

  memory?: HarnessMemoryConfig;
  delegation?: HarnessDelegationConfig;

  /** Explicit budget wins over capability-derived budget. */
  contextBudget?: ContextBudget;

  /** MCP server configs are accepted and exposed, but connecting them is
   *  deferred (no ToolDefinition bridge exists yet — plan P0-8+). */
  mcp?: McpServerConfig[];
}

export const DEFAULT_FEATURE_FLAGS: HarnessFeatureFlags = {
  context: true,
  checkpoint: true,
  artifacts: true,
  memory: false,
  learning: false,
  skills: true,
  delegation: false,
  mcp: false,
  plugins: false,
  observability: true,
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: 32_000,
  reserved: { system: 1_500, task: 2_000, output: 2_000 },
  dynamic: 0,
};