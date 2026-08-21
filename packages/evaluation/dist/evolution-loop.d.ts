import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
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
/** Choose the single most reliable variant. Only one is ever promoted; the
 *  champion wins ties and is kept when nothing beats it. Budgets are enforced. */
export declare function choosePromoted(champion: VariantAssessment, variants: VariantAssessment[], budgets?: Partial<EvolutionBudgets>): EvolutionDecision;
/** Run the evolution loop: unify a variant set over the same cases, then pick
 *  the single most reliable, budget-aware winner from a real per-variant EvalOutcome
 *  stream (champion + challengers evaluated with the same cases). */
export declare function runEvolutionLoop(championId: string, variantIds: string[], cases: EvalCase[], runVariant: (id: string, runWorkers: {
    run: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
}) => Promise<{
    id: string;
    runs: EvalOutcome[];
}>, runWorker: (c: EvalCase) => Promise<EvalOutcome>, options?: {
    cost?: CostModelOptions;
    budgets?: Partial<EvolutionBudgets>;
}): Promise<{
    assessments: Map<string, VariantAssessment>;
    decision: EvolutionDecision;
}>;
export declare function renderEvolutionDecision(assessments: Map<string, VariantAssessment>, decision: EvolutionDecision): string;
//# sourceMappingURL=evolution-loop.d.ts.map