/** P29-4 — wire DTOs for the App Server protocol v1. */
import type { ThreadId } from "./ids.js";
import type { ThreadItem } from "./items.js";

export const PROTOCOL_VERSION = "1";

export interface ProtocolClientInfo {
  name: string;
  version: string;
}

export interface ProtocolClientCapabilities {
  streamingItems: boolean;
  approvalForms: boolean;
}

export interface ProtocolServerInfo {
  name: string;
  version: string;
}

export interface InitializeServer {
  protocolVersion: string;
  serverInfo: ProtocolServerInfo;
  capabilities: ProtocolClientCapabilities;
}

// -- thread ----------------------------------------------------------------

export interface ThreadStartParams {
  agentName: string;
  resumeThreadId?: ThreadId;
  /** Optional idempotency key (P29-9) — a retried thread/start must not create
   *  two threads. */
  idempotencyKey?: string;
}

export interface ThreadInfo {
  threadId: ThreadId;
  createdAt: number;
  itemCount: number;
  lastSequence: number;
  status: "active" | "completed" | "interrupted";
}

export interface ThreadReadParams {
  threadId: ThreadId;
  afterSequence?: number;
  limit?: number;
}

export interface ThreadReadResult {
  threadId: ThreadId;
  items: ThreadItem[];
  nextSequence: number;
}

// -- turn ------------------------------------------------------------------

export interface TurnStartParams {
  threadId: ThreadId;
  prompt: string;
  /** Optional idempotency key (P29-09) — a retried turn/start must not run the
   *  same prompt twice. */
  idempotencyKey?: string;
}

export interface TurnStarted {
  turnId: string;
  threadId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
  reason?: string;
}

/** Streamed turn events (P29-6 output of ProtocolEventMapper). */
export type TurnEventName =
  | "item/started"
  | "item/delta"
  | "item/completed"
  | "turn/completed"
  | "turn/interrupted"
  | "turn/failed";

export interface TurnEvent {
  type: TurnEventName;
  sequence: number;
  threadId: string;
  turnId: string;
  item?: ThreadItem;
  /** item/started only. */
  itemId?: string;
  /** item/delta only. */
  delta?: { text?: string };
  error?: { code: string; message: string; retryable: boolean };
}

// -- approval / ask ---------------------------------------------------------

export interface ApprovalRespondParams {
  approvalId: string;
  decision: "allow" | "deny";
  decidedBy?: string;
  idempotencyKey?: string;
  /** Reuse scope when allowed (P22-3): "one_call" | "one_tool" | "session". */
  grantScope?: "one_call" | "one_tool" | "session";
}

export interface AskRespondParams {
  askId: string;
  answer: string;
  idempotencyKey?: string;
}

// -- introspection ----------------------------------------------------------

export interface ListAgentsResult {
  agents: readonly { id: string; name: string }[];
}

export interface ListToolsResult {
  tools: readonly {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }[];
}

export interface ListSkillsResult {
  skills: readonly { id: string; name: string; description?: string }[];
}

export interface TraceReadParams {
  threadId: string;
  turnId?: string;
}

export interface TraceReadResult {
  threadId: string;
  spans: readonly {
    id: string;
    parentId?: string;
    name: string;
    startedAt: string;
    endedAt?: string;
    status: "running" | "ok" | "error";
  }[];
}

// -- request/response envelope (JSON-RPC-ish) -------------------------------

export type ProtocolRequest =
  | { method: "initialize"; id: number; params: { clientInfo: ProtocolClientInfo; capabilities?: ProtocolClientCapabilities } }
  | { method: "thread/start"; id: number; params: ThreadStartParams }
  | { method: "thread/read"; id: number; params: ThreadReadParams }
  | { method: "thread/resume"; id: number; params: ThreadReadParams }
  | { method: "thread/fork"; id: number; params: ThreadStartParams }
  | { method: "thread/list"; id: number; params: Record<string, never> }
  | { method: "thread/loaded/list"; id: number; params: Record<string, never> }
  | { method: "turn/start"; id: number; params: TurnStartParams }
  | { method: "turn/interrupt"; id: number; params: TurnInterruptParams }
  | { method: "turn/steer"; id: number; params: TurnInterruptParams }
  | { method: "approval/respond"; id: number; params: ApprovalRespondParams }
  | { method: "ask/respond"; id: number; params: AskRespondParams }
  | { method: "agent/list"; id: number; params: Record<string, never> }
  | { method: "tool/list"; id: number; params: Record<string, never> }
  | { method: "skill/list"; id: number; params: Record<string, never> }
  | { method: "trace/read"; id: number; params: TraceReadParams }
  | { method: "approval/respond"; id: number; params: ApprovalRespondParams }
  | { method: "invalid"; id: number; params: Record<string, never> };

export type ProtocolResponse =
  | { id: number; result: unknown }
  | { id: number; error: { code: string; message: string; retryable: boolean; data?: unknown } };