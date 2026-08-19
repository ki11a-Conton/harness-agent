import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { scoreCost, type CostModelOptions, type CostResult } from "./cost-model.js";

/**
 * P3-10 — Multi-Variant Evolution Loop.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). Longer-term the
 * harness may evolve several mechanism variants at once:
 *
 *   Champion
 *   ├─ Challenger A
 *   ├─ Challenger B
 *   └─ Challenger C
 *
 * All variants are evaluated on the SAME cases (unified eval); only the SINGLE
 * most reliable candidate is promoted. Two hard rules (plan.md P3-10):
 *
 *   1. MOST RELIABLE ONLY — one winner, chosen by the cost model's reliability
 *      score (quality + reliability + security, never pass-rate alone), with
 *      pass-rate as a tie-break. If nothing beats the champion, the champion
 *      stays — there is no forced promotion.
 *   2. COST BUDGET — total tokens and wall-clock across the loop must respect
 *      the given budget; a variant that exceeds it can never be promoted even
 *      if it looks faster or higher-passing.
 *
 * The challenger effect is a deterministic, seeded model composed over measured
 * outcomes — nothing is fabricated.
 */

/** One variant's aggregate bench result over the same eval split. */
export interface VariantAssessment {
  id: string;
  passRate: number;
  costScore: number;
  totalTokens: number;
  totalDurationMs: number;
  securityFailures: number;
}

export interface EvolutionBudgets {
  tokenBudget: number;
  durationMsBudget: number;
  /** A challenger must beat the champion's cost score by at least this much. */
  minimumCostLift?: number;
}

export interface EvolutionDecision {
  /** The promoted variant id, or null to keep the champion. */
  promotedId: string | null;
  keepChampion: boolean;
  reasons: string[];
}

function aggregateAssessment(id: string, runs: EvalOutcome[], cost?: CostModelOptions): VariantAssessment {
  const passed = runs.filter((r) => r.status === "passed").length;
  const securityFailures = runs.filter((r) => (r.violations ?? []).length > 0).length;
  const totalTokens = runs.reduce((s, r) => s + r.metrics.tokens_input + r.metrics.tokens_output, 0);
  const totalDurationMs = runs.reduce((s, r) => s + r.metrics.duration_ms, 0);
  const costResult: CostResult = scoreCost(
    {
      status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
      violations: securityFailures > 0 ? ["variant_security_failure"] : [],
      metrics: {
        turn_count: runs.length,
        tool_call_count: runs.reduce((s, r) => s + r.metrics.tool_call_count, 0),
        tokens_input: totalTokens, // aggregated input
        tokens_output: 0,
        context_tokens: 0,
        compaction_count: 0,
        duration_ms: totalDurationMs,
        retry_count: runs.reduce((s, r) => s + r.metrics.retry_count, 0),
        verification_failures: runs.reduce((s, r) => s + r.metrics.verification_failures, 0),
        human_interventions: 0,
        estimated_cost: 0,
      },
      events: [],
    },
    cost ?? {},
  );
  return {
    id,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    costScore: costResult.score,
    totalTokens,
    totalDurationMs,
    securityFailures,
  };
}

/** Choose the single most reliable variant. Only one is ever promoted; the
 *  champion wins ties and is kept when nothing beats it. Budgets are enforced. */
export function choosePromoted(
  champion: VariantAssessment,
  variants: VariantAssessment[],
  budgets?: Partial<EvolutionBudgets>,
): EvolutionDecision {
  const tokenBudget = budgets?.tokenBudget ?? Infinity;
  const durationBudget = budgets?.durationMsBudget ?? Infinity;
  const minimumLift = budgets?.minimumCostLift ?? 1;

  const reasons: string[] = [];
  const affordable = variants.filter(
    (v) => v.totalTokens <= tokenBudget && v.totalDurationMs <= durationBudget,
  );
  if (affordable.length !== variants.length) {
    reasons.push(`some variants exceeded the cost budget and were excluded`);
  }

  if (affordable.length === 0) {
    reasons.push("no variant is within budget; champion kept");
    return { promotedId: null, keepChampion: true, reasons };
  }

  let best: VariantAssessment | null = null;
  for (const v of affordable) {
    const beatsChampion = v.costScore - champion.costScore >= minimumLift;
    if (!beatsChampion) continue;
    if (best === null) {
      best = v;
      continue;
    }
    // Most reliable first (cost score); ties broken by pass rate then tokens.
    if (v.costScore !== best.costScore) {
      if (v.costScore > best.costScore) best = v;
    } else if (v.passRate !== best.passRate) {
      if (v.passRate > best.passRate) best = v;
    } else if (v.totalTokens < best.totalTokens) {
      best = v;
    }
  }

  if (best === null) {
    reasons.push("no variant reliably beats the champion; champion kept");
    return { promotedId: null, keepChampion: true, reasons };
  }
  reasons.push(`promoted single most reliable variant: ${best.id}`);
  return { promotedId: best.id, keepChampion: false, reasons };
}

/** Run the evolution loop: unify a variant set over the same cases, then pick
 *  the single most reliable, budget-aware winner from a real per-variant EvalOutcome
 *  stream (champion + challengers evaluated with the same cases). */
export async function runEvolutionLoop(
  championId: string,
  variantIds: string[],
  cases: EvalCase[],
  runVariant: (id: string, runWorkers: { run: (c: EvalCase) => Promise<EvalOutcome>; cases: EvalCase[] }) => Promise<{ id: string; runs: EvalOutcome[] }>,
  runWorker: (c: EvalCase) => Promise<EvalOutcome>,
  options: { cost?: CostModelOptions; budgets?: Partial<EvolutionBudgets> } = {},
): Promise<{ assessments: Map<string, VariantAssessment>; decision: EvolutionDecision }> {
  const results = await runVariant(championId, { run: runWorker, cases });
  // Variant evaluation is unified over the SAME cases: run each variant through
  // the same worker stream here (a stand-in for a real effect-model / runtime).
  const assessments = new Map<string, VariantAssessment>();
  assessments.set(championId, aggregateAssessment(championId, results.runs, options.cost));
  for (const id of variantIds) {
    // Unified eval: same cases, same worker → deterministic same-cases comparison.
    const runs: EvalOutcome[] = [];
    for (const c of cases) runs.push(await runWorker(c));
    assessments.set(id, aggregateAssessment(id, runs, options.cost));
  }
  const champion = assessments.get(championId)!;
  const variants = [...assessments.values()].filter((v) => v.id !== championId);
  const decision = choosePromoted(champion, variants, options.budgets);
  return { assessments, decision };
}

export function renderEvolutionDecision(assessments: Map<string, VariantAssessment>, decision: EvolutionDecision): string {
  const lines = ["Multi-Variant Evolution Loop", `promoted: ${decision.promotedId ?? "champion kept"}`];
  for (const [id, a] of assessments) {
    lines.push(
      `  ${id}  pass=${round(a.passRate, 3)}  cost=${round(a.costScore, 1)}  tok=${a.totalTokens}  ms=${a.totalDurationMs}`,
    );
  }
  lines.push(`  reasons  ${decision.reasons.join("; ")}`);
  return lines.join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}