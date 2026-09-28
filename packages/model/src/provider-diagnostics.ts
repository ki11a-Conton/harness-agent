import { createHash } from "node:crypto";
import type { SerializedChatMessage } from "@ar/contracts";
import { redactSecrets } from "@ar/security";

/**
 * F7 / R6 — redaction-safe diagnostic bundle for REAL provider errors.
 *
 * The 11148 incident (`{"code":11148,"msg":"tool calls and tool results do not
 * match"}`) could not be root-caused because the failing request body was not
 * retained anywhere in the run artifact (docs/evidence/E4-N8-paid-run-executed.md
 * §6.1). Retaining the body verbatim is not an option: it carries the user's
 * full conversation and tool output.
 *
 * This bundle keeps exactly what is needed to diagnose that class of failure —
 * request STRUCTURE, tool call/result ID correlation, model/endpoint digests,
 * HTTP status and a stable reason — and never the API key, message content or
 * tool output. Sizes are recorded; text is not.
 */

export const PROVIDER_DIAGNOSTIC_SCHEMA = "ar.provider-diagnostics.v1";

/** Correlation entries are capped so one pathological transcript cannot turn a
 *  diagnostic into an unbounded artifact. */
const MAX_CORRELATION_ENTRIES = 64;
const MAX_TOOL_NAMES = 32;
const DIGEST_CHARS = 16;

/** Stable reason codes — never free-form provider text. */
export type ProviderDiagnosticReason =
  | "wire_protocol_violation"
  | "tool_name_not_in_grammar"
  | "http_status"
  | "transport_error"
  | "stream_timeout";

export interface ToolCallCorrelation {
  /** Index of the assistant message carrying the call. */
  callIndex: number;
  callId: string;
  name: string;
  /** How many `tool` messages answer this id. */
  resultCount: number;
  /** Indexes of those `tool` messages. */
  resultIndexes: number[];
  /** True when the id is requested more than once in the same assistant message. */
  duplicatedRequest: boolean;
}

export interface ProviderDiagnosticBundle {
  schema: typeof PROVIDER_DIAGNOSTIC_SCHEMA;
  reason: ProviderDiagnosticReason;
  /** HTTP status when one was observed; `null` when no request was made. */
  status: number | null;
  /** sha256 digest of the redacted endpoint — the URL itself is not retained. */
  endpointDigest: string;
  /** sha256 digest of the model id — used to correlate without pinning. */
  modelDigest: string;
  request: {
    messageCount: number;
    /** Per-message role, with `assistant+tool_calls` when calls are attached. */
    roles: string[];
    toolCallCount: number;
    toolResultCount: number;
    toolNames: string[];
    /** Byte sizes only — never the text. */
    contentBytes: number;
    toolArgumentBytes: number;
    toolOutputBytes: number;
    /** Names advertised in `tools[]` (redacted); empty when none were sent. */
    advertisedToolNames: string[];
    advertisedToolCount: number;
  };
  toolCallIdCorrelation: ToolCallCorrelation[];
  /** Every requested id that no `tool` message answers (the 11148 signature). */
  unansweredToolCallIds: string[];
  /** `tool` messages that answer no assistant call present in this request. */
  orphanToolResultIndexes: number[];
  correlationTruncated: boolean;
  /** Marks the bundle as safe to persist; content retention is FALSE by design. */
  redacted: true;
  contentRetained: false;
}

/** Short, stable digest of a string (sha256, truncated). Not reversible. */
export function diagnosticDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, DIGEST_CHARS);
}

/** Strip credentials/userinfo from an endpoint before digesting it, so a URL
 *  with `?api_key=...` or `user:pass@host` cannot leak through the digest
 *  input, the reason, or a stray log line. */
export function redactEndpoint(endpoint: string): string {
  const withoutUserInfo = endpoint.replace(/\/\/[^/@\s]*@/g, "//");
  return redactSecrets(withoutUserInfo).content;
}

export interface ProviderDiagnosticInput {
  reason: ProviderDiagnosticReason;
  messages: readonly SerializedChatMessage[];
  endpoint?: string;
  modelId?: string;
  status?: number;
  tools?: readonly { name: string }[];
}

function byteLength(value: unknown): number {
  if (typeof value !== "string") return 0;
  return Buffer.byteLength(value, "utf8");
}

/**
 * Build the bundle. Pure, deterministic, and safe to attach to a
 * `model.failed` event / error `evidence` string.
 */
export function buildProviderDiagnosticBundle(input: ProviderDiagnosticInput): ProviderDiagnosticBundle {
  const roles: string[] = [];
  const correlation: ToolCallCorrelation[] = [];
  const toolNames: string[] = [];
  const unanswered = new Set<string>();
  const orphanIndexes: number[] = [];
  let toolCallCount = 0;
  let toolResultCount = 0;
  let contentBytes = 0;
  let toolArgumentBytes = 0;
  let toolOutputBytes = 0;

  // Map<callId, correlation> for ids requested by any assistant message.
  const byCallId = new Map<string, ToolCallCorrelation>();

  for (let i = 0; i < input.messages.length; i += 1) {
    const message = input.messages[i]!;
    const calls = message.role === "assistant" ? message.tool_calls : undefined;
    roles.push(calls?.length ? "assistant+tool_calls" : message.role);
    contentBytes += byteLength(message.content);

    if (calls?.length) {
      for (const call of calls) {
        toolCallCount += 1;
        const id = typeof call.id === "string" ? call.id : "";
        const name = call.function?.name ?? "";
        toolArgumentBytes += byteLength(call.function?.arguments);
        if (name && !toolNames.includes(name) && toolNames.length < MAX_TOOL_NAMES) toolNames.push(name);
        const existing = byCallId.get(id);
        if (existing === undefined) {
          const entry: ToolCallCorrelation = {
            callIndex: i,
            callId: id,
            name,
            resultCount: 0,
            resultIndexes: [],
            duplicatedRequest: false,
          };
          byCallId.set(id, entry);
          correlation.push(entry);
        } else {
          existing.duplicatedRequest = true;
        }
        unanswered.add(id);
      }
      continue;
    }

    if (message.role === "tool") {
      toolResultCount += 1;
      toolOutputBytes += byteLength(message.content);
      const id = message.tool_call_id;
      if (id === undefined || id.length === 0) {
        orphanIndexes.push(i);
        continue;
      }
      const entry = byCallId.get(id);
      if (entry === undefined) {
        orphanIndexes.push(i);
        continue;
      }
      entry.resultCount += 1;
      entry.resultIndexes.push(i);
      unanswered.delete(id);
    }
  }

  const truncated = correlation.length > MAX_CORRELATION_ENTRIES;

  return {
    schema: PROVIDER_DIAGNOSTIC_SCHEMA,
    reason: input.reason,
    status: input.status ?? null,
    endpointDigest: diagnosticDigest(redactEndpoint(input.endpoint ?? "")),
    modelDigest: diagnosticDigest(redactSecrets(input.modelId ?? "").content),
    request: {
      messageCount: input.messages.length,
      roles,
      toolCallCount,
      toolResultCount,
      toolNames,
      contentBytes,
      toolArgumentBytes,
      toolOutputBytes,
      advertisedToolNames: (input.tools ?? [])
        .slice(0, MAX_TOOL_NAMES)
        .map((tool) => redactSecrets(tool.name).content),
      advertisedToolCount: input.tools?.length ?? 0,
    },
    toolCallIdCorrelation: truncated ? correlation.slice(0, MAX_CORRELATION_ENTRIES) : correlation,
    unansweredToolCallIds: [...unanswered],
    orphanToolResultIndexes: orphanIndexes,
    correlationTruncated: truncated,
    redacted: true,
    contentRetained: false,
  };
}
