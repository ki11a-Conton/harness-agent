import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider, SessionId, TurnId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager, type SessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT = {
  id: newAgentId(),
  name: "race-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a race test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: { maxToolCalls: 5 },
} as const satisfies AgentDefinition;

describe("bisect", () => {
  it("loads", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: { id: "x", listModels: async () => [], createClient: () => ({}) } as never,
      orchestrator: new FakeOrchestrator(),
      agents: [AGENT],
      toolRegistry: defaultTestToolCatalog(),
    });
    const manager = new DefaultLoadedSessionManager({ runtime, store });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
    const actor = await manager.load(session.id);
    expect(actor.sessionId).toBe(session.id);
  });
});
