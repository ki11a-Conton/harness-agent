import { expect, it } from "vitest";
import type { AgentDefinition, AskId, AskUserReply, AskUserRequest, AskUserStore, SessionId, Turn } from "@ar/contracts";
import { eventSinkFromStore, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { DefaultSessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

class Asks implements AskUserStore {
  readonly requests = new Map<AskId, AskUserRequest>();
  async create(request: AskUserRequest) { this.requests.set(request.id, { ...request }); }
  async get(id: AskId) { return this.requests.get(id); }
  async listPending(sessionId: SessionId) { return [...this.requests.values()].filter(request => request.sessionId === sessionId && request.status === "pending"); }
  async markAnswered(id: AskId, reply: AskUserReply) { const request = this.requests.get(id)!; this.requests.set(id, { ...request, status: "answered", answerText: reply.text, answeredAt: reply.answeredAt }); }
  async markWithdrawn(id: AskId) { this.requests.set(id, { ...this.requests.get(id)!, status: "withdrawn" }); }
}
async function setup() {
  const agent: AgentDefinition = { id: newAgentId(), name: "parked-cancel", description: "test", mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const store = new MemorySessionStore(), events = new MemoryEventStore(), asks = new Asks();
  const runtime = new AgentRuntime({ store, events, askUserStore: asks, modelProvider: new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required" })]), agents: [agent], orchestrator: new FakeOrchestrator(), toolRegistry: defaultTestToolCatalog() });
  const session = await runtime.createSession({ agent, cwd: "." }), turn = await runtime.startTurn(session.id, "implement target");
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal); expect(outcome.status).toBe("waiting_for_user");
  const actor = new DefaultSessionActor({ persistent: session, runtime, store, askUserStore: asks, emit: eventSinkFromStore(events) });
  return { runtime, store, events, asks, actor, session, turn, outcome };
}

it("duplicate cancel, interrupt and close join one durable parked-turn cancellation", async () => {
  const s = await setup(), update = s.store.updateTurn.bind(s.store);
  let release!: () => void, entered!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  s.store.updateTurn = async (turn: Turn) => { if (turn.status === "cancelled") { writes += 1; entered(); await gate; } await update(turn); };
  const first = s.actor.cancelTurn(s.turn.id); await ready;
  const duplicate = s.actor.cancelTurn(s.turn.id), interrupt = s.actor.interrupt();
  let closed = false; const closing = s.actor.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
  expect((await s.store.getTurn(s.turn.id))!.status).toBe("waiting_for_user");
  release(); const [one, two] = await Promise.all([first, duplicate, interrupt, closing]);
  expect(one).toEqual(two); expect(writes).toBe(1); expect(closed).toBe(true);
  expect((await s.store.getTurn(s.turn.id))!.status).toBe("cancelled");
  expect(await s.asks.listPending(s.session.id)).toEqual([]);
  expect((await s.events.list(s.session.id)).filter(event => event.type === "turn.cancelled")).toHaveLength(1);
});

it("a failed cancellation write leaves the actual turn and question pending, releases admission and can be retried", async () => {
  const s = await setup(), update = s.store.updateTurn.bind(s.store); let fail = true;
  s.store.updateTurn = async turn => { if (turn.status === "cancelled" && fail) { fail = false; throw new Error("controlled cancellation disk failure"); } await update(turn); };
  try {
    await expect(s.actor.cancelTurn(s.turn.id)).rejects.toThrow("controlled cancellation disk failure");
    expect((await s.store.getTurn(s.turn.id))!.status).toBe("waiting_for_user"); expect(await s.asks.listPending(s.session.id)).toHaveLength(1);
    expect((await s.events.list(s.session.id)).some(event => event.type === "turn.cancelled")).toBe(false);
    expect((await s.actor.cancelTurn(s.turn.id)).disposition).toBe("cancel_requested");
    expect((await s.store.getTurn(s.turn.id))!.status).toBe("cancelled");
  } finally { await s.actor.close(); }
});

it("cannot cancel another session's parked turn or overwrite a terminal turn", async () => {
  const s = await setup();
  const other = await s.runtime.createSession({ agent: s.runtime.getAgent(s.session.agentId)!, cwd: "." });
  const actor = new DefaultSessionActor({ persistent: other, runtime: s.runtime, store: s.store, askUserStore: s.asks, emit: eventSinkFromStore(s.events) });
  try {
    expect((await actor.cancelTurn(s.turn.id)).disposition).toBe("not_running");
    expect((await s.store.getTurn(s.turn.id))!.status).toBe("waiting_for_user");
    await s.actor.cancelTurn(s.turn.id);
    expect((await s.actor.cancelTurn(s.turn.id)).disposition).toBe("not_running");
    expect((await s.events.list(s.session.id)).filter(event => event.type === "turn.cancelled")).toHaveLength(1);
    const reloaded = new DefaultSessionActor({ persistent: s.session, runtime: s.runtime, store: s.store });
    try { await expect(reloaded.runTurn(s.turn.id)).rejects.toThrow(/terminal/); }
    finally { await reloaded.close(); }
  } finally { await Promise.all([actor.close(), s.actor.close()]); }
});

it("cannot run an unanswered question again to bypass the pause", async () => {
  const s = await setup();
  try {
    await expect(s.actor.runTurn(s.turn.id)).rejects.toThrow(/still waiting/);
    expect((await s.store.getTurn(s.turn.id))!.status).toBe("waiting_for_user");
    expect(await s.asks.listPending(s.session.id)).toHaveLength(1);
  } finally { await s.actor.close(); }
});
