import type { ArtifactId, SessionId, ToolCallId, TurnId } from "./ids.js";

/** How sensitive the artifact content is; drives redaction and preview policy. */
export type ArtifactSensitivity = "low" | "medium" | "high";

/** How long the artifact is expected to live before cleanup. */
export type ArtifactRetention = "turn" | "session" | "permanent";

/**
 * P1-12: a durable record of a tool output that was offloaded to disk.
 * The `id` — not the `ref` path — is the stable identity: the same bytes may
 * be re-materialized at a different path (or same path on different machines).
 */
export interface Artifact {
  id: ArtifactId;
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  /** Path (or other ref) where the content lives. */
  ref: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  sensitivity: ArtifactSensitivity;
  retention: ArtifactRetention;
}

/** P1-12: durable registry for tool-result artifacts. */
export interface ArtifactStore {
  register(artifact: Artifact): Promise<void>;
  get(id: ArtifactId): Promise<Artifact | undefined>;
  byToolCallId(sessionId: SessionId, turnId: TurnId, toolCallId: ToolCallId): Promise<Artifact[]>;
  bySessionId(sessionId: SessionId): Promise<Artifact[]>;
  byHash(sha256: string): Promise<Artifact[]>;
  list(): Promise<Artifact[]>;
  remove(ids: ArtifactId[]): Promise<void>;
}
