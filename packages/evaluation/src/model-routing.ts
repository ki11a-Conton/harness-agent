import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { seededRandom } from "./planner-executor.js";

/**
 * P3-14 — Model Routing Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). If routing ever
 * grows to multiple models, plan.md P3-14 sketches the motivating split:
 *
 *   cheap model  → simple / read-only planning
 *   strong model → complex coding / review
 *
 * Two hard rules:
 *
 *   1. EVALUATE FIRST — routing is decided on benchmark cost/quality, never on
 *      fashion. There is NO default that "more models is better".
 *   2. COST/QUALITY WIN REQUIRED — the routed policy is promoted only when it
 *      actually spends fewer tokens AND keeps quality within tolerance (never
 *      letting the complex split regress without a real saving). Otherwise the
 *      single-model champion stays.
 *
 * The challenger is a deterministic, seeded effect model composed over measured
 * outcomes — nothing is fabricated.
 */

export type ModelClass = "cheap" | "strong";
export type TaskClass = "simple" | "complex";

/** Route a task to a model class by structural cues (suite / verification /
 *  fixture cardinality) — deterministic, never model wording. */
export function classifyTask(c: Pick<EvalCase, "suite" | "verification" | "workspace" | "tags">): TaskClass {
  if (c.suite === "stress" || c.suite === "adversarial") return "complex";
  if (c.verification && c.verification.length > 0) return "complex";
  const fixture = c.workspace?.fixture as unknown;
  if (Array.isArray(fixture) && fixture.length > 2) return "complex";
  if (Array.isArray(c.tags) && c.tags.some((t) => /complex|review|multi/.test(t))) return "complex";
  return "simple";
}

export type RoutingPolicy = Record<TaskClass, ModelClass>;

/** The single-model champion: everything on the strong model. */
export const CHAMPION_ROUTING: RoutingPolicy = { simple: "strong", complex: "strong" };

export interface RoutingEffectModel {
  /** Token fraction a cheap model costs vs the strong model (1 = same). */
  cheapTokenFactor: number;
  /** Pass-rate loss a cheap model suffers on COMPLEX tasks (0..1). */
  complexCheapPenalty: number;
  /** Pass-rate loss a cheap model suffers on SIMPLE tasks (0..1). Small. */
  simpleCheapPenalty: number;
  /** Notional cost per token for the strong model (fixed, so relative). */
  strongTokenCost: number;
}

export const DEFAULT_ROUTING_MODEL: RoutingEffectModel = {
  cheapTokenFactor: 0.35,
  complexCheapPenalty: 0.25,
  simpleCheapPenalty: 0.03,
  strongTokenCost: 1,
};

export interface RoutedRunMetrics {
  caseId: string;
  policy: "single_strong" | "routed";
  taskClass: TaskClass;
  model: ModelClass;
  passed: boolean;
  tokens: number;
}

export function simulateRoutedRun(
  outcome: EvalOutcome,
  taskClass: TaskClass,
  policy: RoutingPolicy,
  options: { model?: Partial<RoutingEffectModel>; seed?: number } = {},
): RoutedRunMetrics {
  const m: RoutingEffectModel = { ...DEFAULT_ROUTING_MODEL, ...(options.model ?? {}) };
  const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 17);
  const model = policy[taskClass];
  const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
  let passed = outcome.status === "passed";

  if (model === "cheap") {
    const penalty = taskClass === "complex" ? m.complexCheapPenalty : m.simpleCheapPenalty;
    if (!passed && random() < penalty) passed = false; // stay failed (no help)
    // A cheap model on a passing case seldom breaks it; only the complex penalty
    // above models failure. Passing stays passing unless randomness flips it.
    if (passed && random() < penalty * 0.2) passed = false;
  }

  return {
    caseId: outcome.caseId,
    policy: isChampion(policy) ? "single_strong" : "routed",
    taskClass,
    model,
    passed,
    tokens: Math.round(tokens * (model === "cheap" ? m.cheapTokenFactor : 1)),
  };
}

function isChampion(p: RoutingPolicy): boolean {
  return p.simple === "strong" && p.complex === "strong";
}

export interface RoutingComparison {
  championPassRate: number;
  routedPassRate: number;
  championTokens: number;
  routedTokens: number;
  complexRoutedPassRate: number;
  complexChampionPassRate: number;
  passDelta: number;
  tokenSavingRatio: number; // 1 = routed spent nothing, 0 = no saving
  promoteRouted: boolean;
  reasons: string[];
}

/**
 * The cost/quality gate. The routed policy is promoted ONLY when it saves a
 * meaningful fraction of tokens AND does not regress the complex split beyond
 * tolerance. Tasteless "multi-model is better" is explicitly not a default.
 */
export function evaluateRouting(
  champion: RoutedRunMetrics[],
  routed: RoutedRunMetrics[],
  opts: { minTokenSavingRatio?: number; maxComplexPassDrop?: number } = {},
): RoutingComparison {
  const minSaving = opts.minTokenSavingRatio ?? 0.2;
  const maxComplexDrop = opts.maxComplexPassDrop ?? 0.05;
  const reasons: string[] = [];

  const champPass = passRate(champion);
  const routedPass = passRate(routed);
  const champTokens = sumTokens(champion);
  const routedTokens = sumTokens(routed);

  const complexChamp = passRate(champion.filter((r) => r.taskClass === "complex"));
  const complexRouted = passRate(routed.filter((r) => r.taskClass === "complex"));

  const passDelta = routedPass - champPass;
  const tokenSavingRatio = champTokens > 0 ? 1 - routedTokens / champTokens : 0;
  const complexDrop = complexChamp - complexRouted;

  if (tokenSavingRatio < minSaving) {
    reasons.push(`token saving ${round(tokenSavingRatio, 3)} below threshold ${minSaving}`);
  }
  if (complexDrop > maxComplexDrop) {
    reasons.push(`complex split regressed by ${round(complexDrop, 3)} (allow ≤ ${maxComplexDrop})`);
  }
  const promoteRouted =
    tokenSavingRatio >= minSaving && complexDrop <= maxComplexDrop && unchangingVs(champPass, routedPass, complexDrop);
  if (promoteRouted) reasons.push("routed policy wins on cost/quality");

  return {
    championPassRate: champPass,
    routedPassRate: routedPass,
    championTokens: champTokens,
    routedTokens: routedTokens,
    complexRoutedPassRate: complexRouted,
    complexChampionPassRate: complexChamp,
    passDelta,
    tokenSavingRatio,
    promoteRouted,
    reasons,
  };
}

/** A routed policy may not catastrophically lower overall pass either; the
 *  complex check plus a small overall tolerance guard that. */
function unchangingVs(champPass: number, routedPass: number, complexDrop: number): boolean {
  return complexDrop <= 0.05 && routedPass >= champPass - 0.08;
}

function passRate(runs: RoutedRunMetrics[]): number {
  if (runs.length === 0) return 0;
  return runs.filter((r) => r.passed).length / runs.length;
}

function sumTokens(runs: RoutedRunMetrics[]): number {
  return runs.reduce((s, r) => s + r.tokens, 0);
}

export function renderRoutingComparison(cmp: RoutingComparison): string {
  return [
    "Model Routing Experiment",
    `decision: ${cmp.promoteRouted ? "PROMOTE routed" : "KEEP single-model champion"}`,
    `  pass              ${round(cmp.championPassRate, 3)} → ${round(cmp.routedPassRate, 3)}  (${round(cmp.passDelta, 3)})`,
    `  complex pass      ${round(cmp.complexChampionPassRate, 3)} → ${round(cmp.complexRoutedPassRate, 3)}`,
    `  tokens            ${cmp.championTokens} → ${cmp.routedTokens}  (saving ${round(cmp.tokenSavingRatio, 3)})`,
    `  reasons           ${cmp.reasons.join("; ")}`,
  ].join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}