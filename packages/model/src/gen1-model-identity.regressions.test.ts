import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function sentModel(identity: { modelId?: string } = {}, config: Record<string, unknown> = {}) {
  const send = vi.fn(async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal("fetch", send);
  const client = new OpenAICompatibleProvider({ apiKey: "offline-test", ...identity })
    .createClient({ providerId: "openai", modelId: "requested-model" }, config);
  for await (const _event of client.generate({ messages: [] }, new AbortController().signal)) { /* consume */ }
  return JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model;
}

describe("GEN1: the requested model reaches the actual HTTP request", () => {
  it("uses ModelRef when no constructor/call-site model is pinned", async () => {
    vi.stubEnv("OPENAI_MODEL", "environment-model");
    expect(await sentModel()).toBe("requested-model");
  });
  it("preserves a frozen constructor identity over ModelRef/environment", async () => {
    vi.stubEnv("OPENAI_MODEL", "environment-model");
    expect(await sentModel({ modelId: "frozen-model" })).toBe("frozen-model");
  });
  it("preserves explicit call-site identity as the highest priority", async () => {
    expect(await sentModel({ modelId: "frozen-model" }, { modelId: "call-site-model" })).toBe("call-site-model");
  });
});
