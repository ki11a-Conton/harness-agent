import { describe, expect, it } from "vitest";
import type { AgentDefinition, InboxStore, TurnId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
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

describe("long-running actor recovery reservations", () => {
  it("rechecks ownership after recovery discovery before reserving a followup", async () => {
    const store = new MemorySessionStore();
    const agent: AgentDefinition = { id: newAgentId(), name: "reservation", description: "audit regression", mode: "primary",
      model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {},
      permissions: { rules: [] }, skills: {}, limits: {} };
    const runtime = new AgentRuntime({ store, events: new MemoryEventStore(), agents: [agent],
      modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]),
      toolRegistry: defaultTestToolCatalog(), orchestrator: new FakeOrchestrator(), permissiveToolResolution: true });
    const session = await runtime.createSession({ agent, cwd: "/work" });
    const discoveryEntered = gate(), discoveryRelease = gate(), startEntered = gate(), startRelease = gate();
    const inbox: InboxStore = {
      async admit() {}, async listPending() { return []; }, async listAll() { return []; },
      async listRecoverable() { discoveryEntered.open(); await discoveryRelease.promise; return []; },
      async markPromoted() {}, async bindPromotion() {}, async markConsumed() {},
    };
    const executed: TurnId[] = [];
    const actor = new DefaultSessionActor({ persistent: session, store, inbox, runtime: {
      async startTurn(sessionId, text) { startEntered.open(); await startRelease.promise; return runtime.startTurn(sessionId, text); },
      runTurn(sessionId, turnId, signal, options) { executed.push(turnId); return runtime.runTurn(sessionId, turnId, signal, options); },
    } });
    const drain = actor.drainFollowupsForTest();
    await discoveryEntered.promise;
    const starting = actor.startTurn({ sessionId: session.id, text: "new task admitted during discovery" });
    // Install the rejection handler before opening either boundary.
    const settled = starting.then(handle => ({ handle }), error => ({ error }));
    await startEntered.promise;
    discoveryRelease.open(); await drain;
    expect(actor.executionState).toBe("starting");
    startRelease.open();
    const result = await settled;
    expect("error" in result ? result.error : undefined).toBeUndefined();
    if (!("handle" in result)) throw result.error;
    expect((await result.handle.outcome).status).toBe("completed");
    expect(executed).toEqual([result.handle.turnId]);
    await actor.close();
  });
});
