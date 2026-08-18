import type { ExperimentConfig, ExperimentComparison, ExperimentReport, ExperimentVariant, ExperimentVariantResult } from "@ar/contracts";

/**
 * P2-9: experiment harness — runs mechanism variants and produces a
 * comparison report. The `runBenchmark` dep is injected so callers can
 * wire it to real benchmarks (benchmark-command.ts) or use the default
 * simulation for testing.
 */

export interface ExperimentHarnessDeps {
  runBenchmark?: (variant: ExperimentVariant, config: ExperimentConfig) => Promise<ExperimentVariantResult>;
}

/** Default benchmark: simulates a run with random metrics. */
async function defaultRunBenchmark(variant: ExperimentVariant, _config: ExperimentConfig): Promise<ExperimentVariantResult> {
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
  private readonly runBenchmark: (variant: ExperimentVariant, config: ExperimentConfig) => Promise<ExperimentVariantResult>;

  constructor(deps: ExperimentHarnessDeps = {}) {
    this.runBenchmark = deps.runBenchmark ?? defaultRunBenchmark;
  }

  async run(config: ExperimentConfig): Promise<ExperimentReport> {
    const startedAt = Date.now();
    const results: ExperimentVariantResult[] = [];

    for (const variant of config.variants) {
      try {
        const result = await this.runBenchmark(variant, config);
        results.push(result);
      } catch (cause) {
        results.push({
          variantName: variant.name,
          mechanism: variant.mechanism,
          status: "failed",
          metrics: {},
          error: String(cause),
          startedAt,
          durationMs: 0,
        });
      }
    }

    return {
      configId: config.id,
      description: config.description,
      results,
      comparisons: computeComparisons(config, results),
      startedAt,
      completedAt: Date.now(),
    };
  }
}

/** Compare every non-baseline variant against the baseline on shared metrics. */
export function computeComparisons(
  config: ExperimentConfig,
  results: ExperimentVariantResult[],
): ExperimentComparison[] {
  const baselineName = config.baseline ?? config.variants[0]!.name;
  const baseline = results.find((r) => r.variantName === baselineName);
  if (baseline === undefined) return [];

  const comparisons: ExperimentComparison[] = [];
  for (const result of results) {
    if (result.variantName === baselineName) continue;
    for (const metric of Object.keys(result.metrics)) {
      if (!(metric in baseline.metrics)) continue;
      const delta = (baseline.metrics[metric] ?? 0) - (result.metrics[metric] ?? 0);
      comparisons.push({
        variantA: baselineName,
        variantB: result.variantName,
        metric,
        delta,
        winner: null,
      });
    }
  }
  return comparisons;
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
    lines.push(`  ${statusIcon} ${result.variantName} (${result.mechanism}) — ${result.durationMs}ms`);
    if (result.error !== undefined) lines.push(`    error: ${result.error}`);
    for (const [key, value] of Object.entries(result.metrics)) {
      lines.push(`    ${key}: ${typeof value === "number" ? value.toFixed(2) : value}`);
    }
  }
  if (report.comparisons.length > 0) {
    lines.push("", "Comparisons (baseline delta):");
    for (const cmp of report.comparisons) {
      lines.push(`  ${cmp.variantA} vs ${cmp.variantB} — ${cmp.metric}: ${cmp.delta.toFixed(4)}`);
    }
  }
  return lines.join("\n");
}