import type { AskId, MessageId, PromptId, SessionId, ToolCallId, TurnId } from "./ids.js";
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
  /** Set when role === "assistant": reasoning/thinking content produced by a
   *  thinking-mode model (e.g. deepseek reasoning_content). Some providers
   *  REQUIRE this to be passed back on the next assistant message of the
   *  conversation; it is never shown to the user as final output. */
  reasoningContent?: string;
  /** P2-36: when this message was produced by injecting an inbox prompt (steer /
   *  followup), records the source prompt id. Used as the exactly-once key so a
   *  crash between "message appended" and "prompt consumed" cannot double-inject
   *  the same steer on resume. */
  promptId?: PromptId;
  /** P2-43: when this message is a resumed user reply to a pending ask,
   *  records the ask id. Used as the exactly-once key so a crash between
   *  "ask answered" and "reply appended" cannot double-inject the reply. */
  askId?: AskId;
  createdAt: number;
}

export interface UserMessage {
  sessionId: SessionId;
  text: string;
}