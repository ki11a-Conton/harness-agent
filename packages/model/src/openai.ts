import type {
  FinishReason,
  Message,
  ModelClient,
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRef,
  ModelRequest,
  ProviderConfig,
  ToolCall,
  ToolCallId,
  ToolSpec,
  Usage,
} from "@ar/contracts";
import { AgentError, errorInfo, newToolCallId } from "@ar/contracts";
import { redactSecrets } from "@ar/security";

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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_PROVIDER_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Truncation limit for response-body summaries included in error events. */
const BODY_SUMMARY_LIMIT = 200;

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** OpenAI chat-message shape built from contracts Message. */
type OpenAiMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function toOpenAiMessage(message: Message): OpenAiMessage {
  if (message.role === "tool" && message.toolCallId) {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/** Parses accumulated tool-call arguments; keeps the raw string when the JSON is malformed. */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return raw as unknown as Record<string, unknown>;
  } catch {
    // Malformed arguments JSON — keep the raw string (noted: the caller can
    // still recover the call; a failed parse must not drop the tool call).
    return raw as unknown as Record<string, unknown>;
  }
}

/** Summarize an error into the error event, redacting any secret material so
 *  provider error payloads never leak keys/tokens into the event trail. */
function summarize(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return redactSecrets(raw.replace(/\s+/g, " ").trim()).content.slice(0, BODY_SUMMARY_LIMIT);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

async function summarizeBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return redactSecrets(text.replace(/\s+/g, " ").trim()).content.slice(0, BODY_SUMMARY_LIMIT);
  } catch {
    // Best-effort: a body-summary read that races/timeouts must not fail the
    // whole call; the real response body is not degraded by this summary.
    return "";
  }
}

/**
 * P1-18: deterministic backoff computation, jittered so bursts of concurrent
 * callers do not thresh together. `rng` returns [0, 1); equal jitter keeps
 * the delay within ±25% of the exponential curve. `retryAfterMs` (server
 * Retry-After) always wins over the local curve.
 */
export function nextBackoffDelayMs(
  baseMs: number,
  attempt: number,
  retryAfterMs: number | undefined,
  rng: () => number = Math.random,
): number {
  const exponential = baseMs * 2 ** attempt;
  const jittered = exponential * (0.75 + 0.5 * rng());
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** P1-18: parse an HTTP Retry-After header — integer seconds or HTTP-date.
 *  Returns ms; invalid/past values fall back to 0 (retry immediately). */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 ? ms : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const ms = date - now;
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

/** Exponential backoff between provider-internal retries. An abort during
 *  the wait resolves early; the next fetch then fails as cancelled. */
async function backoff(
  baseMs: number,
  attempt: number,
  retryAfterMs: number | undefined,
  signal: AbortSignal,
  rng: () => number = Math.random,
): Promise<void> {
  const delay = nextBackoffDelayMs(baseMs, attempt, retryAfterMs, rng);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * OpenAI-compatible chat-completions provider over fetch + SSE.
 *
 * Streaming only: POST {baseUrl}/chat/completions with stream: true, parsed
 * line by line. Transient failures (network errors, HTTP 429/5xx) BEFORE the
 * response stream starts are retried internally with exponential backoff
 * (retry taxonomy kind "provider", Phase 11); each retry is observable via
 * ModelEvent "retry". Streaming-phase failures are never retried.
 */
async function* streamChatCompletion(
  opts: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    maxProviderRetries: number;
    retryDelayMs: number;
    requestTimeoutMs: number;
  },
  request: ModelRequest,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  yield { type: "started", timestamp: Date.now() };
  if (signal.aborted) {
    yield { type: "completed", result: { finishReason: "cancelled" }, timestamp: Date.now() };
    return;
  }

  // Phase 7 deadline: the effective signal combines the caller's abort with a
  // request-level timeout. A timeout is NEVER a cancellation — the caller's
  // abort is the only path to "cancelled".
  const timeoutSignal = opts.requestTimeoutMs > 0 ? AbortSignal.timeout(opts.requestTimeoutMs) : undefined;
  const effectiveSignal = timeoutSignal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : signal;
  const timedOut = (): boolean => timeoutSignal !== undefined && timeoutSignal.aborted && !signal.aborted;
  const timeoutMessage = `OpenAI chat completion timed out after ${opts.requestTimeoutMs}ms`;

  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: request.messages.map(toOpenAiMessage),
    stream: true,
    // Request stream usage so token accounting works on compatible servers
    // (plan.md Phase 8/10 observability; harmless for servers that ignore it).
    stream_options: { include_usage: true },
  };
  const tools = request.tools?.map(toOpenAiTool);
  if (tools?.length) body.tools = tools;

  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        yield { type: "completed", result: { finishReason: "cancelled" }, timestamp: Date.now() };
        return;
      }
      const info = errorInfo(
        "MODEL_ERROR",
        timedOut() ? timeoutMessage : `OpenAI chat completion failed: ${summarize(err)}`,
        { cause: err, provider: { kind: timedOut() ? "timeout" : "network" } },
      );
      if (attempt < opts.maxProviderRetries) {
        yield { type: "retry", attempt: attempt + 1, error: info, timestamp: Date.now() };
        await backoff(opts.retryDelayMs, attempt, undefined, signal);
        continue;
      }
      yield { type: "error", error: info, timestamp: Date.now() };
      return;
    }

    if (!response.ok) {
      const detail = await summarizeBody(response);
      const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after") ?? null);
      const kind = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server_error" : "http";
      const info = errorInfo(
        "MODEL_ERROR",
        `OpenAI chat completion failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        {
          retryable: false,
          safeToRetry: false,
          cause: response.status,
          provider: {
            kind,
            status: response.status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        },
      );
      // 429 (rate limit) and 5xx are transient; other statuses (401/403/400)
      // are not retried. Streaming has not started at this point, so a
      // retry is safe: the request body is unchanged and idempotent.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < opts.maxProviderRetries) {
        yield { type: "retry", attempt: attempt + 1, error: info, timestamp: Date.now() };
        await backoff(opts.retryDelayMs, attempt, retryAfterMs, signal);
        continue;
      }
      yield { type: "error", error: info, timestamp: Date.now() };
      return;
    }

    break;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "completed", result: { finishReason: "stop" }, timestamp: Date.now() };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let streamEnded = false;
  let text = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | undefined;
  let aborted = false;

  let abortResolve: (() => void) | undefined;
  const onAbort = () => abortResolve?.();
  effectiveSignal.addEventListener("abort", onAbort);
  const abortSignal = new Promise<"abort">((resolve) => {
    abortResolve = () => resolve("abort");
  });
  if (signal.aborted) aborted = true;

  const finishEvents = (reason: FinishReason | undefined): ModelEvent[] => {
    const calls: ToolCall[] = [...toolCalls.values()].map((tc) => ({
      id: tc.id ? (tc.id as ToolCallId) : newToolCallId(),
      name: tc.name,
      args: parseArgs(tc.args),
    }));
    const events: ModelEvent[] = calls.map((call) => ({
      type: "tool_call_delta",
      toolCall: call,
      timestamp: Date.now(),
    }));
    events.push({
      type: "completed",
      result: {
        finishReason: reason ?? (calls.length ? "tool_calls" : "stop"),
        text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(usage ? { usage } : {}),
      },
      timestamp: Date.now(),
    });
    return events;
  };

  const processData = (payload: string): { events: ModelEvent[]; finished: boolean } => {
    if (payload === "[DONE]") {
      return { events: finishEvents(undefined), finished: true };
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      // Non-JSON SSE keepalive line — nothing to emit.
      return { events: [], finished: false };
    }
    const events: ModelEvent[] = [];
    const choice = chunk.choices?.[0];
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
      events.push({ type: "usage", usage, timestamp: Date.now() });
    }
    const delta = choice?.delta;
    if (delta?.content) {
      text += delta.content;
      events.push({ type: "text_delta", text: delta.content, timestamp: Date.now() });
    }
    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        if (call.index === undefined) continue;
        const slot = toolCalls.get(call.index) ?? { id: "", name: "", args: "" };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name += call.function.name;
        if (call.function?.arguments) slot.args += call.function.arguments;
        toolCalls.set(call.index, slot);
      }
    }
    if (choice?.finish_reason) {
      // Non-stop/tool_calls reasons (e.g. "length") also map to "stop":
      // the streamed text is still delivered, the caller decides what to do.
      const reason: FinishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
      return { events: [...events, ...finishEvents(reason)], finished: true };
    }
    return { events, finished: false };
  };

  let finished = false;
  try {
    while (!finished && !aborted) {
      if (streamEnded && buffer.length === 0) break;
      while (buffer.indexOf("\n") < 0 && !streamEnded) {
        const outcome = await Promise.race([reader.read(), abortSignal]);
        if (outcome === "abort") {
          aborted = true;
          break;
        }
        if (outcome.done) {
          streamEnded = true;
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(outcome.value, { stream: true });
      }
      if (aborted) break;
      const nl = buffer.indexOf("\n");
      const line = nl >= 0 ? buffer.slice(0, nl).replace(/\r$/, "") : buffer;
      buffer = nl >= 0 ? buffer.slice(nl + 1) : "";
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload) continue;
      const { events, finished: f } = processData(payload);
      for (const ev of events) yield ev;
      if (f) finished = true;
    }
  } finally {
    effectiveSignal.removeEventListener("abort", onAbort);
  }

  if (aborted) {
    if (timedOut()) {
      // Stream-phase timeout: partial text may already have been yielded, so
      // a retry would duplicate output — report as a non-retryable error.
      yield {
        type: "error",
        error: errorInfo("MODEL_ERROR", timeoutMessage, {
          retryable: false,
          safeToRetry: false,
          provider: { kind: "timeout" },
        }),
        timestamp: Date.now(),
      };
      return;
    }
    yield { type: "completed", result: { finishReason: "cancelled", text }, timestamp: Date.now() };
    return;
  }
  if (!finished) {
    // Stream ended without a finish_reason (EOF or [DONE] missing) — infer it.
    for (const ev of finishEvents(undefined)) yield ev;
  }
}

/**
 * OpenAI-compatible model provider (OpenAI, Azure OpenAI-compatible
 * gateways, Ollama/OpenAI-proxy endpoints, etc.).
 *
 * The API key is resolved per createClient() call:
 * config.apiKey > OPENAI_API_KEY; a missing key throws MODEL_ERROR with a
 * message that never echoes the key itself.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai";

  async listModels(): Promise<ModelInfo[]> {
    // TODO: the real list lives behind GET {baseUrl}/models (needs the API
    // key). Until that endpoint is wired, expose no static list.
    return [];
  }

  createClient(_ref: ModelRef, config: ProviderConfig): ModelClient {
    const str = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const baseUrl = (str(config.baseUrl) ?? str(process.env.OPENAI_BASE_URL) ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    const apiKey = str(config.apiKey) ?? str(process.env.OPENAI_API_KEY);
    const modelId = str(config.modelId) ?? str(process.env.OPENAI_MODEL) ?? DEFAULT_MODEL;
    if (!apiKey) {
      throw new AgentError(
        errorInfo("MODEL_ERROR", "OpenAI provider requires an API key: set config.apiKey or the OPENAI_API_KEY environment variable", {
          retryable: false,
          safeToRetry: false,
        }),
      );
    }
    return {
      generate: (request, signal) =>
        streamChatCompletion(
          {
            baseUrl,
            apiKey,
            modelId,
            maxProviderRetries: Number(config.maxProviderRetries) >= 0
              ? Number(config.maxProviderRetries)
              : DEFAULT_MAX_PROVIDER_RETRIES,
            retryDelayMs: Number(config.retryDelayMs) >= 0
              ? Number(config.retryDelayMs)
              : DEFAULT_RETRY_DELAY_MS,
            requestTimeoutMs: Number(config.requestTimeoutMs) >= 0
              ? Number(config.requestTimeoutMs)
              : DEFAULT_REQUEST_TIMEOUT_MS,
          },
          request,
          signal,
        ),
    };
  }
}