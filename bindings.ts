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
export class SessionBindings {
  private readonly byFrom = new Map<string, SessionId>();

  /** Sender of the message currently being delivered (set by WebServer). */
  pendingFrom: string | undefined;

  onSessionCreated(session: Session): void {
    const from = this.pendingFrom;
    if (from !== undefined) this.byFrom.set(from, session.id);
  }

  get(from: string): SessionId | undefined {
    return this.byFrom.get(from);
  }

  all(): Array<{ from: string; sessionId: SessionId }> {
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
  constructor(
    private readonly inner: RpcMethodRegistry,
    private readonly onSessionCreated: (session: Session) => void,
  ) {
    super();
  }

  override async invoke(
    name: string,
    params?: Record<string, unknown>,
    ctx?: RpcContext,
  ): Promise<unknown> {
    const result = await this.inner.invoke(name, params, ctx);
    if (name === "session.create") this.onSessionCreated(result as Session);
    return result;
  }
}
