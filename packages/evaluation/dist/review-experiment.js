import { toolNameOf as toolNameOfPayload } from "@ar/contracts";
import { scoreCost } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";
/**
 * REFUSES any object that carries a hidden-reasoning surface. This is the
 * isolation guard, applied before the Reviewer runs: an input that smuggles
 * transcript / reasoning / internal-plan / chain-of-thought fields is a
 * fail-closed violation (never silently truncated).
 */
const FORBIDDEN_KEYS = [
    "reasoning",
    "chain_of_thought",
    "hidden_reasoning",
    "internal_plan",
    "private_plan",
    "transcript",
    "worker_thoughts",
    "cot",
    "scratchpad",
];
export function assertReviewerIsolation(reviewable) {
    for (const key of Object.keys(reviewable)) {
        if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
            throw new Error(`reviewer isolation violated: input carries hidden-reasoning key "${key}"`);
        }
    }
}
export const DEFAULT_REVIEWER_MODEL = {
    reviewTokensPerCase: 800,
    reviewLatencyMsPerCase: 1000,
    defectRecall: 0.6,
    falsePositiveRate: 0.1,
    reviewOnlyWhenVerified: true,
};
function resolveReviewModel(partial) {
    const m = DEFAULT_REVIEWER_MODEL;
    return {
        reviewTokensPerCase: partial?.reviewTokensPerCase ?? m.reviewTokensPerCase,
        reviewLatencyMsPerCase: partial?.reviewLatencyMsPerCase ?? m.reviewLatencyMsPerCase,
        defectRecall: partial?.defectRecall ?? m.defectRecall,
        falsePositiveRate: partial?.falsePositiveRate ?? m.falsePositiveRate,
        reviewOnlyWhenVerified: partial?.reviewOnlyWhenVerified ?? m.reviewOnlyWhenVerified,
    };
}
// ---------------------- Reviewable derivation (no reasoning surface) ---------
const WRITE_TOOLS = new Set(["write_file", "edit_file", "write"]);
const TEST_PATTERN = /(^|\/)(test|tests|__tests__|spec|specs)(\/|\.)|\.test\.|\.spec\./i;
const GENERATED_PATTERN = /(^|\/)(dist|build|coverage|node_modules|\.artifacts)(\/|$)/i;
/** Derive a Reviewer-isolated Reviewable from a Worker's observable outcome.
 *  Reads only tool events (changed files / evidence) — never any reasoning. */
export function deriveReviewable(outcome, seed = 7) {
    const changedPaths = [];
    const touchedFiles = new Set();
    for (const event of outcome.events) {
        if (event.type === "tool.completed" && WRITE_TOOLS.has(toolName(event))) {
            const path = pathOf(event);
            if (path !== undefined) {
                touchedFiles.add(path);
                changedPaths.push(path);
            }
        }
    }
    const changedFileCount = touchedFiles.size;
    const touchedTests = [...touchedFiles].some((p) => TEST_PATTERN.test(p));
    const touchedGeneratedOrConfig = [...touchedFiles].some((p) => GENERATED_PATTERN.test(p));
    const evidence = [];
    for (const event of outcome.events) {
        if (event.type.startsWith("verification.")) {
            evidence.push({
                type: event.type,
                source: typeof event.payload.detail === "string" ? event.payload.detail : event.type,
            });
        }
    }
    void seed;
    const reviewable = {
        caseId: outcome.caseId,
        changedPaths: [...changedPaths],
        touchedTests,
        touchedGeneratedOrConfig,
        evidence,
        changedFileCount,
        verificationPassed: outcome.status === "passed",
    };
    assertReviewerIsolation(reviewable);
    return reviewable;
}
/**
 * Default deterministic truth layer when the caller does not supply one:
 * a case is "latently defective" when the diff was generated/config-heavy or
 * broad with no tests touched and no verification evidence. This is a
 * documented heuristic (seeded for reproducibility), NOT a measurement; real
 * experiments must supply a judge-backed truth layer.
 */
export function defaultTruthLayer(outcome, seed = 7) {
    const r = seededRandom(seed * 31 + outcome.caseId.length);
    const hasVerificationEvidence = outcome.events.some((event) => event.type.startsWith("verification."));
    const touchedTests = outcome.events.some((event) => event.type === "tool.completed" &&
        WRITE_TOOLS.has(toolName(event)) &&
        (() => {
            const p = pathOf(event);
            return p !== undefined && TEST_PATTERN.test(p);
        })());
    const baseRisk = hasVerificationEvidence && touchedTests ? 0.15 : 0.55;
    const latentDefect = r() < baseRisk;
    return { caseId: outcome.caseId, latentDefect };
}
/** Simulate a review-pipeline run for one case given its truth layer. */
export function simulateReviewRun(outcome, truth, reviewable, pipeline, options = {}) {
    const model = resolveReviewModel(options.model);
    const random = seededRandom((options.seed ?? 7) + outcome.caseId.length);
    const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
    let flagged = false;
    let defectCaught = false;
    let falsePositiveHandled = false;
    if (pipeline === "worker_reviewer_verifier") {
        const shouldReview = model.reviewOnlyWhenVerified ? outcome.status === "passed" : true;
        if (shouldReview) {
            // The Reviewer inspects ONLY the reviewable surface; its decision stems
            // from that surface's cues plus its recall/noise rates.
            const riskySurface = reviewable.touchedGeneratedOrConfig || reviewable.changedFileCount === 0;
            const detectSignal = truth.latentDefect && (riskySurface ? 0.8 : 0.4) && random() < model.defectRecall;
            const noiseSignal = !truth.latentDefect && random() < model.falsePositiveRate;
            if (detectSignal) {
                flagged = true;
                defectCaught = true;
            }
            else if (noiseSignal) {
                flagged = true;
                falsePositiveHandled = true;
            }
        }
    }
    return {
        caseId: outcome.caseId,
        pipeline,
        latentDefect: truth.latentDefect,
        verificationPassed: outcome.status === "passed",
        flagged,
        defectCaught,
        falsePositiveHandled,
        tokens: tokens + (pipeline === "worker_reviewer_verifier" ? model.reviewTokensPerCase : 0),
        durationMs: outcome.metrics.duration_ms +
            (pipeline === "worker_reviewer_verifier" ? model.reviewLatencyMsPerCase : 0),
    };
}
// ---------------------- Aggregation & cost ---------------------------------
export function aggregateReview(runs, pipeline, cost) {
    const allDefects = runs.filter((r) => r.latentDefect).length;
    const caught = runs.filter((r) => r.defectCaught).length;
    const falsePositives = runs.filter((r) => r.falsePositiveHandled).length;
    // Quality is scored on *shipped* defect-freedom, not on the verifier's
    // pass flag. A case that passed the verifier but shipped with a latent
    // defect is a failure (the "false-complete" the Reviewer exists to catch).
    // This makes catching real defects visible to the cost model so their value
    // can outweigh review cost — otherwise review could never be promotable.
    const slippedDefects = allDefects - caught;
    const shippedFailures = runs.filter((r) => !r.verificationPassed).length + slippedDefects;
    const costResult = scoreCost({
        status: shippedFailures > 0 ? "failed" : "passed",
        violations: [],
        metrics: {
            turn_count: runs.length,
            tool_call_count: runs.reduce((s, r) => (r.verificationPassed ? 1 : 0) + s, 0),
            tokens_input: Math.round(runs.reduce((s, r) => s + r.tokens, 0) * 0.7),
            tokens_output: Math.round(runs.reduce((s, r) => s + r.tokens, 0) * 0.3),
            context_tokens: 0,
            duration_ms: runs.reduce((s, r) => s + r.durationMs, 0),
            retry_count: 0,
            verification_failures: 0,
            human_interventions: 0,
            compaction_count: 0,
            estimated_cost: 0,
        },
        events: [],
    }, cost ?? {});
    return {
        pipeline,
        defectCaughtRate: allDefects === 0 ? 0 : caught / allDefects,
        slippedDefects: allDefects - caught,
        falsePositives,
        netDefectsCaught: caught - falsePositives,
        totalTokens: runs.reduce((s, r) => s + r.tokens, 0),
        totalDurationMs: runs.reduce((s, r) => s + r.durationMs, 0),
        costScore: costResult.score,
    };
}
// ---------------------- Experiment runner & gate ----------------------------
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
export async function runReviewExperiment(cases, runWorker, options = {}) {
    const model = resolveReviewModel(options.model);
    const baseline = [];
    const challenger = [];
    for (const caseDef of cases) {
        const outcome = await runWorker(caseDef);
        const truth = options.truth?.(caseDef, outcome) ?? defaultTruthLayer(outcome, options.seed ?? 7);
        const reviewable = deriveReviewable(outcome, options.seed ?? 7);
        baseline.push(simulateReviewRun(outcome, truth, reviewable, "worker_verifier", options));
        // Guard: assert the Reviewer input carries no reasoning surface every time.
        assertReviewerIsolation(reviewable);
        challenger.push(simulateReviewRun(outcome, truth, reviewable, "worker_reviewer_verifier", options));
    }
    const baselineAgg = aggregateReview(baseline, "worker_verifier", options.cost);
    const challengerAgg = aggregateReview(challenger, "worker_reviewer_verifier", options.cost);
    const defectCaughtDelta = challengerAgg.slippedDefects - baselineAgg.slippedDefects; // negative = fewer slipped
    const tokenDeltaRatio = baselineAgg.totalTokens === 0 ? 0 : (challengerAgg.totalTokens - baselineAgg.totalTokens) / baselineAgg.totalTokens;
    const latencyDeltaRatio = baselineAgg.totalDurationMs === 0 ? 0 : (challengerAgg.totalDurationMs - baselineAgg.totalDurationMs) / baselineAgg.totalDurationMs;
    const costScoreDelta = challengerAgg.costScore - baselineAgg.costScore;
    const decision = decideReviewPromotion({
        netDefectsCaught: challengerAgg.netDefectsCaught,
        slippedDelta: defectCaughtDelta,
        falsePositiveRate: challengerAgg.falsePositives === 0
            ? 0
            : challengerAgg.falsePositives /
                Math.max(1, challenger.filter((r) => !r.latentDefect).length),
        costScoreDelta,
        gate: options.gate,
    });
    return {
        baseline: baselineAgg,
        challenger: challengerAgg,
        cases: challenger,
        defectCaughtDelta,
        slippedDelta: defectCaughtDelta,
        falsePositiveCount: challengerAgg.falsePositives,
        tokenDeltaRatio,
        latencyDeltaRatio,
        costScoreDelta,
        decision,
    };
}
/** The review promotion gate. Encodes: promote only if the isolation-safe
 *  Reviewer catches ≥ `minimumNetDefectsCaught` latent defects net of noise,
 *  keeps the false-positive rate under `maxFalsePositiveRate`, and does not
 *  tank the cost score. A Reviewer that only adds tokens/latency without
 *  catching real defects is never promoted. */
export function decideReviewPromotion(input) {
    const minimumNetDefectsCaught = input.gate?.minimumNetDefectsCaught ?? 1;
    const maxFalsePositiveRate = input.gate?.maxFalsePositiveRate ?? 0.3;
    if (input.netDefectsCaught < minimumNetDefectsCaught) {
        return {
            promote: false,
            code: "no_defect_value",
            reason: `rejected: reviewer caught only ${input.netDefectsCaught} net defects (need >= ${minimumNetDefectsCaught}); a token/latency-only review is not promotable`,
            minimumNetDefectsCaught,
            maxFalsePositiveRate,
        };
    }
    if (input.falsePositiveRate > maxFalsePositiveRate) {
        return {
            promote: false,
            code: "too_noisy",
            reason: `rejected: reviewer false-positive rate ${round(input.falsePositiveRate, 3)} exceeds tolerance ${maxFalsePositiveRate}`,
            minimumNetDefectsCaught,
            maxFalsePositiveRate,
        };
    }
    if (input.costScoreDelta <= 0) {
        return {
            promote: false,
            code: "cost_negative",
            reason: `rejected: cost-score delta ${round(input.costScoreDelta)} is not positive, so added review cost ate the value`,
            minimumNetDefectsCaught,
            maxFalsePositiveRate,
        };
    }
    return {
        promote: true,
        code: "promote",
        reason: `promote: reviewer caught ${input.netDefectsCaught} net defects (≥ ${minimumNetDefectsCaught}), false-positive ${round(input.falsePositiveRate, 3)} (≤ ${maxFalsePositiveRate}), cost score +${round(input.costScoreDelta)}`,
        minimumNetDefectsCaught,
        maxFalsePositiveRate,
    };
}
/** Render the experiment as plain text for CLI output. */
export function renderReviewComparison(cmp) {
    const lines = [
        "Review Agent Experiment",
        `cases: ${cmp.cases.length}`,
        `decision: ${cmp.decision.promote ? "PROMOTE" : "REJECT"} (${cmp.decision.code})`,
        cmp.decision.reason,
        "",
        `  latent defects caught rate  ${round(cmp.baseline.defectCaughtRate, 3)} → ${round(cmp.challenger.defectCaughtRate, 3)}`,
        `  slipped defects             ${cmp.baseline.slippedDefects} → ${cmp.challenger.slippedDefects}  (Δ ${cmp.slippedDelta})`,
        `  false positives             ${cmp.falsePositiveCount}`,
        `  tokens                      ${cmp.baseline.totalTokens} → ${cmp.challenger.totalTokens}  (Δ ${round(cmp.tokenDeltaRatio * 100, 1)}%)`,
        `  latency (ms)                ${cmp.baseline.totalDurationMs} → ${cmp.challenger.totalDurationMs}  (Δ ${round(cmp.latencyDeltaRatio * 100, 1)}%)`,
        `  cost score                  ${cmp.baseline.costScore.toFixed(3)} → ${cmp.challenger.costScore.toFixed(3)}  (Δ ${round(cmp.costScoreDelta, 3)})`,
    ];
    return lines.join("\n");
}
function toolName(event) {
    return toolNameOfPayload(event.payload) ?? "<unknown>";
}
function pathOf(event) {
    const args = event.payload.args;
    if (typeof args !== "object" || args === null)
        return undefined;
    const record = args;
    const path = record.path ?? record.file;
    return typeof path === "string" ? path : undefined;
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=review-experiment.js.map