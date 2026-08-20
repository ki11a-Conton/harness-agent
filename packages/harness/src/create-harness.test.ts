import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelRef } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";
import { READONLY_TOOL_NAMES } from "./create-harness.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-harness-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

/** Minimal fake provider: one model with a known 128k-token window. */
function fakeProvider(modelId = "test-model"): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "fake", modelId };
  const provider: ModelProvider = {
    id: "fake",
    listModels: async () => [
      { id: modelId, name: "Test Model", capabilities: { contextWindowTokens: 128_000 } },
    ],
    createClient: () => {
      throw new Error("fake provider never streams — assertions target the harness structure");
    },
  };
  return { provider, model };
}

function baseConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const { provider, model } = fakeProvider();
  return {
    cwd: process.cwd(),
    profile: "test",
    modelProvider: provider,
    model,
    ...overrides,
  };
}

describe("P0-3: createHarness production composition root", () => {
  it("default production profile wires pipeline, artifacts, tools, skills and a session store", async () => {
    const harness = await createHarness(baseConfig());

    expect(harness.runtime).toBeDefined();
    expect(harness.context.pipeline).toBeDefined();
    expect(harness.context.budget.maxTokens).toBeGreaterThan(0);
    expect(harness.context.budgetFallback).toBe(false);
    expect(harness.artifactStore).toBeDefined();
    expect(harness.sessionService).toBeDefined();
    expect(harness.registry.names()).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "grep_search",
      "repo_tree",
      "symbol_search",
      "repo_map",
      "discover_commands",
      "env_snapshot",
      "exec",
      "update_plan",
    ]);

    const info = harness.introspect();
    expect(info.profile).toBe("test");
    expect(info.features.context).toBe(true);
    expect(info.features.checkpoint).toBe(false); // no dataDir
    expect(info.features.artifacts).toBe(true);
    expect(info.features.skills).toBe(true);
    expect(info.features.delegation).toBe(false);
    expect(info.stores.session).toBe("MemSessionStore");
    expect(info.stores.artifacts).toBe("InMemoryArtifactStore");
    expect(info.stores.approval).toBe("InMemoryApprovalStore");

    await harness.close();
  });

  it("wires durable checkpoint + JSONL stores and tool output budget when dataDir is set", async () => {
    const dataDir = await tempDir();
    const harness = await createHarness(baseConfig({ dataDir }));

    const info = harness.introspect();
    expect(info.features.checkpoint).toBe(true);
    expect(info.stores.session).toBe("JSONLSessionStore");
    expect(info.stores.events).toBe("JSONLEventStore");
    expect(info.stores.checkpoint).toBe("DurableCheckpointStore");
    expect(info.stores.approval).toBe("DurableApprovalStore");

    // P1-5: ask-user + inbox are durable under a dataDir.
    expect(harness.askUserStore).toBeDefined();
    expect(harness.askUserStore!.constructor.name).toBe("JSONLAskUserStore");

    await harness.close();
  });

  it("P5-3: dataStore sqlite backs all five runtime contracts with one WAL store", async () => {
    const dataDir = await tempDir();
    const harness = await createHarness(baseConfig({ dataDir, dataStore: "sqlite" }));
    try {
      const info = harness.introspect();
      expect(info.stores.session).toBe("SqliteRuntimeStore");
      expect(info.stores.events).toBe("SqliteRuntimeStore");
      // checkpoint/askUser are composition surfaces (the InboxStore.listPending
      // and EventStore.list name collisions make single-class implementation
      // impossible — documented in the store).
      expect(info.stores.checkpoint).toBe("Object");
      expect(harness.askUserStore).toBeDefined();
      expect(harness.askUserStore!.constructor.name).toBe("Object");
      // The sqlite-backed store persists across a reopen (one file, WAL).
      const sessionId = (await harness.sessionService.create({ agentId: harness.agents[0]!.id, model: harness.agents[0]!.model, cwd: harness.config.cwd })).id;
      await harness.close();
      const reopened = await createHarness(baseConfig({ dataDir, dataStore: "sqlite" }));
      const sessions = await reopened.store.listSessions();
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
      await reopened.close();
    } finally {
      await harness.close();
    }
  });

  it("uses no ask-user store and memory inbox without a dataDir", async () => {
    const harness = await createHarness(baseConfig());
    expect(harness.askUserStore).toBeUndefined();
    expect(harness.inbox.constructor.name).toBe("MemInboxStore");
    await harness.close();
  });

  it("registers the subagent definition and scheduler when delegation is enabled", async () => {
    const harness = await createHarness(
      baseConfig({
        delegation: { enabled: true, maxDepth: 2, maxConcurrent: 2, timeoutMs: 60_000 },
      }),
    );

    expect(harness.scheduler).toBeDefined();
    expect(harness.delegator).toBeDefined();
    // P3-6: delegation registers the read-only worker AND the write-capable
    // worker-w agent (used by delegate_worker).
    expect(harness.agents.map((a) => a.name)).toEqual(["main", "worker-w", "worker"]);
    const worker = harness.agents.find((a) => a.name === "worker")!;
    expect(worker.mode).toBe("subagent");
    expect(worker.tools.allow).toEqual([...READONLY_TOOL_NAMES]);

    const info = harness.introspect();
    expect(info.features.delegation).toBe(true);
    expect(info.features.scheduler).toBe(true);

    await harness.close();
  });

  it("wires a memory bridge only when memory is enabled with a dataDir", async () => {
    const noMem = await createHarness(baseConfig());
    expect(noMem.memory).toBeUndefined();
    expect(noMem.introspect().features.memory).toBe(false);
    await noMem.close();

    const dataDir = await tempDir();
    const withMem = await createHarness(baseConfig({ dataDir, memory: { enabled: true } }));
    expect(withMem.memory).toBeDefined();
    expect(withMem.introspect().features.memory).toBe(true);
    expect(withMem.introspect().stores.memory).toBeDefined();
    const result = await withMem.memory!.retrieve("query", "global", { k: 3 });
    expect(Array.isArray(result.items)).toBe(true);
    await withMem.close();
  });

  it("falls back to the conservative budget when the model window is unknown", async () => {
    const model: ModelRef = { providerId: "fake", modelId: "unknown-window" };
    const provider: ModelProvider = {
      id: "fake",
      listModels: async () => [],
      createClient: () => {
        throw new Error("unused");
      },
    };
    const harness = await createHarness(baseConfig({ model, modelProvider: provider }));

    expect(harness.context.budgetFallback).toBe(true);
    expect(harness.context.budget.maxTokens).toBe(32_000);

    await harness.close();
  });

  it("uses an explicit contextBudget without consulting model capabilities", async () => {
    const harness = await createHarness(
      baseConfig({ contextBudget: { maxTokens: 40_000, reserved: { system: 1, task: 1, output: 1 }, dynamic: 0 } }),
    );
    expect(harness.context.budget.maxTokens).toBe(40_000);
    expect(harness.context.budgetFallback).toBe(false);
    await harness.close();
  });

  it("refuses to enable memory without a dataDir or dbPath", async () => {
    await expect(createHarness(baseConfig({ memory: { enabled: true } }))).rejects.toThrow(/dataDir/);
  });

  it("close() drains lifecycle resources (memory store closer) without errors", async () => {
    const dataDir = await tempDir();
    const harness = await createHarness(baseConfig({ dataDir, memory: { enabled: true } }));
    await expect(harness.close()).resolves.toBeUndefined();
  });

  it("reports honest feature flags for deferred subsystems", async () => {
    const harness = await createHarness(baseConfig());
    const info = harness.introspect();
    expect(info.features.mcp).toBe(false);
    expect(info.features.plugins).toBe(false);
    expect(info.features.learning).toBe(false);
    expect(info.features.verifier).toBe(false);
    await harness.close();
  });
});