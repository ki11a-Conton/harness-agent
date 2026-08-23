import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelRef } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-config-wiring-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // best-effort cleanup; a locked file (e.g. sqlite handle) must not hang CI
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)),
  );
  tempDirs = [];
}, 20_000);

function fakeProvider(modelId = "test-model"): { provider: ModelProvider; model: ModelRef } {
  const model: ModelRef = { providerId: "fake", modelId };
  const provider: ModelProvider = {
    id: "fake",
    listModels: async () => [
      { id: modelId, name: "Test Model", capabilities: { contextWindowTokens: 128_000 } },
    ],
    createClient: () => {
      throw new Error("fake provider never streams");
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

/** Create a session doc so the durable state snapshot (P27-4 freeze) has a
 *  row to attach to — both memory and JSONL stores require it. */
async function createSession(
  harness: Awaited<ReturnType<typeof createHarness>>,
  id: string,
): Promise<string> {
  const now = Date.now();
  await harness.store.createSession({
    id: id as never,
    agentId: harness.agents[0]!.id,
    model: harness.config.model,
    cwd: harness.config.cwd,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("P27 config wiring in createHarness", () => {
  it("exposes the resolved config stack (defaults → profile → runtime)", async () => {
    const harness = await createHarness(baseConfig());
    expect(harness.resolvedConfig).toBeDefined();
    expect(harness.resolvedConfig.layers.map((l) => l.source)).toEqual([
      "defaults",
      "profile",
      "runtime",
    ]);
    expect(harness.resolvedConfig.value.profile).toBe("test");
    expect(harness.resolvedConfig.value.cwd).toBe(process.cwd());
    expect(harness.resolvedConfig.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // per-key origin: sandbox leaves from the profile preset, feature flags
    // from the profile preset's full defaults when runtime does not override
    expect(harness.resolvedConfig.origins.get("sandboxPolicy.network.mode")?.source).toBe("profile");
    expect(harness.resolvedConfig.origins.get("featureFlags.memory")?.source).toBe("profile");
    await harness.close();
  });

  it("runtime overrides win and are recorded as runtime origin", async () => {
    const harness = await createHarness(
      baseConfig({ featureFlags: { skills: false }, limits: { maxTurns: 9 } }),
    );
    expect(harness.resolvedConfig.value.featureFlags?.skills).toBe(false);
    expect(harness.resolvedConfig.origins.get("featureFlags.skills")?.source).toBe("runtime");
    expect(harness.resolvedConfig.origins.get("limits.maxTurns")?.source).toBe("runtime");
    await harness.close();
  });

  it("configExplain renders whole config with lifecycle + redaction", async () => {
    const harness = await createHarness(baseConfig({ limits: { maxTurns: 3 } }));
    const result = harness.configExplain();
    expect(result.fingerprint).toBe(harness.resolvedConfig.fingerprint);
    const limits = result.entries.find((e) => e.key === "limits.maxTurns")!;
    expect(limits.value).toBe(3);
    expect(limits.lifecycle).toBe("session_frozen");
    expect(limits.origin?.source).toBe("runtime");
    const cwd = result.entries.find((e) => e.key === "cwd")!;
    expect(cwd.lifecycle).toBe("process_static");
    await harness.close();
  });

  it("configExplain(key) explains a single key", async () => {
    const harness = await createHarness(baseConfig());
    const result = harness.configExplain("profile");
    expect(result.key).toBe("profile");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.value).toBe("test");
    expect(result.entries[0]!.lifecycle).toBe("session_frozen");
    await harness.close();
  });

  it("freeze + check: no drift right after freezing", async () => {
    const harness = await createHarness(baseConfig());
    const sessionId = await createSession(harness, "sess-drift-1");
    await harness.freezeConfigFingerprint(sessionId as never);
    const decision = await harness.checkSessionConfigDrift(sessionId as never);
    expect(decision.severity).toBe("none");
    await harness.close();
  });

  it("check across harnesses: changed session_frozen key → reject (widen)", async () => {
    const dir = await tempDir();
    // harness A freezes with memory OFF
    const hA = await createHarness(baseConfig({ dataDir: dir, featureFlags: { memory: false } }));
    const sessionId = await createSession(hA, "sess-drift-2");
    await hA.freezeConfigFingerprint(sessionId as never);
    await hA.close();
    // harness B (same store) starts with memory ON → widening drift
    const hB = await createHarness(baseConfig({ dataDir: dir, featureFlags: { memory: true } }));
    const decision = await hB.checkSessionConfigDrift(sessionId as never);
    expect(decision.severity).toBe("reject");
    const item = decision.changed.find((c) => c.key === "featureFlags.memory")!;
    expect(item.direction).toBe("widen");
    await hB.close();
  });

  it("check: process_static change → restart_required", async () => {
    const dir = await tempDir();
    // JSONL store (real snapshot round-trip). Simulate a session frozen by a
    // previous run whose cwd differs — a process_static drift.
    const harness = await createHarness(baseConfig({ dataDir: dir }));
    const sessionId = await createSession(harness, "sess-drift-3");
    await harness.store.saveStateSnapshot(sessionId as never, {
      "p27.configFingerprint": "<stale-fingerprint>",
      "p27.configValue": JSON.stringify({
        ...harness.resolvedConfig.value,
        cwd: "/old/workspace",
      }),
    });
    const decision = await harness.checkSessionConfigDrift(sessionId as never);
    expect(decision.severity).toBe("restart_required");
    const item = decision.changed.find((c) => c.key === "cwd")!;
    expect(item.lifecycle).toBe("process_static");
    await harness.close();
  });

  it("check with no frozen snapshot → none", async () => {
    const harness = await createHarness(baseConfig());
    const sessionId = await createSession(harness, "sess-drift-4");
    const decision = await harness.checkSessionConfigDrift(sessionId as never);
    expect(decision.severity).toBe("none");
    await harness.close();
  });

  it("P27-4 production path: sessions.load rejects a drifted frozen session (fail-closed)", async () => {
    const dir = await tempDir();
    // harness A — freezes when the session is loaded through the manager.
    const hA = await createHarness(baseConfig({ dataDir: dir, featureFlags: { memory: false } }));
    const sessionId = await createSession(hA, "sess-drift-prod-1");
    // Load via the production path: freeze happens inside LoadedSessionManager.load.
    const actor = await hA.sessions.load(sessionId as never);
    expect(actor).toBeDefined();
    await hA.close();

    // harness B — same durable store, but memory is now ON (session_frozen widening).
    const hB = await createHarness(baseConfig({ dataDir: dir, featureFlags: { memory: true } }));
    // The same production path must now REJECT the load, never silently proceed.
    await expect(hB.sessions.load(sessionId as never)).rejects.toMatchObject({
      message: /CONFIG_DRIFT_REJECTED|config drifted/i,
    });
    await hB.close();
  });

  it("P27-4 production path: matching frozen config loads cleanly", async () => {
    const dir = await tempDir();
    const hA = await createHarness(baseConfig({ dataDir: dir }));
    const sessionId = await createSession(hA, "sess-drift-prod-2");
    await hA.sessions.load(sessionId as never);
    await hA.close();
    // harness B with the SAME effective config → no drift → load succeeds.
    const hB = await createHarness(baseConfig({ dataDir: dir }));
    const actor = await hB.sessions.load(sessionId as never);
    expect(actor).toBeDefined();
    await hB.close();
  });
});
