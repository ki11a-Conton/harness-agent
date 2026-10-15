import { setImmediate as immediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { newAgentId, type AdmittedPrompt, type AgentDefinition, type InboxStore } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { DefaultSessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

it.each(["scan", "dequeue", "start", "bind"] as const)("close retains its resources until the in-flight followup %s finishes", async phase => {
  const entered = gate(), release = gate();
  const store = new MemorySessionStore(), provider = new ScriptedModelProvider([ScriptedModelProvider.text("must not execute")]);
  let resourcesReleased = false, lateWrites = 0;
  const create = store.createTurn.bind(store), update = store.updateTurn.bind(store);
  store.createTurn = async turn => { if (resourcesReleased) lateWrites++; await create(turn); };
  store.updateTurn = async turn => { if (resourcesReleased) lateWrites++; await update(turn); };
  const prompts: AdmittedPrompt[] = [];
  const inbox: InboxStore = {
    async admit(prompt) { prompts.push(prompt); },
    async listPending(id) { return prompts.filter(p => p.sessionId === id && p.status === "pending"); },
    async listAll(id) { return prompts.filter(p => p.sessionId === id); },
    async listRecoverable(id) {
      if (phase === "scan") { entered.open(); await release.promise; }
      return prompts.filter(p => p.sessionId === id && ["pending", "promoted"].includes(p.status));
    },
    async markPromoted(id) { prompts.find(p => p.id === id)!.status = "promoted"; },
    async bindPromotion(id, turnId) { const prompt = prompts.find(p => p.id === id)!; prompt.status = "promoted"; prompt.promotedTurnId = turnId; },
    async markConsumed(id) { prompts.find(p => p.id === id)!.status = "consumed"; },
  };
  const agent: AgentDefinition = { id: newAgentId(), name: "close-drain", description: "real followup promotion with controlled IO boundaries",
    mode: "primary", model: { providerId: provider.id, modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, inbox, events: new MemoryEventStore(), agents: [agent], modelProvider: provider,
    toolRegistry: defaultTestToolCatalog(), orchestrator: new FakeOrchestrator(), permissiveToolResolution: true });
  const session = await runtime.createSession({ agent, cwd: "/work" });
  const actor = new DefaultSessionActor({ persistent: session, store, inbox, onClosed: () => { resourcesReleased = true; }, runtime: {
    async startTurn(id, text) {
      if (phase === "start") { entered.open(); await release.promise; }
      return runtime.startTurn(id, text);
    }, runTurn: (...args) => runtime.runTurn(...args),
  } });
  const reserve = actor.inputQueue.reservePendingFollowup.bind(actor.inputQueue);
  actor.inputQueue.reservePendingFollowup = async () => {
    const result = await reserve();
    if (phase === "dequeue") { entered.open(); await release.promise; }
    return result;
  };
  const bind = actor.inputQueue.bindReservedFollowup.bind(actor.inputQueue);
  actor.inputQueue.bindReservedFollowup = async (...args) => {
    await bind(...args);
    if (phase === "bind") { entered.open(); await release.promise; }
  };
  let closing: Promise<void> | undefined;
  try {
    await actor.enqueueFollowup({ sessionId: session.id, text: "queued reminder" });
    await entered.promise;
    let settled = false;
    closing = actor.close().then(() => { settled = true; });
    // With only memory stores, one event-loop turn drains every unblocked
    // close continuation. The held operation cannot finish before release.
    await immediate();
    expect(settled, "close returned while owned promotion IO was still blocked").toBe(false);
    expect(resourcesReleased).toBe(false);
    release.open(); await closing;
    expect(resourcesReleased).toBe(true);
    expect(lateWrites).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(actor.status().loaded).toBe(false);
    if (phase === "scan" || phase === "dequeue") expect(await store.listTurns(session.id)).toHaveLength(0);
  } finally { release.open(); await (closing ?? actor.close()); await immediate(); }
}, 5_000);
