import { describe, expect, it } from "vitest";
import { buildCheckpoint, DEFAULT_TOOL_SEMANTICS, newAgentId, newCheckpointId, newEventId,
  newMessageId, newSessionId, newTurnId, newWorkingState } from "@ar/contracts";
import type { AgentDefinition, AgentEvent, CheckpointData, ToolExecutionRecord } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { RecoveryController } from "./recovery-controller.js";
import { AgentRuntime } from "./runtime.js";
import { RunBudgetTracker } from "./run-budget.js";
const semantics = { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" as const };

async function fixture() {
  const store = new MemorySessionStore(), events = new MemoryEventStore();
  const sessionId = newSessionId(), turnId = newTurnId();
  const controller = new RecoveryController({ store, events, now: () => 100,
    semanticsOf: () => semantics,
    emit: (sid, type, payload, tid) => events.appendNew({ id: newEventId(), sessionId: sid, turnId: tid, type, payload, timestamp: 100 }),
  });
  const checkpoint = buildCheckpoint({ checkpointId: newCheckpointId(), schemaVersion: 1, sessionId, turnId,
    agentId: newAgentId(), createdAt: 1, reason: "before-requests", phase: "thinking", iteration: 0,
    state: newWorkingState("fix both files"), toolLedger: [], childSessions: [], lastEventSequence: 0,
    effectiveAgentConfigRef: "effectiveAgent", contextRefs: [] });
  const append = (type: AgentEvent["type"], payload: Record<string, unknown>) => events.appendNew({
    id: newEventId(), sessionId, turnId, type, payload: { toolCallId: "reused-id", ...payload }, timestamp: 10 + events.events.length,
  });
  return { checkpoint, store, sessionId, turnId, append,
    request: (path: string) => append("tool.requested", { name: "write_file", args: { path } }),
    message: () => store.appendMessage({ id: newMessageId(), sessionId, turnId, role: "tool", toolCallId: "reused-id" as never, content: "stored output", createdAt: 30 }),
    replay: () => controller.reconstructResumeState(sessionId, turnId, checkpoint) };
}

describe("distinct executions may reuse a model call id across iterations", () => {
  it("restores both successful writes as separate occurrences", async () => {
    const f = await fixture();
    await f.request("a.ts"); await f.append("tool.completed", { status: "success" }); await f.message();
    await f.request("b.ts"); await f.append("tool.completed", { status: "success" });
    const result = await f.replay();
    expect(result.working.filesChanged).toEqual(["a.ts", "b.ts"]);
    expect(result.committedSideEffects).toHaveLength(2);
    expect(result.replayedToolLedger).toHaveLength(2);
    expect(new Set(result.replayedToolLedger.map(row => row.argsHash)).size).toBe(2);
    expect(result.unresolvedTools).toEqual([]);
  });

  it("does not inherit the previous success or tool message when the next occurrence has no outcome", async () => {
    const f = await fixture();
    await f.request("a.ts"); await f.append("tool.completed", { status: "success" }); await f.message();
    await f.request("b.ts");
    const result = await f.replay();
    expect(result.working.filesChanged).toEqual(["a.ts"]);
    expect(result.replayedToolLedger).toHaveLength(1);
    expect(result.committedSideEffects).toHaveLength(1);
    expect(result.unresolvedTools).toHaveLength(1);
    expect(result.unresolvedTools[0]!.argsHash).not.toBe(result.replayedToolLedger[0]!.argsHash);
  });

  it("a later denial does not erase a distinct successful write", async () => {
    const f = await fixture();
    await f.request("a.ts"); await f.append("tool.completed", { status: "success" });
    await f.request("b.ts"); await f.append("tool.completed", { status: "denied" });
    const result = await f.replay();
    expect(result.working.filesChanged).toEqual(["a.ts"]);
    expect(result.replayedToolLedger.map(row => row.status)).toEqual(["success", "denied"]);
    expect(result.committedSideEffects).toHaveLength(1);
    expect(result.unresolvedTools).toEqual([]);
  });

  it("a successful distinct occurrence does not erase earlier partial-effect reconciliation", async () => {
    const f = await fixture();
    await f.request("a.ts"); await f.append("tool.completed", { status: "failed" });
    await f.request("b.ts"); await f.append("tool.completed", { status: "success" });
    const result = await f.replay();
    expect(result.working.filesChanged).toEqual(["b.ts"]);
    expect(result.replayedToolLedger.map(row => row.status)).toEqual(["failed", "success"]);
    expect(result.unresolvedTools).toHaveLength(1);
    expect(result.committedSideEffects).toHaveLength(1);
  });

  it("still folds multiple retry terminals inside one requested occurrence", async () => {
    const f = await fixture();
    await f.request("a.ts"); await f.append("tool.failed", { error: { code: "PROCESS_ERROR" } });
    await f.append("tool.completed", { status: "success" }); await f.append("tool.completed", {});
    const result = await f.replay();
    expect(result.replayedToolLedger).toHaveLength(1);
    expect(result.replayedToolLedger[0]!.status).toBe("success");
    expect(result.working.filesChanged).toEqual(["a.ts"]);
    expect(result.unresolvedTools).toEqual([]);
    expect(result.working.failures).toEqual([]);
  });

  it("does not use a pre-checkpoint legacy result to certify a new reused occurrence", async () => {
    const f = await fixture();
    const record: ToolExecutionRecord = { toolCallId: "reused-id" as never, tool: "write_file", argsHash: "before", started: 1, completed: 2, status: "success", sideEffect: true };
    f.checkpoint.toolLedger.push(record); f.checkpoint.state.filesChanged.push("a.ts");
    await f.message(); await f.request("b.ts");
    const result = await f.replay();
    expect(result.working.filesChanged).toEqual(["a.ts"]);
    expect(result.replayedToolLedger).toEqual([]);
    expect(result.unresolvedTools).toHaveLength(1);
  });

  it("preserves both internal plan mutations with reused call ids", async () => {
    const f = await fixture();
    for (const step of ["a", "b"]) {
      await f.append("tool.requested", { name: "update_plan", args: { mutations: [{ op: "mark_completed", step }] } });
      await f.append("tool.completed", {});
    }
    expect((await f.replay()).working.completed).toEqual(["a", "b"]);
  });

  it("keeps one admission when an identical record is repeated inside one frozen step", async () => {
    const f = await fixture();
    const payload = { name: "write_file", args: { path: "a.ts" }, stepId: "step-1" };
    await f.append("tool.requested", payload); await f.append("tool.requested", payload);
    await f.append("tool.completed", { status: "success" }); await f.append("tool.requested", payload);
    const result = await f.replay();
    expect(result.replayedToolLedger).toHaveLength(1);
    expect(result.working.filesChanged).toEqual(["a.ts"]);
    expect(result.unresolvedTools).toEqual([]);
  });

  it("does not deduplicate identical arguments in distinct steps or inherit the earlier result", async () => {
    const f = await fixture();
    await f.append("tool.requested", { name: "write_file", args: { path: "a.ts" }, stepId: "step-1" });
    await f.append("tool.completed", { status: "success" }); await f.message();
    await f.append("tool.requested", { name: "write_file", args: { path: "a.ts" }, stepId: "step-2" });
    const result = await f.replay();
    expect(result.replayedToolLedger).toHaveLength(1);
    expect(result.unresolvedTools).toHaveLength(1);
  });

  it.each([false, true])("does not refund two consumed calls during resume (reused id: %s)", async reused => {
    const agent: AgentDefinition = { id: newAgentId(), name: "budget-replay", description: "two-call budget",
      mode: "primary", model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "code",
      tools: {}, permissions: { rules: [] }, skills: {}, limits: { maxToolCalls: 2 } };
    const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
    let seed: CheckpointData | undefined;
    const checkpoints = { async save(value: CheckpointData) { seed = value; }, async loadLatest() { return seed; }, async list() { return seed ? [seed] : []; } };
    const runtime = new AgentRuntime({ store, events, orchestrator, agents: [agent], checkpointStore: checkpoints,
      modelProvider: new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "c.ts", content: "must not run" }), ScriptedModelProvider.text("done")]),
      toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, toolSemanticsOf: () => semantics });
    const session = await runtime.createSession({ agent, cwd: "/budget-replay" });
    const turn = await runtime.startTurn(session.id, "fix both files");
    const budget = new RunBudgetTracker(agent.limits, () => 10); budget.onTurnStart();
    seed = buildCheckpoint({ checkpointId: newCheckpointId(), schemaVersion: 1, sessionId: session.id, turnId: turn.id,
      agentId: agent.id, createdAt: 1, reason: "before-requests", phase: "thinking", iteration: 0,
      state: newWorkingState("fix both files"), toolLedger: [], childSessions: [],
      lastEventSequence: (await events.nextSequence(session.id)) - 1,
      effectiveAgentConfigRef: "effectiveAgent", contextRefs: [], budgetUsage: { maxTokens: 0, run: budget.snapshot() } });
    for (const [index, path] of ["a.ts", "b.ts"].entries()) {
      const toolCallId = reused ? "repeat" : "call-" + index;
      await events.appendNew({ id: newEventId(), sessionId: session.id, turnId: turn.id, type: "tool.requested", timestamp: 20 + index * 2,
        payload: { toolCallId, name: "write_file", args: { path } } });
      await events.appendNew({ id: newEventId(), sessionId: session.id, turnId: turn.id, type: "tool.completed", timestamp: 21 + index * 2,
        payload: { toolCallId, status: "success" } });
    }
    await runtime.resumeTurn(session.id, new AbortController().signal);
    expect(orchestrator.calls).toHaveLength(0);
  });
});
