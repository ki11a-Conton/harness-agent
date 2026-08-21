import type { AgentId, ModelRef, Session, SessionId, SessionStore } from "@ar/contracts";
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
export declare class SessionService {
    private readonly store;
    private readonly now;
    constructor(deps: SessionServiceDeps);
    create(input: CreateSessionInput): Promise<Session>;
    resume(id: SessionId): Promise<Session>;
    /** Fork a new active session that points at the parent (inherits agent/model/cwd). */
    fork(parentId: SessionId): Promise<Session>;
    cancelSession(id: SessionId): Promise<Session>;
    completeSession(id: SessionId): Promise<Session>;
    /**
     * Move the session out of the live store into the archive directory.
     * Returns the archive directory path. Requires a file-backed store
     * (JSONLSessionStore); other stores throw UNSUPPORTED.
     */
    archive(id: SessionId): Promise<string>;
    private updateStatus;
}
//# sourceMappingURL=service.d.ts.map