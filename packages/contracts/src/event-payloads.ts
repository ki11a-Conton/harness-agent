import type { EventType } from "./event.js";
import type { ToolResult } from "./tool.js";

/**
 * Q-4: typed payload map for key events.
 *
 * The generic `AgentEvent.payload` stays `Record<string, unknown>` for
 * backward compatibility with stored/replayed event logs, but this map gives
 * every event type its canonical, compile-time-checked payload shape so a
 * field name never drifts between producers (e.g. `tool.requested` using
 * `name` while `tool.failed` uses `tool`). Consumers read through the typed
 * accessors below instead of hand-rolling `payload.x ?? payload.y`.
 *
 * Any event type not listed here falls back to `Record<string, unknown>`.
 */

/** Pending response for a generic payload carrying a tool name.
 *  `tool` is canonical; `name` is accepted as a legacy alias from pre-Q-4
 *  producers/logs so stored events keep replaying correctly. */
export interface TypedToolPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  status?: string;
  error?: unknown;
}

/** tool.requested — what the model asked the orchestrator to run. */
export interface ToolRequestedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** tool.started — execution of a tool call began. */
export interface ToolStartedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
}

/** P16-1: durable execution intent for a side-effecting tool call — the
 *  record persisted BEFORE the real executor runs (intent persistence
 *  failure → the side effect does NOT execute, fail-closed). */
export interface ToolIntentPayload {
  toolCallId: string;
  tool: string;
  /** Stable structural hash of the call args. */
  argsHash: string;
  /** sideEffectScope at the time of the call ("filesystem"/"process"/...). */
  sideEffectScope: string;
  /** Idempotent/readOnly semantics snapshot (reconciliation decisions). */
  idempotent: boolean;
  readOnly: boolean;
  startedAt: number;
  sessionId: string;
  turnId?: string;
  stepId?: string;
  /** P26-4: frozen step-world identity (filled by the production
   *  AgentRuntime path; optional for legacy callers). */
  routerFingerprint?: string;
  toolBindingFingerprint?: string;
}

/** P26-4: the side-effect lifecycle journal state machine —
 *  INTENT_PERSISTED → EXECUTION_STARTED → OUTCOME_COMMITTED → CHECKPOINT
 *  (policy). Every side-effecting tool persists enough identity to classify
 *  a crash: intent (ToolIntentPayload), outcome (ToolOutcomeJournalPayload).
 */
export interface ToolOutcomeJournalPayload {
  toolCallId: string;
  status: ToolResult["status"];
  /** Stable hash of the normalized result output (nil on failure/cancel). */
  resultHash?: string;
  /** Evidence hashes (e.g. file content hashes) when the tool reports them. */
  evidenceHashes?: string[];
}

/** tool.output — streaming output chunks from a tool. */
export interface ToolOutputPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  stream?: "stdout" | "stderr";
  text?: string;
}

/** tool.progress — P18-5 progress channel: an in-flight progress signal,
 *  separate from the terminal result. It NEVER settles the call and never
 *  enters the durable ledger as completion. */
export interface ToolProgressPayload {
  toolCallId: string;
  tool?: string;
  text?: string;
}

/** tool.completed — a tool returned without throwing. */
export interface ToolCompletedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  status?: string;
  durationMs?: number;
}

/** tool.failed — a tool threw or was denied. */
export interface ToolFailedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  error?: unknown;
  durationMs?: number;
}

/** tool.permission_requested — an approval request was created. */
export interface ToolPermissionRequestedPayload {
  toolCallId?: string;
  tool?: string;
  name?: string;
  approvalId?: string;
}

/** tool.permission_resolved — an approval decision was applied. */
export interface ToolPermissionResolvedPayload {
  toolCallId?: string;
  tool?: string;
  name?: string;
  approvalId?: string;
  effect?: string;
}

/** model.completed — a model call finished. */
export interface ModelCompletedPayload {
  callId?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  toolCalls?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    estimatedCostUsd?: number;
    estimatedCost?: number;
    cost?: number;
  };
}

/** model.retry — a transient model failure (pre-stream or provider-level). */
export interface ModelRetryPayload {
  callId?: string;
  attempt: number;
  error?: unknown;
}

/** model.started — a model call began. */
export interface ModelStartedPayload {
  callId?: string;
  turnId?: string;
  /** P23-1: the step this model call belongs to. */
  stepId?: string;
  /** P23-1: durable snapshot fingerprints so replay/explain can correlate
   *  one model call with the exact execution snapshot that produced it. */
  toolRouterFingerprint?: string;
  policyFingerprint?: string;
  environmentFingerprint?: string;
  contextFingerprint?: string;
  instructionFingerprint?: string;
  /** P23-7: the exact message/block ids visible to this model call — replay
   *  and explain can state WHICH messages the model saw without duplicating
   *  the transcript. */
  contextMessageIds?: string[];
  contextBlockIds?: string[];
}

/** model.failed — a model call failed terminally. */
export interface ModelFailedPayload {
  callId?: string;
  error?: unknown;
}

/** verification.completed — the verification gate passed. */
export interface VerificationCompletedPayload {
  passed: boolean;
  durationMs?: number;
}

/** verification.failed — the verification gate rejected the turn. */
export interface VerificationFailedPayload {
  error?: unknown;
  attempt: number;
  maxAttempts: number;
  durationMs?: number;
}

/** context.built — a context assembly completed for a model call. */
export interface ContextBuiltPayload {
  tokens?: number;
  used?: number;
  budget?: number;
  dropped?: number;
  compacted?: boolean;
  messagesTokens?: number;
}

/** instruction.discovered — an AGENTS.md document reached the model. */
export interface InstructionDiscoveredPayload {
  path?: string;
  scope?: "root" | "nested" | "cwd";
  sizeBytes?: number;
  truncated?: boolean;
}

/** policy.changed_on_resume — host policy drifted since the session was
 *  created; a safe-resume gate made it observable. */
export interface PolicyChangedOnResumePayload {
  contextPolicyChanged?: boolean;
  contextPolicyHash?: string;
  stored?: string;
}

/** context.compacted — context was summarised to reclaim budget. */
export interface ContextCompactedPayload {
  compressed?: number;
  reason?: string;
  reactive?: boolean;
  totalCount?: number;
  /** Legacy field read by packages/evaluation attribution; kept for
   *  backward compatibility with events that carried it. */
  overflow?: boolean;
}

/** P17-6: a compaction digest FAILED to preserve one or more protected
 *  fields (goal/constraints/decisions/pending/files/commands/tests/failures/
 *  memory-skill-child refs). Surfaced as a violation, never silent. */
export interface ContextProtectedFactsViolationPayload {
  turnId?: string;
  missing: Array<{ field: string; item: string }>;
  digestLength: number;
}

/** command.discovered — P7-6 lazy command discovery found the workspace's
 *  test/typecheck/build commands after a code-changing turn. */
export interface CommandDiscoveredPayload {
  cwd?: string;
  commands?: Record<string, string>;
}

/** verification.step_started / verification.step_completed — P8-2
 *  incremental verification evidence. `ref` is the stable step reference
 *  that subagent testsRun and reports cite. */
export interface VerificationStepPayload {
  ref?: string;
  kind?: string;
  description?: string;
  passed?: boolean;
  detail?: string;
}

/** tools.selected — P7-3 tool disclosure telemetry: how many schemas were
 *  available, how many were advertised to the model, and which were dropped.
 *  P18-2: advertisedTokens prices the advertisement (estimateSpecsTokens) so
 *  benchmarks can compare full vs deferred schema cost directly. */
export interface ToolsSelectedPayload {
  callId?: string;
  available?: number;
  selected?: number;
  dropped?: string[];
  advertisedTokens?: number;
}

/** context.candidate/selected/dropped — P6-3 selection telemetry. One event
 *  per block fact; payload carries source/priority/tokens/reason, never the
 *  content itself (selection metrics must not log sensitive data). */
export interface ContextSelectionPayload {
  source?: string;
  id?: string;
  priority?: number;
  tokens?: number;
  reason?: string;
}

/** run.limit_reached — a turn budget was exhausted. */
export interface RunLimitReachedPayload {
  limit: string;
  used?: number;
  allowed?: number;
  pattern?: string;
}

/** turn.completed / turn.failed / turn.cancelled — a turn reached a terminal
 *  state. P19-1: the runtime stamps the verified-completion `grade` and the
 *  bounded `terminationReason` ONCE here; consumers read them from this event
 *  (or the outcome) — never from model wording. */
export interface TurnTerminalPayload {
  status?: string;
  /** P2-38: partial-failure classification (failed_with_effects / blocked /
   *  cancelled_no_effect / waiting_*). */
  statusDetail?: string;
  falseComplete?: boolean;
  spurious?: boolean;
  endReason?: string;
  /** P2-39: bounded TerminationReason. */
  terminationReason?: string;
  /** P19-1: verified-completion grade (unverified_complete / verification_
   *  failed / verified_partial / verified_complete). */
  grade?: string;
  /** P19-1: gate evidence (passedSteps/totalSteps) that produced the grade. */
  completionEvidence?: { passedSteps: number; totalSteps: number };
  error?: unknown;
}

/** memory.retrieved — pre-turn memory retrieval (plan.md P2-2). The runtime
 *  emits one event per turn when a memory bridge is wired, naming the memory
 *  ids admitted as prior context blocks and how many were suppressed. */
export interface MemoryRetrievedPayload {
  query?: string;
  scope?: string;
  count?: number;
  memoryIds?: string[];
  suppressed?: number;
}

/** reflection.completed — post-turn reflection (plan.md P2-5). One event per
 *  turn terminal outcome; `outputs` are the reflection records produced and
 *  `candidates` the procedural memory candidates that passed the write gate. */
export interface ReflectionCompletedPayload {
  turnId?: string;
  outcome?: string;
  outputs?: number;
  candidates?: number;
}

/** approval.resolved — an approval decision was recorded. */
export interface ApprovalResolvedPayload {
  approvalId?: string;
  decision?: string;
  value?: string;
}

/** mcp.connect_failed — P24-7: a NEEDED MCP server could not be connected.
 *  The step proceeds WITHOUT it (built-in tools remain available); the event
 *  carries the server id so the failure is observable, never silent. */
export interface McpConnectFailedPayload {
  serverId?: string;
  error?: unknown;
}

/** recovery.decided — P19-3: the recovery planner chose a bounded action for
 *  a failure input. Consumers branch on the TYPED action, never on reason
 *  strings; used/remaining expose the per-turn budget position. */
export interface RecoveryDecidedPayload {
  action: string;
  input: string;
  toolCallId?: string;
  tool?: string;
  used?: number;
  remaining?: number;
  reason?: string;
}

/** protocol.repaired / protocol.repair_failed — P19-5: typed protocol
 *  self-heal. `evidence` preserves what was observed before/after the repair —
 *  a dropped call id never silently vanishes. */
export interface ProtocolRepairPayload {
  repairId?: string;
  kind: string;
  action: "recover" | "fail_safe";
  evidence?: {
    kind?: string;
    repaired?: boolean;
    action?: string;
    before?: unknown;
    after?: unknown;
    detail?: string;
  };
  reason?: string;
}

/** subagent.started / subagent.completed / subagent.failed — a delegated
 *  subagent's lifecycle. P20-6 trace tree: parentSpanId carries the spawning
 *  call so the tree rebuilds from the event stream. */
export interface SubagentPayload {
  subagentId?: string;
  parentCallId?: string;
  delegatedBy?: string;
  goal?: string;
  durationMs?: number;
  error?: unknown;
}

/** security.*_denied — a security boundary rejected an action. */
export interface SecurityDeniedPayload {
  reason?: string;
  error?: unknown;
}

/** runtime.degraded — a best-effort subsystem failed non-fatally. The event
 *  exists so P14-6 "no silent catches" stays true: a background/cleanup/
 *  telemetry failure that must not break the run is still observable, with
 *  the failing context and reason. */
export interface RuntimeDegradedPayload {
  /** Subsystem that degraded (e.g. "orchestrator.emit", "skill-loader.load"). */
  context: string;
  /** Human-readable failure reason. */
  reason: string;
}

/**
 * Canonical payload for every known event type. Unlisted types default to a
 * general record so the map stays total over EVENT_TYPES.
 */
export interface EventPayloadMap {
  "tool.requested": ToolRequestedPayload;
  "tool.permission_requested": ToolPermissionRequestedPayload;
  "tool.permission_resolved": ToolPermissionResolvedPayload;
  "tool.intent_persisted": ToolIntentPayload;
  "tool.started": ToolStartedPayload;
  "tool.output": ToolOutputPayload;
  "tool.progress": ToolProgressPayload;
  "tool.completed": ToolCompletedPayload;
  "tool.failed": ToolFailedPayload;
  "tools.selected": ToolsSelectedPayload;
  "model.started": ModelStartedPayload;
  "model.completed": ModelCompletedPayload;
  "model.failed": ModelFailedPayload;
  "model.retry": ModelRetryPayload;
  "verification.completed": VerificationCompletedPayload;
  "verification.step_started": VerificationStepPayload;
  "verification.step_completed": VerificationStepPayload;
  "verification.failed": VerificationFailedPayload;
  "command.discovered": CommandDiscoveredPayload;
  "context.built": ContextBuiltPayload;
  "context.compacted": ContextCompactedPayload;
  "context.protected_facts_violation": ContextProtectedFactsViolationPayload;
  "context.candidate": ContextSelectionPayload;
  "context.selected": ContextSelectionPayload;
  "context.dropped": ContextSelectionPayload;
  "instruction.discovered": InstructionDiscoveredPayload;
  "policy.changed_on_resume": PolicyChangedOnResumePayload;
  "memory.retrieved": MemoryRetrievedPayload;
  "reflection.completed": ReflectionCompletedPayload;
  "run.limit_reached": RunLimitReachedPayload;
  "turn.completed": TurnTerminalPayload;
  "turn.failed": TurnTerminalPayload;
  "turn.cancelled": TurnTerminalPayload;
  "recovery.decided": RecoveryDecidedPayload;
  "mcp.connect_failed": McpConnectFailedPayload;
  "protocol.repaired": ProtocolRepairPayload;
  "protocol.repair_failed": ProtocolRepairPayload;
  "subagent.started": SubagentPayload;
  "subagent.completed": SubagentPayload;
  "subagent.failed": SubagentPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "runtime.degraded": RuntimeDegradedPayload;
  "security.network_denied": SecurityDeniedPayload;
  "security.injection_denied": SecurityDeniedPayload;
  "security.permission_denied": SecurityDeniedPayload;
  "security.filesystem_denied": SecurityDeniedPayload;
  "security.process_denied": SecurityDeniedPayload;
  "security.secret_redacted": SecurityDeniedPayload;
  "security.memory_denied": SecurityDeniedPayload;
  "security.skill_denied": SecurityDeniedPayload;
  "security.mcp_denied": SecurityDeniedPayload;
  "security.approval_denied": SecurityDeniedPayload;
  "security.capability_denied": SecurityDeniedPayload;
}

/** Payload type for a given event type (falls back to a generic record). */
export type EventPayloadOf<T extends EventType> = T extends keyof EventPayloadMap
  ? EventPayloadMap[T]
  : Record<string, unknown>;

/**
 * Canonical tool-name accessor. Prefers the canonical `tool` field, then the
 * legacy `name` alias (pre-Q-4 producers / older stored logs). Every evaluator
 * should use this instead of guessing which field a producer emitted.
 */
export function toolNameOf(payload: object): string | undefined {
  const record = payload as Readonly<Record<string, unknown>>;
  const t = record.tool;
  if (typeof t === "string" && t !== "") return t;
  const n = record.name;
  return typeof n === "string" && n !== "" ? n : undefined;
}

/**
 * Static guarantee that every event type in EVENT_TYPES has a declared payload
 * shape. Kept as a value so dropping/renaming a type above surfaces here.
 */
export const EVENT_PAYLOAD_TYPES = {
  "tool.requested": true,
  "tool.permission_requested": true,
  "tool.permission_resolved": true,
  "tool.intent_persisted": true,
  "tool.started": true,
  "tool.output": true,
  "tool.progress": true,
  "tool.completed": true,
  "tool.failed": true,
  "model.completed": true,
  "model.retry": true,
  "verification.completed": true,
  "verification.failed": true,
  "context.compacted": true,
  "context.protected_facts_violation": true,
  "run.limit_reached": true,
  "turn.completed": true,
  "turn.failed": true,
  "turn.cancelled": true,
  "recovery.decided": true,
  "mcp.connect_failed": true,
  "protocol.repaired": true,
  "protocol.repair_failed": true,
  "subagent.started": true,
  "subagent.completed": true,
  "subagent.failed": true,
  "approval.resolved": true,
  "security.network_denied": true,
  "security.injection_denied": true,
  "security.permission_denied": true,
  "security.filesystem_denied": true,
  "security.process_denied": true,
  "security.secret_redacted": true,
  "security.memory_denied": true,
  "security.skill_denied": true,
  "security.mcp_denied": true,
  "security.approval_denied": true,
  "security.capability_denied": true,
  "runtime.degraded": true,
} as const satisfies Record<string, true>;