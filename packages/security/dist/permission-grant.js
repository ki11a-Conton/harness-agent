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
export class InMemoryPermissionGrantStore {
    grants = new Map();
    now;
    constructor(now = Date.now) {
        this.now = now;
    }
    key(sessionId, grantKey) {
        return `${sessionId}/${grantKey}`;
    }
    async grant(g) {
        this.grants.set(this.key(g.sessionId, g.grantKey), g);
    }
    async get(sessionId, grantKey) {
        const g = this.grants.get(this.key(sessionId, grantKey));
        if (g === undefined)
            return undefined;
        return isGrantExpired(g, this.now()) ? undefined : g;
    }
    async consume(sessionId, grantKey, now) {
        const g = this.grants.get(this.key(sessionId, grantKey));
        if (g === undefined)
            return undefined;
        const next = consumePermissionGrantUsage(g, now);
        if (next === undefined) {
            this.grants.delete(this.key(sessionId, grantKey));
            return undefined;
        }
        this.grants.set(this.key(sessionId, grantKey), next);
        return next;
    }
    async list(sessionId) {
        const out = [];
        const staleKeys = [];
        for (const [key, g] of this.grants) {
            if (g.sessionId !== sessionId)
                continue;
            if (isGrantExpired(g, this.now())) {
                staleKeys.push(key);
                continue;
            }
            out.push(g);
        }
        for (const key of staleKeys)
            this.grants.delete(key);
        return out;
    }
}
//# sourceMappingURL=permission-grant.js.map