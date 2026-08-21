import { RpcMethodRegistry } from "@ar/gateway";
/**
 * from → sessionId tracking for the web server.
 *
 * The Gateway keeps its own sessionByUser map internally and never exposes
 * it, so the web server correlates session creation with the sender itself:
 * WebServer sets `pendingFrom` around each message delivery, and the gateway
 * awaits `session.create` inside that window (bindSession), so
 * TrackingRegistry records the created session against the right `from`.
 */
export class SessionBindings {
    byFrom = new Map();
    /** Sender of the message currently being delivered (set by WebServer). */
    pendingFrom;
    onSessionCreated(session) {
        const from = this.pendingFrom;
        if (from !== undefined)
            this.byFrom.set(from, session.id);
    }
    get(from) {
        return this.byFrom.get(from);
    }
    all() {
        return [...this.byFrom.entries()].map(([from, sessionId]) => ({ from, sessionId }));
    }
}
/**
 * RpcMethodRegistry wrapper that observes session creation. The gateway
 * drives sessions only through this surface, so no Core reach-through is
 * needed to learn which session a sender was bound to. register()/has()/
 * listMethods() are inherited and unused (the gateway never registers).
 */
export class TrackingRegistry extends RpcMethodRegistry {
    inner;
    onSessionCreated;
    constructor(inner, onSessionCreated) {
        super();
        this.inner = inner;
        this.onSessionCreated = onSessionCreated;
    }
    async invoke(name, params, ctx) {
        const result = await this.inner.invoke(name, params, ctx);
        if (name === "session.create")
            this.onSessionCreated(result);
        return result;
    }
}
//# sourceMappingURL=bindings.js.map