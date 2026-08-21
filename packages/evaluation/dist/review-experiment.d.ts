import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-2 — Review Agent Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). For high-risk
 * tasks it models an independent Reviewer inserted between the Worker and the
 * verifier:
 *
 *   Worker → independent Reviewer → verifier
 *
 * The core safety property enforced here is REVIEWER ISOLATION: the Reviewer
 * must only ever read artifacts / diff / evidence derived from the Worker's
 * observable outputs — NEVER the Worker's hidden reasoning, internal plan,
 * or private chain-of-thought. The structured input type documented below
 * deliberately carries no transcript/ reasoning surface, and the guard
 * function rejects (fail-closed) any input that would smuggle one in.
 *
 * Value hypothesis: on high-risk tasks the verifier alone may let a
 * "false-complete" slip (the gate passes but the artifacts are actually
 * wrong). An isolation-respecting Reviewer that inspects the diff/evidence
 * can catch a fraction of those latent defects — at the price of an extra
 * review pass (tokens + latency) and some false-positive rework on clean
 * outputs. The promotion gate only promotes the Reviewer when the net defect
 * reduction clears the added cost (plan.md P3: 不能降低安全标准来通过).
 *
 * As with P3-1, the Reviewer is expressed as a deterministic, seeded effect
 * model composed over the measured Worker outcome; measurement truth (which
 * passed cases are actually defective) is supplied by a truth layer — never
 * fed to the Reviewer — so nothing is fabricated.
 */
/** Reviewer pipeline variant. */
export type ReviewPipeline = "worker_verifier" | "worker_reviewer_verifier";
/** What the Reviewer may read. Deliberately EXCLUDES any reasoning surface.
 *  Sourced only from observable Worker outputs: changed files (diff), touched
 *  tests, evidence, and outputs. */
export interface Reviewable {
    caseId: string;
    /** Files the Worker changed (diff surface). */
    changedPaths: string[];
    /** Whether the diff touched test files (a "did you test it" signal). */
    touchedTests: boolean;
    /** Whether the diff touched configuration / generated junk paths (risk cue). */
    touchedGeneratedOrConfig: boolean;
    /** Evidence produced by the Worker (verification artifacts, command outputs). */
    evidence: Array<{
        type: string;
        source: string;
    }>;
    /** Change breadth — number of changed files. */
    changedFileCount: number;
    /** The Worker's verification gate result. */
    verificationPassed: boolean;
}
export declare function assertReviewerIsolation(reviewable: Record<string, unknown>): void;
/** Measurement truth for a case — whether the passed Work was actually
 *  defective. Supplied by a truth layer (e.g. a holdout judge / known-answer
 *  set) and NEVER handed to the Reviewer. */
export interface ReviewTruth {
    caseId: string;
    /** True when the artifact/diff is actually wrong even though it passed. */
    latentDefect: boolean;
}
/** The Reviewer's detection effect model — tunable experiment hypothesis. */
export interface ReviewerEffectModel {
    /** Extra tokens the review pass burns per reviewed case. */
    reviewTokensPerCase: number;
    /** Extra wall-clock (ms) the review pass adds per reviewed case. */
    reviewLatencyMsPerCase: number;
    /** Fraction of latent defects the isolation-respecting Reviewer catches
     *  by reading only diff/evidence (0..1). */
    defectRecall: number;
    /** Fraction of CLEAN (non-defective) outputs wrongly flagged for rework
     *  (0..1) — the reviewer's noise floor. */
    falsePositiveRate: number;
    /** Only cases with a verification gate are routed through the Reviewer
     *  (high-risk gate). */
    reviewOnlyWhenVerified: boolean;
}
export interface ReviewRunMetrics {
    caseId: string;
    pipeline: ReviewPipeline;
    latentDefect: boolean;
    verificationPassed: boolean;
    /** True when the Reviewer flagged the output for rework (challenger only). */
    flagged: boolean;
    /** True when a latent defect was caught (rework before it shipped). */
    defectCaught: boolean;
    /** True when a clean output was wastefully flagged (false positive). */
    falsePositiveHandled: boolean;
    tokens: number;
    durationMs: number;
}
export interface ReviewAggregate {
    pipeline: ReviewPipeline;
    /** Latent defects caught as a fraction of ALL latent defects present. */
    defectCaughtRate: number;
    /** Slipped defects: latent defects that shipped/uncaught. */
    slippedDefects: number;
    /** False positives (clean outputs wastefully flagged). */
    falsePositives: number;
    /** (defectsCaught - falsePositives) — net review value. */
    netDefectsCaught: number;
    totalTokens: number;
    totalDurationMs: number;
    costScore: number;
}
export interface ReviewComparison {
    baseline: ReviewAggregate;
    challenger: ReviewAggregate;
    cases: ReviewRunMetrics[];
    defectCaughtDelta: number;
    slippedDelta: number;
    falsePositiveCount: number;
    tokenDeltaRatio: number;
    latencyDeltaRatio: number;
    costScoreDelta: number;
    decision: ReviewDecision;
}
export type ReviewDecisionCode = "promote" | "no_defect_value" | "too_noisy" | "cost_negative";
export interface ReviewDecision {
    promote: boolean;
    code: ReviewDecisionCode;
    reason: string;
    minimumNetDefectsCaught: number;
    maxFalsePositiveRate: number;
}
export interface RunReviewExperimentOptions {
    model?: Partial<ReviewerEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: {
        /** Minimum net defects (caught - false positives) required to promote. */
        minimumNetDefectsCaught?: number;
        /** Above this false-positive fraction, promotion is blocked as too noisy. */
        maxFalsePositiveRate?: number;
    };
}
export declare const DEFAULT_REVIEWER_MODEL: ReviewerEffectModel;
/** Derive a Reviewer-isolated Reviewable from a Worker's observable outcome.
 *  Reads only tool events (changed files / evidence) — never any reasoning. */
export declare function deriveReviewable(outcome: EvalOutcome, seed?: number): Reviewable;
/**
 * Default deterministic truth layer when the caller does not supply one:
 * a case is "latently defective" when the diff was generated/config-heavy or
 * broad with no tests touched and no verification evidence. This is a
 * documented heuristic (seeded for reproducibility), NOT a measurement; real
 * experiments must supply a judge-backed truth layer.
 */
export declare function defaultTruthLayer(outcome: EvalOutcome, seed?: number): ReviewTruth;
/** Simulate a review-pipeline run for one case given its truth layer. */
export declare function simulateReviewRun(outcome: EvalOutcome, truth: ReviewTruth, reviewable: Reviewable, pipeline: ReviewPipeline, options?: {
    model?: Partial<ReviewerEffectModel>;
    seed?: number;
}): ReviewRunMetrics;
export declare function aggregateReview(runs: ReviewRunMetrics[], pipeline: ReviewPipeline, cost?: CostModelOptions): ReviewAggregate;
/**
 * Run the Review Agent experiment: same cases through Worker+verifier
 * (baseline) and Worker→Reviewer→verifier (challenger). The Reviewer is
 * isolation-isolated (reads only diff/evidence) and the truth layer is kept
 * out of its input.
 *
 * @param cases benchmark cases (only used for ids/ordering).
 * @param runWorker per-case Worker runner producing the baseline `EvalOutcome`.
 * @param truth generated per case — can be omitted to use the documented
 *        deterministic heuristic (real experiments must supply a judge-backed
 *        truth layer instead).
 */
export declare function runReviewExperiment(cases: EvalCase[], runWorker: (caseDef: EvalCase) => Promise<EvalOutcome>, options?: RunReviewExperimentOptions & {
    truth?: (caseDef: EvalCase, outcome: EvalOutcome) => ReviewTruth;
}): Promise<ReviewComparison>;
interface ReviewPromotionInput {
    netDefectsCaught: number;
    slippedDelta: number;
    falsePositiveRate: number;
    costScoreDelta: number;
    gate?: {
        minimumNetDefectsCaught?: number;
        maxFalsePositiveRate?: number;
    };
}
/** The review promotion gate. Encodes: promote only if the isolation-safe
 *  Reviewer catches ≥ `minimumNetDefectsCaught` latent defects net of noise,
 *  keeps the false-positive rate under `maxFalsePositiveRate`, and does not
 *  tank the cost score. A Reviewer that only adds tokens/latency without
 *  catching real defects is never promoted. */
export declare function decideReviewPromotion(input: ReviewPromotionInput): ReviewDecision;
/** Render the experiment as plain text for CLI output. */
export declare function renderReviewComparison(cmp: ReviewComparison): string;
export {};
//# sourceMappingURL=review-experiment.d.ts.map