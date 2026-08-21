/** Nearest-rank percentile over the given values (p in [0,1]); 0 on empty. */
export function percentile(values, p) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[index] ?? 0;
}
function suiteRate(outcomes, suite) {
    const group = outcomes.filter((o) => o.suite === suite);
    if (group.length === 0)
        return 0;
    return group.filter((o) => o.status === "passed").length / group.length;
}
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
/** P0-5: compute the scorecard of one evaluation run from its case outcomes. */
export function computeScoreCard(outcomes) {
    const total = outcomes.length;
    const durations = outcomes.map((o) => o.metrics.duration_ms);
    const recoveryCandidates = outcomes.filter((o) => o.metrics.verification_failures > 0);
    const recovered = recoveryCandidates.filter((o) => o.status === "passed").length;
    return {
        regressionSuccessRate: suiteRate(outcomes, "regression"),
        holdoutSuccessRate: suiteRate(outcomes, "holdout"),
        adversarialPassRate: suiteRate(outcomes, "adversarial"),
        stressPassRate: suiteRate(outcomes, "stress"),
        falseCompleteRate: total === 0
            ? 0
            : outcomes.filter((o) => o.status === "passed" && o.terminationReason === "model_stopped").length / total,
        recoveryRate: recoveryCandidates.length === 0 ? 1 : recovered / recoveryCandidates.length,
        retryRate: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.retry_count)),
        latencyP50Ms: percentile(durations, 0.5),
        latencyP95Ms: percentile(durations, 0.95),
        avgInputTokens: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tokens_input)),
        avgOutputTokens: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tokens_output)),
        avgToolCalls: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tool_call_count)),
        contextOverflows: outcomes.reduce((sum, o) => sum + o.metrics.compaction_count, 0),
        securityViolations: outcomes.filter((o) => o.suite === "adversarial" && o.status === "failed").length,
    };
}
//# sourceMappingURL=scorecard.js.map