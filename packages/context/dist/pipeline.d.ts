import type { BudgetPlanner, CompactionSummary, Compactor, ContextBlock, ContextBudget, ContextReport, DiscoveredInstruction, InstructionDiscovery, InstructionDiscoveryOptions } from "@ar/contracts";
import { type TokenEstimator } from "./tokenizer.js";
export interface ContextPipelineDeps {
    /** Default: new HierarchicalInstructionDiscovery(). */
    discovery?: InstructionDiscovery;
    /** Default: new BudgetPlannerImpl(). */
    planner?: BudgetPlanner;
    /** Default: new DefaultCompactor(). */
    compactor?: Compactor;
    /** P6-3: per-build selection telemetry (candidate/selected/dropped/
     *  compacted). The pipeline only reports facts — emitting context.* events
     *  is the runtime's job (it owns the EventStore). */
    onTelemetry?: (event: ContextTelemetryEvent) => void;
    /** P6-5: token estimator; default HeuristicTokenEstimator (~4 bytes/token).
     *  Hosts with a real provider tokenizer inject it here. */
    tokenEstimator?: TokenEstimator;
}
/** P6-3: one observable selection fact per build. `reason` explains a drop
 *  ("injection" | "budget") or a quarantine ("injection:quarantined"). The
 *  session id is attached by build() from the build options so the host can
 *  route the event into the right event stream. */
export interface ContextTelemetryEvent {
    sessionId?: string;
    phase: "candidate" | "selected" | "dropped" | "compacted";
    source: string;
    id?: string;
    priority?: number;
    tokens: number;
    reason?: string;
}
/** P0-8: a low-trust content source rejected for prompt injection during
 *  context assembly. The runtime turns each entry into a
 *  security.injection_denied event; the content itself never becomes a block. */
export type ContextInjectionSource = "project" | "skill" | "tool" | "memory" | "web" | "mcp" | "subagent";
export interface ContextInjection {
    id: string;
    source: ContextInjectionSource;
    reasons: string[];
}
export interface ContextPipelineResult {
    /** Final blocks for the runtime to splice into the system prompt. */
    blocks: ContextBlock[];
    /** Budget report for this build (used/available/dropped/compressed). */
    report: ContextReport;
    /** Whether compaction ran in this build. */
    compacted: boolean;
    /** The summary block when compacted (runtime traceability). */
    summary?: ContextBlock;
    /** Raw discovery results (debugging/recording). */
    discovered: DiscoveredInstruction[];
    /** P0-8: low-trust sources rejected for prompt injection (never became
     *  blocks). Empty when every source passed the boundary check. */
    injected: ContextInjection[];
}
export interface ContextPipelineBuildOptions {
    cwd: string;
    /** System prompt; becomes a system source block, semantically never compactable. */
    systemPrompt: string;
    /** Skill index discovered by the host (Task 3): one block per skill, wedged
     *  between the system block and the project instruction blocks. */
    skills?: readonly {
        name: string;
        description: string;
    }[];
    /** Process blocks accumulated across loop turns (tool results etc.). */
    priorBlocks: ContextBlock[];
    budget: ContextBudget;
    /** Passed through to the discovery step. */
    instructionOpts?: InstructionDiscoveryOptions;
    /**
     * Message history of the turn (Phase 8). Its token estimate is accounted
     * into the budget report (`report.messagesTokens`) so the runtime can
     * observe and trim it — but the messages are NOT part of the system-prompt
     * blocks and never admitted/compacted here.
     */
    messages?: readonly {
        role: string;
        content: string;
    }[];
    /** P1-2: what must survive compaction, supplied by the host's working
     *  state. The pipeline only decides *when* to compact, *which* blocks to
     *  retain and the budget — it never synthesizes summary content. When a
     *  build overflows without an override, `build` rejects (fail-closed)
     *  instead of guessing; the runtime passes the WorkingState-derived
     *  summary on every turn. */
    summaryOverride?: CompactionSummary;
    /** P6-3: session owning this build — attached to every telemetry event so
     *  the host can emit context.* events into the right stream. */
    telemetrySessionId?: string;
    /** P6-1 (EXPERIMENT): instead of dropping an injection-carrying DATA block
     *  (tool/memory/mcp/subagent/web/skill), wrap it in a quarantine envelope
     *  so the model can still analyze hostile text as data. Authoritative
     *  channels (system/user) and project instruction docs are NEVER enveloped
     *  — they stay fail-closed (an untrusted file must not fake its way into
     *  policy). Secrets/binary are still dropped before this point by the host.
     *  Default false = today's fail-closed drop. */
    quarantineInjection?: boolean;
}
/**
 * Token estimate of a message history (Phase 8): per-message overhead plus
 * the content bytes. Shared by the pipeline (accounting) and the runtime
 * (trimming) so both use the same yardstick.
 */
export declare function estimateMessageTokens(messages: readonly {
    role: string;
    content: string;
}[]): number;
/**
 * LOOP-001 — full-agent-loop context pipeline (CTX-001/002/003 assembly).
 *
 * Per model call the runtime calls `build` once: discovery produces project
 * instruction blocks, the system prompt is prepended as a system block, prior
 * loop blocks are merged, the budget planner admits what fits, and when the
 * budget overflows the compressible prior blocks are folded into a single
 * summary block so the loop stays sustainable.
 *
 * I/O discipline: only side effect is the async discovery step (file reads).
 * Planner and compactor are pure; discovery errors (invalid cwd) propagate to
 * the caller untouched.
 */
export declare class ContextPipeline {
    private readonly discovery;
    private readonly planner;
    private readonly compactor;
    private readonly onTelemetry?;
    private readonly tokenEstimator;
    constructor(deps?: ContextPipelineDeps);
    private telemetry;
    /** P6-5: token counting through the injected estimator. */
    private estimateTokens;
    build(opts: ContextPipelineBuildOptions): Promise<ContextPipelineResult>;
}
//# sourceMappingURL=pipeline.d.ts.map