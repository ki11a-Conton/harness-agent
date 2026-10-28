import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelFinalResult } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const frame = (value: unknown, eol = "\n"): string => `data: ${JSON.stringify(value)}${eol}${eol}`;
// SSE joins the data fields of ONE event with LF before parsing the JSON.
const multiline = (value: unknown, eol = "\n"): string =>
  JSON.stringify(value, null, 2).split("\n").map(line => `data: ${line}${eol}`).join("") + eol;
const text = { choices: [{ delta: { content: "你好 REQUIRED-CONTENT" }, finish_reason: null }] };
const terminal = (reason = "stop") => ({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = { prompt_tokens: 41, completion_tokens: 7 };

function client(baseUrl = "https://offline.invalid/v1") {
  return new OpenAICompatibleProvider({ apiKey: "offline-only", baseUrl }).createClient(
    { providerId: "openai", modelId: "sse-framing-test" },
    { maxProviderRetries: 0, requestTimeoutMs: 2000 },
  );
}

async function collect(options: { baseUrl?: string; abortAt?: (event: ModelEvent) => boolean } = {}): Promise<ModelEvent[]> {
  const controller = new AbortController();
  const events: ModelEvent[] = [];
  for await (const event of client(options.baseUrl).generate({ messages: [] }, controller.signal)) {
    events.push(event);
    if (options.abortAt?.(event)) controller.abort();
  }
  return events;
}

function result(events: ModelEvent[]): ModelFinalResult {
  const completed = events.filter(event => event.type === "completed");
  expect(completed).toHaveLength(1);
  expect(events.filter(event => event.type === "retry" || event.type === "error")).toEqual([]);
  return completed[0]!.result;
}

function streamResponse(body: string, keepOpen = false) {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Force boundaries inside CRLF, the UTF-8 BOM and non-ASCII content.
      for (const byte of encode(body)) controller.enqueue(Uint8Array.of(byte));
      if (!keepOpen) controller.close();
    },
    cancel,
  });
  const fetch = vi.fn(async () => new Response(stream));
  vi.stubGlobal("fetch", fetch);
  return { stream, cancel, fetch };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenAI SSE event framing", () => {
  it.each(["\n", "\r\n", "\r"])("retains multiline data over native HTTP with %j boundaries", async eol => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(multiline(text, eol) + frame(terminal(), eol) + `data: [DONE]${eol}${eol}`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected bound HTTP address");
    try {
      const events = await collect({ baseUrl: `http://127.0.0.1:${address.port}/v1` });
      expect(result(events)).toMatchObject({ finishReason: "stop", text: "你好 REQUIRED-CONTENT" });
      expect(events.filter(event => event.type === "text_delta")).toEqual([
        expect.objectContaining({ text: "你好 REQUIRED-CONTENT" }),
      ]);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(["\n", "\r\n", "\r"])("assembles split tool arguments and trailing usage with bytewise %j framing", async eol => {
    const call = (functionDelta: Record<string, string>, initial = false) => ({ choices: [{ delta: { tool_calls: [{
      index: 0, ...(initial ? { id: "call_multiline" } : {}), function: functionDelta,
    }] }, finish_reason: null }] });
    const body = `\ufeff: heartbeat${eol}event: message${eol}id: offline${eol}retry: 10${eol}`
      + multiline(call({ name: "read_", arguments: '{"path":' }, true), eol)
      + multiline(call({ name: "file", arguments: '"源代码.ts"}' }), eol)
      + multiline(terminal("tool_calls"), eol)
      + multiline({ choices: [], usage }, eol) + `data: [DONE]${eol}${eol}`;
    const response = streamResponse(body, true);
    const events = await collect();
    expect(result(events)).toMatchObject({ finishReason: "tool_calls", usage: { inputTokens: 41, outputTokens: 7 },
      toolCalls: [{ id: "call_multiline", name: "read_file", args: { path: "源代码.ts" } }] });
    expect(events.filter(event => event.type === "tool_call_delta")).toHaveLength(1);
    expect(response.fetch).toHaveBeenCalledTimes(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(response.stream.locked).toBe(false);
  });

  it("keeps EOF compatibility for a complete final JSON event without a blank line", async () => {
    const response = streamResponse(multiline(text) + `data: ${JSON.stringify(terminal())}`);
    expect(result(await collect())).toMatchObject({ finishReason: "stop", text: "你好 REQUIRED-CONTENT" });
    expect(response.stream.locked).toBe(false);
  });

  it("honors abort after multiline text before buffered tool intent and releases the reader", async () => {
    const tool = { choices: [{ delta: { tool_calls: [{ index: 0, id: "not_executed", function: {
      name: "write_file", arguments: '{"path":"a.txt","content":"do not write"}',
    } }] }, finish_reason: null }] };
    const response = streamResponse(multiline(text, "\r") + multiline(tool, "\r") + multiline(terminal("tool_calls"), "\r"), true);
    const events = await collect({ abortAt: event => event.type === "text_delta" });
    expect(result(events)).toMatchObject({ finishReason: "cancelled", text: "你好 REQUIRED-CONTENT" });
    expect(events.filter(event => event.type === "tool_call_delta")).toEqual([]);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(response.stream.locked).toBe(false);
  });

  it("does not replay a connection failure after multiline partial tool arguments", async () => {
    let pull = 0;
    const partial = { choices: [{ delta: { tool_calls: [{ index: 0, id: "partial", function: {
      name: "write_file", arguments: '{"path":',
    } }] }, finish_reason: null }] };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pull++ === 0) controller.enqueue(encode(multiline(partial, "\r\n")));
        else controller.error(new Error("offline stream connection reset"));
      },
    });
    const fetch = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetch);
    const events = await collect();
    expect(events.filter(event => event.type === "completed" || event.type === "tool_call_delta" || event.type === "retry")).toEqual([]);
    expect(events.find(event => event.type === "error")).toMatchObject({ error: {
      retryable: false, safeToRetry: false, provider: { kind: "network" },
    } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });
});
