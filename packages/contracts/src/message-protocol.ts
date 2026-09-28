import type { Message } from "./message.js";
import { TOOL_NAME_PATTERN, isValidToolName } from "./tool.js";

/**
 * P2-41/PROTOCOL: the OpenAI-compatible chat protocol requires that an
 * assistant message carrying `tool_calls` is followed IMMEDIATELY by one
 * `tool` message per requested `tool_call_id` — nothing may be interleaved
 * between the assistant message and its tool results.
 *
 * A strict upstream rejects a request that violates this with HTTP 400
 * ("An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"). The transcript is mapped 1:1 onto the
 * wire (`toOpenAiMessage`), so ANY interleaved or missing result is fatal for
 * the NEXT request, not merely a cosmetic ordering issue.
 *
 * These helpers are pure and dependency-free so they can be used both as a
 * runtime invariant and as a test assertion.
 */

export interface ToolProtocolViolation {
  /** Index of the offending assistant message. */
  assistantIndex: number;
  /** `tool_call_id`s the assistant requested that have no adjacent result. */
  missingToolCallIds: string[];
  /** Index of the first message that terminated the expected tool block. */
  interruptedByIndex?: number;
  /** Role of that interrupting message (when present). */
  interruptedByRole?: Message["role"];
}

/**
 * Collect every tool-protocol violation in `messages`.
 *
 * A block is valid when, for an assistant message with tool calls at index
 * `i`, every requested id appears among the contiguous run of `role:"tool"`
 * messages starting at `i + 1`.
 */
export function findToolProtocolViolations(
  messages: readonly Message[],
): ToolProtocolViolation[] {
  const violations: ToolProtocolViolation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;

    const requested = new Set(message.toolCalls.map((call) => call.id as string));
    const seen = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const id = messages[j]!.toolCallId;
      if (id !== undefined) seen.add(id);
      j += 1;
    }

    const missing = [...requested].filter((id) => !seen.has(id));
    if (missing.length === 0) continue;

    // Only report an interleaving when the block was cut short by a non-tool
    // message before every id was answered (the run of tool messages ended
    // while requests were still outstanding).
    const interrupted = j < messages.length ? messages[j]! : undefined;
    violations.push({
      assistantIndex: i,
      missingToolCallIds: missing,
      ...(interrupted !== undefined
        ? { interruptedByIndex: j, interruptedByRole: interrupted.role }
        : {}),
    });
  }
  return violations;
}

/* ── F7 / R6: the COMPLETE wire-legality check ─────────────────────────────
 *
 * `findToolProtocolViolations` above checks ONE direction only: a requested
 * `tool_call_id` with no adjacent result. That is NOT a complete wire-legality
 * guarantee, and the names `isToolProtocolValid` / `assertToolProtocol`
 * overstated it: an orphaned result (no preceding assistant), a duplicated
 * result, an extra result with an unrequested id, a `tool_call_id` requested
 * twice by one assistant message, an interleaved non-tool message and an
 * illegal tool-call name all passed the old helpers while a strict
 * OpenAI-compatible upstream rejects the request (HTTP 400, the observed
 * `{"code":11148,"msg":"tool calls and tool results do not match"}` family).
 *
 * `findWireProtocolIssues` is the unified, complete check. It runs on the
 * model-VISIBLE view immediately before the provider send, and
 * `findSerializedWireIssues` runs on the actual SERIALIZED request body, so a
 * bad block is rejected locally with zero physical HTTP requests.
 */

/** Stable, machine-readable wire-protocol failure classes. Each is a distinct
 *  diagnostic the caller can branch on, log and replay. */
export type WireProtocolIssueCode =
  /** An assistant requested a `tool_call_id` that no adjacent `tool` message answered. */
  | "missing_tool_result"
  /** A `tool` message with no preceding assistant `tool_calls` block in this view. */
  | "orphan_tool_result"
  /** A `tool` message answering an id the CURRENT assistant block did not request. */
  | "unexpected_tool_result"
  /** The same `tool_call_id` answered twice inside one block. */
  | "duplicate_tool_result"
  /** `role:"tool"` with no `tool_call_id` (the wire would carry no correlation id). */
  | "tool_result_without_id"
  /** One assistant message requests the same `tool_call_id` more than once. */
  | "duplicate_tool_call_id"
  /** A non-tool message was inserted between an assistant `tool_calls` and its results. */
  | "interleaved_message"
  /** An assistant `tool_calls` name is outside the provider function-name grammar. */
  | "invalid_tool_call_name";

export interface WireProtocolIssue {
  code: WireProtocolIssueCode;
  /** Index of the offending message (the assistant, for `missing_tool_result`). */
  index: number;
  /** Index of the assistant `tool_calls` message the issue belongs to. */
  assistantIndex?: number;
  /** `tool_call_id`s implicated by the issue. */
  toolCallIds?: string[];
  /** Role of the message that interrupted a tool block. */
  interruptedByRole?: string;
  /** Human-readable, content-free explanation (never message text). */
  detail: string;
}

/** Structural shape of ONE serialized OpenAI-compatible chat message (the
 *  actual elements of the wire body's `messages` array). Structural on
 *  purpose: contracts must not depend on the model package. */
export interface SerializedChatMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ReadonlyArray<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface NormalizedWireMessage {
  role: string;
  /** ids requested by an assistant `tool_calls` message (order preserved). */
  requestedIds: string[];
  requestedNames: string[];
  /** the id a `tool` message answers. */
  resultId?: string;
}

function normalizeTranscriptMessage(message: Message): NormalizedWireMessage {
  if (message.role === "tool") {
    return { role: "tool", requestedIds: [], requestedNames: [], resultId: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      requestedIds: message.toolCalls.map((call) => call.id as string),
      requestedNames: message.toolCalls.map((call) => call.name),
    };
  }
  return { role: message.role, requestedIds: [], requestedNames: [] };
}

function normalizeSerializedMessage(message: SerializedChatMessage): NormalizedWireMessage {
  if (message.role === "tool") {
    return { role: "tool", requestedIds: [], requestedNames: [], resultId: message.tool_call_id };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      requestedIds: message.tool_calls.map((call) => (typeof call.id === "string" ? call.id : "")),
      requestedNames: message.tool_calls.map((call) => call.function?.name ?? ""),
    };
  }
  return { role: message.role, requestedIds: [], requestedNames: [] };
}

/** The single algorithm behind every wire-legality verdict, over a normalized
 *  view. A "block" opens at an assistant message carrying `tool_calls` and
 *  closes at the first message that is not a `tool` result (or at end of list).
 *  While it is open, every requested id must be answered exactly once and
 *  nothing else may be a `tool` message. */
function findIssuesInNormalizedView(messages: readonly NormalizedWireMessage[]): WireProtocolIssue[] {
  const issues: WireProtocolIssue[] = [];
  let blockActive = false;
  let assistantIndex = -1;
  let expected: readonly string[] = [];
  let answered = new Set<string>();

  const closeBlock = (interruptedByIndex?: number, interruptedByRole?: string): void => {
    const missing = [...new Set(expected)].filter((id) => !answered.has(id));
    if (missing.length > 0) {
      const where =
        interruptedByIndex !== undefined
          ? ` before the block was interrupted at index ${interruptedByIndex} by role="${interruptedByRole}"`
          : " before the view ended";
      issues.push({
        code: "missing_tool_result",
        index: assistantIndex,
        assistantIndex,
        toolCallIds: missing,
        ...(interruptedByRole !== undefined ? { interruptedByRole } : {}),
        detail: `assistant[${assistantIndex}] requested ${missing.join(", ")} but no adjacent tool message answered ${missing.length === 1 ? "it" : "them"}${where}`,
      });
      if (interruptedByIndex !== undefined) {
        issues.push({
          code: "interleaved_message",
          index: interruptedByIndex,
          assistantIndex,
          toolCallIds: missing,
          ...(interruptedByRole !== undefined ? { interruptedByRole } : {}),
          detail: `role="${interruptedByRole}" at index ${interruptedByIndex} splits the tool block of assistant[${assistantIndex}]`,
        });
      }
    }
    blockActive = false;
    assistantIndex = -1;
    expected = [];
    answered = new Set<string>();
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;

    if (message.role === "assistant" && message.requestedIds.length > 0) {
      // A new tool_calls block while the previous one is still open: legal only
      // when the previous block was fully answered.
      if (blockActive) closeBlock(i, "assistant");
      const duplicates = [
        ...new Set(message.requestedIds.filter((id, at) => message.requestedIds.indexOf(id) !== at)),
      ];
      if (duplicates.length > 0) {
        issues.push({
          code: "duplicate_tool_call_id",
          index: i,
          assistantIndex: i,
          toolCallIds: duplicates,
          detail: `assistant[${i}] requests the same tool_call_id more than once: ${duplicates.join(", ")}`,
        });
      }
      const badNames = [...new Set(message.requestedNames.filter((name) => !isValidToolName(name)))];
      if (badNames.length > 0) {
        issues.push({
          code: "invalid_tool_call_name",
          index: i,
          assistantIndex: i,
          detail: `assistant[${i}] carries tool_call name(s) outside ${TOOL_NAME_PATTERN.source}: ${badNames.map((name) => JSON.stringify(name)).join(", ")}`,
        });
      }
      blockActive = true;
      assistantIndex = i;
      expected = message.requestedIds;
      answered = new Set<string>();
      continue;
    }

    if (message.role === "tool") {
      if (!blockActive) {
        issues.push({
          code: "orphan_tool_result",
          index: i,
          ...(message.resultId !== undefined ? { toolCallIds: [message.resultId] } : {}),
          detail: `tool message at index ${i} answers no preceding assistant tool_calls block`,
        });
        continue;
      }
      if (message.resultId === undefined || message.resultId.length === 0) {
        issues.push({
          code: "tool_result_without_id",
          index: i,
          assistantIndex,
          detail: `tool message at index ${i} carries no tool_call_id`,
        });
        continue;
      }
      if (!expected.includes(message.resultId)) {
        issues.push({
          code: "unexpected_tool_result",
          index: i,
          assistantIndex,
          toolCallIds: [message.resultId],
          detail: `tool message at index ${i} answers "${message.resultId}", which assistant[${assistantIndex}] did not request`,
        });
        continue;
      }
      if (answered.has(message.resultId)) {
        issues.push({
          code: "duplicate_tool_result",
          index: i,
          assistantIndex,
          toolCallIds: [message.resultId],
          detail: `tool message at index ${i} repeats the result for "${message.resultId}" already answered in assistant[${assistantIndex}]'s block`,
        });
        continue;
      }
      answered.add(message.resultId);
      continue;
    }

    // user / system / plain assistant: anything else closes an open block.
    if (blockActive) closeBlock(i, message.role);
  }

  if (blockActive) closeBlock();
  return issues;
}

/** Every wire-protocol violation in a model-visible transcript view. */
export function findWireProtocolIssues(messages: readonly Message[]): WireProtocolIssue[] {
  return findIssuesInNormalizedView(messages.map(normalizeTranscriptMessage));
}

/** Every wire-protocol violation in the ACTUAL serialized request body. This
 *  is the check that runs immediately before the provider send (the serialized
 *  array is what leaves the process — nothing may be assumed about the
 *  mapping). */
export function findSerializedWireIssues(messages: readonly SerializedChatMessage[]): WireProtocolIssue[] {
  return findIssuesInNormalizedView(messages.map(normalizeSerializedMessage));
}

/** True when `messages` is a complete, wire-legal tool-protocol view. */
export function isWireProtocolValid(messages: readonly Message[]): boolean {
  return findWireProtocolIssues(messages).length === 0;
}

/** True when the serialized body is wire-legal. */
export function isSerializedWireValid(messages: readonly SerializedChatMessage[]): boolean {
  return findSerializedWireIssues(messages).length === 0;
}

/**
 * P2-41 subset predicate, now backed by the COMPLETE check.
 *
 * The name is kept for the existing regression surface, but the old
 * missing-result-only implementation was the F7 coverage gap; this now returns
 * false for orphaned, duplicated, extra, duplicate-call-id, interleaved and
 * illegal-name views too.
 */
export function isToolProtocolValid(messages: readonly Message[]): boolean {
  return isWireProtocolValid(messages);
}

/**
 * Indexes of `tool` messages that answer no assistant `tool_calls` present in
 * THIS message list. A tool message whose assistant call was trimmed/sliced
 * away is an orphan, and a strict upstream rejects it just like a missing
 * result ("messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'").
 *
 * `messages` is typically the VIEW sent to the model (after trimming), not the
 * full durable transcript.
 */
export function findOrphanToolResults(messages: readonly Message[]): number[] {
  const orphans: number[] = [];
  // Outstanding ids accumulated by the most recent assistant tool_calls block.
  let outstanding = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      outstanding = new Set((message.toolCalls ?? []).map((call) => call.id as string));
      continue;
    }
    if (message.role !== "tool") {
      outstanding = new Set();
      continue;
    }
    const id = message.toolCallId;
    if (id === undefined || !outstanding.has(id)) {
      orphans.push(i);
      continue;
    }
    outstanding.delete(id);
  }
  return orphans;
}

/**
 * Drop `tool` messages that answer no assistant `tool_calls` in THIS list —
 * ONLY from a provably safe leading prefix.
 *
 * Used on the model-visible VIEW after a prefix trim/slice: trimming the
 * oldest messages can cut an assistant `tool_calls` message away while its
 * results remain. Those orphans are a contiguous LEADING run, and dropping
 * them is provably safe (the block they belonged to is not in the view at
 * all, so no in-view request loses an answer).
 *
 * F7/R6: an orphan that is NOT in the leading run means the block was split
 * inside the view (e.g. a system observation between `tool(a)` and `tool(b)`).
 * Dropping it would NOT repair the view — assistant[block] would still be
 * unanswered — so this function leaves it in place and the send-boundary
 * validator fails the request locally instead of hiding the corruption. The
 * durable transcript is never modified by this.
 */
export function dropOrphanToolResults(messages: readonly Message[]): Message[] {
  let leadingToolRun = 0;
  while (leadingToolRun < messages.length && messages[leadingToolRun]!.role === "tool") leadingToolRun += 1;
  if (leadingToolRun === 0) return [...messages];
  const orphans = new Set(findOrphanToolResults(messages).filter((index) => index < leadingToolRun));
  if (orphans.size === 0) return [...messages];
  return messages.filter((_, index) => !orphans.has(index));
}

/**
 * Assert the COMPLETE tool-protocol invariant, throwing with actionable detail.
 *
 * `assertToolProtocol(await store.listMessages(sessionId))` is the regression
 * guard: the original stall-ordering defect survived because the existing
 * tests asserted events/outcomes but never the persisted message ORDER. F7/R6
 * widened it from "missing result only" to the full wire-legality check, so a
 * corrupt view can no longer pass because a different helper would have caught
 * it.
 */
export function assertToolProtocol(messages: readonly Message[]): void {
  assertWireProtocol(messages);
}

/** Assert `messages` is a complete, wire-legal tool-protocol view. */
export function assertWireProtocol(messages: readonly Message[], context = "message view"): void {
  const issues = findWireProtocolIssues(messages);
  if (issues.length === 0) return;
  throw new Error(
    `tool protocol violation: an assistant message with 'tool_calls' must be followed immediately by one tool message per 'tool_call_id' — none missing, none interleaved, none duplicated, none extra (${context})\n${renderWireIssues(issues)}`,
  );
}

/** Assert the ACTUAL serialized request body is wire-legal. */
export function assertSerializedWire(
  messages: readonly SerializedChatMessage[],
  context = "serialized request body",
): void {
  const issues = findSerializedWireIssues(messages);
  if (issues.length === 0) return;
  throw new Error(
    `tool protocol violation in the ${context}: the assistant 'tool_calls' / 'tool' result pairing is not wire-legal\n${renderWireIssues(issues)}`,
  );
}

/** Stable one-line-per-issue rendering for logs and thrown messages. */
export function renderWireIssues(issues: readonly WireProtocolIssue[]): string {
  return issues.map((issue) => `  [${issue.code}] ${issue.detail}`).join("\n");
}
