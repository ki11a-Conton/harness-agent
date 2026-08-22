import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  CheckpointData,
  CheckpointStore,
  ModelEvent,
  Session,
  SessionId,
  SessionStatus,
  WorkingState,
} from "@ar/contracts";
import {
  buildCheckpoint,
  DEFAULT_TOOL_SEMANTICS,
  newAgentId,
  newCheckpointId,
  newEventId,
  newSessionId,
  newTurnId,
  newWorkingState,
} from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, buildResumePrompt, classifyUnknownOutcome } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "test-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

class FakeCheckpointStore implements CheckpointStore {
  saved: CheckpointData[] = [];
  seed?: CheckpointData;

  async save(checkpoint: CheckpointData): Promise<void> {
    this.saved.push(checkpoint);
  }

  async loadLatest(): Promise<CheckpointData | undefined> {
    return this.seed;
  }

  async list(): Promise<CheckpointData[]> {
    return [...this.saved].reverse();
  }
}

class FilteringSessionStore extends MemorySessionStore {
  override async listSessions(opts?: {
    parentId?: SessionId;
    status?: SessionStatus;
  }): Promise<Session[]> {
    let list = await super.listSessions();
    if (opts?.parentId !== undefined) list = list.filter((s) => s.parentId === opts.parentId);
    if (opts?.status !== undefined) list = list.filter((s) => s.status === opts.status);
    return list;
  }
}

function seededCheckpoint(sessionId: SessionId, over: Partial<CheckpointData> = {}): CheckpointData {
  return buildCheckpoint({
    checkpointId: newCheckpointId(),
    schemaVersion: 1 as const,
    sessionId,
    agentId: AGENT.id as never,
    createdAt: 10,
    reason: "tool:completed:write_file",
    phase: "thinking",
    iteration: 1,
    state: newWorkingState("goal"),
    toolLedger: [],
    childSessions: [],
    lastEventSequence: 0,
    effectiveAgentConfigRef: "effectiveAgent",
    contextRefs: [],
    ...over,
  });
}

async function makeRuntime(
  scripts: ModelEvent[][] = [ScriptedModelProvider.text("done")],
): Promise<{
  runtime: AgentRuntime;
  store: FilteringSessionStore;
  events: MemoryEventStore;
  ckpt: FakeCheckpointStore;
}> {
  const provider = new ScriptedModelProvider(scripts);
  const store = new FilteringSessionStore();
  const events = new MemoryEventStore();
  const ckpt = new FakeCheckpointStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
    agents: [AGENT],
    checkpointStore: ckpt,
    checkpointPolicy: {
      afterSideEffectTools: false,
      afterCompaction: false,
      afterVerification: false,
      everyNIterations: 0,
    },
  });
  return { runtime, store, events, ckpt };
}

function requestedEvent(sessionId: SessionId, toolCallId: string, name: string, args: Record<string, unknown>, timestamp = 7): AgentEvent {
  return {
    id: newEventId(),
    sessionId,
    turnId: newTurnId(),
    sequence: 0 as never,
    timestamp,
    type: "tool.requested",
    payload: { toolCallId, name, args },
  };
}

describe("AgentRuntime resume (P1-4)", () => {
  it("resumes from a durable checkpoint into a fresh turn seeded with the restored working state", async () => {
    const { runtime, events, ckpt } = await makeRuntime();
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });

    const lastEventSequence = (await events.nextSequence(session.id)) - 1;
    const state = newWorkingState("fix the build");
    state.completed.push("added config");
    state.filesChanged.push("config.yaml");
    ckpt.seed = seededCheckpoint(session.id, {
      lastEventSequence,
      state,
    });

    const result = await runtime.resumeTurn(session.id, new AbortController().signal);

    expect(result.checkpointId).toBe(ckpt.seed!.checkpointId);
    expect(result.state.goal).toBe("fix the build");
    expect(result.state.filesChanged).toEqual(["config.yaml"]);
    expect(result.state.completed).toContain("added config");
    expect(result.outcome.status).toBe("completed");
    expect(result.replayedEventCount).toBe(0);
    expect(result.committedSideEffects).toEqual([]);
    expect(result.unresolvedTools).toEqual([]);

    const stored = await events.list(session.id);
    expect(stored.map((e) => e.type)).toContain("session.resumed");
    const resumed = stored.find((e) => e.type === "session.resumed")!;
    expect(resumed.payload.resumedTurnId).toBe(result.outcome.turn.id);
  });

  it("marks post-checkpoint completed side effects as committed (never redo) and folds them into the restored state", async () => {
    const { runtime, store, events, ckpt } = await makeRuntime();
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const lastEventSequence = (await events.nextSequence(session.id)) - 1;

    const interruptedTurn = newTurnId();
    await events.append(requestedEvent(session.id, "toolcall_w", "write_file", { path: "CHANGELOG.md", content: "x" }));
    await store.appendMessage({
      id: "message_m" as never,
      sessionId: session.id,
      turnId: interruptedTurn,
      role: "tool",
      toolCallId: "toolcall_w" as never,
      content: "wrote CHANGELOG.md",
      createdAt: 7,
    });
    ckpt.seed = seededCheckpoint(session.id, {
      lastEventSequence,
      turnId: interruptedTurn,
    });

    const result = await runtime.resumeTurn(session.id, new AbortController().signal);

    expect(result.replayedEventCount).toBe(1);
    expect(result.committedSideEffects).toHaveLength(1);
    expect(result.committedSideEffects[0]!.tool).toBe("write_file");
    expect(result.committedSideEffects[0]!.sideEffect).toBe(true);
    expect(result.unresolvedTools).toEqual([]);
    expect(result.state.filesChanged).toContain("CHANGELOG.md");
    expect(result.state.completed).toContain("modified CHANGELOG.md");

    const prompt = buildResumePrompt(result.state, result.committedSideEffects, result.unresolvedTools);
    expect(prompt).toContain("do NOT redo");
    expect(prompt).toContain("CHANGELOG.md");
  });

  it("surfaces started-but-unconfirmed tools as unresolved reconciliation (never auto-redo)", async () => {
    const { runtime, events, ckpt } = await makeRuntime();
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const lastEventSequence = (await events.nextSequence(session.id)) - 1;

    await events.append(requestedEvent(session.id, "toolcall_ex", "exec", { command: "npm publish" }));
    ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });

    const result = await runtime.resumeTurn(session.id, new AbortController().signal);

    expect(result.unresolvedTools).toHaveLength(1);
    expect(result.unresolvedTools[0]!.tool).toBe("exec");
    expect(result.unresolvedTools[0]!.sideEffect).toBe(true);
    expect(result.committedSideEffects).toEqual([]);
    // The exec was never re-executed: the resumed turn ran only the text script.
    expect(result.state.commandsRun).toEqual([]);

    // P2-40: the unresolved tool surfaces as a reconciliation retry-kind event.
    const trail = await events.list(session.id);
    const reconciliations = trail.filter((e) => e.type === "retry.reconciliation");
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]!.payload).toMatchObject({
      toolCallId: "toolcall_ex",
      tool: "exec",
      sideEffect: true,
    });

    const prompt = buildResumePrompt(result.state, result.committedSideEffects, result.unresolvedTools);
    expect(prompt).toContain("Unresolved tool executions");
    expect(prompt).toContain("reconcile");
    expect(prompt).toContain("may have side effect");
  });

  it("refuses to resume without a durable checkpoint (RESUME_FAILED)", async () => {
    const { runtime } = await makeRuntime();
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });

    await expect(runtime.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
      info: expect.objectContaining({ code: "RESUME_FAILED" }),
    });
  });

  it("refuses to resume when the runtime has no checkpoint store at all", async () => {
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]),
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [AGENT],
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });

    await expect(runtime.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
      info: expect.objectContaining({ code: "RESUME_FAILED" }),
    });
  });

  it("resume prompt carries working state, committed side effects and unresolved tools and omits the transcript", () => {
    const state = newWorkingState("goal here");
    state.pending.push("verify");
    state.importantFacts.push("fact");

    const committed: CheckpointData["toolLedger"] = [
      { toolCallId: "toolcall_1" as never, tool: "write_file", argsHash: "a", started: 1, completed: 2, status: "success", sideEffect: true },
    ];
    const unresolved: import("@ar/contracts").UnresolvedToolExecution[] = [
      { toolCallId: "toolcall_2" as never, tool: "exec", argsHash: "b", started: 3, sideEffect: true, sideEffectScope: "process" },
    ];

    const prompt = buildResumePrompt(state, committed, unresolved);

    expect(prompt).toContain("goal here");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("fact");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("exec");
    expect(prompt).toContain("do NOT redo");
    expect(prompt).toContain("reconcile");
    expect(prompt).not.toContain("[user]");
  });
});
describe("P16-2: unknown-outcome reconciliation verdicts", () => {
  const sem = (over: Partial<import("@ar/contracts").ToolSemantics>) =>
    ({ ...DEFAULT_TOOL_SEMANTICS, ...over });

  it("read-only and idempotent tools are safe_retry", () => {
    expect(classifyUnknownOutcome("read_file", sem({ readOnly: true, sideEffectScope: "none" })).decision)
      .toBe("safe_retry");
    expect(classifyUnknownOutcome("apply_patch", sem({ idempotent: true, sideEffectScope: "filesystem" })).decision)
      .toBe("safe_retry");
  });

  it("filesystem writes are needs_verification (with or without evidence)", () => {
    const noEvidence = classifyUnknownOutcome("write_file", sem({ sideEffectScope: "filesystem" }));
    expect(noEvidence.decision).toBe("needs_verification");
    expect(noEvidence.reason).toContain("target state");
    const withEvidence = classifyUnknownOutcome("write_file", sem({ sideEffectScope: "filesystem" }), "hash=abc123");
    expect(withEvidence.decision).toBe("needs_verification");
    if ("evidence" in withEvidence) expect(withEvidence.evidence).toBe("hash=abc123");
  });

  it("process/network/global/unknown are never_auto (never blindly re-run)", () => {
    for (const scope of ["process", "network", "global", "unknown"] as const) {
      const verdict = classifyUnknownOutcome("exec", sem({ sideEffectScope: scope }));
      expect(verdict.decision).toBe("never_auto");
    }
  });

  it("buildResumePrompt renders per-tool verdicts", () => {
    const state = newWorkingState("g");
    const committed: CheckpointData["toolLedger"] = [];
    const unresolved: import("@ar/contracts").UnresolvedToolExecution[] = [
      { toolCallId: "c1" as never, tool: "write_file", argsHash: "a", started: 1, sideEffect: true, sideEffectScope: "filesystem" },
      { toolCallId: "c2" as never, tool: "exec", argsHash: "b", started: 2, sideEffect: true, sideEffectScope: "process" },
    ];
    const verdicts: import("@ar/core").ReconciliationVerdict[] = [
      { decision: "needs_verification", reason: "verify target state" },
      { decision: "never_auto", reason: "never auto-re-run" },
    ];
    const prompt = buildResumePrompt(state, committed, unresolved, verdicts);
    expect(prompt).toContain("[needs_verification] verify target state");
    expect(prompt).toContain("[never_auto] never auto-re-run");
  });
});

describe("P16-3: run/recovery budgets persist across checkpoint/resume", () => {
  const budgetedAgent: AgentDefinition = {
    ...AGENT,
    limits: { maxToolCalls: 2 },
  };

  it("periodic checkpoint carries the FULL run-budget snapshot (tool call counter etc.)", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
      ScriptedModelProvider.text("done"),
    ]);
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const ckpt = new FakeCheckpointStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [budgetedAgent],
      checkpointStore: ckpt,
      checkpointPolicy: {
        afterSideEffectTools: false,
        afterCompaction: false,
        afterVerification: false,
        everyNIterations: 1,
      },
    });
    const session = await runtime.createSession({ agent: budgetedAgent, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "go");
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(ckpt.saved.length).toBeGreaterThan(0);
    const bu = ckpt.saved[ckpt.saved.length - 1]!.budgetUsage;
    expect(bu).toBeDefined();
    // P16-3: the checkpoint carries the consumed counters — never refreshed.
    expect(bu!.run?.usedToolCalls).toBeGreaterThanOrEqual(1);
    expect(bu!.run?.usedTurns).toBeGreaterThanOrEqual(1);
    expect(bu!.recoveryUsage).toBeDefined();
    expect(bu!.verificationRetries).toBeTypeOf("number");
    expect(bu!.stallRecoveryCount).toBeTypeOf("number");
  });

  it("resume SEEDS the consumed budget — maxToolCalls is NOT refreshed", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
    ]);
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const ckpt = new FakeCheckpointStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [budgetedAgent],
      checkpointStore: ckpt,
      checkpointPolicy: {},
    });
    const session = await runtime.createSession({ agent: budgetedAgent, cwd: "C:\\work" });

    // The checkpoint says 2/2 tool calls were already consumed before the crash.
    ckpt.seed = seededCheckpoint(session.id, {
      budgetUsage: {
        maxTokens: 0,
        run: {
          runId: "" as never,
          limits: { maxToolCalls: 2 },
          usedTurns: 1,
          usedToolCalls: 2,
          startedAt: 1,
          durationMs: 1,
          outputChars: 0,
          retries: 0,
          subagentsSpawned: 0,
          estimatedCostUsd: 0,
        },
        recoveryUsage: { change_strategy: 2 },
      },
    });

    // Resume: the FIRST tool call must already breach maxToolCalls=2 (the
    // budget was seeded from the checkpoint, not refreshed to 0).
    const result = await runtime.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.error?.code).toBe("RESOURCE_LIMIT");
    // and the reconciliation prompt surfaced the seeded state
    expect(result.unresolvedTools).toBeDefined();
  });
});

describe("P17-6: buildStateDigest renders every protected field (integration)", () => {
  it("a rich working state survives into the digest with zero missing fields", async () => {
    const { buildStateDigest } = await import("./turn-helpers.js");
    const { protectedFieldsMissing } = await import("@ar/context");
    const working = newWorkingState("fix the release pipeline");
    working.constraints.push("must not use sudo");
    working.decisions.push("use pnpm workspaces");
    working.pending.push("run e2e");
    working.filesChanged.push("src/main.ts");
    working.commandsRun.push("pnpm build");
    working.testsRun.push("pnpm test");
    working.failures.push("verify step failed: e2e timeout");
    working.memoryRefs.push("mem-1");
    working.childAgentRefs.push("child-s1");
    working.toolRefs.push("write_file#c1");

    const digest = buildStateDigest(working, "compact");
    const missing = protectedFieldsMissing(
      {
        goal: working.goal,
        constraints: working.constraints,
        pending: working.pending,
        decisions: working.decisions,
        filesChanged: working.filesChanged,
        commandsRun: working.commandsRun,
        testsRun: working.testsRun,
        failures: working.failures,
        unresolvedTools: working.toolRefs,
        memoryRefs: working.memoryRefs,
        skillRefs: working.toolRefs,
        childAgentRefs: working.childAgentRefs,
      },
      digest,
      {
        unresolvedTools: working.toolRefs,
        memoryRefs: working.memoryRefs,
        skillRefs: working.toolRefs,
        childAgentRefs: working.childAgentRefs,
      },
    );
    expect(missing).toEqual([]);
  });
});
