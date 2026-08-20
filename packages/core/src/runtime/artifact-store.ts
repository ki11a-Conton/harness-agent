import type { Artifact, ArtifactId, ArtifactStore, SessionId, ToolCallId, TurnId } from "@ar/contracts";

/** In-memory ArtifactStore with id/hash/tool-call indexes (P1-12). */
export class InMemoryArtifactStore implements ArtifactStore {
  private byId = new Map<ArtifactId, Artifact>();
  private hashIndex = new Map<string, Artifact[]>();
  private toolCallIndex = new Map<string, Artifact[]>();
  private sessionIndex = new Map<SessionId, Artifact[]>();

  async register(artifact: Artifact): Promise<void> {
    this.byId.set(artifact.id, artifact);
    const key = `${artifact.sessionId}:${artifact.turnId}:${artifact.toolCallId}`;
    this.push(this.toolCallIndex, key, artifact);
    this.push(this.sessionIndex, artifact.sessionId, artifact);
    this.push(this.hashIndex, artifact.sha256, artifact);
  }

  async get(id: ArtifactId): Promise<Artifact | undefined> {
    return this.byId.get(id);
  }

  async byToolCallId(
    sessionId: SessionId,
    turnId: TurnId,
    toolCallId: ToolCallId,
  ): Promise<Artifact[]> {
    return [...(this.toolCallIndex.get(`${sessionId}:${turnId}:${toolCallId}`) ?? [])];
  }

  async bySessionId(sessionId: SessionId): Promise<Artifact[]> {
    return [...(this.sessionIndex.get(sessionId) ?? [])];
  }

  async byHash(sha256: string): Promise<Artifact[]> {
    return [...(this.hashIndex.get(sha256) ?? [])];
  }

  async list(): Promise<Artifact[]> {
    return [...this.byId.values()];
  }

  async remove(ids: ArtifactId[]): Promise<void> {
    const wanted = new Set(ids);
    for (const id of wanted) {
      const artifact = this.byId.get(id);
      if (artifact === undefined) continue;
      this.byId.delete(id);
      const toolKey = `${artifact.sessionId}:${artifact.turnId}:${artifact.toolCallId}`;
      this.removeFrom(this.toolCallIndex, toolKey, id);
      this.removeFrom(this.sessionIndex, artifact.sessionId, id);
      this.removeFrom(this.hashIndex, artifact.sha256, id);
    }
  }

  private push<K>(map: Map<K, Artifact[]>, key: K, artifact: Artifact): void {
    const existing = map.get(key);
    if (existing === undefined) map.set(key, [artifact]);
    else existing.push(artifact);
  }

  private removeFrom<K>(map: Map<K, Artifact[]>, key: K, id: ArtifactId): void {
    const existing = map.get(key);
    if (existing === undefined) return;
    const next = existing.filter((a) => a.id !== id);
    if (next.length === 0) map.delete(key);
    else map.set(key, next);
  }
}
