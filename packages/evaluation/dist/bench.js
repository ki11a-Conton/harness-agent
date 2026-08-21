/**
 * Head-to-head comparison benchmark (§133): run the same eval cases through
 * two harness implementations (or the same harness twice) and compare
 * outcome quality, never a single collapsed score (§149).
 */
export class BenchRunner {
    /**
     * Runs every case through both harnesses and compares the outcomes.
     *
     * The same `EvalCase` instance is handed to both runs, so "same model,
     * same task, same environment, different harness" (§133) is the caller's
     * contract to arrange. Cases run sequentially so the report order always
     * matches the input order.
     *
     * A throwing harness run rejects the whole comparison — no fabricated
     * outcome is produced; harness crashes surface as `EvalOutcome` with
     * `status: "error"` instead (the runner.ts convention).
     */
    async runCompare(deps) {
        const { cases, runA, runB } = deps;
        const entries = [];
        for (const caseDef of cases) {
            const resultA = await runA(caseDef);
            const resultB = await runB(caseDef);
            entries.push({
                caseId: caseDef.id,
                resultA,
                resultB,
                winner: determineWinner(resultA, resultB),
            });
        }
        return {
            cases: entries,
            summary: {
                a: totalsOf(entries.map((entry) => entry.resultA)),
                b: totalsOf(entries.map((entry) => entry.resultB)),
            },
        };
    }
}
const STATUS_RANK = {
    passed: 2,
    failed: 1,
    error: 0,
};
/**
 * Winner determination: status first (passed > failed > error), then fewer
 * violations, then tie — two failed runs with equal violations are reported
 * as "both_failed", everything else equal as "tie".
 */
function determineWinner(a, b) {
    if (STATUS_RANK[a.status] > STATUS_RANK[b.status])
        return "A";
    if (STATUS_RANK[b.status] > STATUS_RANK[a.status])
        return "B";
    if (a.violations.length < b.violations.length)
        return "A";
    if (b.violations.length < a.violations.length)
        return "B";
    return a.status === "failed" ? "both_failed" : "tie";
}
function totalsOf(outcomes) {
    let success = 0;
    let safety = 0;
    let reliability = 0;
    let toolCalls = 0;
    let duration = 0;
    let cost = 0;
    for (const outcome of outcomes) {
        if (outcome.status === "passed")
            success += 1;
        if (outcome.violations.length === 0)
            safety += 1;
        if (outcome.status !== "error")
            reliability += 1;
        toolCalls += outcome.metrics?.tool_call_count ?? 0;
        duration += outcome.metrics?.duration_ms ?? 0;
        cost += outcome.metrics?.estimated_cost ?? 0;
    }
    const count = outcomes.length;
    return {
        success,
        safety,
        reliability,
        efficiency: count === 0 ? 0 : toolCalls / count,
        latency: count === 0 ? 0 : duration / count,
        cost,
    };
}
//# sourceMappingURL=bench.js.map