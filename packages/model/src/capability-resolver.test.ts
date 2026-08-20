import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelRef } from "@ar/contracts";
import { budgetForCapabilities, resolveCapabilities } from "./capability-resolver.js";

const ref = (modelId: string): ModelRef => ({ providerId: "openai", modelId });

describe("capability resolver (P1-19)", () => {
  it("resolves known gpt-4o family capabilities without any model-name hardcode in callers", () => {
    const caps = resolveCapabilities(ref("gpt-4o"));
    expect(caps.toolCalling).toBe(true);
    expect(caps.parallelToolCalls).toBe(true);
    expect(caps.contextWindowTokens).toBe(128_000);
    expect(caps.maxOutputTokens).toBe(16_384);
    expect(caps.vision).toBe(true);
  });

  it("matches by family prefix, so gpt-4o-mini and gpt-4.1 variants resolve too", () => {
    expect(resolveCapabilities(ref("gpt-4o-mini")).contextWindowTokens).toBe(128_000);
    expect(resolveCapabilities(ref("gpt-4.1")).contextWindowTokens).toBe(128_000);
    expect(resolveCapabilities(ref("gpt-4.1-nano")).contextWindowTokens).toBe(1_000_000);
    expect(resolveCapabilities(ref("gpt-5")).reasoningStream).toBe(true);
    expect(resolveCapabilities(ref("o3")).contextWindowTokens).toBe(200_000);
  });

  it("provider-advertised capabilities override the known table", () => {
    const info: ModelInfo = {
      id: "gpt-4o",
      capabilities: { contextWindowTokens: 64_000, vision: false },
    };
    const caps = resolveCapabilities(ref("gpt-4o"), info);
    expect(caps.contextWindowTokens).toBe(64_000);
    expect(caps.vision).toBe(false);
    // untouched fields still come from the known table
    expect(caps.toolCalling).toBe(true);
  });

  it("host overrides win over everything", () => {
    const info: ModelInfo = { id: "gpt-4o", capabilities: { contextWindowTokens: 64_000 } };
    const caps = resolveCapabilities(ref("gpt-4o"), info, { contextWindowTokens: 8_000, vision: true });
    expect(caps.contextWindowTokens).toBe(8_000);
    expect(caps.vision).toBe(true);
  });

  it("unknown models get an empty declaration (no assumptions)", () => {
    const caps = resolveCapabilities(ref("llama-3.3-70b"));
    expect(caps).toEqual({});
    expect(caps.contextWindowTokens).toBeUndefined();
    expect(caps.toolCalling).toBeUndefined();
  });

  it("budgetForCapabilities reserves ~30% of the window and handles unknowns", () => {
    expect(budgetForCapabilities({ contextWindowTokens: 128_000 })).toBe(89_600);
    expect(budgetForCapabilities({})).toBeUndefined();
    expect(budgetForCapabilities({ contextWindowTokens: 0 })).toBeUndefined();
  });
});