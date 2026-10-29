import { expect, it, vi } from "vitest";
import { newAgentId, type AgentDefinition, type SessionId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, type AgentRuntimeDeps } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const BASE: AgentDefinition = { id: newAgentId(), name: "observer-policy", description: "offline policy regression", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "frozen policy",
  tools: { allow: ["read_file", "write_file", "exec"] }, permissions: { defaultEffect: "allow", rules: [] }, skills: {}, limits: {} };
const RESTRICTED: AgentDefinition = { ...BASE, tools: { allow: ["read_file"] }, permissions: { defaultEffect: "deny", rules: [
  { effect: "allow", action: "read", resource: "file", scope: "session" },
] } };
function make(store = new MemorySessionStore(), events = new MemoryEventStore(), extra: Partial<AgentRuntimeDeps> = {}) {
  const model = new ScriptedModelProvider([ScriptedModelProvider.text("done")]), orchestrator = new FakeOrchestrator();
  const engine = new AgentRuntime({ store, events, modelProvider: model, orchestrator, agents: [BASE], ...extra });
  return { store, events, model, orchestrator, engine };
}

it("a synchronous terminal observer can read the same frozen policy without reentering terminal recovery", async () => {
  const h = make(), session = await h.engine.createSession({ agent: RESTRICTED, cwd: "/policy-observer" });
  const turn = await h.engine.startTurn(session.id, "finish");
  const append = h.events.appendNew.bind(h.events);
  let inspected = 0;
  h.events.appendNew = async event => {
    const committed = await append(event);
    if (event.type === "turn.completed") {
      const policy = await h.engine.getSessionAgentPolicy(session.id);
      expect(policy.tools).toEqual(RESTRICTED.tools); expect(policy.permissions).toEqual(RESTRICTED.permissions);
      inspected++;
    }
    return committed;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([h.engine.runTurn(session.id, turn.id, new AbortController().signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("terminal observer policy lookup deadlocked")), 1000); })]);
    expect(result.status).toBe("completed"); expect(inspected).toBe(1);
    expect(h.model.calls).toHaveLength(1); expect(h.orchestrator.calls).toHaveLength(0);
    expect(h.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  } finally { clearTimeout(timer); }
});

it("policy lookup does not publish a pending terminal outcome, while ordinary metadata still repairs and fences it", async () => {
  const flush = vi.fn(async () => {}), h = make(undefined, undefined, { durabilityFence: { durabilityLevel: "memory", flushThrough: flush } });
  const session = await h.engine.createSession({ agent: RESTRICTED, cwd: "/pending-terminal-policy" });
  const turn = await h.engine.startTurn(session.id, "finish");
  const append = h.events.appendNew.bind(h.events);
  h.events.appendNew = async event => { if (event.type === "turn.completed") throw new Error("terminal publication interrupted"); return append(event); };
  await expect(h.engine.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toThrow("terminal publication interrupted");
  h.events.appendNew = append;
  const fresh = make(h.store, h.events, { durabilityFence: { durabilityLevel: "memory", flushThrough: flush } });
  const list = vi.spyOn(h.store, "listTurns"), journal = vi.spyOn(h.events, "list");
  expect((await fresh.engine.getSessionAgentPolicy(session.id)).tools).toEqual(RESTRICTED.tools);
  expect(list).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  expect(h.events.events.filter(event => event.type === "turn.completed")).toHaveLength(0);
  await fresh.engine.getSessionAgent(session.id);
  expect(h.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1); expect(flush).toHaveBeenCalledTimes(1);
  expect(h.model.calls).toHaveLength(1); expect(fresh.model.calls).toHaveLength(0); expect(fresh.orchestrator.calls).toHaveLength(0);
});

it("policy lookup retains frozen parent and child permissions across a wider registry restart", async () => {
  const h = make(), parent = await h.engine.createSession({ agent: RESTRICTED, cwd: "/parent" });
  const child = await h.engine.createSession({ parentId: parent.id, agent: RESTRICTED, cwd: "/parent/child" });
  const fresh = make(h.store, h.events);
  for (const id of [parent.id, child.id]) {
    const policy = await fresh.engine.getSessionAgentPolicy(id);
    expect(policy.tools).toEqual(RESTRICTED.tools); expect(policy.permissions).toEqual(RESTRICTED.permissions);
    expect(policy.systemPrompt).toBe(RESTRICTED.systemPrompt);
  }
  expect(fresh.model.calls).toHaveLength(0); expect(fresh.orchestrator.calls).toHaveLength(0);
});

it("policy lookup refuses an unknown session without starting a model or tool", async () => {
  const h = make();
  await expect(h.engine.getSessionAgentPolicy("session_missing" as SessionId)).rejects.toThrow(/unknown session/);
  expect(h.model.calls).toHaveLength(0); expect(h.orchestrator.calls).toHaveLength(0); expect(h.events.events).toHaveLength(0);
});

it.each(["corrupt", "foreign"] as const)("policy lookup fails closed for a %s effective-agent snapshot", async kind => {
  const h = make(), session = await h.engine.createSession({ agent: RESTRICTED, cwd: "/bad-policy" });
  const snapshot = (await h.store.loadStateSnapshot(session.id))!;
  if (kind === "corrupt") snapshot.effectiveAgent = { tools: BASE.tools };
  else (snapshot.effectiveAgent as { agentId: string }).agentId = newAgentId();
  await h.store.saveStateSnapshot(session.id, snapshot);
  await expect(h.engine.getSessionAgentPolicy(session.id)).rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
  expect(h.model.calls).toHaveLength(0); expect(h.orchestrator.calls).toHaveLength(0);
});

it.each(["before", "after"] as const)("policy lookup retains model-selection recovery after an append failure %s commit", async stage => {
  const h = make(), session = await h.engine.createSession({ agent: RESTRICTED, cwd: "/selection-policy" });
  const append = h.events.appendNew.bind(h.events);
  h.events.appendNew = async event => { if (stage === "after") await append(event); throw new Error("selection publication interrupted"); };
  const selected = { providerId: "next-provider", modelId: "next-model" };
  await expect(h.engine.setSessionModel(session.id, selected)).rejects.toThrow("selection publication interrupted");
  h.events.appendNew = append;
  const fresh = make(h.store, h.events), policy = await fresh.engine.getSessionAgentPolicy(session.id);
  expect(policy.model).toEqual(selected); expect(policy.tools).toEqual(RESTRICTED.tools); expect(policy.permissions).toEqual(RESTRICTED.permissions);
  expect(h.events.events.filter(event => event.payload.kind === "web_model_selection")).toHaveLength(1);
  expect(fresh.model.calls).toHaveLength(0); expect(fresh.orchestrator.calls).toHaveLength(0);
});

it("policy lookup keeps existing host-policy drift observation without widening the frozen agent", async () => {
  const h = make(undefined, undefined, { recovery: new RecoveryPolicy({ maxAttempts: 2 }) });
  const session = await h.engine.createSession({ agent: RESTRICTED, cwd: "/policy-drift" });
  const fresh = make(h.store, h.events, { recovery: new RecoveryPolicy({ maxAttempts: 4 }) });
  const policy = await fresh.engine.getSessionAgentPolicy(session.id);
  expect(policy.permissions).toEqual(RESTRICTED.permissions); expect(policy.tools).toEqual(RESTRICTED.tools);
  expect(h.events.events.filter(event => event.type === "policy.changed_on_resume")).toHaveLength(1);
  expect(fresh.model.calls).toHaveLength(0); expect(fresh.orchestrator.calls).toHaveLength(0);
});
