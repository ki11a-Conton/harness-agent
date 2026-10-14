import { expect, it, vi } from "vitest";
import { newAgentId, type AgentDefinition, type AskUserRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const agent: AgentDefinition = { id: newAgentId(), name: "ask-host-callback", description: "test", mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
function setup(askUser: (request: AskUserRequest) => Promise<undefined>) {
  const store = new MemorySessionStore(), events = new MemoryEventStore();
  const runtime = new AgentRuntime({ store, events, agents: [agent], orchestrator: new FakeOrchestrator(), toolRegistry: defaultTestToolCatalog(), askUser,
    modelProvider: new ScriptedModelProvider([ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required" }), ScriptedModelProvider.text("done")]),
  });
  return { runtime, store, events };
}

it.each(["synchronous", "asynchronous"])("a %s host callback failure is observed without rejecting or abandoning the actual question", async mode => {
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const fail = () => { throw new Error("controlled host question delivery failure"); };
  const input = setup(mode === "synchronous" ? fail : async () => fail());
  try {
    const session = await input.runtime.createSession({ agent, cwd: "." }), turn = await input.runtime.startTurn(session.id, "choose target");
    const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(outcome.status).toBe("waiting_for_user"); expect((await input.store.getTurn(turn.id))!.status).toBe("waiting_for_user");
    expect(log.mock.calls.map(call => String(call[0])).join("\n")).toContain("controlled host question delivery failure");
    expect((await input.events.list(session.id)).filter(event => event.type === "ask.user_asked")).toHaveLength(1);
    expect((await input.runtime.submitUserAnswer(session.id, turn.id, outcome.pendingAsk!.id, "blue")).resumed).toBe(true);
    expect((await input.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
    expect((await input.store.listMessages(session.id)).filter(message => message.askId !== undefined)).toHaveLength(1);
  } finally { log.mockRestore(); }
});

it("a slow asynchronous host callback does not hold the turn open or block out-of-band answering", async () => {
  let finish!: () => void, delivered: AskUserRequest | undefined;
  const pending = new Promise<undefined>(resolve => { finish = () => resolve(undefined); });
  const input = setup(request => { delivered = request; return pending; });
  try {
    const session = await input.runtime.createSession({ agent, cwd: "." }), turn = await input.runtime.startTurn(session.id, "choose target");
    const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("waiting_for_user"); expect(delivered?.id).toBe(outcome.pendingAsk!.id);
    expect((await input.runtime.submitUserAnswer(session.id, turn.id, outcome.pendingAsk!.id, "blue")).resumed).toBe(true);
    expect((await input.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
  } finally { finish(); await pending; }
});
