import type { SessionId, SessionStore, TaskSpec, TurnId, Verifier, VerificationResult } from "@ar/contracts";
/**
 * VERIFY-001: runtime-side verification gate (independent integration segment).
 *
 * Responsibilities:
 * - Pull history via store.listMessages(sessionId) and render a compact
 *   transcript: one "[role] content" line per message, per-message truncation
 *   (messageTruncate) plus a hard overall cap (maxTranscriptChars).
 * - Assemble VerificationContext (sessionId / turnId / cwd / changedPaths /
 *   transcript / runStartedAt) and delegate to the wrapped Verifier.
 * - Fail closed: any exception escaping verifier.verify becomes a
 *   "blocked" gate with a synthetic review check carrying an
 *   INTERNAL_ERROR AgentErrorInfo; errors are never swallowed as passes.
 *
 * Design decision — no short-circuit on empty task.verification:
 * TaskVerifier (VS-001) returns a deterministic level-0 / passed=false result
 * for absent or empty specs, so delegating unconditionally keeps every turn on
 * the same code path (uniform coverage) instead of special-casing callers.
 */
export interface RuntimeVerifierOptions {
    cwd: string;
    runStartedAt: number;
    /** Paths the agent touched during the run (collected by the runtime). */
    changedPaths: string[];
    /** Workspace file inventory at run start (for deletion detection). */
    baselineFiles?: string[];
    /** Transcript render cap for the whole turn history. Default 16_000. */
    maxTranscriptChars?: number;
    /** Per-message content cap in the rendered transcript. Default 1_000. */
    messageTruncate?: number;
    /** P1-7: injected clock. Default Date.now. */
    now?: () => number;
}
export type GateStatus = "passed" | "failed" | "blocked";
export interface VerificationGate {
    status: GateStatus;
    result: VerificationResult;
    /** Human-readable explanation; for failed/blocked this carries the cause. */
    reason: string;
}
export declare class RuntimeVerifier {
    private readonly verifier;
    constructor(verifier: Verifier);
    verifyTurn(task: TaskSpec, sessionId: SessionId, turnId: TurnId | undefined, store: SessionStore, opts: RuntimeVerifierOptions): Promise<VerificationGate>;
}
//# sourceMappingURL=runtime-verifier.d.ts.map