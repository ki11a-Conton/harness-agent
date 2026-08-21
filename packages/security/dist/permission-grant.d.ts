import type { PermissionGrantStore, SessionId, SessionPermissionGrant } from "@ar/contracts";
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
export declare class InMemoryPermissionGrantStore implements PermissionGrantStore {
    private readonly grants;
    private readonly now;
    constructor(now?: () => number);
    private key;
    grant(g: SessionPermissionGrant): Promise<void>;
    get(sessionId: SessionId, grantKey: string): Promise<SessionPermissionGrant | undefined>;
    consume(sessionId: SessionId, grantKey: string, now: number): Promise<SessionPermissionGrant | undefined>;
    list(sessionId: SessionId): Promise<SessionPermissionGrant[]>;
}
//# sourceMappingURL=permission-grant.d.ts.map