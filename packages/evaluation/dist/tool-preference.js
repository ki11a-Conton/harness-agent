import { toolNameOf as toolNameOfPayload } from "@ar/contracts";
import { scoreCost } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";
/** Static tool safety table (reused concept from P3-4). */
const SAFETY_CRITICAL_TOOLS = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "search",
    "exec",
    "verification",
]);
/** True when a scope string matches a case. Empty scope matches anything. */
export function scopeMatches(scope, caseScope) {
    return scope === "" || caseScope === "" || scope === caseScope;
}
/** True when a preference would target a safety-critical tool. Such a
 *  preference must never be applied (a safety boundary cannot be re-weighted
 *  off). Safeguard mirrors the P3-4 safety-subset invariant. */
export function preferenceTargetsSafetyCritical(tool) {
    return SAFETY_CRITICAL_TOOLS.has(tool);
}
/**
 * Learn a candidate tool preference from a trace (already scoped). Counts how
 * often a tool was used in successful outcomes vs failed outcomes within the
 * trace; returns a preference proposal (still `candidate`) stamped with `scope`
 * plus its evidence size. Preferences resting on too few samples are dropped
 * (a single success must not stamp behavior).
 */
export function learnToolPreference(runs, scope, tool, opts = {}) {
    const minSamples = opts.minSamples ?? 3;
    const minSuccessFrac = opts.minSuccessFrac ?? 0.6;
    const inScope = runs; // trace is assumed pre-scoped to `scope`
    if (inScope.length === 0)
        return undefined;
    let usedCount = 0;
    let successWhenUsed = 0;
    for (const run of inScope) {
        const used = run.events.some(isToolUse(tool));
        if (!used)
            continue;
        usedCount += 1;
        if (run.status === "passed")
            successWhenUsed += 1;
    }
    // Too little evidence → no learning (single success must not stamp behavior).
    if (usedCount < minSamples)
        return undefined;
    const successFrac = successWhenUsed / usedCount;
    if (successFrac < minSuccessFrac)
        return undefined;
    return {
        id: `pref:${scope}:${tool}`,
        tool,
        scope,
        weight: 1 + successFrac, // prefer the tool proportionally to success rate
        status: "candidate",
        evidenceSamples: usedCount,
        version: 1,
    };
}
/** The promotion gate: only a benchmark-validated, sufficient-evidence
 *  preference that never strips a safety-critical tool becomes ACTIVE. */
export function promotePreference(preference, delta, gate) {
    const minimumSamples = gate?.minimumSamples ?? 3;
    const minimumPassLift = gate?.minimumPassLift ?? 0;
    if (preference.status !== "candidate")
        return preference;
    if (preference.evidenceSamples < minimumSamples)
        return preference; // no evidence → no promotion
    if (!delta.safetyIntact)
        return preference; // never promote a safety-stripping preference
    if (delta.passDelta < minimumPassLift)
        return preference; // must actually help in scope
    if (delta.costScoreDelta <= 0)
        return preference; // cost ate the value
    return { ...preference, status: "active", version: preference.version + 1 };
}
/** Explicit, permanent rollback: flips an active preference to rolled_back so
 *  it no longer applies anywhere and is excluded from future promotion. */
export function rollbackPreference(preference) {
    if (preference.status !== "active")
        return preference;
    return { ...preference, status: "rolled_back", version: preference.version + 1 };
}
/** Applies a preference to a scope only when it is ACTIVE and scope-matching.
 *  A rolled_back or candidate preference never applies. */
export function shouldApplyPreference(preference, caseScope) {
    return preference.status === "active" && scopeMatches(preference.scope, caseScope);
}
export const DEFAULT_PREFERENCE_MODEL = {
    preferencePassGain: 0.2,
    applicationReach: 1,
    preferenceTokensPerCase: 150,
    faultStripSafety: false,
};
export function simulatePreferenceRun(outcome, policy, preferences, caseScope, options = {}) {
    const model = {
        ...DEFAULT_PREFERENCE_MODEL,
        ...(options.model ?? {}),
    };
    const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 7);
    const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
    let passed = outcome.status === "passed";
    if (policy === "no_preferences") {
        return {
            caseId: outcome.caseId,
            policy,
            appliedPreference: false,
            strippedSafetyTool: false,
            passed,
            tokens,
            durationMs: outcome.metrics.duration_ms,
        };
    }
    // Which ACTIVE, scope-matching preferences apply here? During VALIDATION the
    // candidate is measured as-if-active (`measureAsActive`) solely to decide
    // promotion — the production apply path (shouldApplyPreference) still
    // requires `active`, and rolled_back/candidate never apply in runtime.
    const applicable = preferences.filter((p) => (options.measureAsActive === true || p.status === "active") &&
        scopeMatches(p.scope, caseScope));
    // Scope-aware: a preference outside this scope never counts.
    const applied = applicable.length > 0 && random() < model.applicationReach;
    let strippedSafetyTool = false;
    if (model.faultStripSafety) {
        // Fault injection: the preference would drop a safety-critical tool.
        strippedSafetyTool = true;
        // Safety guard: never allow — the run must fail-closed (no promotion).
        passed = false;
    }
    else if (applied && !passed && random() < model.preferencePassGain) {
        passed = true;
    }
    return {
        caseId: outcome.caseId,
        policy,
        appliedPreference: applied || strippedSafetyTool,
        strippedSafetyTool,
        passed,
        // Preference application costs a little extra ordering budget.
        tokens: tokens + (applied || strippedSafetyTool ? model.preferenceTokensPerCase : 0),
        durationMs: outcome.metrics.duration_ms + (applied || strippedSafetyTool ? 200 : 0),
    };
}
export function aggregatePreference(runs, cost) {
    const passed = runs.filter((r) => r.passed).length;
    const stripped = runs.filter((r) => r.strippedSafetyTool).length;
    const costResult = scoreCost({
        status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
        violations: stripped > 0 ? ["tool_preference_strip_safety"] : [],
        metrics: {
            turn_count: runs.length,
            tool_call_count: runs.reduce((s, r) => (r.passed ? 1 : 0) + s, 0),
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
        passRate: runs.length === 0 ? 0 : passed / runs.length,
        appliedCount: runs.filter((r) => r.appliedPreference).length,
        strippedCount: stripped,
        costScore: costResult.score,
    };
}
/** Run the end-to-end learned-tool-preference experiment: learn from a training
 *  trace, promote on a validation split (scope-aware), then measure the
 *  challenger vs baseline on the evaluation cases, honoring rollbacks. */
export async function runPreferenceExperiment(trainingTrace, validation, evaluation, options = {}) {
    const tool = options.tool ?? "read_file";
    const scope = options.scope ?? "coding";
    const seed = options.seed ?? 7;
    // 1. LEARN (candidate) from the training trace.
    const learned = learnToolPreference(trainingTrace, scope, tool, {
        minSamples: options.gate?.minimumSamples ?? 3,
    });
    if (learned === undefined) {
        throw new Error("no preference learned: trace lacks a statistically sound signal");
    }
    // 2. PROMOTE on the validation split (benchmark promoted, scope-aware).
    //    The candidate is measured as-if-active ONLY here to decide promotion.
    let vBaseline = [];
    let vChallenger = [];
    for (const c of validation.cases) {
        const outcome = await validation.runWorker(c);
        const s = validation.scopeOf(c);
        vBaseline.push(simulatePreferenceRun(outcome, "no_preferences", [], s, { model: options.model, seed }));
        vChallenger.push(simulatePreferenceRun(outcome, "learned_preferences", [learned], s, {
            model: options.model,
            seed,
            measureAsActive: true,
        }));
    }
    const vBaseAgg = aggregatePreference(vBaseline, options.cost);
    const vChallAgg = aggregatePreference(vChallenger, options.cost);
    // Safety must be intact on the validation split for promotion.
    const safetyIntact = vChallAgg.strippedCount === 0;
    let champion = promotePreference(learned, {
        passDelta: vChallAgg.passRate - vBaseAgg.passRate,
        costScoreDelta: vChallAgg.costScore - vBaseAgg.costScore,
        safetyIntact,
    }, options.gate);
    if (options.rollbackAfterPromote)
        champion = rollbackPreference(champion);
    // 3. MEASURE on the evaluation split.
    const base = [];
    const challenger = [];
    for (const c of evaluation.cases) {
        const outcome = await evaluation.runWorker(c);
        const s = evaluation.scopeOf(c);
        base.push(simulatePreferenceRun(outcome, "no_preferences", [], s, { model: options.model, seed }));
        challenger.push(simulatePreferenceRun(outcome, "learned_preferences", [champion], s, { model: options.model, seed }));
    }
    const baseAgg = aggregatePreference(base, options.cost);
    const challAgg = aggregatePreference(challenger, options.cost);
    return {
        baselinePassRate: baseAgg.passRate,
        challengerPassRate: challAgg.passRate,
        strippedCount: challAgg.strippedCount,
        activeCount: champion.status === "active" ? 1 : 0,
        appliedCount: challAgg.appliedCount,
        passDelta: challAgg.passRate - baseAgg.passRate,
        costScoreDelta: challAgg.costScore - baseAgg.costScore,
    };
}
function isToolUse(tool) {
    return (event) => {
        if (event.type !== "tool.completed" && event.type !== "tool.requested")
            return false;
        return toolNameOfPayload(event.payload) === tool;
    };
}
export function renderPreferenceComparison(cmp) {
    return [
        "Learned Tool Preference Experiment",
        `decision: ${cmp.activeCount > 0 ? "ACTIVE (promoted)" : "NOT ACTIVE"}`,
        `  stripped-safety faults     ${cmp.strippedCount}`,
        `  preferences applied         ${cmp.appliedCount}`,
        `  pass rate                   ${round(cmp.baselinePassRate, 3)} → ${round(cmp.challengerPassRate, 3)}  (${cmp.activeCount > 0 ? (cmp.passDelta >= 0 ? "lift" : "reject") : "no-op"})`,
        `  cost score delta            ${round(cmp.costScoreDelta, 3)}`,
    ].join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=tool-preference.js.map