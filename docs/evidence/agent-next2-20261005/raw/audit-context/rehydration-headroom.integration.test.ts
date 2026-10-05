import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMemoryId, newSessionId } from "@ar/contracts";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(maxTokens: number, options: { memory?: boolean; outputReserved?: number; goal?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ar-rehydration-headroom-")); roots.push(cwd);
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: "rehydration-headroom", listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128_000 } }], createClient: () => ({ async *generate(request) {
    requests.push(structuredClone(request));
    yield { type: "started", timestamp: 0 };
    yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "done" } };
  } }) };
  const memory = options.memory ?? true;
  const goal = options.goal ?? "continue";
  const h = await createHarness({ cwd, dataDir: join(cwd, "data"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted" },
    ...(memory ? { memory: { enabled: true, scope: "workspace" } } : {}), featureFlags: { skills: false, mcp: false, delegation: false, learning: false },
    contextBudget: { maxTokens, reserved: { system: 0, task: 0, output: options.outputReserved ?? 0 }, dynamic: 0 },
  });
  if (memory) {
    const now = Date.now();
    for (const content of [`${goal} useful hint`, `${goal} detailed ${"other ".repeat(1_000)}`]) await h.memoryStore!.write({ id: newMemoryId(), sourceSession: newSessionId(), content, type: "procedural", importance: 0.9, confidence: 0.9, novelty: 0.5, stability: 0.6, createdAt: now, updatedAt: now, deleted: false, scope: "global" });
  }
  const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
  const turn = await h.runtime.startTurn(session.id, goal);
  const run = async () => ({ outcome: await h.runtime.runTurn(session.id, turn.id, new AbortController().signal), events: await h.events.list(session.id) });
  return { h, requests, run, goal };
}

describe("actual Harness rehydration within effective user/output reservation", () => {
  it("keeps the fitting digest and user channel while omitting an optional pointer that previously failed the turn", async () => {
    const f = await fixture(165);
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("completed");
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.system).toContain("# Compaction Summary");
      expect(f.requests[0]!.system).toContain("## Goal\ncontinue");
      expect(f.requests[0]!.system).toContain("## Constraints\n- continue");
      expect(f.requests[0]!.system).not.toContain("## Refs");
      expect(f.requests[0]!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["continue"]);
      expect(events.find(event => event.type === "context.built")?.payload.used).toBe(147);
      expect(events.find(event => event.type === "memory.retrieved")?.payload.count).toBe(2);
      expect(events.some(event => event.type === "run.limit_reached")).toBe(false);
    } finally { await f.h.close(); }
  });

  it("retains the optional pointer when the actual effective budget has enough space", async () => {
    const f = await fixture(170);
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("completed"); expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.system).toContain("## Refs\n- full transcript preserved on disk");
      expect(events.find(event => event.type === "context.built")?.payload.used).toBe(158);
    } finally { await f.h.close(); }
  });

  it("preserves the output reservation in addition to the actual active user cost", async () => {
    const f = await fixture(175, { outputReserved: 10 });
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("completed"); expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.system).not.toContain("## Refs");
      expect(events.find(event => event.type === "context.built")?.payload.used).toBe(147);
      expect(f.requests[0]!.messages.some(message => message.role === "user" && message.content === "continue")).toBe(true);
    } finally { await f.h.close(); }
  });

  it("uses the same effective headroom for an actual Unicode user message", async () => {
    const f = await fixture(164, { goal: "继续" });
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("completed"); expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.system).toContain("## Goal\n继续");
      expect(f.requests[0]!.system).not.toContain("## Refs");
      expect(f.requests[0]!.messages.some(message => message.role === "user" && message.content === "继续")).toBe(true);
      expect(events.some(event => event.type === "run.limit_reached")).toBe(false);
    } finally { await f.h.close(); }
  });

  it("keeps the default memory-off non-compacting path unchanged", async () => {
    const f = await fixture(165, { memory: false });
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("completed"); expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.system).not.toContain("# Compaction Summary");
      expect(events.find(event => event.type === "context.built")?.payload.used).toBe(130);
      expect(events.some(event => event.type === "memory.retrieved")).toBe(false);
    } finally { await f.h.close(); }
  });

  it("still fails an irreducible protected system/user overflow before any provider call", async () => {
    const f = await fixture(129);
    try {
      const { outcome, events } = await f.run();
      expect(outcome.status).toBe("failed"); expect(f.requests).toEqual([]);
      expect(events.find(event => event.type === "run.limit_reached")?.payload).toMatchObject({ limit: "maxTokens", used: 140 });
    } finally { await f.h.close(); }
  });
});
