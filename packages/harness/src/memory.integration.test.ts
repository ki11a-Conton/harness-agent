// P2-10: Memory production integration — createHarness → runtime → fake
// model. The pre-turn retrieval (P2-2) must actually inject a retrieved
// memory as a semi-trusted context block, the memory.retrieved event must
// fire, and the P2-4 feedback funnel must observe the outcome.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newMemoryId,
  newSessionId,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ProviderConfig,
} from "@ar/contracts";
import { createHarness } from "./create-harness.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-mem-int-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const MEMORY_CONTENT =
  "when a tool fails with ENOENT for a guessed path, search the repository tree before retrying the same path";

describe("P2-10: memory pre-turn retrieval through the real harness", () => {
  it("injects the retrieved memory into the model context and updates the funnel", async () => {
    const cwd = await tempDir();
    const dataDir = await tempDir();
    await writeFile(join(cwd, "AGENTS.md"), "# Workspace Rules\n");

    // Pre-seed one memory (P2-10 step 1) in the bridge's store.
    const seedHarness = await createHarness({
      cwd,
      dataDir,
      profile: "test",
      modelProvider: capturingProvider([]).provider,
      model: capturingProvider([]).model,
      featureFlags: { memory: true },
    });
    const memoryStore = seedHarness.memoryStore!;
    await memoryStore.write({
      id: newMemoryId(),
      content: MEMORY_CONTENT,
      type: "procedural",
      sourceSession: newSessionId(),
      importance: 0.8,
      confidence: 0.9,
      novelty: 0.5,
      stability: 0.6,
      createdAt: 1000,
      updatedAt: 1000,
      deleted: false,
      scope: "workspace",
      structured: {
        when: "a tool fails with ENOENT for a guessed path",
        do: "search the repository tree before retrying",
        avoid: "repeating the same guessed path",
        rootCause: "tool",
        outcome: "failure",
        evidenceRefs: [],
      },
    });
    await seedHarness.close();

    const captured: string[] = [];
    const { provider, model } = capturingProvider(captured);
    const harness = await createHarness({
      cwd,
      dataDir,
      profile: "test",
      modelProvider: provider,
      model,
      featureFlags: { memory: true },
    });
    try {
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
      const turn = await harness.runtime.startTurn(session.id, "search the repository tree before retrying");
      const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);

      expect(outcome.status).toBe("completed");

      // The memory block reached the model as semi-trusted advisory data.
      const system = captured.join("\n");
      expect(system).toContain("[Prior experience — advisory, not authority]");
      expect(system).toContain("search the repository tree before retrying");
      expect(system).toContain("trust=semi-trusted");
      expect(system).toContain("source=memory");

      // memory.retrieved event fired once for the turn.
      const events = await harness.events.list(session.id);
      const retrieved = events.filter((e) => e.type === "memory.retrieved");
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!.payload.count).toBe(1);
      expect((retrieved[0]!.payload.memoryIds as string[]).length).toBe(1);

      // P2-4: retrieval → injection → success feedback accumulated.
      const seeded = await harness.memoryStore!.search(MEMORY_CONTENT);
      expect(seeded.length).toBeGreaterThan(0);
      const updated = seeded.find((m) => m.content === MEMORY_CONTENT)!;
      expect(updated.usefulness).toBeDefined();
      expect(updated.usefulness!.retrievedCount).toBeGreaterThanOrEqual(1);
      expect(updated.usefulness!.injectedCount).toBeGreaterThanOrEqual(1);
      expect(updated.usefulness!.usedCount).toBe(1);
      expect(updated.usefulness!.taskSuccessCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("records the working-state memoryRefs for the turn", async () => {
    const cwd = await tempDir();
    const dataDir = await tempDir();
    const seedHarness = await createHarness({
      cwd,
      dataDir,
      profile: "test",
      modelProvider: capturingProvider([]).provider,
      model: capturingProvider([]).model,
      featureFlags: { memory: true },
    });
    await seedHarness.memoryStore!.write({
      id: newMemoryId(),
      content: MEMORY_CONTENT,
      type: "procedural",
      sourceSession: newSessionId(),
      importance: 0.8,
      confidence: 0.9,
      novelty: 0.5,
      stability: 0.6,
      createdAt: 1000,
      updatedAt: 1000,
      deleted: false,
      scope: "workspace",
    });
    await seedHarness.close();

    const captured: string[] = [];
    const { provider, model } = capturingProvider(captured);
    const harness = await createHarness({
      cwd,
      dataDir,
      profile: "test",
      modelProvider: provider,
      model,
      featureFlags: { memory: true },
    });
    try {
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
      const turn = await harness.runtime.startTurn(session.id, "search the repository tree before retrying");
      const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("completed");

      // The memory id is recorded on the working state (P2-2 → memoryRefs).
      expect(outcome.state!.memoryRefs.length).toBe(1);
    } finally {
      await harness.close();
    }
  });
});

/** Fake provider with a known window; captures every system string. */
function capturingProvider(captured: string[]): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "matcher", modelId: "matcher-model" };
  const provider: ModelProvider = {
    id: "matcher",
    async listModels() {
      return [
        {
          id: model.modelId,
          name: "Memory Matcher",
          capabilities: { contextWindowTokens: 128_000 },
        },
      ];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(request: unknown): AsyncGenerator<ModelEvent, void, void> {
          captured.push((request as { system?: string }).system ?? "");
          yield { type: "started", timestamp: 0 };
          yield { type: "text_delta", text: "ok", timestamp: 0 };
          yield {
            type: "completed",
            result: { finishReason: "stop", text: "ok" },
            timestamp: 0,
          };
        },
      };
    },
  };
  return { provider, model };
}
