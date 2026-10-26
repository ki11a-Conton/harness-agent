import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

// Real loopback HTTP only. The observer returns the original Response and its
// original text() promise, giving cancellation a deterministic body-read gate.
let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
});
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
};

async function serve(status: number, hanging: boolean, recover = false) {
  let requests = 0;
  const closed = deferred();
  server = createServer((req, res) => {
    req.resume(); requests += 1;
    res.on("close", closed.resolve);
    if (recover && requests > 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(status, { "content-type": "text/plain" });
    res.write("offline diagnostic body");
    if (!hanging) res.end();
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests: () => requests, closed: closed.promise };
}
function nativeBodyGate() {
  const started = deferred();
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await fetch(...args);
    const text = response.text.bind(response);
    vi.spyOn(response, "text").mockImplementation(() => {
      const pending = text();
      started.resolve();
      return pending;
    });
    return response;
  });
  return started.promise;
}
async function collect(url: string, signal: AbortSignal, retries: number, timeout = 0) {
  const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "local-error-body" }, {
    apiKey: "offline-only", baseUrl: url, maxProviderRetries: retries, retryDelayMs: 0, requestTimeoutMs: timeout,
  });
  const events: ModelEvent[] = [];
  for await (const event of client.generate({ messages: [] }, signal)) events.push(event);
  return events;
}
const terminals = (events: ModelEvent[]) => events.filter(event => event.type === "completed" || event.type === "error");

// Cancellation must win over an error-body summary interrupted by the same
// signal, independently of whether the HTTP status was normally retryable.
describe("OpenAI HTTP error-body cancellation and request deadline", () => {
  it.each([401, 403, 500].flatMap(status => [0, 2].map(retries => ({ status, retries }))))(
    "preserves caller cancellation during HTTP $status body, retries=$retries", async ({ status, retries }) => {
      const host = await serve(status, true);
      const reading = nativeBodyGate();
      const controller = new AbortController();
      const pending = collect(host.url, controller.signal, retries);
      await reading;
      controller.abort();
      const events = await pending;
      expect(terminals(events)).toEqual([expect.objectContaining({ type: "completed", result: { finishReason: "cancelled" } })]);
      expect(events.filter(event => event.type === "retry" || event.type === "tool_call_delta")).toEqual([]);
      expect(host.requests()).toBe(1);
      await host.closed;
    }, 10_000,
  );

  it.each([401, 429, 500].flatMap(status => [0, 2].map(retries => ({ status, retries }))))(
    "preserves the whole-call deadline during HTTP $status body, retries=$retries", async ({ status, retries }) => {
      const host = await serve(status, true);
      const reading = nativeBodyGate();
      const controller = new AbortController();
      const pending = collect(host.url, controller.signal, retries, 500);
      await reading;
      const events = await pending;
      expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "MODEL_ERROR", provider: { kind: "timeout" } }) })]);
      expect(events.filter(event => event.type === "retry" || event.type === "tool_call_delta")).toEqual([]);
      expect(controller.signal.aborted).toBe(false);
      expect(host.requests()).toBe(1);
      await host.closed;
    }, 10_000,
  );

  it.each([401, 403])("retains a completed HTTP %s diagnostic when no signal was interrupted", async status => {
    const host = await serve(status, false);
    const events = await collect(host.url, new AbortController().signal, 2);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({
      message: `OpenAI chat completion failed: HTTP ${status}: offline diagnostic body`,
      provider: { kind: "http", status }, retryable: false, safeToRetry: false,
    }) })]);
    expect(host.requests()).toBe(1);
  });

  it.each([429, 500])("retains a successful provider retry after a completed HTTP %s body", async status => {
    const host = await serve(status, false, true);
    const events = await collect(host.url, new AbortController().signal, 2);
    expect(events.filter(event => event.type === "retry")).toHaveLength(1);
    expect(terminals(events)).toEqual([expect.objectContaining({ type: "completed", result: expect.objectContaining({ finishReason: "stop", text: "recovered" }) })]);
    expect(host.requests()).toBe(2);
  });
});
