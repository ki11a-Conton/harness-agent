/** In-memory ArtifactStore with id/hash/tool-call indexes (P1-12). */
export class InMemoryArtifactStore {
    byId = new Map();
    hashIndex = new Map();
    toolCallIndex = new Map();
    sessionIndex = new Map();
    async register(artifact) {
        this.byId.set(artifact.id, artifact);
        const key = `${artifact.sessionId}:${artifact.turnId}:${artifact.toolCallId}`;
        this.push(this.toolCallIndex, key, artifact);
        this.push(this.sessionIndex, artifact.sessionId, artifact);
        this.push(this.hashIndex, artifact.sha256, artifact);
    }
    async get(id) {
        return this.byId.get(id);
    }
    async byToolCallId(sessionId, turnId, toolCallId) {
        return [...(this.toolCallIndex.get(`${sessionId}:${turnId}:${toolCallId}`) ?? [])];
    }
    async bySessionId(sessionId) {
        return [...(this.sessionIndex.get(sessionId) ?? [])];
    }
    async byHash(sha256) {
        return [...(this.hashIndex.get(sha256) ?? [])];
    }
    async list() {
        return [...this.byId.values()];
    }
    async remove(ids) {
        const wanted = new Set(ids);
        for (const id of wanted) {
            const artifact = this.byId.get(id);
            if (artifact === undefined)
                continue;
            this.byId.delete(id);
            const toolKey = `${artifact.sessionId}:${artifact.turnId}:${artifact.toolCallId}`;
            this.removeFrom(this.toolCallIndex, toolKey, id);
            this.removeFrom(this.sessionIndex, artifact.sessionId, id);
            this.removeFrom(this.hashIndex, artifact.sha256, id);
        }
    }
    push(map, key, artifact) {
        const existing = map.get(key);
        if (existing === undefined)
            map.set(key, [artifact]);
        else
            existing.push(artifact);
    }
    removeFrom(map, key, id) {
        const existing = map.get(key);
        if (existing === undefined)
            return;
        const next = existing.filter((a) => a.id !== id);
        if (next.length === 0)
            map.delete(key);
        else
            map.set(key, next);
    }
}
//# sourceMappingURL=artifact-store.js.map