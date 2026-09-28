import type { Message } from "./message.js";

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

/** True when every assistant `tool_calls` block is immediately answered. */
export function isToolProtocolValid(messages: readonly Message[]): boolean {
  return findToolProtocolViolations(messages).length === 0;
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
 * Drop `tool` messages that answer no assistant `tool_calls` in THIS list.
 *
 * Used on the model-visible VIEW after a prefix trim/slice: trimming the
 * oldest messages can cut an assistant `tool_calls` message away while its
 * results remain, and a strict upstream rejects an orphan tool result
 * ("messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'"). The durable transcript is never modified by this.
 */
export function dropOrphanToolResults(messages: readonly Message[]): Message[] {
  const orphans = new Set(findOrphanToolResults(messages));
  if (orphans.size === 0) return [...messages];
  return messages.filter((_, index) => !orphans.has(index));
}

/**
 * Assert the tool-protocol invariant, throwing with actionable detail.
 *
 * `assertToolProtocol(await store.listMessages(sessionId))` is the regression
 * guard: the original stall-ordering defect survived because the existing
 * tests asserted events/outcomes but never the persisted message ORDER.
 */
export function assertToolProtocol(messages: readonly Message[]): void {
  const violations = findToolProtocolViolations(messages);
  if (violations.length === 0) return;
  const detail = violations
    .map((violation) => {
      const where =
        violation.interruptedByIndex !== undefined
          ? `, block interrupted at index ${violation.interruptedByIndex} by role="${violation.interruptedByRole}"`
          : ", block ended before the result(s) were persisted";
      return `  assistant[${violation.assistantIndex}] is missing tool result(s) for ${violation.missingToolCallIds.join(", ")}${where}`;
    })
    .join("\n");
  throw new Error(
    `tool protocol violation: an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'\n${detail}`,
  );
}
