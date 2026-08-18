import type { AgentId, ApprovalId, SessionId, TurnId } from "./ids.js";

export interface ApprovalRequest {
  id: ApprovalId;
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  action: string;
  target: string;
  reason: string;
  policyRule?: string;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalDecisionValue = "allow" | "deny" | "expired" | "cancelled";

export interface ApprovalDecision {
  id: ApprovalId;
  value: ApprovalDecisionValue;
  decidedAt: number;
  decidedBy?: string;
}

export interface ApprovalResolver {
  resolve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}