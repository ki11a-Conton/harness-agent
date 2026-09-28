import { describe, expect, it } from "vitest";
import type { Message } from "./message.js";
import { newMessageId, newSessionId } from "./ids.js";
import { assertToolProtocol, isToolProtocolValid } from "./message-protocol.js";

/**
 * F7 / R6 — RED reproducer for the tool-protocol coverage gap.
 *
 * `isToolProtocolValid` / `assertToolProtocol` (message-protocol.ts:37-75)
 * only check ONE direction: an assistant `tool_calls` id that has no adjacent
 * result. Orphaned, duplicated, extra and duplicate-call-id shapes are handled
 * by a DIFFERENT function (`findOrphanToolResults`), so the two helpers are
 * NOT a complete wire-legality guarantee — their names overstate what they
 * prove.
 *
 * This file deliberately uses ONLY the pre-existing API surface so it runs
 * against the baseline SHA and FAILS, proving the gap with a target assertion
 * instead of an import error. The complete valid/invalid table that uses the
 * unified validator lives in `message-protocol.wire.test.ts`.
 *
 * Every case below is a shape a strict OpenAI-compatible upstream rejects with
 * HTTP 400 (the observed `{"code":11148,"msg":"tool calls and tool results do
 * not match"}` family), i.e. a request the harness must never put on the wire.
 */

const sessionId = newSessionId();

function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId, role, content, createdAt: 0, ...extra };
}

const assistantCalls = (ids: readonly string[], content = "calling"): Message =>
  message("assistant", content, { toolCalls: ids.map((id) => ({ id: id as never, name: "read_file", args: {} })) });

const toolResult = (id: string, content = "ok"): Message =>
  message("tool", content, { toolCallId: id as never });

describe("F7 RED: isToolProtocolValid/assertToolProtocol are not a complete wire-legality check", () => {
  it("invalid-01 orphan: a tool result with no preceding assistant is rejected", () => {
    const messages = [message("user", "u"), toolResult("call_orphan")];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("invalid-02 missing: assistant[a,b] followed by only a is rejected", () => {
    const messages = [assistantCalls(["call_a", "call_b"]), toolResult("call_a"), message("assistant", "next")];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("invalid-03 duplicate: the same call id answered twice is rejected", () => {
    const messages = [assistantCalls(["call_a"]), toolResult("call_a"), toolResult("call_a", "again")];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("invalid-04 extra: a result whose id was never requested is rejected", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      toolResult("call_b"),
      toolResult("call_c"),
    ];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("invalid-05 duplicate call id: one assistant asking the same id twice is rejected", () => {
    const messages = [assistantCalls(["call_a", "call_a"]), toolResult("call_a")];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("invalid-06 inserted system message splitting the block is rejected", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      message("system", "[stall recovery]"),
      toolResult("call_b"),
    ];
    expect(isToolProtocolValid(messages)).toBe(false);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("valid-01 complete two-result block is accepted", () => {
    const messages = [
      message("user", "go"),
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      toolResult("call_b"),
      message("assistant", "done"),
    ];
    expect(isToolProtocolValid(messages)).toBe(true);
    expect(() => assertToolProtocol(messages)).not.toThrow();
  });

  it("valid-02 explicit not-executed results on a cancel/stop path are accepted", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a", "cancelled: not executed"),
      toolResult("call_b", "cancelled: not executed"),
    ];
    expect(isToolProtocolValid(messages)).toBe(true);
    expect(() => assertToolProtocol(messages)).not.toThrow();
  });
});
