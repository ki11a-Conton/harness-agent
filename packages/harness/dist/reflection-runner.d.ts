import type { EventStore, ReflectionOutput, SessionId, TurnId } from "@ar/contracts";
import { type MemoryWritePolicy } from "@ar/memory";
import type { LearningCandidate } from "@ar/learning";
import type { LearningCandidateStore } from "./candidate-store.js";
export interface PostTurnReflectorDeps {
    events: EventStore;
    candidateStore: LearningCandidateStore;
    /** Reflection journal directory (dataDir). */
    dataDir: string;
    writePolicy?: MemoryWritePolicy;
    now?: () => number;
    /** Deterministic id factory; defaults to a randomUUID-based generator. */
    newCandidateId?: () => string;
}
export interface ReflectionRunInput {
    sessionId: SessionId;
    turnId: TurnId;
    /** Structured outcome view (decoupled from @ar/core's TurnOutcome). */
    outcome: {
        status: string;
        state?: {
            goal?: string;
        };
    };
}
export interface ReflectionRunResult {
    /** Reflection outputs appended to the journal. */
    outputs: number;
    /** Candidates queued into the learning candidate store (write-gate passed). */
    candidates: number;
}
export interface ReflectionJournalRecord {
    schemaVersion: number;
    sessionId: SessionId;
    turnId: TurnId;
    outcome: string;
    at: number;
    reflection: ReflectionOutput;
}
export declare const REFLECTION_FILE_NAME = "reflection-outputs.jsonl";
/** P2-5: deterministic post-turn reflection. Reads the session event stream,
 *  reflects over failures, journals the outputs, and queues write-gate-passing
 *  procedural candidates (P2-6). Errors are contained per step — a reflection
 *  failure must never break the surrounding application. */
export declare class PostTurnReflector {
    private readonly events;
    private readonly candidateStore;
    private readonly journal;
    private readonly writePolicy;
    private readonly now;
    private readonly makeCandidateId;
    constructor(deps: PostTurnReflectorDeps);
    /** P2-5: reflect over one completed/failed turn. */
    reflect(input: ReflectionRunInput): Promise<ReflectionRunResult>;
    /** Read the reflection journal (for the CLI / audits). */
    listJournal(): Promise<ReflectionJournalRecord[]>;
    private appendJournal;
}
/** A write-gate-passing reflection becomes a queued learning candidate. The
 *  source reflection id is preserved for the promotion audit trail and the
 *  structured strategy lesson travels with the candidate (P2-6) so a later
 *  promotion can build a rich memory entry. */
export declare function candidateFromReflection(reflection: ReflectionOutput, id: string, at: number): LearningCandidate;
//# sourceMappingURL=reflection-runner.d.ts.map