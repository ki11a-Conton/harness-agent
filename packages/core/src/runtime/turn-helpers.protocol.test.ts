import { describe, expect, it } from "vitest";
import type { Message } from "@ar/contracts";
import { newMessageId, newSessionId, newToolCallId, assertToolProtocol, findOrphanToolResults } from "@ar/contracts";
import { trimMessageHistory } from "./turn-helpers.js";

/**
 * P2-41/PROTOCOL: the Phase-8 message-history trim bounds what the MODEL sees
 * by dropping the oldest messages. Dropping a prefix can cut an assistant
 * message carrying `tool_calls` away while its `tool` results remain, and a
 * strict OpenAI-compatible upstream rejects an orphan tool result
 * ("messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'"). The trim must therefore never leave the VIEW protocol-broken.
 */

const sessionId = newSessionId();

function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId, role, content, createdAt: 0, ...extra };
}

describe("trimMessageHistory tool-protocol safety", () => {
  it("drops tool results whose assistant call was trimmed away", () => {
    const c1 = newToolCallId();
    // A big prefix forces the trim to cut between the assistant tool_calls and
    // the messages that follow it.
    const messages: Message[] = [
      message("assistant", "calling", { toolCalls: [{ id: c1, name: "echo", args: {} }] }),
      message("tool", "x".repeat(4000), { toolCallId: c1 }),
      message("assistant", "later"),
      message("user", "tail"),
    ];
    const trimmed = trimMessageHistory(messages, 1);
    expect(findOrphanToolResults(trimmed)).toEqual([]);
    // The assistant whose results were dropped must not remain either, or the
    // block would be unanswered.
    assertToolProtocol(trimmed);
  });

  it("keeps a whole block when the trim stops inside it", () => {
    const c1 = newToolCallId();
    const c2 = newToolCallId();
    const messages: Message[] = [
      message("user", "u"),
      message("assistant", "calling", {
        toolCalls: [
          { id: c1, name: "echo", args: {} },
          { id: c2, name: "echo", args: {} },
        ],
      }),
      message("tool", "a", { toolCallId: c1 }),
      message("tool", "b", { toolCallId: c2 }),
      message("assistant", "done"),
    ];
    const trimmed = trimMessageHistory(messages, 1);
    assertToolProtocol(trimmed);
  });
});
