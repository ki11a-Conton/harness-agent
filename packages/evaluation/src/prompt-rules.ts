import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { scoreCost, type CostModelOptions, type CostResult } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";

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

// ---------------------- Security scan --------------------------------------

/** Prompt-injection markers that must never appear in an injected directive. */
const INJECTION_MARKERS = [
  "ignore previous instructions",
  "ignore all prior instructions",
  "you are now",
  "system prompt says",
  "do anything the user asks",
  "disregard earlier rules",
] as const;

/** Secret-looking patterns that must never be injected. */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{12,}/,
  /AKIA[0-9A-Z]{16}/,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
] as const;

/** Phrasings that instruct skipping a safety / verification barrier. */
const SAFETY_STRIP_MARKERS = [
  "skip verification",
  "bypass verification",
  "ignore permission",
  "don't verify",
  "no verification",
  "skip permission",
] as const;

/** True when a directive equals or embeds an entire reflection body verbatim.
 *  This is the P3-7 hard invariant: reflection text must never be appended as-is. */
export function isVerbatimReflectionAppend(directive: string, reflections: string[]): boolean {
  const needle = directive.trim();
  return reflections.some((r) => {
    const body = r.trim();
    return body !== "" && (needle === body || needle.includes(body) || body.includes(needle));
  });
}

export interface PromptRuleScanResult {
  ok: boolean;
  reason?: string;
}

/** Fail-closed security scan for a distilled rule. A passing scan is required
 *  for promotion; a failing scan can never be applied. */
export function assertPromptRuleSecurity(
  directive: string,
  reflections: string[],
): PromptRuleScanResult {
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
export function promptScopeMatches(scope: string, caseScope: string): boolean {
  return scope === "" || caseScope === "" || scope === caseScope;
}

// ---------------------- Learning (distillation) ----------------------------

/** Extract observable reflection-like signals from a run: the structured
 *  termination reason plus any reflection.* events. Kept small and explicit. */
export function extractReflections(run: EvalOutcome): string[] {
  const out: string[] = [];
  if (typeof run.reason === "string" && run.reason.trim() !== "") out.push(run.reason);
  for (const event of run.events) {
    if (event.type.startsWith("reflection.")) {
      const text =
        event.payload?.directive ?? event.payload?.rule ?? event.payload?.text ?? event.payload?.content;
      if (typeof text === "string" && text.trim() !== "") out.push(text);
    }
  }
  return out;
}

export const PROMPT_RULE_DISTILL_FRAGMENTS = [
  "verify changes before completing",
  "read the target file before editing it",
  "confirm scope before mutating",
] as const;

/**
 * Distill a prompt rule from reflection signals within a scope. The resulting
 * `directive` is a fresh, safe composition — never a verbatim reflection body
 * (the security scan re-checks this). Evidence must exceed `minSamples`; too
 * little evidence produces no rule (a single reflection never stamps behavior).
 */
export function distillPromptRule(
  scopedRuns: EvalOutcome[] | { reflections: string[]; count: number },
  scope: string,
  opts: { minSamples?: number; fragments?: readonly string[] } = {},
): PromptRule | undefined {
  const minSamples = opts.minSamples ?? 3;
  const fragments = opts.fragments ?? PROMPT_RULE_DISTILL_FRAGMENTS;

  let reflections: string[];
  let evidenceSamples: number;
  if (Array.isArray(scopedRuns)) {
    const rs: string[] = [];
    for (const run of scopedRuns) rs.push(...extractReflections(run));
    reflections = rs;
    evidenceSamples = scopedRuns.length;
  } else {
    reflections = scopedRuns.reflections;
    evidenceSamples = scopedRuns.count;
  }

  if (evidenceSamples < minSamples) return undefined; // too thin
  if (reflections.length === 0) return undefined;

  // Fresh composition selected deterministically from fragments. This is the
  // distilled directive — never copied from a reflection body.
  const directive = fragments[0] ?? "follow the verified procedure";
  const scan = assertPromptRuleSecurity(directive, reflections);
  if (!scan.ok) return undefined; // a rule that fails its own security scan is not produced

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
export function promotePromptRule(
  rule: PromptRule,
  delta: { passDelta: number; costScoreDelta: number; securityOk: boolean },
  gate?: { minimumSamples?: number; minimumPassLift?: number },
): PromptRule {
  const minimumSamples = gate?.minimumSamples ?? 3;
  const minimumPassLift = gate?.minimumPassLift ?? 0;
  if (rule.status !== "candidate") return rule;
  if (rule.evidenceSamples < minimumSamples) return rule;
  if (!rule.securityOk || !delta.securityOk) return rule; // security scan fail-closed
  if (delta.passDelta < minimumPassLift) return rule;
  if (delta.costScoreDelta <= 0) return rule;
  return { ...rule, status: "active", version: rule.version + 1 };
}

/** Explicit, permanent rollback: active → rolled_back; no longer applies
 *  anywhere and is excluded from future promotion. */
export function rollbackPromptRule(rule: PromptRule): PromptRule {
  if (rule.status !== "active") return rule;
  return { ...rule, status: "rolled_back", version: rule.version + 1 };
}

/** Applies only when ACTIVE and scope-matching. rolled_back/candidate never apply. */
export function shouldApplyPromptRule(rule: PromptRule, caseScope: string): boolean {
  return rule.status === "active" && promptScopeMatches(rule.scope, caseScope);
}

// ---------------------- Effect model ---------------------------------------

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

export const DEFAULT_PROMPT_RULE_MODEL: PromptRuleEffectModel = {
  rulePassGain: 0.2,
  applicationReach: 1,
  ruleTokensPerCase: 120,
  faultVerbatimReflection: false,
  faultInjection: false,
};

export interface PromptRuleRunMetrics {
  caseId: string;
  policy: PromptRulePolicy;
  appliedRule: boolean;
  securityFailed: boolean;
  passed: boolean;
  tokens: number;
  durationMs: number;
}

export function simulatePromptRuleRun(
  outcome: EvalOutcome,
  policy: PromptRulePolicy,
  rules: PromptRule[],
  caseScope: string,
  options: { model?: Partial<PromptRuleEffectModel>; seed?: number; measureAsActive?: boolean } = {},
): PromptRuleRunMetrics {
  const model: PromptRuleEffectModel = { ...DEFAULT_PROMPT_RULE_MODEL, ...(options.model ?? {}) };
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
  const applicable = matching.filter(
    (r) => (options.measureAsActive === true || r.status === "active") && r.securityOk,
  );
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

export function aggregatePromptRule(
  runs: PromptRuleRunMetrics[],
  cost?: CostModelOptions,
): { passRate: number; appliedCount: number; securityFailures: number; costScore: number } {
  const passed = runs.filter((r) => r.passed).length;
  const securityFailures = runs.filter((r) => r.securityFailed).length;
  const costResult: CostResult = scoreCost(
    {
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

        usage_unknown: 0,

        cache_tokens_read: 0,

        cache_tokens_created: 0,

        model_call_count: 0,
      },
      events: [],
    },
    cost ?? {},
  );
  return {
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    appliedCount: runs.filter((r) => r.appliedRule).length,
    securityFailures,
    costScore: costResult.score,
  };
}

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
export async function runPromptRuleExperiment(
  trainingRuns: EvalOutcome[],
  validation: { runWorker: (c: EvalCase) => Promise<EvalOutcome>; cases: EvalCase[]; scopeOf: (c: EvalCase) => string },
  evaluation: { runWorker: (c: EvalCase) => Promise<EvalOutcome>; cases: EvalCase[]; scopeOf: (c: EvalCase) => string },
  options: {
    scope?: string;
    model?: Partial<PromptRuleEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: { minimumSamples?: number; minimumPassLift?: number };
    rollbackAfterPromote?: boolean;
  } = {},
): Promise<PromptRuleComparison> {
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
  const vBaseline: PromptRuleRunMetrics[] = [];
  const vChallenger: PromptRuleRunMetrics[] = [];
  for (const c of validation.cases) {
    const outcome = await validation.runWorker(c);
    const s = validation.scopeOf(c);
    vBaseline.push(simulatePromptRuleRun(outcome, "no_rules", [], s, { model: options.model, seed }));
    vChallenger.push(
      simulatePromptRuleRun(outcome, "learned_rules", [learned], s, {
        model: options.model,
        seed,
        measureAsActive: true,
      }),
    );
  }
  const vBaseAgg = aggregatePromptRule(vBaseline, options.cost);
  const vChallAgg = aggregatePromptRule(vChallenger, options.cost);
  const securityOk = vChallAgg.securityFailures === 0;

  let champion = promotePromptRule(
    learned,
    {
      passDelta: vChallAgg.passRate - vBaseAgg.passRate,
      costScoreDelta: vChallAgg.costScore - vBaseAgg.costScore,
      securityOk,
    },
    options.gate,
  );
  if (options.rollbackAfterPromote) champion = rollbackPromptRule(champion);

  // 3. MEASURE on the evaluation split.
  const base: PromptRuleRunMetrics[] = [];
  const challenger: PromptRuleRunMetrics[] = [];
  for (const c of evaluation.cases) {
    const outcome = await evaluation.runWorker(c);
    const s = evaluation.scopeOf(c);
    base.push(simulatePromptRuleRun(outcome, "no_rules", [], s, { model: options.model, seed }));
    challenger.push(
      simulatePromptRuleRun(outcome, "learned_rules", [champion], s, { model: options.model, seed }),
    );
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

export function renderPromptRuleComparison(cmp: PromptRuleComparison): string {
  return [
    "Learned Prompt Rules Experiment",
    `decision: ${cmp.activeCount > 0 ? "ACTIVE (promoted)" : "NOT ACTIVE"}`,
    `  security failures          ${cmp.securityFailures}`,
    `  rules applied               ${cmp.appliedCount}`,
    `  pass rate                   ${round(cmp.baselinePassRate, 3)} → ${round(cmp.challengerPassRate, 3)}  (${cmp.activeCount > 0 ? (cmp.passDelta >= 0 ? "lift" : "reject") : "no-op"})`,
    `  cost score delta            ${round(cmp.costScoreDelta, 3)}`,
  ].join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}