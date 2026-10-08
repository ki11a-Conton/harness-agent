import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_TOKEN_ESTIMATOR, hashRuleContent } from "@ar/context";
import { ScriptedModelProvider } from "@ar/model";
import type { ModelRequest } from "@ar/contracts";
import { createHarness, DEFAULT_MAIN_SYSTEM_PROMPT } from "./create-harness.js";
import { createCodingPromptPolicy, resolveAgentPromptPolicy } from "./coding-prompt-policy.js";
import { subagentDefinition, workerAgentDefinition } from "./worker-agent.js";
import { DEFAULT_CONTEXT_BUDGET, type HarnessConfig } from "./config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function config(dataDir?: string): Promise<HarnessConfig> {
  const cwd = await mkdtemp(join(tmpdir(), "harness-prompt-")); roots.push(cwd);
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("No changes.")]);
  return { cwd, ...(dataDir === undefined ? {} : { dataDir }), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } };
}

it("policy selector defaults to unchanged legacy and rejects unsupported/empty values", () => {
  expect(resolveAgentPromptPolicy()).toBeUndefined();
  expect(resolveAgentPromptPolicy("legacy")).toBeUndefined();
  expect(resolveAgentPromptPolicy("coding-v1")).toEqual(createCodingPromptPolicy());
  for (const value of ["", "coding-v2", "CODING-V1", " coding-v1 "]) {
    expect(() => resolveAgentPromptPolicy(value)).toThrow("Unsupported HARNESS_AGENT_PROMPT");
  }
  expect(Object.isFrozen(createCodingPromptPolicy())).toBe(true);
});
it("benchmark/test defaults preserve the original primary and worker prompts byte for byte", async () => {
  expect(hashRuleContent(DEFAULT_MAIN_SYSTEM_PROMPT)).toBe("66cd48195dc8b44cb40922d0b4072a940b0b649ab2c419f98465e71d24486e14");
  for (const profile of ["test", "benchmark"] as const) {
    const c = { ...await config(), profile };
    const h = await createHarness(c);
    try {
      expect(h.agents[0]!.systemPrompt).toBe(DEFAULT_MAIN_SYSTEM_PROMPT);
      expect(h.resolvedConfig.value).not.toHaveProperty("agentPromptPolicy");
      expect(subagentDefinition(c).systemPrompt).toBe("You are a subagent working inside a delegated session. Complete the goal and report findings.");
      expect(workerAgentDefinition(c).systemPrompt).toBe("You are a write-capable worker in an ISOLATED copy of the parent workspace. Make the requested changes in this workspace only. On success they are merged back under conflict detection.");
    } finally { await h.close(); }
  }
});
it("changing policy text changes frozen config; same version alone cannot silently resume", async () => {
  const c = await config(); const dataDir = join(c.cwd, "data");
  const policy = createCodingPromptPolicy();
  const first = await createHarness({ ...c, dataDir, agentPromptPolicy: policy });
  const session = await first.runtime.createSession({ agent: first.agents[0]!, cwd: c.cwd });
  await first.sessions.load(session.id);
  const fingerprint = first.resolvedConfig.fingerprint;
  await first.close();
  const matching = await createHarness({ ...c, dataDir, agentPromptPolicy: createCodingPromptPolicy() });
  try {
    expect(matching.resolvedConfig.fingerprint).toBe(fingerprint);
    await expect(matching.sessions.load(session.id)).resolves.toBeDefined();
  } finally { await matching.close(); }
  const changed = await createHarness({ ...c, dataDir, agentPromptPolicy: { ...policy, primary: `${policy.primary}\nChanged text, same version.` } });
  try {
    expect(changed.resolvedConfig.fingerprint).not.toBe(fingerprint);
    const drift = await changed.checkSessionConfigDrift(session.id);
    expect(drift.changed.some(item => item.key === "agentPromptPolicy.primary" && item.lifecycle === "session_frozen")).toBe(true);
    await expect(changed.sessions.load(session.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i);
  } finally { await changed.close(); }
});
it("old durable sessions reject a new policy and can resume with explicit legacy rollback", async () => {
  const c = await config(); const dataDir = join(c.cwd, "data");
  const first = await createHarness({ ...c, dataDir });
  const session = await first.runtime.createSession({ agent: first.agents[0]!, cwd: c.cwd });
  await first.sessions.load(session.id); await first.close();
  const upgraded = await createHarness({ ...c, dataDir, agentPromptPolicy: createCodingPromptPolicy() });
  try { await expect(upgraded.sessions.load(session.id)).rejects.toThrow(/CONFIG_DRIFT_REJECTED|config drifted/i); }
  finally { await upgraded.close(); }
  const rollback = await createHarness({ ...c, dataDir });
  try { await expect(rollback.sessions.load(session.id)).resolves.toBeDefined(); }
  finally { await rollback.close(); }
});
it("new prompts fit the existing fallback system reserve and keep the exact champion suffix on actual requests", async () => {
  const c = await config(); const policy = createCodingPromptPolicy();
  const suffix = "EXACT_CHAMPION_SUFFIX_FOR_WIRING_TEST\nKeep these bytes.";
  for (const prompt of [policy.primary, policy.readonlyWorker, policy.writeWorker]) {
    expect(DEFAULT_TOKEN_ESTIMATOR.estimate(prompt)).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.reserved.system);
  }
  const requests: ModelRequest[] = []; const original = c.modelProvider.createClient.bind(c.modelProvider);
  c.modelProvider.createClient = (model, cfg) => {
    const client = original(model, cfg);
    return { async *generate(request, signal) { requests.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  await writeFile(join(c.cwd, "AGENTS.md"), "Project convention: keep public exports stable.\n");
  const h = await createHarness({ ...c, agentPromptPolicy: policy, completionGuidance: suffix });
  try {
    expect(h.agents[0]!.systemPrompt).toBe(`${policy.primary}\n\n${suffix}`);
    const explain = h.configExplain("agentPromptPolicy.primary").entries[0]!;
    expect(explain.lifecycle).toBe("session_frozen"); expect(explain.origin?.source).toBe("runtime");
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd: c.cwd });
    const turn = await h.runtime.startTurn(session.id, "Inspect the workspace");
    await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(requests[0]!.system).toContain(`${policy.primary}\n\n${suffix}`);
    expect(requests[0]!.system).toContain("Project convention: keep public exports stable.");
  } finally { await h.close(); }
});
it("worker prompt improvements leave actual tool permissions and limits unchanged", async () => {
  const c = await config(); const improved = { ...c, agentPromptPolicy: createCodingPromptPolicy() };
  for (const builder of [subagentDefinition, workerAgentDefinition]) {
    const legacy = builder(c); const next = builder(improved);
    expect(next.tools).toEqual(legacy.tools); expect(next.permissions).toEqual(legacy.permissions); expect(next.limits).toEqual(legacy.limits);
    expect(next.systemPrompt).toContain("Policy: coding-v1");
  }
  expect(subagentDefinition(improved).systemPrompt).not.toMatch(/^- (write_file|edit_file|exec|update_plan):/m);
});
