/**
 * P29-5 — Thread Item wire model.
 *
 * The protocol exposes a flat, human-consumable stream of items that make up a
 * thread's visible conversation — the wire-side projection of internal
 * session/turn/event state. The mapping is intentionally a projection: core
 * events remain core events, and this wire union is what travels to a client
 * (CLI/SDK/web).
 *
 * Naming follows P29-3 — the external primitive names:
 *   Thread ↔ Session
 *   Turn   ↔ Turn
 *   Item   ↔ a single visible unit (message / tool call / approval / ...).
 *
 * Deliberately excluded: chain-of-thought. Reasoning metadata may expose only
 * `status`, an intentionally generated `summary`, and `tokens`, never hidden
 * private reasoning text (P29-5).
 *
 * Every item carries its `sequence` from the authoritative event store
 * (P29-8): replays and reconnect resumption are sequence-addressable.
 */
import type { ThreadId } from "./ids.js";

export type ThreadItemKind =
  | "user_message"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "file_change"
  | "approval"
  | "ask_user"
  | "verification"
  | "runtime_warning";

/** Common shape shared by every item. */
export interface ThreadItemBase {
  kind: ThreadItemKind;
  /** Monotonic sequence from the authoritative event store (P29-8). */
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  /** Present only when intentionally generated (never forced). */
  reasoning?: { status: "none" | "thinking" | "complete"; summary?: string; tokens?: number };
}

export interface UserMessageItem {
  kind: "user_message";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  text: string;
}

export interface AgentMessageItem {
  kind: "agent_message";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  text: string;
  /** True when this is the final response of the turn. */
  final?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCallItem {
  kind: "tool_call";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  tool: string;
  id: string;
  args: Record<string, unknown>;
  callIndex: number;
}

export interface ToolResultItem {
  kind: "tool_result";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  tool: string;
  id: string;
  callIndex: number;
  ok: boolean;
  error?: string;
  truncated?: boolean;
}

export interface FileChangeItem {
  kind: "file_change";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  operation: "write" | "delete" | "move";
  path: string;
}

export interface ApprovalItem {
  kind: "approval";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  approvalId: string;
  action: string;
  target: string;
  reason: string;
  /** Wire scope: "one_call" | "one_tool" | "session". */
  scope: "one_call" | "one_tool" | "session";
}

export interface AskUserItem {
  kind: "ask_user";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  askId: string;
  prompt: string;
  options?: readonly string[];
}

export interface VerificationItem {
  kind: "verification";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  verificationId: string;
  status: "pending" | "passed" | "failed" | "skipped";
  summary?: string;
}

export interface RuntimeWarningItem {
  kind: "runtime_warning";
  sequence: number;
  threadId: ThreadId;
  turnId?: string;
  timestamp: number;
  message: string;
}

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | FileChangeItem
  | ApprovalItem
  | AskUserItem
  | VerificationItem
  | RuntimeWarningItem;

export function isThreadItem(value: unknown): value is ThreadItem {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  const kinds: readonly unknown[] = [
    "user_message",
    "agent_message",
    "tool_call",
    "tool_result",
    "file_change",
    "approval",
    "ask_user",
    "verification",
    "runtime_warning",
  ];
  return kinds.includes(kind) && typeof (value as { sequence?: unknown }).sequence === "number";
}