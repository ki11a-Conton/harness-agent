import { describe, expect, it } from "vitest";
import type { AgentDefinition, AskId, AskUserReply, AskUserRequest, AskUserStore, Message, SessionId } from "@ar/contracts";
import { newAgentId, newAskId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const agent: AgentDefinition = {
  id: newAgentId(), name: "ask-identity-regression", description: "test", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: {},
};
class AskStore implements AskUserStore {
  readonly requests = new Map<AskId, AskUserRequest>();
  async create(request: AskUserRequest) { this.requests.set(request.id, { ...request }); }
  async get(id: AskId) { const request = this.requests.get(id); return request === undefined ? undefined : { ...request }; }
  async listPending(sessionId: SessionId) { return [...this.requests.values()].filter(request => request.sessionId === sessionId && request.status === "pending"); }
  async markAnswered(id: AskId, reply: AskUserReply) {
    const request = this.requests.get(id);
    if (request === undefined || request.status !== "pending") throw new Error("ask not pending");
    this.requests.set(id, { ...request, status: "answered", answerText: reply.text, answeredAt: reply.answeredAt });
  }
  async markWithdrawn(id: AskId) {
    const request = this.requests.get(id);
    if (request !== undefined) this.requests.set(id, { ...request, status: "withdrawn" });
  }
}
class CrashStore extends MemorySessionStore {
  failNextReply: "before" | "after" | undefined;
  override async appendMessage(message: Message) {
    const crash = message.askId === undefined ? undefined : this.failNextReply;
    if (crash !== undefined) this.failNextReply = undefined;
    if (crash === "before") throw new Error("controlled crash before reply append");
    await super.appendMessage(message);
    if (crash === "after") throw new Error("controlled crash after reply append");
  }
}
function setup(durable: boolean, store = new CrashStore()) {
  const asks = durable ? new AskStore() : undefined;
  const events = new MemoryEventStore();
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required", options: ["a", "b"] }),
  ]);
  const makeRuntime = () => new AgentRuntime({ store, events, modelProvider: provider,
    orchestrator: new FakeOrchestrator(), agents: [agent], toolRegistry: defaultTestToolCatalog(),
    ...(asks === undefined ? {} : { askUserStore: asks }), maxIterationsPerTurn: 1,
  });
  return { store, asks, events, makeRuntime, runtime: makeRuntime() };
}
async function park(input: ReturnType<typeof setup>) {
  const session = await input.runtime.createSession({ agent, cwd: "." });
  const turn = await input.runtime.startTurn(session.id, "Choose a target");
  const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("waiting_for_user");
  expect(outcome.pendingAsk).toBeDefined();
  return { session, turn, askId: outcome.pendingAsk!.id };
}
async function replies(input: ReturnType<typeof setup>, sessionId: SessionId) {
  return (await input.store.listMessages(sessionId)).filter(message => message.askId !== undefined);
}

describe("ask answer identity and durable retry boundary", () => {
  it("refuses a real ask from another session without answering or injecting it", async () => {
    const input = setup(true); const a = await park(input);
    const b = await input.runtime.createSession({ agent, cwd: "." });
    const bTurn = await input.runtime.startTurn(b.id, "Unrelated task");
    const result = await input.runtime.submitUserAnswer(b.id, bTurn.id, a.askId, "foreign answer");
    expect({ resumed: result.resumed, originalAskStatus: (await input.asks!.get(a.askId))!.status,
      originalSessionReplies: (await replies(input, a.session.id)).length, foreignSessionReplies: (await replies(input, b.id)).length,
      foreignSessionReplyEvent: (await input.events.list(b.id)).some(event => event.type === "ask.user_replied") })
      .toEqual({ resumed: false, originalAskStatus: "pending", originalSessionReplies: 0,
        foreignSessionReplies: 0, foreignSessionReplyEvent: false });
  });
  it("refuses a real ask on a different turn of the same session", async () => {
    const input = setup(true); const a = await park(input);
    const other = await input.runtime.startTurn(a.session.id, "Different task");
    expect((await input.runtime.submitUserAnswer(a.session.id, other.id, a.askId, "wrong turn")).resumed).toBe(false);
    expect((await input.asks!.get(a.askId))!.status).toBe("pending");
    expect(await replies(input, a.session.id)).toHaveLength(0);
  });
  it.each([true, false])("refuses an unknown ask (durable store=%s)", async durable => {
    const input = setup(durable); const a = await park(input);
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, newAskId(), "invented")).resumed).toBe(false);
    expect(await replies(input, a.session.id)).toHaveLength(0);
  });
  it("does not substitute event proof for a missing configured durable ask record", async () => {
    const input = setup(true); const a = await park(input); input.asks!.requests.delete(a.askId);
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "lost record")).resumed).toBe(false);
    expect(await replies(input, a.session.id)).toHaveLength(0);
  });
  it("supports a real no-store ask across Runtime reconstruction through durable ask events", async () => {
    const input = setup(false); const a = await park(input); const restored = input.makeRuntime();
    expect((await restored.submitUserAnswer(a.session.id, a.turn.id, a.askId, "target a")).resumed).toBe(true);
    expect((await restored.submitUserAnswer(a.session.id, a.turn.id, a.askId, "different retry text")).resumed).toBe(true);
    expect(await replies(input, a.session.id)).toHaveLength(1);
  });
  it("retains exactly-once success for genuine retries after the turn completed", async () => {
    const input = setup(true); const a = await park(input);
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "target a")).resumed).toBe(true);
    const turn = (await input.store.getTurn(a.turn.id))!; await input.store.updateTurn({ ...turn, status: "completed" });
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "different retry text")).resumed).toBe(true);
    expect(await replies(input, a.session.id)).toHaveLength(1);
  });
  it("does not treat history from another turn as an idempotent success", async () => {
    const input = setup(true); const a = await park(input);
    await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "target a");
    const other = await input.runtime.startTurn(a.session.id, "Different task");
    expect((await input.runtime.submitUserAnswer(a.session.id, other.id, a.askId, "wrong retry turn")).resumed).toBe(false);
    expect(await replies(input, a.session.id)).toHaveLength(1);
  });
  it("recovers the durable answer after markAnswered succeeded but append failed, preserving original text", async () => {
    const input = setup(true); const a = await park(input); input.store.failNextReply = "before";
    await expect(input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "persisted answer")).rejects.toThrow("controlled crash");
    expect((await input.asks!.get(a.askId))!.answerText).toBe("persisted answer");
    expect((await input.makeRuntime().submitUserAnswer(a.session.id, a.turn.id, a.askId, "changed retry answer")).resumed).toBe(true);
    const messages = await replies(input, a.session.id); expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("[user reply to your question]\npersisted answer");
    const replyEvents = (await input.events.list(a.session.id)).filter(event => event.type === "ask.user_replied");
    expect(replyEvents).toHaveLength(1); expect(replyEvents[0]!.payload.text).toBe("persisted answer");
  });
  it("keeps append-committed crash retries exactly once", async () => {
    const input = setup(true); const a = await park(input); input.store.failNextReply = "after";
    await expect(input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "committed answer")).rejects.toThrow("controlled crash");
    expect((await input.makeRuntime().submitUserAnswer(a.session.id, a.turn.id, a.askId, "retry")).resumed).toBe(true);
    expect(await replies(input, a.session.id)).toHaveLength(1);
  });
  it("refuses withdrawn asks", async () => {
    const input = setup(true); const a = await park(input); await input.asks!.markWithdrawn(a.askId);
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "too late")).resumed).toBe(false);
    expect(await replies(input, a.session.id)).toHaveLength(0);
  });
  it("refuses new answer injection once the waiting turn ended", async () => {
    const input = setup(true); const a = await park(input);
    const turn = (await input.store.getTurn(a.turn.id))!; await input.store.updateTurn({ ...turn, status: "cancelled" });
    expect((await input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "too late")).resumed).toBe(false);
    expect((await input.asks!.get(a.askId))!.status).toBe("pending");
    expect(await replies(input, a.session.id)).toHaveLength(0);
  });
  it.each([true, false])("serializes simultaneous same-ask submissions (durable store=%s)", async durable => {
    const input = setup(durable); const a = await park(input);
    const results = await Promise.all([
      input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "first answer"),
      input.runtime.submitUserAnswer(a.session.id, a.turn.id, a.askId, "second answer"),
    ]);
    expect(results.every(result => result.resumed)).toBe(true);
    const messages = await replies(input, a.session.id); expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("first answer");
  });
});
