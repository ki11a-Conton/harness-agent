import type { AgentId, Message, ModelRef, Session, SessionId, SessionStore } from "@ar/contracts";
import { AgentError, assertWireProtocol, errorInfo, EFFECTIVE_AGENT_SNAPSHOT_KEY, RUNTIME_POLICY_SNAPSHOT_KEY, newMessageId, newSessionId } from "@ar/contracts";
import { SessionStoreError } from "./session-store.js";

/** Archive support: the file-backed store moves artifacts to dataDir/archive/<id>. */
interface ArchiveCapableStore extends SessionStore {
  archiveSession(id: SessionId): Promise<{ archivedPath: string }>;
}

export interface SessionServiceDeps {
  store: SessionStore;
  now?: () => number;
  /** Production hosts create through Runtime so the effective agent policy
   * is frozen before a session becomes runnable. */
  createSession?: (input: CreateSessionInput) => Promise<Session>;
  /** Additional host-owned frozen fields inherited by branches/children.
   * Working state, approvals, inbox and recovery records are never copied. */
  forkStateKeys?: readonly string[];
  /** Hosts publish inert history for UI replay, without copying live approval
   * or tool-execution events from the source session. */
  onForkHistory?: (input: { parentId: SessionId; sessionId: SessionId; messages: readonly Message[] }) => Promise<void>;
}

export interface CreateSessionInput {
  agentId: AgentId;
  model: ModelRef;
  cwd: string;
  parentId?: SessionId;
  /** A branch is not runnable until its frozen policy and history are saved. */
  initialStatus?: "active" | "failed";
}

/**
 * Session lifecycle service (architecture plan §28). Depends only on the
 * SessionStore contract; it never touches the event store or the runtime.
 */
export class SessionService {
  private readonly store: SessionStore;
  private readonly now: () => number;
  private readonly createSession?: SessionServiceDeps["createSession"];
  private readonly forkStateKeys: readonly string[];
  private readonly onForkHistory?: SessionServiceDeps["onForkHistory"];

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.createSession = deps.createSession;
    this.forkStateKeys = [EFFECTIVE_AGENT_SNAPSHOT_KEY, RUNTIME_POLICY_SNAPSHOT_KEY, ...(deps.forkStateKeys ?? [])];
    this.onForkHistory = deps.onForkHistory;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    if (this.createSession !== undefined) return this.createSession(input);
    const session: Session = {
      id: newSessionId(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      agentId: input.agentId,
      model: input.model,
      cwd: input.cwd,
      status: input.initialStatus ?? "active",
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

  async list(opts?: Parameters<SessionStore["listSessions"]>[0]): Promise<Session[]> {
    return this.store.listSessions(opts);
  }

  /** P25-7: spawn a CHILD session (subagent parentage). The child inherits
   *  agent/model/cwd and points at the parent, but starts EMPTY — no copied
   *  history. Conversational branches use threadFork; the two are never
   *  overloaded. */
  async spawnChild(parentId: SessionId): Promise<Session> {
    const parent = await this.resume(parentId);
    this.assertForkable(parent);
    const child = await this.create({
      agentId: parent.agentId,
      model: parent.model,
      cwd: parent.cwd,
      parentId: parent.id,
      initialStatus: "failed",
    });
    await this.inheritFrozenState(parentId, child.id);
    return this.activate(child);
  }

  /** Backward-compatible alias of spawnChild (kept for existing callers). */
  async fork(parentId: SessionId): Promise<Session> {
    return this.spawnChild(parentId);
  }

  /** P25-7: fork a conversational BRANCH (thread.fork, Codex-like). Creates
   *  a new active session with the parent's agent/model/cwd AND a copy of the
   *  parent's message history (fresh message ids, branch sessionId). Turn
   *  records are NOT copied — the branch continues with its own turns. */
  async threadFork(parentId: SessionId): Promise<Session> {
    const parent = await this.resume(parentId);
    this.assertForkable(parent);
    await this.assertSettled(parentId);
    const messages = await this.store.listMessages(parentId);
    // A new parent turn can be admitted after the first check. Check again
    // after taking the immutable view, and reject an ABA snapshot captured
    // mid-tool-round even if that turn has since finished. A turn admitted
    // after these checks cannot alter the already captured branch history.
    await this.assertSettled(parentId);
    assertWireProtocol(messages, `fork snapshot of ${parentId}`);
    const session = await this.create({
      agentId: parent.agentId,
      model: parent.model,
      cwd: parent.cwd,
      parentId: parent.id,
      initialStatus: "failed",
    });
    await this.inheritFrozenState(parentId, session.id);
    const copied: Message[] = [];
    for (const message of messages) {
      // These identities belong to the parent's exactly-once queue/ask/turn
      // lineage. The branch carries their text as history, never live work.
      const { turnId: _turnId, promptId: _promptId, askId: _askId, ...history } = message;
      const copy: Message = {
        ...history,
        id: newMessageId(),
        sessionId: session.id,
      };
      await this.store.appendMessage(copy);
      copied.push(copy);
    }
    await this.onForkHistory?.({ parentId, sessionId: session.id, messages: copied });
    return this.activate(session);
  }

  private assertForkable(parent: Session): void {
    if (parent.status === "failed") throw new AgentError(errorInfo("INTERNAL_ERROR", `cannot fork failed or incompletely initialized session ${parent.id}`));
  }

  private async assertSettled(parentId: SessionId): Promise<void> {
    const unfinished = (await this.store.listTurns(parentId)).find(turn =>
      turn.status === "running" || turn.status === "waiting_for_approval" || turn.status === "waiting_for_user");
    if (unfinished !== undefined) throw new AgentError(errorInfo("SESSION_BUSY", `cannot fork session ${parentId} while turn ${unfinished.id} is ${unfinished.status}; finish or interrupt it first`));
  }

  private async activate(session: Session): Promise<Session> {
    const active: Session = { ...session, status: "active", updatedAt: this.now() };
    await this.store.updateSession(active);
    return active;
  }

  private async inheritFrozenState(parentId: SessionId, childId: SessionId): Promise<void> {
    const source = await this.store.loadStateSnapshot(parentId);
    if (source === undefined) return;
    const inherited: Record<string, unknown> = {};
    for (const key of this.forkStateKeys) {
      if (Object.hasOwn(source, key)) inherited[key] = structuredClone(source[key]);
    }
    if (Object.keys(inherited).length === 0) return;
    const childState = await this.store.loadStateSnapshot(childId);
    await this.store.saveStateSnapshot(childId, { ...childState, ...inherited });
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
