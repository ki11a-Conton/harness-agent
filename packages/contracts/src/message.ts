import type { MessageId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { ToolCall } from "./tool.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  turnId?: TurnId;
  role: MessageRole;
  content: string;
  /** Set when role === "tool": the tool call this message answers. */
  toolCallId?: ToolCallId;
  /** Set when role === "assistant": tool calls requested by the model. */
  toolCalls?: ToolCall[];
  createdAt: number;
}

export interface UserMessage {
  sessionId: SessionId;
  text: string;
}