import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";
import type { HarnessConfig } from "./config.js";

// PKG-001 reproducer: the config-drift baseline used to be written only by
// `sessions.load`, so "create session -> change config -> first load" compared
// against NOTHING, returned severity "none", and then froze the CHANGED config
// as the new baseline. CONFIG_DRIFT_REJECTED could never fire on a session's
// first resume — which is the most common path of all.
//
// The real drift keys are private to create-harness.ts, so the tests read the
// durable state snapshot through the public store surface (`p27.*` keys).

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-pkg001-"));
  roots.push(dir);
  return dir;
}

/** Two harnesses over the SAME dataDir = "the host restarted with a different
 *  effective config". `limits.maxToolCalls` is a session_frozen key, and going
 *  50 -> 500 is a widening direction (severity: reject). */
function config(dir: string, maxToolCalls: number): HarnessConfig {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("No changes.")]);
  return {
    cwd: process.cwd(),
    dataDir: dir,
    profile: "test",
    modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    limits: { maxToolCalls },
  };
}

describe("PKG-001: the config-drift baseline is frozen at session creation", () => {
  it("writes the fingerprint into the durable snapshot before any load", async () => {
    const dir = await dataDir();
    const harness = await createHarness(config(dir, 50));
    try {
      const session = await harness.sessionService.create({
        agentId: harness.agents[0]!.id,
        model: harness.agents[0]!.model,
        cwd: harness.config.cwd,
      });
      const snapshot = await harness.store.loadStateSnapshot(session.id);
      // The baseline must exist the moment the session does — not after a load.
      expect(snapshot?.["p27.configFingerprint"]).toBe(harness.resolvedConfig.fingerprint);
      expect(typeof snapshot?.["p27.configValue"]).toBe("string");
    } finally {
      await harness.close();
    }
  });

  it("rejects the FIRST load after a frozen-config change (create -> change -> load)", async () => {
    const dir = await dataDir();
    const created = await createHarness(config(dir, 50));
    const session = await created.sessionService.create({
      agentId: created.agents[0]!.id,
      model: created.agents[0]!.model,
      cwd: created.config.cwd,
    });
    await created.close();

    // The session has never been loaded: this is its first resume.
    const widened = await createHarness(config(dir, 500));
    try {
      const drift = await widened.checkSessionConfigDrift(session.id);
      expect(drift.changed.some((item) => item.key === "limits.maxToolCalls")).toBe(true);
      await expect(widened.sessions.load(session.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i);
    } finally {
      await widened.close();
    }
  });

  it("still loads a first resume under an unchanged config", async () => {
    const dir = await dataDir();
    const created = await createHarness(config(dir, 50));
    const session = await created.sessionService.create({
      agentId: created.agents[0]!.id,
      model: created.agents[0]!.model,
      cwd: created.config.cwd,
    });
    await created.close();
    const same = await createHarness(config(dir, 50));
    try {
      await expect(same.sessions.load(session.id)).resolves.toBeDefined();
    } finally {
      await same.close();
    }
  });
});


it("review PR13: failure to persist the initial drift baseline must not publish a runnable session", async () => {
  const dir = await dataDir(); const harness = await createHarness(config(dir, 50));
  try {
    const save = harness.store.saveStateSnapshot.bind(harness.store);
    harness.store.saveStateSnapshot = async (id, snapshot) => {
      if (snapshot["p27.configFingerprint"] !== undefined) throw new Error("review simulated fingerprint write failure");
      return save(id, snapshot);
    };
    await expect(harness.sessionService.create({ agentId: harness.agents[0]!.id,
      model: harness.agents[0]!.model, cwd: harness.config.cwd })).rejects.toThrow("fingerprint write failure");
    expect((await harness.store.listSessions()).filter(session => session.status !== "failed")).toEqual([]);
  } finally { await harness.close(); }
});

it.each(["before-baseline", "after-baseline", "before-publish", "after-publish"])("restarts safely after %s in the initial configuration commit", async stage => {
  const dir = await dataDir(); const harness = await createHarness(config(dir, 50));
  const save = harness.store.saveStateSnapshot.bind(harness.store);
  const update = harness.store.updateSession.bind(harness.store);
  if (stage.endsWith("baseline")) {
    harness.store.saveStateSnapshot = async (id, snapshot) => {
      if (snapshot["p27.configFingerprint"] === undefined) return save(id, snapshot);
      if (stage === "after-baseline") await save(id, snapshot);
      throw new Error("injected baseline interruption");
    };
  } else {
    harness.store.updateSession = async session => {
      if (session.status !== "active") return update(session);
      if (stage === "after-publish") await update(session);
      throw new Error("injected publication interruption");
    };
  }
  try {
    await expect(harness.sessionService.create({ agentId: harness.agents[0]!.id,
      model: harness.agents[0]!.model, cwd: harness.config.cwd })).rejects.toThrow("interruption");
  } finally { await harness.close(); }
  const restarted = await createHarness(config(dir, 50));
  try {
    const rows = await restarted.store.listSessions(); expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe(stage === "after-publish" ? "active" : "failed");
    if (row.status === "active") {
      expect((await restarted.store.loadStateSnapshot(row.id))!["p27.configFingerprint"]).toBe(restarted.resolvedConfig.fingerprint);
    } else {
      await expect(restarted.runtime.startTurn(row.id, "must not run")).rejects.toThrow("failed");
      expect(await restarted.store.listTurns(row.id)).toEqual([]);
    }
  } finally { await restarted.close(); }
});
