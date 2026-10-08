import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

afterEach(() => vi.unstubAllGlobals());

async function send(modelId: string, request: ModelRequest, baseUrl = "https://api.openai.com/v1", chatCompatibility?: unknown) {
  const fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal("fetch", fetch);
  const provider = new OpenAICompatibleProvider({ apiKey: "offline-test", baseUrl, modelId });
  let error: unknown;
  try {
    const client = provider.createClient({ providerId: "openai", modelId }, { ...(chatCompatibility === undefined ? {} : { chatCompatibility }) });
    for await (const _event of client.generate(request, new AbortController().signal)) { /* consume */ }
  } catch (caught) { error = caught; }
  const body = fetch.mock.calls.length ? JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) : undefined;
  return { fetch, body, error };
}

describe("GEN1: official reasoning-model wire parameters", () => {
  it.each(["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5.2-2025-12-11"])("sends a supported output cap for %s", async model => {
    const result = await send(model, { messages: [], maxTokens: 123 });
    expect(result.error).toBeUndefined();
    expect(result.body).toMatchObject({ model, max_completion_tokens: 123 });
    expect(result.body).not.toHaveProperty("max_tokens");
    expect(result.body).not.toHaveProperty("temperature");
  });
  it("fails locally and actionably when an explicit unsupported temperature would be ignored", async () => {
    const result = await send("o3", { messages: [], temperature: 0.2 });
    expect(result.fetch).not.toHaveBeenCalled();
    expect(String(result.error)).toContain("omit temperature");
    expect(result.error).toMatchObject({ info: { retryable: false, safeToRetry: false, provider: { kind: "protocol" } } });
  });
  it.each(["https://api.deepseek.com/v1", "https://proxy.example/v1", "https://api.openai.com.evil.example/v1"])("retains custom gateway semantics at %s", async endpoint => {
    const result = await send("gpt-5", { messages: [], maxTokens: 123, temperature: 0.2 }, endpoint);
    expect(result.body).toMatchObject({ max_tokens: 123, temperature: 0.2 });
    expect(result.body).not.toHaveProperty("max_completion_tokens");
  });
  it("uses an explicit gateway capability declaration", async () => {
    const result = await send("custom", { messages: [], maxTokens: 123 }, "https://proxy.example/v1", { maxTokensField: "max_completion_tokens", supportsTemperature: false });
    expect(result.body).toHaveProperty("max_completion_tokens", 123);
  });
  it("preserves the legacy default request body when generation parameters are absent", async () => {
    const result = await send("gpt-5", { messages: [] });
    expect(result.body).toEqual({ model: "gpt-5", messages: [], stream: true, stream_options: { include_usage: true } });
  });
  it("preserves explicit sampling on a nonreasoning chat model", async () => {
    const result = await send("gpt-5-chat-latest", { messages: [], temperature: 0.2 });
    expect(result.body).toHaveProperty("temperature", 0.2);
  });
  it.each([null, "auto", { maxTokensField: "wrong" }, { supportsTemperature: "false" }, { other: true }])("rejects invalid compatibility %j before a request", async compatibility => {
    const result = await send("custom", { messages: [] }, "https://proxy.example/v1", compatibility);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(String(result.error)).toContain("chatCompatibility");
  });
});
