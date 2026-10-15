import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

async function receive(usage: unknown[]) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the actual HTTP body */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      ...usage.map(value => ({ choices: [], usage: value })),
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
    ];
    // Split bytes too: cache parsing must share the production SSE decoder.
    for (const byte of Buffer.from(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n")) res.write(Buffer.from([byte]));
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline" }, {
      apiKey: "offline", baseUrl: `http://127.0.0.1:${address.port}/v1`, maxProviderRetries: 0, requestTimeoutMs: 5000,
    });
    const events: ModelEvent[] = [];
    for await (const event of client.generate({ messages: [] }, AbortSignal.timeout(10000))) events.push(event);
    expect(events.filter(e => e.type === "error")).toEqual([]);
    const completed = events.find(e => e.type === "completed");
    expect(completed?.type).toBe("completed");
    if (completed?.type !== "completed") throw new Error("no completion");
    expect(completed.result.finishReason).toBe("stop");
    return { usage: completed.result.usage, events };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("C1 actual HTTP/SSE cache usage", () => {
  it.each([
    [{ prompt_tokens_details: { cached_tokens: 128 } }, 128, "openai-details"],
    [{ prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 }, 128, "deepseek"],
    [{ prompt_tokens_details: { cached_tokens: 0 } }, 0, "openai-details"],
  ])("preserves measured cache subsets, including zero: %j", async (extra, cached, source) => {
    const { usage } = await receive([{ prompt_tokens: 200, completion_tokens: 20, ...extra }]);
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadTokens: cached, cacheUsageSource: source });
    expect((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toBe(220);
  });
  it("does not fabricate zero for absent or partial counts", async () => {
    const { usage } = await receive([{ completion_tokens: 20 }]);
    expect(usage).toEqual({ outputTokens: 20 });
  });
  it("merges cumulative snapshots without resetting absent fields", async () => {
    const { usage } = await receive([{ prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 128 } }, { completion_tokens: 20 }]);
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128 });
  });
  it.each([-1, 0.5, "128", null, 201])("rejects invalid cache counts %j", async cached => {
    const { usage } = await receive([{ prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cached } }]);
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheUsageIssue).toBe("invalid");
  });
  it("does not silently select inconsistent dialects", async () => {
    const { usage } = await receive([{ prompt_tokens: 200, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 64 }, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 }]);
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheUsageIssue).toBe("conflict");
  });
  it("rejects inconsistent DeepSeek totals", async () => {
    const { usage } = await receive([{ prompt_tokens: 200, completion_tokens: 20, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 100 }]);
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheUsageIssue).toBe("conflict");
  });
  it("rejects a mixed-dialect miss count contradicting the observed standard cache subset", async () => {
    const { usage } = await receive([{ prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 128 }, prompt_cache_miss_tokens: 64 }]);
    expect(usage?.cacheReadTokens).toBeUndefined(); expect(usage?.cacheUsageIssue).toBe("conflict");
  });
  it("revalidates a retained cache count when a later footer revises total input", async () => {
    const { usage, events } = await receive([{ prompt_cache_hit_tokens: 128 }, { prompt_tokens: 100, completion_tokens: 20 }]);
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheUsageIssue: "invalid" });
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(events.filter(e => e.type === "usage").at(-1)).toMatchObject({ usage: { cacheUsageIssue: "invalid" } });
  });
  it("a later actual zero cache observation recovers a revised-input conflict", async () => {
    const { usage } = await receive([{ prompt_cache_hit_tokens: 128 }, { prompt_tokens: 100 }, { prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 20 }]);
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 });
    expect(usage?.cacheUsageIssue).toBeUndefined();
  });
});
