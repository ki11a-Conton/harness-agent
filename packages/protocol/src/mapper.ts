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
      case "model.started":
        return { ...base, type: "item/started", itemId: event.id };
      case "model.delta":
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
            usage:
              event.payload.usage !== undefined
                ? (event.payload.usage as {
                    inputTokens: number;
                    outputTokens: number;
                  })
                : undefined,
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
      case "turn.failed":
        return {
          ...base,
          type: "turn/failed",
          error: {
            code:
              typeof event.payload.code === "string"
                ? event.payload.code
                : "INTERNAL_ERROR",
            message:
              typeof event.payload.message === "string"
                ? event.payload.message
                : "turn failed",
            retryable: event.payload.retryable === true,
          },
        };
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