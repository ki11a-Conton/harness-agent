import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelClient, ModelEvent } from "@ar/contracts";
import { nextBackoffDelayMs, OpenAICompatibleProvider } from "./openai.js";
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
const client = (config: Record<string, unknown>): ModelClient => new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "long-delay" }, {
  apiKey: "local-only", baseUrl: "https://offline.invalid/v1", maxProviderRetries: 1, retryDelayMs: 0, requestTimeoutMs: 80, ...config,
});
async function collect(model: ModelClient, signal = new AbortController().signal) {
  const events: ModelEvent[] = [];
  for await (const event of model.generate({ messages: [] }, signal)) events.push(event);
  return events;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Count real HTTP requests, not fetch invocations: native fetch rejects an
// already-aborted retry signal before opening a socket. The legacy invocation
// count is covered independently by openai.test.ts and remains unchanged.
async function withRateLimitServer(header: string | undefined, config: Record<string, unknown>, verify: (events: ModelEvent[], requests: number) => void) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(429, header === undefined ? {} : { "retry-after": header });
    response.end("controlled rate limit");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture not listening");
  try {
    const events = await collect(client({ baseUrl: `http://127.0.0.1:${address.port}/v1`, ...config }));
    verify(events, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it.each(["2147484", "999999999999999999999", "9".repeat(400)])("honors long Retry-After %s within the unchanged whole-call deadline", async header => {
  await withRateLimitServer(header, {}, (events, requests) => {
    expect(requests).toBe(1);
    expect(events.findLast(event => event.type === "error" || event.type === "completed")).toMatchObject({ type: "error", error: { provider: { kind: "timeout" } } });
  });
});

it("honors a long configured backoff instead of overflowing into a 1ms retry", async () => {
  await withRateLimitServer(undefined, { retryDelayMs: 3_000_000_000 }, (events, requests) => {
    expect(requests).toBe(1);
    expect(events.findLast(event => event.type === "error")).toMatchObject({ error: { provider: { kind: "timeout" } } });
  });
});

it("allows cancellation during a long retry wait without another HTTP attempt", async () => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let physicalAttempts = 0;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    physicalAttempts++;
    return new Response("limited", { status: 429, headers: { "retry-after": "2147484" } });
  });
  const events: ModelEvent[] = [];
  try {
    for await (const event of client({ requestTimeoutMs: 0 }).generate({ messages: [] }, controller.signal)) {
      events.push(event);
      if (event.type === "retry") timer = setTimeout(() => controller.abort(), 20);
    }
    expect(events.findLast(event => event.type === "completed" || event.type === "error")).toMatchObject({ type: "completed", result: { finishReason: "cancelled" } });
    // An already-aborted fetch call cannot issue an HTTP request. Count actual
    // non-aborted attempts separately from the invocation's cancellation check.
    expect(physicalAttempts).toBe(1);
  } finally { clearTimeout(timer); controller.abort(); }
});

it("preserves normal immediate retry behavior", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("limited", { status: 429 })).mockResolvedValueOnce(ok());
  expect((await collect(client({ requestTimeoutMs: 1000 }))).findLast(event => event.type === "completed")).toMatchObject({ result: { finishReason: "stop", text: "ok" } });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not turn a valid long request timeout into an immediate abort", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    const abort = () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(ok()); }, 20);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }));
  expect((await collect(client({ requestTimeoutMs: 3_000_000_000, maxProviderRetries: 0 }))).findLast(event => event.type === "completed" || event.type === "error")).toMatchObject({ type: "completed", result: { text: "ok", finishReason: "stop" } });
});

it("keeps zero-delay exponential backoff at zero for large attempt counts", () => {
  expect(nextBackoffDelayMs(0, 2048, undefined, () => 0.5)).toBe(0);
});

it("waits the full multi-segment Retry-After without shortening its duration", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "2147484" } })).mockResolvedValueOnce(ok());
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const pending = (async () => {
    const events: ModelEvent[] = [];
    for await (const event of client({ requestTimeoutMs: 0 }).generate({ messages: [] }, new AbortController().signal)) {
      events.push(event); if (event.type === "retry") ready();
    }
    return events;
  })();
  await waiting; await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_147_483_646); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(353); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).findLast(event => event.type === "completed")).toMatchObject({ result: { finishReason: "stop", text: "ok" } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
