import type { Session, SessionId } from "@ar/contracts";
import { RpcMethodRegistry } from "@ar/gateway";
import type { RpcContext } from "@ar/gateway";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  constructor(private readonly filePath?: string) {
    if (filePath === undefined) return;
    let raw: string;
    try { raw = readFileSync(filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const data = JSON.parse(raw) as { version?: unknown; bindings?: unknown };
    if (data.version !== 1 || !Array.isArray(data.bindings)) throw new Error("invalid Web session bindings");
    for (const entry of data.bindings) {
      if (typeof entry?.from !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(entry.from) ||
          typeof entry.sessionId !== "string" || !/^session_[A-Za-z0-9-]+$/.test(entry.sessionId) || this.byFrom.has(entry.from)) {
        throw new Error("invalid or duplicate Web session binding");
      }
      this.byFrom.set(entry.from, entry.sessionId as SessionId);
    }
  }

  /** Sender of the message currently being delivered (set by WebServer). */
  pendingFrom: string | undefined;

  onSessionCreated(session: Session): void {
    const from = this.pendingFrom;
    if (from !== undefined) {
      const next = new Map(this.byFrom).set(from, session.id);
      if (this.filePath !== undefined) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        const fd = openSync(temporary, "w", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, bindings: [...next].map(([from, sessionId]) => ({ from, sessionId })) }), "utf8");
          fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(temporary, this.filePath);
      }
      this.byFrom.set(from, session.id);
    }
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
