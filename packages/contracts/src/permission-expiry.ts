import type { AgentId, ApprovalId, SessionId } from "./ids.js";

/**
 * P2-44 — permission expansion expiry.
 *
 * A session-scoped approval ("allow the rest of this session") expands the
 * effective capability of the agent. Expansions must NOT be open-ended: every
 * grant carries an explicit `expiresAt` (hard deadline) and, for call/tool
 * bounds, a usage meter. This module is the pure boundary — no I/O — so both the
 * producer (security layer) and any host/UI can classify a grant's liveness
 * deterministically.
 */
export type GrantBound = "one_call" | "one_tool" | "session";

export const GRANT_BOUNDS = [
  "one_call",
  "one_tool",
  "session",
] as const satisfies readonly GrantBound[];

export interface SessionPermissionGrant {
  sessionId: SessionId;
  /**
   * Fingerprint of the allowed action@resource pattern. Two grants for the same
   * session can coexist only if their keys differ (a later grant for the same
   * key REPLACES the earlier one, resetting liveness).
   */
  grantKey: string;
  /** How the grant is bounded: single call, single tool pattern, or session. */
  bound: GrantBound;
  /** The approval that created the grant (audit linkage). */
  approvalId: ApprovalId;
  agentId: AgentId;
  grantedAt: number;
  /** Hard expiry; once passed the grant is dead regardless of remaining usage. */
  expiresAt: number;
  /**
   * Usage meter for bounded grants (one_call ⇒ 1, one_tool ⇒ N). Decremented on
   * each use; when it reaches 0 the grant dies even if `expiresAt` is in the
   * future. `undefined` means NO usage cap (a session expansion is bounded only
   * by `expiresAt`), so a session grant is never exhausted by calling consume.
   */
  remainingUses?: number;
}

/** A grant that is still alive at `now` (not past its hard expiry). */
export function isGrantExpired(grant: SessionPermissionGrant, now: number): boolean {
  return now >= grant.expiresAt;
}

/** Milliseconds until the hard expiry; 0 once expired. */
export function grantRemainingMs(grant: SessionPermissionGrant, now: number): number {
  return Math.max(0, grant.expiresAt - now);
}

/**
 * Consume one usage of a bounded grant and return the updated grant, or
 * `undefined` when the grant is already exhausted/expired. Pure: it does NOT
 * mutate the input, the caller persists the returned value.
 *
 * A grant with `remainingUses === undefined` (session bound) is not usage
 * capped — it is returned unchanged until `expiresAt`.
 */
export function consumePermissionGrantUsage(
  grant: SessionPermissionGrant,
  now: number,
): SessionPermissionGrant | undefined {
  if (isGrantExpired(grant, now)) return undefined;
  if (grant.remainingUses === undefined) return grant;
  const remaining = grant.remainingUses - 1;
  if (remaining <= 0) return undefined;
  return { ...grant, remainingUses: remaining };
}

/**
 * Persistence seam for permission expansions. A durable implementation keeps a
 * grant (and its expiry/usage) across a restart so a session expansion does not
 * silently become unbounded.
 */
export interface PermissionGrantStore {
  grant(g: SessionPermissionGrant): Promise<void>;
  get(sessionId: SessionId, grantKey: string): Promise<SessionPermissionGrant | undefined>;
  /** Consume one usage (if bounded) and persist; returns the grant or undefined. */
  consume(sessionId: SessionId, grantKey: string, now: number): Promise<SessionPermissionGrant | undefined>;
  list(sessionId: SessionId): Promise<SessionPermissionGrant[]>;
}