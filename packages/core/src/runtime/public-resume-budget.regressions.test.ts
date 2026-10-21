import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentEvent, CheckpointData, CheckpointStore, RunBudget, RunLimits, TurnId } from "@ar/contracts";
import { buildCheckpoint, newAgentId, newCheckpointId, newEventId, newMessageId, newTurnId, newWorkingState } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { RunBudgetTracker } from "./run-budget.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

class Checkpoints implements CheckpointStore {
  saved: CheckpointData[] = [];
  async save(checkpoint: CheckpointData) { this.saved.push(structuredClone(checkpoint)); }
  async loadLatest() { return structuredClone(this.saved.at(-1)); }
  async list() { return structuredClone([...this.saved].reverse()); }
}

async function setup(limits: RunLimits = {}, scripts = [ScriptedModelProvider.text("ok")]) {
  const agent: AgentDefinition = { id: newAgentId(), name: "resume-budget", description: "resume budget regression", mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits };
  const store = new MemorySessionStore(), events = new MemoryEventStore(), checkpointStore = new Checkpoints();
  const provider = new ScriptedModelProvider(scripts), orchestrator = new FakeOrchestrator();
  let prefetches = 0;
  const runtime = new AgentRuntime({ store, events, checkpointStore, modelProvider: provider, orchestrator, agents: [agent],
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, now: () => 1000,
    memoryBlocks: async () => { prefetches++; return []; },
    checkpointPolicy: { afterSideEffectTools: true, afterCompaction: false, afterVerification: false, everyNIterations: 0 } });
  const session = await runtime.createSession({ agent, cwd: "/work" });
  const turn = await runtime.startTurn(session.id, "finish the change");
  const budget = new RunBudgetTracker(limits, () => 0); budget.onTurnStart();
  async function checkpoint(run: RunBudget = budget.snapshot()) {
    const checkpoint = buildCheckpoint({ checkpointId: newCheckpointId(), schemaVersion: 1, sessionId: session.id, turnId: turn.id,
      agentId: agent.id, createdAt: 0, reason: "iteration", phase: "thinking", iteration: 1, toolCallsExecuted: 0,
      state: newWorkingState(turn.input.text), toolLedger: [], childSessions: [], lastEventSequence: (await events.nextSequence(session.id)) - 1,
      effectiveAgentConfigRef: "effectiveAgent", contextRefs: [], budgetUsage: { maxTokens: 0, run } });
    await checkpointStore.save(checkpoint);
    return checkpoint;
  }
  async function event(type: AgentEvent["type"], payload: Record<string, unknown>, turnId: TurnId = turn.id) {
    return events.append({ id: newEventId(), sessionId: session.id, turnId, sequence: 0, timestamp: 0, type, payload } as AgentEvent);
  }
  async function completed(text: string, cost: number, purpose?: string, turnId: TurnId = turn.id) {
    // Match the durable assistant + journal boundary before terminal persistence.
    if (purpose !== "compaction") await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId,
      role: "assistant", content: text, createdAt: 0 });
    await event("model.completed", { callId: newEventId(), finishReason: "stop", text, final: true, toolCalls: 0,
      durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: cost }, ...(purpose === undefined ? {} : { purpose }) }, turnId);
  }
  async function settledTool(id: string, name: string, duplicate = false, turnId: TurnId = turn.id) {
    await event("tool.requested", { toolCallId: id, name, args: { path: "old.txt" } }, turnId);
    if (duplicate) await event("tool.requested", { toolCallId: id, name, args: { path: "old.txt" } }, turnId);
    await event("tool.completed", { toolCallId: id, name, status: "success" }, turnId);
    await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId, role: "tool", toolCallId: id as never, content: "done", createdAt: 0 });
  }
  const resume = () => runtime.resumeTurn(session.id, new AbortController().signal);
  return { runtime, store, events, checkpointStore, provider, orchestrator, session, turn, budget, checkpoint, event, completed, settledTool, resume,
    prefetches: () => prefetches };
}

describe("public recovery preserves durable task consumption across its fresh turn", () => {
  it.each(["cost", "output"] as const)("stops before provider or memory when post-checkpoint %s already breached its cap", async kind => {
    const h = await setup(kind === "cost" ? { maxEstimatedCostUsd: 1 } : { maxOutputChars: 5 });
    h.budget.onModelUsage(1, 1, kind === "cost" ? 0.4 : 0);
    await h.checkpoint();
    await h.completed(kind === "output" ? "123456" : "spent", kind === "cost" ? 0.8 : 0);
    const result = await h.resume();
    expect(result.outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(result.outcome.turn.id).not.toBe(h.turn.id);
    expect(h.provider.calls).toHaveLength(0); expect(h.prefetches()).toBe(0);
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload)
      .toMatchObject({ limit: kind === "cost" ? "maxEstimatedCostUsd" : "maxOutputChars" });
  });

  it.each(["cost", "output"] as const)("also preflights a direct fresh run with an already-spent %s seed", async kind => {
    const h = await setup(kind === "cost" ? { maxEstimatedCostUsd: 1 } : { maxOutputChars: 5 });
    const seed = h.budget.snapshot();
    if (kind === "cost") seed.estimatedCostUsd = 1.2;
    else seed.outputChars = 6;
    const outcome = await h.runtime.runTurn(h.session.id, h.turn.id, new AbortController().signal,
      { initialState: newWorkingState("continue"), budgetSeed: seed });
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(h.provider.calls).toHaveLength(0); expect(h.prefetches()).toBe(0);
  });

  it("filters the source turn and excludes the checkpoint watermark without mutating the snapshot", async () => {
    const h = await setup({ maxEstimatedCostUsd: 1, maxOutputChars: 8 });
    await h.completed("already covered by the snapshot", 99);
    h.budget.onModelUsage(1, 1, 0.2); h.budget.onOutput(1);
    const checkpoint = await h.checkpoint(), original = structuredClone(checkpoint);
    await h.completed("another turn must not consume this task's budget", 99, undefined, newTurnId());
    await h.completed("tail", 0.2);
    expect((await h.resume()).outcome.status).toBe("completed");
    expect(h.provider.calls).toHaveLength(1);
    expect(h.checkpointStore.saved[0]).toEqual(original);
  });

  it("charges compaction cost before resuming but does not count its summary as answer output", async () => {
    const h = await setup({ maxEstimatedCostUsd: 0.5, maxOutputChars: 2 });
    h.budget.onModelUsage(1, 1, 0.2); await h.checkpoint();
    await h.completed("long internal compaction summary", 0.4, "compaction");
    expect((await h.resume()).outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload.limit).toBe("maxEstimatedCostUsd");
    expect(h.provider.calls).toHaveLength(0);
  });

  it("preserves a legacy checkpoint-only budget when the source turn cannot be identified", async () => {
    const h = await setup({ maxEstimatedCostUsd: 1, maxOutputChars: 5 });
    h.budget.onModelUsage(1, 1, 0.2); h.budget.onOutput(1);
    const { turnId: _turnId, ...legacy } = await h.checkpoint();
    await h.checkpointStore.save(legacy);
    await h.completed("unattributable session journal", 99, undefined, newTurnId());
    expect((await h.resume()).outcome.status).toBe("completed");
    expect(h.provider.calls).toHaveLength(1);
  });

  it("allows output exactly at its cap after a paid compaction summary", async () => {
    const h = await setup({ maxEstimatedCostUsd: 1, maxOutputChars: 2 });
    await h.checkpoint(); await h.completed("a long internal summary", 0.2, "compaction");
    expect((await h.resume()).outcome.status).toBe("completed");
    expect(h.provider.calls).toHaveLength(1);
  });

  it("carries tool and retry tails while retaining fresh-turn identity, turn consumption and duration", async () => {
    const h = await setup({ maxTurns: 3, maxToolCalls: 3, maxDurationMs: 10 },
      [ScriptedModelProvider.toolCall("write_file", { path: "new.txt", content: "new" }), ScriptedModelProvider.text("done")]);
    await h.settledTool("before", "write_file"); await h.event("model.retry", { attempt: 1 });
    const seed = h.budget.snapshot();
    Object.assign(seed, { usedTurns: 2, usedToolCalls: 1, retries: 1, subagentsSpawned: 2, durationMs: 10000 });
    await h.checkpoint(seed);
    await h.settledTool("tail", "write_file", true);
    await h.settledTool("plan", "update_plan");
    const other = newTurnId();
    await h.settledTool("other", "write_file", false, other);
    await h.event("model.retry", { attempt: 1 }, other);
    await h.event("model.retry", { attempt: 1 }); await h.event("model.retry", { attempt: 2 });
    const result = await h.resume();
    expect(result.outcome.status).toBe("completed");
    expect(result.outcome.turn.id).not.toBe(h.turn.id);
    expect(result.outcome.turn.startedAt).toBe(1000);
    expect(h.orchestrator.calls).toHaveLength(1);
    const restored = h.checkpointStore.saved.find(checkpoint => checkpoint.turnId === result.outcome.turn.id)?.budgetUsage?.run;
    expect(restored).toMatchObject({ usedTurns: 3, usedToolCalls: 3, retries: 3, subagentsSpawned: 2, durationMs: 0, startedAt: 1000 });
    expect(restored?.runId).not.toBe(seed.runId);
  });

  it("enforces a tool budget consumed after the checkpoint instead of regranting that call", async () => {
    const h = await setup({ maxToolCalls: 1 }, [ScriptedModelProvider.toolCall("write_file", { path: "blocked.txt", content: "blocked" })]);
    await h.checkpoint(); await h.settledTool("tail", "write_file");
    const result = await h.resume();
    expect(result.outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(h.provider.calls).toHaveLength(1); expect(h.orchestrator.calls).toHaveLength(0);
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload.limit).toBe("maxToolCalls");
  });

  it("keeps maxTurns as a fresh-turn charge on explicit resume", async () => {
    const h = await setup({ maxTurns: 1 }); await h.checkpoint();
    expect((await h.resume()).outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(h.provider.calls).toHaveLength(0);
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload).toMatchObject({ limit: "maxTurns", used: 2, allowed: 1 });
  });
});
