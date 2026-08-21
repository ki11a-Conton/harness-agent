import type { AgentEvent, EventStore, SessionId, SessionStatus, SessionStore, TaskSpec, Verifier } from "@ar/contracts";
import { type RunMetrics } from "./metrics.js";
/**
 * Episode trace export, per AGENT_ARCHITECTURE_PLAN v2.0 §77.
 *
 * Reads an event stream + session record through their contracts interfaces
 * (never the JSONL implementations) and writes a self-contained episode
 * package: task.json, session.json, events.jsonl, context.json,
 * tool-calls.jsonl, permissions.jsonl, artifacts.json, verification.json,
 * metrics.json, summary.json.
 *
 * The export target is discovered from the session store: exactly one
 * session is required (0 or >1 throws). An empty event stream is valid and
 * produces a complete, parseable package.
 */
/** §77 file set, in canonical order. */
export declare const EPISODE_FILES: readonly ["task.json", "session.json", "events.jsonl", "context.json", "tool-calls.jsonl", "permissions.jsonl", "artifacts.json", "verification.json", "metrics.json", "summary.json"];
/** §168 repository snapshot embedded in summary.json. */
export interface RepoSnapshot {
    node: string;
    git: {
        available: boolean;
        branch?: string;
        commit?: string;
        dirty?: boolean;
        changedFiles?: string[];
    };
}
export interface ArtifactEntry {
    path: string;
    kind?: string;
    description?: string;
    at: number;
}
export interface EpisodeSummary {
    sessionId: SessionId;
    status: SessionStatus;
    taskId?: string;
    startedAt: number;
    endedAt: number;
    turnCount: number;
    toolCallCount: number;
    artifactCount: number;
    artifacts: string[];
    verification: {
        source: "verifier" | "events" | "none";
        passed?: boolean;
    };
    metrics: RunMetrics;
    repoSnapshot: RepoSnapshot;
    files: readonly string[];
}
export interface EpisodePackage {
    outputDir: string;
    files: readonly string[];
    sessionId: SessionId;
    events: AgentEvent[];
    metrics: RunMetrics;
    summary: EpisodeSummary;
}
export interface ExportEpisodeDeps {
    events: EventStore;
    sessions: SessionStore;
    task?: TaskSpec;
    verifier?: Verifier;
    outputDir: string;
}
/** Export a complete episode package (§77) for the single session in the store. */
export declare function exportEpisode(deps: ExportEpisodeDeps): Promise<EpisodePackage>;
//# sourceMappingURL=trace-exporter.d.ts.map