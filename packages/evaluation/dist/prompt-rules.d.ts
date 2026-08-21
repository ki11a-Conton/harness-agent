import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-7 — Learned Prompt Rules experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A prompt rule
 * is a distilled, scoped directive that an agent could inject into its system
 * prompt. plan.md P3-7 requires every prompt candidate to carry:
 *
 *   version, scope, evidence, promotion benchmark, security scan, rollback
 *
 * The core hard invariant — and the point that separates P3-7 from a generic
 * "learn something and apply it" — is:
 *
 *   NEVER append reflection text verbatim to the system prompt.
 *
 * A rule that is a verbatim copy of (or contains) a reflection body is NOT a
 * distilled rule; it is a raw transcript piece. It must fail the security scan
 * and never be promoted or applied. Learning produces a *distilled directive*
 * (versioned / scoped / evidence-stamped), not raw text.
 *
 * Security scan (fail-closed, mirrors the production `securityCheck` in
 * packages/learning): a candidate that (a) is a verbatim reflection append,
 * (b) carries a prompt-injection marker, (c) leaks a secret-looking string, or
 * (d) instructs skipping a verification / permission barrier is REJECTED with
 * `ok:false`. Promotion and application require `ok:true`.
 *
 * As with the rest of P3, the challenger is a deterministic, seeded effect
 * model composed over measured outcomes — nothing is fabricated.
 */
export type PromptRuleStatus = "candidate" | "active" | "rolled_back";
/** A distilled, scoped, versioned prompt rule learned from reflection signals. */
export interface PromptRule {
    /** Unique id. */
    id: string;
    /** The distilled directive text (versioned). NEVER verbatim reflection text. */
    directive: string;
    /** Scope this rule applies to (e.g. "debugging"). Empty = broadest allowed. */
    scope: string;
    status: PromptRuleStatus;
    /** Reflection samples that supported distillation. */
    evidenceSamples: number;
    version: number;
    /** Result of the security scan at creation/distillation time. */
    securityOk: boolean;
    /** The reflection body that seeded this rule (provenance, never injected). */
    sourceReflectionId?: string;
}
/** True when a directive equals or embeds an entire reflection body verbatim.
 *  This is the P3-7 hard invariant: reflection text must never be appended as-is. */
export declare function isVerbatimReflectionAppend(directive: string, reflections: string[]): boolean;
export interface PromptRuleScanResult {
    ok: boolean;
    reason?: string;
}
/** Fail-closed security scan for a distilled rule. A passing scan is required
 *  for promotion; a failing scan can never be applied. */
export declare function assertPromptRuleSecurity(directive: string, reflections: string[]): PromptRuleScanResult;
/** True when a scope string matches a case. Empty matches anything. */
export declare function promptScopeMatches(scope: string, caseScope: string): boolean;
/** Extract observable reflection-like signals from a run: the structured
 *  termination reason plus any reflection.* events. Kept small and explicit. */
export declare function extractReflections(run: EvalOutcome): string[];
export declare const PROMPT_RULE_DISTILL_FRAGMENTS: readonly ["verify changes before completing", "read the target file before editing it", "confirm scope before mutating"];
/**
 * Distill a prompt rule from reflection signals within a scope. The resulting
 * `directive` is a fresh, safe composition — never a verbatim reflection body
 * (the security scan re-checks this). Evidence must exceed `minSamples`; too
 * little evidence produces no rule (a single reflection never stamps behavior).
 */
export declare function distillPromptRule(scopedRuns: EvalOutcome[] | {
    reflections: string[];
    count: number;
}, scope: string, opts?: {
    minSamples?: number;
    fragments?: readonly string[];
}): PromptRule | undefined;
/** Promotion gate: version + scope + evidence + security scan + benchmark. A
 *  rule becomes ACTIVE only when it is scoped, carries enough evidence, passed
 *  the security scan, and the benchmark shows a real lift without cost burnout. */
export declare function promotePromptRule(rule: PromptRule, delta: {
    passDelta: number;
    costScoreDelta: number;
    securityOk: boolean;
}, gate?: {
    minimumSamples?: number;
    minimumPassLift?: number;
}): PromptRule;
/** Explicit, permanent rollback: active → rolled_back; no longer applies
 *  anywhere and is excluded from future promotion. */
export declare function rollbackPromptRule(rule: PromptRule): PromptRule;
/** Applies only when ACTIVE and scope-matching. rolled_back/candidate never apply. */
export declare function shouldApplyPromptRule(rule: PromptRule, caseScope: string): boolean;
export type PromptRulePolicy = "no_rules" | "learned_rules";
export interface PromptRuleEffectModel {
    /** Pass-rate lift when an active, scope-matching, security-ok rule applies. */
    rulePassGain: number;
    /** Fraction of matching cases where the rule actually injects. */
    applicationReach: number;
    /** Extra tokens carrying/injecting the directive. */
    ruleTokensPerCase: number;
    /** Fault: the candidate is a verbatim reflection append (must fail closed). */
    faultVerbatimReflection: boolean;
    /** Fault: the candidate carries an injection/secret/safety-strip marker. */
    faultInjection: boolean;
}
export declare const DEFAULT_PROMPT_RULE_MODEL: PromptRuleEffectModel;
export interface PromptRuleRunMetrics {
    caseId: string;
    policy: PromptRulePolicy;
    appliedRule: boolean;
    securityFailed: boolean;
    passed: boolean;
    tokens: number;
    durationMs: number;
}
export declare function simulatePromptRuleRun(outcome: EvalOutcome, policy: PromptRulePolicy, rules: PromptRule[], caseScope: string, options?: {
    model?: Partial<PromptRuleEffectModel>;
    seed?: number;
    measureAsActive?: boolean;
}): PromptRuleRunMetrics;
export declare function aggregatePromptRule(runs: PromptRuleRunMetrics[], cost?: CostModelOptions): {
    passRate: number;
    appliedCount: number;
    securityFailures: number;
    costScore: number;
};
export interface PromptRuleComparison {
    baselinePassRate: number;
    challengerPassRate: number;
    securityFailures: number;
    activeCount: number;
    appliedCount: number;
    passDelta: number;
    costScoreDelta: number;
}
/** End-to-end experiment: distill a rule from training reflections, security
 *  scan it, promote on a validation split (scope-aware, benchmark), then
 *  measure vs baseline on evaluation, honoring rollbacks. */
export declare function runPromptRuleExperiment(trainingRuns: EvalOutcome[], validation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    scopeOf: (c: EvalCase) => string;
}, evaluation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    scopeOf: (c: EvalCase) => string;
}, options?: {
    scope?: string;
    model?: Partial<PromptRuleEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: {
        minimumSamples?: number;
        minimumPassLift?: number;
    };
    rollbackAfterPromote?: boolean;
}): Promise<PromptRuleComparison>;
export declare function renderPromptRuleComparison(cmp: PromptRuleComparison): string;
//# sourceMappingURL=prompt-rules.d.ts.map