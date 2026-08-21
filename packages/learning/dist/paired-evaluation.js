import { comparePaired } from "./paired.js";
function cardFrom(runs) {
    const passed = runs.filter((r) => r.success).length;
    const total = runs.length;
    const latency = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p95 = latency[Math.min(Math.floor(latency.length * 0.95), latency.length - 1)] ?? 0;
    return {
        regressionSuccessRate: total > 0 ? passed / total : 0,
        holdoutSuccessRate: 0,
        adversarialPassRate: total > 0 ? passed / total : 0,
        stressPassRate: 0,
        falseCompleteRate: 0,
        recoveryRate: 1,
        retryRate: 0,
        latencyP50Ms: latency[Math.floor(latency.length * 0.5)] ?? 0,
        latencyP95Ms: p95,
        avgInputTokens: total > 0 ? runs.reduce((s, r) => s + r.inputTokens, 0) / total : 0,
        avgOutputTokens: total > 0 ? runs.reduce((s, r) => s + r.outputTokens, 0) / total : 0,
        avgToolCalls: total > 0 ? runs.reduce((s, r) => s + r.toolCalls, 0) / total : 0,
        contextOverflows: 0,
        securityViolations: runs.reduce((s, r) => s + r.securityViolations, 0),
    };
}
/** Run the same cases N times per side and compare through the gate. */
export async function runPairedBenchmark(input) {
    const repeats = input.repeats ?? 2;
    const championRuns = [];
    const challengerRuns = [];
    for (let i = 0; i < repeats; i++) {
        const championCards = [];
        const challengerCards = [];
        for (const caseId of input.cases) {
            championCards.push(cardFrom([await input.champion.run(caseId)]));
            challengerCards.push(cardFrom([await input.challenger.run(caseId)]));
        }
        // Aggregate the repeat's per-case cards by the comparison's expectation:
        // comparePaired expects ONE card per repeat (a run summary), so fold.
        championRuns.push(foldCards(championCards));
        challengerRuns.push(foldCards(challengerCards));
    }
    const report = comparePaired(championRuns, challengerRuns, input.options);
    return {
        report,
        championHashes: championRuns.map(() => input.champion.configHash),
        challengerHashes: challengerRuns.map(() => input.challenger.configHash),
    };
}
function foldCards(cards) {
    const n = cards.length;
    const sum = (pick) => cards.reduce((s, c) => s + pick(c), 0);
    return {
        regressionSuccessRate: sum((c) => c.regressionSuccessRate) / n,
        holdoutSuccessRate: sum((c) => c.holdoutSuccessRate) / n,
        adversarialPassRate: sum((c) => c.adversarialPassRate) / n,
        stressPassRate: sum((c) => c.stressPassRate) / n,
        falseCompleteRate: sum((c) => c.falseCompleteRate) / n,
        recoveryRate: sum((c) => c.recoveryRate) / n,
        retryRate: sum((c) => c.retryRate) / n,
        latencyP50Ms: sum((c) => c.latencyP50Ms) / n,
        latencyP95Ms: sum((c) => c.latencyP95Ms) / n,
        avgInputTokens: sum((c) => c.avgInputTokens) / n,
        avgOutputTokens: sum((c) => c.avgOutputTokens) / n,
        avgToolCalls: sum((c) => c.avgToolCalls) / n,
        contextOverflows: sum((c) => c.contextOverflows) / n,
        securityViolations: sum((c) => c.securityViolations) / n,
    };
}
/**
 * P10-4: regression attribution for a candidate report — where the challenger
 * improved and where it regressed, plus cost deltas. Feeds the candidate
 * report automatically.
 */
export function buildAttributionReport(report, candidate) {
    const improved = [];
    const regressed = [];
    for (const metric of report.perMetric) {
        if (metric.challengerMedian > metric.championMedian) {
            improved.push(`${metric.metric} (${metric.championMedian} → ${metric.challengerMedian})`);
        }
        else if (metric.challengerMedian < metric.championMedian) {
            regressed.push(`${metric.metric} (${metric.championMedian} → ${metric.challengerMedian})`);
        }
    }
    const summary = `candidate ${candidate.id}: overall=${report.overall}; ` +
        `improved=${improved.length > 0 ? improved.join("; ") : "none"}; ` +
        `regressed=${regressed.length > 0 ? regressed.join("; ") : "none"}`;
    return { candidateId: candidate.id, improved, regressed, summary };
}
//# sourceMappingURL=paired-evaluation.js.map