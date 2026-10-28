import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createCatalogService, type CatalogHost } from "./catalog.js";
import { createHostTools } from "./host-tools.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function setup(baseURL: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-discovery-credentials-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("not called")]);
  const harness = await createHarness({ cwd: directory, dataDir: directory, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  cleanup.push(() => harness.close());
  const signal = new AbortController().signal;
  const calls: Array<Record<string, unknown>> = [];
  const service = (overrides: Partial<CatalogHost> = {}) => {
    const tools = createHostTools(harness, directory, directory);
    return createCatalogService({ harness, cwd: directory, dataDir: directory, environment: {},
      initialProviderProfiles: { gateway: { api: "openai-completions", baseURL, apiKeyEnv: "GATEWAY_KEY", models: [{ id: "coding" }] } },
      ...tools, executeTool: async (id, name, args, requestedSignal) => {
        calls.push(structuredClone(args));
        return tools.executeTool(id, name, args, requestedSignal);
      }, validateModelProfiles: async () => {}, ...overrides });
  };
  const initial = service();
  await initial.call("credentials/set", { ref: "GATEWAY_KEY", value: "stored-discovery-private" }, signal);
  return { harness, signal, calls, service };
}

const credentialSources: Array<{ source: string; environment: Record<string, string>; initialCredentials: Record<string, string>; expected: string }> = [
  { source: "file", environment: {}, initialCredentials: {}, expected: "stored-discovery-private" },
  { source: "launch", environment: {}, initialCredentials: { GATEWAY_KEY: "launch-discovery-private" }, expected: "launch-discovery-private" },
  { source: "env", environment: { GATEWAY_KEY: "environment-discovery-private" }, initialCredentials: { GATEWAY_KEY: "launch-discovery-private" }, expected: "environment-discovery-private" },
];
it.each(credentialSources)("an existing provider discovers with its $source credential without exposing it to the browser or tool arguments", async ({ source, environment, initialCredentials, expected }) => {
  const received: Array<string | undefined> = [];
  const baseURL = await endpoint((request, response) => {
    received.push(request.headers.authorization);
    const accepted = request.headers.authorization === `Bearer ${expected}`;
    response.writeHead(accepted ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify(accepted ? { data: [{ id: "coding" }] } : { error: "unauthorized" }));
  });
  const stack = await setup(`${baseURL}///`);
  const service = stack.service({ environment, initialCredentials });
  expect(await service.call("credentials/describe", { refs: ["GATEWAY_KEY"] }, stack.signal)).toMatchObject({ GATEWAY_KEY: { configured: true, source } });
  // This is the exact edit-card request after its saved password field is cleared.
  expect(await service.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "gateway", baseURL, api: "openai-completions" } }, stack.signal)).toEqual([{ id: "coding" }]);
  expect(received).toEqual([`Bearer ${expected}`]);
  expect(stack.calls).toHaveLength(1);
  expect(stack.calls[0]).toEqual({ url: `${baseURL}/models`, ticket: expect.any(String) });
  const browserView = await service.call("settings/describe", {}, stack.signal);
  const events = await Promise.all((await stack.harness.store.listSessions()).map(session => stack.harness.events.list(session.id)));
  for (const value of [stack.calls, browserView, events]) expect(JSON.stringify(value)).not.toContain(expected);
});

it("an explicit one-shot key overrides all configured sources without replacing the saved credential", async () => {
  const received: Array<string | undefined> = [];
  const baseURL = await endpoint((request, response) => { received.push(request.headers.authorization); response.end(JSON.stringify({ data: [{ id: "coding" }] })); });
  const stack = await setup(baseURL);
  const service = stack.service({ environment: { GATEWAY_KEY: "environment-discovery-private" } });
  expect(await service.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "gateway", baseURL, apiKey: "one-shot-discovery-private" } }, stack.signal)).toEqual([{ id: "coding" }]);
  expect(received).toEqual(["Bearer one-shot-discovery-private"]);
  expect((await service.resolvedModelProfiles(stack.signal)).gateway?.apiKey).toBe("environment-discovery-private");
});

it("a saved key is never borrowed for another protocol, host, port, path, or unknown provider", async () => {
  const baseURL = "http://127.0.0.1:37281/v1";
  const stack = await setup(baseURL);
  const observed: Array<{ url: string; authorization: string | null }> = [];
  // The controlled host tool and its sandbox still run; replace only the actual
  // fetch boundary so protocol and hostname variants cannot contact the network.
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    observed.push({ url: input, authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify({ data: [{ id: "coding" }] }), { status: 200 });
  });
  const service = stack.service();
  for (const request of [
    { provider: "gateway", baseURL: "https://127.0.0.1:37281/v1" },
    { provider: "gateway", baseURL: "http://localhost:37281/v1" },
    { provider: "gateway", baseURL: "http://127.0.0.1:37282/v1" },
    { provider: "gateway", baseURL: "http://127.0.0.1:37281/other" },
    { provider: "unknown", baseURL },
    { baseURL },
  ]) expect(await service.call("llm/discoverModels", { settingsNs: "llm-pi-ai", request }, stack.signal)).toEqual([{ id: "coding" }]);
  expect(observed).toHaveLength(6);
  expect(observed.every(item => item.authorization === null)).toBe(true);
});

it("authenticated model discovery still rejects redirects instead of forwarding a saved key", async () => {
  let trapped = 0; let received: string | undefined;
  const trap = await endpoint((_request, response) => { trapped++; response.end(JSON.stringify({ data: [{ id: "unexpected" }] })); });
  const baseURL = await endpoint((request, response) => { received = request.headers.authorization; response.writeHead(302, { Location: `${trap}/models` }); response.end(); });
  const stack = await setup(baseURL);
  await expect(stack.service().call("llm/discoverModels", { settingsNs: "llm-pi-ai", request: { provider: "gateway", baseURL } }, stack.signal)).rejects.toMatchObject({ code: "llm/model-discovery-rejected" });
  expect(received).toBe("Bearer stored-discovery-private");
  expect(trapped).toBe(0);
});
