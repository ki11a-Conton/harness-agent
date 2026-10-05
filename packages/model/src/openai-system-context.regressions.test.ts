import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, ModelEvent, ModelRequest } from "@ar/contracts";
import { newMessageId, newSessionId, newToolCallId } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

const API_KEY = "sk-synthetic-context-test";
const SYSTEM = "TOPLEVEL_SYSTEM_中文marker\n保留空白  和换行\n";
const POLICY = { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 5000 };

function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId: newSessionId(), role, content, createdAt: 0, ...extra };
}
function completed(): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function setup(retries = 0) {
  const fetch = vi.fn().mockImplementation(async () => completed());
  vi.stubGlobal("fetch", fetch);
  const provider = new OpenAICompatibleProvider({
    apiKey: API_KEY, baseUrl: "http://127.0.0.1:9/v1", modelId: "system-context-test",
    requestPolicy: { ...POLICY, maxProviderRetries: retries },
  });
  const client = provider.createClient({ providerId: provider.id, modelId: "system-context-test" }, {});
  const body = (index = 0) => JSON.parse(String((fetch.mock.calls[index]![1] as RequestInit).body));
  async function generate(request: ModelRequest, signal = new AbortController().signal) {
    const events: ModelEvent[] = [];
    for await (const event of client.generate(request, signal)) events.push(event);
    return events;
  }
  return { fetch, body, generate };
}

afterEach(() => vi.unstubAllGlobals());

describe("production OpenAI wire preserves admitted system context", () => {
  it.each([SYSTEM, "English policy and project instructions", "   "])(
    "prepends nonempty system bytes without trimming: %j", async (system) => {
      const env = setup();
      const events = await env.generate({ system, messages: [message("user", "current task")] });
      expect(events.at(-1)).toMatchObject({ type: "completed", result: { finishReason: "stop" } });
      expect(env.body().messages).toEqual([{ role: "system", content: system }, { role: "user", content: "current task" }]);
    },
  );

  it("sends an explicit system even when history is empty", async () => {
    const env = setup();
    await env.generate({ system: SYSTEM, messages: [] });
    expect(env.body().messages).toEqual([{ role: "system", content: SYSTEM }]);
  });

  it.each([undefined, ""])("preserves the legacy wire for system=%j", async (system) => {
    const env = setup();
    await env.generate({ ...(system !== undefined ? { system } : {}), messages: [message("system", "historical digest"), message("user", "task")] });
    expect(env.body().messages).toEqual([{ role: "system", content: "historical digest" }, { role: "user", content: "task" }]);
  });

  it("retains history system messages and ordering after the separate assembled system", async () => {
    const env = setup();
    await env.generate({ system: SYSTEM, messages: [message("system", "old compacted state"), message("user", "task"), message("assistant", "answer"), message("system", "new compacted state")] });
    expect(env.body().messages).toEqual([
      { role: "system", content: SYSTEM }, { role: "system", content: "old compacted state" },
      { role: "user", content: "task" }, { role: "assistant", content: "answer" },
      { role: "system", content: "new compacted state" },
    ]);
  });

  it("leaves a parallel assistant/tool group adjacent and retains reasoning content", async () => {
    const env = setup();
    const first = newToolCallId(); const second = newToolCallId();
    await env.generate({ system: SYSTEM, messages: [
      message("user", "read two files"),
      message("assistant", "", { reasoningContent: "retained reasoning", toolCalls: [{ id: first, name: "read_file", args: { path: "a.txt" } }, { id: second, name: "read_file", args: { path: "b.txt" } }] }),
      message("tool", "file a", { toolCallId: first }), message("tool", "file b", { toolCallId: second }),
    ] });
    expect(env.body().messages).toEqual([
      { role: "system", content: SYSTEM }, { role: "user", content: "read two files" },
      { role: "assistant", content: "", reasoning_content: "retained reasoning", tool_calls: [
        { id: first, type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: second, type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
      ] },
      { role: "tool", content: "file a", tool_call_id: first }, { role: "tool", content: "file b", tool_call_id: second },
    ]);
  });

  it("still rejects a missing tool result before HTTP when system is supplied", async () => {
    const env = setup();
    const id = newToolCallId();
    await expect(env.generate({ system: SYSTEM, messages: [message("assistant", "", { toolCalls: [{ id, name: "read_file", args: {} }] }), message("user", "illegal interruption")] })).rejects.toMatchObject({ info: { code: "MODEL_ERROR" } });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("does not mutate a frozen request or accumulate system messages when reused", async () => {
    const env = setup();
    const history = Object.freeze([Object.freeze(message("user", "task"))]);
    const request = Object.freeze({ system: SYSTEM, messages: history });
    const before = structuredClone(request);
    await env.generate(request); await env.generate(request);
    expect(request).toEqual(before);
    expect(env.body(0)).toEqual(env.body(1));
    expect(env.body(0).messages).toHaveLength(2);
  });

  it("retries the same complete wire context after a transient HTTP failure", async () => {
    const env = setup(1);
    env.fetch.mockResolvedValueOnce(new Response("temporary", { status: 503 }));
    const events = await env.generate({ system: SYSTEM, messages: [message("user", "task")] });
    expect(events.some((event) => event.type === "retry")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed", result: { finishReason: "stop" } });
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(env.body(0)).toEqual(env.body(1));
    expect(env.body(1).messages[0]).toEqual({ role: "system", content: SYSTEM });
  });

  it("does not send system context when already cancelled", async () => {
    const env = setup(); const abort = new AbortController(); abort.abort();
    const events = await env.generate({ system: SYSTEM, messages: [message("user", "task")] }, abort.signal);
    expect(events.at(-1)).toMatchObject({ type: "completed", result: { finishReason: "cancelled" } });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("keeps system content and credentials out of provider diagnostic evidence", async () => {
    const env = setup();
    env.fetch.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const events = await env.generate({ system: SYSTEM, messages: [message("user", "task")] });
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ type: "error", error: { code: "MODEL_ERROR" } });
    expect(JSON.stringify(error)).not.toContain(SYSTEM);
    expect(JSON.stringify(error)).not.toContain("TOPLEVEL_SYSTEM_中文marker");
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });
});
