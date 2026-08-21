import { attributeRegression, tallyEvents } from "./attribution.js";
/** Re-run the evaluator over a recorded corpus with a judge, offline. */
export function replayEvaluator(records, judge, score = scorePass) {
    const passed = records.filter((r) => judge(r.outcome)).length;
    return score(records, passed);
}
function scorePass(records, passed) {
    const totalTokens = records.reduce((s, r) => s + r.outcome.metrics.tokens_input + r.outcome.metrics.tokens_output, 0);
    return {
        passRate: records.length === 0 ? 0 : passed / records.length,
        passed,
        failed: records.length - passed,
        totalTokens,
    };
}
/** Differentially test a new judge against the current verdicts offline. */
export function testNewJudge(records, currentVerdicts, newJudge) {
    const changedCases = [];
    const newFailures = [];
    let currentPass = 0;
    let newPass = 0;
    for (const r of records) {
        const cur = currentVerdicts(r.outcome);
        const neu = newJudge(r.outcome);
        if (cur)
            currentPass++;
        if (neu)
            newPass++;
        if (cur !== neu)
            changedCases.push(r.caseId);
        if (cur && !neu)
            newFailures.push(r.caseId);
    }
    return {
        changedCases,
        newFailures,
        currentPassRate: records.length === 0 ? 0 : currentPass / records.length,
        newPassRate: records.length === 0 ? 0 : newPass / records.length,
    };
}
/** Apply a memory ranker to a recorded retrieval; hit = the relevant item is
 *  retrieved within top-k. Deterministic, no model calls. */
export function replayMemoryRanker(retrievals, ranker, topK) {
    return retrievals.map((rec) => {
        const retrieved = ranker(rec.candidates, topK);
        return {
            caseId: rec.caseId,
            retrieved,
            topK,
            hit: retrieved.includes(rec.relevantId),
        };
    });
}
export function rankerHitRate(results) {
    if (results.length === 0)
        return 0;
    return results.filter((r) => r.hit).length / results.length;
}
/** Re-run regression attribution over recorded event traces, offline. */
export function replayAttribution(input) {
    const tally = (cix) => cix.map((c) => ({ caseId: c.caseId, tally: tallyEvents(c.events) }));
    return attributeRegression(tally(input.baseline), tally(input.challenger));
}
//# sourceMappingURL=offline-replay.js.map