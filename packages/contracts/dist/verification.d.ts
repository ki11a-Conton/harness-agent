import type { AgentErrorInfo } from "./errors.js";
import type { SessionId, TurnId } from "./ids.js";
export type EvidenceType = "file" | "command" | "test" | "diff" | "http" | "review";
export interface Evidence {
    type: EvidenceType;
    description: string;
    source: string;
    timestamp: number;
}
export type VerificationLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type VerificationCheckKind = "command" | "artifact" | "requirement" | "review" | "diff";
export interface VerificationCheck {
    id: string;
    kind: VerificationCheckKind;
    description: string;
    passed: boolean;
    evidence?: Evidence;
    error?: AgentErrorInfo;
}
export interface VerificationResult {
    level: VerificationLevel;
    passed: boolean;
    checks: VerificationCheck[];
    evidence: Evidence[];
    startedAt: number;
    completedAt: number;
}
export type VerificationSpec = {
    kind: "command";
    command: string;
    args?: string[];
    description?: string;
} | {
    kind: "artifact";
    path: string;
    mustChange?: boolean;
    description?: string;
} | {
    kind: "requirement";
    statement: string;
    description?: string;
} | {
    kind: "diff";
    /** Every listed path must appear in changedPaths. */
    expectedPaths?: string[];
    /** None of these may appear in changedPaths (destructive/unexpected). */
    mustNotChange?: string[];
    /** Fail if a baseline file (all of them when `true`, or the listed
     *  paths) no longer exists — unexpected file deletion. */
    forbidDeletions?: boolean | string[];
    /** Fail when any changed path matches one of these glob patterns
     *  (generated junk / format-only explosion). */
    forbidPatterns?: string[];
    /** Fail when more than this many files were changed (large accidental
     *  rewrite). */
    maxFiles?: number;
    description?: string;
};
/** P1-15: objective completion requirements. A task whose outcome can be
 *  verified objectively must not complete on the model's word alone. */
export interface CompletionPolicy {
    /** Task is only done when the verification gate passes; a missing verifier
     *  blocks completion instead of silently passing. */
    requiresVerification?: boolean;
    /** Task must have changed at least one file. */
    requiresChangedFile?: boolean;
    /** Task must not have changed any file. */
    requiresNoSideEffects?: boolean;
}
export interface TaskSpec {
    id: string;
    goal: string;
    constraints?: string[];
    allowedScope?: string[];
    forbiddenScope?: string[];
    verification?: VerificationSpec[];
    progress?: string;
    completionPolicy?: CompletionPolicy;
}
/** Narrow, dependency-free view of run state handed to Verifiers. */
export interface VerificationContext {
    sessionId: SessionId;
    turnId?: TurnId;
    cwd: string;
    /** Paths the agent touched during the run (produced by tools). */
    changedPaths: string[];
    /** Workspace file inventory at run start — lets diff checks detect
     *  unexpected deletions. Optional: only supplied when the host has a
     *  baseline (e.g. benchmark fixtures). */
    baselineFiles?: string[];
    /** Raw history of messages/tool results, rendered compactly. */
    transcript: string;
    runStartedAt: number;
}
export interface Verifier {
    verify(task: TaskSpec, context: VerificationContext): Promise<VerificationResult>;
}
//# sourceMappingURL=verification.d.ts.map