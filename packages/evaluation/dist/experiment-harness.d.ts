import type { ExperimentConfig, ExperimentComparison, ExperimentReport, ExperimentVariant, ExperimentVariantResult, CrossModelAnalysis } from "@ar/contracts";
/**
 * P2-9: experiment harness — runs mechanism variants and produces a
 * comparison report. The `runBenchmark` dep is injected so callers can
 * wire it to real benchmarks (benchmark-command.ts) or use the default
 * simulation for testing.
 *
 * P2-15: when the config declares ≥2 `models`, the harness runs each variant
 * under every model (strongest first) and records the per-model result, then
 * derives a `crossModel` analysis flagging mechanisms that only help one
 * model or actively harm the weaker one.
 */
export interface ExperimentHarnessDeps {
    runBenchmark?: (variant: ExperimentVariant, config: ExperimentConfig, model?: string) => Promise<ExperimentVariantResult>;
}
export declare class ExperimentHarness {
    private readonly runBenchmark;
    constructor(deps?: ExperimentHarnessDeps);
    run(config: ExperimentConfig): Promise<ExperimentReport>;
}
/** Compare every non-baseline variant against the baseline on shared metrics.
 *  Model-aware (P2-15): each comparison is confined to a single model so the
 *  deltas are never polluted by mixing models. The optional `model` field on
 *  the comparison keeps results filterable per model. */
export declare function computeComparisons(config: ExperimentConfig, results: ExperimentVariantResult[]): ExperimentComparison[];
/**
 * P2-15: cross-model findings. Returns undefined when the config does not
 * declare ≥2 models (single-model runs have nothing to cross-compare).
 *
 * For each non-baseline mechanism it computes the baseline→mechanism delta on
 * the strong model and on the (weakest) weaker model, then classifies it. The
 * two findings this exists for — "harms-weaker" and "improves-only-*" — cannot
 * be seen in a single-model evaluation, which is the entire point: a Harness
 * optimization must not be promoted on the strength of one prompt style.
 */
export declare function computeCrossModel(config: ExperimentConfig, results: ExperimentVariantResult[]): CrossModelAnalysis | undefined;
/** Render a report as plain text for CLI output. */
export declare function renderReport(report: ExperimentReport): string;
//# sourceMappingURL=experiment-harness.d.ts.map