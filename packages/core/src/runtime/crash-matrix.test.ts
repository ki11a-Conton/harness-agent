// P26-8 — crash matrix: every crash window around a NON-IDEMPOTENT
// side-effecting tool must never cause an automatic duplicate side effect.
// Inject a kill at each of the 9 plan points, resume from the durable
// stores, and assert the side-effect counter never over-ran.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  CheckpointData,
  CheckpointStore,
  ModelEvent,
  Session,
  SessionId,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
} from "@ar/contracts";
import { buildCheckpoint, newAgentId, newCheckpointId, newWorkingState } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, RuntimeKilledError, type FaultPoint } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "crash-matrix-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a crash-matrix test",
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
    if (this.saved.length > 0) return this.saved[this.saved.length - 1];
    return this.seed;
  }
  async list(): Promise<CheckpointData[]> {
    return [...this.saved].reverse();
  }
}

/** NON-IDEMPOTENT write tool: every execution increments a counter — the
 *  duplicate-side-effect detector for the whole matrix. */
class WriteCountingOrchestrator extends FakeOrchestrator {
  writeCount = 0;
  override async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (request.call.name === "write_file") this.writeCount += 1;
    return super.execute(request, context);
  }
}

function killAt(points: ReadonlySet<FaultPoint>) {
  return (point: FaultPoint): void => {
    if (points.has(point)) throw new RuntimeKilledError(point);
  };
}

let cwd: string;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function makeRuntime(opts: {
  scripts?: ModelEvent[][];
  kill?: ReadonlySet<FaultPoint>;
  orch?: WriteCountingOrchestrator;
  checkpoint?: FakeCheckpointStore;
} = {}) {
  cwd = await mkdtemp(join(tmpdir(), "cm-"));
  tempDirs.push(cwd);
  const orch = opts.orch ?? new WriteCountingOrchestrator({ status: "success", output: "ok" });
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const ckpt = opts.checkpoint ?? new FakeCheckpointStore();
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
    orchestrator: orch,
    agents: [AGENT],
    checkpointStore: ckpt,
    checkpointPolicy: { afterSideEffectTools: true, afterCompaction: true, afterVerification: true, everyNIterations: 0 },
    ...(opts.kill !== undefined ? { failpoint: killAt(opts.kill) } : {}),
  });
  return { runtime, store, events, ckpt, orch };
}

function seededCheckpoint(sessionId: SessionId): CheckpointData {
  return buildCheckpoint({
    checkpointId: newCheckpointId(),
    schemaVersion: 1 as const,
    sessionId,
    agentId: AGENT.id as never,
    createdAt: 10,
    reason: "seed",
    phase: "thinking",
    iteration: 1,
    state: newWorkingState("fix the build"),
    toolLedger: [],
    childSessions: [],
    lastEventSequence: 0,
    effectiveAgentConfigRef: "effectiveAgent",
    contextRefs: [],
  });
}

function toolScript(): ModelEvent[][] {
  return [ScriptedModelProvider.toolCall("write_file", { path: "a.txt", text: "x" }), ScriptedModelProvider.text("done")];
}

async function runUntilKilled(runtime: AgentRuntime, session: Session, point: FaultPoint): Promise<void> {
  const turn = await runtime.startTurn(session.id, "fix the build");
  await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
    name: "RuntimeKilledError",
    point,
  });
}

function restartedRuntime(opts: {
  store: MemorySessionStore;
  events: MemoryEventStore;
  ckpt: FakeCheckpointStore;
  orch: WriteCountingOrchestrator;
  scripts?: ModelEvent[][];
}): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store: opts.store,
    events: opts.events,
    modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
    orchestrator: opts.orch,
    agents: [AGENT],
    checkpointStore: opts.ckpt,
    checkpointPolicy: { afterSideEffectTools: false, afterCompaction: false, afterVerification: false, everyNIterations: 0 },
  });
}

/** Resume and assert: the turn completes and the non-idempotent write was
 *  NEVER executed again automatically beyond `expectedWrites`. */
async function resumeAndAssert(
  runtime: AgentRuntime,
  session: Session,
  orch: WriteCountingOrchestrator,
  expectedWrites: number,
): Promise<void> {
  const result = await runtime.resumeTurn(session.id, new AbortController().signal);
  expect(result.outcome.status).toBe("completed");
  expect(orch.writeCount).toBe(expectedWrites);
}

describe("P26-8: crash matrix — no automatic duplicate side effect (non-idempotent write)", () => {
  it("1. before intent: nothing on record → the write runs once (first execution, not a duplicate)", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["tool.intent_persisting"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "tool.intent_persisting");
    expect(orch.writeCount).toBe(0);

    const r2 = restartedRuntime({ store, events, ckpt, orch, scripts: toolScript() });
    await resumeAndAssert(r2, session, orch, 1);
  });

  it("2. after intent, before execute: unknown-outcome reconciliation — NEVER re-executed", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({ scripts: toolScript() });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    // Intent-orchestrator: gates pass, intent persisted, kill BEFORE executor.
    let executed = 0;
    const intentOrch = {
      async execute(
        request: ToolCallRequest,
        _ctx: ToolExecutionContext,
      ): Promise<ToolResult> {
        return this.executeBound({ ...request, binding: { name: request.call.name } as never } as never, _ctx);
      },
      async executeBound(
        _request: ToolCallRequest,
        _ctx: ToolExecutionContext,
      ): Promise<ToolResult> {
        if (executed === 0) throw new RuntimeKilledError("tool.intent_persisted");
        executed += 1;
        return { status: "success", output: "ok" };
      },
    };
    const rKill = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events,
      modelProvider: new ScriptedModelProvider(toolScript()),
      orchestrator: intentOrch as never,
      agents: [AGENT],
      checkpointStore: ckpt,
      checkpointPolicy: { afterSideEffectTools: true, afterCompaction: true, afterVerification: true, everyNIterations: 0 },
    });
    const turn = await rKill.startTurn(session.id, "fix the build");
    await expect(rKill.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
      name: "RuntimeKilledError",
      point: "tool.intent_persisted",
    });
    expect(orch.writeCount).toBe(0);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 0);
  });

  it("3. after execution start: UNKNOWN EFFECT — reconciled, never re-executed", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["tool.executing"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "tool.executing");
    expect(orch.writeCount).toBe(0);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 0);
  });

  it("4. after effect committed, before outcome write: committed effect, never re-executed", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["tool.effect_committed"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "tool.effect_committed");
    expect(orch.writeCount).toBe(1); // the executor DID commit the write

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 1); // ...and it must stay 1
  });

  it("5/6. after outcome write / before checkpoint: committed outcome, checkpoint forwards", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["tool.completed"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "tool.completed");
    expect(orch.writeCount).toBe(1);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 1);
  });

  it("7. after checkpoint: resume from checkpoint, no re-execution", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["tool.checkpointed"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "tool.checkpointed");
    expect(orch.writeCount).toBe(1);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 1);
  });

  it("8. before turn completion: terminal record not written, committed work resumes", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["turn.completing"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "turn.completing");
    expect(orch.writeCount).toBe(1);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    await resumeAndAssert(r2, session, orch, 1);
  });

  it("9. after terminal event, before response: terminal already durable, no re-run", async () => {
    const { runtime, store, events, ckpt, orch } = await makeRuntime({
      scripts: toolScript(),
      kill: new Set(["turn.completed_acked"] as FaultPoint[]),
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    ckpt.seed = seededCheckpoint(session.id);
    await runUntilKilled(runtime, session, "turn.completed_acked");
    expect(orch.writeCount).toBe(1);

    const r2 = restartedRuntime({ store, events, ckpt, orch });
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");
    expect(orch.writeCount).toBe(1);
  });
});
