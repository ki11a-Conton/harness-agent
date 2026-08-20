import type { ModelCapabilities, ModelInfo, ModelRef } from "@ar/contracts";

/**
 * P1-19: capability resolution for a model reference.
 *
 * Precedence (highest first):
 * 1. explicit host overrides (config),
 * 2. capabilities advertised by the provider's ModelInfo,
 * 3. the built-in known-model table (OpenAI-compatible families),
 * 4. nothing — unknown models get an empty declaration and callers must
 *    fall back to their own defaults instead of hardcoding model names.
 */
export function resolveCapabilities(
  ref: ModelRef,
  info?: ModelInfo,
  overrides?: Partial<ModelCapabilities>,
): ModelCapabilities {
  const known = KNOWN_MODEL_CAPABILITIES.find((entry) => entry.match(ref.modelId))?.caps;
  return {
    ...(known ?? {}),
    ...(info?.capabilities ?? {}),
    ...(overrides ?? {}),
  };
}

/** P1-19: safe context budget (tokens) from the resolved context window.
 *  Keeps ~30% of the window free for the response, tool results and
 *  compaction slack. Returns undefined when the window is unknown. */
export function budgetForCapabilities(caps: ModelCapabilities): number | undefined {
  const window = caps.contextWindowTokens;
  if (window === undefined || window <= 0) return undefined;
  return Math.floor(window * 0.7);
}

interface KnownModel {
  match: (modelId: string) => boolean;
  caps: ModelCapabilities;
}

const EXACT = (prefixes: string[]) => (modelId: string) =>
  prefixes.some((p) => modelId === p || modelId.startsWith(`${p}-`));

/** Built-in table for OpenAI-compatible families (kept here, not in core —
 *  core must not know provider specifics). Prefix-based, case-sensitive,
 *  matching the actual OpenAI model ids. */
const KNOWN_MODEL_CAPABILITIES: readonly KnownModel[] = [
  {
    match: EXACT(["gpt-4.1-nano"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: false,
      contextWindowTokens: 1_000_000,
      structuredOutput: true,
      vision: true,
      maxOutputTokens: 32_768,
    },
  },
  {
    match: EXACT(["gpt-4o", "gpt-4.1"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: false,
      contextWindowTokens: 128_000,
      structuredOutput: true,
      vision: true,
      maxOutputTokens: 16_384,
    },
  },
  {
    match: EXACT(["gpt-5"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: true,
      contextWindowTokens: 400_000,
      structuredOutput: true,
      vision: true,
      maxOutputTokens: 64_000,
    },
  },
  {
    match: EXACT(["o1", "o3"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: true,
      contextWindowTokens: 200_000,
      structuredOutput: true,
      vision: false,
      maxOutputTokens: 100_000,
    },
  },
  {
    match: EXACT(["gpt-4-turbo", "gpt-4"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: false,
      contextWindowTokens: 128_000,
      structuredOutput: true,
      vision: true,
      maxOutputTokens: 4_096,
    },
  },
  {
    match: EXACT(["gpt-3.5-turbo"]),
    caps: {
      toolCalling: true,
      parallelToolCalls: true,
      reasoningStream: false,
      contextWindowTokens: 16_385,
      structuredOutput: false,
      vision: false,
      maxOutputTokens: 4_096,
    },
  },
];