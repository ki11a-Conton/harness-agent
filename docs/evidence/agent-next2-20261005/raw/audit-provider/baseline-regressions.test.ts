// Proposed destination: packages/model/src/openai-retry-wait.regressions.test.ts
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider, nextBackoffDelayMs, parseRetryAfter } from "../../../packages/model/src/openai.js";

const ok = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
const bad = (status = 429, retryAfter?: string) => new Response("offline fixture", {
  status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
});
const client = (requestTimeoutMs = 0, retryDelayMs = 1000, maxProviderRetries = 1) =>
  new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline" }, {
    apiKey: "offline-test-only", baseUrl: "https://offline.invalid/v1", requestTimeoutMs, retryDelayMs, maxProviderRetries,
  });

function transport(initial: Response | Error, response: () => Response = ok) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    if (fetch.mock.calls.length === 1) {
      if (initial instanceof Error) throw initial;
      return initial;
    }
    return response();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function run(c: AbortController, options: { timeout?: number; delay?: number; retries?: number; onEvent?: (event: ModelEvent) => void } = {}) {
  let finishedAt: number | undefined;
  const start = Date.now();
  const pending = (async () => {
    const events: ModelEvent[] = [];
    for await (const event of client(options.timeout, options.delay, options.retries).generate({ messages: [] }, c.signal)) {
      events.push(event); options.onEvent?.(event);
    }
    finishedAt = Date.now() - start;
    return events;
  })();
  return { pending, finishedAt: () => finishedAt };
}
function fakeDeadline() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("The operation timed out", "TimeoutError")), ms);
    return c.signal;
  });
}
const terminals = (events: ModelEvent[]) => events.filter(e => e.type === "completed" || e.type === "error");

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenAI retry wait deadline, cancellation and native listener ownership", () => {
  it.each(["http", "network"])("whole-call deadline interrupts %s retry backoff at 50 ms", async (kind) => {
    fakeDeadline();
    const fetch = transport(kind === "http" ? bad(429, "1") : new TypeError("offline network fixture"));
    const c = new AbortController(); const runResult = run(c, { timeout: 50, delay: 1000 });
    await vi.advanceTimersByTimeAsync(49);
    expect(runResult.finishedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const finishedAtDeadline = runResult.finishedAt();
    await vi.runAllTimersAsync(); const events = await runResult.pending;
    expect(finishedAtDeadline).toBe(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter(e => e.type === "retry")).toHaveLength(1);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ provider: { kind: "timeout" } }) })]);
    expect(events.filter(e => e.type === "completed" || e.type === "tool_call_delta")).toEqual([]);
    expect(c.signal.aborted).toBe(false);
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http", "network"])("caller abort while consuming %s retry event does not wait for a future abort", async (kind) => {
    const fetch = transport(kind === "http" ? bad(429, "1") : new TypeError("offline network fixture"));
    const c = new AbortController();
    const r = run(c, { onEvent: e => { if (e.type === "retry") c.abort(); } });
    await vi.advanceTimersByTimeAsync(0);
    const completedWithoutDelay = r.finishedAt();
    await vi.runAllTimersAsync(); const events = await r.pending;
    expect(completedWithoutDelay).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "completed", result: { finishReason: "cancelled" } })]);
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http", "network"])("normal %s retry success removes the native wait listener", async (kind) => {
    const fetch = transport(kind === "http" ? bad(429, "1") : new TypeError("offline network fixture"));
    const c = new AbortController(); const r = run(c);
    await vi.advanceTimersByTimeAsync(999); expect(r.finishedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); const events = await r.pending;
    expect(r.finishedAt()).toBe(1000); expect(fetch).toHaveBeenCalledTimes(2);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "completed", result: { finishReason: "stop", text: "ok", usage: { inputTokens: 7, outputTokens: 2 } } })]);
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller abort during an installed wait cancels its timer and listener", async () => {
    const fetch = transport(bad(429, "1")); const c = new AbortController(); const r = run(c);
    await vi.advanceTimersByTimeAsync(40); c.abort(); await vi.advanceTimersByTimeAsync(0);
    const events = await r.pending;
    expect(r.finishedAt()).toBe(40); expect(fetch).toHaveBeenCalledTimes(2);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "completed", result: { finishReason: "cancelled" } })]);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("already-expired deadline at the yielded retry event skips waiting", async () => {
    fakeDeadline(); const fetch = transport(bad(429, "1")); const c = new AbortController();
    const iter = client(50).generate({ messages: [] }, c.signal)[Symbol.asyncIterator]();
    expect((await iter.next()).value?.type).toBe("started");
    expect((await iter.next()).value?.type).toBe("retry");
    await vi.advanceTimersByTimeAsync(50);
    let finishedAt: number | undefined;
    const pending = iter.next().then(value => { finishedAt = Date.now(); return value; });
    const resumedAt = Date.now(); await vi.advanceTimersByTimeAsync(0); const completedWithoutDelay = finishedAt;
    await vi.runAllTimersAsync(); const final = await pending;
    expect(completedWithoutDelay).toBe(resumedAt); expect(final.value).toMatchObject({ type: "error", error: { provider: { kind: "timeout" } } });
    expect(fetch).toHaveBeenCalledTimes(2); expect((await iter.next()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("zero-delay retry success does not retain an abort listener", async () => {
    const fetch = transport(bad()); const c = new AbortController(); const r = run(c, { delay: 0 });
    await vi.runAllTimersAsync(); const events = await r.pending;
    expect(fetch).toHaveBeenCalledTimes(2); expect(events.at(-1)).toMatchObject({ type: "completed", result: { finishReason: "stop" } });
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("reused caller signal does not accumulate listeners across 12 successful retrying calls", async () => {
    const c = new AbortController();
    for (let i = 0; i < 12; i += 1) {
      const fetch = transport(bad()); const r = run(c, { delay: 0 });
      await vi.runAllTimersAsync(); const events = await r.pending;
      expect(fetch).toHaveBeenCalledTimes(2); expect(events.at(-1)).toMatchObject({ type: "completed", result: { finishReason: "stop" } });
    }
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("caller cancellation wins if the whole-call deadline also expires before retry resumes", async () => {
    fakeDeadline(); const fetch = transport(bad(429, "1")); const c = new AbortController();
    const iter = client(50).generate({ messages: [] }, c.signal)[Symbol.asyncIterator]();
    await iter.next(); await iter.next(); await vi.advanceTimersByTimeAsync(50); c.abort();
    const pending = iter.next(); await vi.runAllTimersAsync(); const final = await pending;
    expect(final.value).toMatchObject({ type: "completed", result: { finishReason: "cancelled" } });
    expect(fetch).toHaveBeenCalledTimes(2); expect((await iter.next()).done).toBe(true);
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("Retry-After remains a lower bound when the deadline is disabled", async () => {
    const fetch = transport(bad(429, "2")); const c = new AbortController(); const r = run(c, { delay: 10 });
    await vi.advanceTimersByTimeAsync(1999); expect(fetch).toHaveBeenCalledTimes(1); expect(r.finishedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); const events = await r.pending;
    expect(r.finishedAt()).toBe(2000); expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.find(e => e.type === "retry")).toMatchObject({ type: "retry", error: { provider: { kind: "rate_limit", status: 429, retryAfterMs: 2000 } } });
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("non-transient 401 does not schedule a retry wait", async () => {
    const fetch = transport(bad(401)); const c = new AbortController(); const r = run(c);
    await vi.runAllTimersAsync(); const events = await r.pending;
    expect(fetch).toHaveBeenCalledTimes(1); expect(events.filter(e => e.type === "retry")).toEqual([]);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ provider: { kind: "http", status: 401 } }) })]);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("exhausted 503 retry budget keeps three fetches and two retry events", async () => {
    const fetch = transport(bad(503), () => bad(503)); const c = new AbortController(); const r = run(c, { delay: 0, retries: 2 });
    await vi.runAllTimersAsync(); const events = await r.pending;
    expect(fetch).toHaveBeenCalledTimes(3); expect(events.filter(e => e.type === "retry")).toHaveLength(2);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ provider: { kind: "server_error", status: 503 } }) })]);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("streaming read failure never enters provider retry backoff", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new TypeError("offline read failed")); } });
    const fetch = vi.fn(async () => new Response(stream)); vi.stubGlobal("fetch", fetch);
    const c = new AbortController(); const r = run(c); await vi.runAllTimersAsync(); const events = await r.pending;
    expect(fetch).toHaveBeenCalledTimes(1); expect(events.filter(e => e.type === "retry")).toEqual([]);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ provider: { kind: "network" }, retryable: false, safeToRetry: false }) })]);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("Retry-After parsing and backoff jitter policy stay unchanged", () => {
    const now = Date.UTC(2026, 9, 5);
    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000);
    expect(parseRetryAfter("not a date", now)).toBeUndefined();
    expect(nextBackoffDelayMs(1000, 1, 4000, () => 0)).toBe(4000);
    expect(nextBackoffDelayMs(1000, 1, undefined, () => 0)).toBe(1500);
    expect(nextBackoffDelayMs(1000, 1, undefined, () => 1)).toBe(2500);
  });
});
