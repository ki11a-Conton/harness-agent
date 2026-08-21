import type { AgentId, CheckpointId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { WorkingState } from "./working-state.js";
import type { ToolResultStatus } from "./tool.js";
/**
 * P1-3 Durable Checkpoint — the serializable snapshot of a turn's run state
 * at a safe boundary (after a successful side-effect tool, after compaction,
 * after a verification gate, periodically). Every consumer of "where did we
 * get to" (resume, observability, evaluation) reads this single structure.
 *
 * Integrity contract:
 * - `schemaVersion` is fixed at CHECKPOINT_SCHEMA_VERSION; readers reject
 *   records with an unsupported version (they must not be silently parsed).
 * - `checksum` is a SHA-256 over the stable-JSON of every other field, so a
 *   torn/bad write is detectable on load and must never displace the last
 *   valid checkpoint.
 */
export declare const CHECKPOINT_SCHEMA_VERSION: 1;
export interface CheckpointBudgetUsage {
    /** Context budget max tokens (when the runtime runs with a context). */
    maxTokens: number;
    /** Last observed context usage in tokens, when known. */
    usedTokens?: number;
}
/** P1-4 tool execution ledger record (plan §1277): the durable, replayable
 *  trace of an executed tool call. Resume/reconciliation policy reads it:
 *  a completed side-effect must not be blindly re-executed; an interrupt
 *  (started without a terminal outcome) enters reconciliation. */
export interface ToolExecutionRecord {
    toolCallId: ToolCallId;
    tool: string;
    /** Stable hash of the call args (structural, key-order independent). */
    argsHash: string;
    started: number;
    completed?: number;
    status: ToolResultStatus | "interrupted";
    /** Hash of the rendered result content, when produced. */
    resultHash?: string;
    /** write/edit/exec — a side effect that must not be blindly replayed. */
    sideEffect: boolean;
}
/** Compute the stable args hash used by the tool ledger (same canonical
 *  serialization as the checkpoint checksum). */
export declare function computeArgsHash(args: Record<string, unknown>): string;
/** P1-4: a tool execution that STARTED but has no terminal outcome (the
 *  process died mid-execution, or the result was lost with the crash). It
 *  must be surfaced to the model for reconciliation, never auto-replayed
 *  when `sideEffect` is true. */
export interface UnresolvedToolExecution {
    toolCallId: ToolCallId;
    tool: string;
    argsHash: string;
    started: number;
    sideEffect: boolean;
}
export interface CheckpointData {
    checkpointId: CheckpointId;
    schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
    sessionId: SessionId;
    turnId?: TurnId;
    agentId: AgentId;
    createdAt: number;
    /** Why this checkpoint was taken (tool/completion, compaction, verification,
     *  periodic). Observability + resume policy read it. */
    reason: string;
    /** Agent phase at the boundary (idle/thinking/tool_pending/observing/...). */
    phase: string;
    /** Model round-trips completed in the turn so far. */
    iteration: number;
    /** The turn's authoritative run state (P1-1, single source of truth). */
    state: WorkingState;
    budgetUsage?: CheckpointBudgetUsage;
    /** Executed tool calls in order (the P1-4 execution ledger; resume reads it
     *  to decide what may / may not be replayed). */
    toolLedger: ToolExecutionRecord[];
    /** Sessions created under this one (child delegation). */
    childSessions: SessionId[];
    /** Last event sequence persisted for the session (event store), so resume
     *  can replay only what happened after this checkpoint. */
    lastEventSequence: number;
    /** Reference to the frozen effective-agent-config snapshot key. */
    effectiveAgentConfigRef: string;
    /** Discovered instruction/skill context refs (paths/ids) at the boundary. */
    contextRefs: string[];
    /** SHA-256 over the stable-JSON of every field above (excludes this field). */
    checksum: string;
}
/** Stable JSON serialization with sorted object keys — the checksum basis.
 *  Semantics mirror JSON.stringify so a value survives a write→parse
 *  round-trip with the same checksum: object keys holding `undefined` are
 *  omitted, array `undefined` slots become `null`, BigInt is rejected and
 *  cyclic values fail explicitly. Delegates to the Q-5 canonical
 *  `stableStringify` so args/config/checkpoint hashes all share one
 *  implementation. */
export declare function stableStringifyForChecksum(value: unknown): string;
/** SHA-256 checksum over the canonical payload (every field but checksum). */
export declare function computeCheckpointChecksum(payload: Omit<CheckpointData, "checksum">): string;
/** Build a checkpoint with its integrity checksum precomputed. */
export declare function buildCheckpoint(payload: Omit<CheckpointData, "checksum">): CheckpointData;
/** P1-3: durable checkpoint persistence. Implementations must write
 *  atomically and never let a bad/torn checkpoint displace the last good one
 *  (see DurableCheckpointStore). */
export interface CheckpointStore {
    save(checkpoint: CheckpointData): Promise<void>;
    loadLatest(sessionId: SessionId): Promise<CheckpointData | undefined>;
    /** All valid checkpoints for a session, most recent first. */
    list(sessionId: SessionId): Promise<CheckpointData[]>;
}
/** Which safe boundaries take a checkpoint (P1-3). */
export interface CheckpointPolicy {
    /** After a successful side-effect tool (write/edit/exec). Default true. */
    afterSideEffectTools: boolean;
    /** After every context compaction. Default true. */
    afterCompaction: boolean;
    /** After every verification gate (passed or failed). Default true. */
    afterVerification: boolean;
    /** Periodic checkpoint every N model iterations; 0 disables. Default 5. */
    everyNIterations: number;
}
export declare const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy;
//# sourceMappingURL=checkpoint.d.ts.map