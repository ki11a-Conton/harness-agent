import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT = {
  id: newAgentId(), name: "race-agent", description: "test", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "you are a race test",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: { maxToolCalls: 5 },
} as const satisfies AgentDefinition;

class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private entered = 0;
  private entryWaiters: Array<() => void> = [];
  private releases: Array<(value: void | PromiseLike<void>) => void> = [];

  // resolves when the NEXT in-flight turn has reached the gate
  whenEntered(): Promise<void> {
    if (this.entered > 0) return Promise.resolve();
    return new Promise((r) => this.entryWaiters.push(r));
  }
  release(): void {
    this.releases.shift()?.(undefined);
  }
  listModels(): Promise<never[]> { return Promise.resolve([]); }
  createClient() {
    const self = this;
    return {
      async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        self.entered += 1;
        self.entryWaiters.shift()?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          self.releases.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}

/** P36-9: assert the typed error CODE (SESSION_BUSY), never message text. */
async function expectSessionBusy(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ info: { code: "SESSION_BUSY" } });
}

describe("bisect5", () => {
  it("gated flow", async () => {
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
    await provider.whenEntered();
    // Create a second turn via the RUNTIME (actor.createTurn refuses while
    // one is active); runTurn on it is refused with SESSION_BUSY.
    const secondTurn = await runtime.startTurn(session.id, "second");
    await expectSessionBusy(actor.runTurn(secondTurn.id));
    expect(actor.activeTurn?.turn.id).toBe(first.turnId);
    provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    expect(actor.activeTurn).toBeUndefined();
  });
});
