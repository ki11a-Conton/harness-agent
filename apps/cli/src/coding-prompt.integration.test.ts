import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createDefaultDeps, DEFAULT_SYSTEM_PROMPT } from "./main.js";
import { runCommand } from "./commands.js";
import { createCodingPromptPolicy } from "@ar/harness";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "cli-prompt-")); roots.push(cwd);
  const requests: ModelRequest[] = [];
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Inspection complete; no code changed.")]);
  const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { requests.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  return { cwd, provider, requests };
}

it("P02: CLI exported default is the base prompt actually sent to the model", async () => {
  vi.stubEnv("HARNESS_AGENT_PROMPT", "legacy");
  const f = await fixture();
  const deps = await createDefaultDeps({ cwd: f.cwd, provider: f.provider });
  try {
    await runCommand(["run", f.cwd, "Inspect this workspace."], deps);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests[0]!.system).toContain(DEFAULT_SYSTEM_PROMPT);
  } finally { await deps.close?.(); }
});

it("CLI installs opt-in policy in config and the actual model request", async () => {
  vi.stubEnv("HARNESS_AGENT_PROMPT", "coding-v1");
  const f = await fixture(); const policy = createCodingPromptPolicy();
  const deps = await createDefaultDeps({ cwd: f.cwd, provider: f.provider });
  try {
    expect(deps.resolvedConfig?.value.agentPromptPolicy).toEqual(policy);
    expect(deps.introspection.features.delegation).toBe(false);
    await runCommand(["run", f.cwd, "Inspect this workspace."], deps);
    expect(f.requests[0]!.system).toContain(policy.primary);
    expect(f.requests[0]!.system).not.toContain(DEFAULT_SYSTEM_PROMPT);
  } finally { await deps.close?.(); }
});
it("explicit legacy overrides the environment without adding a frozen config key", async () => {
  vi.stubEnv("HARNESS_AGENT_PROMPT", "coding-v1");
  const f = await fixture();
  const deps = await createDefaultDeps({ cwd: f.cwd, provider: f.provider, agentPrompt: "legacy" });
  try {
    expect(deps.resolvedConfig?.value).not.toHaveProperty("agentPromptPolicy");
    await runCommand(["run", f.cwd, "Inspect this workspace."], deps);
    expect(f.requests[0]!.system).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(f.requests[0]!.system).not.toContain("Policy: coding-v1");
  } finally { await deps.close?.(); }
});
it("invalid selection rejects startup before the provider is used", async () => {
  vi.stubEnv("HARNESS_AGENT_PROMPT", "typo");
  const f = await fixture(); const list = vi.spyOn(f.provider, "listModels"); const client = vi.spyOn(f.provider, "createClient");
  await expect(createDefaultDeps({ cwd: f.cwd, provider: f.provider })).rejects.toThrow("Unsupported HARNESS_AGENT_PROMPT");
  expect(list).not.toHaveBeenCalled(); expect(client).not.toHaveBeenCalled();
});
