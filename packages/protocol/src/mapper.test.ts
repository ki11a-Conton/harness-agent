import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { ProtocolEventMapper, mapEvents } from "./mapper.js";

function evt(
  type: AgentEvent["type"],
  seq: number,
  payload: Record<string, unknown> = {},
  turnId?: string,
): AgentEvent {
  return {
    id: `evt-${seq}` as AgentEvent["id"],
    sessionId: "sess-1" as AgentEvent["sessionId"],
    turnId: turnId as AgentEvent["turnId"],
    sequence: seq,
    timestamp: 1000 + seq,
    type,
    payload,
  };
}

const mapper = new ProtocolEventMapper();

describe("P29-6 ProtocolEventMapper golden", () => {
  it("maps model.delta to item/delta", () => {
    const e = evt("model.delta", 5, { text: "hel" }, "turn-1");
    expect(mapper.map(e, "thr-1")).toEqual({
      sequence: 5,
      threadId: "thr-1",
      turnId: "turn-1",
      type: "item/delta",
      delta: { text: "hel" },
    });
  });

  it("maps model.completed to an agent_message item", () => {
    const e = evt(
      "model.completed",
      6,
      { text: "answer", final: true, usage: { inputTokens: 10, outputTokens: 20 } },
      "t1",
    );
    const mapped = mapper.map(e, "thr-1");
    expect(mapped?.type).toBe("item/completed");
    expect(mapped?.item).toMatchObject({
      kind: "agent_message",
      text: "answer",
      final: true,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it("maps tool.started to a tool_call item", () => {
    const e = evt("tool.started", 7, { tool: "bash", toolCallId: "c1", callIndex: 0, args: { cmd: "ls" } }, "t1");
    const mapped = mapper.map(e, "thr-1");
    expect(mapped?.item).toMatchObject({
      kind: "tool_call",
      tool: "bash",
      id: "c1",
      args: { cmd: "ls" },
      callIndex: 0,
    });
  });

  it("maps approval.created to an approval item with scope passthrough", () => {
    const e = evt("approval.created", 8, { approvalId: "ap1", action: "exec", target: "npm test", scope: "one_tool", reason: "r" }, "t1");
    const mapped = mapper.map(e, "thr-1");
    expect(mapped?.item).toMatchObject({
      kind: "approval",
      approvalId: "ap1",
      scope: "one_tool",
    });
  });

  it("maps turn.completed to turn/completed", () => {
    const e = evt("turn.completed", 9, {}, "t1");
    expect(mapper.map(e, "thr-1")).toEqual({
      sequence: 9,
      threadId: "thr-1",
      turnId: "t1",
      type: "turn/completed",
    });
  });

  it("maps turn.cancelled to turn/interrupted", () => {
    const e = evt("turn.cancelled", 10, {}, "t1");
    const mapped = mapper.map(e, "thr-1");
    expect(mapped?.type).toBe("turn/interrupted");
  });

  it("maps turn.failed to turn/failed with error info", () => {
    const e = evt("turn.failed", 11, { code: "TOOL_ERROR", message: "boom", retryable: true }, "t1");
    const mapped = mapper.map(e, "thr-1");
    expect(mapped).toMatchObject({
      type: "turn/failed",
      error: { code: "TOOL_ERROR", message: "boom", retryable: true },
    });
  });

  it("drops non-visible events (trace/progress/policy)", () => {
    for (const type of [
      "context.built",
      "tool.progress",
      "security.injection_denied",
      "checkpoint.created",
    ] as const) {
      expect(mapper.map(evt(type, 1), "thr-1")).toBeNull();
    }
  });

  it("batch mapping is deterministic (same input → same output)", () => {
    const events = [
      evt("turn.started", 1, {}, "t1"),
      evt("model.started", 2, {}, "t1"),
      evt("model.delta", 3, { text: "a" }, "t1"),
      evt("tool.started", 4, { tool: "bash", toolCallId: "c1" }, "t1"),
      evt("turn.completed", 5, {}, "t1"),
    ];
    const first = mapEvents(new ProtocolEventMapper(), events, "thr-1");
    const second = mapEvents(new ProtocolEventMapper(), events, "thr-1");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.length).toBe(4); // model.started, model.delta, tool.started, turn.completed (turn.started dropped)
  });
});