import { expect, it } from "vitest";
import { newEventId, newSessionId, newTurnId, type AgentEvent } from "@ar/contracts";
import { ProtocolEventMapper } from "./mapper.js";

const mapper = new ProtocolEventMapper();
function failure(payload: Record<string, unknown>): AgentEvent {
  return { id: newEventId(), sessionId: newSessionId(), turnId: newTurnId(), type: "model.failed", sequence: 5,
    timestamp: 1000, payload };
}

it("projects a committed failed partial once as explicitly incomplete non-final text without usage", () => {
  const event = failure({ callId: "call", messageId: "message", text: "unchanged partial 中文🙂",
    incomplete: { reason: "model_error", callId: "call" }, error: { code: "MODEL_ERROR" } });
  const projected = mapper.map(event, "thread");
  expect(projected).toMatchObject({ type: "item/completed", item: { kind: "agent_message",
    text: event.payload.text, final: false, incomplete: true } });
  expect(projected).toEqual(mapper.map(event, "thread"));
  expect(JSON.stringify(projected)).not.toContain("usage");
});

it("keeps old failure journals and private compaction failures out of assistant items", () => {
  expect(mapper.map(failure({ error: { code: "MODEL_ERROR" }, text: "old event text" }), "thread")).toBeNull();
  expect(mapper.map(failure({ purpose: "compaction", messageId: "summary", text: "PRIVATE_SUMMARY",
    incomplete: { reason: "model_error", callId: "summary" } }), "thread")).toBeNull();
});
