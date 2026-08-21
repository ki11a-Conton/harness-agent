/**
 * Q-1: context pipeline + steering injection + tool-output rendering extracted
 * from runtime.ts. Owns buildContext (skill/instruction discovery, system
 * prompt assembly, auto-compact, message-history trim, overflow check),
 * injectSteeringPrompts (exactly-once steer admission), and
 * renderToolResultForContext (budget/artifact/redaction/injection scan).
 *
 * Method bodies are byte-for-byte the ones that lived on AgentRuntime — the
 * only change is `this.<field>` → `this.deps.<field>`, plus `checkpoint` /
 * `finishTurn` arriving as injected functions bound to the runtime (so this
 * controller never imports runtime.ts / recovery controllers directly).
 * `compactCounter` is shared BY REFERENCE: it is the runtime-owned mutable
 * compaction count the model-call controller also increments.
 */
import { errorInfo } from "@ar/contracts";
import type { AgentDefinition, AgentEvent, ArtifactStore, CheckpointBudgetUsage, ContextBlock, ContextBudget, InboxStore, Message, SessionId, SessionStore, Skill, SkillIndexEntry, TerminationReason, ToolCall, ToolExecutionRecord, ToolResult, ToolSemantics, Turn, TurnId, WorkingState } from "@ar/contracts";
import type { ContextPipeline, InstructionDiscoveryOptions } from "@ar/context";
import { AgentState } from "../state/agent-state.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import type { FaultPoint, FaultPointContext, SkillDiscovery, TurnContext, TurnOutcome, TurnOutcomeStatus } from "./turn-helpers.js";
/** Q-1: result of buildContext — either proceed with updated context state
 *  or finish the turn on overflow. */
export type ContextUpdate = {
    action: "proceed";
    history: Message[];
    system: string;
    lastReportTokens: number | undefined;
    digestAppended: boolean;
    overflowAttempt: number;
} | {
    action: "finish";
    outcome: TurnOutcome;
};
/** Q-1: everything ContextController needs from the runtime. All fields are
 *  read-only bindings captured at construction; `compactCounter` is the single
 *  shared mutable compaction count (also incremented by the model-call
 *  controller's reactive compaction). */
export interface ContextControllerDeps {
    store: SessionStore;
    emit: (sessionId: SessionId, type: AgentEvent["type"], payload: Record<string, unknown>, turnId?: TurnId, spans?: {
        spanId?: string;
        parentSpanId?: string;
    }) => Promise<AgentEvent>;
    now: () => number;
    failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
    context?: {
        pipeline: ContextPipeline;
        budget: ContextBudget;
        instructionOpts?: InstructionDiscoveryOptions;
    };
    skills?: () => Skill[] | SkillDiscovery | Promise<Skill[] | SkillDiscovery>;
    skillSelector?: (entries: SkillIndexEntry[]) => SkillIndexEntry[];
    /** P2-8: loads the body of the skills selected by `skillSelector` as
     *  semi-trusted context blocks (progressive disclosure: index → selection
     *  → body load → context). Receives the turn identity and selected names;
     *  the returned blocks are admitted into the pipeline ahead of tool output.
     *  Absent by default (index-only skills). */
    skillBodyBlocks?: (input: {
        sessionId: SessionId;
        turnId: TurnId;
        names: string[];
    }) => Promise<ContextBlock[]>;
    recovery?: RecoveryPolicy;
    compactCounter: {
        value: number;
    };
    checkpoint: (ctx: TurnContext, working: WorkingState, state: AgentState, toolLedger: ToolExecutionRecord[], reason: string, budgetUsage?: CheckpointBudgetUsage) => Promise<void>;
    finishTurn: (ctx: TurnContext, status: TurnOutcomeStatus, state: AgentState, working: WorkingState, error?: ReturnType<typeof errorInfo>, terminationReason?: TerminationReason, ledger?: ToolExecutionRecord[]) => Promise<TurnOutcome>;
    toolOutputBudget?: {
        maxInlineBytes: number;
        artifactDir?: string;
    };
    outputRedactor?: (content: string) => {
        content: string;
        redacted: number;
    };
    artifactStore?: ArtifactStore;
    semanticsOf: (name: string) => ToolSemantics;
    injectionDetector?: (content: string) => {
        hasInjection: boolean;
        reasons: string[];
    };
    inbox?: InboxStore;
}
export declare class ContextController {
    private readonly deps;
    constructor(deps: ContextControllerDeps);
    /**
     * Q-1: context pipeline + compaction + overflow check extracted from
     * runTurn. Handles: context build (skill/instruction discovery, security
     * events), system prompt assembly, auto-compact, message-history trim,
     * context overflow check. Returns ContextUpdate — proceed with updated
     * state or finish on overflow.
     */
    buildContext(ctx: TurnContext, agent: AgentDefinition, turn: Turn, working: WorkingState, priorBlocks: ContextBlock[], state: AgentState, toolLedger: ToolExecutionRecord[], history: Message[], _system: string, lastReportTokens: number | undefined, digestAppended: boolean, overflowAttempt: number, reactiveCompacted: boolean): Promise<ContextUpdate>;
    /**
     * Q-1: steering prompt injection extracted from runTurn. User steering
     * admitted while the turn is running lands here — the safe boundary
     * before the model call — as a user message. Exactly-once: checks history
     * for already-appended promptId and reconciles to consumed if found.
     * Returns the (possibly refreshed) message history.
     */
    injectSteeringPrompts(ctx: TurnContext, history: Message[]): Promise<Message[]>;
    renderToolResultForContext(ctx: TurnContext, call: ToolCall, result: ToolResult): Promise<string>;
}
//# sourceMappingURL=context-controller.d.ts.map