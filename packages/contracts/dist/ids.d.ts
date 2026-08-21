declare const brand: unique symbol;
type Branded<S extends string> = string & {
    readonly [brand]: S;
};
export type SessionId = Branded<"SessionId">;
export type TurnId = Branded<"TurnId">;
export type MessageId = Branded<"MessageId">;
export type ToolCallId = Branded<"ToolCallId">;
export type ApprovalId = Branded<"ApprovalId">;
export type EventId = Branded<"EventId">;
export type RunId = Branded<"RunId">;
export type CheckpointId = Branded<"CheckpointId">;
export type MemoryId = Branded<"MemoryId">;
export type SkillId = Branded<"SkillId">;
export type AgentId = Branded<"AgentId">;
export type JobId = Branded<"JobId">;
export type ProcessId = Branded<"ProcessId">;
export type TraceId = Branded<"TraceId">;
export type PromptId = Branded<"PromptId">;
export type ArtifactId = Branded<"ArtifactId">;
export type AskId = Branded<"AskId">;
export type ModelCallId = Branded<"ModelCallId">;
/** Override the global ID source; pass null to restore the default randomUUID.
 *  Q-8: tests install a deterministic generator for reproducible event/model
 *  snapshots, then MUST restore it (the returned disposer does that). */
export declare function installIdSource(source: (() => string) | null): void;
/**
 * Install a deterministic, counter-based ID source for reproducible snapshots.
 * Returns a disposer that restores the previously active source.
 *
 * The counter resets on every install, so the same call sequence always yields
 * the same IDs (fully replayable). Suffixes are globally-unique per call, so
 * no cross-type collisions occur even though the value space is small.
 */
export declare function installDeterministicIds(): () => void;
export declare function newSessionId(): SessionId;
export declare function newTurnId(): TurnId;
export declare function newMessageId(): MessageId;
export declare function newToolCallId(): ToolCallId;
export declare function newApprovalId(): ApprovalId;
export declare function newEventId(): EventId;
export declare function newRunId(): RunId;
export declare function newCheckpointId(): CheckpointId;
export declare function newMemoryId(): MemoryId;
export declare function newSkillId(): SkillId;
export declare function newAgentId(): AgentId;
export declare function newJobId(): JobId;
export declare function newProcessId(): ProcessId;
export declare function newTraceId(): TraceId;
export declare function newPromptId(): PromptId;
export declare function newArtifactId(): ArtifactId;
export declare function newAskId(): AskId;
export declare function newModelCallId(): ModelCallId;
export declare function isId(prefix: string, value: string): boolean;
export {};
//# sourceMappingURL=ids.d.ts.map