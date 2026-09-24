/**
 * P28 — Typed Capability Approval V3 (security-side machinery).
 *
 * This module turns approval *decisions* into executable `CapabilityGrant`s and
 * implements the grant cache with:
 *   - P28-3 executable scope semantics (session / one_tool reuse rules);
 *   - P28-4 `isCoveredByGrant` authority-subset checks (fail closed);
 *   - P28-5 emergency revocation (session-level, applies before new execution).
 *
 * It is deliberately pure-of-I/O: the caller hosts the cache lifecycle (session
 * start/end), the store, and the policy policy; this module defines the
 * matching semantics + revocation ledger so any host can rely on it
 * deterministically.
 */
import type {
  CapabilityGrant,
  CapabilityRequest,
  SessionId,
} from "@ar/contracts";
import { approvalFingerprint, grantCoversRequest } from "@ar/contracts";

/** Revocation target: a session or a specific grant fingerprint. */
export type RevocationTarget =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "grant"; sessionId: SessionId; fingerprint: string };

export interface GrantCache {
  /** Record a newly-approved grant (P28-3: scope must be session/one_tool). */
  remember(grant: CapabilityGrant): void;
  /** Does any remembered grant cover this request? Fails closed on unknown. */
  isCovered(request: CapabilityRequest, sessionId: SessionId): boolean;
  /** P28-5: revoke grants by target. Returns number of grants removed. */
  revoke(target: RevocationTarget): number;
  /** List still-remembered grants for a session (audit / inspection). */
  list(sessionId: SessionId): readonly CapabilityGrant[];
}

interface GrantEntry {
  grant: CapabilityGrant;
  /** Non-null once the grant is revoked (append-only ledger retains it). */
  revoked?: number;
}

/** Default in-memory grant cache with per-session revocation support. */
export class DefaultGrantCache implements GrantCache {
  /** Entries keyed by sessionId. Revoked entries are retained (append-only
   *  ledger) but excluded from {@link isCovered}. */
  private readonly perSession = new Map<SessionId, GrantEntry[]>();

  remember(grant: CapabilityGrant): void {
    // Runtime guard: legacy injection of "one_call" is discarded (P28-3 never
    // remembers one-call grants). Type-level the scope is already narrowed, so
    // the cast is required to support tampered/legacy input.
    if ((grant.scope as string) === "one_call") return;
    const list = this.perSession.get(grant.sessionId) ?? [];
    list.push({ grant });
    this.perSession.set(grant.sessionId, list);
  }

  isCovered(request: CapabilityRequest, sessionId: SessionId): boolean {
    const entries = this.perSession.get(sessionId);
    if (entries === undefined) return false;
    // Grants added later override earlier ones; a terminated grant never covers.
    for (const entry of entries) {
      if (entry.revoked !== undefined) continue;
      if (grantCoversRequest(request, entry.grant)) return true;
    }
    return false;
  }

  revoke(target: RevocationTarget): number {
    const entries = this.perSession.get(target.sessionId);
    if (entries === undefined) return 0;
    let removed = 0;
    for (const e of entries) {
      const match =
        target.kind === "session" || e.grant.fingerprint === target.fingerprint;
      if (match && e.revoked === undefined) {
        e.revoked = Date.now();
        removed += 1;
      }
    }
    return removed;
  }

  list(sessionId: SessionId): readonly CapabilityGrant[] {
    return (this.perSession.get(sessionId) ?? [])
      .filter((e) => e.revoked === undefined)
      .map((e) => e.grant);
  }
}

/**
 * Build a grant from an approved request (P28-3).
 *
 * Rules:
 *   - scope "session"/"one_tool" → remember; "one_call" → never remember.
 *   - The grant stores the *approved* capability, not the request — so a later
 *     narrower request may still be covered.
 */
export function grantFromApproval(input: {
  sessionId: SessionId;
  capability: CapabilityRequest;
  scope: CapabilityGrant["scope"];
  authority?: unknown;
  decidedBy?: string;
}): CapabilityGrant | undefined {
  if ((input.scope as string) === "one_call") return undefined;
  return {
    sessionId: input.sessionId,
    fingerprint: approvalFingerprint(input.capability),
    capability: input.capability,
    authority: input.authority,
    scope: input.scope,
    createdAt: Date.now(),
    ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
  };
}