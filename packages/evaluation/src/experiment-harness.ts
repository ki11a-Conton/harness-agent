import type {
  ExperimentConfig,
  ExperimentComparison,
  ExperimentReport,
  ExperimentVariant,
  ExperimentVariantResult,
  CrossModelAnalysis,
  CrossModelFinding,
} from "@ar/contracts";

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
  runBenchmark?: (
    variant: ExperimentVariant,
    config: ExperimentConfig,
    model?: string,
  ) => Promise<ExperimentVariantResult>;
}

/** Default benchmark: simulates a run with random metrics. */
async function defaultRunBenchmark(
  variant: ExperimentVariant,
  _config: ExperimentConfig,
  _model?: string,
): Promise<ExperimentVariantResult> {
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  return {
    variantName: variant.name,
    mechanism: variant.mechanism,
    status: "completed",
    metrics: {
      passRate: 0.8 + Math.random() * 0.2,
      latencyP50: 50 + Math.random() * 100,
      latencyP95: 100 + Math.random() * 500,
      tokens: 500 + Math.random() * 1500,
    },
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

export class ExperimentHarness {
  private readonly runBenchmark: (
    variant: ExperimentVariant,
    config: ExperimentConfig,
    model?: string,
  ) => Promise<ExperimentVariantResult>;

  constructor(deps: ExperimentHarnessDeps = {}) {
    this.runBenchmark = deps.runBenchmark ?? defaultRunBenchmark;
  }

  async run(config: ExperimentConfig): Promise<ExperimentReport> {
    const startedAt = Date.now();
    const results: ExperimentVariantResult[] = [];
    const models = config.models ?? ["default"];

    for (const variant of config.variants) {
      for (const model of models) {
        try {
          const result = await this.runBenchmark(variant, config, model);
          const resultWithModel = {
            ...result,
            // Record the model even when the injected benchmark omits it,
            // so results are always machine-filterable per model (P2-15).
            model: result.model ?? model,
          };
          results.push(resultWithModel);
        } catch (cause) {
          results.push({
            variantName: variant.name,
            mechanism: variant.mechanism,
            status: "failed",
            metrics: {},
            error: String(cause),
            startedAt,
            durationMs: 0,
            model,
          });
        }
      }
    }

    const report: ExperimentReport = {
      configId: config.id,
      description: config.description,
      results,
      comparisons: computeComparisons(config, results),
      startedAt,
      completedAt: Date.now(),
    };
    const crossModel = computeCrossModel(config, results);
    if (crossModel !== undefined) report.crossModel = crossModel;
    return report;
  }
}

/** Compare every non-baseline variant against the baseline on shared metrics.
 *  Model-aware (P2-15): each comparison is confined to a single model so the
 *  deltas are never polluted by mixing models. The optional `model` field on
 *  the comparison keeps results filterable per model. */
export function computeComparisons(
  config: ExperimentConfig,
  results: ExperimentVariantResult[],
): ExperimentComparison[] {
  const baselineName = config.baseline ?? config.variants[0]!.name;
  const models = config.models ?? ["default"];
  const comparisons: ExperimentComparison[] = [];

  for (const model of models) {
    const baselineForModel = results.find(
      (r) => r.variantName === baselineName && (r.model ?? "default") === model,
    );
    if (baselineForModel === undefined) continue;
    for (const result of results) {
      if (result.variantName === baselineName) continue;
      if ((result.model ?? "default") !== model) continue;
      for (const metric of Object.keys(result.metrics)) {
        if (!(metric in baselineForModel.metrics)) continue;
        const delta = (baselineForModel.metrics[metric] ?? 0) - (result.metrics[metric] ?? 0);
        comparisons.push({
          variantA: baselineName,
          variantB: result.variantName,
          metric,
          delta,
          winner: null,
          model,
        });
      }
    }
  }
  return comparisons;
}

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
export function computeCrossModel(
  config: ExperimentConfig,
  results: ExperimentVariantResult[],
): CrossModelAnalysis | undefined {
  const models = config.models ?? ["default"];
  if (models.length < 2) return undefined;

  const strong = resolveCapableModel(config, models, "strong");
  const weak = resolveCapableModel(config, models, "weak");
  if (strong === undefined || weak === undefined) return undefined;

  const baselineName = config.baseline ?? config.variants[0]!.name;
  const findings: CrossModelFinding[] = [];
  const counts: Record<string, number> = {};

  const metricsOf = (variant: string, model: string): Record<string, number> | undefined =>
    results.find(
      (r) => r.variantName === variant && (r.model ?? "default") === model,
    )?.metrics;

  const baselineStrong = metricsOf(baselineName, strong);
  const baselineWeak = metricsOf(baselineName, weak);
  if (baselineStrong === undefined || baselineWeak === undefined) {
    return { model: { strong, weak }, findings, counts };
  }

  for (const variant of config.variants) {
    if (variant.name === baselineName) continue;
    const strongMetrics = metricsOf(variant.name, strong);
    const weakMetrics = metricsOf(variant.name, weak);
    if (strongMetrics === undefined || weakMetrics === undefined) continue;
    for (const metric of Object.keys(strongMetrics)) {
      const sStrongB = baselineStrong[metric];
      const sWeakB = baselineWeak[metric];
      const sStrong = strongMetrics[metric];
      const sWeak = weakMetrics[metric];
      if (typeof sStrongB !== "number" || typeof sWeakB !== "number") continue;
      if (typeof sStrong !== "number" || typeof sWeak !== "number") continue;
      const strongDelta = sStrong - sStrongB;
      const weakDelta = sWeak - sWeakB;
      const kind = classifyCrossModel(strongDelta, weakDelta);
      counts[kind] = (counts[kind] ?? 0) + 1;
      findings.push({
        mechanism: variant.name,
        metric,
        strongDelta: round(strongDelta),
        weakDelta: round(weakDelta),
        kind,
        detail: crossModelDetail(variant.name, metric, strongDelta, weakDelta),
      });
    }
  }

  return { model: { strong, weak }, findings, counts };
}

/** Capability of a model: explicit tag wins; else the first `models` entry is strong. */
function resolveCapableModel(
  config: ExperimentConfig,
  models: string[],
  wanted: "strong" | "weak",
): string | undefined {
  for (const model of models) {
    const cap = config.modelCapabilities?.[model];
    if (cap === wanted) return model;
  }
  // Fall back to ordering: first = strong, last = weak.
  if (wanted === "strong") return models[0];
  return models[models.length - 1];
}

function classifyCrossModel(strongDelta: number, weakDelta: number): CrossModelFinding["kind"] {
  if (strongDelta > 0 && weakDelta > 0) return "consistent";
  if (strongDelta > 0 && weakDelta < 0) return "harms-weaker";
  if (strongDelta > 0) return "improves-only-strong";
  if (weakDelta > 0) return "improves-only-weak";
  return "mixed";
}

function crossModelDetail(
  mechanism: string,
  metric: string,
  strongDelta: number,
  weakDelta: number,
): string {
  if (strongDelta > 0 && weakDelta < 0) {
    return `${mechanism} improves strong-model ${metric} by ${strongDelta.toFixed(4)} but harms weak-model ${metric} by ${Math.abs(weakDelta).toFixed(4)}`;
  }
  if (strongDelta > 0) {
    return `${mechanism} improves ${metric} only on the strong model (+${strongDelta.toFixed(4)}); weaker model unchanged or worse`;
  }
  if (weakDelta > 0) {
    return `${mechanism} improves ${metric} only on the weaker model (+${weakDelta.toFixed(4)}); strong model unchanged or worse`;
  }
  return `${mechanism} does not improve ${metric} on either model`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Render a report as plain text for CLI output. */
export function renderReport(report: ExperimentReport): string {
  const lines: string[] = [
    `Experiment: ${report.configId}`,
    report.description ?? "",
    `Variants: ${report.results.length}`,
    "",
  ];
  for (const result of report.results) {
    const statusIcon = result.status === "completed" ? "✓" : result.status === "failed" ? "✗" : "–";
    const modelTag = result.model !== undefined ? ` (${result.model})` : "";
    lines.push(`  ${statusIcon} ${result.variantName}${modelTag} — ${result.durationMs}ms`);
    if (result.error !== undefined) lines.push(`    error: ${result.error}`);
    for (const [key, value] of Object.entries(result.metrics)) {
      lines.push(`    ${key}: ${typeof value === "number" ? value.toFixed(2) : value}`);
    }
  }
  if (report.comparisons.length > 0) {
    lines.push("", "Comparisons (baseline delta):");
    for (const cmp of report.comparisons) {
      const modelTag = cmp.model !== undefined ? ` [${cmp.model}]` : "";
      lines.push(`  ${cmp.variantA} vs ${cmp.variantB}${modelTag} — ${cmp.metric}: ${cmp.delta.toFixed(4)}`);
    }
  }
  if (report.crossModel !== undefined) {
    lines.push("", "Cross-model analysis (P2-15):");
    lines.push(`  strong=${report.crossModel.model.strong} · weak=${report.crossModel.model.weak}`);
    lines.push(`  counts: ${Object.entries(report.crossModel.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const finding of report.crossModel.findings) {
      lines.push(`  [${finding.kind}] ${finding.mechanism} ${finding.metric}: strong ${finding.strongDelta.toFixed(4)} / weak ${finding.weakDelta.toFixed(4)}`);
    }
  }
  return lines.join("\n");
}