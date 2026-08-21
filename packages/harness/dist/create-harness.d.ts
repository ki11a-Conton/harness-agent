import { type AgentDefinition, type ApprovalStore, type ArtifactStore, type AskUserStore, type CheckpointStore, type ContextBudget, type EventStore, type InboxStore, type MemoryScope, type MemoryStore, type MemoryType, type SessionStore } from "@ar/contracts";
import { AgentRuntime } from "@ar/core";
import { ContextPipeline } from "@ar/context";
import { type RetrieveResult } from "@ar/memory";
import { SessionService } from "@ar/session";
import { ToolRegistry } from "@ar/tools";
import { AgentExecutionScheduler, Delegator } from "@ar/agents";
import { type HarnessConfig, type HarnessFeatureFlags, type HarnessProfile } from "./config.js";
import type { HarnessIntrospection } from "./introspection.js";
import { MemoryRuntimeBridge } from "./memory-runtime-bridge.js";
import { PostTurnReflector } from "./reflection-runner.js";
import { type LearningCandidateStore } from "./candidate-store.js";
import { type SkillBodyBlockProvider } from "./skill-context.js";
/** Tool profile shared by every production harness (plan.md P0-5 single
 *  source: packages/tools/src/production-tools.ts). ask_user is a core
 *  runtime phase — ASK_GATE_TOOL — and must NOT be registered as a
 *  ToolDefinition. */
export declare const PRODUCTION_TOOL_NAMES: readonly ["read_file", "write_file", "edit_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot", "exec", "update_plan"];
export declare const READONLY_TOOL_NAMES: readonly ["read_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot"];
/** Minimal memory bridge for P0-3: store creation + retrieval. The full
 *  pre-turn injection bridge (context blocks from memory) is P2-1. */
export interface MemoryBridge {
    store: MemoryStore;
    retrieve(query: string, scope: MemoryScope, opts?: {
        k?: number;
        type?: MemoryType;
    }): Promise<RetrieveResult>;
}
export interface Harness {
    runtime: AgentRuntime;
    store: SessionStore;
    events: EventStore;
    registry: ToolRegistry;
    sessionService: SessionService;
    agents: AgentDefinition[];
    memory?: MemoryBridge;
    scheduler?: AgentExecutionScheduler;
    delegator?: Delegator;
    /** P2-1: full pre-turn memory bridge (retrieve → context blocks → feedback). */
    memoryBridge?: MemoryRuntimeBridge;
    /** P2-6: durable learning-candidate queue (reflection output, pre-promotion). */
    candidates?: LearningCandidateStore;
    /** P2-5: post-turn reflection runner (journal + candidate queue). */
    reflector?: PostTurnReflector;
    /** P2-8: skill body provider (progressive disclosure + effectiveness). */
    skillBodies?: SkillBodyBlockProvider;
    /** P0-3: real MCP transports connected at harness creation. */
    mcp?: {
        servers: number;
        tools: string[];
    };
    approvalStore: ApprovalStore;
    inbox: InboxStore;
    askUserStore?: AskUserStore;
    checkpointStore?: CheckpointStore;
    artifactStore?: ArtifactStore;
    context: {
        pipeline: ContextPipeline;
        budget: ContextBudget;
        /** True when the model's context window was unknown and the conservative
         *  fallback budget was used (audit/doctor should surface a warning). */
        budgetFallback: boolean;
    };
    profile: HarnessProfile;
    config: HarnessConfig;
    introspect(): HarnessIntrospection;
    close(): Promise<void>;
}
export declare const DEFAULT_MAIN_SYSTEM_PROMPT: string;
export declare function createHarness(config: HarnessConfig): Promise<Harness>;
/**
 * Context budget from the model's known capabilities; conservative fallback
 * when unknown (plan.md P0-4: never hardcode 32000 when capability known).
 * The fallback decision is surfaced for doctor/audit.
 */
export declare function resolveContextBudget(config: HarnessConfig): Promise<{
    budget: ContextBudget;
    budgetFallback: boolean;
}>;
interface IntrospectionInput {
    profile: string;
    registry: ToolRegistry;
    store: SessionStore;
    events: EventStore;
    approvalStore: ApprovalStore;
    checkpointStore?: CheckpointStore;
    artifactStore?: ArtifactStore;
    memoryStore?: MemoryStore;
    features: HarnessFeatureFlags;
    delegator?: Delegator;
    scheduler?: AgentExecutionScheduler;
    mcpTools?: string[];
    mcpServers?: number;
}
/** Honest wiring facts: store implementations by constructor name, registered
 *  tool names, and feature flags — exactly what P0-1's audit consumes. */
export declare function introspectHarness(input: IntrospectionInput): HarnessIntrospection;
export {};
//# sourceMappingURL=create-harness.d.ts.map