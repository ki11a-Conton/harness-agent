/**
 * P2-10: Automated Regression Attribution.
 *
 * When a challenger regresses (its metrics fall behind the baseline), a bare
 * "passRate 83% → 80%" is not actionable. This module reduces a case's event
 * trail into a per-dimension signal summary (model retries, tool retries,
 * compactions, verification failures, permission/security failures, context
 * overflow, latency, tokens, false completion, subagent failures), then
 * compares baseline vs challenger to name the likely regression source with
 * concrete event evidence.
 *
 * It is deliberately a pure function of event streams — the same traffic the
 * runner already judges on — so it never depends on model wording and never
 * fabricates a source that has no supporting counters.
 */
/** All regression signal dimensions we can attribute. Each maps to a counter. */
export const REGRESSION_DIMENSIONS = [
    "model_retries",
    "tool_retries",
    "compactions",
    "verification_failures",
    "permission_failures",
    "security_failures",
    "context_overflow",
    "latency_ms",
    "tokens",
    "false_complete",
    "subagent_failures",
];
const TALLY_ZERO = {
    model_retries: 0,
    tool_retries: 0,
    compactions: 0,
    verification_failures: 0,
    permission_failures: 0,
    security_failures: 0,
    context_overflow: 0,
    latency_ms: 0,
    tokens: 0,
    false_complete: 0,
    subagent_failures: 0,
};
/** Count of the same tool call started more than once (an internal retry). */
function countToolRetries(events) {
    const startedByCall = new Map();
    for (const event of events) {
        if (event.type !== "tool.started")
            continue;
        const id = event.payload.toolCallId;
        if (typeof id === "string")
            startedByCall.set(id, (startedByCall.get(id) ?? 0) + 1);
    }
    let retries = 0;
    for (const count of startedByCall.values())
        if (count > 1)
            retries += count - 1;
    return retries;
}
function sumNumber(events, type, key) {
    let total = 0;
    for (const event of events) {
        if (event.type !== type)
            continue;
        const value = event.payload[key];
        if (typeof value === "number" && Number.isFinite(value))
            total += value;
    }
    return total;
}
/** Reduce one case's event trail into per-dimension tallies. */
export function tallyEvents(events) {
    const model_retries = events.filter((e) => e.type === "model.retry" || e.type === "retry.provider" || e.type === "retry.stallRecovery").length;
    const compactions = events.filter((e) => e.type === "context.compacted").length;
    const verification_failures = events.filter((e) => e.type === "verification.failed" || (e.type === "verification.completed" && e.payload.passed === false)).length;
    const permission_failures = events.filter((e) => e.type === "security.permission_denied" ||
        e.type === "security.approval_denied" ||
        e.type === "approval.resolved" && e.payload.decision === "deny").length;
    const security_failures = events.filter((e) => e.type.startsWith("security.")).length;
    const context_overflow = events.filter((e) => e.type === "run.limit_reached" && (e.payload.limit === "context" || e.payload.limit === "maxTokens")).length + events.filter((e) => e.type === "context.compacted" && e.payload.overflow === true).length;
    const false_complete = events.filter((e) => e.type === "turn.completed" && (e.payload.falseComplete === true || e.payload.spurious === true)).length;
    return {
        model_retries,
        tool_retries: countToolRetries(events),
        compactions,
        verification_failures,
        permission_failures,
        security_failures,
        context_overflow,
        latency_ms: sumNumber(events, "model.completed", "durationMs"),
        tokens: sumNumber(events, "model.completed", "outputTokens") +
            sumNumber(events, "model.delta", "outputTokens"),
        false_complete,
        subagent_failures: events.filter((e) => e.type === "subagent.failed").length,
    };
}
/**
 * Compare per-case tallies. `baselineCases`/`challengerCases` may each contain
 * repeated tallies (one per benchmark case). The primary source is the
 * dimension with the largest challenger-minus-baseline delta margin across
 * the summed tallies; affectedCases are the case labels where the challenger
 * exceeded the baseline on that dimension.
 */
export function attributeRegression(baselineCases, challengerCases) {
    const sum = (cases) => {
        const acc = { ...TALLY_ZERO };
        for (const { tally } of cases) {
            acc.model_retries += tally.model_retries;
            acc.tool_retries += tally.tool_retries;
            acc.compactions += tally.compactions;
            acc.verification_failures += tally.verification_failures;
            acc.permission_failures += tally.permission_failures;
            acc.security_failures += tally.security_failures;
            acc.context_overflow += tally.context_overflow;
            acc.latency_ms += tally.latency_ms;
            acc.tokens += tally.tokens;
            acc.false_complete += tally.false_complete;
            acc.subagent_failures += tally.subagent_failures;
        }
        return acc;
    };
    const base = sum(baselineCases);
    const chall = sum(challengerCases);
    const contributors = [];
    // Human-readable counts alongside the raw numeric counters (latency/tokens
    // are magnitudes, not counts — evidence uses the totals).
    const evidenceOf = (dim, baselineValue, challengerValue) => [
        [`${dim}: ${baselineValue}`],
        [`${dim}: ${challengerValue}`],
    ];
    for (const dim of REGRESSION_DIMENSIONS) {
        const b = base[dim];
        const c = chall[dim];
        if (c > b) {
            contributors.push({
                dimension: dim,
                baseline: b,
                challenger: c,
                delta: c - b,
                evidence: evidenceOf(dim, b, c),
            });
        }
    }
    contributors.sort((x, y) => y.delta - x.delta);
    const primary = contributors[0];
    const affectedCases = [];
    if (primary !== undefined) {
        const dim = primary.dimension;
        const perCase = new Map();
        for (const { caseId, tally } of baselineCases) {
            perCase.set(caseId, (perCase.get(caseId) ?? 0) - tally[dim]);
        }
        for (const { caseId, tally } of challengerCases) {
            perCase.set(caseId, (perCase.get(caseId) ?? 0) + tally[dim]);
        }
        for (const [caseId, net] of perCase) {
            if (net > 0)
                affectedCases.push(caseId);
        }
        affectedCases.sort();
    }
    return {
        likelySource: primary?.dimension ?? "",
        regressed: primary !== undefined,
        contributors,
        affectedCases,
    };
}
/** Deterministic tally of an empty stream — used to keep the contract honest. */
export function zeroTally() {
    return { ...TALLY_ZERO };
}
//# sourceMappingURL=attribution.js.map