import type { AgentId, ModelRef, Session, SessionId, SessionStore } from "@ar/contracts";
import { newSessionId } from "@ar/contracts";
import { SessionStoreError } from "./session-store.js";

/** Archive support: the file-backed store moves artifacts to dataDir/archive/<id>. */
interface ArchiveCapableStore extends SessionStore {
  archiveSession(id: SessionId): Promise<{ archivedPath: string }>;
}

export interface SessionServiceDeps {
  store: SessionStore;
  now?: () => number;
}

export interface CreateSessionInput {
  agentId: AgentId;
  model: ModelRef;
  cwd: string;
  parentId?: SessionId;
}

/**
 * Session lifecycle service (architecture plan §28). Depends only on the
 * SessionStore contract; it never touches the event store or the runtime.
 */
export class SessionService {
  private readonly store: SessionStore;
  private readonly now: () => number;

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: newSessionId(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      agentId: input.agentId,
      model: input.model,
      cwd: input.cwd,
      status: "active",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.store.createSession(session);
    return session;
  }

  async resume(id: SessionId): Promise<Session> {
    const session = await this.store.getSession(id);
    if (!session) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot resume unknown session ${id}`);
    }
    return session;
  }

  /** Fork a new active session that points at the parent (inherits agent/model/cwd). */
  async fork(parentId: SessionId): Promise<Session> {
    const parent = await this.resume(parentId);
    return this.create({
      agentId: parent.agentId,
      model: parent.model,
      cwd: parent.cwd,
      parentId: parent.id,
    });
  }

  async cancelSession(id: SessionId): Promise<Session> {
    const session = await this.resume(id);
    return this.updateStatus(session, "cancelled");
  }

  async completeSession(id: SessionId): Promise<Session> {
    const session = await this.resume(id);
    return this.updateStatus(session, "completed");
  }

  /**
   * Move the session out of the live store into the archive directory.
   * Returns the archive directory path. Requires a file-backed store
   * (JSONLSessionStore); other stores throw UNSUPPORTED.
   */
  async archive(id: SessionId): Promise<string> {
    await this.resume(id);
    const capable = this.store as Partial<ArchiveCapableStore>;
    if (typeof capable.archiveSession !== "function") {
      throw new SessionStoreError(
        "UNSUPPORTED",
        `archive requires a file-backed store (JSONLSessionStore), got ${this.store.constructor.name}`,
      );
    }
    const { archivedPath } = await capable.archiveSession(id);
    return archivedPath;
  }

  private async updateStatus(session: Session, status: "cancelled" | "completed"): Promise<Session> {
    const updated: Session = { ...session, status, updatedAt: this.now() };
    await this.store.updateSession(updated);
    return updated;
  }
}
