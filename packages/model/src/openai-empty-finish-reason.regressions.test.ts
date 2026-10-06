/**
 * N5 — a provider that sends `finish_reason: ""` on every content frame.
 *
 * MEASURED against the approved local OpenAI-compatible endpoint (raw SSE via
 * `curl -N`): content frames carry `"finish_reason": ""` and only the final frame
 * carries `"stop"` with usage:
 *
 *   data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"", ...}],"usage":null}
 *   data: {"choices":[{"delta":{"content":""},"finish_reason":"stop", ...}],"usage":{...}}
 *   data: [DONE]
 *
 * The stream parser treated a present-but-empty `finish_reason` as an abnormal
 * TERMINAL reason, so the whole turn aborted on the first frame — before any tool
 * call, with 0 input/output tokens reported. Every benchmark run against that
 * endpoint therefore failed as `MODEL_ERROR`/`model_error` for an infrastructure
 * reason rather than a model-quality one.
 *
 * An empty string carries no terminal meaning; it means "not finished yet" and
 * must behave exactly like an absent field. A GENUINE abnormal reason (e.g.
 * "length") must still fail closed — asserted below so the tolerance cannot
 * silently swallow a real truncation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const frame = (delta: Record<string, unknown>, finishReason: string | null, usage: unknown = null): string =>
  sse({ choices: [{ delta, finish_reason: finishReason, index: 0, logprobs: null }], usage });

/** The exact frame shape the approved endpoint produced. */
const emptyFinishFrames =
  frame({ content: "", role: "assistant" }, "") +
  frame({ content: "ready" }, "") +
  frame({ content: "", role: "assistant" }, "stop", { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) +
  "data: [DONE]\n\n";

function client() {
  return new OpenAICompatibleProvider().createClient(
    { providerId: "openai", modelId: "offline" },
    {
      apiKey: "offline-test-only",
      baseUrl: "https://offline.invalid/v1",
      maxProviderRetries: 0,
      retryDelayMs: 0,
      requestTimeoutMs: 0,
    },
  );
}

async function collect(body: string): Promise<ModelEvent[]> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  const events: ModelEvent[] = [];
  for await (const event of client().generate({ messages: [] }, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function completed(events: ModelEvent[]): Extract<ModelEvent, { type: "completed" }>[] {
  return events.filter((e): e is Extract<ModelEvent, { type: "completed" }> => e.type === "completed");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI stream: empty finish_reason is not a terminal reason", () => {
  it("consumes `finish_reason: \"\"` frames as content and completes on the real reason", async () => {
    const events = await collect(emptyFinishFrames);
    const done = completed(events);
    expect(done).toHaveLength(1);
    const result = done[0]!.result;
    expect(result.finishReason).toBe("stop");
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("ready");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
    // The text was delivered as a delta, not as an error event.
    expect(events.some((e) => e.type === "text_delta" && e.text === "ready")).toBe(true);
  });

  it("still fails closed on a GENUINE abnormal finish reason", async () => {
    const events = await collect(frame({ content: "partial" }, "length") + "data: [DONE]\n\n");
    const done = completed(events);
    expect(done).toHaveLength(1);
    expect(done[0]!.result.finishReason).toBe("error");
    expect(done[0]!.result.error?.code).toBe("MODEL_ERROR");
    expect(done[0]!.result.error?.evidence).toContain("length");
  });
});
