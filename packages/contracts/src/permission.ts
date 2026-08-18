import type { AgentId, SessionId, TurnId } from "./ids.js";

export type PermissionEffect = "allow" | "ask" | "deny";

export type PermissionScope =
  | "global"
  | "project"
  | "agent"
  | "session"
  | "tool"
  | "call";

export interface PermissionRule {
  id?: string;
  action: string;
  resource: string;
  /** Glob pattern matched against the request target (e.g. "** /*" or "npm test"). */
  pattern?: string;
  effect: PermissionEffect;
  scope?: PermissionScope;
}

export interface PermissionPolicy {
  rules: PermissionRule[];
  /** Fallback when no rule matches. Defaults to "ask". */
  defaultEffect?: PermissionEffect;
}

export interface PermissionRequest {
  action: string;
  resource: string;
  target?: string;
  agentId: AgentId;
  sessionId: SessionId;
  turnId?: TurnId;
}

export interface PermissionDecision {
  effect: PermissionEffect;
  rule?: PermissionRule;
  reason: string;
}

export interface PermissionEngine {
  evaluate(
    request: PermissionRequest,
    policy: PermissionPolicy,
  ): Promise<PermissionDecision>;
}