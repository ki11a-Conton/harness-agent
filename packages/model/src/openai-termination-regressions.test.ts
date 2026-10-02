import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelFinalResult } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

// Every fetch is replaced; these fixtures cannot reach a model endpoint.
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const toolDelta = (rawArgs = '{"path":"a.txt","content":"partial"}') => ({
  choices: [{ delta: { tool_calls: [{
    index: 0, id: "call_one", function: { name: "write_file", arguments: rawArgs },
  }] } }],
});
const partial = sse({
  choices: [{ delta: { content: "partial answer", reasoning_content: "partial reasoning" } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});
const terminal = (reason: string): string => sse({ choices: [{ delta: {}, finish_reason: reason }] });

async function generate(parts: string[] | null): Promise<{ events: ModelEvent[]; result: ModelFinalResult }> {
  const fetch = vi.fn(async () => new Response(parts === null ? null : parts.join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  }));
  vi.stubGlobal("fetch", fetch);
  const client = new OpenAICompatibleProvider().createClient(
    { providerId: "openai", modelId: "offline" },
    { apiKey: "offline-test-key", baseUrl: "https://offline.invalid/v1", requestTimeoutMs: 0, maxProviderRetries: 2 },
  );
  const events: ModelEvent[] = [];
  for await (const event of client.generate({ messages: [] }, new AbortController().signal)) events.push(event);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === "retry")).toEqual([]);
  const completed = events.filter((event): event is Extract<ModelEvent, { type: "completed" }> => event.type === "completed");
  expect(completed).toHaveLength(1);
  return { events, result: completed[0]!.result };
}

afterEach(() => vi.unstubAllGlobals());

describe("R1: OpenAI stream termination evidence", () => {
  const abnormal = [
    { label: "output length", suffix: [terminal("length")], reason: "length", boundary: "finish_reason" },
    { label: "content filter", suffix: [terminal("content_filter")], reason: "content_filter", boundary: "finish_reason" },
    { label: "unknown finish reason", suffix: [terminal("unexpected")], reason: "unexpected", boundary: "finish_reason" },
    { label: "empty finish reason", suffix: [terminal("")], reason: "", boundary: "finish_reason" },
    { label: "natural EOF", suffix: [], reason: null, boundary: "eof" },
    { label: "DONE without finish reason", suffix: ["data: [DONE]\n\n"], reason: null, boundary: "done" },
  ];

  for (const fixture of abnormal) {
    it.each([false, true])(`fails ${fixture.label} with tool intent=%s while retaining partial output`, async (withTool) => {
      const { events, result } = await generate([partial, ...(withTool ? [sse(toolDelta())] : []), ...fixture.suffix]);
      expect(result.finishReason).toBe("error");
      expect(result.text).toBe("partial answer");
      expect(result.reasoningContent).toBe("partial reasoning");
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      expect(result.error).toMatchObject({ code: "MODEL_ERROR", retryable: false, safeToRetry: false, provider: { kind: "protocol" } });
      expect(JSON.parse(result.error!.evidence!)).toMatchObject({ boundary: fixture.boundary, finishReason: fixture.reason });
      if (withTool) {
        expect(result.toolCalls).toEqual([{ id: "call_one", name: "write_file", args: { path: "a.txt", content: "partial" } }]);
        expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
      } else {
        expect(result.toolCalls).toBeUndefined();
      }
    });
  }

  it("fails an HTTP 200 response without a body instead of fabricating an empty answer", async () => {
    const { result } = await generate(null);
    expect(result.finishReason).toBe("error");
    expect(result.error).toMatchObject({ code: "MODEL_ERROR", retryable: false, safeToRetry: false, provider: { kind: "protocol" } });
    expect(JSON.parse(result.error!.evidence!)).toMatchObject({ boundary: "missing_body", finishReason: null });
  });

  it("retains an incomplete tool argument string for protocol-repair audit without certifying execution", async () => {
    const { result } = await generate([sse(toolDelta('{"path":"a.txt","content":"par')), terminal("length")]);
    expect(result.finishReason).toBe("error");
    expect(result.toolCalls?.[0]).toMatchObject({ id: "call_one", name: "write_file", args: '{"path":"a.txt","content":"par' });
  });

  it("bounds and redacts unsupported finish reasons in diagnostics", async () => {
    const secret = "sk-proj-leakedsecret1234567890";
    const { result } = await generate([partial, terminal(`${secret}${"x".repeat(5000)}`)]);
    expect(result.finishReason).toBe("error");
    expect(JSON.stringify(result.error)).not.toContain(secret);
    const evidence = JSON.parse(result.error!.evidence!) as { finishReason: string };
    expect(evidence.finishReason.length).toBeLessThanOrEqual(200);
    expect(result.error!.message.length).toBeLessThan(500);
  });

  it.each([
    { suffix: [], boundary: "EOF" },
    { suffix: ["data: [DONE]\n\n"], boundary: "DONE" },
  ])("accepts explicit normal stop regardless of subsequent transport close ($boundary)", async ({ suffix }) => {
    const { result } = await generate([partial, terminal("stop"), ...suffix]);
    expect(result).toMatchObject({ finishReason: "stop", text: "partial answer", usage: { inputTokens: 11, outputTokens: 7 } });
    expect(result.error).toBeUndefined();
  });

  it("accepts normal tool_calls with complete arguments", async () => {
    const { result } = await generate([sse(toolDelta()), terminal("tool_calls"), "data: [DONE]\n\n"]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it("treats an empty natural EOF as an incomplete response", async () => {
    const { result } = await generate([]);
    expect(result.finishReason).toBe("error");
    expect(result.text).toBe("");
  });
});
