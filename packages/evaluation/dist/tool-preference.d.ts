import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-5 — Learned Tool Preference experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). The goal is to
 * actually connect a `tool_preference` learning signal to tool ordering, but
 * with three hard requirements (plan.md P3-5):
 *
 *   1. BENCHMARK PROMOTED — a learned preference becomes ACTIVE only after it
 *      clears a benchmark promotion gate on a hold-out validation split. A
 *      preference that never validated stays `candidate` and never applies.
 *   2. SCOPE-AWARE — every preference is stamped with a scope; it may only
 *      affect cases whose scope matches. Non-matching behavior is unchanged.
 *      A single success can never rewire the global config.
 *   3. ROLLBACKABLE — every preference is versioned with an explicit
 *      `rollback()` that flips it to `rolled_back`, after which it no longer
 *      applies anywhere (and is excluded from future promotion).
 *
 * Safety invariant (carried from P3-4): applying a preference must never remove
 * a safety-critical tool; a preference that would do so is hard-rejected.
 *
 * As with the rest of P3, the challenger is a deterministic, seeded effect model
 * composed over measured outcomes — nothing is fabricated.
 */
/** Preference lifecycle. Promoted via benchmark gate; rollbackable forever. */
export type PreferenceStatus = "candidate" | "active" | "rolled_back";
/** A scoped, versioned tool preference learned from traces. */
export interface ToolPreference {
    /** Unique id. */
    id: string;
    /** The tool whose relative order is preferred. */
    tool: string;
    /** Scope this preference is restricted to (e.g. a task lane). Empty = broadest
     *  allowed scope but STILL a scope — never "everything everywhere". */
    scope: string;
    /** Preference weight (>1 prefers this tool earlier; <1 defers it). */
    weight: number;
    status: PreferenceStatus;
    /** Evidence supporting the preference (trace samples used to learn it). */
    evidenceSamples: number;
    /** Version counter; bumps on every promotion flip. */
    version: number;
}
/** True when a scope string matches a case. Empty scope matches anything. */
export declare function scopeMatches(scope: string, caseScope: string): boolean;
/** True when a preference would target a safety-critical tool. Such a
 *  preference must never be applied (a safety boundary cannot be re-weighted
 *  off). Safeguard mirrors the P3-4 safety-subset invariant. */
export declare function preferenceTargetsSafetyCritical(tool: string): boolean;
/**
 * Learn a candidate tool preference from a trace (already scoped). Counts how
 * often a tool was used in successful outcomes vs failed outcomes within the
 * trace; returns a preference proposal (still `candidate`) stamped with `scope`
 * plus its evidence size. Preferences resting on too few samples are dropped
 * (a single success must not stamp behavior).
 */
export declare function learnToolPreference(runs: EvalOutcome[], scope: string, tool: string, opts?: {
    minSamples?: number;
    minSuccessFrac?: number;
}): ToolPreference | undefined;
/** The promotion gate: only a benchmark-validated, sufficient-evidence
 *  preference that never strips a safety-critical tool becomes ACTIVE. */
export declare function promotePreference(preference: ToolPreference, delta: {
    passDelta: number;
    costScoreDelta: number;
    safetyIntact: boolean;
}, gate?: {
    minimumSamples?: number;
    minimumPassLift?: number;
}): ToolPreference;
/** Explicit, permanent rollback: flips an active preference to rolled_back so
 *  it no longer applies anywhere and is excluded from future promotion. */
export declare function rollbackPreference(preference: ToolPreference): ToolPreference;
/** Applies a preference to a scope only when it is ACTIVE and scope-matching.
 *  A rolled_back or candidate preference never applies. */
export declare function shouldApplyPreference(preference: ToolPreference, caseScope: string): boolean;
export type PreferencePolicy = "no_preferences" | "learned_preferences";
export interface PreferenceEffectModel {
    /** Pass-rate lift when an active, scope-matching preference is applied. */
    preferencePassGain: number;
    /** Fraction of active-preference cases where the tool actually gets used. */
    applicationReach: number;
    /** Extra tokens ordering/preference application costs. */
    preferenceTokensPerCase: number;
    /** Whether applying a preference ever strips a safety-critical tool (fault
     *  injection used in tests to verify the safety guard). */
    faultStripSafety: boolean;
}
export declare const DEFAULT_PREFERENCE_MODEL: PreferenceEffectModel;
export interface PreferenceRunMetrics {
    caseId: string;
    policy: PreferencePolicy;
    appliedPreference: boolean;
    strippedSafetyTool: boolean;
    passed: boolean;
    tokens: number;
    durationMs: number;
}
export declare function simulatePreferenceRun(outcome: EvalOutcome, policy: PreferencePolicy, preferences: ToolPreference[], caseScope: string, options?: {
    model?: Partial<PreferenceEffectModel>;
    seed?: number;
    measureAsActive?: boolean;
}): PreferenceRunMetrics;
export declare function aggregatePreference(runs: PreferenceRunMetrics[], cost?: CostModelOptions): {
    passRate: number;
    appliedCount: number;
    strippedCount: number;
    costScore: number;
};
export interface PreferenceComparison {
    baselinePassRate: number;
    challengerPassRate: number;
    strippedCount: number;
    activeCount: number;
    appliedCount: number;
    passDelta: number;
    costScoreDelta: number;
}
/** Run the end-to-end learned-tool-preference experiment: learn from a training
 *  trace, promote on a validation split (scope-aware), then measure the
 *  challenger vs baseline on the evaluation cases, honoring rollbacks. */
export declare function runPreferenceExperiment(trainingTrace: EvalOutcome[], validation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    scopeOf: (c: EvalCase) => string;
}, evaluation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    scopeOf: (c: EvalCase) => string;
}, options?: {
    tool?: string;
    scope?: string;
    model?: Partial<PreferenceEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: {
        minimumSamples?: number;
        minimumPassLift?: number;
    };
    rollbackAfterPromote?: boolean;
}): Promise<PreferenceComparison>;
export declare function renderPreferenceComparison(cmp: PreferenceComparison): string;
//# sourceMappingURL=tool-preference.d.ts.map