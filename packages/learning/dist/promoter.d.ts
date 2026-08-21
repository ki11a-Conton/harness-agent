import type { LearningCandidate } from "./candidate.js";
import type { PairedComparisonReport, PairedGateOptions } from "./paired.js";
import type { HarnessScoreCard } from "./scorecard.js";
export interface PromotionDecision {
    action: "promoted" | "rejected" | "rolled_back";
    reason: string;
}
export interface PromoteDeps {
    securityCheck: (c: LearningCandidate) => Promise<{
        ok: boolean;
        reason?: string;
    }>;
    benchmarkBefore: () => Promise<number>;
    benchmarkAfter: () => Promise<number>;
    /** Minimum required gain; boundary inclusive (after == before + threshold rejects). */
    threshold?: number;
    /** P10-5: hard security gate — count of security violations observed on the
     *  challenger runs. ANY violation rejects, even when the success score
     *  improved ("不是总分游戏"). Absent → not gated. */
    securityViolations?: () => Promise<number>;
    persist: (c: LearningCandidate) => Promise<void>;
}
export interface ReEvaluateDeps {
    benchmarkCurrent: () => Promise<number>;
}
/**
 * §147/§194 promotion gate for learning candidates (§69 pipeline:
 * trace → outcome → reflection → candidate → evaluation → promotion).
 *
 * Nothing is persisted before this gate approves. A candidate must pass a
 * security check AND show a benchmark improvement over a recorded baseline;
 * §194 forbids auto-promotion on score alone, and §147 requires repeated
 * evidence — a single sample is rejected by design ("one accidental success
 * is insufficient"). A missing baseline (benchmarkBefore returning a
 * non-finite value or throwing) rejects without ever measuring the "after"
 * score; the error message is preserved in the reason rather than swallowed.
 * Security-check failures are always decisive and short-circuit before any
 * benchmark runs.
 *
 * The §70 rollback path is `evaluateAfter`: after a successful promotion the
 * post-promotion score is recorded on the candidate, and a later
 * re-measurement below that score returns `rolled_back` (nothing is written
 * on rollback — undoing the live change is the caller's action).
 *
 * All side effects flow through the injected deps; there is no filesystem,
 * store, or network access here.
 */
export declare class LearningPromoter {
    promote(c: LearningCandidate, deps: PromoteDeps): Promise<PromotionDecision>;
    /**
     * §70 post-promotion re-evaluation. A current score below the recorded
     * post-promotion score rolls the promotion back; an unmeasurable current
     * score also rolls back (fail-closed: the promotion can no longer be
     * confirmed healthy). Never calls persist.
     */
    evaluateAfter(c: LearningCandidate, deps: ReEvaluateDeps): Promise<PromotionDecision>;
}
/**
 * P0-5 LearningPromoter V2: Champion → Candidate → Challenger → repeated
 * paired evaluations → Promotion Gate (plan.md P0-5).
 *
 * Unlike the single-score LearningPromoter (§194: one accidental success is
 * insufficient), V2 compares N paired repeated runs (same seed / comparable
 * configuration per index) through the HarnessScoreCard gate: no significant
 * regression, holdout benefit per candidate kind, no new security violations
 * (hard gate, not tradable), no raised false-complete rate, latency and token
 * use within configured budgets.
 *
 * Nothing is persisted before the gate approves; the security check runs
 * first and short-circuits benchmarks on failure (same contract as V1). On
 * approval the full promotion ledger (§790-797) is written to
 * `candidate.promotionRecord` and `persist` is called once.
 *
 * The §70 rollback path is `reEvaluate`: the current repeated runs are
 * compared against the frozen post-promotion scorecard; any regressed pair or
 * budget breach rolls the promotion back (fail-closed when runs cannot be
 * collected). Rollback never calls persist — undoing the live change is the
 * caller's action, exactly like V1.
 *
 * All side effects flow through the injected deps; there is no filesystem,
 * store, or network access here.
 */
export interface PairedPromotionDecision {
    action: "promoted" | "rejected" | "rolled_back";
    reason: string;
    /** Present whenever a paired evaluation ran (gate details, per metric). */
    report?: PairedComparisonReport;
}
/** Version metadata recorded verbatim into the promotion ledger. */
export interface RecordMeta {
    /** Free-form evaluation configuration (runs, seeds, tolerances, budgets). */
    evaluationConfig?: string;
    /** Suite versions or identifiers of the evaluation. */
    suiteVersions?: string;
    /** Judge logic version of the evaluation. */
    judgeVersion?: string;
    /** Model / provider versions of the evaluation. */
    modelProviderVersion?: string;
}
export interface PairedPromoteDeps {
    securityCheck: (c: LearningCandidate) => Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Champion run i (paired seed / comparable configuration per index). */
    championRuns: (runIndex: number) => Promise<HarnessScoreCard>;
    /** Challenger run i — same seed / configuration as champion run i. */
    challengerRuns: (runIndex: number) => Promise<HarnessScoreCard>;
    /** Number of repeated paired runs (must be ≥ MIN_REPEATED_RUNS). */
    runs: number;
    options?: PairedGateOptions;
    /** Version metadata for the promotion ledger (absent → "(not recorded)"). */
    meta?: RecordMeta;
    persist: (c: LearningCandidate) => Promise<void>;
}
export interface PairedReEvaluateDeps {
    /** Current run i of the post-promotion state, N repeated runs. */
    currentRuns: (runIndex: number) => Promise<HarnessScoreCard>;
    /** Number of repeated current runs (must be ≥ MIN_REPEATED_RUNS). */
    runs: number;
    options?: PairedGateOptions;
}
export declare class LearningPromoterV2 {
    private resolveHoldout;
    private collect;
    /**
     * Champion/Challenger promotion gate over N paired repeated runs. Runs are
     * only collected after the security check passes; any collection failure
     * rejects (fail-closed) without persisting.
     */
    promote(c: LearningCandidate, deps: PairedPromoteDeps): Promise<PairedPromotionDecision>;
    /**
     * §70/§777-797 periodic rollback re-evaluation: the current repeated runs
     * must still hold against the frozen post-promotion scorecard. Any run
     * pair with more security violations or a raised false-complete rate, any
     * median regression beyond tolerance, or any budget breach rolls the
     * promotion back. Unmeasurable current runs also roll back (fail-closed:
     * the promotion can no longer be confirmed healthy). Never calls persist.
     */
    reEvaluate(c: LearningCandidate, deps: PairedReEvaluateDeps): Promise<PairedPromotionDecision>;
}
//# sourceMappingURL=promoter.d.ts.map