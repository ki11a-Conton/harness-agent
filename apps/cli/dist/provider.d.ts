import type { ModelProvider } from "@ar/contracts";
export declare const STUB_PROVIDER_ID = "stub";
/** Placeholder provider: makes missing configuration a structured, visible
 *  failure (agent doctor flags it; runs fail with MODEL_ERROR). */
export declare function stubProvider(): ModelProvider;
export interface ResolveModelProviderOptions {
    apiKey?: string;
    baseUrl?: string;
}
/**
 * Default model provider resolution: when OPENAI_API_KEY is present, load the
 * OpenAI-compatible provider from @ar/model; otherwise fall back to the stub
 * (the doctor reports the difference as a WARNING).
 */
export declare function resolveModelProvider(opts?: ResolveModelProviderOptions): Promise<ModelProvider>;
//# sourceMappingURL=provider.d.ts.map