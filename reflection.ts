import type {
  AgentEvent,
  ErrorCode,
  EventType,
  MemoryCandidate,
  ReflectionOutput,
  SessionId,
  TurnId,
} from "@ar/contracts";
import { ERROR_CODES } from "@ar/contracts";

/** §164 failure attribution categories. */
export type FailureRootCause =
  | "model"
  | "context"
  | "tool"
  | "permission"
  | "sandbox"
  | "environment"
  | "verification";

/** Failure event types the reflector scans (§68). turn.cancelled is not a failure. */
export const FAILURE_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "turn.failed",
  "tool.failed",
  "verification.failed",
  "model.failed",
]);

export interface ReflectDeps {
  events: AgentEvent[];
  taskGoal?: string;
}

/**
 * REFLECTION-001: deterministic (§68) rule-based reflection over an event
 * stream — no LLM. Every failure event is attributed to a §164 root cause,
 * backed by evidence (related event ids + timestamps) and a template lesson,
 * and yields one procedural memory candidate. Aggregation: no failures -> [];
 * failures sharing a root cause (and, for tool failures, the same tool) are
 * deduped into a single output; persistence is left to the §67 write gate
 * (reflection never writes, §181).
 */
export class Reflector {
  reflect({ events, taskGoal }: ReflectDeps): ReflectionOutput[] {
    const toolNames = new Map<string, string>();
    for (const event of events) {
      const callId = stringOf(event.payload, ["toolCallId"]);
      const name = toolNameOf(event.payload);
      if (callId !== undefined && name !== undefined) toolNames.set(callId, name);
    }

    const groups = new Map<string, ReflectionGroup>();
    const order: string[] = [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (!FAILURE_EVENT_TYPES.has(event.type)) continue;
      const cause = attribute(event);
      if (cause === undefined) continue;

      const turnId = resolveTurnId(events, index);
      const tool = cause === "tool"
        ? (failureTool(event, toolNames) ?? precedingTurnTool(events, index, turnId, toolNames))
        : undefined;
      const key = cause === "tool" ? `tool:${tool ?? ""}` : cause;
      const outcome: "failure" | "partial" =
        event.type === "turn.failed" || !recovered(events, index, event, turnId)
          ? "failure"
          : "partial";
      const detail = errorDetailOf(event.payload);
      const lesson = lessonFor(cause, detail, tool);
      const strategy = strategyFor(cause, detail, tool);
      const evidence = renderEvidence(
        event,
        relatedEvents(events, index, event, turnId),
        taskGoal,
      );
      const severity = event.type === "turn.failed" ? 0.9 : SEVERITY[cause];

      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          cause,
          sessionId: event.sessionId,
          lesson,
          strategy,
          evidences: [evidence],
          evidenceRefs: [event.id],
          importance: severity,
          outcome,
        });
        order.push(key);
      } else {
        group.evidences.push(evidence);
        group.evidenceRefs.push(event.id);
        group.importance = Math.max(group.importance, severity);
        if (outcome === "failure") group.outcome = "failure";
      }
    }

    return order.map((key) => {
      const group = groups.get(key)!;
      return {
        outcome: group.outcome,
        rootCause: group.cause,
        evidence: group.evidences.join("; "),
        lesson: group.lesson,
        generalizable: !NON_GENERALIZABLE_CAUSES.has(group.cause),
        candidate: candidateFor(group.sessionId, group.lesson, group.importance, group),
      };
    });
  }
}

interface ReflectionGroup {
  cause: FailureRootCause;
  sessionId: SessionId;
  lesson: string;
  strategy: { when: string; do: string; avoid: string };
  evidences: string[];
  evidenceRefs: string[];
  importance: number;
  outcome: "failure" | "partial";
}

/** Contracts error taxonomy -> §164 root cause. */
const CAUSE_BY_CODE: Partial<Record<ErrorCode, FailureRootCause>> = {
  MODEL_ERROR: "model",
  TOOL_SCHEMA_ERROR: "tool",
  PROCESS_ERROR: "tool",
  PROCESS_TIMEOUT: "tool",
  PERMISSION_DENIED: "permission",
  APPROVAL_DENIED: "permission",
  SANDBOX_DENIED: "sandbox",
  CONTEXT_OVERFLOW: "context",
  VERIFICATION_FAILED: "verification",
  NETWORK_ERROR: "environment",
  RESOURCE_LIMIT: "environment",
};

/**
 * §45 policy denials are not auto-retryable and their lessons are
 * session-specific, so they do not generalize into reusable procedural
 * memory.
 */
const NON_GENERALIZABLE_CAUSES: ReadonlySet<FailureRootCause> = new Set([
  "permission",
  "sandbox",
]);

/** Failure severity by root cause; a failed turn (turn.failed) is always 0.9. */
const SEVERITY: Record<FailureRootCause, number> = {
  model: 0.6,
  context: 0.7,
  tool: 0.6,
  permission: 0.5,
  sandbox: 0.5,
  environment: 0.5,
  verification: 0.8,
};

/** Rule-estimate candidate quality, constant until evaluation (§67). */
const CANDIDATE_CONFIDENCE = 0.6;
const CANDIDATE_NOVELTY = 0.5;
const CANDIDATE_STABILITY = 0.5;

interface FailureDetail {
  code?: ErrorCode;
  message?: string;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

function stringOf(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Extract the error code/message from a failure event payload, honoring the
 * runtime convention (TRACE-001): `payload.error` is an AgentErrorInfo-shaped
 * object, a plain string (verification.failed reason), or a "CODE: ..." string.
 */
function errorDetailOf(payload: Record<string, unknown>): FailureDetail {
  const direct = payload.code;
  if (isErrorCode(direct)) {
    return { code: direct, message: stringOf(payload, ["message"]) };
  }
  const raw = payload.error;
  if (typeof raw === "string") {
    for (const code of ERROR_CODES) {
      if (raw.startsWith(`${code}:`) || raw.startsWith(`${code} `)) {
        return { code, message: raw };
      }
    }
    return { message: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const nested = record.info;
    const info =
      typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : {};
    const code = record.code ?? info.code;
    if (isErrorCode(code)) {
      return {
        code,
        message: stringOf(record, ["message"]) ?? stringOf(info, ["message"]),
      };
    }
    const message = stringOf(record, ["message"]);
    if (message !== undefined) return { message };
  }
  return {};
}

/**
 * §164 attribution: the contracts error code wins; otherwise the event type's
 * natural cause. INTERNAL_ERROR is a tool implementation failure on
 * tool.failed and an environment failure elsewhere. USER_CANCELLED is not an
 * agent failure (nothing to learn) and is skipped.
 */
function attribute(event: AgentEvent): FailureRootCause | undefined {
  const { code } = errorDetailOf(event.payload);
  if (code === "USER_CANCELLED") return undefined;
  if (code === "INTERNAL_ERROR") {
    return event.type === "tool.failed" ? "tool" : "environment";
  }
  if (code !== undefined) {
    const cause = CAUSE_BY_CODE[code];
    if (cause !== undefined) return cause;
  }
  switch (event.type) {
    case "tool.failed":
      return "tool";
    case "model.failed":
      return "model";
    case "verification.failed":
      return "verification";
    case "turn.failed":
      return "model";
  }
  return undefined;
}

function toolNameOf(payload: Record<string, unknown>): string | undefined {
  return stringOf(payload, ["tool", "name"]);
}

/** Tool name for a failure: from the payload, else the correlated tool.requested. */
function failureTool(
  event: AgentEvent,
  toolNames: ReadonlyMap<string, string>,
): string | undefined {
  const direct = toolNameOf(event.payload);
  if (direct !== undefined) return direct;
  const callId = stringOf(event.payload, ["toolCallId"]);
  return callId !== undefined ? toolNames.get(callId) : undefined;
}

/**
 * Inherit the failing tool from an earlier same-turn tool failure: a
 * turn.failed that wraps a tool error carries no tool identity, but it must
 * dedupe into the same group as the tool.failed it follows.
 */
function precedingTurnTool(
  events: readonly AgentEvent[],
  index: number,
  turnId: TurnId | undefined,
  toolNames: ReadonlyMap<string, string>,
): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      event.type === "turn.started" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      if (turnId === undefined || event.turnId !== turnId) return undefined;
      continue;
    }
    if (event.type === "tool.failed") {
      const tool = failureTool(event, toolNames);
      if (tool !== undefined) return tool;
    }
  }
  return undefined;
}

/** Enclosing turn for a failure: its own turnId, else the nearest turn.* boundary. */
function resolveTurnId(events: readonly AgentEvent[], index: number): TurnId | undefined {
  const event = events[index]!;
  if (event.turnId !== undefined) return event.turnId;
  for (let i = index; i >= 0; i -= 1) {
    const candidate = events[i]!;
    if (
      candidate.type === "turn.started" ||
      candidate.type === "turn.completed" ||
      candidate.type === "turn.failed" ||
      candidate.type === "turn.cancelled"
    ) {
      return candidate.turnId;
    }
  }
  return undefined;
}

/** Recovery evidence after the failure: same toolCallId completed, or the turn completed. */
function recovered(
  events: readonly AgentEvent[],
  index: number,
  failure: AgentEvent,
  turnId: TurnId | undefined,
): boolean {
  const callId = stringOf(failure.payload, ["toolCallId"]);
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i]!;
    if (
      callId !== undefined &&
      event.type === "tool.completed" &&
      event.payload.toolCallId === callId
    ) {
      return true;
    }
    if (turnId !== undefined && event.turnId === turnId && event.type === "turn.completed") {
      return true;
    }
  }
  return false;
}

/** Related events for evidence: the request that led to the failure, the same-turn
 *  terminal event, and same-turn preceding failures — in sequence order. */
function relatedEvents(
  events: readonly AgentEvent[],
  index: number,
  failure: AgentEvent,
  turnId: TurnId | undefined,
): AgentEvent[] {
  const related: AgentEvent[] = [];
  const callId = stringOf(failure.payload, ["toolCallId"]);
  if (callId !== undefined) {
    for (let i = index; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type === "tool.requested" && event.payload.toolCallId === callId) {
        related.push(event);
        break;
      }
    }
  }
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i]!;
    if (
      turnId !== undefined &&
      event.turnId === turnId &&
      (event.type === "turn.failed" ||
        event.type === "turn.completed" ||
        event.type === "turn.cancelled")
    ) {
      related.push(event);
      break;
    }
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (turnId !== undefined && event.turnId === turnId && FAILURE_EVENT_TYPES.has(event.type)) {
      related.push(event);
    }
  }
  return related.sort((a, b) => a.sequence - b.sequence);
}

function renderEvidence(
  failure: AgentEvent,
  related: readonly AgentEvent[],
  taskGoal: string | undefined,
): string {
  const parts = [`${failure.type} ${failure.id}@${failure.timestamp}`];
  for (const event of related) {
    parts.push(`${event.type} ${event.id}@${event.timestamp}`);
  }
  const body = parts.join("; ");
  return taskGoal !== undefined ? `${body}; task: ${taskGoal}` : body;
}

function lessonFor(
  cause: FailureRootCause,
  detail: FailureDetail,
  tool: string | undefined,
): string {
  const message = detail.message ?? detail.code ?? "no detail";
  switch (cause) {
    case "tool":
      return `tool ${tool ?? "unknown"} failed with ${message}; verify inputs and environment before retry`;
    case "model":
      return `model call failed with ${message}; check the provider and limits before retry`;
    case "context":
      return `context overflow (${message}); compact the context before continuing`;
    case "permission":
      return `action denied by permission policy (${message}); do not retry automatically (§45)`;
    case "sandbox":
      return `action denied by sandbox policy (${message}); do not bypass the sandbox (§45)`;
    case "verification":
      return `verification failed (${message}); inspect the evidence, fix the issue, and re-verify`;
    case "environment":
      return `environment failure (${message}); check the environment state before retrying`;
  }
}

/**
 * P2-1: rule-based strategy lesson (When/Do/Avoid). Deterministic templates
 * keyed by root cause; known tool failure signatures refine the recovery
 * strategy (e.g. ENOENT → search before guessing paths). LLM enrichment is
 * deliberately NOT wired here — rules must never depend on a model.
 */
function strategyFor(
  cause: FailureRootCause,
  detail: FailureDetail,
  tool: string | undefined,
): { when: string; do: string; avoid: string } {
  const message = detail.message ?? detail.code ?? "no detail";
  const toolName = tool ?? "unknown";
  const pathHint = /ENOENT|no such file|not found/i.test(message) ? message : undefined;
  switch (cause) {
    case "tool":
      if (pathHint !== undefined) {
        return {
          when: `${toolName} failed with a missing-path error (${pathHint}) for a guessed or repository-relative path`,
          do: "search the repository tree / file index before retrying guessed paths",
          avoid: "repeating the same guessed path without verifying it exists",
        };
      }
      return {
        when: `${toolName} failed with ${message}`,
        do: "verify inputs and environment state, then retry",
        avoid: "retrying the same call without checking inputs",
      };
    case "model":
      return {
        when: `model call failed with ${message}`,
        do: "check the provider, timeouts and limits, then retry",
        avoid: "retrying blindly against a failing provider",
      };
    case "context":
      return {
        when: `context overflow (${message})`,
        do: "compact the context (digest + trimmed history) before continuing",
        avoid: "continuing with an overflowing context",
      };
    case "permission":
      return {
        when: `action denied by permission policy (${message})`,
        do: "ask the user for an explicit override",
        avoid: "retrying automatically without approval (§45)",
      };
    case "sandbox":
      return {
        when: `action denied by sandbox policy (${message})`,
        do: "keep the action inside the allowed sandbox surface",
        avoid: "bypassing the sandbox (§45)",
      };
    case "verification":
      return {
        when: `verification failed (${message})`,
        do: "inspect the verification evidence, fix the reported issue, and re-verify",
        avoid: "declaring completion without a passing gate",
      };
    case "environment":
      return {
        when: `environment failure (${message})`,
        do: "check the environment state before retrying",
        avoid: "retrying against an unrecoverable environment",
      };
  }
}

function candidateFor(
  sessionId: SessionId,
  lesson: string,
  importance: number,
  group: ReflectionGroup,
): MemoryCandidate {
  return {
    content: lesson,
    type: "procedural",
    sourceSession: sessionId,
    importance,
    confidence: CANDIDATE_CONFIDENCE,
    novelty: CANDIDATE_NOVELTY,
    stability: CANDIDATE_STABILITY,
    structured: {
      when: group.strategy.when,
      do: group.strategy.do,
      avoid: group.strategy.avoid,
      rootCause: group.cause,
      outcome: group.outcome,
      evidenceRefs: [...group.evidenceRefs],
    },
  };
}
