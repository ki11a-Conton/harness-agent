import type { AgentId, SessionId, TurnId } from "./ids.js";
import type { ToolCall, ToolResult } from "./tool.js";

/**
 * Lifecycle hook names per AGENT_ARCHITECTURE_PLAN §51 / HOOK-001.
 * Hooks may observe, annotate, block, transform — but may never bypass security:
 * permission evaluation always runs; hooks only narrow (before_tool null blocks)
 * or wrap, never widen.
 */
export const HOOK_NAMES = [
  "session_start",
  "session_end",
  "before_model",
  "after_model",
  "before_tool",
  "after_tool",
  "tool_error",
  "before_permission",
  "after_permission",
  "before_compaction",
  "after_compaction",
  "before_subagent",
  "after_subagent",
  "before_memory_write",
  "after_memory_write",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export interface HookContext {
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  timestamp: number;
}

export type BeforeToolHook = (
  ctx: HookContext,
  call: ToolCall,
) => ToolCall | null | Promise<ToolCall | null>;
export type AfterToolHook = (
  ctx: HookContext,
  call: ToolCall,
  result: ToolResult,
) => void | Promise<void>;

/** Union of accepted handler signatures; contextual typing picks the match. */
export type HookFn =
  | ((ctx: HookContext) => Promise<unknown> | unknown)
  | BeforeToolHook
  | AfterToolHook;