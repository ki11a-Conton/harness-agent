import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it("C4 actual external summary implementation changes cannot silently resume under the same declared id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "summary-identity-"));
  const provider = new ScriptedModelProvider([]);
  const base = { cwd, dataDir: join(cwd, "state"), profile: "test" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, featureFlags: { skills: false } };
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness({ ...base, contextSummary: { mode: "external-v1", implementationId: "same-id", summarize: content => content } });
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    await harness.sessions.load(session.id);
    const original = harness.resolvedConfig.fingerprint;
    await harness.close();
    harness = await createHarness({ ...base, contextSummary: { mode: "external-v1", implementationId: "same-id", summarize: content => content.trim() } });
    expect(harness.resolvedConfig.fingerprint).not.toBe(original);
    await expect(harness.sessions.load(session.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i);
  } finally { await harness?.close(); await rm(cwd, { recursive: true, force: true }); }
});
