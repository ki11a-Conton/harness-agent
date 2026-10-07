import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai.js";
import type { ModelRequest } from "@ar/contracts";
afterEach(() => vi.unstubAllGlobals());
async function send(request: ModelRequest) {
  const fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "test" }, { apiKey: "offline-fixture" });
  const events = []; let error: unknown;
  try { for await (const event of client.generate(request, new AbortController().signal)) events.push(event); } catch (e) { error = e; }
  return { fetch, events, error, body: fetch.mock.calls.length ? JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) : undefined };
}
describe("source audit: requested generation limits reach the transport", () => {
  it("preserves explicit zero temperature and output cap", async () => {
    const result = await send({ messages: [], temperature: 0, maxTokens: 123 });
    expect(result.body).toMatchObject({ temperature: 0, max_tokens: 123 });
  });
  it("omits absent generation parameters", async () => {
    const result = await send({ messages: [] });
    expect(result.body).not.toHaveProperty("temperature"); expect(result.body).not.toHaveProperty("max_tokens");
  });
  it.each([0, -1, NaN, 1.5, Infinity])("refuses invalid output cap %s before sending", async maxTokens => {
    const result = await send({ messages: [], maxTokens });
    expect(result.fetch).not.toHaveBeenCalled(); expect(String(result.error)).toContain("maxTokens");
  });
});
