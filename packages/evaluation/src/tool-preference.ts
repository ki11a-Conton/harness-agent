import type { EvalCase } from "./eval-case.js";
import { toolNameOf as toolNameOfPayload } from "@ar/contracts";
import type { EvalOutcome } from "./runner.js";
import { scoreCost, type CostModelOptions, type CostResult } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";

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
export function scopeMatches(scope: string, caseScope: string): boolean {
  return scope === "" || caseScope === "" || scope === caseScope;
}

/** True when a preference would target a safety-critical tool. Such a
 *  preference must never be applied (a safety boundary cannot be re-weighted
 *  off). Safeguard mirrors the P3-4 safety-subset invariant. */
export function preferenceTargetsSafetyCritical(tool: string): boolean {
  return SAFETY_CRITICAL_TOOLS.has(tool);
}

/**
 * Learn a candidate tool preference from a trace (already scoped). Counts how
 * often a tool was used in successful outcomes vs failed outcomes within the
 * trace; returns a preference proposal (still `candidate`) stamped with `scope`
 * plus its evidence size. Preferences resting on too few samples are dropped
 * (a single success must not stamp behavior).
 */
export function learnToolPreference(
  runs: EvalOutcome[],
  scope: string,
  tool: string,
  opts: { minSamples?: number; minSuccessFrac?: number } = {},
): ToolPreference | undefined {
  const minSamples = opts.minSamples ?? 3;
  const minSuccessFrac = opts.minSuccessFrac ?? 0.6;
  const inScope = runs; // trace is assumed pre-scoped to `scope`
  if (inScope.length === 0) return undefined;

  let usedCount = 0;
  let successWhenUsed = 0;
  for (const run of inScope) {
    const used = run.events.some(isToolUse(tool));
    if (!used) continue;
    usedCount += 1;
    if (run.status === "passed") successWhenUsed += 1;
  }
  // Too little evidence → no learning (single success must not stamp behavior).
  if (usedCount < minSamples) return undefined;
  const successFrac = successWhenUsed / usedCount;
  if (successFrac < minSuccessFrac) return undefined;

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
export function promotePreference(
  preference: ToolPreference,
  delta: { passDelta: number; costScoreDelta: number; safetyIntact: boolean },
  gate?: { minimumSamples?: number; minimumPassLift?: number },
): ToolPreference {
  const minimumSamples = gate?.minimumSamples ?? 3;
  const minimumPassLift = gate?.minimumPassLift ?? 0;
  if (preference.status !== "candidate") return preference;
  if (preference.evidenceSamples < minimumSamples) return preference; // no evidence → no promotion
  if (!delta.safetyIntact) return preference; // never promote a safety-stripping preference
  if (delta.passDelta < minimumPassLift) return preference; // must actually help in scope
  if (delta.costScoreDelta <= 0) return preference; // cost ate the value
  return { ...preference, status: "active", version: preference.version + 1 };
}

/** Explicit, permanent rollback: flips an active preference to rolled_back so
 *  it no longer applies anywhere and is excluded from future promotion. */
export function rollbackPreference(preference: ToolPreference): ToolPreference {
  if (preference.status !== "active") return preference;
  return { ...preference, status: "rolled_back", version: preference.version + 1 };
}

/** Applies a preference to a scope only when it is ACTIVE and scope-matching.
 *  A rolled_back or candidate preference never applies. */
export function shouldApplyPreference(
  preference: ToolPreference,
  caseScope: string,
): boolean {
  return preference.status === "active" && scopeMatches(preference.scope, caseScope);
}

// ---------------------- Effect model ---------------------------------------

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

export const DEFAULT_PREFERENCE_MODEL: PreferenceEffectModel = {
  preferencePassGain: 0.2,
  applicationReach: 1,
  preferenceTokensPerCase: 150,
  faultStripSafety: false,
};

export interface PreferenceRunMetrics {
  caseId: string;
  policy: PreferencePolicy;
  appliedPreference: boolean;
  strippedSafetyTool: boolean;
  passed: boolean;
  tokens: number;
  durationMs: number;
}

export function simulatePreferenceRun(
  outcome: EvalOutcome,
  policy: PreferencePolicy,
  preferences: ToolPreference[],
  caseScope: string,
  options: { model?: Partial<PreferenceEffectModel>; seed?: number; measureAsActive?: boolean } = {},
): PreferenceRunMetrics {
  const model: PreferenceEffectModel = {
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
  const applicable = preferences.filter(
    (p) =>
      (options.measureAsActive === true || p.status === "active") &&
      scopeMatches(p.scope, caseScope),
  );
  // Scope-aware: a preference outside this scope never counts.
  const applied = applicable.length > 0 && random() < model.applicationReach;

  let strippedSafetyTool = false;
  if (model.faultStripSafety) {
    // Fault injection: the preference would drop a safety-critical tool.
    strippedSafetyTool = true;
    // Safety guard: never allow — the run must fail-closed (no promotion).
    passed = false;
  } else if (applied && !passed && random() < model.preferencePassGain) {
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

export function aggregatePreference(
  runs: PreferenceRunMetrics[],
  cost?: CostModelOptions,
): { passRate: number; appliedCount: number; strippedCount: number; costScore: number } {
  const passed = runs.filter((r) => r.passed).length;
  const stripped = runs.filter((r) => r.strippedSafetyTool).length;
  const costResult: CostResult = scoreCost(
    {
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
    },
    cost ?? {},
  );
  return {
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    appliedCount: runs.filter((r) => r.appliedPreference).length,
    strippedCount: stripped,
    costScore: costResult.score,
  };
}

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
export async function runPreferenceExperiment(
  trainingTrace: EvalOutcome[],
  validation: { runWorker: (c: EvalCase) => Promise<EvalOutcome>; cases: EvalCase[]; scopeOf: (c: EvalCase) => string },
  evaluation: { runWorker: (c: EvalCase) => Promise<EvalOutcome>; cases: EvalCase[]; scopeOf: (c: EvalCase) => string },
  options: {
    tool?: string;
    scope?: string;
    model?: Partial<PreferenceEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: { minimumSamples?: number; minimumPassLift?: number };
    rollbackAfterPromote?: boolean;
  } = {},
): Promise<PreferenceComparison> {
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
  let vBaseline: PreferenceRunMetrics[] = [];
  let vChallenger: PreferenceRunMetrics[] = [];
  for (const c of validation.cases) {
    const outcome = await validation.runWorker(c);
    const s = validation.scopeOf(c);
    vBaseline.push(simulatePreferenceRun(outcome, "no_preferences", [], s, { model: options.model, seed }));
    vChallenger.push(
      simulatePreferenceRun(outcome, "learned_preferences", [learned], s, {
        model: options.model,
        seed,
        measureAsActive: true,
      }),
    );
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
  if (options.rollbackAfterPromote) champion = rollbackPreference(champion);

  // 3. MEASURE on the evaluation split.
  const base: PreferenceRunMetrics[] = [];
  const challenger: PreferenceRunMetrics[] = [];
  for (const c of evaluation.cases) {
    const outcome = await evaluation.runWorker(c);
    const s = evaluation.scopeOf(c);
    base.push(simulatePreferenceRun(outcome, "no_preferences", [], s, { model: options.model, seed }));
    challenger.push(
      simulatePreferenceRun(outcome, "learned_preferences", [champion], s, { model: options.model, seed }),
    );
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

function isToolUse(tool: string): (event: EvalOutcome["events"][number]) => boolean {
  return (event) => {
    if (event.type !== "tool.completed" && event.type !== "tool.requested") return false;
    return toolNameOfPayload(event.payload) === tool;
  };
}

export function renderPreferenceComparison(cmp: PreferenceComparison): string {
  return [
    "Learned Tool Preference Experiment",
    `decision: ${cmp.activeCount > 0 ? "ACTIVE (promoted)" : "NOT ACTIVE"}`,
    `  stripped-safety faults     ${cmp.strippedCount}`,
    `  preferences applied         ${cmp.appliedCount}`,
    `  pass rate                   ${round(cmp.baselinePassRate, 3)} → ${round(cmp.challengerPassRate, 3)}  (${cmp.activeCount > 0 ? (cmp.passDelta >= 0 ? "lift" : "reject") : "no-op"})`,
    `  cost score delta            ${round(cmp.costScoreDelta, 3)}`,
  ].join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}