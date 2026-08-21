/** Simple deterministic score mirroring the cost model's shape without a full
 *  metrics object (kept permissive in tokens when context is dropped). */
function assess(name, runs) {
    const totalTokens = runs.reduce((s, r) => s + r.tokens, 0);
    const criticalDrops = runs.filter((r) => r.droppedContext).length;
    const passed = runs.filter((r) => r.passed && !r.droppedContext).length;
    const passRate = runs.length === 0 ? 0 : passed / runs.length;
    // Cost score: quality(correct, no overflow) * 100, penalised by tokens.
    const eff = runs.length === 0 ? 0 : passed / runs.length;
    const tokenFactor = totalTokens > 0 ? Math.min(1, 32_000 / totalTokens) : 1;
    const costScore = Math.round(eff * 100 * (0.8 + 0.2 * tokenFactor));
    return { name, costScore, passRate, totalTokens, criticalDrops };
}
/** Enforce the no-critical-context-drop invariant. Aggregate per-policy runs and
 *  pick the best cost-adjusted policy that beats the champion without dropping
 *  critical context. */
export function chooseBestContextPolicy(champion, candidates, opts = {}) {
    const minLift = opts.minCostLift ?? 1;
    const maxCriticalDrops = opts.maxCriticalDrops ?? 0;
    const reasons = [];
    const eligible = candidates.filter((c) => c.criticalDrops <= maxCriticalDrops && c.costScore - champion.costScore >= minLift);
    reasons.push(`policies kept: ${eligible.map((e) => e.name).join(", ") || "none"}` +
        (eligible.length !== candidates.length ? " (unsafe/blowing-context policies excluded)" : ""));
    if (eligible.length === 0) {
        reasons.push("no context policy safely beats the champion; champion kept");
        return { promotedName: null, keepChampion: true, reasons };
    }
    // Cost-adjusted best; ties broken by pass rate then fewer tokens.
    let best = eligible[0];
    for (const c of eligible.slice(1)) {
        if (c.costScore > best.costScore)
            best = c;
        else if (c.costScore === best.costScore && c.passRate > best.passRate)
            best = c;
        else if (c.costScore === best.costScore && c.passRate === best.passRate && c.totalTokens < best.totalTokens)
            best = c;
    }
    reasons.push(`promoted context policy: ${best.name}`);
    return { promotedName: best.name, keepChampion: false, reasons };
}
/** Score one context-policy run from raw metrics + whether it dropped context. */
export function runPolicyEffects(metricsByKey, passed) {
    return metricsByKey.map((m, i) => ({
        passed: passed[i] ?? false,
        tokens: m.tokens,
        droppedContext: m.droppedContext,
    }));
}
/** Adapt a RunMetrics into the compact per-run shape used for policy scoring. */
export function fromRunMetrics(m, droppedContext) {
    return {
        passed: m.verification_failures === 0 && !droppedContext,
        tokens: m.tokens_input + m.tokens_output,
        droppedContext,
    };
}
export function renderContextDecision(assessments, decision) {
    const lines = ["Context Policy Learning", `promoted: ${decision.promotedName ?? "champion kept"}`];
    for (const a of assessments) {
        lines.push(`  ${a.name}  pass=${round(a.passRate, 3)}  cost=${round(a.costScore, 1)}  drops=${a.criticalDrops}`);
    }
    lines.push(`  reasons  ${decision.reasons.join("; ")}`);
    return lines.join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=context-policy.js.map