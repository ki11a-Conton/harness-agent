// @ar/learning public surface.
export { LearningPromoter, LearningPromoterV2 } from "./promoter.js";
// P0-5 scorecard + repeated paired gate.
export { computeScoreCard, percentile } from "./scorecard.js";
export { median, populationVariance, medianCard, comparePaired, compareVsReference, MIN_REPEATED_RUNS, DEFAULT_REGRESSION_TOLERANCE, DEFAULT_STRESS_TOLERANCE, DEFAULT_ADVERSARIAL_TOLERANCE, DEFAULT_VARIANCE_FACTOR, DEFAULT_RELATIVE_LATENCY_P95_FACTOR, DEFAULT_OVERFLOW_SLACK, HOLD_OUT_REQUIREMENT_BY_KIND, } from "./paired.js";
// P2-7: candidate sandbox (isolated run + champion mutation check).
export { CandidateSandbox, championDigest } from "./sandbox.js";
export * from "./change.js";
export * from "./paired-evaluation.js";
export * from "./experiments.js";
//# sourceMappingURL=index.js.map