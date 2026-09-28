import { describe, expect, it } from "vitest";
import type { Message } from "./message.js";
import { newMessageId, newSessionId, newToolCallId } from "./ids.js";
import {
  assertToolProtocol,
  dropOrphanToolResults,
  findOrphanToolResults,
  findToolProtocolViolations,
  isToolProtocolValid,
} from "./message-protocol.js";

/**
 * P2-41/PROTOCOL: the wire protocol requires an assistant message carrying
 * `tool_calls` to be followed IMMEDIATELY by one `tool` message per
 * `tool_call_id`. These tests pin the pure invariant used by the runtime tests
 * and by the transcript repair applied to the model-visible view.
 */

const sessionId = newSessionId();

function message(
  role: Message["role"],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id: newMessageId(),
    sessionId,
    role,
    content,
    createdAt: 0,
    ...extra,
  };
}

function assistantWithCalls(ids: string[], content = "calling"): Message {
  return message("assistant", content, {
    toolCalls: ids.map((id) => ({ id: id as never, name: "echo", args: {} })),
  });
}

function toolResult(id: string, content = "ok"): Message {
  return message("tool", content, { toolCallId: id as never });
}

describe("message-protocol invariant", () => {
  it("accepts a transcript whose tool blocks are immediately answered", () => {
    const c1 = newToolCallId();
    const c2 = newToolCallId();
    const messages = [
      message("user", "do it"),
      assistantWithCalls([c1, c2]),
      toolResult(c1),
      toolResult(c2),
      message("assistant", "done"),
    ];
    expect(isToolProtocolValid(messages)).toBe(true);
    expect(findToolProtocolViolations(messages)).toHaveLength(0);
    expect(() => assertToolProtocol(messages)).not.toThrow();
  });

  it("detects the reported defect: a system observation splitting the block", () => {
    // This is the exact shape captured from the failing workbuddy request:
    //   assistant(tool_calls=[c1,c2]), tool(c1), system(stall), tool(c2)
    const c1 = newToolCallId();
    const c2 = newToolCallId();
    const messages = [
      message("user", "do it"),
      assistantWithCalls([c1, c2]),
      toolResult(c1),
      message("system", '[stall recovery — detected "repeated_error"]'),
      toolResult(c2),
    ];
    const violations = findToolProtocolViolations(messages);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.missingToolCallIds).toEqual([c2]);
    expect(violations[0]!.interruptedByRole).toBe("system");
    expect(() => assertToolProtocol(messages)).toThrow(/tool_call_id/);
  });

  it("detects a completely missing tool result", () => {
    const c1 = newToolCallId();
    const c2 = newToolCallId();
    const messages = [
      assistantWithCalls([c1, c2]),
      toolResult(c1),
      message("assistant", "next"),
    ];
    const violations = findToolProtocolViolations(messages);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.missingToolCallIds).toEqual([c2]);
  });

  it("treats a trailing unanswered tool_calls block as a violation", () => {
    const c1 = newToolCallId();
    const messages = [message("user", "go"), assistantWithCalls([c1])];
    expect(findToolProtocolViolations(messages)).toHaveLength(1);
    expect(() => assertToolProtocol(messages)).toThrow();
  });

  it("ignores assistant messages without tool calls", () => {
    const messages = [message("user", "hi"), message("assistant", "hello")];
    expect(isToolProtocolValid(messages)).toBe(true);
  });
});

describe("orphan tool results (prefix trim / slice safety)", () => {
  it("finds a tool result whose assistant call was trimmed away", () => {
    const c1 = newToolCallId();
    const messages = [toolResult(c1), message("assistant", "done")];
    expect(findOrphanToolResults(messages)).toEqual([0]);
    expect(dropOrphanToolResults(messages)).toHaveLength(1);
    expect(dropOrphanToolResults(messages)[0]!.role).toBe("assistant");
  });

  it("finds an orphan created by an interleaved non-tool message", () => {
    const c1 = newToolCallId();
    const messages = [
      assistantWithCalls([c1]),
      message("system", "observation"),
      toolResult(c1),
    ];
    expect(findOrphanToolResults(messages)).toEqual([2]);
  });

  it("leaves a valid transcript untouched", () => {
    const c1 = newToolCallId();
    const messages = [assistantWithCalls([c1]), toolResult(c1)];
    expect(findOrphanToolResults(messages)).toEqual([]);
    expect(dropOrphanToolResults(messages)).toEqual(messages);
  });

  it("does not mutate the input list", () => {
    const c1 = newToolCallId();
    const messages = [toolResult(c1)];
    dropOrphanToolResults(messages);
    expect(messages).toHaveLength(1);
  });
});
