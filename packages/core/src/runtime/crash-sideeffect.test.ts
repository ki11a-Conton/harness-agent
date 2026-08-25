// PHASE 34-3 — Tool side-effect crash suite.
//
// P26-4 / P16-6 define crash windows across a tool's side-effect lifecycle.
// Requirement: for NON-IDEMPOTENT side effects (a file-append counter), a
// process crash in ANY window must not cause the runtime to automatically
// re-execute the tool — the reconciled outcome is "committed at most once",
// so the automatic duplicate side-effect count stays 0 on every unsafe path.
//
// The counter file is the probe: exactly (or at most) one appended line after
// crash + resume proves no automatic duplicate.

import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
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
  SessionStatus,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  ToolSemantics,
  BoundToolCallRequest,
} from "@ar/contracts";
import { buildCheckpoint, newCheckpointId, newWorkingState, DEFAULT_TOOL_SEMANTICS, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, RuntimeKilledError, type FaultPoint } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "crash-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a crash test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: { maxToolCalls: 5 },
};

/** Non-idempotent side effect: every execute of `append_file` appends one
 *  line to the counter file. Double execution shows as 2 lines. */
class CounterOrchestrator extends FakeOrchestrator {
  constructor(private readonly counterPath: string) {
    super({ status: "success", output: "ok" });
  }
  override async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const call = Array.isArray(request.call) ? request.call[0] : request.call;
    if (call?.name === "append_file") {
      await appendFile(this.counterPath, "x\n", "utf8");
    }
    return super.execute(request, context);
  }
}

class FakeCheckpointStore implements CheckpointStore {
  saved: CheckpointData[] = [];
  seed?: CheckpointData;
  async save(c: CheckpointData): Promise<void> {
    this.saved.push(c);
  }
  async loadLatest(): Promise<CheckpointData | undefined> {
    return this.saved.length > 0 ? this.saved[this.saved.length - 1] : this.seed;
  }
  async list(): Promise<CheckpointData[]> {
    return [...this.saved].reverse();
  }
}

class FilteringSessionStore extends MemorySessionStore {
  override async listSessions(opts?: { parentId?: SessionId; status?: SessionStatus }): Promise<Session[]> {
    let list = await super.listSessions();
    if (opts?.parentId !== undefined) list = list.filter((s) => s.parentId === opts.parentId);
    if (opts?.status !== undefined) list = list.filter((s) => s.status === opts.status);
    return list;
  }
}

function toolScript(toolName: string, args: Record<string, unknown>): ModelEvent[][] {
  return [ScriptedModelProvider.toolCall(toolName, args), ScriptedModelProvider.text("done")];
}

function killAt(points: ReadonlySet<FaultPoint>) {
  return (point: FaultPoint): void => {
    if (points.has(point)) throw new RuntimeKilledError(point);
  };
}

/** A "last durable checkpoint" seed: what a real process would see before the
 *  interrupted turn wrote any of its own progress. resumeTurn requires it. */
function seededCheckpoint(sessionId: SessionId, over: Partial<CheckpointData> = {}): CheckpointData {
  return buildCheckpoint({
    checkpointId: newCheckpointId(),
    schemaVersion: 1,
    sessionId,
    agentId: AGENT.id,
    createdAt: 10,
    reason: "seed",
    phase: "thinking",
    iteration: 1,
    state: newWorkingState("append"),
    toolLedger: [],
    childSessions: [],
    lastEventSequence: 0,
    effectiveAgentConfigRef: "effectiveAgent",
    contextRefs: [],
    ...over,
  } as CheckpointData);
}

interface Harness {
  runtime: AgentRuntime;
  store: FilteringSessionStore;
  events: MemoryEventStore;
  ckpt: FakeCheckpointStore;
  orch: CounterOrchestrator;
  counterPath: string;
  cwd: string;
}

let tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

async function makeHarness(opts: { kill?: ReadonlySet<FaultPoint>; scripts?: ModelEvent[][] } = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "p34-3-"));
  tempDirs.push(cwd);
  const counterPath = join(cwd, "counter.txt");
  const store = new FilteringSessionStore();
  const events = new MemoryEventStore();
  const ckpt = new FakeCheckpointStore();
  const orch = new CounterOrchestrator(counterPath);
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
    orchestrator: orch,
    agents: [AGENT],
    checkpointStore: ckpt,
    checkpointPolicy: {
      afterSideEffectTools: true,
      afterCompaction: true,
      afterVerification: true,
      everyNIterations: 0,
    },
    toolSemanticsOf: (name) =>
      name === "append_file"
        ? { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" }
        : DEFAULT_TOOL_SEMANTICS,
    ...(opts.kill !== undefined ? { failpoint: killAt(opts.kill) } : {}),
  });
  return { runtime, store, events, ckpt, orch, counterPath, cwd };
}

async function runUntilKilled(
  runtime: AgentRuntime,
  session: Session,
  point: FaultPoint,
): Promise<{ turnId: string; lastEventSequence: number }> {
  const turn = await runtime.startTurn(session.id, "append");
  await expect(runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
    name: "RuntimeKilledError",
    point,
  });
  return { turnId: turn.id, lastEventSequence: 0 };
}

/** Fresh "process" over the same durable stores. */
function restartedRuntime(h: Harness): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store: h.store,
    events: h.events,
    modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]),
    orchestrator: h.orch,
    agents: [AGENT],
    checkpointStore: h.ckpt,
    checkpointPolicy: {
      afterSideEffectTools: true,
      afterCompaction: true,
      afterVerification: true,
      everyNIterations: 0,
    },
    toolSemanticsOf: (name) =>
      name === "append_file"
        ? { ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "filesystem" }
        : DEFAULT_TOOL_SEMANTICS,
  });
}

async function countLines(path: string): Promise<number> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

describe("P34-3 side-effect crash suite (non-idempotent counter)", () => {
  it("3.1 kill at tool.completed (effect committed, checkpoint pending) — no automatic re-run", async () => {
    const h = await makeHarness({
      kill: new Set(["tool.completed"]),
      scripts: toolScript("append_file", { path: "counter" }),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId, lastEventSequence } = await runUntilKilled(h.runtime, session, "tool.completed");
    expect(await countLines(h.counterPath)).toBe(1); // committed exactly once
    // seed the last durable checkpoint BEFORE the interrupted turn
    h.ckpt.seed = seededCheckpoint(session.id, { lastEventSequence, turnId: turnId as never });
    const r2 = restartedRuntime(h);
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");
    expect(await countLines(h.counterPath)).toBe(1); // NO automatic re-run
  });

  it("3.2 kill at tool.checkpointed (effect + checkpoint persisted) — no duplicate", async () => {
    const h = await makeHarness({
      kill: new Set(["tool.checkpointed"]),
      scripts: toolScript("append_file", { path: "counter" }),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    await runUntilKilled(h.runtime, session, "tool.checkpointed");
    expect(await countLines(h.counterPath)).toBe(1);
    const r2 = restartedRuntime(h);
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");
    expect(await countLines(h.counterPath)).toBe(1);
  });

  it("3.3 kill at tool.effect_committed (P26-8 window) — no duplicate", async () => {
    const h = await makeHarness({
      kill: new Set(["tool.effect_committed"]),
      scripts: toolScript("append_file", { path: "counter" }),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId, lastEventSequence } = await runUntilKilled(h.runtime, session, "tool.effect_committed");
    expect(await countLines(h.counterPath)).toBe(1);
    h.ckpt.seed = seededCheckpoint(session.id, { lastEventSequence, turnId: turnId as never });
    const r2 = restartedRuntime(h);
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");
    expect(await countLines(h.counterPath)).toBe(1);
  });

  it("3.4 kill after tool.intent_persisted (P16-6: intent durable, executor not run) — never a blind duplicate", async () => {
    // This window is modeled by an orchestrator that writes the durable
    // intent and then dies BEFORE the executor runs — resume must reconcile
    // "may have run" without blindly re-running the non-idempotent append.
    const h = await makeHarness({
      kill: new Set(["tool.executing"]),
      scripts: toolScript("append_file", { path: "counter" }),
    });
    // note: tool.executing is the runtime-injected sub-executor boundary. The
    // durable intent was persisted by design (P16-1); the executor outcome is
    // unknown, so resume must reconcile without a blind duplicate append.
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId, lastEventSequence } = await runUntilKilled(h.runtime, session, "tool.executing");
    void turnId;
    expect(await countLines(h.counterPath)).toBeLessThanOrEqual(1);
    h.ckpt.seed = seededCheckpoint(session.id, { lastEventSequence });
    const r2 = restartedRuntime(h);
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");
    expect(await countLines(h.counterPath)).toBeLessThanOrEqual(1);
  });

  it("3.5 no-crash baseline — a single clean turn appends exactly one line", async () => {
    const h = await makeHarness({ scripts: toolScript("append_file", { path: "counter" }) });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "append");
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(await countLines(h.counterPath)).toBe(1);
  });
});