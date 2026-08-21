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
export declare function resolveCapabilities(ref: ModelRef, info?: ModelInfo, overrides?: Partial<ModelCapabilities>): ModelCapabilities;
/** P1-19: safe context budget (tokens) from the resolved context window.
 *  Keeps ~30% of the window free for the response, tool results and
 *  compaction slack. Returns undefined when the window is unknown. */
export declare function budgetForCapabilities(caps: ModelCapabilities): number | undefined;
//# sourceMappingURL=capability-resolver.d.ts.map