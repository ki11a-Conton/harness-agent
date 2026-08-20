import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentDefinition,
  AgentEvent,
  AgentId,
  Artifact,
  ArtifactStore,
  ContextBlock,
  ContextBudget,
  EventStore,
  InboxStore,
  Message,
  ModelProvider,
  SandboxPolicy,
  Session,
  SessionId,
  SessionStore,
  Skill,
  SkillIndexEntry,
  TaskSpec,
  ToolCall,
  ToolCapability,
  ToolOrchestrator,
  ToolResult,
  ToolSemantics,
  ToolSpec,
  Turn,
  TurnId,
  UserMessage,
  Verifier,
} from "@ar/contracts";
import {
  AdaptiveRecoveryPlanner,
  DEFAULT_CHECKPOINT_POLICY,
  DEFAULT_TOOL_CAPABILITY,
  DEFAULT_TOOL_SEMANTICS,
  EFFECTIVE_AGENT_SNAPSHOT_KEY,
  RUNTIME_POLICY_SNAPSHOT_KEY,
  computeArgsHash,
  errorInfo,
  isToolAllowedByPolicy,
  newArtifactId,
  newEventId,
  newMessageId,
  newSessionId,
  newTurnId,
  newWorkingState,
  snapshotEffectiveConfig,
  STALL_WINDOW_SIZE,
  defaultAskUserLifecycle,
  RealTimer,
} from "@ar/contracts";
import type {
  CheckpointId,
  CheckpointPolicy,
  CheckpointStore,
  CompactionSummary,
  EffectiveAgentConfig,
  EffectiveRuntimePolicySnapshot,
  ToolExecutionRecord,
  WorkingState,
  ProgressSignal,
  StallPattern,
  RecoveryAction,
  RecoveryDecision,
  RecoveryInput,
  AskUserRequest,
  AskUserReply,
  AskUserStore,
  AskUserLifecycle,
  AskReason,
  AskId,
  Timer,
} from "@ar/contracts";
import type { ContextPipeline, InstructionDiscoveryOptions } from "@ar/context";
import { estimateMessageTokens } from "@ar/context";
import { applyWorkingStateMutation, type WorkingStateMutation } from "@ar/contracts";
import { AgentError } from "../errors.js";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import {
  buildResumePrompt,
  DEFAULT_RUNTIME_TOOL_SEMANTICS,
  isContextOverflowError,
  isEffectiveAgentConfig,
  rethrowIfKill,
  renderToolResult,
  toContextBlock,
  trimMessageHistory,
  updateWorkingState,
  workingStateToCompactionSummary,
  ASK_GATE_TOOL,
} from "./turn-helpers.js";
import type {
  FaultPoint,
  FaultPointContext,
  ResumeResult,
  SkillDiscovery,
  TurnContext,
  TurnOutcome,
} from "./turn-helpers.js";
import { ToolCallController } from "./tool-call-controller.js";
import { RunBudgetTracker } from "./run-budget.js";

/** P1-6: deterministic hash of a policy value (session fingerprinting). */
function stableHashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
import type { ExecutedToolCall } from "./tool-call-controller.js";
import { ContextController } from "./context-controller.js";
import type { ContextUpdate } from "./context-controller.js";
import { ModelCallController } from "./model-call-controller.js";
import { VerificationController } from "./verification-controller.js";
import { RecoveryController } from "./recovery-controller.js";

/**
 * P2-41: non-identical stall patterns detected by default. `identical_tool` is
 * excluded — the legacy `maxRepeatedIdenticalToolCalls` gate already owns it.
 * The rest (alternating loop, repeated error, unchanged repeated read,
 * verification fix loop, no-progress churn) were previously invisible.
 */
const DEFAULT_ENABLED_STALL_PATTERNS: readonly StallPattern[] = [
  "alternating_loop",
  "repeated_error",
  "repeated_read_no_change",
  "verification_fix_loop",
  "no_progress",
];

// Q-1: defaultSandboxPolicy / FaultPoint / FaultPointContext /
// RuntimeKilledError / rethrowIfKill / TurnOutcome / TurnOutcomeStatus /
// TurnOutcomeDetail / ResumeResult / ASK_GATE_TOOL moved to turn-helpers.ts
// (shared with the extracted controllers); re-exported here so the public
// @ar/core surface (apps/cli, fault-injection tests importing ./runtime.js)
// is unchanged.
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
  toolOutputBudget?: { maxInlineBytes: number; artifactDir?: string };
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
  outputRedactor?: (content: string) => { content: string; redacted: number };
  /** P0-8: prompt-injection scan for untrusted content (rendered tool
   *  output). On a hit the content is withheld (fail-closed) and a
   *  security.injection_denied event is emitted. Absent by default (no
   *  detection — the host decides which detector to wire). */
  injectionDetector?: (content: string) => { hasInjection: boolean; reasons: string[] };
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
  /** P0-11: optional callback for token usage reporting (tree / scheduler budget).
   *  Called after model.completed with the usage from the most recent call. */
  reportModelUsage?: (inputTokens: number, outputTokens: number) => void;
}


/** Q-1: result of handleToolResults — tells runTurn what to do next. */
type ToolResultsAction =
  | { action: "continue_loop" }
  | { action: "finish"; outcome: TurnOutcome }
  | { action: "done" };

/** Q-1: per-turn initialization bundle produced by prepareTurn — the immutable
 *  read-only TurnContext plus the fresh mutable accumulators created at turn
 *  start (AgentState, working state, tool execution ledger). */
interface TurnInit {
  ctx: TurnContext;
  state: AgentState;
  turn: Turn;
  working: WorkingState;
  toolLedger: ToolExecutionRecord[];
}

export class AgentRuntime {
  private readonly store: SessionStore;
  private readonly events: EventStore;
  private readonly modelProvider: ModelProvider;
  private readonly orchestrator: ToolOrchestrator;
  private readonly hooks: HookRegistry;
  private readonly agents: ReadonlyMap<AgentId, AgentDefinition>;
  private readonly maxIterationsPerTurn: number;
  private readonly maxRepeatedIdenticalToolCalls: number;
  private readonly maxStallRecoveries: number;
  /** P2-41: non-identical stall patterns the runtime actively detects. */
  private readonly enabledStallPatterns: ReadonlySet<StallPattern>;
  /** P2-41: recovery budget for pattern-based stalls. */
  private readonly maxPatternStallRecoveries: number;
  private readonly maxVerificationFailures: number;
  private readonly maxParallelToolCalls: number;
  private readonly toolCapabilityOf: (toolName: string) => ToolCapability;
  private readonly toolSemanticsOf?: (toolName: string) => ToolSemantics;
  private readonly toolOutputBudget?: AgentRuntimeDeps["toolOutputBudget"];
  private readonly artifactStore?: ArtifactStore;
  private readonly outputRedactor?: AgentRuntimeDeps["outputRedactor"];
  private readonly injectionDetector?: AgentRuntimeDeps["injectionDetector"];
  private readonly inbox?: InboxStore;
  private readonly reportModelUsage?: (inputTokens: number, outputTokens: number) => void;
  private readonly now: () => number;
  /** Q-7: injectable timer driving retry-backoff sleeps. */
  private readonly timer: Timer;
  private readonly sandboxPolicy?: SandboxPolicy;
  private readonly context?: AgentRuntimeDeps["context"];
  private readonly task?: TaskSpec;
  private readonly verifier?: Verifier;
  private readonly recovery?: RecoveryPolicy;
  /** P2-42: adaptive recovery planner (bounded action budgets). */
  private readonly adaptiveRecovery?: AdaptiveRecoveryPlanner;
  /** P2-42: per-turn ledger of recovery-action uses against their budgets. */
  private readonly recoveryUsage: Partial<Record<RecoveryAction, number>> = {};
  private readonly skills?: AgentRuntimeDeps["skills"];
  private readonly skillSelector?: AgentRuntimeDeps["skillSelector"];
  private readonly toolSpecs: readonly ToolSpec[];
  private readonly changedPathsProvider?: () => readonly string[];
  private readonly baselineFilesProvider?: () => readonly string[];
  /** P1-20: cumulative compaction count (observability metric). Q-1: boxed
   *  so the context + model-call controllers share it by reference. */
  private readonly compactCounter = { value: 0 };
  private readonly checkpointStore?: CheckpointStore;
  private readonly checkpointPolicy: CheckpointPolicy;
  private readonly failpoint?: AgentRuntimeDeps["failpoint"];
  /** P2-43: ask-user gate — durable store, handler, and pure lifecycle. */
  private readonly askUserStore?: AskUserStore;
  private readonly askUser?: (request: AskUserRequest) => Promise<AskUserReply | undefined>;
  private readonly askUserLifecycle: AskUserLifecycle;

  /** Q-1: tool-call execution (batch planning, single-call pipeline, stall
   *  traces) delegated to the extracted controller module. */
  private readonly toolCallController: ToolCallController;

  /** Q-1: context pipeline + steering injection + tool-output rendering
   *  delegated to the extracted controller module. */
  private readonly contextController: ContextController;

  /** Q-1: verification gate delegated to the extracted controller module. */
  private readonly verificationController: VerificationController;

  /** Q-1: model-call + post-completion processing delegated to the extracted
   *  controller module. */
  private readonly modelCallController: ModelCallController;

  /** Q-1: recovery/persistence helpers (finishTurn / checkpoint / park /
   *  reconstruct) delegated to the extracted controller module. */
  private readonly recoveryController: RecoveryController;

  constructor(deps: AgentRuntimeDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.modelProvider = deps.modelProvider;
    this.orchestrator = deps.orchestrator;
    this.hooks = deps.hooks ?? new HookRegistry();
    this.agents = new Map(deps.agents.map((a) => [a.id, a]));
    this.maxIterationsPerTurn = deps.maxIterationsPerTurn ?? 20;
    this.maxRepeatedIdenticalToolCalls = deps.maxRepeatedIdenticalToolCalls ?? 3;
    this.maxStallRecoveries = deps.maxStallRecoveries ?? 1;
    this.enabledStallPatterns = new Set(
      deps.enabledStallPatterns ?? DEFAULT_ENABLED_STALL_PATTERNS,
    );
    this.maxPatternStallRecoveries = deps.maxPatternStallRecoveries ?? 1;
    this.maxVerificationFailures = deps.maxVerificationFailures ?? 3;
    this.maxParallelToolCalls = deps.maxParallelToolCalls ?? 4;
    this.toolCapabilityOf = deps.toolCapabilityOf ?? (() => DEFAULT_TOOL_CAPABILITY);
    this.toolSemanticsOf = deps.toolSemanticsOf;
    this.toolOutputBudget = deps.toolOutputBudget;
    this.artifactStore = deps.artifactStore;
    this.outputRedactor = deps.outputRedactor;
    this.injectionDetector = deps.injectionDetector;
    this.inbox = deps.inbox;
    this.reportModelUsage = deps.reportModelUsage;
    this.now = deps.now ?? Date.now;
    this.timer = deps.timer ?? new RealTimer(this.now);
    this.sandboxPolicy = deps.sandboxPolicy;
    this.context = deps.context;
    this.task = deps.task;
    this.verifier = deps.verifier;
    this.recovery = deps.recovery;
    this.adaptiveRecovery = deps.adaptiveRecovery;
    this.skills = deps.skills;
    this.skillSelector = deps.skillSelector;
    this.toolSpecs = deps.toolSpecs ?? [];
    this.changedPathsProvider = deps.changedPathsProvider;
    this.baselineFilesProvider = deps.baselineFilesProvider;
    this.checkpointStore = deps.checkpointStore;
    this.checkpointPolicy = { ...DEFAULT_CHECKPOINT_POLICY, ...deps.checkpointPolicy };
    this.failpoint = deps.failpoint;
    this.askUserStore = deps.askUserStore;
    this.askUser = deps.askUser;
    this.askUserLifecycle = deps.askUserLifecycle ?? defaultAskUserLifecycle;
    // Q-1: recovery/persistence helpers delegated to the extracted controller.
    // Constructed FIRST because the context + model-call controllers bind
    // checkpoint/finishTurn/parkForUserInput to it.
    this.recoveryController = new RecoveryController({
      store: this.store,
      events: this.events,
      emit: (sessionId, type, payload, turnId) => this.emit(sessionId, type, payload, turnId),
      now: () => this.now(),
      checkpointStore: this.checkpointStore,
      askUserStore: this.askUserStore,
      askUser: this.askUser,
      semanticsOf: (name) => this.semanticsOf(name),
    });
    // Q-1: tool-call execution delegated to the extracted controller. The
    // bindings below are captured once (all fields above are readonly);
    // `recoveryUsage` is passed by reference — the shared mutable budget map.
    this.toolCallController = new ToolCallController({
      orchestrator: this.orchestrator,
      store: this.store,
      hooks: this.hooks,
      emit: (sessionId, type, payload, turnId) => this.emit(sessionId, type, payload, turnId),
      failAt: (point, ctx) => this.failAt(point, ctx),
      now: () => this.now(),
      timer: this.timer,
      sandboxPolicy: this.sandboxPolicy,
      recovery: this.recovery,
      adaptiveRecovery: this.adaptiveRecovery,
      recoveryUsage: this.recoveryUsage,
      toolCapabilityOf: (toolName) => this.toolCapabilityOf(toolName),
      maxParallelToolCalls: this.maxParallelToolCalls,
    });
    // Q-1: context pipeline + steering + tool-output rendering delegated to
    // the extracted controller. `compactCounter` is shared by reference with
    // the model-call controller (reactive compaction).
    this.contextController = new ContextController({
      store: this.store,
      emit: (sessionId, type, payload, turnId) => this.emit(sessionId, type, payload, turnId),
      now: () => this.now(),
      failAt: (point, ctx) => this.failAt(point, ctx),
      context: this.context,
      skills: this.skills,
      skillSelector: this.skillSelector,
      recovery: this.recovery,
      compactCounter: this.compactCounter,
      checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) =>
        this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason, budgetUsage),
      finishTurn: (ctx, status, state, working, error, terminationReason, ledger) =>
        this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger),
      toolOutputBudget: this.toolOutputBudget,
      outputRedactor: this.outputRedactor,
      artifactStore: this.artifactStore,
      semanticsOf: (name) => this.semanticsOf(name),
      injectionDetector: this.injectionDetector,
      inbox: this.inbox,
    });
    // Q-1: verification gate delegated to the extracted controller.
    this.verificationController = new VerificationController({
      task: this.task,
      verifier: this.verifier,
      store: this.store,
      now: () => this.now(),
      changedPathsProvider: this.changedPathsProvider,
      baselineFilesProvider: this.baselineFilesProvider,
    });
    // Q-1: model-call + post-completion delegated to the extracted
    // controller. runVerificationGate is bound to the verification
    // controller; checkpoint/finishTurn/parkForUserInput/wallClockExceeded
    // are bound to the runtime (they are recovery/recovery-adjacent and stay
    // on AgentRuntime to avoid a controller ↔ runtime cycle).
    this.modelCallController = new ModelCallController({
      store: this.store,
      emit: (sessionId, type, payload, turnId) => this.emit(sessionId, type, payload, turnId),
      now: () => this.now(),
      failAt: (point, ctx) => this.failAt(point, ctx),
      toolSpecs: this.toolSpecs,
      recovery: this.recovery,
      timer: this.timer,
      compactCounter: this.compactCounter,
      maxVerificationFailures: this.maxVerificationFailures,
      afterVerificationCheckpoint: this.checkpointPolicy.afterVerification,
      contextBudgetMaxTokens: this.context?.budget.maxTokens ?? 0,
      checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) =>
        this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason, budgetUsage),
      finishTurn: (ctx, status, state, working, error, terminationReason, ledger) =>
        this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger),
      parkForUserInput: (ctx, state, working, call, ledger) =>
        this.recoveryController.parkForUserInput(ctx, state, working, call, ledger),
      runVerificationGate: (ctx) => this.verificationController.runVerificationGate(ctx),
      wallClockExceeded: (agent, turn) => this.wallClockExceeded(agent, turn),
    });
  }

  /** P1-5: invoke the fault injector at a kill point (no-op when absent). */
  private async failAt(point: FaultPoint, ctx: FaultPointContext): Promise<void> {
    if (this.failpoint === undefined) return;
    await this.failpoint(point, ctx);
  }

  getHooks(): HookRegistry {
    return this.hooks;
  }

  private async emit(
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    turnId?: TurnId,
  ): Promise<AgentEvent> {
    const sequence = await this.events.nextSequence(sessionId);
    return this.events.append({
      id: newEventId(),
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      sequence,
      timestamp: this.now(),
      type,
      payload,
    });
  }

  async createSession(opts: {
    agent: AgentDefinition;
    cwd: string;
    parentId?: SessionId;
  }): Promise<Session> {
    if (!this.agents.has(opts.agent.id)) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${opts.agent.id}`));
    }
    const session: Session = {
      id: newSessionId(),
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      agentId: opts.agent.id,
      model: opts.agent.model,
      cwd: opts.cwd,
      status: "active",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.store.createSession(session);
    // P0-1: freeze the effective configuration (model/systemPrompt/tools/
    // permissions/skills/limits) into the session state. runTurn honors this
    // snapshot instead of re-reading the registry, so delegation restrictions
    // survive resume, and later registry changes cannot silently widen a
    // running session. Persistence failure fails session creation (fail-closed:
    // a session without a frozen policy must not run against the base agent).
    await this.store.saveStateSnapshot(session.id, {
      [EFFECTIVE_AGENT_SNAPSHOT_KEY]: snapshotEffectiveConfig(opts.agent),
      // P1-6: freeze the runtime policy hashes too, so a resume can detect
      // host-policy drift (safe-resume gate).
      [RUNTIME_POLICY_SNAPSHOT_KEY]: {
        version: 1,
        contextPolicyHash: this.context !== undefined ? stableHashOf(this.context) : undefined,
        retryPolicyHash: this.recovery !== undefined ? stableHashOf(this.recovery) : undefined,
        schedulerPolicyHash: undefined,
        toolSemanticsHash: this.toolSemanticsOf !== undefined ? String(this.toolSemanticsOf.length) : undefined,
        createdAt: this.now(),
      } satisfies EffectiveRuntimePolicySnapshot,
    });
    await this.emit(session.id, "session.created", { sessionId: session.id, agentId: session.agentId });
    await this.hooks.dispatch("session_start", {
      sessionId: session.id,
      agentId: session.agentId,
      timestamp: this.now(),
    });
    return session;
  }

  async startTurn(sessionId: SessionId, text: string): Promise<Turn> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    if (session.status !== "active") {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${sessionId} is ${session.status}`));
    }
    const input: UserMessage = { sessionId, text };
    const turn: Turn = {
      id: newTurnId(),
      sessionId,
      input,
      status: "running",
      startedAt: this.now(),
    };
    await this.store.createTurn(turn);
    await this.store.appendMessage({
      id: newMessageId(),
      sessionId,
      turnId: turn.id,
      role: "user",
      content: text,
      createdAt: this.now(),
    });
    await this.emit(sessionId, "turn.started", { turnId: turn.id, text }, turn.id);
    return turn;
  }

  /** Execute one turn: model round-trips + tool calls, bounded and cancellable.
 *  `opts.initialState` seeds the working state from a restored checkpoint
 *  (P1-4 resume) instead of the turn input text. */
  async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    signal: AbortSignal,
    opts: { initialState?: WorkingState } = {},
  ): Promise<TurnOutcome> {
    // Q-1: turn initialization extracted to prepareTurn (session/agent/turn
    // resolution, TurnContext, AgentState, working state, tool ledger).
    const { ctx, state, turn, working, toolLedger } = await this.prepareTurn(sessionId, turnId, signal, opts);

    const priorBlocks: ContextBlock[] = [];
    let overflowAttempt = 0;
    let verificationFailures = 0;
    let reactiveCompacted = false;
    let digestAppended = false;
    let lastReportTokens: number | undefined;
    // P0-10: unified run-budget tracker (replaces scattered counters).
    const budget = new RunBudgetTracker(ctx.agent.limits, this.now);

    try {
      for (let i = 0; i < this.maxIterationsPerTurn; i++) {
        if (signal.aborted) {
          return this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
        }

        // P1-3 periodic checkpoint: every N model iterations at a safe
        // boundary (between model calls). Iteration 0 is the warm-up.
        if (
          this.checkpointPolicy.everyNIterations > 0 &&
          state.getIteration() > 0 &&
          state.getIteration() % this.checkpointPolicy.everyNIterations === 0
        ) {
          await this.recoveryController.checkpoint(ctx, working, state, toolLedger, "periodic:iteration", lastReportTokens !== undefined ? { maxTokens: this.context?.budget.maxTokens ?? 0, usedTokens: lastReportTokens } : undefined);
        }

        const durationBreach = budget.onDurationCheck();
        if (durationBreach !== undefined) {
          await this.emit(sessionId, "run.limit_reached", { ...durationBreach }, turnId);
          return this.recoveryController.finishTurn(
            ctx, "failed", state, working,
            errorInfo("RESOURCE_LIMIT", `maxDurationMs (${durationBreach.allowed}ms) exceeded after ${durationBreach.used}ms`),
            "time_limit",
            toolLedger,
          );
        }

        await this.hooks.dispatch("before_model", {
          sessionId, turnId, agentId: ctx.session.agentId, timestamp: this.now(),
        });
        // P0-9: model.started is emitted by the model-call controller per
        // attempt with a callId (usage/latency/retry attribution).

        const client = this.modelProvider.createClient(ctx.agent.model, {});
        let history = await this.store.listMessages(sessionId);

        // Steer injection (plan.md Issue 3 / Phase 5.3, P2-36): user steering
        // admitted while the turn is running lands here — the safe boundary
        // before the model call — as a user message. Follow-up prompts stay
        // queued for the host's outer loop.
        //
        // P2-36 exactly-once: the steer transition spans two stores (session
        // message + inbox status), so a crash between append and consume would
        // otherwise double-inject on resume. We therefore check `history` for
        // an already-appended message carrying `promptId` and skip (reconciling
        // the prompt to consumed) when one exists.
        // Q-1: steering prompt injection extracted to injectSteeringPrompts.
        history = await this.contextController.injectSteeringPrompts(ctx, history);

        if (reactiveCompacted && history.length > 12) {
          // Reactive compact (plan.md Phase 4/5): after a context-length model
          // error the runtime retries with a REDUCED history — the state
          // digest message (appended below) plus the most recent messages.
          // The full transcript stays in the store (transcript fallback).
          history = history.slice(-12);
        }

        // Q-1: context pipeline + compaction + overflow extracted to buildContext.
        // Returns TurnOutcome on overflow failure, undefined to proceed.
        // Mutates: history, system, lastReportTokens, digestAppended, overflowAttempt
        // (via the returned ContextUpdate object).
        const ctxUpdate = await this.contextController.buildContext(
          ctx, ctx.agent, turn, working, priorBlocks, state, toolLedger,
          history, ctx.agent.systemPrompt, lastReportTokens, digestAppended, overflowAttempt, reactiveCompacted,
        );
        if (ctxUpdate.action === "finish") return ctxUpdate.outcome;
        let system = ctxUpdate.system;
        history = ctxUpdate.history;
        lastReportTokens = ctxUpdate.lastReportTokens;
        digestAppended = ctxUpdate.digestAppended;
        overflowAttempt = ctxUpdate.overflowAttempt;
        const modelResult = await this.modelCallController.callModelWithRetry(
          ctx, client, history, system, working, state, toolLedger, lastReportTokens, reactiveCompacted,
        );

        if (modelResult.status === "cancelled") {
          return this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
        }
        if (modelResult.status === "failed") {
          return this.recoveryController.finishTurn(ctx, "failed", state, working, modelResult.error, "model_error", toolLedger);
        }

        // completed
        reactiveCompacted = modelResult.reactiveCompacted;
        // Q-1: post-completion processing extracted to handleModelCompletion.
        const completion = await this.modelCallController.handleModelCompletion(
          ctx, modelResult, turn, working, state, toolLedger, lastReportTokens, verificationFailures,
        );
        if (completion.action === "continue_loop") {
          verificationFailures = completion.verificationFailures;
          continue;
        }
        // P0-11: report per-call token usage to the tree budget (scheduler).
        if (this.reportModelUsage !== undefined && modelResult.usage !== undefined) {
          this.reportModelUsage(modelResult.usage.inputTokens ?? 0, modelResult.usage.outputTokens ?? 0);
        }
        if (completion.action === "finish") return completion.outcome;

        // proceed to execute tools
        const toolCalls = completion.toolCalls;
        const executed = await this.toolCallController.executeToolCalls(ctx, state, toolCalls);
        const toolAction = await this.handleToolResults(
          ctx, executed, working, state, toolLedger, priorBlocks, lastReportTokens, budget,
        );
        if (toolAction.action === "continue_loop") continue;
        if (toolAction.action === "finish") return toolAction.outcome;
        // done: fall through to next iteration
      }

      const info = errorInfo("RESOURCE_LIMIT", `maxIterationsPerTurn (${this.maxIterationsPerTurn}) reached`);
      await this.emit(sessionId, "run.limit_reached", { limit: "maxIterationsPerTurn", used: this.maxIterationsPerTurn }, turnId);
      return this.recoveryController.finishTurn(ctx, "failed", state, working, info, "agent_limit", toolLedger);
    } finally {
      const current = await this.store.getSession(sessionId);
      if (current) await this.store.updateSession({ ...current, updatedAt: this.now() });
    }
  }

  /**
   * Q-1: turn initialization extracted from runTurn — resolves the session,
   * agent and turn (throwing AgentError on unknown ids), bundles the five
   * read-only values into the TurnContext, and creates the per-turn mutable
   * accumulators: AgentState (with beginTurn applied), the working state
   * (seeded from the restored checkpoint on resume, else the turn input),
   * and the empty tool execution ledger. Pure wiring, no events emitted.
   */
  private async prepareTurn(
    sessionId: SessionId,
    turnId: TurnId,
    signal: AbortSignal,
    opts: { initialState?: WorkingState },
  ): Promise<TurnInit> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    const agent = await this.resolveAgent(session);

    // Q-1: bundle the five read-only turn values into a single context object.
    const ctx: TurnContext = { sessionId, turnId, signal, session, agent };

    const state = new AgentState(sessionId, session.agentId, this.now);
    state.beginTurn(turnId);
    const turn = await this.store.getTurn(turnId);
    if (!turn) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown turn ${turnId}`));
    // P1-4: a resuming turn seeds its working state from the restored
    // checkpoint instead of the (resume) input text; otherwise a fresh
    // per-turn working state is the single run-state structure — the
    // compaction digest, pipeline summary override and the final TurnOutcome
    // all read from it (no parallel journal/summary copies).
    const working: WorkingState =
      opts?.initialState !== undefined ? opts.initialState : newWorkingState(turn.input.text);
    // P1-3/P1-4: checkpoint material tracked per turn — the durable tool
    // execution ledger and the last observed context usage so a checkpoint
    // can carry budget usage without re-reading the transcript.
    const toolLedger: ToolExecutionRecord[] = [];
    return { ctx, state, turn, working, toolLedger };
  }

  // Q-1: executeToolCalls / runReadBatch / recordStallTrace / executeToolCall
  // moved to tool-call-controller.ts (ToolCallController). runTurn delegates
  // via this.toolCallController; the method bodies are unchanged except for
  // `this.<field>` → `this.deps.<field>` bindings.

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
  private async handleToolResults(
    ctx: TurnContext,
    executed: ExecutedToolCall[],
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    priorBlocks: ContextBlock[],
    lastReportTokens: number | undefined,
    budget: RunBudgetTracker,
  ): Promise<ToolResultsAction> {
    const { sessionId, turnId, signal, agent } = ctx;
        for (const { call, result, streak } of executed) {
          // P0-12: update_plan is a runtime-internal tool that applies
          // working state mutations directly — no external execution.
          if (call.name === "update_plan") {
            const mutations = call.args.mutations as WorkingStateMutation[] | undefined;
            if (mutations !== undefined) {
              for (const mutation of mutations) {
                applyWorkingStateMutation(working, mutation);
              }
            }
            // Skip the normal tool processing (no block, no message, no ledger).
            state.countToolCall();
            continue;
          }
          const content = await this.contextController.renderToolResultForContext(ctx, call, result);
          priorBlocks.push(toContextBlock(call.id, result, content));
          await this.store.appendMessage({
            id: newMessageId(),
            sessionId,
            turnId,
            role: "tool",
            content,
            toolCallId: call.id,
            createdAt: this.now(),
          });
          updateWorkingState(call, result, working, this.semanticsOf(call.name));
          state.countToolCall();
          // P1-3/P1-4: record the call in the durable execution ledger (the
          // side-effect-safety basis for resume/reconciliation) and checkpoint
          // after a successful side-effect tool — a durable safe boundary for
          // long tasks.
          toolLedger.push({
            toolCallId: call.id,
            tool: call.name,
            argsHash: computeArgsHash(call.args),
            started: this.now(),
            completed: this.now(),
            status: result.status,
            ...(result.output !== undefined
              ? { resultHash: computeArgsHash({ output: result.output }) }
              : {}),
            sideEffect: this.semanticsOf(call.name).sideEffectScope !== "none",
          });
          if (this.semanticsOf(call.name).sideEffectScope !== "none" && result.status === "success") {
            // P2-41: a landed side effect (new artifact / file diff) is concrete
            // progress — clear the stall window so a later similar call is not
            // misjudged as stagnation.
            state.recordProgress("new_artifact");
            // P1-5: kill after the effect landed but BEFORE its checkpoint —
            // the window where only the store result message proves it.
            await this.failAt("tool.completed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
            if (this.checkpointPolicy.afterSideEffectTools) {
              await this.recoveryController.checkpoint(
                ctx, working, state, toolLedger, `tool:completed:${call.name}`,
                lastReportTokens !== undefined ? { maxTokens: this.context?.budget.maxTokens ?? 0, usedTokens: lastReportTokens } : undefined,
              );
              // P1-5: kill AFTER the checkpoint persisted (a durable safety
              // boundary exists — resume can proceed from it).
              await this.failAt("tool.checkpointed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
            }
          }
          if (
            this.maxRepeatedIdenticalToolCalls > 0 &&
            streak >= this.maxRepeatedIdenticalToolCalls
          ) {
            // plan.md Phase 11 stall recovery: before terminating, give the
            // model one bounded chance to change strategy. The streak is
            // reset and a system observation is injected; a second streak
            // (recovery budget exhausted) terminates as before.
            if (this.maxStallRecoveries > 0 && state.useStallRecovery(this.maxStallRecoveries)) {
              await this.emit(sessionId, "retry.stallRecovery", {
                streak,
                allowed: this.maxRepeatedIdenticalToolCalls,
                remaining: this.maxStallRecoveries,
              }, turnId);
              state.resetToolStreak();
              await this.store.appendMessage({
                id: newMessageId(),
                sessionId,
                turnId,
                role: "system",
                content:
                  `[stall recovery — the identical tool call "${call.name}" was repeated ${streak} times without progress]\n` +
                  "The call keeps returning the same result. Try a different approach or stop repeating it.",
                createdAt: this.now(),
              });
              continue;
            }
            await this.emit(sessionId, "run.limit_reached", { limit: "maxRepeatedToolCalls", used: streak, allowed: this.maxRepeatedIdenticalToolCalls }, turnId);
            return { action: "finish", outcome: await this.recoveryController.finishTurn(
              ctx, "failed", state, working,
              errorInfo("RESOURCE_LIMIT", `maxRepeatedToolCalls (${this.maxRepeatedIdenticalToolCalls}) reached: repeated identical call ${call.name}`),
              "tool_limit",
              toolLedger,
            ) };
          }
          // P2-41: broader stall PATTERNS beyond the identical-call gate. The
          // pure window classifier reports a specific pattern when the recent
          // executions show no progress; if that pattern is enabled we treat it
          // exactly like the identical gate: bounded recovery (inject a system
          // observation, clear the window) then terminate.
          const stallPattern = state.stallPattern();
          if (
            stallPattern !== null &&
            this.enabledStallPatterns.has(stallPattern)
          ) {
            if (this.maxPatternStallRecoveries > 0 && state.useStallRecovery(this.maxPatternStallRecoveries + this.maxStallRecoveries)) {
              await this.emit(sessionId, "retry.stallRecovery", {
                pattern: stallPattern,
                allowed: STALL_WINDOW_SIZE,
                remaining: this.maxPatternStallRecoveries,
              }, turnId);
              state.clearStallWindow();
              await this.store.appendMessage({
                id: newMessageId(),
                sessionId,
                turnId,
                role: "system",
                content:
                  `[stall recovery — detected "${stallPattern}" (repeated tool work without progress)]\n` +
                  "Try a different approach or stop repeating the same work.",
                createdAt: this.now(),
              });
              continue;
            }
            await this.emit(sessionId, "run.limit_reached", { limit: "stallPattern", used: 1, allowed: this.maxPatternStallRecoveries, pattern: stallPattern }, turnId);
            return { action: "finish", outcome: await this.recoveryController.finishTurn(
              ctx, "failed", state, working,
              errorInfo("RESOURCE_LIMIT", `stall pattern detected: ${stallPattern}`),
              "tool_limit",
              toolLedger,
            ) };
          }
          if (agent.limits.maxToolCalls !== undefined) {
            const breach = budget.onToolCall();
            if (breach !== undefined) {
              await this.emit(sessionId, "run.limit_reached", { ...breach }, turnId);
              return { action: "finish", outcome: await this.recoveryController.finishTurn(
                ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", `maxToolCalls (${agent.limits.maxToolCalls}) reached`),
                "tool_limit",
                toolLedger,
              ) };
            }
          }
        }
        // P2-37: a user interrupt arrived during the tool batch. Side effects
        // that already COMMITTED (recorded above into the durable ledger,
        // working state and transcript) are KEPT and reported on the cancelled
        // outcome — cancel is not a rollback. Remaining calls were not run.
        if (signal.aborted) {
          return { action: "finish", outcome: await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger) };
        }
    return { action: "done" };
  }



  /**
   * P2-43 — submit a user's reply to a pending ask and resume the turn. This
   * is the "resume after reply" boundary. It records the answer (store
   * markAnswered when configured, else in-memory), injects the reply as a
   * user message tagged with the ask id (exactly-once: a transcript message
   * carrying askId proves it was already injected — P2-36 pattern), emits
   * ask.user_replied, and returns the resumable prompt. The host then calls
   * runTurn() again (seeded with the reply) to continue.
   */
  async submitUserAnswer(
    sessionId: SessionId,
    turnId: TurnId,
    askId: AskId,
    text: string,
  ): Promise<{ resumed: boolean; message: string }> {
    const pending =
      (this.askUserStore !== undefined
        ? await this.askUserStore.get(askId)
        : undefined) ?? {
          id: askId,
          sessionId,
          turnId,
          reason: "missing_critical_input" as AskReason,
          question: this.askUserLifecycle.fingerprint({ id: askId, sessionId, turnId, reason: "missing_critical_input", question: "", status: "pending", createdAt: this.now() }),
          status: "pending",
          createdAt: this.now(),
        };
    // Exactly-once resume injection: if a prior submitUserAnswer already
    // appended the resumed message for this ask, a duplicate submission is an
    // IDEMPOTENT success (not an error) — we return resumed:true so a host that
    // retries an answer (e.g. after a crash between our reply and its ack) does
    // not treat the recovery as a failure, and we never append a second message.
    const history = await this.store.listMessages(sessionId);
    if (history.some((m) => m.askId === askId)) {
      return { resumed: true, message: `already resumed for ask ${askId}` };
    }
    if (!this.askUserLifecycle.isPending(pending)) {
      return { resumed: false, message: `ask ${askId} is not pending` };
    }
    const reply: AskUserReply = { requestId: askId, text, answeredAt: this.now() };
    if (this.askUserStore !== undefined) {
      await this.askUserStore.markAnswered(askId, reply);
    }
    const prompt = this.askUserLifecycle.resumePrompt(reply);
    await this.store.appendMessage({
      id: newMessageId(),
      sessionId,
      turnId,
      role: "user",
      content: prompt.content,
      askId,
      createdAt: this.now(),
    });
    await this.emit(sessionId, "ask.user_replied", {
      askId,
      turnId,
      text,
    }, turnId);
    return { resumed: true, message: `resumed turn ${turnId} with reply` };
  }

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
  async resumeTurn(sessionId: SessionId, signal: AbortSignal): Promise<ResumeResult> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    const agent = await this.resolveAgent(session);
    if (this.checkpointStore === undefined) {
      throw new AgentError(
        errorInfo("RESUME_FAILED", `session ${sessionId} has no checkpoint store — cannot resume safely`),
      );
    }
    const checkpoint = await this.checkpointStore.loadLatest(sessionId);
    if (checkpoint === undefined) {
      throw new AgentError(
        errorInfo("RESUME_FAILED", `session ${sessionId} has no durable checkpoint — refusing to resume`),
      );
    }

    const turnId = checkpoint.turnId;
    const { working, committedSideEffects, unresolvedTools, replayedEventCount } =
      await this.recoveryController.reconstructResumeState(sessionId, turnId, checkpoint);

    // P2-40: each started-but-unconfirmed tool that must be reconciled is its
    // own reconciliation retry-kind event. Reconciliation is never auto-redone
    // (spec maxAttempts 0) — we only surface the fact so the taxonomy/report can
    // hold the runtime to that promise.
    for (const unresolved of unresolvedTools) {
      await this.emit(
        sessionId,
        "retry.reconciliation",
        {
          toolCallId: unresolved.toolCallId,
          tool: unresolved.tool,
          sideEffect: unresolved.sideEffect,
          started: unresolved.started,
        },
        turnId,
      );
    }

    const resumePrompt = buildResumePrompt(working, committedSideEffects, unresolvedTools);
    const turn = await this.startTurn(sessionId, resumePrompt);
    const outcome = await this.runTurn(sessionId, turn.id, signal, { initialState: working });
    await this.emit(sessionId, "session.resumed", {
      checkpointId: checkpoint.checkpointId,
      previousTurnId: turnId,
      resumedTurnId: turn.id,
      replayedEventCount,
      committedSideEffects: committedSideEffects.length,
      unresolvedTools: unresolvedTools.length,
    }, turn.id);

    return {
      sessionId,
      checkpointId: checkpoint.checkpointId,
      ...(turnId !== undefined ? { turnId } : {}),
      state: working,
      committedSideEffects,
      unresolvedTools,
      replayedEventCount,
      outcome,
    };
  }

  private wallClockExceeded(agent: AgentDefinition, turn: Turn): number | undefined {
    const max = agent.limits.maxDurationMs;
    if (max === undefined) return undefined;
    const elapsed = this.now() - turn.startedAt;
    return elapsed > max ? elapsed : undefined;
  }

  /** P1-11: execution semantics of a tool — injected lookup first, then the
   *  built-in registry, then the conservative default. Never name-matched. */
  private semanticsOf(name: string): ToolSemantics {
    return this.toolSemanticsOf?.(name) ?? DEFAULT_RUNTIME_TOOL_SEMANTICS[name] ?? DEFAULT_TOOL_SEMANTICS;
  }

  getAgent(agentId: AgentId): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

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
  private async resolveAgent(session: Session): Promise<AgentDefinition> {
    const snapshot = await this.store.loadStateSnapshot(session.id);
    if (snapshot === undefined) {
      const base = this.agents.get(session.agentId);
      if (!base) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${session.agentId}`));
      return base;
    }
    const cfg = snapshot[EFFECTIVE_AGENT_SNAPSHOT_KEY] as EffectiveAgentConfig | undefined;
    if (!isEffectiveAgentConfig(cfg)) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `session ${session.id} has a corrupt effective-agent snapshot: refusing to run against the base agent`),
      );
    }
    if (cfg.agentId !== session.agentId) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `session ${session.id} effective-agent snapshot agentId ${cfg.agentId} does not match session agentId ${session.agentId}`),
      );
    }
    // P1-6: safe-resume gate — detect host policy drift since the session was
    // created. Never silently change security semantics: the change is
    // observable on the event stream so a strict host can refuse to resume.
    const runtimePolicy = snapshot[RUNTIME_POLICY_SNAPSHOT_KEY] as EffectiveRuntimePolicySnapshot | undefined;
    if (runtimePolicy?.version === 1 && this.context !== undefined) {
      const currentContextHash = stableHashOf(this.context);
      if (runtimePolicy.contextPolicyHash !== undefined && runtimePolicy.contextPolicyHash !== currentContextHash) {
        await this.emit(session.id, "policy.changed_on_resume", {
          contextPolicyChanged: true,
          contextPolicyHash: currentContextHash,
          stored: runtimePolicy.contextPolicyHash,
        }, undefined);
      }
    }
    // Metadata (name/description/mode) is cosmetic and not part of the
    // security boundary; fall back to the registry when available.
    const meta = this.agents.get(session.agentId);
    return {
      id: cfg.agentId,
      name: meta?.name ?? cfg.agentId,
      description: meta?.description ?? "",
      mode: meta?.mode ?? "primary",
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      tools: cfg.tools,
      permissions: cfg.permissions,
      skills: cfg.skills,
      limits: cfg.limits,
    };
  }


}

// Q-1: below are re-exports of pure helpers now living in ./turn-helpers.js.
// Public API preserved: renderToolResult/buildResumePrompt are re-exported
// so `export * from ./runtime.js` in index.ts stays stable.
export { renderToolResult, buildResumePrompt };
