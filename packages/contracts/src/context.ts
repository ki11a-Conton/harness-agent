import type { ContextBudget, ContextReport } from "./limits.js";

export type ContextSource =
  | "system"
  | "user"
  | "project"
  | "local"
  | "skill"
  | "memory"
  | "tool"
  | "web"
  | "mcp"
  | "subagent";

export type TrustLevel = "trusted" | "semi-trusted" | "untrusted";

/** P17-4: ONE context taxonomy — every context block belongs to exactly one
 *  category, and every category has a fixed, encoded profile of
 *  priority / compressible / persistable / trust / rehydratable. Consumers
 *  (budget planner, compactor, memory extraction, rehydration) key on the
 *  category, never on ad-hoc per-block flags. */
export type ContextCategory =
  /** User hard constraints, effective policy summary, current goal. NEVER
   *  compacted, never dropped, always rehydrated. */
  | "protected-instruction"
  /** Plan / pending / decisions / files changed / unresolved tool calls.
   *  Structural run state — survives compaction via the WorkingState digest. */
  | "working-state"
  /** Memory / selected skill / project instructions. Semi-trusted data. */
  | "knowledge"
  /** Tool / verification results. Compressible, evidence, not persistable. */
  | "evidence"
  /** Progress / temporary observations. Cheap to drop first. */
  | "ephemeral";

/** P17-4: the fixed profile of each context category. */
export interface ContextCategorySpec {
  /** Budget-planning priority (higher = kept first on overflow). */
  defaultPriority: number;
  /** May this category's blocks be compacted? */
  compressible: boolean;
  /** May this category's content persist into memory/learning? */
  persistable: boolean;
  /** Trust floor of this category. */
  trust: TrustLevel;
  /** Must this category's content be rehydrated after compaction? */
  rehydratable: boolean;
}

/** P17-4: the single encoded taxonomy — one row per category, used by every
 *  consumer. A block whose `category` is absent defaults to "evidence" (the
 *  most conservative data-only row). */
export const CONTEXT_CATEGORY_SPECS: Record<ContextCategory, ContextCategorySpec> = {
  "protected-instruction": {
    defaultPriority: Number.MAX_SAFE_INTEGER,
    compressible: false,
    persistable: false, // instructions are NOT memory; they are re-derivable
    trust: "trusted",
    rehydratable: true,
  },
  "working-state": {
    defaultPriority: 5000,
    compressible: true, // via the structured WorkingState digest, never lossy
    persistable: false, // runtime state, not memory
    trust: "trusted",
    rehydratable: true,
  },
  knowledge: {
    defaultPriority: 1000,
    compressible: true, // skill bodies / memory entries are re-retrievable
    persistable: true, // knowledge IS the memory surface (gate-checked)
    trust: "semi-trusted",
    rehydratable: true, // re-selected on demand
  },
  evidence: {
    defaultPriority: 100,
    compressible: true,
    persistable: false,
    trust: "semi-trusted",
    rehydratable: false, // tool/verification results are not re-injected wholesale
  },
  ephemeral: {
    defaultPriority: 10,
    compressible: true,
    persistable: false,
    trust: "semi-trusted",
    rehydratable: false,
  },
};

/** P17-4: the conservative default for blocks without an explicit category. */
export const DEFAULT_CONTEXT_CATEGORY: ContextCategory = "evidence";

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
  /** P17-4: the block's taxonomy category. Absent → DEFAULT_CONTEXT_CATEGORY
   *  ("evidence"). Consumers read the category's fixed spec — never ad-hoc. */
  category?: ContextCategory;
  /** P2-21: provenance is preserved when content enters the context. */
  provenance?: ContextBlockProvenance;
  /** P14-5: whether this block is AUTHORITATIVE instruction (system prompt,
   *  user hard constraints, runtime-owned state) vs DATA ONLY. Untrusted /
   *  semi-trusted blocks are NEVER instructional — a missing flag means data.
   *  Consumers (trust-boundary prompt, memory extraction, compaction) rely on
   *  this to keep untrusted content from upgrading into instructions. */
  instructional?: boolean;
  /** P14-5: whether this block's content may be persisted into memory /
   *  learning. Untrusted data is never persistable (memory-pollution gate,
   *  P17-2); absent = not persistable. */
  persistable?: boolean;
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

export const NEVER_COMPACT_SOURCES: ReadonlySet<string> = new Set([
  "system",
  "user",
]);

// ---- P3 (CTX-001 / CTX-002 / CTX-003) extension surfaces --------------------

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

/** Compaction: replace compressible blocks with a structured summary (CTX-003).
 *  P17-5: the production implementation is the MultiStageCompactor; the
 *  interface permits async stages (LLM summary / reactive fallback hooks). */
export interface Compactor {
  compact(blocks: ContextBlock[], summary: CompactionSummary): ContextBlock[] | Promise<ContextBlock[]>;
}