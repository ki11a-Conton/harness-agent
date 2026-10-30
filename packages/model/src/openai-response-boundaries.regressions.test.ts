import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const text = frame({ choices: [{ delta: { content: "kept" }, finish_reason: null }] });
const stop = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const tool = frame({ choices: [{ delta: { tool_calls: [{
  index: 0, id: "call_one", function: { name: "read_file", arguments: '{"path":"a.txt"}' },
}] } }] });
const done = "data: [DONE]\n\n";
afterEach(() => vi.restoreAllMocks());

async function collect(response: Response, retries = 2): Promise<ModelEvent[]> {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline-boundary" }, {
    apiKey: "offline-only", baseUrl: "https://offline.invalid/v1", maxProviderRetries: retries,
    retryDelayMs: 0, requestTimeoutMs: 0,
  });
  const events: ModelEvent[] = [];
  for await (const event of client.generate({ messages: [] }, new AbortController().signal)) events.push(event);
  expect(fetch).toHaveBeenCalledTimes(1);
  return events;
}
const terminal = (events: ModelEvent[]) => events.filter(event => event.type === "completed" || event.type === "error");

describe("OpenAI error-body and stream protocol boundaries", () => {
  it("caps error-body work and cancels the remaining body while keeping a redacted diagnostic", async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const prefix = new TextEncoder().encode("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890 diagnostic ");
    const bytes = new Uint8Array(4096).fill(120);
    bytes.set(prefix);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (pulled++ < 256) controller.enqueue(bytes); else controller.close(); },
      cancel,
    });
    const events = await collect(new Response(body, { status: 401 }));
    expect(pulled * bytes.byteLength).toBeLessThan(80 * 1024);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(terminal(events)).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({
      provider: { kind: "http", status: 401 }, retryable: false, safeToRetry: false,
    }) })]);
    const diagnostic = JSON.stringify(events);
    expect(diagnostic).toContain("HTTP 401");
    expect(diagnostic).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("does not disclose a credential fragment cut by the error-body byte cap", async () => {
    const label = "Authorization: Bearer ";
    const body = " ".repeat(64 * 1024 - label.length - 8) + label + "abcdefghijklmnopqrstuvwxyz1234567890";
    const events = await collect(new Response(body, { status: 401 }));
    expect(terminal(events)[0]).toMatchObject({ type: "error", error: { provider: { kind: "http", status: 401 } } });
    expect(JSON.stringify(events)).not.toContain("abcdefgh");
  });

  it("keeps the HTTP diagnostic when the error body is already owned by another reader", async () => {
    const response = new Response("diagnostic", { status: 401 });
    const owner = response.body!.getReader();
    try {
      const events = await collect(response);
      expect(terminal(events)[0]).toMatchObject({ type: "error", error: { message: "OpenAI chat completion failed: HTTP 401", provider: { kind: "http", status: 401 } } });
      expect(response.body!.locked).toBe(true);
    } finally {
      await owner.cancel();
      owner.releaseLock();
    }
  });

  it("does not replace an HTTP error with a failed diagnostic-body read", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private_payload")); } });
    const events = await collect(new Response(body, { status: 403 }));
    expect(terminal(events)[0]).toMatchObject({ type: "error", error: { message: "OpenAI chat completion failed: HTTP 403", provider: { kind: "http", status: 403 } } });
    expect(body.locked).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private_payload");
  });

  it.each(["", text, tool])("fails a malformed JSON data event after prefix %j without authorizing buffered tools", async prefix => {
    const malformed = 'data: {"choices":[{"delta":{"content":"private_payload"}}\n\n';
    const events = await collect(new Response(prefix + malformed + stop + done));
    expect(events.filter(event => event.type === "retry" || event.type === "tool_call_delta")).toEqual([]);
    expect(terminal(events)).toEqual([expect.objectContaining({ type: "completed", result: expect.objectContaining({
      finishReason: "error", error: expect.objectContaining({
        provider: { kind: "protocol" }, retryable: false, safeToRetry: false,
      }),
    }) })]);
    expect(JSON.stringify(terminal(events))).not.toContain("private_payload");
    if (prefix === text) expect(terminal(events)[0]).toMatchObject({ result: { text: "kept" } });
  });

  it.each([
    { choices: [{ delta: { content: { private_payload: "value" } } }] },
    { choices: [{ delta: { reasoning_content: 7 } }] },
    { choices: { private_payload: "value" } },
    { choices: [{ delta: "private_payload" }] },
    { choices: [{ delta: { tool_calls: {} } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: {} } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: [] } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: {} }] } }] },
  ])("rejects invalid consumed chunk fields without corrupting ModelEvent contracts: %j", async bad => {
    const events = await collect(new Response(frame(bad) + stop + done));
    expect(events.filter(event => event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "tool_call_delta" || event.type === "retry")).toEqual([]);
    expect(terminal(events)).toEqual([expect.objectContaining({ type: "completed", result: expect.objectContaining({
      finishReason: "error", error: expect.objectContaining({ provider: { kind: "protocol" }, retryable: false, safeToRetry: false }),
    }) })]);
    expect(JSON.stringify(terminal(events))).not.toContain("private_payload");
  });

  it("accepts comments, null text fields, role-only deltas and a usage-only footer", async () => {
    const body = ": heartbeat\n\n" + frame({ choices: [{ delta: { role: "assistant", content: null, reasoning_content: null } }] })
      + text + stop + frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + done;
    const events = await collect(new Response(body));
    expect(terminal(events)).toEqual([expect.objectContaining({ type: "completed", result: expect.objectContaining({
      finishReason: "stop", text: "kept", usage: { inputTokens: 3, outputTokens: 2 },
    }) })]);
  });

  it("keeps the certified boundary immutable after late malformed output", async () => {
    const body = text + stop + 'data: {"choices":\n\n' + frame({ choices: [{ delta: { content: {} } }] }) + done;
    const events = await collect(new Response(body));
    expect(terminal(events)).toEqual([expect.objectContaining({ type: "completed", result: { finishReason: "stop", text: "kept" } })]);
  });

  it("releases the reader after a protocol failure even if the transport stays open", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: [] } }] }) + done)); },
      cancel,
    });
    const events = await collect(new Response(body));
    expect(terminal(events)[0]).toMatchObject({ result: { finishReason: "error", error: { provider: { kind: "protocol" } } } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
