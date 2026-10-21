import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentEvent, CheckpointData, CheckpointStore, ModelEvent, RunLimits, TaskSpec, VerificationResult } from "@ar/contracts";
import { buildCheckpoint, newAgentId, newCheckpointId, newEventId, newToolCallId, newWorkingState } from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, type AgentRuntimeDeps } from "./runtime.js";
import { RunBudgetTracker } from "./run-budget.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

class Checkpoints implements CheckpointStore {
  saved: CheckpointData[] = [];
  async save(checkpoint: CheckpointData) { this.saved.push(structuredClone(checkpoint)); }
  async loadLatest() { return structuredClone(this.saved.at(-1)); }
  async list() { return structuredClone([...this.saved].reverse()); }
}
function agent(limits: RunLimits = {}): AgentDefinition {
  return { id: newAgentId(), name: "longrun", description: "deterministic budgets and recovery", mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits };
}
const task: TaskSpec = { id: "longrun", goal: "complete the change", constraints: [], verification: [{ kind: "command", command: "test" }] };
function verdict(passed: boolean): VerificationResult {
  return { level: 3, passed, checks: [{ id: "test", kind: "command", description: "check", passed }], evidence: [], startedAt: 0, completedAt: 0 };
}
function text(text: string, estimatedCostUsd = 0): ModelEvent[] {
  return [{ type: "started", timestamp: 0 }, { type: "text_delta", text, timestamp: 0 },
    { type: "completed", result: { finishReason: "stop", text, usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd } }, timestamp: 0 }];
}
function setup(a: AgentDefinition, scripts: ModelEvent[][], overrides: Partial<AgentRuntimeDeps> = {}) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
  const provider = new ScriptedModelProvider(scripts);
  const runtime = new AgentRuntime({ store, events, orchestrator, modelProvider: provider, agents: [a],
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, ...overrides });
  return { store, events, orchestrator, provider, runtime };
}
async function start(h: ReturnType<typeof setup>, a: AgentDefinition) {
  const session = await h.runtime.createSession({ agent: a, cwd: "/work" });
  const turn = await h.runtime.startTurn(session.id, "complete the change");
  return { session, turn };
}

describe("long-running completion accounting and checkpoint recovery", () => {
  it("meters failed verification attempts and stops before spending another call", async () => {
    const a = agent({ maxEstimatedCostUsd: 1 });
    const reports: number[] = []; let checks = 0;
    const h = setup(a, [text("first", 0.75), text("second", 0.75), text("third")], {
      task, verifier: { async verify() { checks++; return verdict(false); } },
      reportModelUsage: (_session, usage) => { reports.push(usage.estimatedCostUsd ?? -1); },
    });
    const { session, turn } = await start(h, a);
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect((await h.store.getTurn(turn.id))?.status).toBe("failed");
    expect(h.provider.calls).toHaveLength(2); expect(checks).toBe(1);
    expect(reports).toEqual([0.75, 0.75]);
    expect(h.events.events.filter(event => event.type === "model.completed").map(event => event.payload.usage))
      .toEqual([expect.objectContaining({ estimatedCostUsd: 0.75 }), expect.objectContaining({ estimatedCostUsd: 0.75 })]);
    expect((await h.store.listMessages(session.id)).filter(message => message.role === "assistant").map(message => message.content))
      .toEqual(["first", "second"]);
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload.limit).toBe("maxEstimatedCostUsd");
  });

  it("counts output from a failed gate and checks a final answer before terminal persistence", async () => {
    for (const shouldFailFirst of [false, true]) {
      const a = agent({ maxOutputChars: 5 }); let checks = 0;
      const h = setup(a, shouldFailFirst ? [text("abc"), text("def")] : [text("abcdef")], {
        task, verifier: { async verify() { checks++; return verdict(!shouldFailFirst); } },
      });
      const { session, turn } = await start(h, a);
      const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(checks).toBe(shouldFailFirst ? 1 : 0);
      expect((await h.store.getTurn(turn.id))?.status).toBe("failed");
      expect(h.events.events.filter(event => event.type === "model.completed")).toHaveLength(shouldFailFirst ? 2 : 1);
      expect((await h.store.listMessages(session.id)).filter(message => message.role === "assistant").map(message => message.content))
        .toEqual(shouldFailFirst ? ["abc", "def"] : ["abcdef"]);
    }
  });


  it("records a metered tool request at the cost cap without executing or leaving an orphan tool call", async () => {
    const a = agent({ maxEstimatedCostUsd: 0.1 });
    const script = ScriptedModelProvider.toolCall("write_file", { path: "blocked.txt", content: "never" });
    for (const event of script) if (event.type === "completed") event.result.usage = { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.2 };
    const h = setup(a, [script]);
    const { session, turn } = await start(h, a);
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT"); expect(h.orchestrator.calls).toEqual([]);
    const completed = h.events.events.filter(event => event.type === "model.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.usage).toMatchObject({ estimatedCostUsd: 0.2, inputTokens: 10, outputTokens: 5 });
    const history = await h.store.listMessages(session.id);
    const assistantIndex = history.findIndex(message => message.role === "assistant");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(history[assistantIndex + 1]).toMatchObject({ role: "tool", toolCallId: history[assistantIndex]!.toolCalls![0]!.id });
    expect(h.events.events.some(event => event.type === "tool.started")).toBe(false);
  });

  it("keeps full budgets, failure evidence and consumed verification retries in context-enabled checkpoints", async () => {
    const a = agent(), checkpointStore = new Checkpoints();
    const h = setup(a, [text("first", 0.2), text("second", 0.3)], { checkpointStore,
      context: { pipeline: new ContextPipeline({ discovery: { discover: async () => [] } }),
        budget: { maxTokens: 10000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 } },
      task, verifier: { async verify() { return verdict(false); } }, maxVerificationFailures: 2,
    });
    const { session, turn } = await start(h, a);
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verification_failed");
    const saved = checkpointStore.saved.filter(checkpoint => checkpoint.reason === "verification:failed");
    expect(saved.map(checkpoint => checkpoint.budgetUsage?.verificationRetries)).toEqual([1, 2]);
    expect(saved.map(checkpoint => checkpoint.budgetUsage?.run?.estimatedCostUsd)).toEqual([0.2, 0.5]);
    expect(saved.map(checkpoint => checkpoint.state.failures.length)).toEqual([1, 2]);
    expect(saved.map(checkpoint => checkpoint.iteration)).toEqual([1, 2]);
    expect((await h.store.listMessages(session.id)).some(message => message.content.includes("[verification failed"))).toBe(true);
  });

  it("same-turn restart retains earlier writes, ledger and an already-consumed tool budget", async () => {
    const a = agent({ maxToolCalls: 1 }), checkpointStore = new Checkpoints();
    const h = setup(a, [ScriptedModelProvider.toolCall("write_file", { path: "new.txt", content: "new" })], { checkpointStore });
    const { session, turn } = await start(h, a);
    const state = newWorkingState(turn.input.text); state.filesChanged.push("old.txt"); state.completed.push("modified old.txt");
    const budget = new RunBudgetTracker(a.limits, () => 0); budget.onTurnStart(); budget.onToolCall();
    await checkpointStore.save(buildCheckpoint({ checkpointId: newCheckpointId(), schemaVersion: 1, sessionId: session.id, turnId: turn.id,
      agentId: a.id, createdAt: 0, reason: "tool:completed:write_file", phase: "thinking", iteration: 7, toolCallsExecuted: 1,
      state, toolLedger: [{ toolCallId: newToolCallId(), tool: "write_file", argsHash: "old", started: 0, completed: 0, status: "success", sideEffect: true }],
      childSessions: [], lastEventSequence: (await h.events.nextSequence(session.id)) - 1, effectiveAgentConfigRef: "effectiveAgent", contextRefs: [],
      budgetUsage: { maxTokens: 1000, run: budget.snapshot() } }));
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed"); expect(outcome.terminationReason).toBe("tool_limit");
    expect(outcome.state?.filesChanged).toEqual(["old.txt"]);
    expect(outcome.statusDetail).toBe("failed_with_effects"); expect(h.orchestrator.calls).toHaveLength(0);
    expect(outcome.iterations).toBe(8); expect(outcome.turn.id).toBe(turn.id);
  });

  it("does not reopen verification attempts after an exhausted checkpoint boundary", async () => {
    const a = agent(), checkpointStore = new Checkpoints();
    const h = setup(a, [text("must not execute")], { checkpointStore, maxVerificationFailures: 2 });
    const { session, turn } = await start(h, a);
    const state = newWorkingState(turn.input.text); state.failures.push("verification: failed twice");
    const budget = new RunBudgetTracker(a.limits, () => 0); budget.onTurnStart();
    await checkpointStore.save(buildCheckpoint({ checkpointId: newCheckpointId(), schemaVersion: 1, sessionId: session.id, turnId: turn.id,
      agentId: a.id, createdAt: 0, reason: "verification:failed", phase: "thinking", iteration: 1, toolCallsExecuted: 0,
      state, toolLedger: [], childSessions: [], lastEventSequence: (await h.events.nextSequence(session.id)) - 1,
      effectiveAgentConfigRef: "effectiveAgent", contextRefs: [], budgetUsage: { maxTokens: 0, run: budget.snapshot(), verificationRetries: 2 } }));
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verification_failed"); expect(h.provider.calls).toHaveLength(0);
    expect(outcome.state?.failures).toEqual(["verification: failed twice"]);
  });

  it("fails closed on executed turns without a checkpoint instead of granting a fresh budget", async () => {
    const a = agent(), h = setup(a, [text("must not execute")]);
    const { session, turn } = await start(h, a);
    await h.events.append({ id: newEventId(), sessionId: session.id, turnId: turn.id, sequence: 0, timestamp: 0,
      type: "model.started", payload: { callId: "interrupted" } } as AgentEvent);
    await expect(h.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({ info: { code: "RESUME_FAILED" } });
    expect(h.provider.calls).toHaveLength(0); expect(h.orchestrator.calls).toHaveLength(0);
  });
});
