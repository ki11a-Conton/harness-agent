import { scoreCost } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";
// ---------------------- Security scan --------------------------------------
/** Prompt-injection markers that must never appear in an injected directive. */
const INJECTION_MARKERS = [
    "ignore previous instructions",
    "ignore all prior instructions",
    "you are now",
    "system prompt says",
    "do anything the user asks",
    "disregard earlier rules",
];
/** Secret-looking patterns that must never be injected. */
const SECRET_PATTERNS = [
    /sk-[a-zA-Z0-9]{12,}/,
    /AKIA[0-9A-Z]{16}/,
    /password\s*[:=]\s*\S+/i,
    /secret\s*[:=]\s*\S+/i,
    /Bearer\s+[A-Za-z0-9._-]{20,}/,
];
/** Phrasings that instruct skipping a safety / verification barrier. */
const SAFETY_STRIP_MARKERS = [
    "skip verification",
    "bypass verification",
    "ignore permission",
    "don't verify",
    "no verification",
    "skip permission",
];
/** True when a directive equals or embeds an entire reflection body verbatim.
 *  This is the P3-7 hard invariant: reflection text must never be appended as-is. */
export function isVerbatimReflectionAppend(directive, reflections) {
    const needle = directive.trim();
    return reflections.some((r) => {
        const body = r.trim();
        return body !== "" && (needle === body || needle.includes(body) || body.includes(needle));
    });
}
/** Fail-closed security scan for a distilled rule. A passing scan is required
 *  for promotion; a failing scan can never be applied. */
export function assertPromptRuleSecurity(directive, reflections) {
    const lower = directive.toLowerCase();
    for (const marker of INJECTION_MARKERS) {
        if (lower.includes(marker)) {
            return { ok: false, reason: `prompt-injection marker: "${marker}"` };
        }
    }
    for (const pat of SECRET_PATTERNS) {
        if (pat.test(directive)) {
            return { ok: false, reason: "secret-like string in directive" };
        }
    }
    for (const marker of SAFETY_STRIP_MARKERS) {
        if (lower.includes(marker)) {
            return { ok: false, reason: `safety-strip phrasing: "${marker}"` };
        }
    }
    // The P3-7 hard invariant: never append reflection text verbatim.
    if (isVerbatimReflectionAppend(directive, reflections)) {
        return { ok: false, reason: "directive is a verbatim reflection append (not distilled)" };
    }
    return { ok: true };
}
// ---------------------- Scope matching -------------------------------------
/** True when a scope string matches a case. Empty matches anything. */
export function promptScopeMatches(scope, caseScope) {
    return scope === "" || caseScope === "" || scope === caseScope;
}
// ---------------------- Learning (distillation) ----------------------------
/** Extract observable reflection-like signals from a run: the structured
 *  termination reason plus any reflection.* events. Kept small and explicit. */
export function extractReflections(run) {
    const out = [];
    if (typeof run.reason === "string" && run.reason.trim() !== "")
        out.push(run.reason);
    for (const event of run.events) {
        if (event.type.startsWith("reflection.")) {
            const text = event.payload?.directive ?? event.payload?.rule ?? event.payload?.text ?? event.payload?.content;
            if (typeof text === "string" && text.trim() !== "")
                out.push(text);
        }
    }
    return out;
}
export const PROMPT_RULE_DISTILL_FRAGMENTS = [
    "verify changes before completing",
    "read the target file before editing it",
    "confirm scope before mutating",
];
/**
 * Distill a prompt rule from reflection signals within a scope. The resulting
 * `directive` is a fresh, safe composition — never a verbatim reflection body
 * (the security scan re-checks this). Evidence must exceed `minSamples`; too
 * little evidence produces no rule (a single reflection never stamps behavior).
 */
export function distillPromptRule(scopedRuns, scope, opts = {}) {
    const minSamples = opts.minSamples ?? 3;
    const fragments = opts.fragments ?? PROMPT_RULE_DISTILL_FRAGMENTS;
    let reflections;
    let evidenceSamples;
    if (Array.isArray(scopedRuns)) {
        const rs = [];
        for (const run of scopedRuns)
            rs.push(...extractReflections(run));
        reflections = rs;
        evidenceSamples = scopedRuns.length;
    }
    else {
        reflections = scopedRuns.reflections;
        evidenceSamples = scopedRuns.count;
    }
    if (evidenceSamples < minSamples)
        return undefined; // too thin
    if (reflections.length === 0)
        return undefined;
    // Fresh composition selected deterministically from fragments. This is the
    // distilled directive — never copied from a reflection body.
    const directive = fragments[0] ?? "follow the verified procedure";
    const scan = assertPromptRuleSecurity(directive, reflections);
    if (!scan.ok)
        return undefined; // a rule that fails its own security scan is not produced
    return {
        id: `rule:${scope}`,
        directive,
        scope,
        status: "candidate",
        evidenceSamples,
        version: 1,
        securityOk: true,
        sourceReflectionId: `ref:${scope}`,
    };
}
// ---------------------- Lifecycle ------------------------------------------
/** Promotion gate: version + scope + evidence + security scan + benchmark. A
 *  rule becomes ACTIVE only when it is scoped, carries enough evidence, passed
 *  the security scan, and the benchmark shows a real lift without cost burnout. */
export function promotePromptRule(rule, delta, gate) {
    const minimumSamples = gate?.minimumSamples ?? 3;
    const minimumPassLift = gate?.minimumPassLift ?? 0;
    if (rule.status !== "candidate")
        return rule;
    if (rule.evidenceSamples < minimumSamples)
        return rule;
    if (!rule.securityOk || !delta.securityOk)
        return rule; // security scan fail-closed
    if (delta.passDelta < minimumPassLift)
        return rule;
    if (delta.costScoreDelta <= 0)
        return rule;
    return { ...rule, status: "active", version: rule.version + 1 };
}
/** Explicit, permanent rollback: active → rolled_back; no longer applies
 *  anywhere and is excluded from future promotion. */
export function rollbackPromptRule(rule) {
    if (rule.status !== "active")
        return rule;
    return { ...rule, status: "rolled_back", version: rule.version + 1 };
}
/** Applies only when ACTIVE and scope-matching. rolled_back/candidate never apply. */
export function shouldApplyPromptRule(rule, caseScope) {
    return rule.status === "active" && promptScopeMatches(rule.scope, caseScope);
}
export const DEFAULT_PROMPT_RULE_MODEL = {
    rulePassGain: 0.2,
    applicationReach: 1,
    ruleTokensPerCase: 120,
    faultVerbatimReflection: false,
    faultInjection: false,
};
export function simulatePromptRuleRun(outcome, policy, rules, caseScope, options = {}) {
    const model = { ...DEFAULT_PROMPT_RULE_MODEL, ...(options.model ?? {}) };
    const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 13);
    const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
    let passed = outcome.status === "passed";
    if (policy === "no_rules") {
        return {
            caseId: outcome.caseId,
            policy,
            appliedRule: false,
            securityFailed: false,
            passed,
            tokens,
            durationMs: outcome.metrics.duration_ms,
        };
    }
    const matching = rules.filter((r) => promptScopeMatches(r.scope, caseScope));
    const applicable = matching.filter((r) => (options.measureAsActive === true || r.status === "active") && r.securityOk);
    const applied = applicable.length > 0 && random() < model.applicationReach;
    // Security fail-closed: any fault that would let an unsafe rule through.
    const securityFailed = model.faultVerbatimReflection || model.faultInjection;
    if (securityFailed) {
        return {
            caseId: outcome.caseId,
            policy,
            appliedRule: true,
            securityFailed: true,
            passed: false,
            tokens: tokens + model.ruleTokensPerCase,
            durationMs: outcome.metrics.duration_ms + 200,
        };
    }
    if (applied && !passed && random() < model.rulePassGain) {
        passed = true;
    }
    return {
        caseId: outcome.caseId,
        policy,
        appliedRule: applied,
        securityFailed: false,
        passed,
        tokens: tokens + (applied ? model.ruleTokensPerCase : 0),
        durationMs: outcome.metrics.duration_ms + (applied ? 150 : 0),
    };
}
export function aggregatePromptRule(runs, cost) {
    const passed = runs.filter((r) => r.passed).length;
    const securityFailures = runs.filter((r) => r.securityFailed).length;
    const costResult = scoreCost({
        status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
        violations: securityFailures > 0 ? ["prompt_rule_security_failure"] : [],
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
        appliedCount: runs.filter((r) => r.appliedRule).length,
        securityFailures,
        costScore: costResult.score,
    };
}
/** End-to-end experiment: distill a rule from training reflections, security
 *  scan it, promote on a validation split (scope-aware, benchmark), then
 *  measure vs baseline on evaluation, honoring rollbacks. */
export async function runPromptRuleExperiment(trainingRuns, validation, evaluation, options = {}) {
    const scope = options.scope ?? "debugging";
    const seed = options.seed ?? 7;
    // 1. LEARN (candidate): distill + security scan.
    const learned = distillPromptRule(trainingRuns, scope, {
        minSamples: options.gate?.minimumSamples ?? 3,
    });
    if (learned === undefined) {
        throw new Error("no prompt rule learned: evidence too thin or failed security scan");
    }
    // 2. PROMOTE on the validation split (benchmark promoted, scope-aware).
    const vBaseline = [];
    const vChallenger = [];
    for (const c of validation.cases) {
        const outcome = await validation.runWorker(c);
        const s = validation.scopeOf(c);
        vBaseline.push(simulatePromptRuleRun(outcome, "no_rules", [], s, { model: options.model, seed }));
        vChallenger.push(simulatePromptRuleRun(outcome, "learned_rules", [learned], s, {
            model: options.model,
            seed,
            measureAsActive: true,
        }));
    }
    const vBaseAgg = aggregatePromptRule(vBaseline, options.cost);
    const vChallAgg = aggregatePromptRule(vChallenger, options.cost);
    const securityOk = vChallAgg.securityFailures === 0;
    let champion = promotePromptRule(learned, {
        passDelta: vChallAgg.passRate - vBaseAgg.passRate,
        costScoreDelta: vChallAgg.costScore - vBaseAgg.costScore,
        securityOk,
    }, options.gate);
    if (options.rollbackAfterPromote)
        champion = rollbackPromptRule(champion);
    // 3. MEASURE on the evaluation split.
    const base = [];
    const challenger = [];
    for (const c of evaluation.cases) {
        const outcome = await evaluation.runWorker(c);
        const s = evaluation.scopeOf(c);
        base.push(simulatePromptRuleRun(outcome, "no_rules", [], s, { model: options.model, seed }));
        challenger.push(simulatePromptRuleRun(outcome, "learned_rules", [champion], s, { model: options.model, seed }));
    }
    const baseAgg = aggregatePromptRule(base, options.cost);
    const challAgg = aggregatePromptRule(challenger, options.cost);
    return {
        baselinePassRate: baseAgg.passRate,
        challengerPassRate: challAgg.passRate,
        securityFailures: challAgg.securityFailures,
        activeCount: champion.status === "active" ? 1 : 0,
        appliedCount: challAgg.appliedCount,
        passDelta: challAgg.passRate - baseAgg.passRate,
        costScoreDelta: challAgg.costScore - baseAgg.costScore,
    };
}
export function renderPromptRuleComparison(cmp) {
    return [
        "Learned Prompt Rules Experiment",
        `decision: ${cmp.activeCount > 0 ? "ACTIVE (promoted)" : "NOT ACTIVE"}`,
        `  security failures          ${cmp.securityFailures}`,
        `  rules applied               ${cmp.appliedCount}`,
        `  pass rate                   ${round(cmp.baselinePassRate, 3)} → ${round(cmp.challengerPassRate, 3)}  (${cmp.activeCount > 0 ? (cmp.passDelta >= 0 ? "lift" : "reject") : "no-op"})`,
        `  cost score delta            ${round(cmp.costScoreDelta, 3)}`,
    ].join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=prompt-rules.js.map