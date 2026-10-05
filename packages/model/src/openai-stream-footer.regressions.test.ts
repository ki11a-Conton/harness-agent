import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelFinalResult } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const text = sse({ choices: [{ delta: { content: "你好 complete", reasoning_content: "kept reasoning" }, finish_reason: null }] });
const usage = { prompt_tokens: 137, completion_tokens: 23, total_tokens: 160 };
const footer = sse({ choices: [], usage });
const terminal = (reason: string, extra: Record<string, unknown> = {}): string =>
  sse({ choices: [{ delta: {}, finish_reason: reason }], ...extra });
const tool = sse({ choices: [{ delta: { tool_calls: [{
  index: 0, id: "call_one", function: { name: "read_file", arguments: '{"path":"a.txt"}' },
}] } }] });

function client(requestTimeoutMs = 0) {
  return new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline" }, {
    apiKey: "offline-test-only", baseUrl: "https://offline.invalid/v1",
    maxProviderRetries: 2, retryDelayMs: 0, requestTimeoutMs,
  });
}

async function collect(response: Response, options: {
  abortAt?: (event: ModelEvent) => boolean;
  timeoutMs?: number;
} = {}): Promise<ModelEvent[]> {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const events: ModelEvent[] = [];
  for await (const event of client(options.timeoutMs).generate({ messages: [] }, controller.signal)) {
    events.push(event);
    if (options.abortAt?.(event)) controller.abort();
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === "retry")).toEqual([]);
  return events;
}

function result(events: ModelEvent[]): ModelFinalResult {
  const completed = events.filter((event): event is Extract<ModelEvent, { type: "completed" }> => event.type === "completed");
  expect(completed).toHaveLength(1);
  return completed[0]!.result;
}

function hangingResponse(firstFrames: string, cancelError?: Error): {
  response: Response; stream: ReadableStream<Uint8Array>; cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(() => { if (cancelError) throw cancelError; });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encode(firstFrames)); },
    cancel,
  });
  return { response: new Response(stream), stream, cancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI stream footer, cancellation and reader ownership", () => {
  it.each(["stop", "tool_calls"])("reads independent final usage after %s", async (reason) => {
    const events = await collect(new Response((reason === "tool_calls" ? tool : text) + terminal(reason) + footer + "data: [DONE]\n\n"));
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 137, outputTokens: 23 } }),
    ]);
    expect(result(events)).toMatchObject({ finishReason: reason, usage: { inputTokens: 137, outputTokens: 23 } });
    if (reason === "tool_calls") expect(result(events).toolCalls).toEqual([{ id: "call_one", name: "read_file", args: { path: "a.txt" } }]);
    else expect(result(events)).toMatchObject({ text: "你好 complete", reasoningContent: "kept reasoning" });
  });

  it("reads a final footer split across bytes, UTF-8 and CRLF lines", async () => {
    const bytes = encode((text + terminal("stop") + footer + "data: [DONE]\n\n").replace(/\n/g, "\r\n"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    });
    const events = await collect(new Response(stream));
    expect(result(events)).toMatchObject({ finishReason: "stop", text: "你好 complete", usage: { inputTokens: 137, outputTokens: 23 } });
    expect(stream.locked).toBe(false);
  });

  it("replaces an earlier partial snapshot instead of treating it as the final footer", async () => {
    const events = await collect(new Response(sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + text + terminal("stop") + footer));
    expect(events.filter((event) => event.type === "usage").map((event) => event.type === "usage" && event.usage)).toEqual([
      { inputTokens: 5, outputTokens: 2 }, { inputTokens: 137, outputTokens: 23 },
    ]);
    expect(result(events).usage).toEqual({ inputTokens: 137, outputTokens: 23 });
  });

  it("finishes immediately when usage is on the normal finish frame, then cancels and releases the reader", async () => {
    const body = hangingResponse(text + terminal("stop", { usage }));
    const events = await collect(body.response);
    expect(result(events)).toMatchObject({ finishReason: "stop", usage: { inputTokens: 137, outputTokens: 23 } });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it("finishes on a valid footer without waiting for DONE or network close", async () => {
    const body = hangingResponse(text + terminal("stop") + footer);
    const events = await collect(body.response);
    expect(result(events)).toMatchObject({ finishReason: "stop", usage: { inputTokens: 137, outputTokens: 23 } });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it.each(["data: [DONE]\n\n", ""])("retains a normal completion without usage at transport boundary %j", async (close) => {
    const events = await collect(new Response(text + terminal("stop") + close));
    expect(result(events)).toMatchObject({ finishReason: "stop", text: "你好 complete" });
    expect(result(events).usage).toBeUndefined();
  });

  it.each(["data: [DONE]\n\n", ""])("still rejects transport boundary %j without normal evidence", async (close) => {
    const events = await collect(new Response(tool + close));
    expect(result(events)).toMatchObject({ finishReason: "error", error: { code: "MODEL_ERROR", retryable: false, safeToRetry: false } });
  });

  it("ignores output, reasoning, tool and finish mutations after the first normal boundary", async () => {
    const injected = sse({ choices: [{ delta: { content: "INJECTED", reasoning_content: "INJECTED", tool_calls: [{
      index: 0, id: "call_bad", function: { name: "write_file", arguments: '{"path":"bad"}' },
    }] }, finish_reason: "tool_calls" }], usage });
    const events = await collect(new Response(text + terminal("stop") + injected));
    expect(result(events)).toEqual({ finishReason: "stop", text: "你好 complete", reasoningContent: "kept reasoning", usage: { inputTokens: 137, outputTokens: 23 } });
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([]);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.text)).toEqual(["你好 complete"]);
  });

  it("ignores late mutations to an already certified tool call", async () => {
    const injected = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "write_file", arguments: "BAD" } }] } }], usage });
    const events = await collect(new Response(tool + terminal("tool_calls") + injected));
    expect(result(events).toolCalls).toEqual([{ id: "call_one", name: "read_file", args: { path: "a.txt" } }]);
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
  });

  it.each(["length", "content_filter", "unexpected"])("fails abnormal %s immediately and releases an open stream", async (reason) => {
    const body = hangingResponse(tool + terminal(reason));
    const events = await collect(body.response);
    expect(result(events)).toMatchObject({ finishReason: "error", error: { retryable: false, safeToRetry: false, provider: { kind: "protocol" } } });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it("honors caller abort before a buffered normal finish", async () => {
    const events = await collect(new Response(text + terminal("stop") + footer), { abortAt: (event) => event.type === "text_delta" });
    expect(result(events)).toMatchObject({ finishReason: "cancelled", text: "你好 complete" });
    expect(events.filter((event) => event.type === "usage" || event.type === "tool_call_delta")).toEqual([]);
  });

  it("honors caller abort between events emitted from the same finish frame", async () => {
    const events = await collect(new Response(sse({ choices: [{ delta: { content: "first" }, finish_reason: "stop" }], usage })), {
      abortAt: (event) => event.type === "text_delta",
    });
    expect(result(events).finishReason).toBe("cancelled");
    // Usage precedes text within one parsed frame; it may already be yielded.
    // Cancellation must suppress the subsequent normal completion.
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([]);
  });

  it.each(["", "data: [DONE]\n\n", footer])("honors caller abort between a final tool delta and completion at boundary %j", async (close) => {
    const events = await collect(new Response(tool + terminal("tool_calls") + close), {
      abortAt: (event) => event.type === "tool_call_delta",
    });
    expect(result(events).finishReason).toBe("cancelled");
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
  });

  it.each(["", "data: [DONE]\n\n", footer])("does not emit another completion after caller aborts delivered success at boundary %j", async (close) => {
    const events = await collect(new Response(text + terminal("stop") + close), {
      abortAt: (event) => event.type === "completed",
    });
    expect(result(events).finishReason).toBe("stop");
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("classifies an unsignaled fetch AbortError as a request failure, not caller cancellation", async () => {
    const fetch = vi.fn(async () => { throw new DOMException("unrelated transport abort", "AbortError"); });
    vi.stubGlobal("fetch", fetch);
    const events: ModelEvent[] = [];
    for await (const event of client().generate({ messages: [] }, new AbortController().signal)) events.push(event);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { provider: { kind: "network" } } });
  });

  it("classifies a pre-stream deadline AbortError as timeout even when fetch uses a generic AbortError", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("transport aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const events: ModelEvent[] = [];
    for await (const event of client(25).generate({ messages: [] }, new AbortController().signal)) events.push(event);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { provider: { kind: "timeout" } } });
  });

  it("cancels while waiting for a footer after normal tool intent", async () => {
    const body = hangingResponse(tool + terminal("tool_calls"));
    const fetch = vi.fn(async () => body.response);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const events: ModelEvent[] = [];
    const timer = setTimeout(() => controller.abort(), 20);
    try { for await (const event of client().generate({ messages: [] }, controller.signal)) events.push(event); }
    finally { clearTimeout(timer); }
    expect(result(events).finishReason).toBe("cancelled");
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it("reports a footer deadline without authorizing tools or retrying", async () => {
    const body = hangingResponse(tool + terminal("tool_calls"));
    const events = await collect(body.response, { timeoutMs: 25 });
    expect(events.filter((event) => event.type === "completed" || event.type === "tool_call_delta")).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { retryable: false, safeToRetry: false, provider: { kind: "timeout" } } });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it("reports a reader rejection after normal intent without certifying success", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(encode(tool + terminal("tool_calls"))); } });
    const timer = setTimeout(() => controller.error(new Error("offline reader failed")), 20);
    let events: ModelEvent[];
    try { events = await collect(new Response(stream)); } finally { clearTimeout(timer); }
    expect(events.filter((event) => event.type === "completed" || event.type === "tool_call_delta")).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { code: "MODEL_ERROR", retryable: false, safeToRetry: false, provider: { kind: "network" } } });
    expect(stream.locked).toBe(false);
  });

  it("cancels and releases the response when a consumer returns early", async () => {
    const body = hangingResponse(text);
    vi.stubGlobal("fetch", vi.fn(async () => body.response));
    for await (const event of client().generate({ messages: [] }, new AbortController().signal)) if (event.type === "text_delta") break;
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
  });

  it("cleanup rejection does not replace a normal completion or retain the lock", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const body = hangingResponse(text + terminal("stop", { usage }), new Error("sk-offline-cleanup-secret"));
    const events = await collect(body.response);
    expect(result(events).finishReason).toBe("stop");
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
    expect(stderr.mock.calls).toEqual([["[degraded] openai.reader.cancel: response cleanup failed\n"]]);
  });

  it("cleanup rejection does not replace caller cancellation", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const body = hangingResponse(text, new Error("sk-offline-cleanup-secret"));
    const events = await collect(body.response, { abortAt: (event) => event.type === "text_delta" });
    expect(result(events).finishReason).toBe("cancelled");
    expect(body.stream.locked).toBe(false);
    expect(stderr.mock.calls).toEqual([["[degraded] openai.reader.cancel: response cleanup failed\n"]]);
  });

  it.each([false, true])("releaseLock rejection reports only a fixed diagnostic and preserves caller cancellation=%s", async (abort) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const body = hangingResponse(text + terminal("stop", { usage }));
    const originalGetReader = body.stream.getReader.bind(body.stream);
    vi.spyOn(body.stream, "getReader").mockImplementation(() => {
      const reader = originalGetReader();
      const release = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        release(); // Exercise real cleanup before the transport hook fails.
        throw new Error("sk-offline-release-secret");
      };
      return reader;
    });
    const events = await collect(body.response, { abortAt: (event) => abort && event.type === "text_delta" });
    expect(result(events).finishReason).toBe(abort ? "cancelled" : "stop");
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
    expect(stderr.mock.calls).toEqual([["[degraded] openai.reader.releaseLock: response cleanup failed\n"]]);
  });
});
