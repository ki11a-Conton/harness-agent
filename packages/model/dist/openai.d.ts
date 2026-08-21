import type { ModelClient, ModelInfo, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
/** Optional OpenAI-compatible provider settings, passable via ProviderConfig. */
export interface OpenAIProviderConfig {
    /** API key. Falls back to the OPENAI_API_KEY environment variable. */
    apiKey?: string;
    /** Base URL including the version prefix (e.g. https://api.openai.com/v1).
     *  Falls back to OPENAI_BASE_URL, then the OpenAI default. */
    baseUrl?: string;
    /** Model id sent in the request. Falls back to OPENAI_MODEL, then "gpt-4o-mini". */
    modelId?: string;
    /**
     * Provider-internal retries for transient failures (network errors, HTTP
     * 429/5xx) that occur BEFORE the response stream starts. Retried attempts
     * are observable via ModelEvent "retry" (retry taxonomy kind "provider").
     * Streaming-phase failures are never retried. Default 2.
     */
    maxProviderRetries?: number;
    /**
     * Base delay between retries, exponential backoff (x2 per attempt).
     * Default 200ms; tests use 0.
     */
    retryDelayMs?: number;
    /**
     * Request-level deadline (Phase 7): the whole generate() call — request and
     * stream — is aborted after this many ms. A timeout BEFORE the stream
     * starts is a transient failure (retried within maxProviderRetries); a
     * timeout mid-stream is never retried and is reported as MODEL_ERROR.
     * Timeouts are always distinguishable from a caller abort (only the caller
     * abort yields "cancelled"). Default 120000; set 0 to disable.
     */
    requestTimeoutMs?: number;
}
/**
 * P1-18: deterministic backoff computation, jittered so bursts of concurrent
 * callers do not thresh together. `rng` returns [0, 1); equal jitter keeps
 * the delay within ±25% of the exponential curve. `retryAfterMs` (server
 * Retry-After) always wins over the local curve.
 */
export declare function nextBackoffDelayMs(baseMs: number, attempt: number, retryAfterMs: number | undefined, rng?: () => number): number;
/** P1-18: parse an HTTP Retry-After header — integer seconds or HTTP-date.
 *  Returns ms; invalid/past values fall back to 0 (retry immediately). */
export declare function parseRetryAfter(header: string | null, now?: number): number | undefined;
/**
 * OpenAI-compatible model provider (OpenAI, Azure OpenAI-compatible
 * gateways, Ollama/OpenAI-proxy endpoints, etc.).
 *
 * The API key is resolved per createClient() call:
 * config.apiKey > OPENAI_API_KEY; a missing key throws MODEL_ERROR with a
 * message that never echoes the key itself.
 */
export declare class OpenAICompatibleProvider implements ModelProvider {
    readonly id = "openai";
    listModels(): Promise<ModelInfo[]>;
    createClient(_ref: ModelRef, config: ProviderConfig): ModelClient;
}
//# sourceMappingURL=openai.d.ts.map