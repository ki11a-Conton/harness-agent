import type {
  PermissionGrantStore,
  SessionId,
  SessionPermissionGrant,
} from "@ar/contracts";
import { consumePermissionGrantUsage, isGrantExpired } from "@ar/contracts";

/**
 * P2-44 — permission expansion store (in-memory reference implementation).
 *
 * A session-scoped approval is an expansion of effective capability; such
 * expansions must be bounded (hard `expiresAt`) and, for call/tool bounds,
 * usage-limited. This store enforces both: expired grants are never returned,
 * and consuming a usage-exhausted grant removes it.
 *
 * It implements the @ar/contracts `PermissionGrantStore` seam so a durable,
 * host-owned store can be swapped in for cross-restart persistence.
 */
export class InMemoryPermissionGrantStore implements PermissionGrantStore {
  private readonly grants = new Map<string, SessionPermissionGrant>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(sessionId: SessionId, grantKey: string): string {
    return `${sessionId}/${grantKey}`;
  }

  async grant(g: SessionPermissionGrant): Promise<void> {
    this.grants.set(this.key(g.sessionId, g.grantKey), g);
  }

  async get(
    sessionId: SessionId,
    grantKey: string,
  ): Promise<SessionPermissionGrant | undefined> {
    const g = this.grants.get(this.key(sessionId, grantKey));
    if (g === undefined) return undefined;
    return isGrantExpired(g, this.now()) ? undefined : g;
  }

  async consume(
    sessionId: SessionId,
    grantKey: string,
    now: number,
  ): Promise<SessionPermissionGrant | undefined> {
    const g = this.grants.get(this.key(sessionId, grantKey));
    if (g === undefined) return undefined;
    const next = consumePermissionGrantUsage(g, now);
    if (next === undefined) {
      this.grants.delete(this.key(sessionId, grantKey));
      return undefined;
    }
    this.grants.set(this.key(sessionId, grantKey), next);
    return next;
  }

  async list(sessionId: SessionId): Promise<SessionPermissionGrant[]> {
    const out: SessionPermissionGrant[] = [];
    const staleKeys: string[] = [];
    for (const [key, g] of this.grants) {
      if (g.sessionId !== sessionId) continue;
      if (isGrantExpired(g, this.now())) {
        staleKeys.push(key);
        continue;
      }
      out.push(g);
    }
    for (const key of staleKeys) this.grants.delete(key);
    return out;
  }
}