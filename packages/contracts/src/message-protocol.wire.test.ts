import { describe, expect, it } from "vitest";
import type { Message } from "./message.js";
import { newMessageId, newSessionId } from "./ids.js";
import {
  assertSerializedWire,
  assertToolProtocol,
  assertWireProtocol,
  dropOrphanToolResults,
  findSerializedWireIssues,
  findWireProtocolIssues,
  isToolProtocolValid,
  isWireProtocolValid,
  renderWireIssues,
  type SerializedChatMessage,
  type WireProtocolIssueCode,
} from "./message-protocol.js";

/**
 * F7 / R6 — the complete valid/invalid TABLE for the unified wire-legality
 * check, plus the SERIALIZED-body view (what actually leaves the process).
 *
 * Every invalid row names the exact issue code(s) it must produce, so the
 * table is a replayable diagnostic contract, not just a boolean. The RED
 * reproducer that proves the pre-change coverage gap lives in
 * `message-protocol.wire-gap.test.ts`.
 */

const sessionId = newSessionId();

function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId, role, content, createdAt: 0, ...extra };
}

const assistantCalls = (ids: readonly string[], content = "calling"): Message =>
  message("assistant", content, {
    toolCalls: ids.map((id) => ({ id: id as never, name: "read_file", args: {} })),
  });

const namedCalls = (names: readonly string[], id = "call_a"): Message =>
  message("assistant", "calling", {
    toolCalls: names.map((name, at) => ({ id: (at === 0 ? id : `${id}_${at}`) as never, name, args: {} })),
  });

const toolResult = (id: string, content = "ok"): Message =>
  message("tool", content, { toolCallId: id as never });

const codes = (messages: readonly Message[]): WireProtocolIssueCode[] =>
  findWireProtocolIssues(messages).map((issue) => issue.code);

// ── the wire body exactly as the provider serializes it ─────────────────────
function wire(messages: readonly Message[]): SerializedChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id as string,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

describe("F7/R6 valid-invalid table (unified wire-legality)", () => {
  it("valid-01 complete two-result block", () => {
    const messages = [
      message("user", "go"),
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      toolResult("call_b"),
      message("assistant", "done"),
    ];
    expect(isWireProtocolValid(messages)).toBe(true);
    expect(isToolProtocolValid(messages)).toBe(true);
    expect(findWireProtocolIssues(messages)).toEqual([]);
    expect(() => assertWireProtocol(messages)).not.toThrow();
    expect(() => assertToolProtocol(messages)).not.toThrow();
    expect(findSerializedWireIssues(wire(messages))).toEqual([]);
  });

  it("valid-02 explicit not-executed results on a cancel path", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a", "cancelled by user: not executed"),
      toolResult("call_b", "turn stopped: not executed"),
    ];
    expect(findWireProtocolIssues(messages)).toEqual([]);
  });

  it("valid-03 two consecutive complete blocks", () => {
    const messages = [
      assistantCalls(["call_a"]),
      toolResult("call_a"),
      assistantCalls(["call_b"]),
      toolResult("call_b"),
    ];
    expect(findWireProtocolIssues(messages)).toEqual([]);
  });

  it("valid-04 assistant-without-tool-calls and a lone user/system transcript", () => {
    expect(findWireProtocolIssues([message("user", "hi"), message("assistant", "hello")])).toEqual([]);
    expect(findWireProtocolIssues([message("system", "sys"), message("user", "hi")])).toEqual([]);
  });

  it("invalid-01 orphan: a tool result with no preceding assistant", () => {
    const messages = [message("user", "u"), toolResult("call_orphan")];
    expect(codes(messages)).toEqual(["orphan_tool_result"]);
    expect(() => assertWireProtocol(messages)).toThrow(/orphan_tool_result/);
  });

  it("invalid-02 missing: assistant[a,b] followed by only a", () => {
    const messages = [assistantCalls(["call_a", "call_b"]), toolResult("call_a"), message("assistant", "next")];
    expect(codes(messages)).toEqual(["missing_tool_result", "interleaved_message"]);
    expect(findWireProtocolIssues(messages)[0]!.toolCallIds).toEqual(["call_b"]);
  });

  it("invalid-03 duplicate: the same call id answered twice", () => {
    const messages = [assistantCalls(["call_a"]), toolResult("call_a"), toolResult("call_a", "again")];
    expect(codes(messages)).toEqual(["duplicate_tool_result"]);
  });

  it("invalid-04 extra: a result whose id was never requested", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      toolResult("call_b"),
      toolResult("call_c"),
    ];
    expect(codes(messages)).toEqual(["unexpected_tool_result"]);
  });

  it("invalid-05 duplicate call id inside one assistant message", () => {
    const messages = [assistantCalls(["call_a", "call_a"]), toolResult("call_a")];
    expect(codes(messages)).toEqual(["duplicate_tool_call_id"]);
  });

  it("invalid-06 inserted system message splits the block", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      message("system", "[stall recovery]"),
      toolResult("call_b"),
    ];
    // The split both strands call_b (missing) and orphans the trailing result.
    expect(codes(messages)).toEqual([
      "missing_tool_result",
      "interleaved_message",
      "orphan_tool_result",
    ]);
    expect(findWireProtocolIssues(messages)[1]!.interruptedByRole).toBe("system");
  });

  it("invalid-07 tool message with no tool_call_id", () => {
    const messages = [assistantCalls(["call_a"]), message("tool", "ok")];
    // In-loop issue first (the malformed result), then the block closes with
    // call_a still unanswered.
    expect(codes(messages)).toEqual(["tool_result_without_id", "missing_tool_result"]);
  });

  it("invalid-08 trailing unanswered block (stall/cancel without results)", () => {
    const messages = [message("user", "go"), assistantCalls(["call_a"])];
    expect(codes(messages)).toEqual(["missing_tool_result"]);
  });

  it("invalid-09 illegal tool-call name echoed on the wire", () => {
    expect(codes([namedCalls(["mcp_data_source.read"])])).toEqual([
      "invalid_tool_call_name",
      "missing_tool_result",
    ]);
  });
});

describe("F7/R6 serialized-body validation (what actually leaves the process)", () => {
  it("catches an orphan whose `tool_call_id` is absent from the serialized body", () => {
    // The transcript has a tool message with NO toolCallId: `toOpenAiMessage`
    // emits `{role:"tool"}` with no correlation id. The serialized check must
    // see that on the BODY, not trust the in-memory object.
    const body: SerializedChatMessage[] = [
      { role: "user", content: "u" },
      { role: "tool", content: "result without id" },
    ];
    const issues = findSerializedWireIssues(body);
    expect(issues.map((i) => i.code)).toEqual(["orphan_tool_result"]);
    expect(() => assertSerializedWire(body)).toThrow(/orphan_tool_result/);
  });

  it("validates the serialized two-result block as valid", () => {
    const body: SerializedChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "a", tool_call_id: "call_a" },
      { role: "tool", content: "b", tool_call_id: "call_b" },
    ];
    expect(findSerializedWireIssues(body)).toEqual([]);
    expect(() => assertSerializedWire(body)).not.toThrow();
  });

  it("reports a duplicate call id in the serialized body", () => {
    const body: SerializedChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "a", tool_call_id: "call_a" },
    ];
    expect(findSerializedWireIssues(body).map((i) => i.code)).toContain("duplicate_tool_call_id");
  });
});

describe("F7/R6 tool-name boundaries on assistant tool_calls (P2-43 strengthening)", () => {
  const nameCodes = (name: string): WireProtocolIssueCode[] => codes([namedCalls([name])]);

  it("accepts a legal snake_case name", () => {
    expect(nameCodes("read_file")).not.toContain("invalid_tool_call_name");
  });

  it("accepts a legal dotted-free MCP name", () => {
    expect(nameCodes("mcp_data_source_read")).not.toContain("invalid_tool_call_name");
  });

  it("rejects a dotted name", () => {
    expect(nameCodes("mcp_data_source.read")).toContain("invalid_tool_call_name");
  });

  it("rejects an empty name", () => {
    expect(nameCodes("")).toContain("invalid_tool_call_name");
  });

  it("accepts the 64-character boundary and rejects 65", () => {
    expect(nameCodes("a".repeat(64))).not.toContain("invalid_tool_call_name");
    expect(nameCodes("a".repeat(65))).toContain("invalid_tool_call_name");
  });

  it("rejects Unicode and newline names", () => {
    expect(nameCodes("工具_read")).toContain("invalid_tool_call_name");
    expect(nameCodes("read\nfile")).toContain("invalid_tool_call_name");
  });
});

describe("F7/R6 safe prefix repair is prefix-only", () => {
  it("drops a LEADING run of orphan results (the prefix-trim artifact)", () => {
    const messages = [toolResult("call_gone"), toolResult("call_gone_b"), message("assistant", "later")];
    const repaired = dropOrphanToolResults(messages);
    expect(repaired.map((m) => m.role)).toEqual(["assistant"]);
    expect(messages).toHaveLength(3); // never mutates the input / durable list
  });

  it("does NOT silently drop a mid-view orphan — the split is unrepairable", () => {
    const messages = [
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a"),
      message("system", "[stall recovery]"),
      toolResult("call_b"),
    ];
    const repaired = dropOrphanToolResults(messages);
    expect(repaired).toHaveLength(4);
    // Still broken -> the send-boundary check must reject it locally.
    expect(findWireProtocolIssues(repaired).length).toBeGreaterThan(0);
  });

  it("leaves a valid view untouched", () => {
    const messages = [assistantCalls(["call_a"]), toolResult("call_a")];
    expect(dropOrphanToolResults(messages)).toEqual(messages);
  });
});

describe("F7/R6 replayable diagnostics", () => {
  it("renders a stable, content-free one-line-per-issue log", () => {
    const messages = [assistantCalls(["call_a", "call_b"]), toolResult("call_a"), toolResult("call_c")];
    const log = renderWireIssues(findWireProtocolIssues(messages));
    expect(log).toContain("[missing_tool_result] assistant[0] requested call_b");
    expect(log).toContain("[unexpected_tool_result] tool message at index 2 answers \"call_c\"");
    // The log never contains message CONTENT.
    expect(log).not.toContain("calling");
    expect(log).not.toContain("ok");
  });
});
