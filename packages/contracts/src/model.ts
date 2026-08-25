import type { AgentErrorInfo } from "./errors.js";
import type { ToolCall, ToolSpec } from "./tool.js";
import type { Message } from "./message.js";

/** P1-19: declared model capabilities. Absent fields mean "not declared" —
 *  callers must not assume a capability the model did not advertise. */
export interface ModelCapabilities {
  toolCalling?: boolean;
  parallelToolCalls?: boolean;
  reasoningStream?: boolean;
  contextWindowTokens?: number;
  structuredOutput?: boolean;
  vision?: boolean;
  maxOutputTokens?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextSize?: number;
  inputCostPer1k?: number;
  outputCostPer1k?: number;
  capabilities?: ModelCapabilities;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type ProviderConfig = Record<string, unknown>;

export interface ModelRequest {
  messages: readonly Message[];
  system?: string;
  tools?: readonly ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

/**
 * P0-9: a partial usage snapshot as delivered by usage events / a model's
 * final result (fields optional — a provider may omit input or output tokens).
 * The runtime accumulates these into the single usage record on
 * model.completed. CONTRACT: snapshots are CUMULATIVE (later snapshots replace
 * the fields they carry), never deltas.
 *
 * P20-1: a provider that returns NO usage at all must never be recorded as a
 * bare 0 (that would fabricate a "free" call). Consumers must carry the
 * provenance in `source`:
 *   - "measured"  — numbers came from the provider.
 *   - "estimated" — the runtime/host estimated them (e.g. default-rate cost).
 *   - "unknown"   — the provider gave nothing; any number on the record is
 *                   absent, and consumers must NOT treat the call as 0-cost.
 */
export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  /** P20-1: prompt-cache reads (tokens served from cache). */
  cacheReadTokens?: number;
  /** P20-1: prompt-cache writes (tokens stored into cache). */
  cacheCreationTokens?: number;
  estimatedCostUsd?: number;
  source?: "measured" | "estimated" | "unknown";
}

export type FinishReason = "stop" | "tool_calls" | "error" | "cancelled";

export interface ModelFinalResult {
  finishReason: FinishReason;
  text?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  error?: AgentErrorInfo;
  /** Reasoning/thinking content emitted by a thinking-mode provider. Carried
   *  so the caller can persist it on the assistant message and, for providers
   *  that require it (deepseek reasoning_content), pass it back on the next
   *  request. Never surfaced as final user-facing output. */
  reasoningContent?: string;
}

export type ModelEvent =
  | { type: "started"; timestamp: number }
  | { type: "text_delta"; text: string; timestamp: number }
  | { type: "reasoning_delta"; text: string; timestamp: number }
  | { type: "tool_call_delta"; toolCall: ToolCall; timestamp: number }
  | { type: "usage"; usage: Usage; timestamp: number }
  | { type: "completed"; result: ModelFinalResult; timestamp: number }
  | { type: "error"; error: AgentErrorInfo; timestamp: number }
  /**
   * Provider-internal retry (retry taxonomy kind "provider", Phase 11):
   * emitted when the provider retries a TRANSIENT failure (network error,
   * HTTP 429/5xx) before the response stream starts. Streaming-phase
   * failures are never retried. `attempt` is 1-based.
   */
  | { type: "retry"; attempt: number; error: AgentErrorInfo; timestamp: number };

export interface ModelClient {
  generate(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelProvider {
  readonly id: string;

  listModels(): Promise<ModelInfo[]>;

  createClient(model: ModelRef, config: ProviderConfig): ModelClient;
}