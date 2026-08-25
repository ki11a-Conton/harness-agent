// P26-7 — projections are REBUILDABLE views over the canonical journal.
// Delete a projection, rebuild it, and the visible state must be identical.

import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionId } from "@ar/contracts";
import { newAgentId, newEventId, newMessageId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import {
  rebuildSessionProjection,
  rebuildToolLedgerProjection,
  rebuildTraceProjection,
  rebuildTranscriptProjection,
  rebuildTurnProjection,
} from "./projections.js";

const AGENT_ID = newAgentId();

async function seed(deps: { store: MemorySessionStore; events: MemoryEventStore }): Promise<{
  sessionId: SessionId;
  turnId: string;
  toolCallId: string;
}> {
  const sessionId = newSessionId();
  const turnId = newTurnId();
  const toolCallId = newToolCallId();
  await deps.store.createSession({
    id: sessionId,
    agentId: AGENT_ID,
    model: { providerId: "p", modelId: "m" },
    cwd: "/work",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  await deps.store.createTurn({ id: turnId, sessionId, input: { sessionId, text: "hi" }, status: "completed", startedAt: 1, completedAt: 2 });
  await deps.store.appendMessage({ id: newMessageId(), sessionId, turnId, role: "user", content: "hi", createdAt: 1 });
  await deps.store.appendMessage({ id: newMessageId(), sessionId, turnId, role: "assistant", content: "ok", createdAt: 2 });

  const ev = (type: AgentEvent["type"], over: Partial<AgentEvent> = {}): AgentEvent => ({
    id: newEventId(),
    sessionId,
    turnId,
    sequence: 0,
    timestamp: 1,
    type,
    payload: {},
    ...over,
  });
  await deps.events.appendNew(ev("turn.started"));
  await deps.events.appendNew(
    ev("tool.intent_persisted", {
      payload: { toolCallId, tool: "write_file", argsHash: "a1", sideEffectScope: "filesystem" },
      spanId: "span_tool_1",
      parentSpanId: "span_model_1",
    }),
  );
  await deps.events.appendNew(
    ev("tool.completed", { payload: { toolCallId }, spanId: "span_tool_1", parentSpanId: "span_model_1" }),
  );
  await deps.events.appendNew(ev("model.delta", { payload: { text: "x" }, spanId: "span_model_1" }));
  await deps.events.appendNew(ev("turn.completed"));
  return { sessionId, turnId, toolCallId };
}

describe("P26-7: projections are rebuildable views of the journal", () => {
  it("rebuildSessionProjection reads durable docs + journal envelope", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId } = await seed({ store, events });

    const proj = await rebuildSessionProjection({ store, events }, sessionId);
    expect(proj.session.id).toBe(sessionId);
    expect(proj.turns).toHaveLength(1);
    expect(proj.messageCount).toBe(2);
    expect(proj.lastSequence).toBe(5); // MemoryEventStore seq starts at 1
  });

  it("rebuildTurnProjection enumerates the turn's tool calls from journal events", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId, turnId, toolCallId } = await seed({ store, events });

    const proj = await rebuildTurnProjection({ store, events }, sessionId, turnId as never);
    expect(proj.status).toBe("completed");
    expect(proj.messageCount).toBe(2);
    expect(proj.toolCallIds).toEqual([toolCallId]);
  });

  it("rebuildTranscriptProjection keeps only semantic journal events", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId } = await seed({ store, events });

    const proj = await rebuildTranscriptProjection({ store, events }, sessionId);
    expect(proj.messages).toHaveLength(2);
    const types = proj.semanticEvents.map((e) => e.type);
    // model.delta is an observability delta → dropped from the journal view.
    expect(types).toContain("turn.started");
    expect(types).toContain("tool.intent_persisted");
    expect(types).toContain("tool.completed");
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("model.delta");
  });

  it("rebuildToolLedgerProjection rebuilds intent→outcome entries (crash window → interrupted)", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId, toolCallId } = await seed({ store, events });
    // A second tool that crashed mid-flight (intent only, no outcome).
    await events.appendNew({
      id: newEventId(),
      sessionId,
      timestamp: 9,
      type: "tool.intent_persisted",
      payload: { toolCallId: newToolCallId(), tool: "exec", argsHash: "a2", sideEffectScope: "process" },
    });

    const proj = await rebuildToolLedgerProjection({ store, events }, sessionId);
    expect(proj.entries).toHaveLength(2);
    const done = proj.entries.find((e) => e.toolCallId === toolCallId)!;
    expect(done.status).toBe("success");
    expect(done.sideEffect).toBe(true);
    const interrupted = proj.entries.find((e) => e.tool === "exec")!;
    expect(interrupted.status).toBe("interrupted");
  });

  it("rebuildTraceProjection builds the span tree and roots", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId } = await seed({ store, events });

    const proj = await rebuildTraceProjection({ store, events }, sessionId);
    expect(proj.rootSpans).toEqual(["span_model_1"]);
    expect(proj.spanTree.get("span_model_1")).toEqual(["span_tool_1"]);
  });

  it("rebuild is idempotent: rebuilding from the same journal yields the same visible state", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const { sessionId } = await seed({ store, events });

    const a = await rebuildToolLedgerProjection({ store, events }, sessionId);
    const b = await rebuildToolLedgerProjection({ store, events }, sessionId);
    expect(b).toEqual(a);
    const t1 = await rebuildTranscriptProjection({ store, events }, sessionId);
    const t2 = await rebuildTranscriptProjection({ store, events }, sessionId);
    expect(t2).toEqual(t1);
  });
});
