import type { EvalCase, ForbiddenActions } from "./eval-case.js";
/**
 * P3-8 — Auto-generated Benchmark Candidates.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). An agent may
 * propose new benchmark cases, but plan.md P3-8 forbids a proposal from
 * entering the formal regression suite unchecked:
 *
 *   judge freeze       the candidate is judged by the FROZEN judge version; a
 *                      candidate cannot ship its own judge/expected
 *                      interpretation, and its pinned judgeVersion must match.
 *   fixture sanitize   proposed fixture files are scanned; injection markers,
 *                      secret-like strings, path traversal, and dangerous exec
 *                      commands reject the candidate (fail-closed).
 *   human or deterministic review
 *                      acceptance requires either a deterministic structural
 *                      review OR (when opted in) explicit human approval; a
 *                      pending review never enters regression.
 *
 * Only after all three pass does a proposal become a regression-ready EvalCase.
 * This mirrors the production stance that additions to the benchmark must be
 * frozen-judged and clean, never self-certified by the proposing agent.
 */
export type BenchCandidateSuite = "regression" | "holdout" | "adversarial" | "stress";
/** An agent-proposed benchmark case. Must carry NO judge logic of its own —
 *  only a pinned judgeVersion that must match the frozen judge. */
export interface BenchmarkCandidate {
    /** Id and (separate) proposal id to surface the proposing agent. */
    id: string;
    proposalId: string;
    task: string;
    suite: BenchCandidateSuite;
    /** Proposed fixture files (path → content). Sanitized before acceptance. */
    fixture?: Record<string, string>;
    expected: EvalCase["expected"];
    forbidden?: ForbiddenActions;
    /** Must equal the frozen judge version; a mismatch means the judge isn't
     *  frozen for this candidate (its own interpretation would leak in). */
    judgeVersionPinned: string;
    tags?: string[];
    /** Optional human review ticket id, surfaced for an explicit approval path. */
    reviewTicketId?: string;
}
export type CandidateVerdict = "accepted" | "pending" | "rejected";
export interface CandidateReviewReport {
    verdict: CandidateVerdict;
    /** Why. Empty when accepted. */
    reasons: string[];
    /** The regression-ready case when accepted (judge frozen to `judgeVersion`). */
    case?: EvalCase;
}
export interface SanitizeResult {
    ok: boolean;
    reason?: string;
}
/** Scan a proposed fixture set. Any unsafe path or content rejects it. */
export declare function sanitizeFixture(fixture: Record<string, string> | undefined): SanitizeResult;
/** The candidate is acceptable only if its pinned judge version equals the
 *  frozen judge. A candidate must never carry/interpret its own judge. */
export declare function assertJudgeFrozen(candidate: BenchmarkCandidate, frozenJudgeVersion: string): {
    ok: boolean;
    reason?: string;
};
export interface DeterministicReviewOptions {
    frozenJudgeVersion: string;
    allowedSuites?: readonly BenchCandidateSuite[];
    /** When true, acceptance requires explicit human approval (else pending). */
    requireHuman?: boolean;
}
/** Pure structural review of a candidate. Deterministic — no human needed. */
export declare function deterministicReview(candidate: BenchmarkCandidate, options: DeterministicReviewOptions): CandidateReviewReport;
/** Build the regression-ready EvalCase from an accepted candidate. The judge is
 *  frozen to `judgeVersion`; the candidate carries no judge of its own. */
export declare function toCase(candidate: BenchmarkCandidate, judgeVersion: string): EvalCase;
/**
 * The P3-8 acceptance gate. An agent's proposed case becomes a regression-ready
 * EvalCase ONLY after: judge is frozen, fixture is sanitized, and the review is
 * either deterministic-passing or explicitly human-approved. Safety (judge
 * freeze + fixture sanitize + structure) is ALWAYS enforced and can never be
 * waived by human approval — a human only decides whether a *structurally safe*
 * proposal needs an explicit authorization ticket before admission.
 */
export declare function reviewBenchmarkCandidate(candidate: BenchmarkCandidate, options?: DeterministicReviewOptions & {
    humanApproved?: boolean;
}): CandidateReviewReport;
//# sourceMappingURL=benchmark-candidates.d.ts.map