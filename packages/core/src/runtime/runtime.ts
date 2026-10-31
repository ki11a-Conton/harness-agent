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
  DurabilityFenceStore,
  EventStore,
  InboxStore,
  Message,
  ModelProvider,
  ModelRef,
  SandboxPolicy,
  Session,
  SessionId,
  SessionStore,
  Skill,
  SkillIndexEntry,
  TaskSpec,
  ToolCall,
  ToolOrchestrator,
  ToolResult,
  ToolSemantics,
  Turn,
  TurnId,
  UserMessage,
  VerificationSpec,
  Verifier,
} from "@ar/contracts";
import {
  AdaptiveRecoveryPlanner,
  DEFAULT_CHECKPOINT_POLICY,
  DEFAULT_TOOL_SEMANTICS,
  EFFECTIVE_AGENT_SNAPSHOT_KEY,
  RUNTIME_POLICY_SNAPSHOT_KEY,
  buildSkillSnapshot,
  computeArgsHash,
  dropOrphanToolResults,
  errorInfo,
  isToolAllowedByPolicy,
  newArtifactId,
  newEventId,
  newMessageId,
  newToolCallId,
  newSessionId,
  newTurnId,
  newWorkingState,
  newTurnExecutionState,
  snapshotEffectiveConfig,
  STALL_WINDOW_SIZE,
  defaultAskUserLifecycle,
  isAskReason,
  RealTimer,
} from "@ar/contracts";
import type {
  CheckpointBudgetUsage,
  CheckpointData,
  CheckpointId,
  CheckpointPolicy,
  CheckpointStore,
  CompactionSummary,
  EffectiveAgentConfig,
  EffectiveRuntimePolicySnapshot,
  RunBudget,
  ToolExecutionRecord,
  WorkingState,
  ProgressSignal,
  StallPattern,
  RecoveryAction,
  RecoveryDecision,
  RecoveryInput,
  StepExecutionSnapshot,
  TurnExecutionState,
  AskUserRequest,
  AskUserReply,
  AskUserStore,
  AskUserLifecycle,
  AskId,
  Timer,
  TerminationReason,
} from "@ar/contracts";
import type { ContextPipeline, InstructionDiscoveryOptions } from "@ar/context";
import type { ToolSelector } from "../tools/tool-selector.js";
import { estimateMessageTokens, hashPolicyConfig } from "@ar/context";
import { applyWorkingStateMutation, type WorkingStateMutation } from "@ar/contracts";
import { buildStateDigest } from "./turn-helpers.js";
import { AgentError } from "../errors.js";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";
import { ASK_GATE_SPEC } from "./ask-gate.js";
import type { StepToolCatalog } from "./tool-catalog.js";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import { RecoveryPolicy, type FailureKind } from "../recovery/recovery.js";
import {
  activeUserMessages,
  buildResumePrompt,
  classifyUnknownOutcome,
  DEFAULT_RUNTIME_TOOL_SEMANTICS,
  defaultSandboxPolicy,
  isContextOverflowError,
  isEffectiveAgentConfig,
  rethrowIfKill,
  renderToolResult,
  retainMessageHistoryTail,
  toContextBlock,
  trimMessageHistory,
  updateWorkingState,
  workingStateToCompactionSummary,
  ASK_GATE_TOOL,
} from "./turn-helpers.js";
import type {
  FaultPoint,
  FaultPointContext,
  ReconciliationVerdict,
  ResumeResult,
  SkillDiscovery,
  TurnContext,
  TurnOutcome,
} from "./turn-helpers.js";
import { ToolCallController } from "./tool-call-controller.js";
import { RunBudgetTracker } from "./run-budget.js";
import { ReadOnlyPrefetch } from "./read-only-prefetch.js";

/** P1-6: deterministic hash of a policy value (session fingerprinting). */
function stableHashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Carry durable consumption past the snapshot into either recovery path. */
function replayCheckpointBudget(checkpoint: CheckpointData, budget: RunBudget, events: readonly AgentEvent[]): RunBudget {
  // Legacy snapshots cannot identify an interrupted turn. Preserve their
  // checkpoint-only seed rather than attributing another task's journal.
  if (checkpoint.turnId === undefined) return structuredClone(budget);
  const replay = events.filter(event => event.sequence > checkpoint.lastEventSequence &&
    event.turnId === checkpoint.turnId);
  const requested = new Map(replay.filter(event => event.type === "tool.requested")
    .filter(event => typeof event.payload.toolCallId === "string").map(event => [event.payload.toolCallId as string, event]));
  const restored = structuredClone(budget);
  restored.usedToolCalls += [...requested.values()].filter(event => event.payload.name !== "update_plan").length;
  for (const event of replay.filter(event => event.type === "model.completed")) {
    const usage = event.payload.usage as import("@ar/contracts").UsageSnapshot | undefined;
    restored.estimatedCostUsd += usage?.estimatedCostUsd ?? 0;
    if (event.payload.purpose !== "compaction" && typeof event.payload.text === "string") restored.outputChars += event.payload.text.length;
  }
  restored.retries += replay.filter(event => event.type === "model.retry").length;
  return restored;
}

/** PKG-003: deterministic hash of a policy VALUE for drift detection. Object
 *  keys are sorted first, so an equivalent policy built with a different key
 *  insertion order hashes identically — plain [[stableHashOf]] is key-order
 *  sensitive and would report phantom drift. Functions/undefined are dropped,
 *  matching JSON.stringify. */
function stablePolicyHash(value: unknown): string {
  return stableHashOf(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === "function") continue;
      sorted[key] = sortKeysDeep(entry);
    }
    return sorted;
  }
  return value;
}

/** PKG-003: local extension of the frozen runtime-policy snapshot.
 *
 *  Version 1 froze `toolSemanticsHash` as `String(this.toolSemanticsOf.length)`
 *  — the arity constant "1", identical for every host — and had no sandbox
 *  hash at all, while the resume gate compared only `contextPolicyHash`. So a
 *  session resumed under a widened retry/sandbox/tool-semantics policy drifted
 *  silently. Version 2 adds a real tool-semantics table hash plus the sandbox
 *  hash, and the gate compares all four dimensions. Version-1 snapshots keep
 *  the legacy context-only comparison: re-deriving the other dimensions would
 *  report phantom drift for every pre-upgrade session. */
type RuntimePolicySnapshotV2 = Omit<EffectiveRuntimePolicySnapshot, "version"> & {
  version: 2;
  sandboxPolicyHash?: string;
};
import type { ExecutedToolCall } from "./tool-call-controller.js";
import { ContextController } from "./context-controller.js";
import type { ContextUpdate } from "./context-controller.js";
import { ModelCallController, finalizeUsage } from "./model-call-controller.js";
import { VerificationController } from "./verification-controller.js";
import { RecoveryController } from "./recovery-controller.js";

/**
 * P2-41: non-identical stall patterns detected by default. `identical_tool` is
 * excluded — the legacy `maxRepeatedIdenticalToolCalls` gate already owns it.
 * The rest (alternating loop, repeated error, unchanged repeated read,
 * verification fix loop, no-progress churn) were previously invisible.
 */
export const DEFAULT_ENABLED_STALL_PATTERNS: readonly StallPattern[] = [
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
export type { FaultPoint, FaultPointContext, ReconciliationVerdict, TurnOutcome, TurnOutcomeStatus, TurnOutcomeDetail, ResumeResult, SkillSecurityDenialRecord, SkillDiscovery } from "./turn-helpers.js";

export interface AgentRuntimeDeps {
  store: SessionStore;
  events: EventStore;
  /** P26-3: optional durability fence — when wired, the runtime flushes the
   *  event journal through the turn's last event before acking completion, so
   *  an acked turn cannot be lost on crash. The store declares its honest
   *  DurabilityLevel; absent fence = no flush (callers that need it must
   *  wire a JSONL or SQLite store). */
  durabilityFence?: DurabilityFenceStore;
  modelProvider: ModelProvider;
  orchestrator: ToolOrchestrator;
  agents: AgentDefinition[];
  hooks?: HookRegistry;
  maxIterationsPerTurn?: number;
  /** Stall detection (plan.md Phase 2): kill the turn after this many
   *  consecutive identical tool calls (same name+args). Default 3; set 0 to
   *  disable. */
  maxRepeatedIdenticalToolCalls?: number;
  /** E4-R87 (Phase A): ZERO-CALL replay A/B knob. When `false`, the tool-call
   *  controller feeds NO result fingerprint into the identical-call streak, so
   *  `AgentState.noteToolCall(name, args)` keeps the ORIGINAL pre-R86 contract
   *  (streak keyed on name+args only — byte-identical to source SHA e9776ba,
   *  pinned by `agent-state.test.ts`). Used only to replay the pre-R86
   *  mechanism in process for the mandated baseline-vs-candidate A/B;
   *  DEFAULT `true` = the R86 result-aware behavior (no behavior change for
   *  any existing caller). */
  streakResultAware?: boolean;
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
  /** P1-11/P18-1: ToolSemantics lookup — the ONLY execution-policy source.
   *  Retry, concurrency, checkpoint, approval, side-effect reconciliation,
   *  network behavior, output sensitivity and cancellation all derive from
   *  it (or its single projection); the legacy ToolCapability double-truth
   *  is gone. When unset, a built-in registry keeps the historical behavior
   *  for write_file/edit_file/exec; unknown tools are conservatively
   *  side-effecting (fail-closed, never name-matched). */
  toolSemanticsOf?: (toolName: string) => ToolSemantics;
  /** P18-6: per-call resource conflict key (args-derived) — calls sharing a
   *  key are never batched in parallel. Absent → no static conflict split. */
  resourceConflictOf?: (call: import("@ar/contracts").ToolCall) => import("@ar/contracts").ResourceConflictKey | undefined;
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
  /** An existing one-argument callback remains compatible; the host may use
   * current user task identity without changing the runtime's default choice. */
  skillSelector?: (entries: SkillIndexEntry[], context: import("@ar/contracts").SkillSelectionContext) => SkillIndexEntry[];
  /** P23-1: the mutable process tool catalog. READ ONCE at step snapshot
   *  build time to freeze the step's tool world; never consulted mid-step.
   *  (P35-1: the pre-P23 `toolSpecs` advertisement dep is GONE — the only
   *  tool-world input left is this catalog, so there is exactly ONE decision
   *  source for the frozen step router.) */
  toolRegistry?: StepToolCatalog;
  /** P18-2 deferred advertisement policy — applied at step freeze so the
   *  model-visible advertised set (stubs included) is the frozen step's. */
  schemaAdvertPolicy?: import("@ar/contracts").SchemaAdvertPolicy;
  /** P23-4: test-only permissive tool resolution (never set by the harness). */
  permissiveToolResolution?: boolean;
  /** P24-5: resolve the MCP servers THIS step needs (lazy). The provider
   *  returns an immutable McpBindingSnapshot whose tools are frozen into the
   *  step router; a later refresh can only affect NEW steps. P32-4: selected
   *  skills may declare `mcpServers` — the provider forwards them to the
   *  dependency resolver so the step's MCP world includes skill requirements. */
  mcpBindingProvider?: (input: {
    goal: string;
    selectedSkills?: readonly { name: string; requiredMcpServers?: readonly string[] }[];
  }) => Promise<import("@ar/contracts").McpBindingSnapshot | undefined>;
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
  /** P20-1: per-call usage record (with provenance) for tree-budget
   *  accounting. Only the RUNTIME source feeds the scheduler — no separate
   *  usage path may guess different numbers. */
  reportModelUsage?: (sessionId: SessionId, usage: import("@ar/contracts").UsageSnapshot) => void;
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
    /** Optional for older hosts; provided on every new invocation. */
    signal?: AbortSignal;
    /** First instant that exceeds this execution's maxDurationMs. */
    deadline?: number;
  }) => Promise<ContextBlock[]>;
  /** Optional soft timeout: skip memory with an explicit degraded event.
   * The hard turn deadline and cancellation always terminate the turn. */
  memoryRetrievalTimeoutMs?: number;
  /** Feedback for memory accepted by the active turn. This may persist
   * accounting: unlike read-only retrieval, it is fully awaited before the
   * terminal durability fence and is never raced against cancellation. */
  onMemoryRetrieved?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    blocks: readonly ContextBlock[];
  }) => Promise<void>;
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
    skills?: readonly Skill[];
  }) => Promise<ContextBlock[]>;
  /** Awaited after final context admission and overflow checks. These are
   *  the skill body blocks retained for this successful context build, not
   *  discoveries or provider HTTP/retry usage. An abort observed before the
   *  admission hook receives no callback. Host feedback is awaited through
   *  completion even if cancellation arrives during a write. */
  onSkillBodiesAdmitted?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    blocks: readonly ContextBlock[];
  }) => Promise<void>;
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
  }) => Promise<{ delegated: boolean; summary?: string } | undefined>;
}


/** Q-1: result of handleToolResults — tells runTurn what to do next. */
type ToolResultsAction =
  | { action: "continue_loop" }
  | { action: "finish"; outcome: TurnOutcome }
  | { action: "done" };

/** Q-1: per-turn initialization bundle produced by prepareTurn — the immutable
 *  read-only TurnContext plus the fresh mutable accumulators created at turn
 *  start (AgentState, working state, tool execution ledger, and the P15-1
 *  per-turn execution state). */
interface TurnInit {
  ctx: TurnContext;
  state: AgentState;
  turn: Turn;
  working: WorkingState;
  toolLedger: ToolExecutionRecord[];
  /** P15-1: fresh per-turn execution state (recoveryUsage etc.) — created
   *  here and threaded by value; never a runtime/controller field. */
  turnState: TurnExecutionState;
}

/** P16-3: options for runTurn / runTurnCore / prepareTurn. `initialState`
 *  seeds working state from a restored checkpoint (P1-4); the *Seed fields
 *  carry the checkpoint's consumed budget counters forward so a resumed turn
 *  never refreshes model/token/cost/tool/subagent/recovery/stall/verification
 *  budgets (and never inherits ANOTHER turn's). */
export interface RunTurnOptions {
  initialState?: WorkingState;
  budgetSeed?: RunBudget;
  recoveryUsageSeed?: Partial<Record<RecoveryAction, number>>;
  verificationRetriesSeed?: number;
  stallRecoverySeed?: number;
  iterationSeed?: number;
  toolCallsExecutedSeed?: number;
  toolLedgerSeed?: ToolExecutionRecord[];
}

export class AgentRuntime {
  private readonly policyDriftReports = new Map<SessionId, { hash: string; promise: Promise<void> }>();
  private readonly modelSelectionLocks = new Map<SessionId, Promise<unknown>>();
  private readonly publishedModelSelections = new Map<SessionId, string>();
  private readonly terminalReconciliations = new Map<SessionId, Promise<void>>();

  private async withModelSelectionLock<T>(id: SessionId, action: () => Promise<T>): Promise<T> {
    const previous = this.modelSelectionLocks.get(id) ?? Promise.resolve();
    const current = previous.then(action, action);
    this.modelSelectionLocks.set(id, current);
    try { return await current; }
    finally { if (this.modelSelectionLocks.get(id) === current) this.modelSelectionLocks.delete(id); }
  }

  /** The row is the commit point. A crash before the event append is replayed
   * from this outbox before another selection or model request is admitted.
   * The stable ID also handles an append that committed before throwing. */
  private async publishModelSelection(session: Session): Promise<void> {
    const selection = session.modelSelection;
    if (selection === undefined) return;
    const validModel = (value: ModelRef) => value !== null && typeof value === "object"
      && typeof value.providerId === "string" && value.providerId.length > 0
      && typeof value.modelId === "string" && value.modelId.length > 0;
    if (selection.version !== 1 || !validModel(selection.initialModel) || !validModel(selection.model)
      || selection.model.providerId !== session.model.providerId || selection.model.modelId !== session.model.modelId
      || typeof selection.eventId !== "string" || !selection.eventId || !Number.isFinite(selection.timestamp) || selection.timestamp < 0) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "corrupt durable session model selection"));
    }
    if (this.publishedModelSelections.get(session.id) === selection.eventId) return;
    const existing = (await this.events.list(session.id)).find(event => event.id === selection.eventId);
    const payload = { hostOnly: true, kind: "web_model_selection",
      selection: { provider: selection.model.providerId, model: selection.model.modelId } };
    if (existing !== undefined) {
      if (existing.type !== "human.message" || existing.timestamp !== selection.timestamp
        || stableHashOf(existing.payload) !== stableHashOf(payload)) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", "conflicting durable session model selection event"));
      }
    } else {
      await this.events.appendNew({ id: selection.eventId, sessionId: session.id,
        timestamp: selection.timestamp, type: "human.message", payload });
    }
    this.publishedModelSelections.set(session.id, selection.eventId);
  }

  private readonly store: SessionStore;
  private readonly events: EventStore;
  private readonly modelProvider: ModelProvider;
  private readonly orchestrator: ToolOrchestrator;
  private readonly hooks: HookRegistry;
  private readonly agents: ReadonlyMap<AgentId, AgentDefinition>;
  private readonly maxIterationsPerTurn: number;
  private readonly maxRepeatedIdenticalToolCalls: number;
  /** E4-R87 (Phase A): replay-only knob (see AgentRuntimeDeps). */
  private readonly streakResultAware: boolean;
  private readonly maxStallRecoveries: number;
  /** P2-41: non-identical stall patterns the runtime actively detects. */
  private readonly enabledStallPatterns: ReadonlySet<StallPattern>;
  /** P2-41: recovery budget for pattern-based stalls. */
  private readonly maxPatternStallRecoveries: number;
  private readonly maxVerificationFailures: number;
  private readonly maxParallelToolCalls: number;
  private readonly toolSemanticsOf?: (toolName: string) => ToolSemantics;
  private readonly resourceConflictOf?: (call: import("@ar/contracts").ToolCall) => import("@ar/contracts").ResourceConflictKey | undefined;
  private readonly toolOutputBudget?: AgentRuntimeDeps["toolOutputBudget"];
  private readonly artifactStore?: ArtifactStore;
  private readonly outputRedactor?: AgentRuntimeDeps["outputRedactor"];
  private readonly injectionDetector?: AgentRuntimeDeps["injectionDetector"];
  private readonly inbox?: InboxStore;
  private readonly reportModelUsage?: (sessionId: SessionId, usage: import("@ar/contracts").UsageSnapshot) => void;
  private readonly now: () => number;
  /** Q-7: injectable timer driving retry-backoff sleeps. */
  private readonly timer: Timer;
  private readonly sandboxPolicy?: SandboxPolicy;
  private readonly context?: AgentRuntimeDeps["context"];
  private readonly task?: TaskSpec;
  private readonly verifier?: Verifier;
  private readonly verificationPlanner?: AgentRuntimeDeps["verificationPlanner"];
  private readonly recovery?: RecoveryPolicy;
  /** P2-42: adaptive recovery planner (bounded action budgets). */
  private readonly adaptiveRecovery?: AdaptiveRecoveryPlanner;
  private readonly skills?: AgentRuntimeDeps["skills"];
  private readonly skillSelector?: AgentRuntimeDeps["skillSelector"];
  private readonly onSkillBodiesAdmitted?: AgentRuntimeDeps["onSkillBodiesAdmitted"];
  /** P2-8: loads skill bodies for the selected skills (progressive disclosure). */
  private readonly skillBodyBlocks?: AgentRuntimeDeps["skillBodyBlocks"];
  /** P2-2: pre-turn memory retrieval (memory prior blocks + memory.retrieved). */
  private readonly memoryBlocks?: AgentRuntimeDeps["memoryBlocks"];
  private readonly memoryRetrievalTimeoutMs?: number;
  private readonly onMemoryRetrieved?: AgentRuntimeDeps["onMemoryRetrieved"];
  private readonly memoryPrefetch: ReadOnlyPrefetch;
  /** P2-5: post-turn reflection hook (never alters the turn result). */
  private readonly onTurnComplete?: AgentRuntimeDeps["onTurnComplete"];
  /** P26-3: optional durability fence — flushed before turn completion ack. */
  private readonly durabilityFence?: AgentRuntimeDeps["durabilityFence"];
  /** P3-9: host-provided specialist delegation for adaptive recovery. */
  private readonly delegateSpecialist?: AgentRuntimeDeps["delegateSpecialist"];
  /** P23-3/P35-1: the frozen step router is the ONLY tool-world authority —
   *  advertisement and execution both consume the step snapshot; the catalog
   *  is read once at snapshot build time and never consulted mid-step. */
  private readonly toolRegistry?: StepToolCatalog;
  private readonly schemaAdvertPolicy?: import("@ar/contracts").SchemaAdvertPolicy;
  private readonly permissiveToolResolution?: boolean;
  private readonly mcpBindingProvider?: (input: { goal: string; selectedSkills?: readonly { name: string; requiredMcpServers?: readonly string[] }[] }) => Promise<import("@ar/contracts").McpBindingSnapshot | undefined>;
  private readonly toolSelector?: ToolSelector;
  private readonly changedPathsProvider?: () => readonly string[];
  private readonly baselineFilesProvider?: () => readonly string[];
  /** P1-20: cumulative compaction count (observability metric). Q-1: boxed
   *  so the context + model-call controllers share it by reference. */
  private readonly compactCounter = { value: 0 };
  /** P25-3: per-session running-turn guard — at most ONE active turn per
   *  session, enforced at the runtime boundary (the SessionActor owns the
   *  authority, this map defends against bypassing callers). */
  private readonly runningTurns = new Map<SessionId, TurnId>();
  /** Successful completion closes admission before its first awaited commit. */
  private readonly closingTurns = new Map<SessionId, TurnId>();
  private readonly checkpointStore?: CheckpointStore;
  private readonly checkpointPolicy: CheckpointPolicy;
  /** P16-3: live per-turn budget-usage provider (set by runTurnCore so every
   *  checkpoint writer sees the CURRENT consumed counters). Undefined outside
   *  a turn. */
  private readonly activeBudgetUsage = new Map<SessionId, () => CheckpointBudgetUsage>();
  private readonly pausedTurns = new Map<TurnId, { sessionId: SessionId; askId: AskId; options: RunTurnOptions }>();
  private readonly failpoint?: AgentRuntimeDeps["failpoint"];
  /** P2-43: ask-user gate — durable store, handler, and pure lifecycle. */
  private readonly askUserStore?: AskUserStore;
  /** Serialize reply injection per ask within this single-writer Runtime. */
  private readonly userAnswerSubmissions = new Map<AskId, Promise<void>>();
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
    this.streakResultAware = deps.streakResultAware ?? true;
    this.maxStallRecoveries = deps.maxStallRecoveries ?? 1;
    this.enabledStallPatterns = new Set(
      deps.enabledStallPatterns ?? DEFAULT_ENABLED_STALL_PATTERNS,
    );
    this.maxPatternStallRecoveries = deps.maxPatternStallRecoveries ?? 1;
    this.maxVerificationFailures = deps.maxVerificationFailures ?? 3;
    this.maxParallelToolCalls = deps.maxParallelToolCalls ?? 4;
    this.toolSemanticsOf = deps.toolSemanticsOf;
    this.resourceConflictOf = deps.resourceConflictOf;
    this.toolOutputBudget = deps.toolOutputBudget;
    this.artifactStore = deps.artifactStore;
    this.outputRedactor = deps.outputRedactor;
    this.injectionDetector = deps.injectionDetector;
    this.inbox = deps.inbox;
    this.reportModelUsage = deps.reportModelUsage;
    this.now = deps.now ?? Date.now;
    this.timer = deps.timer ?? new RealTimer(this.now);
    this.memoryPrefetch = new ReadOnlyPrefetch(this.timer, this.now);
    this.sandboxPolicy = deps.sandboxPolicy;
    this.context = deps.context;
    this.task = deps.task;
    this.verifier = deps.verifier;
    this.verificationPlanner = deps.verificationPlanner;
    this.recovery = deps.recovery;
    this.adaptiveRecovery = deps.adaptiveRecovery;
    this.skills = deps.skills;
    this.skillSelector = deps.skillSelector;
    this.skillBodyBlocks = deps.skillBodyBlocks;
    this.onSkillBodiesAdmitted = deps.onSkillBodiesAdmitted;
    this.memoryBlocks = deps.memoryBlocks;
    if (deps.memoryRetrievalTimeoutMs !== undefined &&
      (!Number.isFinite(deps.memoryRetrievalTimeoutMs) || deps.memoryRetrievalTimeoutMs < 0)) {
      throw new RangeError("memoryRetrievalTimeoutMs must be a finite nonnegative number");
    }
    this.memoryRetrievalTimeoutMs = deps.memoryRetrievalTimeoutMs;
    this.onMemoryRetrieved = deps.onMemoryRetrieved;
    this.onTurnComplete = deps.onTurnComplete;
    this.durabilityFence = deps.durabilityFence;
    this.delegateSpecialist = deps.delegateSpecialist;
    this.toolRegistry = deps.toolRegistry;
    this.schemaAdvertPolicy = deps.schemaAdvertPolicy;
    this.permissiveToolResolution = deps.permissiveToolResolution;
    this.mcpBindingProvider = deps.mcpBindingProvider;
    this.toolSelector = deps.toolSelector;
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
      emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
      now: () => this.now(),
      checkpointStore: this.checkpointStore,
      askUserStore: this.askUserStore,
      askUser: this.askUser,
      semanticsOf: (name) => this.semanticsOf(name),
      // P26-8: crash injection for the turn-completion windows.
      failAt: (point, ctx) => this.failAt(point, ctx),
    });
    // Q-1: tool-call execution delegated to the extracted controller. All
    // bindings are captured once (fields are readonly); per-turn mutable state
    // (P15-1 recoveryUsage) is threaded by VALUE into executeToolCalls — it is
    // never a controller field, so turns/sessions cannot pollute each other.
    this.toolCallController = new ToolCallController({
      denialAlreadyReported: async (sessionId, turnId, callId) => (await this.events.list(sessionId)).some(event =>
        event.turnId === turnId && typeof event.type === "string" && event.type.startsWith("security.")
        && event.type.endsWith("_denied") && event.payload.toolCallId === callId),
      orchestrator: this.orchestrator,
      store: this.store,
      hooks: this.hooks,
      emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
      failAt: (point, ctx) => this.failAt(point, ctx),
      now: () => this.now(),
      timer: this.timer,
      sandboxPolicy: this.sandboxPolicy,
      recovery: this.recovery,
      adaptiveRecovery: this.adaptiveRecovery,
      toolSemanticsOf: (name) => this.semanticsOf(name),
      resourceConflictOf: this.resourceConflictOf,
      maxParallelToolCalls: this.maxParallelToolCalls,
      streakResultAware: this.streakResultAware,
      delegateSpecialist: this.delegateSpecialist,
    });
    // Q-1: context pipeline + steering + tool-output rendering delegated to
    // the extracted controller. `compactCounter` is shared by reference with
    // the model-call controller (reactive compaction).
    this.contextController = new ContextController({
      store: this.store,
      emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
      now: () => this.now(),
      failAt: (point, ctx) => this.failAt(point, ctx),
      context: this.context,
      skills: this.skills,
      skillSelector: this.skillSelector,
      skillBodyBlocks: this.skillBodyBlocks,
      onSkillBodiesAdmitted: this.onSkillBodiesAdmitted,
      recovery: this.recovery,
      compactCounter: this.compactCounter,
      checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) =>
        this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason,
          { maxTokens: this.context?.budget.maxTokens ?? 0, ...this.activeBudgetUsage.get(ctx.sessionId)?.(), ...budgetUsage }),
      finishTurn: (ctx, status, state, working, error, terminationReason, ledger, completionEvidence) =>
        this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger, completionEvidence),
      toolOutputBudget: this.toolOutputBudget,
      outputRedactor: this.outputRedactor,
      artifactStore: this.artifactStore,
      semanticsOf: (name) => this.semanticsOf(name),
      injectionDetector: this.injectionDetector,
      inbox: this.inbox,
    });
    // Q-1: verification gate delegated to the extracted controller.
    this.verificationController = new VerificationController({
      executeCommand: async (ctx, spec) => {
        if (!isToolAllowedByPolicy(ctx.agent.tools, "exec")) {
          return { status: "denied", error: errorInfo("PERMISSION_DENIED", "verification exec is excluded by the session tool policy") };
        }
        const definition = this.toolRegistry?.get("exec");
        if (definition === undefined) {
          return { status: "denied", error: errorInfo("TOOL_SCHEMA_ERROR", "verification requires a registered exec tool") };
        }
        const id = newToolCallId();
        const args = { command: spec.command, ...(spec.args !== undefined ? { args: [...spec.args] } : {}), timeoutMs: 120_000 };
        const call: ToolCall = { id, name: "exec", args };
        // Thinking APIs require a reasoning field on every assistant tool-call
        // record in a thinking conversation. A host command has no generated
        // chain: send an empty field only after this provider actually emitted
        // reasoning, preserving the plain OpenAI wire shape otherwise.
        const thinkingConversation = (await this.store.listMessages(ctx.sessionId))
          .some(message => message.role === "assistant" && message.reasoningContent !== undefined);
        // A host verification command is a real tool execution. Preserve its
        // request/result pair so the next model call can diagnose a failure;
        // never promote captured stdout/stderr into a system instruction.
        await this.store.appendMessage({ id: newMessageId(), sessionId: ctx.sessionId, turnId: ctx.turnId,
          role: "assistant", content: "", toolCalls: [call], ...(thinkingConversation ? { reasoningContent: "" } : {}), createdAt: this.now() });
        let result: ToolResult;
        try { result = await this.orchestrator.executeBound({
          id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agent.id,
          call: { id, name: "exec", args },
          binding: {
            name: "exec", spec: { name: "exec", description: definition.description, inputSchema: { type: "object" } },
            definition: { ...definition, execute: (input, context) => context.sandboxPolicy.filesystem.mode === "read-only"
              ? Promise.resolve({ status: "denied", error: errorInfo("SANDBOX_DENIED", "verification process cannot run in a read-only workspace") })
              : definition.execute(input, context) },
            semantics: this.semanticsOf("exec"), provenance: { kind: "builtin" },
          },
        }, {
          sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agent.id,
          cwd: ctx.session.cwd, signal: ctx.signal,
          permissions: ctx.agent.permissions, sandboxPolicy: this.sandboxPolicy ?? defaultSandboxPolicy(),
        }); } catch (error) {
          rethrowIfKill(error);
          result = { status: "failed", error: errorInfo("INTERNAL_ERROR", error instanceof Error ? error.message : String(error)) };
        }
        const content = await this.contextController.renderToolResultForContext(ctx, call, result);
        await this.store.appendMessage({ id: newMessageId(), sessionId: ctx.sessionId, turnId: ctx.turnId,
          role: "tool", content, toolCallId: id, createdAt: this.now() });
        return result as ToolResult<{ exitCode: number | null; durationMs: number }>;
      },
      task: this.task,
      verifier: this.verifier,
      store: this.store,
      now: () => this.now(),
      changedPathsProvider: this.changedPathsProvider,
      baselineFilesProvider: this.baselineFilesProvider,
      ...(this.verificationPlanner !== undefined
        ? { planVerification: this.verificationPlanner }
        : {}),
    });
    // Q-1: model-call + post-completion delegated to the extracted
    // controller. runVerificationGate is bound to the verification
    // controller; checkpoint/finishTurn/parkForUserInput/wallClockExceeded
    // are bound to the runtime (they are recovery/recovery-adjacent and stay
    // on AgentRuntime to avoid a controller ↔ runtime cycle).
    this.modelCallController = new ModelCallController({
      store: this.store,
      emit: (sessionId, type, payload, turnId, spans) => this.emit(sessionId, type, payload, turnId, spans),
      now: () => this.now(),
      failAt: (point, ctx) => this.failAt(point, ctx),
      recovery: this.recovery,
      timer: this.timer,
      compactCounter: this.compactCounter,
      maxVerificationFailures: this.maxVerificationFailures,
      afterVerificationCheckpoint: this.checkpointPolicy.afterVerification,
      contextBudgetMaxTokens: this.context?.budget.maxTokens ?? 0,
      checkpoint: (ctx, working, state, toolLedger, reason, budgetUsage) =>
        this.recoveryController.checkpoint(ctx, working, state, toolLedger, reason,
          { maxTokens: this.context?.budget.maxTokens ?? 0, ...this.activeBudgetUsage.get(ctx.sessionId)?.(), ...budgetUsage }),
      finishTurn: (ctx, status, state, working, error, terminationReason, ledger, completionEvidence) =>
        this.recoveryController.finishTurn(ctx, status, state, working, error, terminationReason, ledger, completionEvidence),
      parkForUserInput: async (ctx, state, working, call, ledger) => {
        const outcome = await this.recoveryController.parkForUserInput(ctx, state, working, call, ledger);
        const usage = this.activeBudgetUsage.get(ctx.sessionId)?.();
        const options: RunTurnOptions = {
          initialState: structuredClone(working), toolLedgerSeed: structuredClone(ledger),
          iterationSeed: state.getIteration(), toolCallsExecutedSeed: state.getToolCallsExecuted(),
          ...(usage?.run !== undefined ? { budgetSeed: structuredClone(usage.run) } : {}),
          ...(usage?.recoveryUsage !== undefined ? { recoveryUsageSeed: { ...usage.recoveryUsage } } : {}),
          verificationRetriesSeed: usage?.verificationRetries, stallRecoverySeed: usage?.stallRecoveryCount,
        };
        // The live fallback also survives a failed checkpoint write. Across a
        // process restart, only an intact checkpoint for this exact pause is
        // accepted; an earlier side-effect checkpoint is not a substitute.
        this.pausedTurns.set(ctx.turnId, { sessionId: ctx.sessionId, askId: outcome.pendingAsk!.id, options });
        await this.recoveryController.checkpoint(ctx, working, state, ledger, `ask:waiting:${outcome.pendingAsk!.id}`, usage);
        if (ctx.signal.aborted) {
          const cancelled = await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", ledger);
          const ask = await this.askUserStore?.get(outcome.pendingAsk!.id);
          if (ask?.status === "pending") await this.askUserStore!.markWithdrawn(ask.id);
          return cancelled;
        }
        return outcome;
      },
      runVerificationGate: (ctx) => this.verificationController.runVerificationGate(ctx),
      hasPendingSteering: (ctx) => this.hasPendingSteering(ctx),
      closeSteeringForCompletion: async (ctx) => {
        // Close synchronously, before durable reads can yield to an admission.
        // A correction already visible belongs to this turn and reopens its
        // existing bounded loop. Later admissions cannot be acknowledged.
        this.closingTurns.set(ctx.sessionId, ctx.turnId);
        if (await this.hasPendingSteering(ctx)) {
          this.closingTurns.delete(ctx.sessionId);
          return false;
        }
        return true;
      },
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
    spans?: { spanId?: string; parentSpanId?: string },
  ): Promise<AgentEvent> {
    // P26-1: sequence allocation is store-owned and atomic (appendNew) — the
    // caller must NEVER allocate via nextSequence + append (non-atomic pair).
    return this.events.appendNew({
      id: newEventId(),
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(spans?.spanId !== undefined ? { spanId: spans.spanId } : {}),
      ...(spans?.parentSpanId !== undefined ? { parentSpanId: spans.parentSpanId } : {}),
      timestamp: this.now(),
      type,
      payload,
    });
  }

  async createSession(opts: {
    agent: AgentDefinition;
    cwd: string;
    parentId?: SessionId;
    /** Used by a host copying branch history; it publishes active only after
     * completing that copy. Failed initialization stays unrunnable. */
    initialStatus?: "active" | "failed";
  }): Promise<Session> {
    if (!this.agents.has(opts.agent.id)) {
      if (opts.parentId === undefined) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${opts.agent.id}`));
      // A durable parent can outlive the host's freshly allocated registry ID.
      // Branch only its validated effective policy; the parent is not a permit
      // to create an arbitrary unknown/wider agent after restart.
      const parentAgent = await this.getSessionAgent(opts.parentId);
      if (parentAgent === undefined || stablePolicyHash(snapshotEffectiveConfig(parentAgent)) !== stablePolicyHash(snapshotEffectiveConfig(opts.agent))) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown or mismatched inherited agent ${opts.agent.id}`));
      }
    }
    const session: Session = {
      id: newSessionId(),
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      agentId: opts.agent.id,
      model: opts.agent.model,
      cwd: opts.cwd,
      // Persist an unrunnable placeholder before the policy snapshot. A
      // crash/I/O error here must not leave a legacy-fallback active session.
      status: "failed",
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
      // Retain display metadata when a fresh host assigns new registry IDs.
      // Effective policy remains exclusively in the validated config above.
      agentMetadata: { version: 1, agentId: opts.agent.id, name: opts.agent.name,
        description: opts.agent.description, mode: opts.agent.mode },
      // P1-6: freeze the runtime policy hashes too, so a resume can detect
      // host-policy drift (safe-resume gate). PKG-003: one builder for both
      // sides of the comparison — see [[runtimePolicySnapshot]].
      [RUNTIME_POLICY_SNAPSHOT_KEY]: this.runtimePolicySnapshot(),
    });
    const initialized: Session = { ...session, status: opts.initialStatus ?? "active" };
    await this.store.updateSession(initialized);
    await this.emit(session.id, "session.created", { sessionId: session.id, agentId: session.agentId });
    await this.hooks.dispatch("session_start", {
      sessionId: session.id,
      agentId: session.agentId,
      timestamp: this.now(),
    });
    return initialized;
  }

  async startTurn(sessionId: SessionId, text: string): Promise<Turn> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    if (session.status !== "active") {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${sessionId} is ${session.status}`));
    }
    // Finish a previously committed outcome before admitting a new prompt.
    await this.reconcileTerminalTurns(sessionId);
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

  /** Settle an actor reservation revoked before execution. This is a durable
   * cancellation only: it never enters the model/tool loop or refunds budgets.
   * A previously started turn must use its ordinary cancellation/recovery path. */
  async cancelUnstartedTurn(sessionId: SessionId, turnId: TurnId): Promise<TurnOutcome> {
    if (this.runningTurns.has(sessionId)) throw new AgentError(errorInfo("SESSION_BUSY", `session ${sessionId} already has an active turn`));
    this.runningTurns.set(sessionId, turnId);
    try {
      const session = await this.store.getSession(sessionId), turn = await this.store.getTurn(turnId);
      if (session === undefined || turn === undefined || turn.sessionId !== sessionId) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `turn ${turnId} does not belong to session ${sessionId}`));
      }
      if (turn.status === "running" && (await this.events.list(sessionId)).some(event => event.turnId === turnId
        && (event.type === "model.started" || event.type === "tool.requested"))) {
        throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} has already started; refusing an unstarted cancellation`));
      }
      if (turn.status === "waiting_for_user" || turn.status === "waiting_for_approval") {
        throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} is paused; use the ordinary cancellation path`));
      }
      const agent = await this.resolveAgent(session);
      const state = new AgentState(sessionId, agent.id, this.now); state.beginTurn(turnId);
      const outcome = await this.recoveryController.finishTurn({ sessionId, turnId, session, agent, signal: new AbortController().signal },
        "cancelled", state, newWorkingState(turn.input.text), undefined, "cancelled", []);
      await this.flushDurability(sessionId);
      return outcome;
    } finally {
      if (this.runningTurns.get(sessionId) === turnId) this.runningTurns.delete(sessionId);
    }
  }

  /** Cancel only a genuine recoverable user pause. Restore its actual ledger
   * and progress without entering execution, model/verification limits, memory
   * retrieval, reflection or the sampling loop. Spent budgets remain intact. */
  async cancelPausedTurn(sessionId: SessionId, turnId: TurnId): Promise<TurnOutcome> {
    if (this.runningTurns.has(sessionId)) throw new AgentError(errorInfo("SESSION_BUSY", `session ${sessionId} already has an active turn`));
    this.runningTurns.set(sessionId, turnId);
    try {
      const turn = await this.store.getTurn(turnId);
      if (turn === undefined || turn.sessionId !== sessionId || turn.status !== "waiting_for_user") {
        await this.reconcileTerminalTurns(sessionId);
        throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} is not a recoverable user pause`));
      }
      const signal = AbortSignal.abort();
      const options = await this.restoreQuestionPause(sessionId, turnId, signal);
      const { ctx, state, working, toolLedger } = await this.prepareTurn(sessionId, turnId, signal, options);
      const outcome = await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
      this.pausedTurns.delete(turnId);
      await this.flushDurability(sessionId);
      return outcome;
    } finally {
      if (this.runningTurns.get(sessionId) === turnId) this.runningTurns.delete(sessionId);
    }
  }

  /** Actor admission query; this grants no authority to execute or mutate. */
  isSteeringOpen(sessionId: SessionId, turnId: TurnId): boolean {
    return this.runningTurns.get(sessionId) === turnId && this.closingTurns.get(sessionId) !== turnId;
  }

  private async hasPendingSteering(ctx: TurnContext): Promise<boolean> {
    const prompts = await this.inbox?.listRecoverable(ctx.sessionId) ?? [];
    return prompts.some(prompt => prompt.kind === "steer" &&
      (prompt.promotedTurnId === undefined || prompt.promotedTurnId === ctx.turnId));
  }

  /** Execute one turn: model round-trips + tool calls, bounded and cancellable.
   *  `opts.initialState` seeds the working state from a restored checkpoint
   *  (P1-4 resume) instead of the turn input text.
   *
   *  P25-3: a session may run at most ONE turn at a time. A concurrent
   *  runTurn for the same session (any turnId) throws SESSION_BUSY — the
   *  SessionActor is the lifecycle authority and this guard defends the
   *  boundary against direct callers. Different sessions run concurrently. */
  async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    signal: AbortSignal,
    opts: RunTurnOptions = {},
  ): Promise<TurnOutcome> {
    const existing = this.runningTurns.get(sessionId);
    if (existing !== undefined) {
      throw new AgentError(
        errorInfo("SESSION_BUSY", `session ${sessionId} already has an active turn (${existing})`),
      );
    }
    this.runningTurns.set(sessionId, turnId);
    try {
      const stored = await this.store.getTurn(turnId);
      if (stored?.sessionId !== sessionId) throw new AgentError(errorInfo("INTERNAL_ERROR", `turn ${turnId} does not belong to session ${sessionId}`));
      await this.reconcileTerminalTurns(sessionId);
      if (stored.terminalOutcome !== undefined || stored.status === "completed" || stored.status === "cancelled") throw new AgentError(errorInfo("INTERNAL_ERROR", `turn ${turnId} is terminal (${stored.status}); create a new turn instead of replaying it`));
      const continuing = stored.status === "waiting_for_user";
      const restoration = continuing ? { options: await this.restoreQuestionPause(sessionId, turnId, signal), continuing: true }
        : await this.restoreInterruptedTurn(sessionId, turnId, opts);
      const outcome = await this.runTurnCore(sessionId, turnId, signal, restoration.options, restoration.continuing);
      if (outcome.status !== "waiting_for_user") this.pausedTurns.delete(turnId);
      // P2-5: post-turn reflection hook — fired exactly once per terminal
      // outcome (the host owns the reflection pipeline). Errors are swallowed:
      // reflection must never change the turn result.
      if (this.onTurnComplete !== undefined && outcome.status !== "waiting_for_user" && outcome.status !== "waiting_for_approval") {
        try {
          await this.onTurnComplete({ sessionId, turnId, outcome });
        } catch (cause) {
          process.stderr.write(
            `[runtime] onTurnComplete failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
        }
      }
      // P26-3 / PKG-002: fence the journal BEFORE acking completion — an acked
      // turn must survive a crash at the store's declared durability level. A
      // fence failure fails the turn (fail-closed): the caller must not treat
      // an un-flushed completion as durable.
      //
      // The fence is handed the turn's REAL last committed sequence: the old
      // `Number.MAX_SAFE_INTEGER` sentinel was unverifiable by every store
      // (`WHERE sequence = MAX_SAFE_INTEGER` never matches), so the guard
      // degraded to a bare WAL checkpoint and could never fail. A session with
      // no committed events has nothing to fence.
      await this.flushDurability(sessionId);
      return outcome;
    } finally {
      this.activeBudgetUsage.delete(sessionId);
      if (this.closingTurns.get(sessionId) === turnId) this.closingTurns.delete(sessionId);
      if (this.runningTurns.get(sessionId) === turnId) {
        this.runningTurns.delete(sessionId);
      }
    }
  }

  private async flushDurability(sessionId: SessionId): Promise<void> {
    if (this.durabilityFence === undefined) return;
    try {
      const lastCommitted = (await this.events.nextSequence(sessionId)) - 1;
      if (lastCommitted >= 0) await this.durabilityFence.flushThrough(sessionId, lastCommitted);
    } catch (error) {
      this.recoveryController.invalidateTerminalSession(sessionId);
      throw error;
    }
  }

  /** The actor recovers an existing durable turn through runTurn, using the
   * same checkpoint/replay state as explicit resume instead of fresh budgets. */
  private async restoreInterruptedTurn(sessionId: SessionId, turnId: TurnId, opts: RunTurnOptions): Promise<{ options: RunTurnOptions; continuing: boolean }> {
    if (opts.initialState !== undefined) return { options: opts, continuing: false };
    let checkpoint = await this.checkpointStore?.loadLatest(sessionId);
    if (checkpoint?.turnId !== turnId) checkpoint = (await this.checkpointStore?.list(sessionId))?.find(candidate => candidate.turnId === turnId);
    if (checkpoint === undefined) {
      const alreadyExecuted = (await this.events.list(sessionId)).some(event => event.turnId === turnId &&
        (event.type === "model.started" || event.type === "tool.requested"));
      if (alreadyExecuted) throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} was interrupted without a durable checkpoint; refusing to reset task state or budget`));
      return { options: opts, continuing: false }; // A created, never-executed turn.
    }
    const usage = checkpoint.budgetUsage;
    if (usage?.run === undefined) throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} has no intact checkpoint budget; refusing to reset consumed limits`));
    const recovered = await this.recoveryController.reconstructResumeState(sessionId, turnId, checkpoint);
    for (const unresolved of recovered.unresolvedTools) {
      const verdict = classifyUnknownOutcome(unresolved.tool, this.semanticsOf(unresolved.tool));
      await this.emit(sessionId, "retry.reconciliation", { toolCallId: unresolved.toolCallId, tool: unresolved.tool,
        sideEffect: unresolved.sideEffect, sideEffectScope: unresolved.sideEffectScope,
        started: unresolved.started, decision: verdict.decision, reason: verdict.reason }, turnId);
    }
    if (recovered.unresolvedTools.length > 0) throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} has unresolved tool outcomes; reconciliation is required before same-turn recovery`));
    const turnEvents = (await this.events.list(sessionId)).filter(event => event.turnId === turnId);
    const replay = turnEvents.filter(event => event.sequence > checkpoint.lastEventSequence);
    // A successful verification checkpoint can cover the final completed
    // sampling before the controller advances its live iteration counter.
    // Durable completions are a lower bound; do not refund that sample when
    // terminal persistence crashes. Compaction is an auxiliary model purpose.
    const completedThroughCheckpoint = turnEvents.filter(event => event.sequence <= checkpoint.lastEventSequence &&
      event.type === "model.completed" && event.payload.purpose !== "compaction").length;
    const modelCompletions = replay.filter(event => event.type === "model.completed" && event.payload.purpose !== "compaction");
    const budgetSeed = replayCheckpointBudget(checkpoint, usage.run, turnEvents);
    const failedVerifications = replay.filter(event => event.type === "verification.failed");
    return { continuing: true, options: { ...opts, initialState: recovered.working,
      toolLedgerSeed: [...checkpoint.toolLedger, ...recovered.replayedToolLedger],
      iterationSeed: Math.max(checkpoint.iteration, completedThroughCheckpoint) + modelCompletions.length,
      toolCallsExecutedSeed: (checkpoint.toolCallsExecuted ?? checkpoint.toolLedger.length) + recovered.replayedToolLedger.length,
      budgetSeed, recoveryUsageSeed: usage.recoveryUsage,
      verificationRetriesSeed: (usage.verificationRetries ?? 0) + failedVerifications.length,
      stallRecoverySeed: usage.stallRecoveryCount } };
  }

  private async restoreQuestionPause(sessionId: SessionId, turnId: TurnId, signal: AbortSignal): Promise<RunTurnOptions> {
    let pause = this.pausedTurns.get(turnId);
    if (pause === undefined) {
      const checkpoint = await this.checkpointStore?.loadLatest(sessionId);
      if (checkpoint?.sessionId !== sessionId || checkpoint.turnId !== turnId || checkpoint.phase !== "waiting_user" ||
          !checkpoint.reason.startsWith("ask:waiting:") || checkpoint.toolCallsExecuted === undefined || checkpoint.budgetUsage?.run === undefined) {
        throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} has no intact question-pause checkpoint; refusing to reset task state or budget`));
      }
      const usage = checkpoint.budgetUsage;
      pause = { sessionId, askId: checkpoint.reason.slice("ask:waiting:".length) as AskId, options: {
        initialState: checkpoint.state, toolLedgerSeed: checkpoint.toolLedger,
        iterationSeed: checkpoint.iteration, toolCallsExecutedSeed: checkpoint.toolCallsExecuted, budgetSeed: usage.run,
        recoveryUsageSeed: usage.recoveryUsage, verificationRetriesSeed: usage.verificationRetries, stallRecoverySeed: usage.stallRecoveryCount,
      } };
    }
    if (pause.sessionId !== sessionId) throw new AgentError(errorInfo("RESUME_FAILED", "question-pause session mismatch"));
    if (!signal.aborted) {
      const reply = (await this.store.listMessages(sessionId)).some(message => message.turnId === turnId && message.role === "user" && message.askId === pause.askId);
      if (!reply) throw new AgentError(errorInfo("RESUME_FAILED", `turn ${turnId} is still waiting for the user answer`));
    }
    return structuredClone(pause.options);
  }

  /** Actor cancellation of a parked turn has no run promise to clean it up. */
  async releasePausedTurn(sessionId: SessionId, turnId: TurnId): Promise<void> {
    const turn = await this.store.getTurn(turnId);
    if (turn?.sessionId === sessionId && (turn.status === "cancelled" || turn.status === "completed" || turn.status === "failed")) this.pausedTurns.delete(turnId);
  }

  /** P2-5: runTurn body (the wrapper fires the post-turn reflection hook).
   *  Model round-trips + tool calls, bounded and cancellable. */
  private async runTurnCore(
    sessionId: SessionId,
    turnId: TurnId,
    signal: AbortSignal,
    opts: RunTurnOptions = {},
    continuing = false,
  ): Promise<TurnOutcome> {
    // Q-1: turn initialization extracted to prepareTurn (session/agent/turn
    // resolution, TurnContext, AgentState, working state, tool ledger).
    const { ctx, state, turn: storedTurn, working, toolLedger, turnState } = await this.prepareTurn(sessionId, turnId, signal, opts);

    const priorBlocks: ContextBlock[] = [];
    let overflowAttempt = 0;
    let verificationFailures = opts.verificationRetriesSeed ?? 0;
    let reactiveCompacted = false;
    // The retry guard lasts for the whole turn; the actual history rewrite
    // is requested only for the next preparation after confirmed overflow.
    let reactiveCompactionPending = false;
    let digestAppended = false;
    let lastReportTokens: number | undefined;
    // P0-10/R6: preparation consumes the same execution duration as the
    // model loop; retrieval must not reset the turn's clock.
    const budget = new RunBudgetTracker(ctx.agent.limits, this.now, continuing ? opts.budgetSeed : undefined);
    // Keep the durable turn's original timestamp. Model execution deadlines
    // use the same active-time clock as the restored budget, excluding the
    // human-input wait rather than treating it as model execution.
    const turn = continuing ? { ...storedTurn, startedAt: budget.snapshot().startedAt } : storedTurn;
    // P16-3: a resumed turn seeds its consumed counters from the checkpoint —
    // budget is NEVER refreshed on resume.
    if (opts.budgetSeed !== undefined) budget.seedConsumed(opts.budgetSeed);
    // P16-3: expose the live per-turn budget usage to checkpoint writers.
    this.activeBudgetUsage.set(sessionId, () => ({
      maxTokens: this.context?.budget.maxTokens ?? 0,
      ...(lastReportTokens !== undefined ? { usedTokens: lastReportTokens } : {}),
      run: budget.snapshot(),
      recoveryUsage: turnState.recoveryUsage,
      verificationRetries: verificationFailures,
      stallRecoveryCount: state.stallRecoveriesUsedCount,
    }));
    // P0-10: maxTurns — a turn-level cap, consumed at the start of each turn.
    const turnBreach = continuing ? undefined : budget.onTurnStart();
    if (turnBreach !== undefined) {
      await this.emit(sessionId, "run.limit_reached", { ...turnBreach, used: turnBreach.used }, turnId);
      return await this.recoveryController.finishTurn(
        ctx, "failed", state, working,
        errorInfo("RESOURCE_LIMIT", `maxTurns (${turnBreach.allowed}) reached`),
        "agent_limit",
        toolLedger,
      );
    }
    // Replay may have incorporated a completion committed after the last
    // checkpoint. Check its already-spent cost/output before any new model or
    // retrieval work; recovery never grants another call after a known breach.
    if (opts.budgetSeed !== undefined) {
      const restoredBreach = budget.onModelUsage(0, 0, 0) ?? budget.onOutput(0);
      if (restoredBreach !== undefined) {
        await this.emit(sessionId, "run.limit_reached", { ...restoredBreach }, turnId);
        return await this.recoveryController.finishTurn(ctx, "failed", state, working,
          errorInfo("RESOURCE_LIMIT", `${restoredBreach.limit} (${restoredBreach.allowed}) exceeded before recovery (${restoredBreach.used})`),
          "agent_limit", toolLedger);
      }
    }
    if (verificationFailures >= this.maxVerificationFailures) {
      await this.emit(sessionId, "run.limit_reached", { limit: "maxVerificationFailures", used: verificationFailures, allowed: this.maxVerificationFailures }, turnId);
      return await this.recoveryController.finishTurn(ctx, "failed", state, working,
        errorInfo("VERIFICATION_FAILED", working.failures.at(-1) ?? "verification retry budget exhausted before recovery"),
        "verification_failed", toolLedger);
    }

    try {
      if (this.memoryBlocks !== undefined) {
        const deadline = ctx.agent.limits.maxDurationMs === undefined ? undefined
          : budget.snapshot().startedAt + ctx.agent.limits.maxDurationMs + 1;
        const retrieved = await this.memoryPrefetch.run((prefetchSignal) => this.memoryBlocks!({
          sessionId, turnId, goal: working.goal, cwd: ctx.session.cwd,
          signal: prefetchSignal, ...(deadline !== undefined ? { deadline } : {}),
        }), { signal, ...(deadline !== undefined ? { deadline } : {}),
          ...(this.memoryRetrievalTimeoutMs !== undefined ? { timeoutMs: this.memoryRetrievalTimeoutMs } : {}),
        });
        if (signal.aborted || retrieved.status === "cancelled") {
          return await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
        }
        const durationBreach = budget.onDurationCheck();
        if (durationBreach !== undefined) {
          await this.emit(sessionId, "run.limit_reached", { ...durationBreach }, turnId);
          return await this.recoveryController.finishTurn(ctx, "failed", state, working,
            errorInfo("RESOURCE_LIMIT", `maxDurationMs (${durationBreach.allowed}ms) exceeded after ${durationBreach.used}ms`),
            "time_limit", toolLedger);
        }
        if (retrieved.status === "rejected") {
          return await this.recoveryController.finishTurn(ctx, "failed", state, working,
            errorInfo("INTERNAL_ERROR", "memory retrieval failed"), "provider_error", toolLedger);
        }
        if (retrieved.status === "busy" || retrieved.status === "timeout") {
          await this.emit(sessionId, "runtime.degraded", {
            reason: `memory_prefetch_${retrieved.status}`, component: "memory", readOnly: true,
          }, turnId);
        } else if (retrieved.status === "ready" && retrieved.value.length > 0) {
          if (this.onMemoryRetrieved !== undefined) {
            try { await this.onMemoryRetrieved({ sessionId, turnId, blocks: retrieved.value }); }
            catch {
              return await this.recoveryController.finishTurn(ctx, "failed", state, working,
                errorInfo("INTERNAL_ERROR", "memory feedback failed"), "provider_error", toolLedger);
            }
          }
          priorBlocks.push(...retrieved.value);
          const memoryIds = [...new Set(retrieved.value.map((block) =>
            block.id.startsWith("memory:") ? block.id.slice("memory:".length) : block.id).filter(Boolean))];
          const known = new Set(working.memoryRefs);
          for (const id of memoryIds) {
            if (!known.has(id)) { working.memoryRefs.push(id); known.add(id); }
          }
          await this.emit(sessionId, "memory.retrieved", {
            query: working.goal, count: memoryIds.length, memoryIds, suppressed: 0,
          }, turnId);
        }
      }
      // P15-2: step counter — one StepContext per model call; the batch of
      // tool calls it requests reuses the SAME step (immutable snapshot).
      let stepIndex = state.getIteration();
      for (let i = state.getIteration(); i < this.maxIterationsPerTurn; i++) {
        if (signal.aborted) {
          return await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
        }

        // P1-3 periodic checkpoint: every N model iterations at a safe
        // boundary (between model calls). Iteration 0 is the warm-up.
        if (
          this.checkpointPolicy.everyNIterations > 0 &&
          state.getIteration() > 0 &&
          state.getIteration() % this.checkpointPolicy.everyNIterations === 0
        ) {
          await this.recoveryController.checkpoint(ctx, working, state, toolLedger, "periodic:iteration", this.activeBudgetUsage.get(sessionId)?.());
        }

        const durationBreach = budget.onDurationCheck();
        if (durationBreach !== undefined) {
          await this.emit(sessionId, "run.limit_reached", { ...durationBreach }, turnId);
          return await this.recoveryController.finishTurn(
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

        if (reactiveCompacted && !this.context?.pipeline.historyCompaction && history.length > 12) {
          // Reactive compact (plan.md Phase 4/5): after a context-length model
          // error the runtime retries with a REDUCED history — the state
          // digest message (appended below) plus the most recent messages.
          // The full transcript stays in the store (transcript fallback).
          // P2-41/PROTOCOL: a tail slice can cut an assistant `tool_calls`
          // message away while its `tool` results remain; an orphan tool result
          // is rejected by a strict upstream, so the view is repaired.
          const activeUsers = activeUserMessages(history, turnId);
          // Preserve the legacy suffix behavior when durable history
          // compaction is not enabled, including an optional leading handoff.
          const handoff = history[0]?.contextCheckpoint !== undefined ? history[0] : undefined;
          const tail = retainMessageHistoryTail(history, Math.max(0, history.length - 12), activeUsers);
          history = handoff !== undefined && !tail.some(message => message.id === handoff.id)
            ? [handoff, ...tail] : tail;
        }

        // Q-1: context pipeline + compaction + overflow extracted to buildContext.
        // Returns TurnOutcome on overflow failure, undefined to proceed.
        // Mutates: history, system, lastReportTokens, digestAppended, overflowAttempt
        // (via the returned ContextUpdate object).
        const ctxUpdate = await this.contextController.buildContext(
          ctx, ctx.agent, turn, working, priorBlocks, state, toolLedger,
          history, ctx.agent.systemPrompt, lastReportTokens, digestAppended, overflowAttempt, reactiveCompactionPending,
          async (request, maxTokens) => {
            const before = budget.onDurationCheck();
            if (before) return { limit: before };
            // A summary is a normal metered model request with NO tools. Use
            // the same provider/client and finite retry controller, but never
            // project its private output as the agent's answer.
            const run = budget.snapshot();
            const deadline = AbortSignal.timeout(Math.max(1, Math.min(45_000,
              run.limits.maxDurationMs === undefined ? 45_000 : run.limits.maxDurationMs - run.durationMs)));
            const summaryCtx = { ...ctx, signal: AbortSignal.any([signal, deadline]) };
            // Freeze this auxiliary request's actual context and empty tool
            // world too. It has its own StepId, at the upcoming coding index;
            // it never resolves MCP dependencies or advances coding state.
            const preparationStep = await buildStepExecutionSnapshot({ sessionId, turnId, agent: ctx.agent,
              cwd: ctx.session.cwd, stepIndex, priorBlocks: [], system: request.system ?? "", compacted: true,
              history: [...request.messages], registry: { get: () => undefined, list: () => [], specs: () => [] },
              goal: working.goal, semanticsOf: name => this.semanticsOf(name), sandboxPolicy: this.sandboxPolicy, now: this.now });
            const result = await this.modelCallController.callModelWithRetry(summaryCtx, client,
              [...request.messages], request.system ?? "", working, state, toolLedger,
              lastReportTokens, true, budget, preparationStep, { maxTokens });
            const duration = budget.onDurationCheck();
            if (result.status !== "completed") {
              if (duration) { await this.emit(sessionId, "run.limit_reached", { ...duration }, turnId); return { limit: duration }; }
              const spent = budget.snapshot();
              if (result.status === "failed" && result.error.code === "RESOURCE_LIMIT" && spent.limits.maxRetries !== undefined && spent.retries > spent.limits.maxRetries) {
                return { limit: { limit: "maxRetries" as const, used: spent.retries, allowed: spent.limits.maxRetries } };
              }
              return { reason: signal.aborted ? "cancelled" : deadline.aborted ? "summary-timeout" : "summary-model-error" };
            }
            const usage = finalizeUsage(result.usage);
            await this.emit(sessionId, "model.completed", { callId: result.callId, purpose: "compaction",
              finishReason: result.final?.finishReason ?? "error", final: false, text: "", toolCalls: 0,
              durationMs: this.now() - result.callStartedAt, usage }, turnId, { spanId: result.callId });
            this.reportModelUsage?.(sessionId, usage);
            const cost = budget.onModelUsage(usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.estimatedCostUsd ?? 0);
            const limit = duration ?? cost ?? budget.onDurationCheck();
            if (limit) { await this.emit(sessionId, "run.limit_reached", { ...limit }, turnId); return { limit }; }
            if (signal.aborted) return { reason: "cancelled" };
            if (deadline.aborted) return { reason: "summary-timeout" };
            if (result.final?.finishReason !== "stop" || result.calls.length || result.final.toolCalls?.length) return { reason: "summary-incomplete-or-tool-intent" };
            return { text: result.final.text ?? result.assistantText };
          },
        );
        if (ctxUpdate.action === "finish") return ctxUpdate.outcome;
        reactiveCompactionPending = false;
        let system = ctxUpdate.system;
        history = ctxUpdate.history;
        lastReportTokens = ctxUpdate.lastReportTokens;
        digestAppended = ctxUpdate.digestAppended;
        overflowAttempt = ctxUpdate.overflowAttempt;
        // P15-2: form the immutable StepContext BEFORE the model call. Every
        // tool call this model response requests will reuse THIS step, so a
        // mid-step config/policy change cannot affect the batch.
        // P32-1/P32-3: the selected skill world + instruction sources of THIS
        // context build are pinned into the step (skills snapshot + sources
        // fingerprint); skill-declared MCP servers feed the step's MCP world.
        const step = await this.buildStepContext(
          ctx, stepIndex, priorBlocks, system, digestAppended || overflowAttempt > 0, history, working.goal,
          {
            selectedSkills: ctxUpdate.selectedSkills,
            instructionSources: ctxUpdate.instructionSources,
          },
        );
        stepIndex += 1;
        const modelResult = await this.modelCallController.callModelWithRetry(
          ctx, client, history, system, working, state, toolLedger, lastReportTokens, reactiveCompacted, budget, step,
        );

        if (modelResult.status === "cancelled") {
          return await this.recoveryController.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger);
        }
        if (modelResult.status === "failed") {
          return await this.recoveryController.finishTurn(ctx, "failed", state, working, modelResult.error, "model_error", toolLedger);
        }
        if (modelResult.status === "rebuild_context") {
          // P23-6: the model-visible world changed (reactive compaction) — the
          // stale step snapshot can never be reused. Compaction orchestration
          // lives HERE in the outer sampling loop: checkpoint → digest →
          // shrink flag → continue, which builds a NEW StepExecutionSnapshot.
          await this.recoveryController.checkpoint(
            ctx, working, state, toolLedger, "context:reactive-compact",
            this.activeBudgetUsage.get(sessionId)?.(),
          );
          reactiveCompacted = true;
          if (this.context?.pipeline.historyCompaction) {
            // A count-based suffix can retain every oversized record. Ask
            // the existing durable compactor to shrink the failed view even
            // when our estimate is below the automatic local threshold.
            reactiveCompactionPending = true;
            continue;
          }
          await this.emit(sessionId, "context.compacted", {
            compressed: 1,
            reason: "reactive compact (context-length model error)",
            reactive: true,
            totalCount: ++this.compactCounter.value,
          }, turnId);
          await this.store.appendMessage({
            id: newMessageId(),
            sessionId,
            turnId,
            role: "system",
            content: buildStateDigest(working, "context is full — reactive compact; continue concisely", activeUserMessages(history, turnId)),
            createdAt: this.now(),
          });
          continue;
        }

        // completed
        reactiveCompacted = modelResult.reactiveCompacted;
        // The controller persists the canonical assistant/usage event before
        // this single metering boundary. A verification retry is still a paid
        // call, and a cap breach retains the observation without running tools.
        const completion = await this.modelCallController.handleModelCompletion(
          ctx, modelResult, turn, working, state, toolLedger, lastReportTokens, verificationFailures, step,
          async () => {
            // P0-11/P20-1: report per-call usage (with provenance) to the tree
            // budget (scheduler). finalizeUsage() marks a provider-less call
            // "unknown" — NEVER a fabricated 0-token record.
            if (this.reportModelUsage !== undefined) {
              this.reportModelUsage(sessionId, finalizeUsage(modelResult.usage));
            }
            // P0-10: maxEstimatedCostUsd — check immediately after model usage so a
            // runaway cost stops BEFORE the next model call.
            if (modelResult.usage !== undefined) {
              const costBreach = budget.onModelUsage(
                modelResult.usage.inputTokens ?? 0,
                modelResult.usage.outputTokens ?? 0,
                modelResult.usage.estimatedCostUsd ?? 0,
              );
              if (costBreach !== undefined) {
                await this.emit(sessionId, "run.limit_reached", { ...costBreach }, turnId);
                return { error: errorInfo("RESOURCE_LIMIT", `maxEstimatedCostUsd (${costBreach.allowed}) exceeded after ${costBreach.used}`), terminationReason: "agent_limit" };
              }
            }
            // P0-10: maxOutputChars — assistant text counts toward the output cap
            // (tool output is metered separately by toolOutputBudget). A breach
            // stops the turn before more tokens are generated.
            if (modelResult.assistantText !== undefined) {
              const outputBreach = budget.onOutput(modelResult.assistantText.length);
              if (outputBreach !== undefined) {
                await this.emit(sessionId, "run.limit_reached", { ...outputBreach }, turnId);
                return { error: errorInfo("RESOURCE_LIMIT", `maxOutputChars (${outputBreach.allowed}) exceeded after ${outputBreach.used}`), terminationReason: "agent_limit" };
              }
            }
            return undefined;
          },
        );
        if (completion.action === "continue_loop") {
          verificationFailures = completion.verificationFailures;
          continue;
        }
        if (completion.action === "finish") return completion.outcome;

        // proceed to execute tools
        const toolCalls = completion.toolCalls;
        // P0-10: maxSubagents — consumed before any delegate tool actually
        // spawns a child (never after the fact).
        for (const call of toolCalls) {
          if (call.name.startsWith("delegate")) {
            const spawnBreach = budget.onSubagentSpawn();
            if (spawnBreach !== undefined) {
              await this.emit(sessionId, "run.limit_reached", { ...spawnBreach }, turnId);
              return await this.recoveryController.finishTurn(
                ctx, "failed", state, working,
                errorInfo("RESOURCE_LIMIT", `maxSubagents (${spawnBreach.allowed}) reached`),
                "agent_limit",
                toolLedger,
              );
            }
          }
        }
        // Reserve the logical call budget BEFORE dispatch. A post-result
        // check lets the over-budget write land and makes its checkpoint
        // omit the consumption. Settle the unexecuted suffix as well, so the
        // model's assistant/tool block remains complete and adjacent.
        const admitted: ToolCall[] = [], blocked: ExecutedToolCall[] = [];
        let toolBreach: import("@ar/contracts").LimitBreach | undefined;
        for (const call of toolCalls) {
          if (toolBreach === undefined && call.name !== "update_plan") toolBreach = budget.onToolCall();
          if (toolBreach === undefined) admitted.push(call);
          else blocked.push({ call, streak: 0, result: { status: "failed", error: errorInfo("RESOURCE_LIMIT", "tool call not dispatched: maxToolCalls reached") } });
        }
        if (toolBreach !== undefined) await this.emit(sessionId, "run.limit_reached", { ...toolBreach }, turnId);
        const executed = [...await this.toolCallController.executeToolCalls(ctx, state, admitted, turnState, step, modelResult.callId), ...blocked];
        const toolAction = await this.handleToolResults(
          ctx, executed, working, state, toolLedger, priorBlocks, lastReportTokens, budget,
        );
        if (toolBreach !== undefined) return await this.recoveryController.finishTurn(
          ctx, signal.aborted ? "cancelled" : "failed", state, working,
          signal.aborted ? undefined : errorInfo("RESOURCE_LIMIT", `maxToolCalls (${toolBreach.allowed}) reached`),
          signal.aborted ? "cancelled" : "tool_limit", toolLedger,
        );
        if (toolAction.action === "continue_loop") continue;
        if (toolAction.action === "finish") return toolAction.outcome;
        // done: fall through to next iteration
      }

      const info = errorInfo("RESOURCE_LIMIT", `maxIterationsPerTurn (${this.maxIterationsPerTurn}) reached`);
      await this.emit(sessionId, "run.limit_reached", { limit: "maxIterationsPerTurn", used: this.maxIterationsPerTurn }, turnId);
      return await this.recoveryController.finishTurn(ctx, "failed", state, working, info, "agent_limit", toolLedger);
    } finally {
      await this.withModelSelectionLock(sessionId, async () => {
        const current = await this.store.getSession(sessionId);
        if (current) await this.store.updateSession({ ...current, updatedAt: this.now() });
      });
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
    opts: RunTurnOptions = {},
  ): Promise<TurnInit> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    const agent = await this.resolveAgent(session);

    // Q-1: bundle the five read-only turn values into a single context object.
    const ctx: TurnContext = { sessionId, turnId, signal, session, agent };

    const state = new AgentState(sessionId, session.agentId, this.now);
    state.beginTurn(turnId);
    state.seedProgress(opts.iterationSeed ?? 0, opts.toolCallsExecutedSeed ?? 0);
    // P16-3: a resumed turn seeds its stall-recovery consumption.
    if (opts.stallRecoverySeed !== undefined && opts.stallRecoverySeed > 0) {
      state.seedStallRecoveries(opts.stallRecoverySeed);
    }
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
    const toolLedger: ToolExecutionRecord[] = opts.toolLedgerSeed ?? [];
    // P15-1: the per-turn execution state is created fresh HERE — a new
    // recoveryUsage map per turn, so no turn inherits another turn's budget.
    const turnState: TurnExecutionState = newTurnExecutionState();
    // P16-3: a resumed turn seeds its recovery-action usage ledger.
    if (opts.recoveryUsageSeed !== undefined) {
      for (const key of Object.keys(opts.recoveryUsageSeed) as RecoveryAction[]) {
        const value = opts.recoveryUsageSeed[key];
        if (value !== undefined) turnState.recoveryUsage[key] = value;
      }
    }
    return { ctx, state, turn, working, toolLedger, turnState };
  }

  /** P23-1: form the immutable StepExecutionSnapshot for ONE model call.
   *  Everything the model and its requested tool calls may observe is pinned
   *  BEFORE the call: frozen agent config, cwd identity, frozen tool router
   *  (from the process catalog, policy-filtered), the permission profile, the
   *  exact context identity and the model ref — plus durable fingerprints in
   *  the StepRecord. The SAME snapshot is threaded into every tool call of
   *  this model response; a mid-step catalog/policy change can only affect
   *  the NEXT snapshot. */
  private async buildStepContext(
    ctx: TurnContext,
    stepIndex: number,
    priorBlocks: ContextBlock[],
    system: string,
    compacted: boolean,
    history: readonly import("@ar/contracts").Message[],
    goal: string,
    opts: {
      /** P32-1/P32-4: skills selected for THIS step (from the context build).
       *  Their identities + MCP requirements are frozen into the step. */
      selectedSkills?: import("@ar/contracts").SkillSnapshot["selected"];
      /** P32-3: exact instruction sources (system + AGENTS.md docs). */
      instructionSources?: readonly import("@ar/contracts").InstructionSource[];
    } = {},
  ): Promise<StepExecutionSnapshot> {
    // P24-5/P32-4: resolve the MCP world THIS step needs — goal mentions PLUS
    // declared requirements of the selected skills (lazy connect). A refresh
    // mid-run only affects NEW steps.
    const mcpBinding = await this.mcpBindingProvider?.({
      goal,
      selectedSkills: opts.selectedSkills?.map((s) => ({
        name: s.name,
        requiredMcpServers: s.requiredMcpServers ?? [],
      })),
    });
    const mcpExtra: readonly import("@ar/contracts").FrozenToolBinding[] = (mcpBinding?.tools ?? []).map((t) => ({
      name: t.toolName,
      spec: { name: t.toolName, description: t.definition.description, inputSchema: { type: "object" } as never },
      definition: t.definition,
      semantics: { retrySafety: "unknown", concurrencySafety: true, cancellable: true, readOnly: false, idempotent: false, sideEffectScope: "unknown", networkBehavior: "outbound", outputSensitivity: "high", requiresApproval: true } as never,
      provenance: { kind: "mcp", sourceId: t.serverId, generation: t.generation },
    }));
    // P32-1: the selected skill world is frozen into the step — a body edit /
    // selection change mid-run can only affect the NEXT step.
    const skillsSnapshot =
      opts.selectedSkills !== undefined && opts.selectedSkills.length > 0
        ? buildSkillSnapshot(opts.selectedSkills)
        : undefined;
    return buildStepExecutionSnapshot({
      ...mcpExtra.length > 0 ? { extraBindings: mcpExtra } : {},
      ...(skillsSnapshot !== undefined ? { skills: skillsSnapshot } : {}),
      ...(opts.instructionSources !== undefined ? { instructionSources: opts.instructionSources } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      agent: ctx.agent,
      cwd: ctx.session.cwd,
      stepIndex,
      priorBlocks,
      system,
      compacted,
      history,
      registry: this.toolRegistry ?? { get: () => undefined, list: () => [], specs: () => [] },
      ...((this.askUserStore !== undefined || this.askUser !== undefined || this.toolRegistry?.specs().some(spec => spec.name === ASK_GATE_TOOL))
        ? { formalActionSpecs: [ASK_GATE_SPEC] } : {}),
      goal,
      toolSelector: this.toolSelector,
      schemaAdvertPolicy: this.schemaAdvertPolicy,
      permissive: this.permissiveToolResolution,
      semanticsOf: (name) => this.semanticsOf(name),
      sandboxPolicy: this.sandboxPolicy,
      now: this.now,
    });
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
    // P2-41/PROTOCOL: the wire protocol requires an assistant message carrying
    // `tool_calls` to be followed IMMEDIATELY by one `tool` message per
    // `tool_call_id` — nothing may be interleaved, and none may be missing. A
    // strict OpenAI-compatible upstream rejects a violation of the NEXT request
    // with HTTP 400 ("An assistant message with 'tool_calls' must be followed by
    // tool messages responding to each 'tool_call_id'").
    //
    // The processing is therefore split into two phases so the invariant holds
    // STRUCTURALLY rather than per-exit-path:
    //   Phase 1 persists one `tool` message for EVERY executed call, in call
    //           order, with no gate able to short-circuit it. (Previously the
    //           runtime-internal `update_plan` skipped its message entirely, and
    //           a gate that terminated mid-batch left every later call
    //           unanswered — both produced the same upstream 400.)
    //   Phase 2 evaluates the stall/limit gates. It may append observations, but
    //           only AFTER the whole block is durable, so a gate can never split
    //           the block or orphan a requested tool call.
    //
    // The tool calls were ALL executed before this method runs (the batch is
    // settled in ToolCallController.executeToolCalls), so persisting every
    // result also makes the transcript reflect what actually happened.
    const deferredObservations: string[] = [];
    for (const { call, result, deferredObservations: callObservations } of executed) {
      if (callObservations !== undefined) deferredObservations.push(...callObservations);
      // P0-12: update_plan is a runtime-internal tool whose mutations the runtime
      // applies directly (the tool itself is a no-op recorder). It still owes the
      // model a `tool` message — the model requested it with a real
      // `tool_call_id`, and leaving it unanswered is a protocol violation.
      if (call.name === "update_plan") {
        const mutations = call.args.mutations as WorkingStateMutation[] | undefined;
        if (result.status === "success" && mutations !== undefined) {
          for (const mutation of mutations) {
            applyWorkingStateMutation(working, mutation);
          }
        }
        // No context block and no ledger entry (it has no external effect), but
        // the result message is mandatory.
        const planContent = await this.contextController.renderToolResultForContext(ctx, call, result);
        await this.store.appendMessage({
          id: newMessageId(),
          sessionId,
          turnId,
          role: "tool",
          content: planContent,
          toolCallId: call.id,
          createdAt: this.now(),
        });
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
      }
    }

    // The execution layer already settled the entire batch. A checkpoint's
    // event watermark therefore covers the entire batch too: its canonical
    // results, working state and ledger must all be complete before saving
    // even the first successful effect's checkpoint.
    for (const { call, result } of executed) {
      if (call.name === "update_plan" || this.semanticsOf(call.name).sideEffectScope === "none" || result.status !== "success") continue;
      // P1-5: kill after the effect landed but BEFORE its checkpoint —
      // the window where only the store result message proves it.
      await this.failAt("tool.completed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
      if (this.checkpointPolicy.afterSideEffectTools) {
        await this.recoveryController.checkpoint(
          ctx, working, state, toolLedger, `tool:completed:${call.name}`,
          this.activeBudgetUsage.get(sessionId)?.(),
        );
        // P1-5: kill AFTER the checkpoint persisted (a durable safety
        // boundary exists — resume can proceed from it).
        await this.failAt("tool.checkpointed", { sessionId, turnId, toolCallId: call.id, tool: call.name });
      }
    }

    // ── Phase 2: gates. The tool block above is fully durable, so every
    // observation appended from here on lands AFTER it (protocol-safe).
    let deferredStallObservation: string | null = null;
    let terminal: { error: ReturnType<typeof errorInfo>; reason: TerminationReason } | null = null;
    for (const { call, result, streak, progressCancelled, wouldBeStreak } of executed) {
      // P0-12: the internal update_plan call never participates in the stall /
      // tool-budget gates (it is bookkeeping, not external work).
      if (call.name === "update_plan") continue;
      // E4-R86 (H2): a repeated call+args whose RESULT CHANGED is observable
      // progress — the identical-call streak was cancelled, so the turn must
      // NOT be terminated for it. Emit structured evidence of the fix path
      // (countable, secret-free: tool name + counts only).
      if (progressCancelled === true) {
        await this.emit(sessionId, "stall.progress_detected", {
          tool: call.name,
          wouldBeStreak: wouldBeStreak ?? streak,
          allowed: this.maxRepeatedIdenticalToolCalls,
        }, turnId);
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
          // Deferred (see `deferredStallObservation`): appending here would
          // split the tool-result block of this batch.
          deferredStallObservation =
            `[stall recovery — the identical tool call "${call.name}" was repeated ${streak} times without progress]\n` +
            "The call keeps returning the same result. Try a different approach or stop repeating it.";
          continue;
        }
        await this.emit(sessionId, "run.limit_reached", { limit: "maxRepeatedToolCalls", used: streak, allowed: this.maxRepeatedIdenticalToolCalls }, turnId);
        terminal = {
          error: errorInfo("RESOURCE_LIMIT", `maxRepeatedToolCalls (${this.maxRepeatedIdenticalToolCalls}) reached: repeated identical call ${call.name}`),
          reason: "tool_limit",
        };
        break;
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
          // Deferred (see `deferredStallObservation`): appending here would
          // split the tool-result block of this batch.
          deferredStallObservation =
            `[stall recovery — detected "${stallPattern}" (repeated tool work without progress)]\n` +
            "Try a different approach or stop repeating the same work.";
          continue;
        }
        await this.emit(sessionId, "run.limit_reached", { limit: "stallPattern", used: 1, allowed: this.maxPatternStallRecoveries, pattern: stallPattern }, turnId);
        terminal = {
          error: errorInfo("RESOURCE_LIMIT", `stall pattern detected: ${stallPattern}`),
          reason: "tool_limit",
        };
        break;
      }
    }

    // P2-41/PROTOCOL: the batch's tool results are ALL durable now, so every
    // deferred observation (adaptive-recovery per call, then the stall gate) is
    // appended strictly AFTER the block — never inside it.
    for (const observation of deferredObservations) {
      await this.store.appendMessage({
        id: newMessageId(),
        sessionId,
        turnId,
        role: "system",
        content: observation,
        createdAt: this.now(),
      });
    }
    if (deferredStallObservation !== null) {
      await this.store.appendMessage({
        id: newMessageId(),
        sessionId,
        turnId,
        role: "system",
        content: deferredStallObservation,
        createdAt: this.now(),
      });
    }
    if (terminal !== null) {
      return { action: "finish", outcome: await this.recoveryController.finishTurn(
        ctx, "failed", state, working, terminal.error, terminal.reason, toolLedger,
      ) };
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
    const previous = this.userAnswerSubmissions.get(askId);
    let release!: () => void;
    const queued = new Promise<void>((resolve) => { release = resolve; });
    this.userAnswerSubmissions.set(askId, queued);
    await previous;
    try {
      const session = await this.store.getSession(sessionId);
      const turn = await this.store.getTurn(turnId);
      if (session === undefined || turn === undefined || turn.sessionId !== sessionId) {
        return { resumed: false, message: `ask ${askId} is not bound to this session and turn` };
      }
      let pending = await this.askUserStore?.get(askId);
      if (pending !== undefined && (pending.id !== askId || pending.sessionId !== sessionId || pending.turnId !== turnId)) {
        return { resumed: false, message: `ask ${askId} is not bound to this session and turn` };
      }
      // A committed reply proves a genuine retry, even after the turn ended
      // or the ask record was removed. Scope that proof to the exact user,
      // session and turn; the same ask id elsewhere is not authorization.
      const history = await this.store.listMessages(sessionId);
      const priorReplies = history.filter(message => message.askId === askId);
      if (priorReplies.some(message => message.role === "user" && message.sessionId === sessionId && message.turnId === turnId)) {
        return { resumed: true, message: `already resumed for ask ${askId}` };
      }
      if (priorReplies.length > 0) {
        return { resumed: false, message: `ask ${askId} has conflicting reply history` };
      }
      if (this.askUserStore === undefined) {
        // Without a dedicated ask store, the events emitted by the actual
        // park transition remain the existence proof across reconstruction.
        // Never invent a pending request from caller-supplied identities.
        const events = await this.events.list(sessionId);
        const asked = events.find(event => event.type === "ask.user_asked" && event.sessionId === sessionId
          && event.turnId === turnId && event.payload.askId === askId && event.payload.turnId === turnId);
        const waiting = events.some(event => event.type === "ask.turn_waiting" && event.sessionId === sessionId
          && event.turnId === turnId && event.payload.askId === askId && event.payload.turnId === turnId);
        if (asked !== undefined && waiting && isAskReason(asked.payload.reason) && typeof asked.payload.question === "string") {
          pending = { id: askId, sessionId, turnId, reason: asked.payload.reason, question: asked.payload.question,
            status: "pending", createdAt: asked.timestamp };
        }
      }
      if (pending === undefined) {
        return { resumed: false, message: `unknown ask ${askId}` };
      }
      if (turn.status !== "waiting_for_user") {
        return { resumed: false, message: `turn ${turnId} is not waiting for a user answer` };
      }
      let reply: AskUserReply;
      if (this.askUserLifecycle.isPending(pending)) {
        reply = { requestId: askId, text, answeredAt: this.now() };
        if (this.askUserStore !== undefined) {
          await this.askUserStore.markAnswered(askId, reply);
          // The durable answer is authoritative, including when the store's
          // implementation no-ops because an answer already won the race.
          pending = await this.askUserStore.get(askId);
          if (pending === undefined || pending.id !== askId || pending.sessionId !== sessionId || pending.turnId !== turnId
            || !this.askUserLifecycle.isAnswered(pending) || typeof pending.answerText !== "string"
            || !Number.isFinite(pending.answeredAt)) {
            return { resumed: false, message: `ask ${askId} has no durable answer` };
          }
          reply = { requestId: askId, text: pending.answerText, answeredAt: pending.answeredAt! };
        }
      } else if (this.askUserLifecycle.isAnswered(pending) && typeof pending.answerText === "string"
        && Number.isFinite(pending.answeredAt)) {
        // Recover the crash window after markAnswered but before append. A
        // changed retry text must never replace the answer already persisted.
        reply = { requestId: askId, text: pending.answerText, answeredAt: pending.answeredAt! };
      } else {
        return { resumed: false, message: `ask ${askId} is not pending` };
      }
      const prompt = this.askUserLifecycle.resumePrompt(reply);
      await this.store.appendMessage({
        id: newMessageId(), sessionId, turnId, role: "user", content: prompt.content, askId, createdAt: this.now(),
      });
      await this.emit(sessionId, "ask.user_replied", { askId, turnId, text: reply.text }, turnId);
      return { resumed: true, message: `resumed turn ${turnId} with reply` };
    } finally {
      release();
      if (this.userAnswerSubmissions.get(askId) === queued) this.userAnswerSubmissions.delete(askId);
    }
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
    await this.reconcileTerminalTurns(sessionId);
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
    const { working, committedSideEffects, replayedToolLedger, unresolvedTools, replayedEventCount } =
      await this.recoveryController.reconstructResumeState(sessionId, turnId, checkpoint);
    const original = turnId === undefined ? undefined : await this.store.getTurn(turnId);
    if (original?.terminalOutcome !== undefined && (original.status === "completed" || original.status === "cancelled")) {
      // Completed/cancelled runs may have lost only their response: return the
      // committed result without new execution. An explicit resume of a failed
      // task still follows the original checkpoint/budget recovery below,
      // preserving its failed record while continuing in a fresh turn.
      const state = new AgentState(sessionId, agent.id, this.now); state.beginTurn(original.id);
      state.seedProgress(checkpoint.iteration, (checkpoint.toolCallsExecuted ?? checkpoint.toolLedger.length) + replayedToolLedger.length);
      const outcome = await this.recoveryController.finishTurn({ sessionId, turnId: original.id, session, agent, signal },
        original.terminalOutcome.status, state, working);
      return { sessionId, checkpointId: checkpoint.checkpointId, turnId: original.id, state: working,
        committedSideEffects, unresolvedTools, replayedEventCount, outcome };
    }

    // P2-40: each started-but-unconfirmed tool that must be reconciled is its
    // own reconciliation retry-kind event. Reconciliation is never auto-redone
    // (spec maxAttempts 0) — we only surface the fact so the taxonomy/report can
    // hold the runtime to that promise. P16-2: every event carries the typed
    // reconciliation VERDICT (safe_retry / needs_verification / never_auto) +
    // reason, so the audit trail can prove the policy was applied per scope.
    const verdicts: ReconciliationVerdict[] = [];
    for (const unresolved of unresolvedTools) {
      const verdict = classifyUnknownOutcome(
        unresolved.tool,
        this.semanticsOf(unresolved.tool),
      );
      verdicts.push(verdict);
      await this.emit(
        sessionId,
        "retry.reconciliation",
        {
          toolCallId: unresolved.toolCallId,
          tool: unresolved.tool,
          sideEffect: unresolved.sideEffect,
          sideEffectScope: unresolved.sideEffectScope,
          started: unresolved.started,
          decision: verdict.decision,
          reason: verdict.reason,
          ...("evidence" in verdict && verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
        },
        turnId,
      );
    }

    // A recovery continues the interrupted task in a fresh turn. Carry only
    // that task's durable user inputs onto the existing user resume channel;
    // copying prompt messages would duplicate their exactly-once identity.
    let interruptedUsers: Message[] = [];
    if (turnId !== undefined) {
      // A steer can be durably bound just before its message append. Settle
      // that crash window on the original turn before creating the resume
      // turn: rewriting promotedTurnId would break exactly-once lineage.
      const history = await this.contextController.injectSteeringPrompts(
        { sessionId, turnId }, await this.store.listMessages(sessionId), { recoverBoundOnly: true },
      );
      interruptedUsers = activeUserMessages(history, turnId);
    }
    const resumePrompt = buildResumePrompt(working, committedSideEffects, unresolvedTools, verdicts, interruptedUsers);
    const bu = checkpoint.budgetUsage;
    const budgetSeed = bu?.run === undefined ? undefined : replayCheckpointBudget(checkpoint, bu.run,
      await this.events.list(sessionId, { afterSequence: checkpoint.lastEventSequence }));
    const turn = await this.startTurn(sessionId, resumePrompt);
    const outcome = await this.runTurn(sessionId, turn.id, signal, {
      initialState: working,
      ...(budgetSeed !== undefined ? { budgetSeed } : {}),
      ...(bu?.recoveryUsage !== undefined ? { recoveryUsageSeed: bu.recoveryUsage } : {}),
      ...(bu?.verificationRetries !== undefined ? { verificationRetriesSeed: bu.verificationRetries } : {}),
      ...(bu?.stallRecoveryCount !== undefined ? { stallRecoverySeed: bu.stallRecoveryCount } : {}),
    });
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

  /** PKG-003: the tool-semantics policy is a LOOKUP, not a scalar — hash the
   *  whole table (registry tools + built-ins, name-sorted) so a host that
   *  reclassifies a tool's read-only/retry/side-effect surface is observed on
   *  resume. The old hash was `String(this.toolSemanticsOf.length)`, i.e. the
   *  constant "1" for every host: a gate that could never differ. */
  private toolSemanticsTableHash(): string | undefined {
    if (this.toolSemanticsOf === undefined) return undefined;
    const names = new Set<string>([
      ...Object.keys(DEFAULT_RUNTIME_TOOL_SEMANTICS),
      ...(this.toolRegistry?.list() ?? []).map((tool) => tool.name),
    ]);
    const table = [...names].sort().map((name) => [name, this.semanticsOf(name)] as const);
    return stablePolicyHash(table);
  }

  /** Hash the complete normalized policy, including exhausted behavior beyond
   * the first eight attempts and every per-kind cap/delay override. */
  private retryPolicyHashOf(): string | undefined {
    return this.recovery === undefined ? undefined : stablePolicyHash(this.recovery.getConfigIdentity());
  }

  /** PKG-003: ONE builder for create-session and for the resume comparison, so
   *  the two sides of the drift check can never diverge from each other. */
  private runtimePolicySnapshot(): RuntimePolicySnapshotV2 {
    return {
      version: 2,
      contextPolicyHash: this.context !== undefined ? stableHashOf(this.context) : undefined,
      retryPolicyHash: this.retryPolicyHashOf(),
      schedulerPolicyHash: undefined,
      toolSemanticsHash: this.toolSemanticsTableHash(),
      sandboxPolicyHash: this.sandboxPolicy !== undefined ? stablePolicyHash(this.sandboxPolicy) : undefined,
      createdAt: this.now(),
    };
  }

  /** Keep the frozen baseline unchanged, but report an unchanged observed
   * drift only once per host. Concurrent metadata reads join the same write;
   * failed writes remain retryable rather than suppressing the observation. */
  private async emitPolicyDrift(sessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hash = stablePolicyHash(payload);
    const previous = this.policyDriftReports.get(sessionId);
    if (previous?.hash === hash) return previous.promise;
    const emit = async () => { await this.emit(sessionId, "policy.changed_on_resume", payload); };
    const promise = (previous?.promise ?? Promise.resolve()).then(emit, emit);
    const entry = { hash, promise };
    this.policyDriftReports.set(sessionId, entry);
    try { await promise; }
    catch (error) {
      if (this.policyDriftReports.get(sessionId) === entry) this.policyDriftReports.delete(sessionId);
      throw error;
    }
  }

  /** PKG-003: emit ONE `policy.changed_on_resume` event naming every policy
   *  dimension that moved since createSession. Observation-only by design (the
   *  P0-1 agent snapshot already prevents silent widening); the old gate
   *  compared only the context pipeline, so a resumed session ran against a
   *  changed retry/sandbox/tool-semantics policy with NO event at all. */
  private async reportPolicyDrift(
    sessionId: SessionId,
    stored: EffectiveRuntimePolicySnapshot | RuntimePolicySnapshotV2,
  ): Promise<void> {
    if (stored.version === 1) {
      const currentContextHash = this.context !== undefined ? stableHashOf(this.context) : undefined;
      const contextPolicyChanged =
        this.context !== undefined &&
        stored.contextPolicyHash !== undefined &&
        stored.contextPolicyHash !== currentContextHash;
      // v1 froze retryPolicyHash as `stableHashOf(this.recovery)` on the live
      // instance, so that exact encoding is still recomputable here: a session
      // created before this upgrade can be checked for retry drift too. v1's
      // toolSemanticsHash was an arity constant and it recorded no sandbox
      // hash, so those two are genuinely unknowable for a legacy session and
      // must not be reported as drift (that would be a phantom alarm on every
      // pre-upgrade resume).
      const retryPolicyChanged =
        this.recovery !== undefined &&
        stored.retryPolicyHash !== undefined &&
        stored.retryPolicyHash !== stableHashOf(this.recovery);
      if (!contextPolicyChanged && !retryPolicyChanged) { this.policyDriftReports.delete(sessionId); return; }
      await this.emitPolicyDrift(sessionId, {
        ...(contextPolicyChanged
          ? { contextPolicyChanged: true, contextPolicyHash: currentContextHash, stored: stored.contextPolicyHash }
          : {}),
        ...(retryPolicyChanged
          ? { retryPolicyChanged: true, retryPolicyHash: stableHashOf(this.recovery) }
          : {}),
      });
      return;
    }
    const current = this.runtimePolicySnapshot();
    const contextPolicyChanged = stored.contextPolicyHash !== current.contextPolicyHash;
    const retryPolicyChanged = stored.retryPolicyHash !== current.retryPolicyHash;
    const toolSemanticsChanged = stored.toolSemanticsHash !== current.toolSemanticsHash;
    const sandboxPolicyChanged = stored.sandboxPolicyHash !== current.sandboxPolicyHash;
    if (!contextPolicyChanged && !retryPolicyChanged && !toolSemanticsChanged && !sandboxPolicyChanged) { this.policyDriftReports.delete(sessionId); return; }
    await this.emitPolicyDrift(sessionId, {
      contextPolicyChanged,
      retryPolicyChanged,
      toolSemanticsChanged,
      sandboxPolicyChanged,
      contextPolicyHash: current.contextPolicyHash ?? null,
      retryPolicyHash: current.retryPolicyHash ?? null,
      toolSemanticsHash: current.toolSemanticsHash ?? null,
      sandboxPolicyHash: current.sandboxPolicyHash ?? null,
    });
  }

  getAgent(agentId: AgentId): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  /** Repair committed terminal events only. Session loading/queue hydration
   * must settle this outbox before acknowledging a prompt or executing work. */
  async reconcileTerminalTurns(sessionId: SessionId): Promise<void> {
    const previous = this.terminalReconciliations.get(sessionId) ?? Promise.resolve();
    // Each caller observes its own failure. A later repair must still run
    // after that rejection, rather than inheriting a permanently failed queue.
    const reconcile = async () => {
      if (await this.recoveryController.reconcileTerminalTurns(sessionId)) await this.flushDurability(sessionId);
    };
    const current = previous.then(reconcile, reconcile);
    this.terminalReconciliations.set(sessionId, current);
    try { await current; }
    finally { if (this.terminalReconciliations.get(sessionId) === current) this.terminalReconciliations.delete(sessionId); }
  }

  /** Read the same persisted effective policy runTurn uses. A host branching
   * a session must not substitute the current registry's wider definition. */
  async getSessionAgent(sessionId: SessionId): Promise<AgentDefinition> {
    const session = await this.store.getSession(sessionId);
    if (session === undefined) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    await this.reconcileTerminalTurns(sessionId);
    return this.resolveAgent(session);
  }

  /** Read the validated effective policy for synchronous event observers.
   * Terminal publication may await such an observer while owning its recovery
   * lock, so this view must not trigger terminal reconciliation. Preserve the
   * ordinary frozen-policy, drift and durable model-selection checks. Public
   * session metadata/startup callers retain getSessionAgent's repair boundary. */
  async getSessionAgentPolicy(sessionId: SessionId): Promise<AgentDefinition> {
    const session = await this.store.getSession(sessionId);
    if (session === undefined) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    return this.resolveAgent(session);
  }

  /** Switch only the authorized model reference. Model, immutable legacy
   * provenance and the event outbox share one atomic session-row commit; tools,
   * permissions, skills and all other frozen policy fields remain unchanged. */
  async setSessionModel(sessionId: SessionId, model: ModelRef): Promise<Session> {
    if (model === undefined || typeof model.providerId !== "string" || model.providerId.length === 0
      || typeof model.modelId !== "string" || model.modelId.length === 0) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "setSessionModel requires a concrete providerId/modelId reference"));
    }
    return this.withModelSelectionLock(sessionId, async () => {
      const session = await this.store.getSession(sessionId);
      if (session === undefined) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
      const snapshot = await this.store.loadStateSnapshot(sessionId);
      const cfg = snapshot?.[EFFECTIVE_AGENT_SNAPSHOT_KEY] as EffectiveAgentConfig | undefined;
      if (!isEffectiveAgentConfig(cfg) || cfg.agentId !== session.agentId) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${sessionId} has a corrupt or foreign effective-agent snapshot: refusing to switch its model`));
      }
      if (session.status !== "active") throw new AgentError(errorInfo("INTERNAL_ERROR", "only active sessions can select a model"));
      await this.publishModelSelection(session);
      if (session.model.providerId === model.providerId && session.model.modelId === model.modelId) return session;
      const selected = { ...model };
      const updated: Session = { ...session, model: selected, updatedAt: this.now(),
        modelSelection: { version: 1, initialModel: { ...(session.modelSelection?.initialModel ?? session.model) },
          model: selected, eventId: newEventId(), timestamp: this.now() } };
      await this.store.updateSession(updated);
      // A failure here leaves a committed, recoverable selection, never a
      // different model in the row and the effective policy. Retry/restart
      // publishes this exact event before proceeding; no best-effort rollback.
      await this.publishModelSelection(updated);
      return updated;
    });
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
    if (session.modelSelection !== undefined) {
      session = await this.withModelSelectionLock(session.id, async () => {
        const current = await this.store.getSession(session.id);
        if (current === undefined) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${session.id}`));
        await this.publishModelSelection(current);
        return current;
      });
    }
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
    // PKG-003: every frozen dimension is compared, not just the context pipeline.
    const runtimePolicy = snapshot[RUNTIME_POLICY_SNAPSHOT_KEY] as
      | EffectiveRuntimePolicySnapshot
      | RuntimePolicySnapshotV2
      | undefined;
    if (runtimePolicy !== undefined) await this.reportPolicyDrift(session.id, runtimePolicy);
    // Display metadata never supplies model/tools/permissions/skills/limits.
    // Existing registry metadata keeps precedence; a restarted registry may
    // lack this durable ID, in which case use only a validated cosmetic record.
    const stored = snapshot.agentMetadata as Record<string, unknown> | undefined;
    const savedMeta: Pick<AgentDefinition, "name" | "description" | "mode"> | undefined = stored !== null && typeof stored === "object" && !Array.isArray(stored)
      && stored.version === 1 && stored.agentId === cfg.agentId && typeof stored.name === "string"
      && typeof stored.description === "string" && (stored.mode === "primary" || stored.mode === "subagent")
      ? { name: stored.name, description: stored.description, mode: stored.mode } : undefined;
    const meta = this.agents.get(session.agentId) ?? savedMeta;
    return {
      id: cfg.agentId,
      name: meta?.name ?? cfg.agentId,
      description: meta?.description ?? "",
      mode: meta?.mode ?? "primary",
      model: session.modelSelection?.model ?? cfg.model,
      systemPrompt: cfg.systemPrompt,
      tools: cfg.tools,
      permissions: cfg.permissions,
      skills: cfg.skills,
      limits: cfg.limits,
    };
  }


}

// Q-1: below are re-exports of pure helpers now living in ./turn-helpers.js.
// Public API preserved: renderToolResult/buildResumePrompt/classifyUnknownOutcome
// are re-exported so `export * from ./runtime.js` in index.ts stays stable.
export { renderToolResult, buildResumePrompt, classifyUnknownOutcome };
