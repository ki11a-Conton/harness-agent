import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@ar/contracts";
import { DEFAULT_TOKEN_ESTIMATOR } from "@ar/context";
import { createHarness } from "./create-harness.js";
import { createCodingPromptPolicy, resolveAgentPromptPolicy } from "./coding-prompt-policy.js";

it("v2 fits reserve, reaches actual SDK requests, and rejects v1 session resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coding-v2-"));
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: "offline-v2", listModels: async () => [], createClient: () => ({ generate: async function* (request) {
    requests.push(request); yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "offline fixture" } };
  } }) };
  const config = { cwd: dir, dataDir: join(dir, "state"), profile: "test" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "fixture" }, featureFlags: { skills: false, learning: false } };
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const policy = resolveAgentPromptPolicy("coding-v2")!;
    expect(policy.version).toBe("coding-v2"); expect(policy).toEqual(createCodingPromptPolicy("coding-v2"));
    for (const text of [policy.primary, policy.readonlyWorker, policy.writeWorker]) expect(DEFAULT_TOKEN_ESTIMATOR.estimate(text)).toBeLessThanOrEqual(1500);
    harness = await createHarness({ ...config, agentPromptPolicy: policy });
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    const turn = await harness.runtime.startTurn(session.id, "Inspect this fixture");
    expect((await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(10000))).status).toBe("completed");
    expect(requests[0]?.system).toContain(policy.primary);
    await harness.sessions.load(session.id); await harness.close();
    harness = await createHarness({ ...config, agentPromptPolicy: createCodingPromptPolicy() });
    await expect(harness.sessions.load(session.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i);
  } finally { await harness?.close(); await rm(dir, { recursive: true, force: true }); }
});
