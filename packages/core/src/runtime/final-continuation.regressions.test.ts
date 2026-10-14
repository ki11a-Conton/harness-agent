import { expect, it } from "vitest";
import type { AgentDefinition, CheckpointData, CheckpointStore, ModelProvider, ModelRequest, SessionId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const agent: AgentDefinition = { id: newAgentId(), name: "final-continuation", description: "test", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
const write = (path: string) => ScriptedModelProvider.toolCall("write_file", { path, content: "updated" });
const ask = () => ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required" });
class Checkpoints implements CheckpointStore {
  readonly saved: CheckpointData[] = [];
  async save(checkpoint: CheckpointData) { this.saved.push(structuredClone(checkpoint)); }
  async list(sessionId: SessionId) { return this.saved.filter(value => value.sessionId === sessionId).toReversed().map(value => structuredClone(value)); }
  async loadLatest(sessionId: SessionId) { return (await this.list(sessionId))[0]; }
}
function setup(provider: ModelProvider, limits: AgentDefinition["limits"] = {}, checkpoints?: Checkpoints, now?: () => number) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
  const completed: string[] = [];
  const definition = { ...agent, limits };
  const makeRuntime = () => new AgentRuntime({ store, events, modelProvider: provider, orchestrator, agents: [definition],
    onTurnComplete: async input => { completed.push(input.outcome.status); },
    toolRegistry: defaultTestToolCatalog(), ...(checkpoints ? { checkpointStore: checkpoints } : {}), ...(now ? { now } : {}), maxIterationsPerTurn: 4 });
  return { store, events, orchestrator, definition, completed, makeRuntime, runtime: makeRuntime() };
}
async function paused(input: ReturnType<typeof setup>) {
  const session = await input.runtime.createSession({ agent: input.definition, cwd: "." });
  const turn = await input.runtime.startTurn(session.id, "implement target");
  const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("waiting_for_user");
  expect((await input.runtime.submitUserAnswer(session.id, turn.id, outcome.pendingAsk!.id, "blue")).resumed).toBe(true);
  return { session, turn, outcome };
}

it.each([false, true])("preserves original files, actual counters and effect classification across a question (restart=%s)", async restart => {
  const checkpoints = new Checkpoints();
  const input = setup(new ScriptedModelProvider([write("app.txt"), ask(), ScriptedModelProvider.text("done")]), { maxTurns: 1 }, checkpoints);
  const { session, turn } = await paused(input);
  const runtime = restart ? input.makeRuntime() : input.runtime;
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("completed");
  expect(outcome.state!.filesChanged).toEqual(["app.txt"]); expect(outcome.toolCalls).toBe(1); expect(outcome.iterations).toBe(2);
  expect(input.orchestrator.calls).toHaveLength(1); expect(await input.store.listTurns(session.id)).toHaveLength(1);
});

it("answering a question does not refresh the consumed tool budget", async () => {
  const input = setup(new ScriptedModelProvider([write("first.txt"), ask(), write("second.txt"), ScriptedModelProvider.text("done")]), { maxToolCalls: 1 });
  const { session, turn } = await paused(input);
  const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
  expect(outcome.statusDetail).toBe("failed_with_effects"); expect(input.orchestrator.calls).toHaveLength(1);
  expect(outcome.state!.filesChanged).toEqual(["first.txt"]);
});

it("cancelled continuation retains the previously committed effect ledger", async () => {
  const input = setup(new ScriptedModelProvider([write("first.txt"), ask()]));
  const { session, turn } = await paused(input), controller = new AbortController(); controller.abort();
  const outcome = await input.runtime.runTurn(session.id, turn.id, controller.signal);
  expect(outcome.statusDetail).toBe("cancelled_with_effects"); expect(outcome.state!.filesChanged).toEqual(["first.txt"]);
  expect(outcome.toolCalls).toBe(1); expect(outcome.iterations).toBe(2);
});

it.each([10, 20])("preserves spent execution duration while excluding human waiting time (limit=%s)", async limit => {
  let time = 1_000, call = 0;
  const provider: ModelProvider = { id: "scripted", listModels: async () => [], createClient: () => ({ async *generate() {
    call += 1; time += 4;
    yield* (call === 1 ? write("first.txt") : call === 2 ? ask() : ScriptedModelProvider.text("done"));
  } }) };
  const input = setup(provider, { maxDurationMs: limit }, undefined, () => time); const { session, turn } = await paused(input); time += 100_000;
  const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe(limit === 10 ? "failed" : "completed"); expect(call).toBe(3);
  if (limit === 10) {
    expect(outcome.terminationReason).toBe("time_limit");
    const reached = (await input.events.list(session.id)).find(event => event.type === "run.limit_reached")!;
    expect(reached.payload.used).toBe(12);
  }
});

it("parallel sessions checkpoint their own live budget, including after another turn finishes", async () => {
  let allowA!: () => void, allowB!: () => void, reachedA!: () => void, reachedB!: () => void;
  const gateA = new Promise<void>(resolve => { allowA = resolve; }), gateB = new Promise<void>(resolve => { allowB = resolve; });
  const readyA = new Promise<void>(resolve => { reachedA = resolve; }), readyB = new Promise<void>(resolve => { reachedB = resolve; });
  const calls = new Map<string, number>();
  const provider: ModelProvider = { id: "scripted", listModels: async () => [], createClient: () => ({ async *generate(request: ModelRequest) {
    const name = request.messages.find(message => message.role === "user")!.content;
    const count = (calls.get(name) ?? 0) + 1; calls.set(name, count);
    if (name === "A" && count === 1) { reachedA(); await gateA; yield* write("a.txt"); }
    else if (name === "A" && count === 2) yield* write("a2.txt");
    else if (name === "B" && count <= 3) yield* ScriptedModelProvider.toolCall("read_file", { path: `b${count}.txt` });
    else { if (name === "B") { reachedB(); await gateB; } yield* ScriptedModelProvider.text("done"); }
  } }) };
  const checkpoints = new Checkpoints(), input = setup(provider, { maxToolCalls: 10 }, checkpoints);
  const a = await input.runtime.createSession({ agent: input.definition, cwd: "." }), b = await input.runtime.createSession({ agent: input.definition, cwd: "." });
  const ta = await input.runtime.startTurn(a.id, "A"), tb = await input.runtime.startTurn(b.id, "B");
  const runningA = input.runtime.runTurn(a.id, ta.id, new AbortController().signal); await readyA;
  const runningB = input.runtime.runTurn(b.id, tb.id, new AbortController().signal); await readyB;
  try {
    const foreign = await input.runtime.createSession({ agent: input.definition, cwd: "." });
    await expect(input.runtime.runTurn(foreign.id, ta.id, new AbortController().signal)).rejects.toThrow(/does not belong/);
    allowA(); expect((await runningA).status).toBe("completed");
    const checkpoint = (await checkpoints.list(a.id)).find(value => value.reason === "tool:completed:write_file")!;
    expect(checkpoint.budgetUsage?.run?.usedToolCalls).toBe(2);
  } finally { allowB(); await runningB; }
});

it("a zero tool budget blocks the side effect before dispatch and still settles the requested tool", async () => {
  const input = setup(new ScriptedModelProvider([write("forbidden.txt")] ), { maxToolCalls: 0 });
  const session = await input.runtime.createSession({ agent: input.definition, cwd: "." }), turn = await input.runtime.startTurn(session.id, "implement");
  const outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
  expect(input.orchestrator.calls).toHaveLength(0); expect(outcome.state!.filesChanged).toEqual([]);
  const history = await input.store.listMessages(session.id), requested = history.find(message => message.toolCalls?.length)!;
  expect(history.filter(message => message.role === "tool").map(message => message.toolCallId)).toContain(requested.toolCalls![0]!.id);
});

it("a restarted question refuses a missing pause checkpoint instead of silently clearing state and budget", async () => {
  const input = setup(new ScriptedModelProvider([write("first.txt"), ask(), ScriptedModelProvider.text("done")]));
  const { session, turn } = await paused(input);
  await expect(input.makeRuntime().runTurn(session.id, turn.id, new AbortController().signal)).rejects.toThrow(/no intact question-pause checkpoint/);
  expect(input.orchestrator.calls).toHaveLength(1); expect((await input.store.getTurn(turn.id))!.status).toBe("waiting_for_user");
});

it("durable continuation restores the actual internal-plan tool count as well as external tool ledger entries", async () => {
  const checkpoints = new Checkpoints(), input = setup(new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("update_plan", { mutations: [] }), write("first.txt"), ask(), ScriptedModelProvider.text("done")]), {}, checkpoints);
  const { session, turn } = await paused(input);
  const outcome = await input.makeRuntime().runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("completed"); expect(outcome.toolCalls).toBe(2); expect(outcome.iterations).toBe(3);
  expect(outcome.state!.filesChanged).toEqual(["first.txt"]);
});

it("repeated questions cannot refresh the same turn's iteration cap", async () => {
  const input = setup(new ScriptedModelProvider([ask(), ask(), ask(), ask(), ScriptedModelProvider.text("must not run")]));
  const { session, turn, outcome: first } = await paused(input); let outcome = first;
  for (let i = 1; i <= 4; i++) {
    if (i > 1) expect((await input.runtime.submitUserAnswer(session.id, turn.id, outcome.pendingAsk!.id, "blue")).resumed).toBe(true);
    outcome = await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    if (i < 4) expect(outcome.status).toBe("waiting_for_user");
  }
  expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT"); expect(outcome.iterations).toBe(4);
  expect(await input.store.listTurns(session.id)).toHaveLength(1);
});

it("a user-input pause does not feed a terminal failure to reflection, memory or skill feedback", async () => {
  const input = setup(new ScriptedModelProvider([ask(), ScriptedModelProvider.text("done")]));
  const { session, turn } = await paused(input); expect(input.completed).toEqual([]);
  expect((await input.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
  expect(input.completed).toEqual(["completed"]);
});

it.each(["completed", "cancelled"] as const)("refuses direct replay of an actual %s turn without calling the model or tool again", async status => {
  const input = setup(new ScriptedModelProvider([write("once.txt"), ScriptedModelProvider.text("done")]));
  const session = await input.runtime.createSession({ agent: input.definition, cwd: "." }), turn = await input.runtime.startTurn(session.id, "implement");
  await input.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  if (status === "cancelled") await input.store.updateTurn({ ...(await input.store.getTurn(turn.id))!, status });
  const before = await input.store.listMessages(session.id);
  await expect(input.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toThrow(/terminal/);
  expect(input.orchestrator.calls).toHaveLength(1); expect(await input.store.listMessages(session.id)).toEqual(before);
});
