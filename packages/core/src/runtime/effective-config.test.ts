import { defaultTestToolCatalog } from "../test/fakes.js";
import { describe, expect, it } from "vitest";
import type { AgentDefinition, SessionId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

// ---- P0-1: Session Effective Agent Config Snapshot -------------------------
// runTurn must honor the frozen per-session effective config (persisted at
// createSession) instead of re-reading the registry, and there must be NO
// path that silently falls back to a wider base agent when a snapshot exists.

const BASE: AgentDefinition = {
  id: newAgentId(),
  name: "base",
  description: "base test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "base prompt",
  tools: { allow: ["read_file", "write_file", "exec"] },
  permissions: { rules: [], defaultEffect: "allow" },
  skills: {},
  limits: {},
};

const READ_ONLY: AgentDefinition = {
  ...BASE,
  tools: { allow: ["read_file"] },
  systemPrompt: "read-only prompt",
};

function makeRuntime(store: MemorySessionStore, agents: AgentDefinition[], events = new MemoryEventStore()) {
  const orchestrator = new FakeOrchestrator({ status: "success", output: "fake-ok" });
  const runtime = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("ok")]),
    orchestrator,
    agents,
    now: () => 1000,
  });
  return { events, orchestrator, runtime };
}

describe("P0-1 effective agent config snapshot", () => {
  it("createSession persists the effective config; runTurn enforces it (write denied)", async () => {
    const store = new MemorySessionStore();
    const { runtime, orchestrator } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "C:\\work" });

    const snapshot = await store.loadStateSnapshot(session.id);
    expect(snapshot?.effectiveAgent).toMatchObject({
      agentId: BASE.id,
      tools: { allow: ["read_file"] },
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "C:\\work\\x.txt", content: "x" }),
      ScriptedModelProvider.text("done"),
    ]);
    const runtime2 = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events: new MemoryEventStore(),
      modelProvider: provider,
      orchestrator,
      agents: [BASE],
      now: () => 1000,
    });
    const turn = await runtime2.startTurn(session.id, "try write");
    const outcome = await runtime2.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(orchestrator.calls).toHaveLength(0);
    const texts = (await store.listMessages(session.id)).filter((m) => m.role === "tool").map((m) => m.content);
    expect(texts.some((t) => t.includes("write_file") && t.includes("denied"))).toBe(true);
  });

  it("resume on a fresh runtime still enforces the snapshot (persisted restriction)", async () => {
    const store = new MemorySessionStore();
    const { runtime, orchestrator } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "C:\\work" });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("exec", { command: "evil" }),
      ScriptedModelProvider.text("done"),
    ]);
    const fresh = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events: new MemoryEventStore(),
      modelProvider: provider,
      orchestrator,
      agents: [BASE],
      now: () => 1000,
    });
    const turn = await fresh.startTurn(session.id, "resume");
    const outcome = await fresh.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(orchestrator.calls).toHaveLength(0);
  });

  it("a later registry widening cannot change a running session's policy", async () => {
    const store = new MemorySessionStore();
    const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "C:\\work" });

    const widened = { ...BASE, tools: { allow: ["read_file", "write_file", "exec"] } };
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "C:\\work\\x.txt", content: "x" }),
      ScriptedModelProvider.text("done"),
    ]);
    const runtime2 = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events: new MemoryEventStore(),
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "fake-ok" }),
      agents: [widened],
      now: () => 1000,
    });
    const turn = await runtime2.startTurn(session.id, "try widen");
    const outcome = await runtime2.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    const texts = (await store.listMessages(session.id)).filter((m) => m.role === "tool").map((m) => m.content);
    expect(texts.some((t) => t.includes("write_file") && t.includes("denied"))).toBe(true);
  });

  it("legacy sessions without a snapshot fall back to the registry agent (backward compat)", async () => {
    const store = new MemorySessionStore();
    const { runtime, orchestrator } = makeRuntime(store, [BASE]);
    // Session created directly through the store — no effective config.
    await store.createSession({
      id: "legacy_1" as SessionId,
      agentId: BASE.id,
      model: BASE.model,
      cwd: "C:\\work",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "C:\\work\\x.txt", content: "x" }),
      ScriptedModelProvider.text("done"),
    ]);
    const runtime2 = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events: new MemoryEventStore(),
      modelProvider: provider,
      orchestrator,
      agents: [BASE],
      now: () => 1000,
    });
    const turn = await runtime2.startTurn("legacy_1" as SessionId, "legacy");
    const outcome = await runtime2.runTurn("legacy_1" as SessionId, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(orchestrator.calls.map((c) => c.request.call.name)).toEqual(["write_file"]);
  });

  it("a corrupt effective-agent snapshot fails closed (no base-agent fallback)", async () => {
    const store = new MemorySessionStore();
    const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: BASE, cwd: "C:\\work" });
    await store.saveStateSnapshot(session.id, { effectiveAgent: { agentId: 42 } });

    const turn = await runtime.startTurn(session.id, "corrupt");
    await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
      info: { code: "INTERNAL_ERROR" },
    });
  });

  it("a snapshot whose agentId mismatches the session fails closed", async () => {
    const store = new MemorySessionStore();
    const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: BASE, cwd: "C:\\work" });
    const other = newAgentId();
    await store.saveStateSnapshot(session.id, {
      effectiveAgent: { ...READ_ONLY, agentId: other, permissions: READ_ONLY.permissions, skills: {}, limits: {} },
    });

    const turn = await runtime.startTurn(session.id, "mismatch");
    await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
      info: { code: "INTERNAL_ERROR" },
    });
  });

  it("session.created fires after the snapshot is persisted", async () => {
    const store = new MemorySessionStore();
    const { runtime, events } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "C:\\work" });
    expect(await store.loadStateSnapshot(session.id)).toBeDefined();
    expect(events.events.some((e) => e.type === "session.created" && e.sessionId === session.id)).toBe(true);
  });

  it("mutating the caller's agent after createSession cannot change the frozen policy", async () => {
    const store = new MemorySessionStore();
    const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "C:\\work" });

    READ_ONLY.tools.allow!.push("write_file");
    READ_ONLY.systemPrompt = "mutated";
    READ_ONLY.permissions.defaultEffect = "deny";
    try {
      const snapshot = await store.loadStateSnapshot(session.id);
      expect(snapshot?.effectiveAgent).toMatchObject({
        tools: { allow: ["read_file"] },
        systemPrompt: "read-only prompt",
        permissions: { defaultEffect: "allow" },
      });
    } finally {
      READ_ONLY.tools.allow!.pop();
      READ_ONLY.systemPrompt = "read-only prompt";
      READ_ONLY.permissions.defaultEffect = "allow";
    }
  });
});

it("a restarted owner with new registry identities retains the original cosmetic role and frozen policy", async () => {
  const store = new MemorySessionStore();
  const { runtime } = makeRuntime(store, [BASE]);
  const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
  const { runtime: restarted } = makeRuntime(store, [{ ...BASE, id: newAgentId(), name: "different current role" }]);
  const actual = await restarted.getSessionAgent(session.id);
  expect(actual.name).toBe(READ_ONLY.name); expect(actual.description).toBe(READ_ONLY.description);
  expect(actual.id).toBe(READ_ONLY.id); expect(actual.tools).toEqual(READ_ONLY.tools);
  expect(actual.permissions).toEqual(READ_ONLY.permissions); expect(actual.systemPrompt).toBe(READ_ONLY.systemPrompt);
});

it("legacy and mismatched cosmetic records do not replace a frozen agent policy", async () => {
  for (const cosmetic of [undefined, { version: 1, agentId: newAgentId(), name: "forged", description: "", mode: "primary", tools: { allow: ["exec"] } }]) {
    const store = new MemorySessionStore(); const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
    const snapshot = (await store.loadStateSnapshot(session.id))!;
    if (cosmetic === undefined) delete snapshot.agentMetadata; else snapshot.agentMetadata = cosmetic;
    await store.saveStateSnapshot(session.id, snapshot);
    const { runtime: restarted } = makeRuntime(store, []);
    const actual = await restarted.getSessionAgent(session.id);
    expect(actual.name).toBe(READ_ONLY.id); expect(actual.tools).toEqual(READ_ONLY.tools);
    expect(actual.permissions).toEqual(READ_ONLY.permissions);
  }
});

describe("P27-4 session model switch", () => {
  it("atomically selects the next model without rewriting frozen policy", async () => {
    const store = new MemorySessionStore(); const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
    const before = (await store.loadStateSnapshot(session.id))!;
    const target = { providerId: "scripted", modelId: "next-model" };

    const updated = await runtime.setSessionModel(session.id, target);
    expect(updated.model).toEqual(target);

    const after = (await store.loadStateSnapshot(session.id))!;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after.effectiveAgent).toMatchObject({
      agentId: READ_ONLY.id,
      systemPrompt: READ_ONLY.systemPrompt,
      tools: READ_ONLY.tools,
      permissions: READ_ONLY.permissions,
      model: READ_ONLY.model,
    });
    expect((await store.getSession(session.id))!.model).toEqual(target);
    // Only the explicit durable selection overrides the immutable snapshot model.
    expect((await runtime.getSessionAgent(session.id)).model).toEqual(target);
  });

  it("fails closed for a missing, corrupt, or foreign effective-agent snapshot", async () => {
    for (const mutate of [
      (snapshot: Record<string, unknown>) => { delete snapshot.effectiveAgent; },
      (snapshot: Record<string, unknown>) => { snapshot.effectiveAgent = { agentId: newAgentId() }; },
      (snapshot: Record<string, unknown>) => { (snapshot.effectiveAgent as { agentId: string }).agentId = newAgentId(); },
    ]) {
      const store = new MemorySessionStore(); const { runtime } = makeRuntime(store, [BASE]);
      const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
      const snapshot = (await store.loadStateSnapshot(session.id))!;
      mutate(snapshot as unknown as Record<string, unknown>);
      await store.saveStateSnapshot(session.id, snapshot);
      await expect(runtime.setSessionModel(session.id, { providerId: "scripted", modelId: "next" }))
        .rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
    }
  });

  it("rejects an empty or unknown model reference instead of clearing the frozen model", async () => {
    const store = new MemorySessionStore(); const { runtime } = makeRuntime(store, [BASE]);
    const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
    for (const model of [{ providerId: "", modelId: "next" }, { providerId: "scripted", modelId: "" }]) {
      await expect(runtime.setSessionModel(session.id, model)).rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
    }
    await expect(runtime.setSessionModel("session_missing" as SessionId, { providerId: "scripted", modelId: "next" }))
      .rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
    expect((await store.getSession(session.id))!.model).toEqual(READ_ONLY.model);
  });
});


it("review PR11: a rejected model selection preserves the previous effective model", async () => {
  const store = new MemorySessionStore(); const { runtime } = makeRuntime(store, [BASE]);
  const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
  const before = await runtime.getSessionAgent(session.id);
  store.updateSession = async () => { throw new Error("review simulated durable row write failure"); };
  await expect(runtime.setSessionModel(session.id, { providerId: "next-route", modelId: "next-model" }))
    .rejects.toThrow("durable row write failure");
  expect((await store.getSession(session.id))!.model).toEqual(before.model);
  expect((await runtime.getSessionAgent(session.id)).model).toEqual(before.model);
});


it.each(["before", "after"])("recovers a model-selection event failure %s durable append exactly once", async stage => {
  const store = new MemorySessionStore(); const { runtime, events } = makeRuntime(store, [BASE]);
  const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
  const append = events.appendNew.bind(events);
  events.appendNew = async event => {
    if (stage === "after") await append(event);
    throw new Error("interrupted event append");
  };
  const model = { providerId: "next-route", modelId: "next-model" };
  await expect(runtime.setSessionModel(session.id, model)).rejects.toThrow("interrupted event append");
  expect((await store.getSession(session.id))!.model).toEqual(model);
  events.appendNew = append;
  const fresh = makeRuntime(store, [BASE], events).runtime;
  expect((await fresh.getSessionAgent(session.id)).model).toEqual(model);
  await fresh.setSessionModel(session.id, model);
  expect((await events.list(session.id)).filter(event => event.payload.kind === "web_model_selection")).toHaveLength(1);
  expect((await store.loadStateSnapshot(session.id))!.effectiveAgent).toMatchObject({ model: READ_ONLY.model, tools: READ_ONLY.tools });
});

it("serializes simultaneous selections without changing the immutable old-message model", async () => {
  const store = new MemorySessionStore(); const { runtime, events } = makeRuntime(store, [BASE]);
  const session = await runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
  await Promise.all(["one", "two"].map(modelId => runtime.setSessionModel(session.id, { providerId: "scripted", modelId })));
  expect((await runtime.getSessionAgent(session.id)).model.modelId).toBe("two");
  expect((await store.getSession(session.id))!.modelSelection!.initialModel).toEqual(READ_ONLY.model);
  expect((await events.list(session.id)).filter(event => event.payload.kind === "web_model_selection")).toHaveLength(2);
});


it("branches a durable parent after registry IDs change without permitting a widened unknown agent", async () => {
  const store = new MemorySessionStore(); const original = makeRuntime(store, [BASE]);
  const parent = await original.runtime.createSession({ agent: READ_ONLY, cwd: "/work" });
  const restarted = makeRuntime(store, [{ ...BASE, id: newAgentId() }]);
  const effective = await restarted.runtime.getSessionAgent(parent.id);
  const before = (await store.listSessions()).length;
  await expect(restarted.runtime.createSession({ agent: { ...effective, tools: BASE.tools }, cwd: "/work", parentId: parent.id }))
    .rejects.toThrow("mismatched inherited agent");
  expect(await store.listSessions()).toHaveLength(before);
  const branch = await restarted.runtime.createSession({ agent: effective, cwd: "/work", parentId: parent.id });
  expect((await restarted.runtime.getSessionAgent(branch.id)).tools).toEqual(READ_ONLY.tools);
  await expect(restarted.runtime.createSession({ agent: effective, cwd: "/work" })).rejects.toThrow("unknown");
});
