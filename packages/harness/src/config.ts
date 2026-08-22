import type {
  ContextBudget,
  ModelProvider,
  ModelRef,
  PermissionPolicy,
  RunLimits,
  SandboxPolicy,
  McpServerConfig,
  SkillIndexEntry,
  TaskSpec,
  VerificationSpec,
  Verifier,
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

export type HarnessProfile = "interactive" | "batch" | "benchmark" | "test" | "ephemeral" | "champion";

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
  /** P16-5: injected wall-clock for the composition root. Every event the
   *  harness appends uses THIS clock (defaults to Date.now). Tests inject a
   *  deterministic clock so event timestamps/ordering are reproducible. */
  now?: () => number;

  /** P5-3: runtime store backend for a persistent dataDir. `jsonl` (default)
   *  uses the JSONL session/event/inbox/ask/checkpoint stores; `sqlite` uses
   *  one SqliteRuntimeStore (WAL) for all five contracts. Memory keeps its
   *  own DB either way. */
  dataStore?: "jsonl" | "sqlite";

  profile: HarnessProfile;

  modelProvider: ModelProvider;
  model: ModelRef;

  featureFlags?: Partial<HarnessFeatureFlags>;
  limits?: Partial<RunLimits>;

  /** Overrides the profile's default sandbox policy. Needed to admit real
   *  network access for http MCP tools (the default sandbox denies network;
   *  stdio MCP is local IPC and does not need this). */
  sandboxPolicy?: SandboxPolicy;

  memory?: HarnessMemoryConfig;
  delegation?: HarnessDelegationConfig;

  /** Explicit budget wins over capability-derived budget. */
  contextBudget?: ContextBudget;

  /** P2-8: skill index pruning before injection (progressive disclosure:
   *  index → selection → body on demand). Receives the metadata rows and
   *  returns the subset to inject. Default: identity (all skills indexed). */
  skillSelector?: (entries: SkillIndexEntry[]) => SkillIndexEntry[];

  /** P7-1/P7-2: progressive tool disclosure — a ToolSelector narrows the
   *  tool schemas advertised to the model per goal. Default: identity (every
   *  schema advertised, pre-P7 behavior). */
  toolSelector?: import("@ar/core").ToolSelector;

  /**
   * MCP server configs. When present (or the mcp feature flag is on), the
   * harness CONNECTS each server over its real transport (http → JSON-RPC
   * over fetch, stdio → spawned child process), adapts the advertised tools
   * into the registry and exposes them to the main agent. A server whose
   * tool descriptions carry prompt-injection material is rejected
   * fail-closed at registration (P0-8). Connection failures abort harness
   * creation — a misconfigured server is never silently dropped.
   */
  mcp?: McpServerConfig[];

  /**
   * Task whose verification specs gate completion (P8-1). When set, the
   * harness wires a TaskVerifier AND a verification plan builder: a task with
   * no declared specs gets an auto-orchestrated plan derived from the change
   * set + discovered commands (buildVerificationPlan). Explicit specs win.
   */
  task?: TaskSpec;
  verification?: {
    /** Plan builder override. Default: buildVerificationPlan consuming the
     *  P7-6 command discovery hints. */
    planner?: (input: {
      task: TaskSpec;
      changedPaths: string[];
      cwd: string;
    }) => VerificationSpec[] | Promise<VerificationSpec[]>;
    /** Verifier override. Default: TaskVerifier emitting
     *  verification.step_started/step_completed events (P8-2). */
    verifier?: Verifier;
  };
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