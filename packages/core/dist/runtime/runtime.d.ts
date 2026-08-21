import type { AgentDefinition, AgentId, ArtifactStore, ContextBlock, ContextBudget, EventStore, InboxStore, ModelProvider, SandboxPolicy, Session, SessionId, SessionStore, Skill, SkillIndexEntry, TaskSpec, ToolCapability, ToolOrchestrator, ToolSemantics, ToolSpec, Turn, TurnId, VerificationSpec, Verifier } from "@ar/contracts";
import { AdaptiveRecoveryPlanner } from "@ar/contracts";
import type { CheckpointPolicy, CheckpointStore, WorkingState, StallPattern, AskUserRequest, AskUserReply, AskUserStore, AskUserLifecycle, AskId, Timer } from "@ar/contracts";
import type { ContextPipeline, InstructionDiscoveryOptions } from "@ar/context";
import type { ToolSelector } from "../tools/tool-selector.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { buildResumePrompt, renderToolResult } from "./turn-helpers.js";
import type { FaultPoint, FaultPointContext, ResumeResult, SkillDiscovery, TurnOutcome } from "./turn-helpers.js";
export { defaultSandboxPolicy, RuntimeKilledError, ASK_GATE_TOOL, TRUST_BOUNDARY_PROMPT } from "./turn-helpers.js";
export type { FaultPoint, FaultPointContext, TurnOutcome, TurnOutcomeStatus, TurnOutcomeDetail, ResumeResult, SkillSecurityDenialRecord, SkillDiscovery } from "./turn-helpers.js";
export interface AgentRuntimeDeps {
    store: SessionStore;
    events: EventStore;
    modelProvider: ModelProvider;
    orchestrator: ToolOrchestrator;
    agents: AgentDefinition[];
    hooks?: HookRegistry;
    maxIterationsPerTurn?: number;
    /** Stall detection (plan.md Phase 2): kill the turn after this many
     *  consecutive identical tool calls (same name+args). Default 3; set 0 to
     *  disable. */
    maxRepeatedIdenticalToolCalls?: number;
    /** Stall recovery (retry taxonomy kind "stallRecovery", Phase 11): before
     *  terminating a stalled turn, the runtime may recover this many times —
     *  resetting the streak and injecting a system observation so the model can
     *  change strategy. Default 1; set 0 for the pre-Phase-11 behavior
     *  (terminate on the first streak). */
    maxStallRecoveries?: number;
    /** P2-41 stall detection V2: extra non-identical stall PATTERNS to detect
     *  beyond the legacy identical-call gate (alternating A->B->A->B loop,
     *  repeated error, unchanged repeated reads, verification fix loop,
     *  no-progress churn). These each have their own bounded budget below.
     *  Default: all patterns EXCEPT `identical_tool` (that case is already
     *  governed by maxRepeatedIdenticalToolCalls). Set [] to disable the
     *  pattern classifier entirely and keep only the legacy gate. */
    enabledStallPatterns?: readonly StallPattern[];
    /** P2-41: how many pattern-based stalls may be recovered (like
     *  `maxStallRecoveries`, but for the non-identical patterns) before the
     *  turn is terminated. Default 1. */
    maxPatternStallRecoveries?: number;
    /** Verification circuit breaker (plan.md Phase 4/7): when the model stops
     *  and the verification gate fails, the runtime injects a structured
     *  failure observation and continues the loop — at most this many times.
     *  Default 3; set 0 to fail the turn on the first failed gate (pre-Phase-4
     *  behavior). */
    maxVerificationFailures?: number;
    /** Concurrency (plan.md Phase 3.3): at most this many consecutive
     *  concurrency-safe (read-only) tool calls run in parallel per iteration.
     *  Default 4; set 0/1 to force serial execution. Writes and unknown tools
     *  always run serially, and results are appended in call order. */
    maxParallelToolCalls?: number;
    /** Capability lookup for retry gating and concurrency planning (plan.md
     *  Phase 3.2/3.6). Defaults to conservative "unknown"/serial. */
    toolCapabilityOf?: (toolName: string) => ToolCapability;
    /** P1-11: full execution-semantics lookup. Replaces name-based hardcodes
     *  (side-effect/checkpoint/resume decisions follow semantics, not tool
     *  names). When unset, a built-in registry keeps the historical behavior
     *  for write_file/edit_file/exec; unknown tools are conservatively
     *  side-effect-free. */
    toolSemanticsOf?: (toolName: string) => ToolSemantics;
    /** Tool Output Budget (plan.md Phase 4/5 Stage 0): tool results whose
     *  rendered output exceeds `maxInlineBytes` are written to an artifact file
     *  under `artifactDir` and replaced in the message trail by a preview +
     *  sha256 + path. Without `artifactDir` the result is truncated inline with
     *  a marker. Default: no budget (inline everything, orchestrator-level cap
     *  still applies). */
    toolOutputBudget?: {
        maxInlineBytes: number;
        artifactDir?: string;
    };
    /** P1-12: durable registry for offloaded tool outputs. When set, every
     *  artifact written under `toolOutputBudget.artifactDir` is registered with
     *  an id (never a bare path) as its identity, plus mime/bytes/sha256/
     *  sensitivity/retention. Consumers (compaction, resume, verification,
     *  observability, cleanup) query by id/session/hash. */
    artifactStore?: ArtifactStore;
    /** P0-7: secret redaction applied to tool output before it crosses
     *  boundaries (artifact files, inline message content). Returns the
     *  redacted content and how many secret spans were replaced; when more
     *  than zero, a security.secret_redacted event is emitted. Absent by
     *  default (identity — the host decides when redaction is required). */
    outputRedactor?: (content: string) => {
        content: string;
        redacted: number;
    };
    /** P0-8: prompt-injection scan for untrusted content (rendered tool
     *  output). On a hit the content is withheld (fail-closed) and a
     *  security.injection_denied event is emitted. Absent by default (no
     *  detection — the host decides which detector to wire). */
    injectionDetector?: (content: string) => {
        hasInjection: boolean;
        reasons: string[];
    };
    /** Session inbox (plan.md Issue 3 / Phase 5.3): pending `steer` prompts are
     *  injected into the running turn before the next model call (safe
     *  boundary); `followup` prompts are left for the host's outer loop. */
    inbox?: InboxStore;
    now?: () => number;
    /** Q-7: injectable timer for retry-backoff sleeps. Defaults to a `RealTimer`
     *  bound to `now`, so tests can drive backoff deterministically without a real
     *  wall-clock wait. */
    timer?: Timer;
    sandboxPolicy?: SandboxPolicy;
    /** LOOP-001: context pipeline (discovery → budget → compaction) run before
     *  every model call; when absent the loop runs without a context budget. */
    context?: {
        pipeline: ContextPipeline;
        budget: ContextBudget;
        instructionOpts?: InstructionDiscoveryOptions;
    };
    /** LOOP-001 / VERIFY-001: task whose verification specs gate completion. */
    task?: TaskSpec;
    /** LOOP-001 / VERIFY-001: independent verifier; gating active only when
     *  both `task` and `verifier` are set. */
    verifier?: Verifier;
    /** P8-1: runtime-side verification plan auto-orchestration. When the task
     *  declares no verification specs, this derives them from the change set
     *  (buildVerificationPlan / discovered commands) and the gate runs them.
     *  Explicit task.verification always wins. */
    verificationPlanner?: (input: {
        task: TaskSpec;
        changedPaths: string[];
        cwd: string;
    }) => VerificationSpec[] | Promise<VerificationSpec[]>;
    /** LOOP-001 / RECOVERY-001: bounded recovery policy for tool failures. */
    recovery?: RecoveryPolicy;
    /** P2-42: adaptive recovery planner with per-action budgets. When set (and
     *  `recovery` is NOT set, they are mutually exclusive recovery configs), the
     *  tool-failure model feed uses the planner instead of the legacy narrow
     *  retry/ask/fail-safe policy. */
    adaptiveRecovery?: AdaptiveRecoveryPlanner;
    /** Task 3: skill index provider. When set (and `context` is set), it is
     *  awaited once per context build, the skills are injected into the pipeline,
     *  and one `skill.discovered` event is emitted per skill after each build.
     *
     *  P0-7: the provider may return a `SkillDiscovery` whose `security` array
     *  names skills rejected for injection/secret at discovery time; the runtime
     *  surfaces each as a `security.skill_denied` / `security.secret_redacted`
     *  event on the session stream (never stderr-only). Returning a plain
     *  `Skill[]` (no rejects) stays fully supported. */
    skills?: () => Skill[] | SkillDiscovery | Promise<Skill[] | SkillDiscovery>;
    /** P2-6: prunes the skill index before injection (index → relevant selection
     *  → body on demand). Receives the metadata rows; returns the subset to
     *  inject. Discovery events still cover every skill. Default: identity. */
    skillSelector?: (entries: SkillIndexEntry[]) => SkillIndexEntry[];
    /** LOOP-001: tool specs advertised to the model (default: none). */
    toolSpecs?: readonly ToolSpec[];
    /** P7-1/P7-2: progressive tool disclosure — narrows the advertised tool
     *  schemas per goal (deterministic champion). Absent → identity (all). */
    toolSelector?: ToolSelector;
    /** LOOP-001: paths touched by the run, reported into verification context. */
    changedPathsProvider?: () => readonly string[];
    /** P1-16: workspace file inventory at run start, reported into verification
     *  context for deletion detection. */
    baselineFilesProvider?: () => readonly string[];
    /** P1-3: durable checkpoint persistence. When set, the runtime persists a
     *  checkpoint at every safe boundary allowed by `checkpointPolicy`
     *  (successful side-effect tool, compaction, verification gate, periodic).
     *  Absent by default (no checkpointing — the host opts in). */
    checkpointStore?: CheckpointStore;
    /** P1-3: which safe boundaries take a checkpoint (partial overrides of the
     *  DEFAULT_CHECKPOINT_POLICY). */
    checkpointPolicy?: Partial<CheckpointPolicy>;
    /** P1-5: fault injection kill points. When set, it is invoked at each named
     *  boundary; a throw simulates process death at that point (the retry/
     *  recovery machinery rethrows RuntimeKilledError untouched). Absent by
     *  default (production runs uninstrumented). */
    failpoint?: (point: FaultPoint, ctx: FaultPointContext) => void | Promise<void>;
    /** P2-43: Ask-User Gate. When a turn lacks critical input it must ask the
     *  user as a FORMAL phase/outcome (`waiting_for_user`), never by simulating a
     *  tool error. Supply an `askUserStore` to make pending asks durable and
     *  an `askUser` handler to surface them to a UI. Both are optional: with the
     *  store alone the runtime still parks the turn with a typed, auditable
     *  request (the contracts boundary — a UI can be added later); with the
     *  handler it also delivers the question to the host. The `ask_user` tool is
     *  recognized by name (ASK_GATE_TOOL); calling it parks the run / routes the
     *  answer back as a user message on resume. Absent by default (the model gets
     *  an explicit "ask_user tool is not available" observation, NOT a fake error —
     *  the model must either infer the answer or the task is beyond its budget). */
    askUserStore?: AskUserStore;
    askUser?: (request: AskUserRequest) => Promise<AskUserReply | undefined>;
    askUserLifecycle?: AskUserLifecycle;
    /** P0-11/P3-10: optional callback for token usage reporting (tree /
     *  scheduler budget). Called after model.completed with the session the
     *  call belonged to and the usage from the most recent call — the session id
     *  lets the host attribute usage to the right tree root (P3-10). */
    reportModelUsage?: (sessionId: SessionId, inputTokens: number, outputTokens: number) => void;
    /** P2-2: pre-turn memory retrieval. When set, the runtime awaits it once
     *  per turn (after turn initialization, before the first model call) and
     *  passes the returned blocks into the context pipeline as memory prior
     *  blocks (source "memory", semi-trusted data). One `memory.retrieved`
     *  event is emitted per turn and the memory ids are appended to the
     *  working state's `memoryRefs`. Absent by default (no memory — plan.md
     *  P2-2: user goal → scope → retrieve → topK → ContextBlock). */
    memoryBlocks?: (input: {
        sessionId: SessionId;
        turnId: TurnId;
        goal: string;
        cwd: string;
    }) => Promise<ContextBlock[]>;
    /** P2-5: post-turn reflection hook. Invoked after every terminal turn
     *  outcome (completed / failed / cancelled) with the final outcome. The
     *  host owns the reflection pipeline (event stream read, deterministic
     *  Reflector, candidate write gate) — core only signals completion. Errors
     *  thrown here are swallowed: reflection must never change the turn result. */
    onTurnComplete?: (input: {
        sessionId: SessionId;
        turnId: TurnId;
        outcome: TurnOutcome;
    }) => void | Promise<void>;
    /** P2-8: skill body blocks for the skills selected by `skillSelector`
     *  (progressive disclosure: index → selection → body load → context).
     *  Receives the turn identity and the selected skill names; returns ready
     *  context blocks that are admitted into the pipeline as semi-trusted skill
     *  data before tool output. The session/turn let the host attribute skill
     *  effectiveness per task (P2-9). Absent by default (index-only skills). */
    skillBodyBlocks?: (input: {
        sessionId: SessionId;
        turnId: TurnId;
        names: string[];
    }) => Promise<ContextBlock[]>;
    /** P3-9: host-provided specialist delegation for adaptive recovery (the
     *  host owns the Delegator and the budget gate). When a tool keeps failing
     *  and the adaptive planner picks delegate_specialist, the host may really
     *  delegate to a specialist subagent and report a bounded observation. */
    delegateSpecialist?: (input: {
        sessionId: SessionId;
        turnId: TurnId;
        goal: string;
        tool: string;
        failure: string;
        signal: AbortSignal;
    }) => Promise<{
        delegated: boolean;
        summary?: string;
    } | undefined>;
}
export declare class AgentRuntime {
    private readonly store;
    private readonly events;
    private readonly modelProvider;
    private readonly orchestrator;
    private readonly hooks;
    private readonly agents;
    private readonly maxIterationsPerTurn;
    private readonly maxRepeatedIdenticalToolCalls;
    private readonly maxStallRecoveries;
    /** P2-41: non-identical stall patterns the runtime actively detects. */
    private readonly enabledStallPatterns;
    /** P2-41: recovery budget for pattern-based stalls. */
    private readonly maxPatternStallRecoveries;
    private readonly maxVerificationFailures;
    private readonly maxParallelToolCalls;
    private readonly toolCapabilityOf;
    private readonly toolSemanticsOf?;
    private readonly toolOutputBudget?;
    private readonly artifactStore?;
    private readonly outputRedactor?;
    private readonly injectionDetector?;
    private readonly inbox?;
    private readonly reportModelUsage?;
    private readonly now;
    /** Q-7: injectable timer driving retry-backoff sleeps. */
    private readonly timer;
    private readonly sandboxPolicy?;
    private readonly context?;
    private readonly task?;
    private readonly verifier?;
    private readonly verificationPlanner?;
    private readonly recovery?;
    /** P2-42: adaptive recovery planner (bounded action budgets). */
    private readonly adaptiveRecovery?;
    /** P2-42: per-turn ledger of recovery-action uses against their budgets. */
    private readonly recoveryUsage;
    private readonly skills?;
    private readonly skillSelector?;
    /** P2-8: loads skill bodies for the selected skills (progressive disclosure). */
    private readonly skillBodyBlocks?;
    /** P2-2: pre-turn memory retrieval (memory prior blocks + memory.retrieved). */
    private readonly memoryBlocks?;
    /** P2-5: post-turn reflection hook (never alters the turn result). */
    private readonly onTurnComplete?;
    /** P3-9: host-provided specialist delegation for adaptive recovery. */
    private readonly delegateSpecialist?;
    private readonly toolSpecs;
    private readonly toolSelector?;
    private readonly changedPathsProvider?;
    private readonly baselineFilesProvider?;
    /** P1-20: cumulative compaction count (observability metric). Q-1: boxed
     *  so the context + model-call controllers share it by reference. */
    private readonly compactCounter;
    private readonly checkpointStore?;
    private readonly checkpointPolicy;
    private readonly failpoint?;
    /** P2-43: ask-user gate — durable store, handler, and pure lifecycle. */
    private readonly askUserStore?;
    private readonly askUser?;
    private readonly askUserLifecycle;
    /** Q-1: tool-call execution (batch planning, single-call pipeline, stall
     *  traces) delegated to the extracted controller module. */
    private readonly toolCallController;
    /** Q-1: context pipeline + steering injection + tool-output rendering
     *  delegated to the extracted controller module. */
    private readonly contextController;
    /** Q-1: verification gate delegated to the extracted controller module. */
    private readonly verificationController;
    /** Q-1: model-call + post-completion processing delegated to the extracted
     *  controller module. */
    private readonly modelCallController;
    /** Q-1: recovery/persistence helpers (finishTurn / checkpoint / park /
     *  reconstruct) delegated to the extracted controller module. */
    private readonly recoveryController;
    constructor(deps: AgentRuntimeDeps);
    /** P1-5: invoke the fault injector at a kill point (no-op when absent). */
    private failAt;
    getHooks(): HookRegistry;
    private emit;
    createSession(opts: {
        agent: AgentDefinition;
        cwd: string;
        parentId?: SessionId;
    }): Promise<Session>;
    startTurn(sessionId: SessionId, text: string): Promise<Turn>;
    /** Execute one turn: model round-trips + tool calls, bounded and cancellable.
     *  `opts.initialState` seeds the working state from a restored checkpoint
     *  (P1-4 resume) instead of the turn input text. */
    runTurn(sessionId: SessionId, turnId: TurnId, signal: AbortSignal, opts?: {
        initialState?: WorkingState;
    }): Promise<TurnOutcome>;
    /** P2-5: runTurn body (the wrapper fires the post-turn reflection hook).
     *  Model round-trips + tool calls, bounded and cancellable. */
    private runTurnCore;
    /**
     * Q-1: turn initialization extracted from runTurn — resolves the session,
     * agent and turn (throwing AgentError on unknown ids), bundles the five
     * read-only values into the TurnContext, and creates the per-turn mutable
     * accumulators: AgentState (with beginTurn applied), the working state
     * (seeded from the restored checkpoint on resume, else the turn input),
     * and the empty tool execution ledger. Pure wiring, no events emitted.
     */
    private prepareTurn;
    /**
     * Q-1: post-execution processing extracted from runTurn. Handles:
     *   - render tool results + append messages + context blocks
     *   - update working state + count tool calls
     *   - tool ledger recording + side-effect checkpoints
     *   - stall detection (identical-call streak + pattern-based)
     *   - maxToolCalls limit check
     *   - post-batch abort check
     * priorBlocks is modified in place (push).
     */
    private handleToolResults;
    /**
     * P2-43 — submit a user's reply to a pending ask and resume the turn. This
     * is the "resume after reply" boundary. It records the answer (store
     * markAnswered when configured, else in-memory), injects the reply as a
     * user message tagged with the ask id (exactly-once: a transcript message
     * carrying askId proves it was already injected — P2-36 pattern), emits
     * ask.user_replied, and returns the resumable prompt. The host then calls
     * runTurn() again (seeded with the reply) to continue.
     */
    submitUserAnswer(sessionId: SessionId, turnId: TurnId, askId: AskId, text: string): Promise<{
        resumed: boolean;
        message: string;
    }>;
    /** P1-4: restore an interrupted session from its most recent durable
     *  checkpoint and continue the task. Resume is NOT a replay of the old
     *  transcript: the model receives the checkpoint working state plus what
     *  happened AFTER the checkpoint (completed side effects that must not be
     *  replayed, and started-but-unconfirmed tools that need reconciliation),
     *  then the normal loop continues in a fresh turn seeded from that state.
     *
     *  Throws RESUME_FAILED when no usable checkpoint exists or no agent can be
     *  resolved for the session (fail-closed: we never invent a recovery we
     *  cannot back with durable state). */
    resumeTurn(sessionId: SessionId, signal: AbortSignal): Promise<ResumeResult>;
    private wallClockExceeded;
    /** P1-11: execution semantics of a tool — injected lookup first, then the
     *  built-in registry, then the conservative default. Never name-matched. */
    private semanticsOf;
    getAgent(agentId: AgentId): AgentDefinition | undefined;
    /**
     * P0-1: resolve the effective agent for a session.
     *
     * - Sessions created by this runtime version carry a persisted
     *   EffectiveAgentConfig snapshot; runTurn honors it, so delegation
     *   restrictions survive resume and registry changes can never widen a
     *   running session.
     * - Legacy sessions (no snapshot) fall back to the registry definition,
     *   preserving pre-P0-1 behavior. This is the only base-agent fallback
     *   path; a present-but-corrupt/mismatched snapshot fails closed instead.
     */
    private resolveAgent;
}
export { renderToolResult, buildResumePrompt };
//# sourceMappingURL=runtime.d.ts.map