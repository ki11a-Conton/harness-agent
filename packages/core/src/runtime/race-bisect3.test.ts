import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager, type SessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT = {
  id: newAgentId(), name: "race-agent", description: "test", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "you are a race test",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: { maxToolCalls: 5 },
} as const satisfies AgentDefinition;

class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private gates: Array<() => void> = [];
  waitForGate(): Promise<void> {
    return new Promise((resolve) => this.gates.push(resolve));
  }
  releaseGate(): void {
    this.gates.shift()?.();
  }
  listModels(): Promise<never[]> { return Promise.resolve([]); }
  createClient() {
    const self = this;
    return {
      async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          self.gates.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}

describe("bisect3", () => {
  it("gated 2.1", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const provider = new GatedProvider();
    const runtime = new AgentRuntime({
      store, events, modelProvider: provider, orchestrator: new FakeOrchestrator(),
      agents: [AGENT], toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    });
    const manager = new DefaultLoadedSessionManager({ runtime, store });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
    const actor = await manager.load(session.id);
    const first = await actor.startTurn({ sessionId: session.id, text: "first" });
    await provider.waitForGate();
    const secondId = (await actor.createTurn({ sessionId: session.id, text: "second" })).id;
    await expect(actor.runTurn(secondId)).rejects.toThrow(/SESSION_BUSY/);
    expect(actor.activeTurn?.turn.id).toBe(first.turnId);
    provider.releaseGate();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    expect(actor.activeTurn).toBeUndefined();
  });
});
