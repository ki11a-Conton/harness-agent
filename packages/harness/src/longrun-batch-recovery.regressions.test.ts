import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newPromptId, newToolCallId } from "@ar/contracts";
import type { CheckpointData, ModelEvent, ModelProvider, ModelRequest, Session, ToolCall, Turn } from "@ar/contracts";
import { RuntimeKilledError } from "@ar/core";
import type { DefaultSessionActor, FaultPoint, FaultPointContext, TurnOutcome } from "@ar/core";
import { createHarness, type Harness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

const roots: string[] = [];
let clock = 1000;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "ar-longrun-batch-")); roots.push(cwd); return cwd;
}

function stop(text: string, cost = 0.2): ModelEvent[] {
  return [{ type: "text_delta", text, timestamp: 1000 }, { type: "completed", result: { finishReason: "stop", text,
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: cost } }, timestamp: 1000 }];
}

function batch(calls: ToolCall[], cost = 0.1): ModelEvent[] {
  return [{ type: "completed", result: { finishReason: "tool_calls", toolCalls: calls,
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: cost } }, timestamp: 1000 }];
}

function provider(scripts: ModelEvent[][], requests: ModelRequest[]): ModelProvider {
  let index = 0;
  return { id: "longrun-batch-script", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(structuredClone(request));
      const script = scripts[index++];
      if (script === undefined) throw new Error("recovery must stop before another model request");
      yield* script;
    },
  }) };
}

function config(cwd: string, dataStore: "jsonl" | "sqlite", modelProvider: ModelProvider, extra: Partial<HarnessConfig> = {}): HarnessConfig {
  return { cwd, dataDir: join(cwd, "state"), dataStore, profile: "test", now: () => ++clock,
    modelProvider, model: { providerId: modelProvider.id, modelId: "scripted-model" }, featureFlags: { skills: false },
    limits: { maxTurns: 1, maxToolCalls: 4, maxEstimatedCostUsd: 2, maxOutputChars: 1000 }, maxIterationsPerTurn: 10,
    contextBudget: { maxTokens: 64000, reserved: { system: 512, task: 512, output: 1024 }, dynamic: 0 }, ...extra };
}

function verification(): Pick<HarnessConfig, "task"> {
  return { task: { id: "batch-recovery", goal: "preserve the completed work and pass the real check",
    verification: [{ kind: "command", command: process.execPath, args: ["check.cjs"] }] } };
}

function injectCrash(harness: Harness, hook: (point: FaultPoint, ctx: FaultPointContext) => void | Promise<void>) {
  (harness.runtime as unknown as { failpoint: typeof hook }).failpoint = hook;
}

async function promotedTurn(harness: Harness): Promise<{ session: Session; turn: Turn }> {
  const agent = harness.agents[0]!;
  const session = await harness.sessionService.create({ agentId: agent.id, model: agent.model, cwd: harness.config.cwd });
  const text = "Finish this original task without repeating completed writes.";
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
    await (actor as DefaultSessionActor).drainFollowupsForTest();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([session.id, turn.id]);
    expect(outcome).toBeDefined();
    expect((await harness.store.listTurns(session.id)).map(item => item.id)).toEqual([turn.id]);
    expect((await harness.inbox.listAll(session.id)).map(item => [item.status, item.promotedTurnId])).toEqual([["consumed", turn.id]]);
    return outcome!;
  } finally { run.mockRestore(); }
}

describe.each(["jsonl", "sqlite"] as const)("long-running durable batch and completion recovery with %s", dataStore => {
  it("retains both already-executed writes when the first batch result is checkpointed before a crash", async () => {
    const cwd = await workspace(), firstRequests: ModelRequest[] = [], resumedRequests: ModelRequest[] = [];
    await writeFile(join(cwd, "check.cjs"), 'const fs = require("fs"); for (const [path, text] of [["first.txt", "first committed write"], ["second.txt", "second committed write"]]) { if (fs.readFileSync(path, "utf8") !== text) process.exit(1); } console.log("both committed writes verified");\n');
    const writes: ToolCall[] = [
      { id: newToolCallId(), name: "write_file", args: { path: "first.txt", content: "first committed write" } },
      { id: newToolCallId(), name: "write_file", args: { path: "second.txt", content: "second committed write" } },
    ];
    const first = await createHarness(config(cwd, dataStore, provider([batch(writes)], firstRequests), { ...verification(), now: () => 1000 }));
    let session!: Session, turn!: Turn, checkpoint!: CheckpointData;
    try {
      ({ session, turn } = await promotedTurn(first));
      injectCrash(first, (point, ctx) => {
        if (point === "tool.checkpointed" && ctx.toolCallId === writes[0]!.id) throw new RuntimeKilledError(point);
      });
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({ point: "tool.checkpointed" });
      expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("first committed write");
      expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("second committed write");
      checkpoint = (await first.checkpointStore!.loadLatest(session.id))!;
      expect(checkpoint.turnId).toBe(turn.id);
      expect(checkpoint.budgetUsage?.run?.usedToolCalls).toBe(2);
      expect(firstRequests).toHaveLength(1);
    } finally { await first.close(); }

    const reopened = await createHarness(config(cwd, dataStore, provider([stop("Both writes are already committed; verify them.")], resumedRequests), { ...verification(), now: () => 1000 }));
    try {
      expect(await reopened.checkpointStore!.loadLatest(session.id)).toEqual(checkpoint);
      const outcome = await recoverWithActor(reopened, session, turn);
      expect(outcome.status).toBe("completed"); expect(outcome.terminationReason).toBe("verified_complete");
      expect(outcome.toolCalls).toBe(2);
      expect(outcome.state?.filesChanged).toEqual(["first.txt", "second.txt"]);
      expect(outcome.state?.completed).toEqual(expect.arrayContaining(["modified first.txt", "modified second.txt"]));
      expect(resumedRequests).toHaveLength(1);
      const finalCheckpoint = (await reopened.checkpointStore!.loadLatest(session.id))!;
      expect(finalCheckpoint.reason).toBe("verification:passed");
      expect(finalCheckpoint.toolLedger).toHaveLength(2);
      expect(finalCheckpoint.toolLedger.map(record => [record.toolCallId, record.status, record.sideEffect])).toEqual(
        writes.map(write => [write.id, "success", true]),
      );
      const events = await reopened.events.list(session.id), callIds = new Set(writes.map(write => write.id));
      expect(events.filter(event => event.type === "tool.started" && callIds.has(event.payload.toolCallId as ToolCall["id"])).map(event => event.payload.toolCallId)).toEqual(writes.map(write => write.id));
      const results = (await reopened.store.listMessagesByTurn(session.id, turn.id)).filter(message => message.role === "tool" && message.toolCallId !== undefined && callIds.has(message.toolCallId));
      expect(results.map(message => message.toolCallId)).toEqual(writes.map(write => write.id));
      expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("first committed write");
      expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("second committed write");
      expect(events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    } finally { await reopened.close(); }
  });

  it.each(["cost", "output"] as const)("stops before any new model call when a post-checkpoint durable completion exhausted %s", async kind => {
    const cwd = await workspace(), firstRequests: ModelRequest[] = [], resumedRequests: ModelRequest[] = [];
    const limits = { maxTurns: 1, maxToolCalls: 2, maxEstimatedCostUsd: kind === "cost" ? 1 : 10, maxOutputChars: kind === "output" ? 5 : 1000 };
    const text = kind === "output" ? "output beyond the persisted cap" : "done";
    const write: ToolCall = { id: newToolCallId(), name: "write_file", args: { path: "committed.txt", content: "keep this committed work" } };
    const first = await createHarness(config(cwd, dataStore, provider([
      batch([write], 0.75), stop(text, kind === "cost" ? 0.75 : 0),
    ], firstRequests), { limits }));
    let session!: Session, turn!: Turn, checkpoint!: CheckpointData;
    const append = first.events.append.bind(first.events);
    const crashedAppend = vi.spyOn(first.events, "append").mockImplementation(async event => {
      const persisted = await append(event);
      if (event.type === "model.completed" && event.payload.finishReason === "stop") {
        throw new RuntimeKilledError("model.stream", "simulated crash after durable model.completed append");
      }
      return persisted;
    });
    try {
      ({ session, turn } = await promotedTurn(first));
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({
        name: "RuntimeKilledError", message: "simulated crash after durable model.completed append",
      });
      checkpoint = (await first.checkpointStore!.loadLatest(session.id))!;
      expect(checkpoint.reason).toBe("tool:completed:write_file");
      expect(checkpoint.budgetUsage?.run).toEqual(expect.objectContaining({ usedTurns: 1, usedToolCalls: 1, estimatedCostUsd: 0.75, outputChars: 0 }));
      const completions = (await first.events.list(session.id, { afterSequence: checkpoint.lastEventSequence })).filter(event => event.type === "model.completed");
      expect(completions).toHaveLength(1); expect(completions[0]!.payload.text).toBe(text);
      expect(completions[0]!.payload.usage).toEqual(expect.objectContaining({ estimatedCostUsd: kind === "cost" ? 0.75 : 0 }));
      expect(firstRequests).toHaveLength(2);
    } finally { crashedAppend.mockRestore(); await first.close(); }

    const reopened = await createHarness(config(cwd, dataStore, provider([], resumedRequests), { limits }));
    try {
      const outcome = await recoverWithActor(reopened, session, turn);
      expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(outcome.statusDetail).toBe("failed_with_effects"); expect(outcome.iterations).toBe(2); expect(outcome.toolCalls).toBe(1);
      expect(outcome.state?.filesChanged).toEqual(["committed.txt"]); expect(resumedRequests).toHaveLength(0);
      expect(await readFile(join(cwd, "committed.txt"), "utf8")).toBe("keep this committed work");
      expect((await reopened.checkpointStore!.loadLatest(session.id))?.toolLedger).toEqual(checkpoint.toolLedger);
      const events = await reopened.events.list(session.id), limit = kind === "cost" ? "maxEstimatedCostUsd" : "maxOutputChars";
      expect(events.filter(event => event.type === "run.limit_reached").map(event => [event.payload.limit, event.payload.used, event.payload.allowed])).toEqual([
        [limit, kind === "cost" ? 1.5 : text.length, kind === "cost" ? 1 : 5],
      ]);
      expect(events.filter(event => event.type === "model.started")).toHaveLength(2);
      expect(events.filter(event => event.type === "tool.started" && event.payload.toolCallId === write.id)).toHaveLength(1);
      expect(events.filter(event => event.type === "turn.completed")).toHaveLength(0);
      expect(events.filter(event => event.type === "turn.failed")).toHaveLength(1);
    } finally { await reopened.close(); }
  });

  it("does not sample again after the only iteration passed verification but terminal persistence crashed", async () => {
    const cwd = await workspace(), firstRequests: ModelRequest[] = [], resumedRequests: ModelRequest[] = [];
    await writeFile(join(cwd, "check.cjs"), 'console.log("real project check passed");\n');
    const extra: Partial<HarnessConfig> = { ...verification(), maxIterationsPerTurn: 1 };
    const first = await createHarness(config(cwd, dataStore, provider([stop("verified answer")], firstRequests), extra));
    let session!: Session, turn!: Turn, checkpoint!: CheckpointData;
    try {
      ({ session, turn } = await promotedTurn(first));
      injectCrash(first, point => { if (point === "turn.completing") throw new RuntimeKilledError(point); });
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toMatchObject({ point: "turn.completing" });
      checkpoint = (await first.checkpointStore!.loadLatest(session.id))!;
      expect(checkpoint.reason).toBe("verification:passed");
      expect(checkpoint.budgetUsage?.run?.usedTurns).toBe(1); expect(firstRequests).toHaveLength(1);
      expect((await first.events.list(session.id)).filter(event => event.type === "verification.completed")).toHaveLength(1);
    } finally { await first.close(); }

    const reopened = await createHarness(config(cwd, dataStore, provider([], resumedRequests), extra));
    try {
      expect(await reopened.checkpointStore!.loadLatest(session.id)).toEqual(checkpoint);
      const outcome = await recoverWithActor(reopened, session, turn);
      expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(outcome.iterations).toBe(1); expect(resumedRequests).toHaveLength(0);
      const events = await reopened.events.list(session.id);
      expect(events.filter(event => event.type === "run.limit_reached").map(event => event.payload.limit)).toEqual(["maxIterationsPerTurn"]);
      expect(events.filter(event => event.type === "model.started")).toHaveLength(1);
      expect(events.filter(event => event.type === "turn.completed")).toHaveLength(0);
      expect(events.filter(event => event.type === "turn.failed")).toHaveLength(1);
    } finally { await reopened.close(); }
  });
});
