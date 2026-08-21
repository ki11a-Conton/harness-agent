import type { ContextBudget, ContextReport } from "./limits.js";
export type ContextSource = "system" | "user" | "project" | "local" | "skill" | "memory" | "tool" | "web" | "mcp" | "subagent";
export type TrustLevel = "trusted" | "semi-trusted" | "untrusted";
/** P2-21: provenance attached to context blocks (e.g. MCP results). */
export interface ContextBlockProvenance {
    kind: string;
    /** Identity of the originating subsystem (e.g. MCP server id). */
    serviceId: string;
    /** Specific tool/entity id within that service (e.g. MCP tool name). */
    toolId: string;
    /** Version or schema hash of the producing entity. */
    version?: string;
    trust: TrustLevel;
    networkBoundary?: NetworkBoundary;
}
/** P2-21: where an MCP result originated on the network. */
export type NetworkBoundary = "loopback" | "lan" | "internet" | "unknown";
export interface ContextBlock {
    id: string;
    source: ContextSource;
    trust: TrustLevel;
    priority: number;
    tokens: number;
    content: string;
    compressible: boolean;
    ephemeral: boolean;
    scope?: string;
    path?: string;
    timestamp?: number;
    /** P2-21: provenance is preserved when content enters the context. */
    provenance?: ContextBlockProvenance;
}
export interface ContextSnapshot {
    blocks: ContextBlock[];
    budget: ContextBudget;
    report: ContextReport;
}
export interface CompactionSummary {
    goal: string;
    constraints: string[];
    decisions: string[];
    /** Completed work items (P1-2: must survive compaction). */
    completed: string[];
    filesChanged: string[];
    commandsRun: string[];
    tests: string[];
    failures: string[];
    openTasks: string[];
    importantFacts: string[];
    /** Artifact references (paths) produced during the run (P1-2: must survive). */
    artifactRefs: string[];
    /** Child-agent (subagent) session references (P1-2: must survive). */
    childAgentRefs: string[];
}
export declare const NEVER_COMPACT_SOURCES: ReadonlySet<string>;
/** One discovered instruction document (CTX-001: hierachical AGENTS.md). */
export interface DiscoveredInstruction {
    path: string;
    scope: "root" | "nested" | "cwd";
    sizeBytes: number;
    content: string;
    /** True when the document was truncated to honor the size budget (warning). */
    truncated: boolean;
    detectedAt: number;
}
export interface InstructionDiscoveryOptions {
    /** Per-document content budget in bytes; a larger file is truncated + flagged. */
    maxBytesPerFile?: number;
    /** Maximum number of documents returned (smallest scope first, except root first). */
    maxDocuments?: number;
}
export interface InstructionDiscovery {
    discover(cwd: string, opts?: InstructionDiscoveryOptions): Promise<DiscoveredInstruction[]>;
}
/** Budget planner result: chosen blocks + what was dropped (CTX-002). */
export interface BudgetPlan {
    selected: ContextBlock[];
    dropped: ContextBlock[];
    report: ContextReport;
}
export interface BudgetPlanner {
    plan(blocks: ContextBlock[], budget: ContextBudget): BudgetPlan;
}
/** Compaction: replace compressible blocks with a structured summary (CTX-003). */
export interface Compactor {
    compact(blocks: ContextBlock[], summary: CompactionSummary): ContextBlock[];
}
//# sourceMappingURL=context.d.ts.map