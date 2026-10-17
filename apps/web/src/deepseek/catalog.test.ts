import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { newToolCallId, toToolSemantics, type ModelProvider, type SessionId } from "@ar/contracts";
import { ToolOrchestrator, ToolRegistry } from "@ar/tools";
import { createCatalogService, type CatalogHost } from "./catalog.js";
import { createHostTools } from "./host-tools.js";
import { RemoteFailure } from "./transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(overrides: Partial<CatalogHost> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-catalog-real-")));
  // The discovered route's sandbox and ledger writes can still be settling when
  // the case ends, so Windows would intermittently fail the teardown itself with
  // ENOTEMPTY instead of reporting the behaviour under test.
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("actual answer")]);
  const harness = await createHarness({ cwd: directory, dataDir: directory, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  cleanup.push(() => harness.close());
  const tools = createHostTools(harness, directory, directory);
  const host: CatalogHost = { harness, cwd: directory, dataDir: directory, environment: {},
    executeHostTool: tools.executeHostTool, registerTool: tools.registerTool, executeTool: tools.executeTool,
    validateModelProfiles: async () => {}, ...overrides };
  const service = createCatalogService(host); const signal = new AbortController().signal;
  const call = (name: string, args: unknown = {}) => service.call(name, args, signal);
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: directory });
  return { directory, harness, host, service, signal, call, id: session.id };
}

it("official settings envelopes rehydrate with the exact Schemastery implementation and expose supported protocols", async () => {
  const stack = await setup();
  const described = await stack.call("settings/describe") as { writable: boolean; hasDocument: boolean; namespaces: Array<{ ns: string; schema: Schema; value: unknown; secrets: unknown[] }> };
  expect(described).toMatchObject({ writable: true, hasDocument: false });
  const models = described.namespaces.find(item => item.ns === "llm-pi-ai")!;
  const root = new Schema(models.schema);
  const profile = root.dict!.providers!.inner!;
  expect(profile.dict!.api!.list!.map(node => node.value)).toEqual(["openai-completions"]);
  expect(profile.dict!.apiKeyEnv!.meta.role).toBe("credential-ref");
  expect(profile({ api: "openai-completions", models: [{ id: "coding" }] })).toHaveProperty("models.0.id", "coding");
  expect(models.secrets).toEqual([]);
  for (const item of described.namespaces) expect(() => new Schema(item.schema)(item.value)).not.toThrow();
});

it("advertises a settings document action only with its actual host opener and honors controlled access denial", async () => {
  const unavailable = await setup();
  await expect(unavailable.call("settings/openSettingsDocument")).rejects.toMatchObject({ code: "gateway/unavailable" });
  const opened: string[] = [], available = await setup({ openSettingsDocument: async path => { opened.push(path); } });
  expect(await available.call("settings/describe")).toMatchObject({ writable: true, hasDocument: true });
  expect(await available.call("settings/openSettingsDocument")).toEqual({ opened: true });
  expect(opened).toEqual([join(available.directory, "deepseek/settings.json")]);
  const denied = await setup({ openSettingsDocument: async path => { opened.push(path); },
    executeHostTool: async () => ({ status: "denied", error: { code: "PERMISSION_DENIED", message: "Private document denied", retryable: false, safeToRetry: false } }) });
  await expect(denied.call("settings/openSettingsDocument")).rejects.toMatchObject({ code: "settings/rejected" });
  expect(opened).toHaveLength(1);
});

it("the official Preview Continue path owns its exact welcome namespace and persists acknowledgement with a revision fence", async () => {
  const stack = await setup();
  const before = await stack.call("settings/describe") as { namespaces: Array<{ ns: string; schema: Schema; value: unknown; revision: number; autoGenerate: boolean }> };
  const welcome = before.namespaces.find(item => item.ns === "ui-settings-general")!;
  expect(welcome).toMatchObject({ value: {}, revision: 0, autoGenerate: false });
  expect(new Schema(welcome.schema).dict!.welcomeNoticeVersion!.meta.volatile).toBe(true);
  const version = "2026-09-28.1"; // Exact official onboarding-copy.ts version, compared by the real client.
  expect(await stack.call("settings/mutate", { ns: "ui-settings-general", expectedRevision: 0, ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: version }] })).toMatchObject({ value: { welcomeNoticeVersion: version }, user: { welcomeNoticeVersion: version }, revision: 1 });
  const reloaded = await createCatalogService({ ...stack.host, registerTool: undefined }).call("settings/describe", {}, stack.signal) as typeof before;
  expect(reloaded.namespaces.find(item => item.ns === "ui-settings-general")).toMatchObject({ value: { welcomeNoticeVersion: version }, revision: 1 });
  await expect(stack.call("settings/mutate", { ns: "ui-settings-general", expectedRevision: 0, ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "stale-version" }] })).rejects.toMatchObject({ code: "settings/conflict" });
});

it("official Work details and Performance settings own the durable ui-chat scope across tabs and restart", async () => {
  const stack = await setup();
  const described = await stack.call("settings/describe") as { namespaces: Array<{ ns: string; schema: Schema; value: unknown; revision: number }> };
  const chat = described.namespaces.find(item => item.ns === "ui-chat");
  expect(chat).toBeDefined();
  expect(chat).toMatchObject({ revision: 0, value: { performanceUsage: "detailed", linkOpening: "sidebar" } });
  expect(() => new Schema(chat!.schema)(chat!.value)).not.toThrow();
  const updated = await stack.call("settings/mutate", { ns: "ui-chat", expectedRevision: 0,
    ops: [{ op: "set", path: ["transcriptView"], value: "compact" }, { op: "set", path: ["performanceUsage"], value: "compact" },
      { op: "set", path: ["linkOpening"], value: "new-tab" }] }) as Record<string, unknown>;
  expect(updated).toMatchObject({ revision: 1, value: { transcriptView: "compact", performanceUsage: "compact", linkOpening: "new-tab" } });
  const second = createCatalogService({ ...stack.host, registerTool: undefined });
  const reloaded = await second.call("settings/describe", {}, stack.signal) as typeof described;
  expect(reloaded.namespaces.find(item => item.ns === "ui-chat")).toMatchObject(updated);
  await expect(second.call("settings/mutate", { ns: "ui-chat", expectedRevision: 0,
    ops: [{ op: "set", path: ["transcriptView"], value: "verbose" }] }, stack.signal)).rejects.toMatchObject({ code: "settings/conflict" });
  await expect(stack.call("settings/update", { ns: "ui-chat", patch: { performanceUsage: "invented" } })).rejects.toMatchObject({ code: "settings/rejected" });
});

it("stored credentials never cross read DTOs, tool output previews or event logs, and persist with private mode", async () => {
  const published: Array<unknown> = [];
  const stack = await setup({ publish: (topic, args) => published.push([topic, args]) });
  const secret = "unique-private-value-923487";
  await stack.call("credentials/set", { ref: "LOCAL_API_KEY", value: secret });
  expect(await stack.call("credentials/describe", { refs: ["LOCAL_API_KEY", "MISSING_API_KEY"] })).toEqual({ LOCAL_API_KEY: { configured: true, source: "file", writable: true }, MISSING_API_KEY: { configured: false, writable: true } });
  expect(published).toEqual([["credentials/reference-updated", ["LOCAL_API_KEY"]]]);
  const events = (await Promise.all((await stack.harness.store.listSessions()).map(row => stack.harness.events.list(row.id)))).flat();
  expect(events.some(event => event.type === "tool.intent_persisted" && event.payload.tool === "web_credentials_write")).toBe(true);
  expect(JSON.stringify(events)).not.toContain(secret);
  const path = join(stack.directory, "deepseek", "credentials.json");
  expect(JSON.parse(await readFile(path, "utf8")).values.LOCAL_API_KEY).toBe(secret);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
  const second = createCatalogService({ ...stack.host, registerTool: undefined });
  expect(await second.call("credentials/describe", { refs: ["LOCAL_API_KEY"] }, stack.signal)).toEqual({ LOCAL_API_KEY: { configured: true, source: "file", writable: true } });
  await stack.call("credentials/unset", { ref: "LOCAL_API_KEY" });
  expect(await stack.call("credentials/describe", { refs: ["LOCAL_API_KEY"] })).toEqual({ LOCAL_API_KEY: { configured: false, writable: true } });
});

it("actual environment and launch layers reject shadowed writes without pretending a stored key became effective", async () => {
  const stack = await setup({ environment: { ENV_API_KEY: "env-secret" }, initialCredentials: { LAUNCH_API_KEY: "launch-secret" } });
  expect(await stack.call("credentials/describe", { refs: ["ENV_API_KEY", "LAUNCH_API_KEY"] })).toEqual({ ENV_API_KEY: { configured: true, source: "env", writable: false }, LAUNCH_API_KEY: { configured: true, source: "launch", writable: false } });
  await expect(stack.call("credentials/set", { ref: "ENV_API_KEY", value: "new-secret" })).rejects.toMatchObject({ code: "credential/rejected" });
  await expect(stack.call("credentials/unset", { ref: "LAUNCH_API_KEY" })).rejects.toMatchObject({ code: "credential/rejected" });
  await expect(readFile(join(stack.directory, "deepseek", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("credential presence and resolution never treat inherited object methods as environment secrets", async () => {
  const stack = await setup();
  expect(await stack.call("credentials/describe", { refs: ["toString", "valueOf"] })).toEqual({ toString: { configured: false, writable: true }, valueOf: { configured: false, writable: true } });
  await stack.call("credentials/set", { ref: "toString", value: "actual-stored-value" });
  expect(await stack.call("credentials/describe", { refs: ["toString"] })).toEqual({ toString: { configured: true, source: "file", writable: true } });
});

it("the actual frozen-owner credential validator refuses rotation before persistence or change notification", async () => {
  let locked = false; const published: unknown[] = [];
  const stack = await setup({ publish: (topic, args) => published.push([topic, args]), validateCredentials: async (values, prior) => {
    if (locked && values.FROZEN_API_KEY !== prior.FROZEN_API_KEY) throw new RemoteFailure("credential/rejected", "The credential is referenced by a frozen model owner", { ref: "FROZEN_API_KEY" });
  } });
  await stack.call("credentials/set", { ref: "FROZEN_API_KEY", value: "original-frozen-secret" }); locked = true;
  const path = join(stack.directory, "deepseek", "credentials.json"); const before = await readFile(path, "utf8");
  await expect(stack.call("credentials/set", { ref: "FROZEN_API_KEY", value: "rotated-secret" })).rejects.toMatchObject({ code: "credential/rejected" });
  await expect(stack.call("credentials/unset", { ref: "FROZEN_API_KEY" })).rejects.toMatchObject({ code: "credential/rejected" });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(published).toEqual([["credentials/reference-updated", ["FROZEN_API_KEY"]]]);
  await stack.call("credentials/set", { ref: "UNUSED_API_KEY", value: "fresh-secret" });
  expect(JSON.parse(await readFile(path, "utf8")).values.UNUSED_API_KEY).toBe("fresh-secret");
});

it("cross-tab revision fences and ordered path operations preserve committed fields on restart", async () => {
  const stack = await setup(); const second = createCatalogService({ ...stack.host, registerTool: undefined });
  const writes = await Promise.allSettled([
    stack.call("settings/mutate", { ns: "ui-theme", ops: [{ op: "set", path: ["fontSize"], value: 16 }], expectedRevision: 0 }),
    second.call("settings/update", { ns: "ui-theme", patch: { preference: "dark" }, expectedRevision: 0 }, stack.signal),
  ]);
  expect(writes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(writes.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "settings/conflict", details: { expected: 0, actual: 1 } } });
  const result = await stack.call("settings/mutate", { ns: "ui-theme", ops: [{ op: "set", path: ["preference"], value: "dark" }, { op: "set", path: ["fontSize"], value: 18 }], expectedRevision: 1 }) as { revision: number; value: unknown };
  expect(result).toMatchObject({ revision: 2, value: { preference: "dark", fontSize: 18 } });
  const reloaded = await second.call("settings/describe", {}, stack.signal) as { namespaces: Array<{ ns: string; revision: number; value: unknown }> };
  expect(reloaded.namespaces.find(item => item.ns === "ui-theme")).toMatchObject(result);
});

it("unsafe paths, secret-bearing settings, unsupported schema values and malformed credentials fail before document writes", async () => {
  const stack = await setup();
  const invalid = [
    ["settings/mutate", { ns: "ui-theme", ops: [{ op: "set", path: ["__proto__", "polluted"], value: true }] }],
    ["settings/update", { ns: "ui-theme", patch: { fontSize: 999 } }],
    ["settings/update", { ns: "llm-pi-ai", patch: { providers: { gateway: { api: "openai-completions", baseURL: "http://user:secret@localhost/v1", models: [{ id: "coding" }] } } } }],
    ["settings/update", { ns: "llm-pi-ai", patch: { providers: { gateway: { apiKey: "DO-NOT-PERSIST", models: [{ id: "coding" }] } } } }],
    ["credentials/set", { ref: "BAD-REF", value: "key" }],
    ["credentials/set", { ref: "KEY", value: "line\nbreak" }],
    ["credentials/describe", { refs: Array.from({ length: 65 }, () => "KEY") }],
  ] as const;
  for (const [name, args] of invalid) await expect(stack.call(name, args)).rejects.toBeDefined();
  await expect(readFile(join(stack.directory, "deepseek", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(stack.directory, "deepseek", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(Object.prototype).not.toHaveProperty("polluted");
});

it("serviceable fresh-session profiles persist references while only the internal resolver obtains actual secret values", async () => {
  const seen: unknown[] = [];
  const stack = await setup({ validateModelProfiles: async profiles => { seen.push(structuredClone(profiles)); } });
  await stack.call("credentials/set", { ref: "GATEWAY_API_KEY", value: "gateway-secret-value" });
  const result = await stack.call("settings/mutate", { ns: "llm-pi-ai", expectedRevision: 0, ops: [{ op: "set", path: ["providers", "gateway"], value: { api: "openai-completions", baseURL: "http://127.0.0.1:3456/v1", apiKeyEnv: "GATEWAY_API_KEY", models: [{ id: "coding", name: "Coding" }] } }] });
  expect(JSON.stringify(result)).not.toContain("gateway-secret-value");
  expect(JSON.stringify(seen)).not.toContain("gateway-secret-value");
  expect(await stack.service.resolvedModelProfiles(stack.signal)).toMatchObject({ gateway: { apiKey: "gateway-secret-value", baseURL: "http://127.0.0.1:3456/v1", models: [{ id: "coding" }] } });
  expect(await stack.call("llm/listConfigurableProviders")).toContainEqual({ provider: "gateway", displayName: "gateway", settingsNs: "llm-pi-ai", settingsPath: ["providers", "gateway"], declared: true });
  expect(await stack.call("session/modelCatalog")).toMatchObject({ groups: expect.arrayContaining([{ id: "gateway", name: "gateway", models: [{ id: "coding", name: "Coding" }] }]) });
});

it("a custom route missing its credential is not advertised as routable until the key is actually available", async () => {
  const stack = await setup();
  await stack.call("settings/mutate", { ns: "llm-pi-ai", ops: [{ op: "set", path: ["providers", "gateway"], value: {
    api: "openai-completions", baseURL: "http://127.0.0.1:3456/v1", apiKeyEnv: "GATEWAY_API_KEY", models: [{ id: "coding" }],
  } }] });
  const missing = await stack.call("session/modelCatalog") as { routableProviders: string[]; failures: Array<{ id: string; message: string }> };
  expect(missing.routableProviders).not.toContain("gateway");
  expect(missing.failures).toContainEqual({ id: "gateway", name: "gateway", message: "The configured adapter or credential is unavailable" });
  await stack.call("credentials/set", { ref: "GATEWAY_API_KEY", value: "real-available-secret" });
  expect(await stack.call("session/modelCatalog")).toMatchObject({ routableProviders: expect.arrayContaining(["gateway"]), failures: [] });
});

it("model catalogs use actual provider directories and keep native frozen session identity unchanged", async () => {
  const realDirectory: ModelProvider = { id: "external", async listModels() { return [{ id: "coding", name: "Coding" }]; }, createClient() { throw new Error("not invoked by discovery"); } };
  const stack = await setup({ providers: [realDirectory] });
  expect(await stack.call("session/modelCatalog")).toEqual({ default: { provider: stack.harness.config.model.providerId, model: "scripted-model" }, groups: [{ id: "external", name: "external", models: [{ id: "coding", name: "Coding" }] }], routableProviders: ["external"], failures: [] });
  expect(await stack.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "external" } })).toEqual([{ id: "coding", name: "Coding" }]);
  await expect(stack.call("session/selectModel", { request: { sessionId: stack.id, provider: "external", model: "coding" } })).rejects.toMatchObject({ code: "session/model-unavailable" });
  expect((await stack.harness.store.getSession(stack.id))?.model).toEqual(stack.harness.config.model);
  await expect(stack.call("session/selectModel", { request: { sessionId: "unowned", provider: "external", model: "coding" } })).rejects.toMatchObject({ code: "session/not-found" });
});

it("existing exact selection is idempotent; unknown or unsupported reasoning selections visibly reject", async () => {
  const stack = await setup(); const selection = { provider: stack.harness.config.model.providerId, model: "scripted-model" };
  expect(await stack.call("session/selectModel", { request: { sessionId: stack.id, ...selection } })).toEqual({ selected: selection });
  await expect(stack.call("session/selectModel", { request: { sessionId: stack.id, ...selection, model: "invented" } })).rejects.toMatchObject({ code: "session/model-unavailable" });
  await expect(stack.call("session/selectModel", { request: { sessionId: stack.id, ...selection, reasoningEffort: "high" } })).rejects.toMatchObject({ code: "session/model-unavailable" });
});

it("network discovery executes through the orchestrator, deduplicates actual HTTP models, and never persists one-shot credentials", async () => {
  let calls = 0; let received = "";
  const server = createServer((request, response) => { calls++; received = request.headers.authorization ?? ""; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "coding", name: "Local coding" }, { id: "coding" }, { id: "other" }] })); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("No loopback address");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const stack = await setup(); const registry = new ToolRegistry(); const executor = new ToolOrchestrator({ registry, workspaceRoot: stack.directory });
  const service = createCatalogService({ ...stack.host, registerTool: definition => registry.register(definition), executeTool: async (_session, name, args, signal) => {
    const definition = registry.get(name)!; const id = newToolCallId(); const agent = stack.harness.agents[0]!;
    return executor.executeBound({ id, sessionId: stack.id, agentId: agent.id, call: { id, name, args }, binding: { name, definition,
      spec: { name, description: definition.description, inputSchema: {} }, semantics: toToolSemantics(definition.metadata, definition.risk), provenance: { kind: "builtin" } } },
    { sessionId: stack.id as SessionId, agentId: agent.id, cwd: stack.directory, signal, permissions: { defaultEffect: "deny", rules: [{ action: "exec", resource: "network", effect: "allow" }] },
      sandboxPolicy: { filesystem: { mode: "read-only" }, network: { mode: "allowlist", hosts: ["127.0.0.1"] }, process: {} } });
  } });
  expect(await service.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { api: "openai-completions", baseURL, apiKey: "one-shot-private-key" } }, stack.signal)).toEqual([{ id: "coding", name: "Local coding" }, { id: "other" }]);
  expect(calls).toBe(1); expect(received).toBe("Bearer one-shot-private-key");
  await expect(readFile(join(stack.directory, "deepseek", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  // The settings dialog runs this call for the local human, with no model session
  // behind it, so it must reach the endpoint instead of opening an approval the
  // dialog has no surface to show. Before this regression the dialog waited out
  // that approval and then reported "Provider discovery was refused by the host
  // or failed" while the endpoint was never contacted.
  expect(await stack.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { baseURL, apiKey: "one-shot-private-key" } })).toEqual([{ id: "coding", name: "Local coding" }, { id: "other" }]);
  expect(calls).toBe(2); expect(received).toBe("Bearer one-shot-private-key");
  await expect(readFile(join(stack.directory, "deepseek", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  type Approval = Parameters<typeof stack.harness.approvalStore.create>[0];
  let notify!: (request: Approval) => void;
  const created = new Promise<Approval>(done => { notify = done; });
  const create = stack.harness.approvalStore.create.bind(stack.harness.approvalStore);
  stack.harness.approvalStore.create = request => { const pending = create(request); notify(request); return pending; };
  // A session-scoped caller is still gated, so the dialog's click authorises only
  // the dialog and never a model session's network access.
  const scoped = stack.host.executeTool!(stack.id, "web_model_discovery", { url: `${baseURL}/models`, ticket: "00000000-0000-4000-8000-000000000000" }, stack.signal);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const approval = await Promise.race([created,
      scoped.then(() => { throw new Error('Discovery bypassed its required approval'); }, error => { throw error; }),
      new Promise<never>((_done, reject) => { deadline = setTimeout(() => reject(new Error('Discovery did not create its approval within 10s')), 10_000); }),
    ]);
    expect(stack.harness.approvalStore.listPending()).toContainEqual(approval);
    stack.harness.approvalStore.resolve(approval.id, "deny", "test");
    await expect(scoped).resolves.toMatchObject({ status: "denied", error: { code: "APPROVAL_DENIED" } });
  } finally {
    clearTimeout(deadline);
    stack.harness.approvalStore.create = create;
  }
  expect(calls).toBe(2);
});

it("caller cancellation settles pending provider discovery without leaking its eventual error", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_done, refused) => { reject = refused; });
  const provider: ModelProvider = { id: "gated", listModels: () => pending, createClient() { throw new Error("not called"); } };
  const stack = await setup({ providers: [provider] }); const controller = new AbortController();
  const call = stack.service.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "gated" } }, controller.signal);
  controller.abort(); await expect(call).rejects.toBeDefined();
  reject(new Error("late-private-provider-error"));
});

it("cancelling a queued settings request settles promptly while its document slot stays ordered", async () => {
  const stack = await setup(); const execute = stack.host.executeHostTool;
  let release!: () => void, entered!: () => void, first = true;
  const gate = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { entered = done; });
  stack.host.executeHostTool = async (sessionId, definition, args, signal) => {
    if (definition.name === "web_settings_read" && first) { first = false; entered(); await gate; }
    return execute(sessionId, definition, args, signal);
  };
  const blocked = stack.call("settings/describe"); await started;
  const controller = new AbortController();
  const queued = stack.service.call("settings/update", { ns: "ui-theme", patch: { preference: "dark" } }, controller.signal);
  const third = stack.call("settings/describe"); let thirdSettled = false; void third.then(() => { thirdSettled = true; });
  controller.abort();
  try {
    const cancelled = await Promise.race([queued.then(() => false, () => true), new Promise<boolean>(done => setTimeout(() => done(false), 100))]);
    expect(cancelled).toBe(true); expect(thirdSettled).toBe(false);
  } finally { release(); await blocked; await queued.catch(() => {}); }
  const after = await third as { namespaces: Array<{ ns: string; value: Record<string, unknown>; revision: number }> };
  expect(after.namespaces.find(row => row.ns === "ui-theme")).toMatchObject({ revision: 0, value: { preference: "system" } });
  await expect(readFile(join(stack.directory, "deepseek", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("a failed provider remains registered and produces an isolated safe catalog diagnostic", async () => {
  const provider: ModelProvider = { id: "broken", async listModels() { throw new Error("provider-secret-that-must-not-return"); }, createClient() { throw new Error("not called"); } };
  const stack = await setup({ providers: [provider] });
  expect(await stack.call("llm/listProviders")).toEqual([{ id: "broken", name: "broken" }]);
  expect(await stack.call("session/modelCatalog")).toMatchObject({ groups: [], failures: [{ id: "broken", name: "broken", message: "Provider model catalog could not be loaded" }] });
  await expect(stack.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "broken" } })).rejects.toMatchObject({ code: "llm/model-discovery-rejected", message: "Provider model catalog could not be loaded" });
});

it("a symlinked credential document cannot be read or replaced through the private host boundary", async () => {
  if (process.platform === "win32") return; // Real Windows symbolic-link privileges are exercised by the platform acceptance job.
  const stack = await setup();
  await stack.call("settings/update", { ns: "ui-theme", patch: { preference: "dark" } });
  const outside = join(stack.directory, "outside-credential.json");
  await writeFile(outside, JSON.stringify({ version: 1, revision: 0, values: { SECRET: "untouched" } }), { mode: 0o600 });
  await symlink(outside, join(stack.directory, "deepseek", "credentials.json"));
  await expect(stack.call("credentials/describe", { refs: ["SECRET"] })).rejects.toMatchObject({ code: "credential/rejected" });
  await expect(stack.call("credentials/set", { ref: "SECRET", value: "replace" })).rejects.toMatchObject({ code: "credential/rejected" });
  expect(JSON.parse(await readFile(outside, "utf8")).values.SECRET).toBe("untouched");
});

it("missing fresh-session owner, unknown endpoints, unexpected parameters and pre-cancellation fail closed", async () => {
  const stack = await setup({ validateModelProfiles: undefined });
  await expect(stack.call("settings/update", { ns: "llm-pi-ai", patch: { providers: {} } })).rejects.toMatchObject({ code: "settings/rejected" });
  await expect(stack.call("settings/unknown")).rejects.toMatchObject({ code: "gateway/not-found" });
  await expect(stack.call("settings/describe", { accidental: true })).rejects.toMatchObject({ code: "gateway/bad-request" });
  const controller = new AbortController(); controller.abort();
  await expect(stack.service.call("credentials/set", { ref: "NEVER_API_KEY", value: "never" }, controller.signal)).rejects.toBeDefined();
  await expect(readFile(join(stack.directory, "deepseek", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
