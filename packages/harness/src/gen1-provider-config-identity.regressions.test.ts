import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import type { ModelProvider } from "@ar/contracts";
import { createHarness } from "./create-harness.js";
import { resolveConfig, resolveHarnessConfig } from "./config-resolver.js";
import { hashOf, runtimeLayer, stableSerialize } from "./config-layers.js";

const model = { providerId: "scripted", modelId: "scripted-model" };
const makeProvider = () => new ScriptedModelProvider([ScriptedModelProvider.text("answer")]);

it("declared provider identity permits restarting with the same executed instance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-provider-restart-"));
  const provider = makeProvider();
  const config = { cwd, dataDir: join(cwd, "data"), profile: "test" as const, modelProvider: provider, model };
  let harness = await createHarness(config);
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const actor = await harness.sessions.load(session.id);
    const handle = await actor.startTurn({ sessionId: session.id, text: "inspect" });
    expect((await handle.outcome).status).toBe("completed");
    expect(provider.calls).toEqual([0]); // Runtime keeps the original instance.
    await harness.close();
    harness = await createHarness(config);
    expect((await harness.checkSessionConfigDrift(session.id)).severity).toBe("none");
    await expect(harness.sessions.load(session.id)).resolves.toBeDefined();
  } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});

it("same provider ID with different declared script configuration still rejects resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-provider-change-"));
  const provider = makeProvider();
  const config = { cwd, dataDir: join(cwd, "data"), profile: "test" as const, modelProvider: provider, model };
  let harness = await createHarness(config);
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    await harness.sessions.load(session.id);
    await harness.close();
    provider.scripts.splice(0, 1, ScriptedModelProvider.text("different configured behavior"));
    harness = await createHarness(config);
    const drift = await harness.checkSessionConfigDrift(session.id);
    expect(drift.severity).toBe("reject");
    expect(drift.changed.map(change => change.key)).toContain("modelProvider.configIdentity.scripts");
    await expect(harness.sessions.load(session.id)).rejects.toMatchObject({ info: { code: "CONFIG_DRIFT_REJECTED" } });
  } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});

it("undeclared provider own configuration remains fail-closed for a same-ID endpoint change", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-provider-unknown-"));
  const provider = { id: "unknown-provider", endpoint: "http://first.invalid", policy: { retries: 2 },
    async listModels() { return []; }, createClient() { throw new Error("must not execute"); } };
  const config = { cwd, dataDir: join(cwd, "data"), profile: "test" as const, modelProvider: provider, model: { providerId: provider.id, modelId: "unknown-model" } };
  let harness = await createHarness(config);
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    await harness.sessions.load(session.id); await harness.close();
    provider.endpoint = "http://second.invalid";
    harness = await createHarness(config);
    const drift = await harness.checkSessionConfigDrift(session.id);
    expect(drift.severity).toBe("reject");
    expect(drift.changed.map(change => change.key)).toContain("modelProvider.endpoint");
    await expect(harness.sessions.load(session.id)).rejects.toMatchObject({ info: { code: "CONFIG_DRIFT_REJECTED" } });
  } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});

it("resolved fingerprint and persisted configuration use one detached immutable capture", () => {
  const provider = { id: "unknown-provider", options: [{ retries: 2 }], async listModels() { return []; }, createClient() { throw new Error("unused"); } };
  const resolved = resolveHarnessConfig({ profile: "test", overrides: { profile: "test", cwd: "/fixture", modelProvider: provider, model } });
  const initial = stableSerialize(resolved.value);
  provider.options[0]!.retries = 9;
  provider.options.push({ retries: 4 });
  expect(stableSerialize(resolved.value)).toBe(initial);
  expect(hashOf(stableSerialize(resolved.value))).toBe(resolved.fingerprint);
  expect(Object.isFrozen(resolved.value)).toBe(true);
  expect(Object.isFrozen((resolved.value.modelProvider as unknown as typeof provider).options)).toBe(true);
});

it("ordinary provider serialization retains the existing P27 hash format", () => {
  const provider = { id: "ordinary-provider", endpoint: "http://offline.invalid", options: [{ retries: 2 }],
    async listModels() { return []; }, createClient() { throw new Error("unused"); } };
  const config = { cwd: "/fixture", profile: "test" as const, modelProvider: provider, model };
  const expected = hashOf(stableSerialize(config));
  const resolved = resolveConfig([runtimeLayer(config)]);
  expect(resolved.fingerprint).toBe(expected);
  expect(stableSerialize(resolved.value)).toBe(stableSerialize(config));
});

it("programmatic scripted sources keep the undeclared provider fallback", () => {
  const provider: ModelProvider = new ScriptedModelProvider([(async function* () { yield* ScriptedModelProvider.text("answer"); })()]);
  const resolved = resolveConfig([runtimeLayer({ cwd: "/fixture", profile: "test", modelProvider: provider, model })]);
  expect(resolved.value.modelProvider).toHaveProperty("index", 0);
  expect(resolved.value.modelProvider).toHaveProperty("calls", []);
});

it.each([
  ["function", () => ({ execution: () => "mutable callback" })],
  ["cycle", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
  ["getter", () => Object.defineProperty({}, "endpoint", { enumerable: true, get() { throw new Error("identity getter must not execute"); } })],
])("invalid declared identity (%s) fails closed", (_name, identity) => {
  const provider = { id: "invalid-identity", getConfigIdentity: identity,
    async listModels() { return []; }, createClient() { throw new Error("unused"); } };
  expect(() => resolveConfig([runtimeLayer({ cwd: "/fixture", profile: "test", modelProvider: provider, model })])).toThrow(TypeError);
});

it("a function nested in an array script does not silently opt into stable identity", () => {
  const script = ScriptedModelProvider.text("answer");
  (script[1] as unknown as Record<string, unknown>).callback = () => "runtime-dependent";
  const provider = new ScriptedModelProvider([script]);
  const resolved = resolveConfig([runtimeLayer({ cwd: "/fixture", profile: "test", modelProvider: provider, model })]);
  expect(resolved.value.modelProvider).toHaveProperty("index", 0);
});

it("array subclasses with procedural iterators do not silently declare data-only scripts", () => {
  class ProceduralScript extends Array<ReturnType<typeof ScriptedModelProvider.text>[number]> {
    override *[Symbol.iterator]() { yield* ScriptedModelProvider.text("runtime-dependent response"); return undefined; }
  }
  const script = new ProceduralScript(...ScriptedModelProvider.text("captured data"));
  const provider = new ScriptedModelProvider([script]);
  const resolved = resolveConfig([runtimeLayer({ cwd: "/fixture", profile: "test", modelProvider: provider, model })]);
  expect(resolved.value.modelProvider).toHaveProperty("index", 0);
});
