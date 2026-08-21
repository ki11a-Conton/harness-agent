import type { Artifact, ArtifactId, ArtifactStore, SessionId, ToolCallId, TurnId } from "@ar/contracts";
/** In-memory ArtifactStore with id/hash/tool-call indexes (P1-12). */
export declare class InMemoryArtifactStore implements ArtifactStore {
    private byId;
    private hashIndex;
    private toolCallIndex;
    private sessionIndex;
    register(artifact: Artifact): Promise<void>;
    get(id: ArtifactId): Promise<Artifact | undefined>;
    byToolCallId(sessionId: SessionId, turnId: TurnId, toolCallId: ToolCallId): Promise<Artifact[]>;
    bySessionId(sessionId: SessionId): Promise<Artifact[]>;
    byHash(sha256: string): Promise<Artifact[]>;
    list(): Promise<Artifact[]>;
    remove(ids: ArtifactId[]): Promise<void>;
    private push;
    private removeFrom;
}
//# sourceMappingURL=artifact-store.d.ts.map