import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import * as model from "./index.js";
import { OpenAICompatibleProvider } from "./openai.js";

type Policy = { maxProviderRetries: number; retryDelayMs: number; requestTimeoutMs: number };
const definitions = model as unknown as Record<string, unknown>;
const resolvePolicy = (config: ProviderConfig = {}, env: Record<string, string | undefined> = {}): Policy | undefined =>
  typeof definitions.resolveOpenAIRequestPolicy === "function"
    ? (definitions.resolveOpenAIRequestPolicy as (config: ProviderConfig, env: Record<string, string | undefined>) => Policy)(config, env)
    : undefined;
const freezePolicy = (provider: ModelProvider, policy: Policy): ModelProvider =>
  typeof definitions.withOpenAIRequestPolicy === "function"
    ? (definitions.withOpenAIRequestPolicy as (provider: ModelProvider, policy: Policy) => ModelProvider)(provider, policy)
    : provider;
const request: ModelRequest = { messages: [{ id: "m" as never, sessionId: "s" as never, createdAt: 0, role: "user", content: "offline policy probe" }] };
const servers: Server[] = [];

async function server(mode: "retry" | "hang") {
  let requests = 0;
  let closed = 0;
  const http = createServer((req, res) => {
    requests++;
    req.resume();
    res.on("close", () => { closed++; });
    req.on("end", () => {
      if (mode === "hang") return;
      if (requests <= 2) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"offline transient fixture"}');
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"offline"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  servers.push(http);
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`, requests: () => requests, closed: () => closed };
}

async function collect(provider: ModelProvider, config: ProviderConfig = {}, signal = new AbortController().signal) {
  const events: ModelEvent[] = [];
  for await (const event of provider.createClient({ providerId: "openai", modelId: "offline-fixture" }, config).generate(request, signal)) events.push(event);
  return events;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const http of servers.splice(0)) {
    http.closeAllConnections();
    await new Promise<void>((done, reject) => http.close(error => error ? reject(error) : done()));
  }
});

describe("OpenAI request policy: resolved once for a confirmed execution", () => {
  it("shares legacy defaults and explicit/config/env fallback semantics without retaining secrets", () => {
    expect(resolvePolicy()).toEqual({ maxProviderRetries: 2, retryDelayMs: 200, requestTimeoutMs: 120_000 });
    expect(resolvePolicy({ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 0 }, { OPENAI_MAX_RETRIES: "9", OPENAI_RETRY_DELAY_MS: "900", OPENAI_REQUEST_TIMEOUT_MS: "9000", OPENAI_API_KEY: "offline-not-a-credential" }))
      .toEqual({ maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 0 });
    expect(resolvePolicy({ maxProviderRetries: -1, retryDelayMs: NaN, requestTimeoutMs: Infinity }, { OPENAI_MAX_RETRIES: "1.5", OPENAI_RETRY_DELAY_MS: "", OPENAI_REQUEST_TIMEOUT_MS: "bad" }))
      .toEqual({ maxProviderRetries: 1.5, retryDelayMs: 0, requestTimeoutMs: 120_000 });
  });

  it("constructor-supplied policy prevents a changed environment from enabling physical retries", async () => {
    const local = await server("retry");
    const policy = { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 };
    const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url, requestPolicy: policy } as ConstructorParameters<typeof OpenAICompatibleProvider>[0]);
    policy.maxProviderRetries = 9;
    vi.stubEnv("OPENAI_MAX_RETRIES", "2");
    vi.stubEnv("OPENAI_RETRY_DELAY_MS", "0");
    const events = await collect(provider);
    expect(local.requests()).toBe(1);
    expect(events.filter(event => event.type === "retry")).toHaveLength(0);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  it("a frozen two-retry policy makes three actual requests despite env retries=0", async () => {
    const local = await server("retry");
    const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url, requestPolicy: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 } } as ConstructorParameters<typeof OpenAICompatibleProvider>[0]);
    vi.stubEnv("OPENAI_MAX_RETRIES", "0");
    const events = await collect(provider);
    expect(local.requests()).toBe(3);
    expect(events.filter(event => event.type === "retry")).toHaveLength(2);
    expect(events.find(event => event.type === "completed")?.result.finishReason).toBe("stop");
  });

  it("keeps legacy explicit client overrides for callers that supply a constructor policy", async () => {
    const local = await server("retry");
    const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url, requestPolicy: { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 } } as ConstructorParameters<typeof OpenAICompatibleProvider>[0]);
    const events = await collect(provider, { maxProviderRetries: 0 });
    expect(local.requests()).toBe(1);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  it("invalid explicit client numbers retain the constructor's frozen fallback", async () => {
    const local = await server("retry");
    const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url, requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 2000 } } as ConstructorParameters<typeof OpenAICompatibleProvider>[0]);
    vi.stubEnv("OPENAI_MAX_RETRIES", "9");
    vi.stubEnv("OPENAI_RETRY_DELAY_MS", "900");
    vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "0");
    const events = await collect(provider, { maxProviderRetries: -1, retryDelayMs: NaN, requestTimeoutMs: Infinity });
    expect(local.requests()).toBe(1);
    expect(events.filter(event => event.type === "retry")).toHaveLength(0);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  it("benchmark wrapper freezes policy even when the caller supplies different config and mutates the original object", async () => {
    const local = await server("retry");
    const policy = { maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs: 2000 };
    const provider = freezePolicy(new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url }), policy);
    policy.maxProviderRetries = 0;
    vi.stubEnv("OPENAI_MAX_RETRIES", "0");
    const events = await collect(provider, { maxProviderRetries: 0 });
    expect(local.requests()).toBe(3);
    expect(events.find(event => event.type === "completed")?.result.finishReason).toBe("stop");
  });

  it("frozen timeout still aborts an actual hanging socket after env timeout is disabled", async () => {
    const local = await server("hang");
    const provider = new OpenAICompatibleProvider({ apiKey: "offline-not-a-credential", baseUrl: local.url, requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 50 } } as ConstructorParameters<typeof OpenAICompatibleProvider>[0]);
    vi.stubEnv("OPENAI_REQUEST_TIMEOUT_MS", "0");
    vi.stubEnv("OPENAI_MAX_RETRIES", "0");
    const caller = new AbortController();
    const fallback = setTimeout(() => caller.abort(), 1000);
    try {
      const events = await collect(provider, {}, caller.signal);
      expect(local.requests()).toBe(1);
      expect(events.some(event => event.type === "error")).toBe(true);
      expect(caller.signal.aborted).toBe(false);
    } finally { clearTimeout(fallback); }
  });
});
