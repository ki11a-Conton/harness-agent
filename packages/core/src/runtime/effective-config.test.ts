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

function makeRuntime(store: MemorySessionStore, agents: AgentDefinition[]) {
  const events = new MemoryEventStore();
  const orchestrator = new FakeOrchestrator({ status: "success", output: "fake-ok" });
  const runtime = new AgentRuntime({
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
