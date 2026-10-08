/**
 * P29-6 — Protocol Event Mapper.
 *
 * Core `AgentEvent`s (the internal truth) are projected DETERMINISTICALLY onto
 * wire `TurnEvent`s. The mapping is a pure function of an `AgentEvent` and a
 * thread id — no hidden state, no randomness — so golden tests can lock the
 * exact wire output for a fixed event input, and a replay over the same store
 * sequence yields the identical client stream.
 *
 * Mapping table (event type → wire event kind):
 *   model.start            → item/started   (agent_message)
 *   model.chunk            → item/delta
 *   message.completed      → item/completed (agent_message / user_message)
 *   tool.started           → item/started   (tool_call)
 *   tool.completed         → item/completed (tool_result)
 *   approval.created       → item/started   (approval)
 *   ask.user_asked         → item/started   (ask_user)
 *   turn.completed         → turn/completed
 *   turn.cancelled         → turn/interrupted
 *   turn.failed            → turn/failed
 */
import type { AgentEvent } from "@ar/contracts";
import type { ThreadId } from "./ids.js";
import type { TurnEvent, TurnEventName } from "./types.js";

export class ProtocolEventMapper {
  /**
   * Map a single core AgentEvent to a wire TurnEvent (or null when the event
   * is not part of the visible stream — e.g. internal trace/progress events).
   */
  map(event: AgentEvent, threadId: ThreadId): TurnEvent | null {
    const base = {
      sequence: event.sequence,
      threadId,
      turnId: event.turnId ?? "unknown",
    };
    switch (event.type) {
      case "turn.started":
        if (typeof event.payload.text !== "string") return null;
        return { ...base, type: "item/completed", item: {
          kind: "user_message", sequence: event.sequence, threadId, turnId: event.turnId, timestamp: event.timestamp, text: event.payload.text,
        } };
      case "model.started":
        return { ...base, type: "item/started", itemId: event.id };
      case "model.delta":
        if (event.payload.kind !== undefined && event.payload.kind !== "text") return null;
        return {
          ...base,
          type: "item/delta",
          delta: {
            text: typeof event.payload.text === "string" ? event.payload.text : "",
          },
        };
      case "model.completed":
        return {
          ...base,
          type: "item/completed",
          item: {
            kind: "agent_message",
            sequence: event.sequence,
            threadId,
            turnId: event.turnId,
            timestamp: event.timestamp,
            text:
              typeof event.payload.text === "string"
                ? event.payload.text
                : "",
            final: event.payload.final === true,
            usage: visibleUsage(event.payload.usage),
          },
        };
      case "tool.started":
        return {
          ...base,
          type: "item/started",
          item: {
            kind: "tool_call",
            sequence: event.sequence,
            threadId,
            turnId: event.turnId,
            timestamp: event.timestamp,
            tool:
              typeof event.payload.tool === "string"
                ? event.payload.tool
                : "unknown",
            id:
              typeof event.payload.toolCallId === "string"
                ? event.payload.toolCallId
                : event.id,
            args:
              typeof event.payload.args === "object" && event.payload.args !== null
                ? (event.payload.args as Record<string, unknown>)
                : {},
            callIndex:
              typeof event.payload.callIndex === "number"
                ? event.payload.callIndex
                : 0,
          },
        };
      case "tool.completed":
        return {
          ...base,
          type: "item/completed",
          item: {
            kind: "tool_result",
            sequence: event.sequence,
            threadId,
            turnId: event.turnId,
            timestamp: event.timestamp,
            tool:
              typeof event.payload.tool === "string"
                ? event.payload.tool
                : "unknown",
            id:
              typeof event.payload.toolCallId === "string"
                ? event.payload.toolCallId
                : event.id,
            callIndex:
              typeof event.payload.callIndex === "number"
                ? event.payload.callIndex
                : 0,
            ok: true,
          },
        };
      case "tool.failed":
        return {
          ...base,
          type: "item/completed",
          item: {
            kind: "tool_result",
            sequence: event.sequence,
            threadId,
            turnId: event.turnId,
            timestamp: event.timestamp,
            tool:
              typeof event.payload.tool === "string"
                ? event.payload.tool
                : "unknown",
            id:
              typeof event.payload.toolCallId === "string"
                ? event.payload.toolCallId
                : event.id,
            callIndex:
              typeof event.payload.callIndex === "number"
                ? event.payload.callIndex
                : 0,
            ok: false,
            error:
              typeof event.payload.error === "string"
                ? event.payload.error
                : "tool failed",
          },
        };
      case "approval.created": {
        const scope = event.payload.scope === "session" || event.payload.scope === "one_tool"
          ? event.payload.scope
          : "one_call";
        return {
          ...base,
          type: "item/started",
          item: {
            kind: "approval",
            sequence: event.sequence,
            threadId,
            turnId: event.turnId,
            timestamp: event.timestamp,
            approvalId:
              typeof event.payload.approvalId === "string"
                ? event.payload.approvalId
                : event.id,
            action:
              typeof event.payload.action === "string"
                ? event.payload.action
                : "unknown",
            target:
              typeof event.payload.target === "string"
                ? event.payload.target
                : "unknown",
            reason:
              typeof event.payload.reason === "string"
                ? event.payload.reason
                : "",
            scope,
          },
        };
      }
      case "turn.completed":
        return { ...base, type: "turn/completed" };
      case "turn.cancelled":
        return { ...base, type: "turn/interrupted" };
      case "turn.failed": {
        // Runtime records the typed AgentErrorInfo under payload.error. Keep
        // the former flat DTO form compatible with existing external stores.
        const failure = typeof event.payload.error === "object" && event.payload.error !== null
          ? event.payload.error as Record<string, unknown> : event.payload;
        return {
          ...base,
          type: "turn/failed",
          error: {
            code:
              typeof failure.code === "string"
                ? failure.code
                : "INTERNAL_ERROR",
            message:
              typeof failure.message === "string"
                ? failure.message
                : "turn failed",
            retryable: failure.retryable === true,
          },
        };
      }
      case "session.forked": {
        // A copied historical observation carries no live turn, approval or
        // tool-execution authority. Never project private reasoning content.
        const history = event.payload.historyMessage;
        if (event.payload.historical !== true || typeof history !== "object" || history === null) return null;
        const message = history as Record<string, unknown>;
        if (typeof message.content !== "string") return null;
        const itemBase = { sequence: event.sequence, threadId, timestamp: typeof message.timestamp === "number" ? message.timestamp : event.timestamp };
        if (message.role === "user") return { ...base, type: "item/completed", item: { ...itemBase, kind: "user_message", text: message.content } };
        if (message.role === "assistant") return { ...base, type: "item/completed", item: { ...itemBase, kind: "agent_message", text: message.content } };
        if (message.role === "tool") return { ...base, type: "item/completed", item: { ...itemBase, kind: "runtime_warning", message: `[Historical tool result; no tool executed in this branch] ${message.content}` } };
        return null;
      }
      default:
        return null; // not part of the visible stream (trace/progress/policy)
    }
  }

  /** Map an event but never throw — used for tolerant streams. */
  mapSafe(event: AgentEvent, threadId: ThreadId): TurnEvent | null {
    try {
      return this.map(event, threadId);
    } catch {
      return null;
    }
  }
}

function visibleUsage(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number" ||
      !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens) ||
      usage.inputTokens < 0 || usage.outputTokens < 0) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/** Convenience: map a batch of events, discarding nulls. */
export function mapEvents(
  mapper: ProtocolEventMapper,
  events: readonly AgentEvent[],
  threadId: ThreadId,
): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const e of events) {
    const m = mapper.map(e, threadId);
    if (m !== null) out.push(m);
  }
  return out;
}
