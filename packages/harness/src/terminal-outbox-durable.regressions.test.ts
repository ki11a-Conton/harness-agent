import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newPromptId, newToolCallId, type ModelEvent, type ModelProvider, type ModelRequest } from "@ar/contracts";
import type { DefaultSessionActor } from "@ar/core";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

function provider(requests: ModelRequest[], write: boolean, pause = false): ModelProvider {
  let index = 0;
  return { id: "terminal-outbox-offline", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(structuredClone(request));
      if (write && index++ === 0) yield { type: "completed", timestamp: 1, result: { finishReason: "tool_calls",
        toolCalls: [{ id: newToolCallId(), name: "write_file", args: { path: "effect.txt", content: "one real committed effect" } }] } };
      else if (pause) yield { type: "completed", timestamp: 1, result: { finishReason: "tool_calls",
        toolCalls: [{ id: newToolCallId(), name: "ask_user", args: { question: "Which target?", reason: "choice_required" } }] } };
      else yield { type: "completed", timestamp: 1, result: { finishReason: "stop", text: "done" } };
    },
  }) };
}
function config(cwd: string, dataStore: "jsonl" | "sqlite", modelProvider: ModelProvider): HarnessConfig {
  return { cwd, dataDir: join(cwd, "state"), dataStore, profile: "test", modelProvider,
    model: { providerId: modelProvider.id, modelId: "offline" }, featureFlags: { skills: false },
    contextBudget: { maxTokens: 64000, reserved: { system: 512, task: 512, output: 1024 }, dynamic: 0 } };
}

describe.each(["jsonl", "sqlite"] as const)("terminal outbox after actual %s store reopen", dataStore => {
  it.each(["before", "after"] as const)("repairs append %s commit through actor load without repeating the real file write", async stage => {
    const cwd = await mkdtemp(join(tmpdir(), "ar-terminal-outbox-"));
    const firstRequests: ModelRequest[] = [], reopenedRequests: ModelRequest[] = [];
    let first: Awaited<ReturnType<typeof createHarness>> | undefined, reopened: typeof first;
    try {
      first = await createHarness(config(cwd, dataStore, provider(firstRequests, true)));
      const agent = first.agents[0]!;
      const session = await first.sessionService.create({ agentId: agent.id, model: agent.model, cwd });
      const promptId = newPromptId(), text = "Write effect.txt then finish.";
      await first.inbox.admit({ id: promptId, sessionId: session.id, text, kind: "followup", status: "pending", admittedAt: 1 });
      await first.inbox.markPromoted(promptId);
      const turn = await first.runtime.startTurn(session.id, text);
      await first.inbox.bindPromotion(promptId, turn.id);
      const append = first.events.appendNew.bind(first.events);
      let armed = true;
      const fault = vi.spyOn(first.events, "appendNew").mockImplementation(async event => {
        if (event.turnId !== turn.id || event.type !== "turn.completed" || !armed) return append(event);
        armed = false;
        if (stage === "before") throw new Error("durable terminal append before commit");
        await append(event);
        throw new Error("durable terminal append after commit");
      });
      await expect(first.runtime.runTurn(session.id, turn.id, new AbortController().signal)).rejects.toThrow(`durable terminal append ${stage}`);
      fault.mockRestore();
      expect(firstRequests).toHaveLength(2);
      expect(await readFile(join(cwd, "effect.txt"), "utf8")).toBe("one real committed effect");
      const committed = await first.store.getTurn(turn.id);
      expect(committed).toMatchObject({ status: "completed", terminalOutcome: { version: 1, status: "completed", terminationReason: "model_stopped" } });
      expect(await first.checkpointStore!.loadLatest(session.id)).toMatchObject({ turnId: turn.id });
      const effectsBefore = (await first.events.list(session.id)).filter(event => event.type === "tool.requested").length;
      expect(effectsBefore).toBe(1);
      await first.close(); first = undefined;

      reopened = await createHarness(config(cwd, dataStore, provider(reopenedRequests, false)));
      const run = vi.spyOn(reopened.runtime, "runTurn");
      const actor = await reopened.sessions.load(session.id);
      await (actor as DefaultSessionActor).drainFollowupsForTest();
      expect(run).not.toHaveBeenCalled();
      expect(reopenedRequests).toHaveLength(0);
      const journal = await reopened.events.list(session.id);
      const terminals = journal.filter(event => event.turnId === turn.id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ id: committed!.terminalOutcome!.eventId,
        timestamp: committed!.terminalOutcome!.timestamp, type: "turn.completed", payload: { status: "completed", terminationReason: "model_stopped" } });
      expect(journal.filter(event => event.type === "tool.requested")).toHaveLength(effectsBefore);
      expect((await reopened.inbox.listAll(session.id)).map(prompt => [prompt.status, prompt.promotedTurnId])).toEqual([["consumed", turn.id]]);
      expect((await reopened.store.listTurns(session.id)).map(item => item.id)).toEqual([turn.id]);
      const resumed = await reopened.runtime.resumeTurn(session.id, new AbortController().signal);
      expect(resumed.outcome).toMatchObject({ status: "completed", terminationReason: "model_stopped", grade: "unverified_complete", turn: { id: turn.id } });
      expect(reopenedRequests).toHaveLength(0);
      expect((await reopened.store.listTurns(session.id)).map(item => item.id)).toEqual([turn.id]);
      expect(await readFile(join(cwd, "effect.txt"), "utf8")).toBe("one real committed effect");
    } finally {
      await first?.close(); await reopened?.close();
      await rm(cwd, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
    }
  });

  it.each(["before", "after"] as const)("keeps paused cancellation effects and withdraws its question after append fails %s commit", async stage => {
    const cwd = await mkdtemp(join(tmpdir(), "ar-paused-terminal-outbox-"));
    const requests: ModelRequest[] = [], after: ModelRequest[] = [];
    let first: Awaited<ReturnType<typeof createHarness>> | undefined, reopened: typeof first;
    try {
      first = await createHarness(config(cwd, dataStore, provider(requests, true, true)));
      const agent = first.agents[0]!;
      const session = await first.sessionService.create({ agentId: agent.id, model: agent.model, cwd });
      const turn = await first.runtime.startTurn(session.id, "Write effect.txt, then ask which target.");
      const paused = await first.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(paused.status).toBe("waiting_for_user"); expect(requests).toHaveLength(2);
      expect(await first.askUserStore!.listPending(session.id)).toHaveLength(1);
      const actor = await first.sessions.load(session.id);
      const append = first.events.appendNew.bind(first.events);
      let armed = true;
      const fault = vi.spyOn(first.events, "appendNew").mockImplementation(async event => {
        if (event.type !== "turn.cancelled" || !armed) return append(event);
        armed = false;
        if (stage === "before") throw new Error("paused terminal append before commit");
        await append(event); throw new Error("paused terminal append after commit");
      });
      await expect(actor.cancelTurn(turn.id)).rejects.toThrow(`paused terminal append ${stage}`);
      fault.mockRestore();
      expect(await first.store.getTurn(turn.id)).toMatchObject({ status: "cancelled", terminalOutcome: {
        status: "cancelled", statusDetail: "cancelled_with_effects", terminationReason: "cancelled" } });
      expect(requests).toHaveLength(2);
      await first.close(); first = undefined;
      reopened = await createHarness(config(cwd, dataStore, provider(after, false)));
      const run = vi.spyOn(reopened.runtime, "runTurn");
      await reopened.sessions.load(session.id);
      expect(run).not.toHaveBeenCalled(); expect(after).toHaveLength(0);
      const cancelled = (await reopened.events.list(session.id)).filter(event => event.type === "turn.cancelled");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.payload).toMatchObject({ status: "cancelled", statusDetail: "cancelled_with_effects", terminationReason: "cancelled" });
      expect(await reopened.askUserStore!.listPending(session.id)).toHaveLength(0);
      expect(await reopened.store.listTurns(session.id)).toHaveLength(1);
      expect(await readFile(join(cwd, "effect.txt"), "utf8")).toBe("one real committed effect");
    } finally {
      await first?.close(); await reopened?.close();
      await rm(cwd, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 });
    }
  });

});
