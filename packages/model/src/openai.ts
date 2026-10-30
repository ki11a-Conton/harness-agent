import { RequestPrefixObserver, type RequestPrefixObservation } from "./request-prefix-observer.js";
import { parseOpenAIUsage } from "./openai-usage.js";
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
import {
  AgentError,
  errorInfo,
  findSerializedWireIssues,
  newToolCallId,
  renderWireIssues,
  toolNameViolation,
  TOOL_NAME_PATTERN,
  type SerializedChatMessage,
} from "@ar/contracts";
import { redactSecrets } from "@ar/security";
import { buildProviderDiagnosticBundle } from "./provider-diagnostics.js";
import { resolveOpenAIChatCompatibility, type OpenAIChatCompatibility } from "./openai-chat-compatibility.js";
import { SseEventDecoder } from "./sse-event-decoder.js";

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
  /** Explicit wire capabilities for a custom gateway. Official OpenAI
   * reasoning models resolve their known parameter constraints automatically. */
  chatCompatibility?: Partial<OpenAIChatCompatibility>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_PROVIDER_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Non-secret transport policy shared by planning and actual clients. */
export interface OpenAIRequestPolicy {
  maxProviderRetries: number;
  retryDelayMs: number;
  requestTimeoutMs: number;
}

function isPolicyNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Keep the legacy explicit > environment > default parsing semantics. */
export function resolveOpenAIRequestPolicy(
  config: ProviderConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenAIRequestPolicy {
  const num = (value: unknown, variable: string | undefined, fallback: number): number => {
    if (isPolicyNumber(value)) return value;
    if (variable !== undefined) {
      const parsed = Number(variable);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return fallback;
  };
  return {
    maxProviderRetries: num(config.maxProviderRetries, env.OPENAI_MAX_RETRIES, DEFAULT_MAX_PROVIDER_RETRIES),
    retryDelayMs: num(config.retryDelayMs, env.OPENAI_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    requestTimeoutMs: num(config.requestTimeoutMs, env.OPENAI_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

/** A confirmed benchmark policy wins over subsequent client config/env reads.
 * The copied policy carries no endpoint or authentication material. */
export function withOpenAIRequestPolicy(provider: ModelProvider, policy: Readonly<OpenAIRequestPolicy>): ModelProvider {
  const frozen = Object.freeze(resolveOpenAIRequestPolicy({ ...policy }, {}));
  return {
    id: provider.id,
    listModels: () => provider.listModels(),
    createClient: (model, config) => provider.createClient(model, { ...config, ...frozen }),
  };
}
/** Truncation limit for response-body summaries included in error events. */
const BODY_SUMMARY_LIMIT = 200;
/** Error diagnostics must not buffer an arbitrarily large provider response. */
const ERROR_BODY_READ_LIMIT = 64 * 1024;

interface ChatChunk {
  error?: { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** deepseek-style thinking-mode field; must be passed back to the API
       *  on the next assistant message of the conversation. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
}

/** OpenAI chat-message shape built from contracts Message. */
type OpenAiMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  /** deepseek thinking-mode: the reasoning content must be echoed back on the
   *  next assistant message; omit when absent (plain providers reject it). */
  reasoning_content?: string;
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
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "assistant" && message.reasoningContent !== undefined
      ? { reasoning_content: message.reasoningContent }
      : {}),
  };
}

function toOpenAiTool(tool: ToolSpec): Record<string, unknown> {
  // P2-43: this is the exact point a tool name becomes the wire
  // `tools[].function.name`. A name outside the OpenAI grammar
  // `^[a-zA-Z0-9_-]{1,64}$` is rejected by a strict upstream with an opaque
  // HTTP 400 `{"code":11133,...,"extError":{"code":"model_param_invalid"}}` that
  // names neither the tool nor the grammar — and it rejects the WHOLE request,
  // so the turn dies as an unexplained `model_error` before any tool runs
  // (reproduced: `mcp_data_source.read` → HTTP 500/11133; `mcp_data_source_read`
  // → HTTP 200). Fail closed HERE, locally and actionably.
  const violation = toolNameViolation(tool.name);
  if (violation !== undefined) {
    throw new AgentError(
      errorInfo(
        "MODEL_ERROR",
        `tool "${tool.name}" is not a valid provider function name: ${violation}. A tool name is sent verbatim as the OpenAI "function.name" and must match ${TOOL_NAME_PATTERN.source}.`,
        {
          retryable: false,
          safeToRetry: false,
          // F7/R6: a name outside the grammar is a LOCAL protocol defect, not a
          // transient provider failure — resending the identical body can never
          // succeed, so the recovery engine must not retry it.
          provider: { kind: "protocol" },
          evidence: JSON.stringify({ tool: tool.name, pattern: TOOL_NAME_PATTERN.source }),
        },
      ),
    );
  }
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

/** Missing or abnormal completion evidence must never authorize a tool batch. */
function streamTerminationError(
  boundary: "finish_reason" | "done" | "eof" | "missing_body",
  finishReason: string | null = null,
): ReturnType<typeof errorInfo> {
  // Provider-controlled reasons can contain arbitrary content. Preserve a
  // bounded, redacted reason for audit without retaining secrets in evidence.
  const reason = finishReason === null ? null : summarize(finishReason);
  return errorInfo(
    "MODEL_ERROR",
    `OpenAI chat completion ended without a normal finish_reason (${boundary}${reason === null ? "" : `: ${reason}`})`,
    {
      retryable: false,
      safeToRetry: false,
      provider: { kind: "protocol" },
      evidence: JSON.stringify({ boundary, finishReason: reason }),
    },
  );
}

async function summarizeBody(response: Response): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (bytes < ERROR_BODY_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      const prefix = value.subarray(0, ERROR_BODY_READ_LIMIT - bytes);
      bytes += prefix.byteLength;
      text += decoder.decode(prefix, { stream: true });
    }
    text += decoder.decode();
    // A capped prefix may stop in the middle of a credential. Drop that final
    // token before redaction rather than disclosing an unrecognizable fragment.
    if (bytes === ERROR_BODY_READ_LIMIT) text = text.replace(/\S*$/u, "");
    return redactSecrets(text.replace(/\s+/g, " ").trim()).content.slice(0, BODY_SUMMARY_LIMIT);
  } catch {
    // Best-effort: a body-summary read that races/timeouts must not fail the
    // whole call; the real response body is not degraded by this summary.
    return "";
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch {
        process.stderr.write("[degraded] openai.errorBody.cancel: response cleanup failed\n");
      }
      try { reader.releaseLock(); } catch {
        process.stderr.write("[degraded] openai.errorBody.releaseLock: response cleanup failed\n");
      }
    }
  }
}

/** Validate only fields consumed as model output. Unknown provider metadata,
 * role-only deltas, nullable text fields and usage-only footers remain valid.
 * Errors report field paths, never the provider-controlled payload itself.
 */
function chunkOutputViolation(value: unknown): string | undefined {
  const object = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  const stringOrAbsent = (input: unknown): boolean => input === undefined || input === null || typeof input === "string";
  if (!object(value)) return "event must be a JSON object";
  if (value.choices === undefined || value.choices === null) return undefined;
  if (!Array.isArray(value.choices)) return "choices must be an array";
  if (!value.choices.length) return undefined;
  const choice: unknown = value.choices[0];
  if (!object(choice)) return "choices[0] must be an object";
  if (!stringOrAbsent(choice.finish_reason)) return "choices[0].finish_reason must be a string or null";
  if (choice.delta === undefined || choice.delta === null) return undefined;
  if (!object(choice.delta)) return "choices[0].delta must be an object or null";
  const delta = choice.delta;
  if (!stringOrAbsent(delta.content)) return "delta.content must be a string or null";
  if (!stringOrAbsent(delta.reasoning_content)) return "delta.reasoning_content must be a string or null";
  if (delta.tool_calls === undefined || delta.tool_calls === null) return undefined;
  if (!Array.isArray(delta.tool_calls)) return "delta.tool_calls must be an array or null";
  for (const call of delta.tool_calls) {
    if (!object(call)) return "delta.tool_calls entries must be objects";
    if (call.index !== undefined && (!Number.isSafeInteger(call.index) || (call.index as number) < 0)) return "tool call index must be a nonnegative safe integer";
    if (!stringOrAbsent(call.id)) return "tool call id must be a string or null";
    if (call.function === undefined || call.function === null) continue;
    if (!object(call.function)) return "tool call function must be an object or null";
    if (!stringOrAbsent(call.function.name)) return "tool call function.name must be a string or null";
    if (!stringOrAbsent(call.function.arguments)) return "tool call function.arguments must be a string or null";
  }
  return undefined;
}

function streamPayloadError(detail: string): ReturnType<typeof errorInfo> {
  return errorInfo("MODEL_ERROR", `Invalid OpenAI SSE chat-completion event: ${detail}`, {
    retryable: false, safeToRetry: false, provider: { kind: "protocol" },
  });
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

/** Retry waits share the whole-call signal. Every settlement releases the
 *  wait's timer and listener; an already-aborted signal never waits. */
async function backoff(
  baseMs: number,
  attempt: number,
  retryAfterMs: number | undefined,
  signal: AbortSignal,
  rng: () => number = Math.random,
): Promise<void> {
  if (signal.aborted) return;
  const delay = nextBackoffDelayMs(baseMs, attempt, retryAfterMs, rng);
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, delay);
  });
}

/**
 * OpenAI-compatible chat-completions provider over fetch + SSE.
 *
 * Streaming only: POST {baseUrl}/chat/completions with stream: true, parsed
 * line by line. Transient failures (network errors, HTTP 429/5xx) BEFORE the
 * response stream starts are retried internally with exponential backoff
 * (retry taxonomy kind "provider", Phase 11); each retry is observable via
 * ModelEvent "retry". The provider never internally replays a stream; the
 * Runtime can retry a transient failure before any semantic output.
 */
let diagnosticRequestObserver: RequestPrefixObserver | undefined;

async function* streamChatCompletion(
  opts: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    maxProviderRetries: number;
    retryDelayMs: number;
    requestTimeoutMs: number;
    chatCompatibility: OpenAIChatCompatibility;
    requestObserver?: RequestPrefixObserver;
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

  // F7/R6: the wire body is serialized HERE, and the tool-protocol check runs
  // on that serialized array immediately before the send — never on an assumed
  // shape. `toOpenAiMessage` is 1:1, but the check does not rely on that: a
  // `tool` message without a `tool_call_id` becomes `{role:"tool"}` with no
  // correlation id on the wire, and the serialized check sees exactly that.
  // ModelRequest.system is assembled by the context pipeline separately from
  // durable history. Preserve its exact bytes on every send, including retries,
  // without rewriting history or splitting assistant/tool groups.
  const wireMessages: OpenAiMessage[] = [
    ...(request.system !== undefined && request.system.length > 0
      ? [{ role: "system", content: request.system }]
      : []),
    ...request.messages.map(toOpenAiMessage),
  ];
  const body: Record<string, unknown> = {
    model: opts.modelId,
    messages: wireMessages,
    stream: true,
    // Request stream usage so token accounting works on compatible servers
    // (plan.md Phase 8/10 observability; harmless for servers that ignore it).
    stream_options: { include_usage: true },
  };

  if (request.maxTokens !== undefined) {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1) {
      throw new AgentError(errorInfo("MODEL_ERROR", "maxTokens must be a positive safe integer", { retryable: false, safeToRetry: false, provider: { kind: "protocol" } }));
    }
    body[opts.chatCompatibility.maxTokensField] = request.maxTokens;
  }
  if (request.reasoningEffort !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(request.reasoningEffort)) throw new AgentError(errorInfo("MODEL_ERROR", "Invalid reasoning effort", { retryable: false, safeToRetry: false, provider: { kind: "protocol" } }));
    body.reasoning_effort = request.reasoningEffort;
  }
  if (request.temperature !== undefined) {
    if (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
      throw new AgentError(errorInfo("MODEL_ERROR", "temperature must be between 0 and 2", { retryable: false, safeToRetry: false, provider: { kind: "protocol" } }));
    }
    if (!opts.chatCompatibility.supportsTemperature) {
      throw new AgentError(errorInfo("MODEL_ERROR", `temperature is not supported for ${opts.modelId} on this endpoint; omit temperature to use the provider's default reasoning configuration`, { retryable: false, safeToRetry: false, provider: { kind: "protocol" } }));
    }
    body.temperature = request.temperature;
  }

  // P2-43: an illegal advertised function name fails closed locally. The
  // diagnostic bundle is attached so a real-world 11133 can be correlated with
  // the exact request structure without retaining any content.
  let tools: ReturnType<typeof toOpenAiTool>[] | undefined;
  try {
    tools = request.tools?.map(toOpenAiTool);
  } catch (err) {
    if (err instanceof AgentError) {
      throw new AgentError({
        ...err.info,
        provider: err.info.provider ?? { kind: "protocol" },
        evidence: JSON.stringify(
          buildProviderDiagnosticBundle({
            reason: "tool_name_not_in_grammar",
            messages: wireMessages,
            endpoint: opts.baseUrl,
            modelId: opts.modelId,
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
          }),
        ),
      });
    }
    throw err;
  }
  if (tools?.length) body.tools = tools;

  // F7/R6: refuse a wire-illegal request LOCALLY. This is the last point before
  // the socket: a violation here means the durable transcript / view repair
  // produced a pairing a strict OpenAI-compatible upstream rejects (the
  // observed 11148 "tool calls and tool results do not match"). No fetch is
  // issued, so the physical HTTP count for this attempt is 0.
  const wireIssues = findSerializedWireIssues(wireMessages);
  if (wireIssues.length > 0) {
    throw new AgentError(
      errorInfo(
        "MODEL_ERROR",
        `refusing to send a wire-illegal chat request: ${wireIssues.length} tool-protocol violation(s) in the serialized message view — every assistant 'tool_calls' block must be followed immediately by exactly one 'tool' message per 'tool_call_id'\n${renderWireIssues(wireIssues)}`,
        {
          retryable: false,
          safeToRetry: false,
          provider: { kind: "protocol" },
          evidence: JSON.stringify(
            buildProviderDiagnosticBundle({
              reason: "wire_protocol_violation",
              messages: wireMessages,
              endpoint: opts.baseUrl,
              modelId: opts.modelId,
              ...(request.tools !== undefined ? { tools: request.tools } : {}),
            }),
          ),
        },
      ),
    );
  }

  const serializedBody = JSON.stringify(body);
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      opts.requestObserver?.observe(body, serializedBody, JSON.stringify([opts.baseUrl, opts.modelId, request.messages[0]?.sessionId ?? "unscoped"]));
      response = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "text/event-stream",
        },
        body: serializedBody,
        signal: effectiveSignal,
      });
    } catch (err) {
      if (signal.aborted) {
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
        await backoff(opts.retryDelayMs, attempt, undefined, effectiveSignal);
        continue;
      }
      yield { type: "error", error: info, timestamp: Date.now() };
      return;
    }

    if (!response.ok) {
      const detail = await summarizeBody(response);
      // Reading an error body is still part of the request. Native fetch aborts
      // that read on cancellation/deadline; the best-effort summary deliberately
      // swallows its exception, so restore the actual terminal cause here before
      // an HTTP diagnostic or retry can replace it.
      if (signal.aborted) {
        yield { type: "completed", result: { finishReason: "cancelled" }, timestamp: Date.now() };
        return;
      }
      if (timedOut()) {
        yield {
          type: "error",
          error: errorInfo("MODEL_ERROR", timeoutMessage, { provider: { kind: "timeout" } }),
          timestamp: Date.now(),
        };
        return;
      }
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
          // F7/R6: a REAL provider error carries a redaction-safe diagnostic
          // bundle — request structure, tool call/result ID correlation, digests,
          // status and a stable reason — so the 11148 class is diagnosable from
          // the run artifact without retaining any user content or tool output.
          evidence: JSON.stringify(
            buildProviderDiagnosticBundle({
              reason: "http_status",
              messages: wireMessages,
              endpoint: opts.baseUrl,
              modelId: opts.modelId,
              status: response.status,
              ...(request.tools !== undefined ? { tools: request.tools } : {}),
            }),
          ),
        },
      );
      // 429 (rate limit) and 5xx are transient; other statuses (401/403/400)
      // are not retried. Streaming has not started at this point, so a
      // retry is safe: the request body is unchanged and idempotent.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < opts.maxProviderRetries) {
        yield { type: "retry", attempt: attempt + 1, error: info, timestamp: Date.now() };
        await backoff(opts.retryDelayMs, attempt, retryAfterMs, effectiveSignal);
        continue;
      }
      yield { type: "error", error: info, timestamp: Date.now() };
      return;
    }

    break;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield {
      type: "completed",
      result: { finishReason: "error", text: "", error: streamTerminationError("missing_body") },
      timestamp: Date.now(),
    };
    return;
  }

  const decoder = new SseEventDecoder();
  let payloads: string[] = [];
  let streamEnded = false;
  let text = "";
  /** Accumulated thinking-mode reasoning content (deepseek reasoning_content). */
  let reasoning = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | undefined;
  let aborted = false;
  let normalReason: "stop" | "tool_calls" | "length" | undefined;
  let semanticOutputSeen = false;

  let abortResolve: (() => void) | undefined;
  const onAbort = () => { aborted = true; abortResolve?.(); };
  effectiveSignal.addEventListener("abort", onAbort);
  const abortSignal = new Promise<"abort">((resolve) => {
    abortResolve = () => resolve("abort");
  });
  if (effectiveSignal.aborted) aborted = true;

  const finishEvents = (reason: FinishReason, error?: ReturnType<typeof errorInfo>, emitToolDeltas = true): ModelEvent[] => {
    const calls: ToolCall[] = [...toolCalls.values()].map((tc) => ({
      id: tc.id ? (tc.id as ToolCallId) : newToolCallId(),
      name: tc.name,
      args: parseArgs(tc.args),
    }));
    const events: ModelEvent[] = (emitToolDeltas ? calls : []).map((call) => ({
      type: "tool_call_delta",
      toolCall: call,
      timestamp: Date.now(),
    }));
    events.push({
      type: "completed",
      result: {
        finishReason: reason,
        ...(error ? { error } : {}),
        text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(reasoning.length > 0 ? { reasoningContent: reasoning } : {}),
        ...(usage ? { usage } : {}),
      },
      timestamp: Date.now(),
    });
    return events;
  };

  const processData = (payload: string): { events: ModelEvent[]; finished: boolean } => {
    if (payload === "[DONE]") {
      // R1: DONE closes the transport; it does not certify model completion.
      // A stored normal reason certifies the output; the transport can close
      // without the optional usage footer on compatible providers.
      return {
        events: normalReason === undefined
          ? finishEvents("error", streamTerminationError("done"))
          : finishEvents(normalReason),
        finished: true,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      if (normalReason !== undefined) return { events: [], finished: false };
      return { events: finishEvents("error", streamPayloadError("malformed JSON data"), false), finished: true };
    }
    // Once completion has been certified, only usage is consumed. Preserve the
    // existing immutable-boundary rule for any later output mutations.
    if (normalReason === undefined) {
      const violation = chunkOutputViolation(parsed);
      if (violation !== undefined) return { events: finishEvents("error", streamPayloadError(violation), false), finished: true };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { events: [], finished: false };
    const chunk = parsed as ChatChunk;
    const events: ModelEvent[] = [];
    if (chunk.error && normalReason === undefined) {
      const status = Number(chunk.error.status ?? chunk.error.code);
      const kind = status === 429 || chunk.error.type === "rate_limit_error" ? "rate_limit"
        : status >= 500 && status <= 599 ? "server_error" : "http";
      const safe = !semanticOutputSeen && (kind === "rate_limit" || kind === "server_error");
      const info = errorInfo("MODEL_ERROR", `OpenAI SSE provider error: ${summarize(chunk.error.message ?? chunk.error.type ?? "unknown provider error")}`, {
        retryable: safe, safeToRetry: safe, provider: { kind, ...(Number.isSafeInteger(status) && status >= 400 && status <= 599 ? { status } : {}) },
      });
      return { events: !semanticOutputSeen ? [{ type: "error", error: info, timestamp: Date.now() }] : finishEvents("error", info), finished: true };
    }
    const choice = chunk.choices?.[0];
    if (chunk.usage) {
      const snapshot = parseOpenAIUsage(chunk.usage);
      if (snapshot !== undefined) {
        usage = { ...usage, ...snapshot };
        if (snapshot.cacheUsageIssue !== undefined) {
          delete usage.cacheReadTokens;
          delete usage.cacheUsageSource;
        } else if (snapshot.cacheReadTokens !== undefined) {
          delete usage.cacheUsageIssue;
        }
        // A later cumulative footer may revise input without repeating cache
        // details. Revalidate the merged subset instead of retaining stale hits.
        if (usage.inputTokens !== undefined && usage.cacheReadTokens !== undefined && usage.cacheReadTokens > usage.inputTokens) {
          usage.cacheUsageIssue = "invalid";
          delete usage.cacheReadTokens;
          delete usage.cacheUsageSource;
        }
        events.push({ type: "usage", usage, timestamp: Date.now() });
      }
    }
    if (normalReason !== undefined) {
      // The output boundary is immutable. Only a final usage snapshot may
      // arrive after it; later choices cannot add output or alter tool intent.
      return chunk.usage
        ? { events: [...events, ...finishEvents(normalReason)], finished: true }
        : { events, finished: false };
    }
    const delta = choice?.delta;
    if (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length) semanticOutputSeen = true;
    if (delta?.content) {
      text += delta.content;
      events.push({ type: "text_delta", text: delta.content, timestamp: Date.now() });
    }
    if (delta?.reasoning_content) {
      reasoning += delta.reasoning_content;
      events.push({ type: "reasoning_delta", text: delta.reasoning_content, timestamp: Date.now() });
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
    const reason = choice?.finish_reason;
    // MEASURED (the approved local OpenAI-compatible endpoint): a server may send
    // `finish_reason: ""` on EVERY content frame and the real reason only on the
    // final frame. An empty string carries no terminal meaning — treating it as an
    // abnormal terminal reason aborted the whole turn on the first frame, before
    // any tool call, so `""` must mean "not finished yet", exactly like absent.
    if (reason !== undefined && reason !== null && reason !== "") {
      if (reason !== "stop" && reason !== "tool_calls" && reason !== "length") {
        return { events: [...events, ...finishEvents("error", streamTerminationError("finish_reason", reason))], finished: true };
      }
      normalReason = reason;
      // An earlier usage snapshot can be partial. Finish immediately only if
      // this normal finish frame itself carries usage; otherwise read the
      // requested standalone footer, DONE, or EOF before completing.
      return chunk.usage
        ? { events: [...events, ...finishEvents(reason)], finished: true }
        : { events, finished: false };
    }
    return { events, finished: false };
  };

  let finished = false;
  let streamError: ReturnType<typeof errorInfo> | undefined;
  try {
    while (!finished && !aborted) {
      let events: ModelEvent[];
      let finalFrame: boolean;
      if (streamEnded && payloads.length === 0) {
        // EOF belongs to the same guarded event path as DONE and usage.
        // In particular, a caller can abort after a yielded tool delta.
        events = normalReason === undefined
          ? finishEvents("error", streamTerminationError("eof"))
          : finishEvents(normalReason);
        finalFrame = true;
      } else {
        while (payloads.length === 0 && !streamEnded) {
          const outcome = await Promise.race([reader.read(), abortSignal]);
          if (outcome === "abort") {
            aborted = true;
            break;
          }
          if (outcome.done) {
            streamEnded = true;
            payloads = decoder.finish();
            break;
          }
          payloads = decoder.push(outcome.value);
        }
        if (aborted) break;
        if (streamEnded && payloads.length === 0) continue;
        const payload = payloads.shift()!.trim();
        if (!payload) continue;
        const parsed = processData(payload);
        events = parsed.events;
        finalFrame = parsed.finished;
      }
      for (const ev of events) {
        if (effectiveSignal.aborted) { aborted = true; break; }
        // Once completion has actually been delivered, a later caller abort
        // cannot produce a second terminal event for this call.
        if (ev.type === "completed") finished = true;
        yield ev;
        if (effectiveSignal.aborted && !finished) { aborted = true; break; }
      }
      if (finalFrame && !aborted) finished = true;
    }
  } catch (err) {
    // Native fetch can reject reader.read() before the abort race resolves.
    // Classify by the effective signal rather than leaking an AbortError or
    // treating a timeout as caller cancellation. Partial output never retries.
    if (effectiveSignal.aborted) aborted = true;
    else {
      // A connection reset before any semantic output is safe to replay via
      // the Runtime's existing finite retry policy. Once even reasoning or
      // partial tool arguments arrived, preserve the no-replay boundary.
      const safe = !semanticOutputSeen && normalReason === undefined;
      streamError = errorInfo("MODEL_ERROR", `OpenAI chat completion stream failed: ${summarize(err)}`, {
        retryable: safe,
        safeToRetry: safe,
        provider: { kind: "network" },
      });
    }
  } finally {
    effectiveSignal.removeEventListener("abort", onAbort);
    // The generator owns the body reader, including when its consumer returns
    // early. Cleanup must never replace the original result or read error.
    try { await reader.cancel(); } catch {
      process.stderr.write("[degraded] openai.reader.cancel: response cleanup failed\n");
    }
    try { reader.releaseLock(); } catch {
      process.stderr.write("[degraded] openai.reader.releaseLock: response cleanup failed\n");
    }
  }

  if (aborted && !finished) {
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
  if (streamError !== undefined) {
    yield { type: "error", error: streamError, timestamp: Date.now() };
    return;
  }
}

/**
 * OpenAI-compatible model provider (OpenAI, Azure OpenAI-compatible
 * gateways, Ollama/OpenAI-proxy endpoints, etc.).
 *
 * Identity resolution, per createClient() call:
 *   config.apiKey/baseUrl/modelId (call-site) >
 *   constructor identity (E4-R83) >
 *   requested ModelRef.modelId (model only) >
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL env >
 *   built-in default.
 *
 * The runtime calls createClient(model, {}) with an EMPTY call config, so the
 * constructor identity is what lets the CLI's explicit --provider/--model/
 * --endpoint flags survive into the actual HTTP request. A missing key throws
 * MODEL_ERROR with a message that never echoes the key itself.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai";

  /** E4-R83 (F83-1): identity fixed at construction time. Nullable so the
   *  legacy no-arg construction keeps pure env/default resolution. */
  private readonly identity: {
    apiKey?: string;
    baseUrl?: string;
    modelId?: string;
    chatCompatibility?: Partial<OpenAIChatCompatibility>;
    onRequestObservation?: (value: RequestPrefixObservation) => void;
  };
  private readonly requestPolicy?: Readonly<OpenAIRequestPolicy>;
  private readonly requestObserver?: RequestPrefixObserver;

  constructor(identity: {
    apiKey?: string;
    baseUrl?: string;
    modelId?: string;
    chatCompatibility?: Partial<OpenAIChatCompatibility>;
    onRequestObservation?: (value: RequestPrefixObservation) => void;
    requestPolicy?: Readonly<OpenAIRequestPolicy>;
  } = {}) {
    this.identity = identity;
    if (identity.onRequestObservation !== undefined) this.requestObserver = new RequestPrefixObserver(identity.onRequestObservation);
    if (identity.requestPolicy !== undefined) {
      this.requestPolicy = Object.freeze(resolveOpenAIRequestPolicy({ ...identity.requestPolicy }, {}));
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // TODO: the real list lives behind GET {baseUrl}/models (needs the API
    // key). Until that endpoint is wired, expose no static list.
    return [];
  }

  createClient(ref: ModelRef, config: ProviderConfig): ModelClient {
    const str = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const baseUrl = (str(config.baseUrl) ?? str(this.identity.baseUrl) ?? str(process.env.OPENAI_BASE_URL) ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    const apiKey = str(config.apiKey) ?? str(this.identity.apiKey) ?? str(process.env.OPENAI_API_KEY);
    // A pinned constructor identity must keep the formal execution identity
    // stable. Otherwise the selected ModelRef is the model this client serves;
    // environment defaults must not silently replace an SDK/host selection.
    const modelId = str(config.modelId) ?? str(this.identity.modelId) ?? str(ref.modelId) ?? str(process.env.OPENAI_MODEL) ?? DEFAULT_MODEL;
    if (!apiKey) {
      throw new AgentError(
        errorInfo("MODEL_ERROR", "OpenAI provider requires an API key: set config.apiKey or the OPENAI_API_KEY environment variable", {
          retryable: false,
          safeToRetry: false,
        }),
      );
    }
    // P38.4-real: allow the provider retry budget to be tuned via environment
    // variables (same OPENAI_* convention as apiKey/baseUrl/modelId). TPM-limited
    // servers need more retries and a longer backoff than the defaults; the
    // runtime calls createClient(model, {}), so identity reaches the request via
    // the call config or (E4-R83) the provider constructor, and the retry budget
    // via env. Explicit config values win over env vars (tests and callers that
    // pass config keep their behavior).
    let requestPolicy: OpenAIRequestPolicy;
    if (this.requestPolicy === undefined) {
      requestPolicy = resolveOpenAIRequestPolicy(config);
    } else {
      // Invalid overrides keep the constructor's frozen fallback, just as
      // invalid legacy overrides keep the valid env/default value.
      const frozenConfig: ProviderConfig = { ...this.requestPolicy };
      for (const key of Object.keys(frozenConfig)) {
        if (isPolicyNumber(config[key])) frozenConfig[key] = config[key];
      }
      requestPolicy = resolveOpenAIRequestPolicy(frozenConfig, {});
    }
    const { maxProviderRetries, retryDelayMs, requestTimeoutMs } = requestPolicy;
    const chatCompatibility = resolveOpenAIChatCompatibility(baseUrl, modelId,
      config.chatCompatibility !== undefined ? config.chatCompatibility : this.identity.chatCompatibility);
    const requestObserver = this.requestObserver ?? (process.env.HARNESS_CACHE_DIAGNOSTICS === "1"
      ? diagnosticRequestObserver ??= new RequestPrefixObserver(value => { process.stderr.write(`[cache-diagnostics] ${JSON.stringify(value)}\n`); })
      : undefined);
    return {
      generate: (request, signal) =>
        streamChatCompletion(
          {
            baseUrl,
            apiKey,
            modelId,
            maxProviderRetries,
            retryDelayMs,
            requestTimeoutMs,
            chatCompatibility,
            requestObserver,
          },
          request,
          signal,
        ),
    };
  }
}
