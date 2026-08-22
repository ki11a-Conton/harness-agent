import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { computeMetrics } from "./metrics.js";

function completed(
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): AgentEvent {
  return {
    id: "e" as never,
    sessionId: "s" as never,
    sequence: 1,
    timestamp: 0,
    type: "model.completed",
    payload: { callId: "call-1", finishReason: "stop", ...(usage !== undefined ? { usage } : {}), ...extra },
  } as unknown as AgentEvent;
}

describe("P20-1 metrics usage accounting", () => {
  it("tokens come from the nested usage record; provenance rides along", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, source: "measured" }),
      completed({ inputTokens: 30, outputTokens: 10, source: "measured" }),
    ]);
    expect(m.tokens_input).toBe(130);
    expect(m.tokens_output).toBe(60);
    expect(m.usage_unknown).toBe(0);
    expect(m.model_call_count).toBe(2);
  });

  it("a provider-less call counts as usage_unknown and contributes NO tokens", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, source: "measured" }),
      // provider returned nothing — the runtime stamped { source: "unknown" }.
      completed({ source: "unknown" }),
    ]);
    expect(m.tokens_input).toBe(100);
    expect(m.tokens_output).toBe(50);
    expect(m.usage_unknown).toBe(1);
    expect(m.model_call_count).toBe(2);
  });

  it("a missing usage payload counts as unknown too (never a free call)", () => {
    const m = computeMetrics([completed(undefined)]);
    expect(m.usage_unknown).toBe(1);
    expect(m.tokens_input).toBe(0);
    expect(m.model_call_count).toBe(1);
  });

  it("cache tokens are aggregated from the usage record", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 200, source: "measured" }),
      completed({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, source: "measured" }),
    ]);
    expect(m.cache_tokens_read).toBe(130);
    expect(m.cache_tokens_created).toBe(200);
  });
});
