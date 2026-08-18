import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDefinition,
  CheckpointData,
  CheckpointStore,
  ModelEvent,
  Session,
  SessionId,
  SessionStatus,
} from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { ContextPipeline } from "@ar/context";

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

/** In-memory CheckpointStore: collects saved checkpoints and can fail on save. */
class FakeCheckpointStore implements CheckpointStore {
  saved: CheckpointData[] = [];
  fail?: Error;

  async save(checkpoint: CheckpointData): Promise<void> {
    if (this.fail !== undefined) throw this.fail;
    this.saved.push(checkpoint);
  }

  async loadLatest(): Promise<CheckpointData | undefined> {
    return undefined;
  }

  async list(): Promise<CheckpointData[]> {
    return [...this.saved].reverse();
  }
}

/** MemorySessionStore with real parentId/status filtering (the plain fake
 *  ignores listSessions opts). */
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

async function makeHarness(
  scripts: ModelEvent[][],
  opts: {
    checkpointStore?: FakeCheckpointStore;
    checkpointPolicy?: Record<string, unknown>;
    withContext?: boolean;
  } = {},
): Promise<{
  runtime: AgentRuntime;
  store: FilteringSessionStore;
  events: MemoryEventStore;
  ckpt: FakeCheckpointStore;
  session: Session;
}> {
  const provider = new ScriptedModelProvider(scripts);
  const orch = new FakeOrchestrator({ status: "success", output: "ok" });
  const store = new FilteringSessionStore();
  const events = new MemoryEventStore();
  const ckpt = opts.checkpointStore ?? new FakeCheckpointStore();
  const cwd = opts.withContext ? await mkdtemp(join(tmpdir(), "rt-ckpt-")) : "C:\\work";

  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: orch,
    agents: [AGENT],
    checkpointStore: ckpt,
    ...(opts.checkpointPolicy !== undefined
      ? { checkpointPolicy: opts.checkpointPolicy }
      : {}),
    ...(opts.withContext
      ? {
          context: {
            pipeline: new ContextPipeline(),
            budget: { maxTokens: 50_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
          },
        }
      : {}),
  });
  const parent = await runtime.createSession({ agent: AGENT, cwd });
  const session = await runtime.createSession({ agent: AGENT, cwd, parentId: parent.id });
  return { runtime, store, events, ckpt, session };
}

async function runTurn(runtime: AgentRuntime, session: Session) {
  const turn = await runtime.startTurn(session.id, "build and verify");
  return runtime.runTurn(session.id, turn.id, new AbortController().signal);
}

/** One tool round-trip followed by one text round-trip: two dedicated scripts
 *  (a single concat array would be consumed inside one generate call). */
function contractScript(
  toolName: string,
  args: Record<string, unknown>,
): ModelEvent[][] {
  return [ScriptedModelProvider.toolCall(toolName, args), ScriptedModelProvider.text("done")];
}

describe("AgentRuntime checkpointing (P1-3)", () => {
  it("persists a checkpoint after a successful side-effect tool with the working state", async () => {
    const { runtime, session, ckpt, events } = await makeHarness(
      contractScript("write_file", { path: "src/a.ts", content: "x" }),
    );

    const outcome = await runTurn(runtime, session);
    expect(outcome.status).toBe("completed");

    expect(ckpt.saved.length).toBe(1);
    const saved = ckpt.saved[0]!;
    expect(saved.reason).toBe("tool:completed:write_file");
    expect(saved.sessionId).toBe(session.id);
    expect(saved.state.goal).toBe("build and verify");
    expect(saved.state.filesChanged).toEqual(["src/a.ts"]);
    expect(saved.toolLedger).toHaveLength(1);
    expect(saved.toolLedger[0]!.tool).toBe("write_file");
    expect(saved.toolLedger[0]!.status).toBe("success");
    expect(saved.toolLedger[0]!.sideEffect).toBe(true);
    expect(saved.toolLedger[0]!.argsHash).toBeTruthy();
    expect(saved.iteration).toBe(1);

    const stored = await events.list(session.id);
    expect(stored.map((e) => e.type)).toContain("checkpoint.created");
  });

  it("does not checkpoint for non-side-effect tools (echo)", async () => {
    const { runtime, session, ckpt } = await makeHarness(
      contractScript("echo", { text: "hi" }),
    );

    await runTurn(runtime, session);
    expect(ckpt.saved).toHaveLength(0);
  });

  it("a checkpoint failure is observable (checkpoint.failed) and does not derail the turn", async () => {
    const ckpt = new FakeCheckpointStore();
    ckpt.fail = new Error("disk full");
    const { runtime, session, events } = await makeHarness(
      contractScript("write_file", { path: "src/a.ts", content: "x" }),
      { checkpointStore: ckpt },
    );

    const outcome = await runTurn(runtime, session);
    expect(outcome.status).toBe("completed");
    expect(ckpt.saved).toHaveLength(0);
    const stored = await events.list(session.id);
    expect(stored.map((e) => e.type)).toContain("checkpoint.failed");
    expect(stored.filter((e) => e.type === "checkpoint.failed")[0]?.payload.error).toContain("disk full");
  });

  it("takes periodic checkpoints every N iterations when configured", async () => {
    const { runtime, session, ckpt } = await makeHarness([
      ...Array.from({ length: 4 }, (_, i) => ScriptedModelProvider.toolCall("read_file", { path: `f${i}` })),
      ScriptedModelProvider.text("done"),
    ], {
      checkpointPolicy: {
        afterSideEffectTools: false,
        afterCompaction: false,
        afterVerification: false,
        everyNIterations: 2,
      },
    });

    const outcome = await runTurn(runtime, session);
    expect(outcome.status).toBe("completed");
    const reasons = ckpt.saved.map((c) => c.reason);
    expect(reasons.filter((r) => r === "periodic:iteration")).toHaveLength(2);
    expect(reasons).toEqual(["periodic:iteration", "periodic:iteration"]);
    expect(ckpt.saved[0]!.iteration).toBe(2);
    expect(ckpt.saved[1]!.iteration).toBe(4);
  });

  it("carries child sessions, budget usage, config ref and last event sequence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rt-ckpt-cfg-"));
    try {
      const provider = new ScriptedModelProvider(
        contractScript("write_file", { path: "src/a.ts", content: "x" }),
      );
      const orch = new FakeOrchestrator({ status: "success", output: "ok" });
      const store = new FilteringSessionStore();
      const events = new MemoryEventStore();
      const ckpt = new FakeCheckpointStore();
      const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: provider,
        orchestrator: orch,
        agents: [AGENT],
        checkpointStore: ckpt,
        context: {
          pipeline: new ContextPipeline(),
          budget: { maxTokens: 50_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
        },
      });
      const session = await runtime.createSession({ agent: AGENT, cwd });
      // The child must already exist before the parent's turn checkpoints.
      const child = await runtime.createSession({ agent: AGENT, cwd, parentId: session.id });

      await runTurn(runtime, session);

      const saved = ckpt.saved[0]!;
      expect(saved.phase).toBe("thinking"); // the loop has returned to thinking after the tool round-trip
      expect(saved.childSessions).toEqual([child.id]);
      expect(saved.budgetUsage).toMatchObject({ maxTokens: 50_000 });
      expect(saved.budgetUsage!.usedTokens).toBeGreaterThan(0);
      expect(saved.effectiveAgentConfigRef).toBe("effectiveAgent");
      expect(saved.lastEventSequence).toBeGreaterThan(0);
      expect(saved.turnId).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("without a checkpoint store no checkpoint events are emitted", async () => {
    const provider = new ScriptedModelProvider(contractScript("write_file", { path: "src/a.ts", content: "x" }));
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [AGENT],
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });

    await runTurn(runtime, session);
    const stored = await events.list(session.id);
    expect(stored.map((e) => e.type)).not.toEqual(expect.arrayContaining(["checkpoint.created", "checkpoint.failed"]));
  });
});