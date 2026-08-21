import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, newMessageId, newSessionId, newToolCallId } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";
const KEY = "sk-test-secret-123";
const enc = (s) => new TextEncoder().encode(s);
let mockFetch;
function stubFetch() {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
}
function sseEvent(obj) {
    return `data: ${JSON.stringify(obj)}\n\n`;
}
function sseResponse(parts, status = 200, ok = true) {
    const chunks = parts.map((p) => (typeof p === "string" ? enc(p) : p));
    return {
        ok,
        status,
        body: new ReadableStream({
            start(controller) {
                for (const c of chunks)
                    controller.enqueue(c);
                controller.close();
            },
        }),
        text: async () => parts.map((p) => (typeof p === "string" ? p : "")).join(""),
    };
}
function message(role, content, extra = {}) {
    return { id: newMessageId(), sessionId: newSessionId(), role, content, createdAt: 0, ...extra };
}
function requestInit(callIndex = 0) {
    return mockFetch.mock.calls[callIndex][1];
}
function requestBody(callIndex = 0) {
    return JSON.parse(String(requestInit(callIndex).body));
}
function requestUrl(callIndex = 0) {
    return mockFetch.mock.calls[callIndex][0];
}
async function generate(provider, request, signal) {
    const client = provider.createClient({ providerId: "openai", modelId: "ignored" }, { apiKey: KEY });
    const events = [];
    for await (const ev of client.generate(request, signal))
        events.push(ev);
    return events;
}
function errorEvent(events) {
    const found = events.find((e) => e.type === "error");
    if (!found)
        throw new Error("expected an error event");
    return found;
}
function completedEvent(events) {
    const found = events.find((e) => e.type === "completed");
    if (!found)
        throw new Error("expected a completed event");
    return found;
}
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe("OpenAICompatibleProvider", () => {
    it("streams text deltas from multiple data lines and completes with stop", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: { content: " " }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: { content: "world" }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(events.map((e) => e.type)).toEqual(["started", "text_delta", "text_delta", "text_delta", "completed"]);
        const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" && e.text);
        expect(deltas).toEqual(["Hello", " ", "world"]);
        expect(completedEvent(events).result).toMatchObject({ finishReason: "stop", text: "Hello world" });
    });
    it("concatenates incremental tool_call name/arguments and parses args", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: "{\"path\":" } }], finish_reason: null } }] }),
            sseEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "\"a.txt\"}" } }], finish_reason: null } }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        const calls = events.filter((e) => e.type === "tool_call_delta");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            type: "tool_call_delta",
            toolCall: { id: "call_1", name: "read_file", args: { path: "a.txt" } },
        });
        expect(completedEvent(events).result).toMatchObject({
            finishReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "read_file", args: { path: "a.txt" } }],
        });
    });
    it("streams a mixed text + tool_calls response ending in tool_calls", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { content: "Let me check" }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n",
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(events.map((e) => e.type)).toEqual(["started", "text_delta", "tool_call_delta", "completed"]);
        const result = completedEvent(events).result;
        expect(result.finishReason).toBe("tool_calls");
        expect(result.text).toBe("Let me check");
        expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", args: { path: "a.txt" } }]);
    });
    it("keeps the raw string when tool-call arguments are malformed JSON", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{\"path\":" } }], finish_reason: null } }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        const call = events.find((e) => e.type === "tool_call_delta");
        expect(call).toMatchObject({ type: "tool_call_delta", toolCall: { id: "call_1", name: "f" } });
        if (call?.type === "tool_call_delta") {
            expect(call.toolCall.args).toBe("{\"path\":");
        }
    });
    it("emits a usage event from the chunk usage field", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
            "data: [DONE]\n\n",
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        const usageEvent = events.find((e) => e.type === "usage");
        expect(usageEvent).toMatchObject({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
        expect(completedEvent(events).result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });
    it("completes with stop when the stream ends via [DONE] without a finish_reason", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
            "data: [DONE]\n\n",
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(completedEvent(events).result).toMatchObject({ finishReason: "stop", text: "ok" });
    });
    it("emits an error event with the status code on HTTP 401 without leaking the key", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([`{"error":{"message":"Incorrect API key"}}`], 401, false));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        const err = errorEvent(events);
        expect(err.error.code).toBe("MODEL_ERROR");
        expect(err.error.retryable).toBe(false);
        expect(err.error.safeToRetry).toBe(false);
        expect(err.error.message).toContain("401");
        expect(err.error.message).toContain("Incorrect API key");
        expect(err.error.message).not.toContain(KEY);
        expect(events.some((e) => e.type === "completed")).toBe(false);
    });
    it("redacts provider secrets from error summaries (P0-7)", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([`{"error":{"message":"Invalid API key sk-proj-leakedsecret1234567890"}}`], 401, false));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        const err = errorEvent(events);
        expect(err.error.code).toBe("MODEL_ERROR");
        expect(err.error.message).not.toContain("sk-proj-leakedsecret1234567890");
        expect(err.error.message).toContain("[redacted]");
        expect(err.error.message).toContain("401");
    });
    it("emits a MODEL_ERROR error event when the network request throws (retries disabled)", async () => {
        stubFetch();
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, maxProviderRetries: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        const err = errorEvent(events);
        expect(err.error.code).toBe("MODEL_ERROR");
        expect(err.error.message).toContain("ECONNREFUSED");
        expect(events.some((e) => e.type === "retry")).toBe(false);
    });
    it("throws when no API key is configured and the message never echoes secrets", () => {
        vi.stubEnv("OPENAI_API_KEY", "");
        const provider = new OpenAICompatibleProvider();
        let thrown;
        try {
            provider.createClient({ providerId: "openai", modelId: "m" }, {});
        }
        catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(AgentError);
        const info = thrown.info;
        expect(info.code).toBe("MODEL_ERROR");
        expect(info.retryable).toBe(false);
        expect(info.message).toContain("OPENAI_API_KEY");
        expect(info.message).not.toMatch(/sk-[A-Za-z0-9]/);
    });
    it("maps user/assistant/tool messages with tool_call_id and assistant tool_calls", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        const tcId = newToolCallId();
        const msgs = [
            message("user", "hi"),
            message("assistant", "", { toolCalls: [{ id: tcId, name: "read_file", args: { path: "a.txt" } }] }),
            message("tool", "file content", { toolCallId: tcId }),
            message("assistant", "done"),
        ];
        await generate(new OpenAICompatibleProvider(), { messages: msgs }, new AbortController().signal);
        expect(requestBody().messages).toEqual([
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: tcId, type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }],
            },
            { role: "tool", content: "file content", tool_call_id: tcId },
            { role: "assistant", content: "done" },
        ]);
    });
    it("maps ToolSpec inputSchema to the OpenAI tools function.parameters", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        const tools = [
            {
                name: "read_file",
                description: "Read a file",
                inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
        ];
        await generate(new OpenAICompatibleProvider(), { messages: [], tools }, new AbortController().signal);
        expect(requestBody().tools).toEqual([
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read a file",
                    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
                },
            },
        ]);
    });
    it("omits tools from the request when none are provided", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(requestBody().tools).toBeUndefined();
        expect(requestBody().stream).toBe(true);
    });
    it("sends a POST with Bearer auth, JSON body and the configured model", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(requestInit().method).toBe("POST");
        const headers = requestInit().headers;
        expect(headers.Authorization).toBe(`Bearer ${KEY}`);
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers.Accept).toBe("text/event-stream");
        expect(requestBody().model).toBe("gpt-4o-mini");
    });
    it("aborts a blocked stream and completes with cancelled", async () => {
        stubFetch();
        let release;
        let sentFirst = false;
        const gate = new Promise((resolve) => (release = resolve));
        const stream = new ReadableStream({
            start(controller) {
                void controller;
            },
            async pull(controller) {
                if (!sentFirst) {
                    sentFirst = true;
                    controller.enqueue(enc(sseEvent({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })));
                    return;
                }
                await gate;
                controller.enqueue(enc(sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }] })));
                controller.close();
            },
        });
        mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body: stream });
        const ac = new AbortController();
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, ac.signal)) {
            events.push(ev);
            if (ev.type === "text_delta")
                ac.abort();
        }
        release();
        expect(events.map((e) => e.type)).toEqual(["started", "text_delta", "completed"]);
        expect(completedEvent(events).result.finishReason).toBe("cancelled");
    });
    it("completes with cancelled without calling fetch when the signal is already aborted", async () => {
        stubFetch();
        const ac = new AbortController();
        ac.abort();
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, ac.signal);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(events.map((e) => e.type)).toEqual(["started", "completed"]);
        expect(completedEvent(events).result.finishReason).toBe("cancelled");
    });
    it("normalizes the baseUrl trailing slash and prefers config.baseUrl over the env", async () => {
        stubFetch();
        vi.stubEnv("OPENAI_BASE_URL", "http://env.local/v1");
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        const provider = new OpenAICompatibleProvider();
        const client = provider.createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, baseUrl: "http://cfg.local/v1/" });
        for await (const _ev of client.generate({ messages: [] }, new AbortController().signal)) {
            // consume
        }
        expect(requestUrl()).toBe("http://cfg.local/v1/chat/completions");
    });
    it("falls back to OPENAI_BASE_URL for the baseUrl", async () => {
        stubFetch();
        vi.stubEnv("OPENAI_BASE_URL", "http://env.local/v1");
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(requestUrl()).toBe("http://env.local/v1/chat/completions");
    });
    it("falls back to the OpenAI default baseUrl when nothing is configured", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(requestUrl()).toBe("https://api.openai.com/v1/chat/completions");
    });
    it("resolves the model from OPENAI_MODEL, config.modelId, then the default", async () => {
        stubFetch();
        mockFetch.mockImplementation(() => Promise.resolve(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })])));
        vi.stubEnv("OPENAI_MODEL", "gpt-4o");
        const provider = new OpenAICompatibleProvider();
        await generate(provider, { messages: [] }, new AbortController().signal);
        expect(requestBody(0).model).toBe("gpt-4o");
        const client = provider.createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, modelId: "custom-model" });
        for await (const _ev of client.generate({ messages: [] }, new AbortController().signal)) {
            // consume
        }
        expect(requestBody(1).model).toBe("custom-model");
        vi.stubEnv("OPENAI_MODEL", "");
        await generate(provider, { messages: [] }, new AbortController().signal);
        expect(requestBody(2).model).toBe("gpt-4o-mini");
    });
    it("resolves the API key from the env and prefers config.apiKey", async () => {
        stubFetch();
        mockFetch.mockImplementation(() => Promise.resolve(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })])));
        vi.stubEnv("OPENAI_API_KEY", "sk-env-key");
        const provider = new OpenAICompatibleProvider();
        const client = provider.createClient({ providerId: "openai", modelId: "m" }, {});
        for await (const _ev of client.generate({ messages: [] }, new AbortController().signal)) {
            // consume
        }
        const envHeaders = requestInit(0).headers;
        expect(envHeaders.Authorization).toBe("Bearer sk-env-key");
        const cfgClient = provider.createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY });
        for await (const _ev of cfgClient.generate({ messages: [] }, new AbortController().signal)) {
            // consume
        }
        const cfgHeaders = requestInit(1).headers;
        expect(cfgHeaders.Authorization).toBe(`Bearer ${KEY}`);
    });
    it("exposes no static model list until the /models endpoint is wired", async () => {
        const provider = new OpenAICompatibleProvider();
        await expect(provider.listModels()).resolves.toEqual([]);
        expect(provider.id).toBe("openai");
    });
    it("includes timestamps on every event", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([
            sseEvent({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
            sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        ]));
        const events = await generate(new OpenAICompatibleProvider(), { messages: [] }, new AbortController().signal);
        expect(events.length).toBeGreaterThan(0);
        for (const ev of events) {
            expect(typeof ev.timestamp).toBe("number");
            expect(ev.timestamp).toBeGreaterThan(0);
        }
    });
});
describe("OpenAICompatibleProvider provider-internal retries (retry.provider, Phase 11)", () => {
    const okResponse = () => sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
    it("retries a transient HTTP 500 and emits retry events before completing", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([], 500, false));
        mockFetch.mockResolvedValueOnce(okResponse());
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const retries = events.filter((e) => e.type === "retry");
        expect(retries).toHaveLength(1);
        expect(retries[0]).toMatchObject({ type: "retry", attempt: 1 });
        expect(completedEvent(events).result.finishReason).toBe("stop");
    });
    it("retries a 429 rate-limit response", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([], 429, false));
        mockFetch.mockResolvedValueOnce(okResponse());
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(events.some((e) => e.type === "retry")).toBe(true);
        expect(completedEvent(events).result.finishReason).toBe("stop");
    });
    it("never retries a 401 (auth) error", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([], 401, false));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(events.some((e) => e.type === "retry")).toBe(false);
        expect(errorEvent(events).error.code).toBe("MODEL_ERROR");
    });
    it("retries a network failure (fetch throw) but not after abort", async () => {
        stubFetch();
        mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
        mockFetch.mockResolvedValueOnce(okResponse());
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(events.some((e) => e.type === "retry")).toBe(true);
        expect(completedEvent(events).result.finishReason).toBe("stop");
    });
    it("kill during provider backoff: an abort inside the backoff window cancels the pending retry (no duplicate request)", async () => {
        stubFetch();
        mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
        // A fetch issued on an already-aborted signal fails instantly with
        // AbortError and never reaches the network — the pending retry is dead.
        mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
        const controller = new AbortController();
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 60_000, maxProviderRetries: 2 });
        const events = [];
        // Wrap the AsyncIterable so we can pause between events and abort while
        // the generator sits inside the backoff wait.
        const iter = (async function* () {
            yield* client.generate({ messages: [] }, controller.signal);
        })();
        events.push((await iter.next()).value); // started
        events.push((await iter.next()).value); // retry
        // The generator now sits inside the backoff wait: arm the abort first so
        // the already-registered listener fires, then drain the pending result.
        const pending = iter.next();
        controller.abort(); // the process "dies" during the backoff window
        events.push((await pending).value);
        // Exactly one real request was attempted: the retry scheduled inside the
        // backoff window never completes, and the failure surfaces as a
        // cancellation rather than an error.
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(events.map((e) => e.type)).toEqual(["started", "retry", "completed"]);
        expect(completedEvent(events).result.finishReason).toBe("cancelled");
    });
    it("does not retry when the caller aborted (cancelled, single attempt)", async () => {
        stubFetch();
        mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
        const controller = new AbortController();
        controller.abort();
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, controller.signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(0);
        expect(completedEvent(events).result.finishReason).toBe("cancelled");
        expect(events.some((e) => e.type === "retry")).toBe(false);
    });
    it("exhausts maxProviderRetries then reports the final failure", async () => {
        stubFetch();
        mockFetch.mockResolvedValue(sseResponse([], 503, false));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, maxProviderRetries: 2 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
        expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
        expect(errorEvent(events).error.code).toBe("MODEL_ERROR");
    });
    it("respects maxProviderRetries: 0 (no internal retries)", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce(sseResponse([], 500, false));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, maxProviderRetries: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(events.some((e) => e.type === "retry")).toBe(false);
    });
    it("P1-18: honors Retry-After on 429 and classifies it rate_limit with retryAfterMs", async () => {
        stubFetch();
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: { get: (name) => (name === "retry-after" ? "1" : null) },
            body: null,
        });
        mockFetch.mockResolvedValueOnce(okResponse());
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, maxProviderRetries: 1 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const retries = events.filter((e) => e.type === "retry");
        expect(retries).toHaveLength(1);
        const err = retries[0].error;
        expect(err.provider).toEqual({ kind: "rate_limit", status: 429, retryAfterMs: 1000 });
        expect(completedEvent(events).result.finishReason).toBe("stop");
    });
    it("P1-18: server_error taxonomy with status on an exhausted 503", async () => {
        stubFetch();
        mockFetch.mockResolvedValue(sseResponse([], 503, false));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, maxProviderRetries: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(errorEvent(events).error.provider).toEqual({ kind: "server_error", status: 503 });
    });
    it("P1-18: nextBackoffDelayMs is jittered and retry-after-bounded", async () => {
        const { nextBackoffDelayMs } = await import("./openai.js");
        // rng mid-range (0.5) → curve * 1.0; retry-after always wins.
        expect(nextBackoffDelayMs(1000, 0, undefined, () => 0.5)).toBe(1000);
        // jitter low (0) → curve * 0.75
        expect(nextBackoffDelayMs(1000, 0, undefined, () => 0)).toBe(750);
        // exponential growth per attempt
        expect(nextBackoffDelayMs(1000, 2, undefined, () => 0.5)).toBe(4000);
        // server Retry-After overrides the local curve
        expect(nextBackoffDelayMs(1000, 0, 10_000, () => 0.5)).toBe(10_000);
        // no retry-after → zero delay at base 0
        expect(nextBackoffDelayMs(0, 0, undefined, () => 0.5)).toBe(0);
    });
    it("P1-18: parseRetryAfter handles seconds, HTTP-date and garbage", async () => {
        const { parseRetryAfter } = await import("./openai.js");
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        expect(parseRetryAfter("10", now)).toBe(10_000);
        expect(parseRetryAfter(null, now)).toBeUndefined();
        expect(parseRetryAfter("", now)).toBeUndefined();
        expect(parseRetryAfter("later", now)).toBeUndefined();
        const future = new Date(now + 30_000).toUTCString();
        expect(parseRetryAfter(future, now)).toBe(30_000);
        const past = new Date(now - 30_000).toUTCString();
        expect(parseRetryAfter(past, now)).toBeUndefined();
    });
});
describe("OpenAICompatibleProvider request timeout (Phase 7 deadline)", () => {
    // A pending fetch that behaves like the real one: rejects when its signal
    // aborts (timeout or caller abort), including an already-aborted signal.
    const never = (_url, init) => new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
            reject(sig.reason);
            return;
        }
        sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
    });
    it("retries a request that timed out before the stream started", async () => {
        stubFetch();
        mockFetch.mockImplementationOnce(never);
        mockFetch.mockResolvedValueOnce(sseResponse([sseEvent({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]));
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, requestTimeoutMs: 25 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(events.some((e) => e.type === "retry")).toBe(true);
        expect(completedEvent(events).result.finishReason).toBe("stop");
    }, 10_000);
    it("reports a timeout as MODEL_ERROR once the retry budget is exhausted", async () => {
        stubFetch();
        mockFetch.mockImplementation(never);
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, requestTimeoutMs: 25, maxProviderRetries: 1 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
        expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
        const err = errorEvent(events);
        expect(err.error.code).toBe("MODEL_ERROR");
        expect(err.error.message).toContain("timed out");
        expect(err.error.message).toContain("25ms");
    }, 10_000);
    it("distinguishes a timeout from a caller abort (timeout never yields cancelled)", async () => {
        stubFetch();
        mockFetch.mockImplementation(never);
        const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "m" }, { apiKey: KEY, retryDelayMs: 0, requestTimeoutMs: 25, maxProviderRetries: 0 });
        const events = [];
        for await (const ev of client.generate({ messages: [] }, new AbortController().signal))
            events.push(ev);
        expect(events.some((e) => e.type === "retry")).toBe(false);
        expect(events.some((e) => e.type === "error")).toBe(true);
        expect(events.some((e) => e.type === "completed")).toBe(false);
    }, 10_000);
});
//# sourceMappingURL=openai.test.js.map