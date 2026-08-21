import type { Session, SessionId } from "@ar/contracts";
import { RpcMethodRegistry } from "@ar/gateway";
import type { RpcContext } from "@ar/gateway";
/**
 * from → sessionId tracking for the web server.
 *
 * The Gateway keeps its own sessionByUser map internally and never exposes
 * it, so the web server correlates session creation with the sender itself:
 * WebServer sets `pendingFrom` around each message delivery, and the gateway
 * awaits `session.create` inside that window (bindSession), so
 * TrackingRegistry records the created session against the right `from`.
 */
export declare class SessionBindings {
    private readonly byFrom;
    /** Sender of the message currently being delivered (set by WebServer). */
    pendingFrom: string | undefined;
    onSessionCreated(session: Session): void;
    get(from: string): SessionId | undefined;
    all(): Array<{
        from: string;
        sessionId: SessionId;
    }>;
}
/**
 * RpcMethodRegistry wrapper that observes session creation. The gateway
 * drives sessions only through this surface, so no Core reach-through is
 * needed to learn which session a sender was bound to. register()/has()/
 * listMethods() are inherited and unused (the gateway never registers).
 */
export declare class TrackingRegistry extends RpcMethodRegistry {
    private readonly inner;
    private readonly onSessionCreated;
    constructor(inner: RpcMethodRegistry, onSessionCreated: (session: Session) => void);
    invoke(name: string, params?: Record<string, unknown>, ctx?: RpcContext): Promise<unknown>;
}
//# sourceMappingURL=bindings.d.ts.map