import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newPromptId, newToolCallId } from "@ar/contracts";
import type { CheckpointData, ModelEvent, ModelProvider, ModelRequest, RunLimits, Session, Turn } from "@ar/contracts";
import { RuntimeKilledError } from "@ar/core";
import type { DefaultSessionActor, FaultPoint, FaultPointContext, TurnOutcome } from "@ar/core";
import { createHarness, type Harness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

const roots: string[] = [];
let clock = 1000;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "ar-longrun-durable-")); roots.push(cwd); return cwd;
}

function stop(text: string, cost = 0.2): ModelEvent[] {
  return [{ type: "text_delta", text, timestamp: 1000 }, { type: "completed", result: { finishReason: "stop", text,
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: cost } }, timestamp: 1000 }];
}

function call(name: string, args: Record<string, unknown>, cost = 0.1): ModelEvent[] {
  return [{ type: "completed", result: { finishReason: "tool_calls", toolCalls: [{ id: newToolCallId(), name, args }],
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: cost } }, timestamp: 1000 }];
}

// The provider's enumerable configuration is stable across the reopen. Scripts
// and observations are closure state, just as a local model transport would be.
function provider(scripts: ModelEvent[][], requests: ModelRequest[]): ModelProvider {
  let index = 0;
  return { id: "longrun-durable-script", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(structuredClone(request));
      const script = scripts[index++];
      if (script === undefined) throw new Error("unexpected model call after the durable budget was exhausted");
      yield* script;
    },
  }) };
}

function config(cwd: string, dataStore: "jsonl" | "sqlite", modelProvider: ModelProvider, limits: Partial<RunLimits>, verify = false): HarnessConfig {
  return { cwd, dataDir: join(cwd, "state"), dataStore, profile: "test", now: () => ++clock,
    modelProvider, model: { providerId: modelProvider.id, modelId: "scripted-model" },
    featureFlags: { skills: false }, limits, maxIterationsPerTurn: 15,
    contextBudget: { maxTokens: 64000, reserved: { system: 512, task: 512, output: 1024 }, dynamic: 0 },
    ...(verify ? { task: { id: "durable-verification", goal: "pass the real project check",
      verification: [{ kind: "command" as const, command: process.execPath, args: ["check.cjs"] }] } } : {}),
  };
}

function injectCrash(harness: Harness, hook: (point: FaultPoint, ctx: FaultPointContext) => void | Promise<void>) {
  // Exercise the runtime's existing fault hook without adding a host option.
  (harness.runtime as unknown as { failpoint: typeof hook }).failpoint = hook;
}

async function promotedTurn(harness: Harness): Promise<{ session: Session; turn: Turn }> {
  const agent = harness.agents[0]!;
  const session = await harness.sessionService.create({ agentId: agent.id, model: agent.model, cwd: harness.config.cwd });
  const text = "Continue the original task using its durable state and budgets.";
  const promptId = newPromptId();
  await harness.inbox.admit({ id: promptId, sessionId: session.id, text, kind: "followup", status: "pending", admittedAt: 1000 });
  await harness.inbox.markPromoted(promptId);
  const turn = await harness.runtime.startTurn(session.id, text);
  await harness.inbox.bindPromotion(promptId, turn.id);
  return { session, turn };
}

async function recoverWithActor(harness: Harness, session: Session, turn: Turn): Promise<TurnOutcome> {
  let outcome: TurnOutcome | undefined;
  const original = harness.runtime.runTurn.bind(harness.runtime);
  const run = vi.spyOn(harness.runtime, "runTurn").mockImplementation(async (...args) => {
    outcome = await original(...args); return outcome;
  });
  try {
    const actor = await harness.sessions.load(session.id);
    // Drive the actor's production discovery/drain deterministically. The test
    // never invokes runTurn/resumeTurn itself after reopening the stores.
    await (actor as DefaultSessionActor).drainFollowupsForTest();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([session.id, turn.id]);
    expect(outcome).toBeDefined();
    expect((await harness.store.listTurns(session.id)).map(item => item.id)).toEqual([turn.id]);
    expect((await harness.inbox.listAll(session.id)).map(item => [item.status, item.promotedTurnId])).toEqual([["consumed", turn.id]]);
    return outcome!;
  } finally { run.mockRestore(); }
}

function fullBudget(checkpoint: CheckpointData) {
  expect(checkpoint.budgetUsage).toEqual(expect.objectContaining({ maxTokens: 64000,
    verificationRetries: expect.any(Number), stallRecoveryCount: expect.any(Number), recoveryUsage: expect.any(Object),
    run: expect.objectContaining({ runId: expect.any(String), limits: expect.any(Object), usedTurns: 1,
      usedToolCalls: expect.any(Number), startedAt: expect.any(Number), durationMs: expect.any(Number), outputChars: expect.any(Number),
      retries: expect.any(Number), subagentsSpawned: expect.any(Number), estimatedCostUsd: expect.any(Number) }) }));
  return checkpoint.budgetUsage!.run!;
}

describe.each(["jsonl", "sqlite"] as const)("long-running actor recovery after closing and reopening %s", dataStore => {
  it("keeps the same turn, committed ledger and consumed tool budget without repeating an append", async () => {
    const cwd = await workspace(), firstRequests: ModelRequest[] = [], resumedRequests: ModelRequest[] = [];
    const limits = { maxTurns: 1, maxToolCalls: 1, maxEstimatedCostUsd: 1, maxOutputChars: 1000 };
    const first = await createHarness(config(cwd, dataStore, provider([
      call("exec", { command: `${process.execPath} -e "require('fs').appendFileSync('effects.log', 'committed\\n')"` }),
    ], firstRequests), limits));
    let session!: Session, turn!: Turn, checkpoint!: CheckpointData, resultId = "";
    try {
      ({ session, turn } = await promotedTurn(first));
      injectCrash(first, point => { if (point === "tool.checkpointed") throw new RuntimeKilledError(point); });
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({ point: "tool.checkpointed" });
      checkpoint = (await first.checkpointStore!.loadLatest(session.id))!;
      expect(checkpoint.reason).toBe("tool:completed:exec"); expect(checkpoint.iteration).toBe(1);
      expect(checkpoint.toolCallsExecuted).toBe(1);
      expect(checkpoint.toolLedger).toEqual([expect.objectContaining({ tool: "exec", status: "success", sideEffect: true })]);
      expect(fullBudget(checkpoint)).toEqual(expect.objectContaining({ usedToolCalls: 1, estimatedCostUsd: 0.1 }));
      const results = (await first.store.listMessagesByTurn(session.id, turn.id)).filter(message => message.role === "tool");
      expect(results).toHaveLength(1); resultId = results[0]!.id;
      expect(await readFile(join(cwd, "effects.log"), "utf8")).toBe("committed\n");
    } finally { await first.close(); }

    const reopened = await createHarness(config(cwd, dataStore, provider([
      call("write_file", { path: "forbidden.txt", content: "the old tool budget must prevent this" }),
    ], resumedRequests), limits));
    try {
      expect(await reopened.checkpointStore!.loadLatest(session.id)).toEqual(checkpoint);
      const outcome = await recoverWithActor(reopened, session, turn);
      expect(outcome.status).toBe("failed"); expect(outcome.terminationReason).toBe("tool_limit");
      expect(outcome.statusDetail).toBe("failed_with_effects"); expect(outcome.iterations).toBe(2);
      expect(outcome.state?.completed).toEqual(checkpoint.state.completed);
      expect(firstRequests).toHaveLength(1); expect(resumedRequests).toHaveLength(1);
      expect(await readFile(join(cwd, "effects.log"), "utf8")).toBe("committed\n");
      await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const messages = await reopened.store.listMessagesByTurn(session.id, turn.id);
      expect(messages.filter(message => message.id === resultId)).toHaveLength(1);
      const events = await reopened.events.list(session.id);
      expect(new Set(events.filter(event => event.type === "tool.completed" && event.payload.tool === "exec").map(event => event.payload.toolCallId))).toHaveLength(1);
      expect(events.filter(event => event.type === "run.limit_reached" && event.payload.limit === "maxToolCalls").map(event => [event.payload.used, event.payload.allowed])).toEqual([[2, 1]]);
      expect(events.filter(event => event.type === "turn.failed")).toHaveLength(1);
    } finally { await reopened.close(); }
  });

  it("retains verification retries, failure feedback, output and cost across the actor restart", async () => {
    const cwd = await workspace(), firstRequests: ModelRequest[] = [], resumedRequests: ModelRequest[] = [];
    await writeFile(join(cwd, "check.cjs"), 'console.error("project check still fails"); process.exit(1);\n');
    const limits = { maxTurns: 1, maxToolCalls: 5, maxEstimatedCostUsd: 2, maxOutputChars: 1000 };
    const first = await createHarness(config(cwd, dataStore, provider([
      call("write_file", { path: "old.txt", content: "durable completed work" }), stop("first answer"),
    ], firstRequests), limits, true));
    let session!: Session, turn!: Turn, checkpoint!: CheckpointData;
    try {
      ({ session, turn } = await promotedTurn(first));
      injectCrash(first, async point => {
        if (point === "model.next_call" && (await first.checkpointStore!.loadLatest(session.id))?.reason === "verification:failed") {
          throw new RuntimeKilledError(point);
        }
      });
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({ point: "model.next_call" });
      checkpoint = (await first.checkpointStore!.loadLatest(session.id))!;
      expect(checkpoint.reason).toBe("verification:failed"); expect(checkpoint.iteration).toBe(2);
      expect(checkpoint.budgetUsage?.verificationRetries).toBe(1);
      expect(checkpoint.state.filesChanged).toEqual(["old.txt"]); expect(checkpoint.state.failures).toHaveLength(1);
      expect(fullBudget(checkpoint)).toEqual(expect.objectContaining({ usedToolCalls: 1, outputChars: "first answer".length }));
      expect(checkpoint.budgetUsage?.run?.estimatedCostUsd).toBeCloseTo(0.3);
    } finally { await first.close(); }

    const reopened = await createHarness(config(cwd, dataStore, provider([
      stop("second answer"), stop("third answer"),
    ], resumedRequests), limits, true));
    try {
      expect(await reopened.checkpointStore!.loadLatest(session.id)).toEqual(checkpoint);
      const outcome = await recoverWithActor(reopened, session, turn);
      expect(outcome.status).toBe("failed"); expect(outcome.terminationReason).toBe("verification_failed");
      expect(outcome.statusDetail).toBe("failed_with_effects"); expect(outcome.iterations).toBe(4);
      expect(firstRequests).toHaveLength(2); expect(resumedRequests).toHaveLength(2);
      expect(resumedRequests[0]!.messages.some(message => message.content.includes("[verification failed — attempt 1/3]"))).toBe(true);
      expect(outcome.state?.filesChanged).toEqual(["old.txt"]); expect(outcome.state?.failures).toHaveLength(3);
      expect(await readFile(join(cwd, "old.txt"), "utf8")).toBe("durable completed work");
      const latest = (await reopened.checkpointStore!.loadLatest(session.id))!;
      const budget = fullBudget(latest), previousBudget = fullBudget(checkpoint);
      expect(latest.iteration).toBe(4); expect(latest.toolLedger).toEqual(checkpoint.toolLedger);
      expect(latest.budgetUsage?.verificationRetries).toBe(3); expect(latest.state.failures).toHaveLength(3);
      expect(budget.runId).toBe(previousBudget.runId); expect(budget.limits).toEqual(previousBudget.limits);
      expect(budget.usedToolCalls).toBe(1); expect(budget.outputChars).toBe("first answersecond answerthird answer".length);
      expect(budget.estimatedCostUsd).toBeCloseTo(0.7);
      const events = await reopened.events.list(session.id);
      expect(events.filter(event => event.type === "verification.failed").map(event => event.payload.attempt)).toEqual([1, 2, 3]);
      expect(new Set(events.filter(event => event.type === "tool.completed" && event.payload.tool === "write_file").map(event => event.payload.toolCallId))).toHaveLength(1);
      expect(events.filter(event => event.type === "turn.completed")).toHaveLength(0);
      expect(events.filter(event => event.type === "turn.failed")).toHaveLength(1);
    } finally { await reopened.close(); }
  });
});
