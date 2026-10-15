import { createServer } from "node:http";
import { expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai.js";
import { RequestPrefixObserver, type RequestPrefixObservation } from "./request-prefix-observer.js";
import { newMessageId, newSessionId, type ModelRequest } from "@ar/contracts";

it("C6 observes actual wire prefixes without rewriting dynamic facts, tools or provider protocol", async () => {
  const requests: Record<string, unknown>[] = [], observations: RequestPrefixObservation[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    requests.push(JSON.parse(body)); res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const provider = new OpenAICompatibleProvider({ onRequestObservation: value => observations.push(value) });
    const sessionId = newSessionId();
    for (const date of ["2026-10-15", "2026-10-16"]) {
      // Runtime/provider routers can create a fresh client for each step.
      const client = provider.createClient({ providerId: "openai", modelId: "offline" }, { apiKey: "offline", baseUrl: `http://127.0.0.1:${address.port}/v1` });
      const request: ModelRequest = { system: `稳定的 coding policy\n[dynamic]\ndate=${date}\nlatest goal=${date}`, messages: [{ id: newMessageId(), sessionId, role: "user", content: "private source fixture", createdAt: 0 }], tools: [{ name: "read_file", description: "read current bytes", inputSchema: { type: "object" } }] };
      for await (const _ of client.generate(request, AbortSignal.timeout(5000))) { /* real stream */ }
    }
    expect(observations).toHaveLength(2);
    expect(observations[0]!.systemCommonPrefixBytes).toBeUndefined();
    expect(observations[1]!.toolsUnchanged).toBe(true);
    expect(observations[1]!.systemCommonPrefixBytes).toBeGreaterThanOrEqual(Buffer.byteLength("稳定的 coding policy\n[dynamic]\n"));
    expect(JSON.stringify(requests[1])).toContain("2026-10-16");
    expect(requests[0]!.tools).toEqual(requests[1]!.tools);
    expect(requests.every(body => !("prompt_cache_key" in body) && !("cache_control" in body))).toBe(true);
    const text = JSON.stringify(observations);
    expect(text).not.toContain("private source fixture"); expect(text).not.toContain("稳定的 coding policy"); expect(text).not.toContain(sessionId);
    expect(observations[1]!.providerCacheHitRate).toBe("not-measured");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("C6 session isolation, bounded retention and failed observers cannot affect requests", () => {
  const seen: RequestPrefixObservation[] = [];
  const observer = new RequestPrefixObserver(value => { seen.push(value); throw new Error("observer unavailable"); });
  const body = { messages: [{ role: "system", content: "same stable policy" }] };
  for (let i = 0; i < 20; i++) observer.observe(body, JSON.stringify(body), `session-${i}`);
  observer.observe(body, JSON.stringify(body), "session-0");
  expect(seen.at(-1)!.systemCommonPrefixBytes).toBeUndefined();
  observer.observe(body, JSON.stringify(body), "session-0");
  expect(seen.at(-1)!.systemCommonPrefixBytes).toBe(Buffer.byteLength("same stable policy"));
});
