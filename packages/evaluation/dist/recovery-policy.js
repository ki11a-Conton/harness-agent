/** Deterministic cost-adjusted score: pass-rate quality minus retry/token drag.
 *  A policy that brute-forces success with retries scores low. */
export function recoveryCostScore(passRate, retries, tokens) {
    const retryDrag = Math.min(1, retries / 4);
    const tokenDrag = tokens > 0 ? Math.min(1, tokens / 32_000) : 0;
    return Math.max(0, Math.round(passRate * 100 - retryDrag * 25 - tokenDrag * 15));
}
/** Choose the best recovery policy. The cost gate is mandatory: only a policy
 *  that beats the champion's cost-adjusted score (quality per retry/token) is
 *  promoted; a retry-inflating policy is rejected even at a higher pass rate. */
export function chooseBestRecoveryPolicy(champion, candidates, opts = {}) {
    const minLift = opts.minCostLift ?? 1;
    const maxRetryMult = opts.maxRetryMultiplier ?? 3;
    const reasons = [];
    const eligible = [];
    for (const c of candidates) {
        if (champion.totalRetries > 0 && c.totalRetries > champion.totalRetries * maxRetryMult) {
            reasons.push(`${c.policyName} brute-forces success: ${c.totalRetries} retries > ${maxRetryMult}x champion`);
            continue;
        }
        if (c.costScore - champion.costScore < minLift) {
            reasons.push(`${c.policyName} fails the cost gate (score ${c.costScore} vs champion ${champion.costScore})`);
            continue;
        }
        eligible.push(c);
    }
    if (eligible.length === 0) {
        reasons.push("no recovery policy clears the cost gate; champion kept");
        return { promotedName: null, keepChampion: true, reasons };
    }
    let best = eligible[0];
    for (const c of eligible.slice(1)) {
        if (c.costScore > best.costScore)
            best = c;
        else if (c.costScore === best.costScore && c.totalRetries < best.totalRetries)
            best = c;
    }
    reasons.push(`promoted cost-gated recovery policy: ${best.policyName}`);
    return { promotedName: best.policyName, keepChampion: false, reasons };
}
/** Adapt raw per-run metrics into a recovery outcome for one policy. */
export function fromRecoveryRuns(policyName, runs, resolve) {
    const passed = runs.filter((r) => resolve(r).passed).length;
    const totalRetries = runs.reduce((s, r) => s + r.metrics.retry_count, 0);
    const totalTokens = runs.reduce((s, r) => s + r.metrics.tokens_input + r.metrics.tokens_output, 0);
    const passRate = runs.length === 0 ? 0 : passed / runs.length;
    return { policyName, passRate, totalRetries, totalTokens, costScore: recoveryCostScore(passRate, totalRetries, totalTokens) };
}
export function renderRecoveryDecision(outcomes, decision) {
    const lines = ["Recovery Policy Learning", `promoted: ${decision.promotedName ?? "champion kept"}`];
    for (const o of outcomes) {
        lines.push(`  ${o.policyName}  pass=${round(o.passRate, 3)}  retries=${o.totalRetries}  cost=${round(o.costScore, 1)}`);
    }
    lines.push(`  reasons  ${decision.reasons.join("; ")}`);
    return lines.join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=recovery-policy.js.map