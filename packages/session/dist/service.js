import { newSessionId } from "@ar/contracts";
import { SessionStoreError } from "./session-store.js";
/**
 * Session lifecycle service (architecture plan §28). Depends only on the
 * SessionStore contract; it never touches the event store or the runtime.
 */
export class SessionService {
    store;
    now;
    constructor(deps) {
        this.store = deps.store;
        this.now = deps.now ?? Date.now;
    }
    async create(input) {
        const session = {
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
    async resume(id) {
        const session = await this.store.getSession(id);
        if (!session) {
            throw new SessionStoreError("UNKNOWN_SESSION", `cannot resume unknown session ${id}`);
        }
        return session;
    }
    /** Fork a new active session that points at the parent (inherits agent/model/cwd). */
    async fork(parentId) {
        const parent = await this.resume(parentId);
        return this.create({
            agentId: parent.agentId,
            model: parent.model,
            cwd: parent.cwd,
            parentId: parent.id,
        });
    }
    async cancelSession(id) {
        const session = await this.resume(id);
        return this.updateStatus(session, "cancelled");
    }
    async completeSession(id) {
        const session = await this.resume(id);
        return this.updateStatus(session, "completed");
    }
    /**
     * Move the session out of the live store into the archive directory.
     * Returns the archive directory path. Requires a file-backed store
     * (JSONLSessionStore); other stores throw UNSUPPORTED.
     */
    async archive(id) {
        await this.resume(id);
        const capable = this.store;
        if (typeof capable.archiveSession !== "function") {
            throw new SessionStoreError("UNSUPPORTED", `archive requires a file-backed store (JSONLSessionStore), got ${this.store.constructor.name}`);
        }
        const { archivedPath } = await capable.archiveSession(id);
        return archivedPath;
    }
    async updateStatus(session, status) {
        const updated = { ...session, status, updatedAt: this.now() };
        await this.store.updateSession(updated);
        return updated;
    }
}
//# sourceMappingURL=service.js.map