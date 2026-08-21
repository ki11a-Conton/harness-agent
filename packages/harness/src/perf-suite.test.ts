import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextBudget, Message } from "@ar/contracts";
import { newMessageId, newSessionId } from "@ar/contracts";
import { JSONLSessionStore } from "@ar/session";
import { JSONLEventStore } from "@ar/events";
import { ContextPipeline } from "@ar/context";

/**
 * P11-1/P11-2: deterministic long-session / context-build performance suite.
 * No paid model; everything is store + pipeline. Figures are PRINTED for the
 * plan record; assertions are structural (data integrity after scale), not
 * wall-clock thresholds (CI machines vary).
 */

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});
async function freshDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "perf-suite-"));
  return tempDir;
}

function message(sessionId: string, i: number): Message {
  return {
    id: newMessageId(),
    sessionId: sessionId as never,
    role: "assistant",
    content: `message ${i} with some realistic payload length for context accounting ${"x".repeat(80)}`,
    createdAt: i,
  };
}

describe("P11-1: long-session scale (deterministic)", () => {
  it("handles 10k messages + 1k events + 500 sessions without corruption", async () => {
    const dir = await freshDir();
    const sessionStore = new JSONLSessionStore({ dataDir: dir });
    const eventStore = new JSONLEventStore({ dataDir: dir });
    const sid = newSessionId();
    await sessionStore.createSession({
      id: sid,
      agentId: newSessionId() as never,
      model: { providerId: "p", modelId: "m" },
      cwd: "/w",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    });
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      await sessionStore.appendMessage(message(sid, i));
    }
    for (let i = 0; i < 1_000; i++) {
      await eventStore.append({
        id: newMessageId() as never,
        sessionId: sid,
        sequence: 0,
        timestamp: i,
        type: "turn.started",
        payload: {},
      });
    }
    for (let i = 0; i < 500; i++) {
      await sessionStore.createSession({
        id: newSessionId(),
        agentId: newSessionId() as never,
        model: { providerId: "p", modelId: "m" },
        cwd: "/w",
        status: "active",
        createdAt: i,
        updatedAt: i,
      });
    }
    const elapsed = performance.now() - started;
    const messages = await sessionStore.listMessages(sid);
    expect(messages).toHaveLength(10_000);
    const events = await eventStore.list(sid);
    expect(events).toHaveLength(1_000);
    expect((await sessionStore.listSessions()).length).toBeGreaterThanOrEqual(500);
    console.log(`[P11-1] 10k msgs + 1k events + 500 sessions: ${elapsed.toFixed(0)}ms`);
  }, 300_000);

  it("builds context over a 10k-message history deterministically", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "repo rules\n", "utf8");
    const pipeline = new ContextPipeline();
    const budget: ContextBudget = {
      maxTokens: 100_000,
      reserved: { system: 0, task: 0, output: 0 },
      dynamic: 0,
    };
    const history = Array.from({ length: 10_000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}: ${"payload ".repeat(10)}`,
    }));
    const started = performance.now();
    const result = await pipeline.build({
      cwd: dir,
      systemPrompt: "You are the harness.",
      priorBlocks: [],
      budget,
      messages: history,
    });
    const elapsed = performance.now() - started;
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.report.messagesTokens).toBeGreaterThan(0);
    console.log(`[P11-2] context build over 10k-message history: ${elapsed.toFixed(1)}ms (messagesTokens=${result.report.messagesTokens})`);
  }, 60_000);
});
