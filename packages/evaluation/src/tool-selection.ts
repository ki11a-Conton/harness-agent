import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { scoreCost, type CostModelOptions, type CostResult } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";

/**
 * P3-4 — Dynamic Tool Selection Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). The hypothesis:
 * when the tool catalog is large, exposing only a task-relevant tool subset
 * (tool index → select relevant tools → expose subset) cuts per-run schema
 * tokens; the saved context budget lifts pass rate on long/context-hungry
 * tasks, while a deterministic selector still covers the tools a task needs.
 *
 * Two hard guards, matching plan.md P3-4 ("减少 schema token。安全边界不变。"):
 *  1. SAFETY SUBSET INVARIANT — the selected subset MUST always contain every
 *     safety-critical tool. A selection that omits one is a fail-closed
 *     violation (never silent): the subscript is rejected and must re-include it.
 *  2. COVERAGE-BASED PROMOTION — a subset that merely saves tokens while
 *     hurting pass rate (tool misses) is not promotable. Only promote when the
 *     token savings are material AND the pass rate does not regress (prefer an
 *     actual lift), AND the cost-model delta is positive.
 *
 * As with P3-1..P3-3, the challenger is a deterministic, seeded effect model
 * composed over the measured all-tools outcome — nothing is fabricated.
 */

/** Tool exposure policy variant. */
export type ToolExposurePolicy = "full_catalog" | "dynamic_subset";

/** A tool the runtime can expose. The selector may omit non-critical tools. */
export interface ToolDescriptor {
  name: string;
  /** Cue keywords / path patterns that signal this tool's relevance. */
  relatedCues: string[];
  /** Structural cue: which task-type families a tool serves (see P3-3 lanes). */
  servesTypes?: string[];
  /** Safety-critical tools can NEVER be omitted from any subset. */
  safetyCritical: boolean;
  /** Context cost of exposing this tool's schema. */
  schemaTokens: number;
}

/** Deterministic selector output for one task. */
export interface ToolSelection {
  caseId: string;
  /** Tools that ended up exposed. Ordered deterministically. */
  selected: string[];
  /** tools the subset omitted (for coverage accounting). */
  omitted: string[];
  /** schema-token cost of exposing `selected`. */
  schemaTokens: number;
  /** all-schema-token cost if the full catalog were exposed. */
  fullSchemaTokens: number;
  /** True when every safety-critical tool is present. Enforced fail-closed. */
  safetyComplete: boolean;
  /** True when the canonical "recovery/fallback" tools are still present
   *  (e.g. an exec/search escape-hatch) so a miss is recoverable. */
  hasFallback: boolean;
}

export interface ToolSet {
  tools: ToolDescriptor[];
  /** Tools that, if omitted, make a missed tool recoverable (escape hatch). */
  fallbackTools: string[];
}

/** Default tool catalog (illustrative). safety-critical ones are marked. */
export const DEFAULT_TOOL_CATALOG: ToolSet = {
  tools: [
    { name: "read_file", relatedCues: ["read", "open", "view"], servesTypes: ["coding", "debugging", "docs", "data", "research"], safetyCritical: true, schemaTokens: 120 },
    { name: "write_file", relatedCues: ["write", "edit", "create", "modify"], servesTypes: ["coding", "docs", "data"], safetyCritical: true, schemaTokens: 130 },
    { name: "edit_file", relatedCues: ["edit", "replace", "change"], servesTypes: ["coding", "debugging", "docs"], safetyCritical: true, schemaTokens: 140 },
    { name: "search", relatedCues: ["search", "find", "grep", "locate"], servesTypes: ["coding", "debugging", "research"], safetyCritical: true, schemaTokens: 110 },
    { name: "exec", relatedCues: ["run", "command", "test", "build", "execute"], servesTypes: ["coding", "debugging", "data"], safetyCritical: true, schemaTokens: 150 },
    { name: "verification", relatedCues: ["verify", "check", "assert", "test"], servesTypes: ["coding", "debugging"], safetyCritical: true, schemaTokens: 100 },
    { name: "query_dataset", relatedCues: ["csv", "dataset", "data", "query", "aggregate"], servesTypes: ["data"], safetyCritical: false, schemaTokens: 90 },
    { name: "render_docs", relatedCues: ["doc", "document", "render", "markdown"], servesTypes: ["docs"], safetyCritical: false, schemaTokens: 80 },
    { name: "web_fetch", relatedCues: ["fetch", "url", "http", "research", "search"], servesTypes: ["research"], safetyCritical: false, schemaTokens: 160 },
    { name: "translate", relatedCues: ["translate", "i18n", "locale"], servesTypes: ["docs"], safetyCritical: false, schemaTokens: 70 },
    { name: "sql_run", relatedCues: ["sql", "database", "select", "query", "table"], servesTypes: ["data"], safetyCritical: false, schemaTokens: 130 },
  ],
  fallbackTools: ["exec", "search"],
};

export const TOOL_SELECT_THRESHOLD = 1;

/**
 * Select the relevant tool subset. Scores each non-critical tool by cue hits
 * across the task text + fixture paths; a tool is included when its score
 * meets the threshold. Safety-critical tools are ALWAYS included. Returns a
 * fail-closed tool selection: if a safety-critical tool is somehow missing,
 * `safetyComplete` is false and the caller must reject the subset.
 */
export function selectRelevantTools(
  caseDef: Pick<EvalCase, "id"> & {
    task?: string;
    fixture?: Record<string, string>;
  },
  toolset: ToolSet = DEFAULT_TOOL_CATALOG,
  threshold = TOOL_SELECT_THRESHOLD,
): ToolSelection {
  const text = (caseDef.task ?? "").toLowerCase();
  const paths = Object.keys(caseDef.fixture ?? {});

  const selected: string[] = [];
  const omitted: string[] = [];
  let safetyComplete = true;

  for (const tool of toolset.tools) {
    if (tool.safetyCritical) {
      selected.push(tool.name);
      continue;
    }
    let score = 0;
    for (const cue of tool.relatedCues) {
      if (text.includes(cue)) score += 1;
    }
    for (const cue of tool.relatedCues) {
      if (paths.some((p) => p.toLowerCase().includes(cue))) score += 1;
    }
    if (score >= threshold) {
      selected.push(tool.name);
    } else {
      omitted.push(tool.name);
    }
  }

  // Fail-closed: every safety-critical tool must be present.
  for (const tool of toolset.tools) {
    if (tool.safetyCritical && !selected.includes(tool.name)) {
      safetyComplete = false;
    }
  }
  const fallbacks = toolset.fallbackTools.filter((name) => selected.includes(name));

  const full = toolset.tools.reduce((s, t) => s + t.schemaTokens, 0);
  let subset = 0;
  for (const tool of toolset.tools) {
    if (selected.includes(tool.name)) subset += tool.schemaTokens;
  }

  return {
    caseId: caseDef.id,
    selected: [...selected].sort(),
    omitted: [...omitted].sort(),
    schemaTokens: subset,
    fullSchemaTokens: full,
    safetyComplete,
    hasFallback: fallbacks.length > 0,
  };
}

/** Dynamic tool selection effect model — tunable experiment hypothesis. */
export interface ToolSelectionEffectModel {
  /** Fraction savings of schema tokens actually realized per run. */
  schemaSavingsReach: number; // 0..1 of the omitted-token delta realized
  /** Chance a needed-but-omitted tool actually causes a hard miss (uncalled). */
  missRate: number; // 0..1
  /** Extra tokens a miss on a non-critical tool costs (recovery / fallback). */
  missRecoveryTokens: number;
  /** Extra latency (ms) a miss costs. */
  missRecoveryLatencyMs: number;
  /** Pass-rate lift applied when schema savings materially relieve context. */
  contextLift: number; // 0..1, applied to context-heavy outcomes
  /** Context size above which savings are assumed to matter. */
  longContextThresholdTokens: number;
}

export const DEFAULT_TOOL_MODEL: ToolSelectionEffectModel = {
  schemaSavingsReach: 1,
  missRate: 0.06,
  missRecoveryTokens: 900,
  missRecoveryLatencyMs: 1200,
  contextLift: 0.08,
  longContextThresholdTokens: 24_000,
};

export interface ToolRunMetrics {
  caseId: string;
  policy: ToolExposurePolicy;
  schemaTokens: number;
  /** Full-catalog schema cost (savings are computed against this, never a
   *  policy-dependent value). */
  fullSchemaTokens: number;
  tokens: number;
  durationMs: number;
  missed: boolean; // a needed tool was omitted and caused rework
  safetyComplete: boolean;
  passed: boolean;
}

export interface ToolAggregate {
  policy: ToolExposurePolicy;
  passRate: number;
  schemaTokensTotal: number;
  schemaSavingsRatio: number;
  misses: number;
  safetyCompleteAll: boolean;
  totalTokens: number;
  totalDurationMs: number;
  costScore: number;
}

export interface ToolComparison {
  baseline: ToolAggregate;
  challenger: ToolAggregate;
  cases: ToolRunMetrics[];
  passDelta: number; // challenger - baseline pass rate
  schemaSavingsRatio: number;
  missedToolCount: number;
  tokenDeltaRatio: number;
  latencyDeltaRatio: number;
  costScoreDelta: number;
  decision: ToolDecisionSummary;
}

export type ToolDecisionCode =
  | "promote"
  | "safety_invariant_failed"
  | "no_lift"
  | "coverage_regression"
  | "savings_trivial"
  | "cost_negative";

export interface ToolDecisionSummary {
  promote: boolean;
  code: ToolDecisionCode;
  reason: string;
  minimumPassLift: number;
  minimumSchemaSavings: number;
  maxMissRatio: number;
}

export interface RunToolSelectionOptions {
  toolset?: ToolSet;
  model?: Partial<ToolSelectionEffectModel>;
  cost?: CostModelOptions;
  seed?: number;
  gate?: {
    minimumPassLift?: number;
    minimumSchemaSavings?: number;
    maxMissRatio?: number;
  };
}

function resolveToolModel(partial?: Partial<ToolSelectionEffectModel>): ToolSelectionEffectModel {
  const m = DEFAULT_TOOL_MODEL;
  return {
    schemaSavingsReach: partial?.schemaSavingsReach ?? m.schemaSavingsReach,
    missRate: partial?.missRate ?? m.missRate,
    missRecoveryTokens: partial?.missRecoveryTokens ?? m.missRecoveryTokens,
    missRecoveryLatencyMs: partial?.missRecoveryLatencyMs ?? m.missRecoveryLatencyMs,
    contextLift: partial?.contextLift ?? m.contextLift,
    longContextThresholdTokens: partial?.longContextThresholdTokens ?? m.longContextThresholdTokens,
  };
}

/**
 * Simulate an exposure-policy run. `full_catalog` is the identity champion
 * (no omitted tools, full schema cost, baseline pass). `dynamic_subset` applies
 * the selected subset: schema tokens drop, and each run may pay a miss
 * (omitted tool needed → rework) or receive a context lift on long tasks.
 * Safety-completeness is carried through and, if ever violated, marks a hard
 * failure. Seeded for reproducibility.
 */
export function simulateToolSelectionRun(
  outcome: EvalOutcome,
  selection: ToolSelection,
  policy: ToolExposurePolicy,
  options: { model?: Partial<ToolSelectionEffectModel>; seed?: number } = {},
): ToolRunMetrics {
  const model = resolveToolModel(options.model);
  const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 5);

  let tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
  const contextTokens =
    outcome.metrics.tokens_input + outcome.metrics.context_tokens;

  if (policy === "full_catalog") {
    return {
      caseId: outcome.caseId,
      policy,
      schemaTokens: selection.fullSchemaTokens,
      fullSchemaTokens: selection.fullSchemaTokens,
      tokens,
      durationMs: outcome.metrics.duration_ms,
      missed: false,
      safetyComplete: selection.safetyComplete,
      passed: outcome.status === "passed",
    };
  }

  // Challenger: equal initial pass as baseline, then apply subset effects.
  let passed = outcome.status === "passed";
  let schemaTokens = selection.schemaTokens;
  let durationMs = outcome.metrics.duration_ms;
  let missed = false;

  // Safety invariant: a safety-incomplete subset is a hard fail.
  if (!selection.safetyComplete) {
    return {
      caseId: outcome.caseId,
      policy,
      schemaTokens,
      fullSchemaTokens: selection.fullSchemaTokens,
      tokens,
      durationMs,
      missed: true,
      safetyComplete: false,
      passed: false,
    };
  }

  // Context lift on long tasks when a material fraction is saved.
  const savingsRatio =
    selection.fullSchemaTokens <= 0
      ? 0
      : (selection.fullSchemaTokens - selection.schemaTokens) * model.schemaSavingsReach /
        selection.fullSchemaTokens;
  const relieved = savingsRatio > 0 && contextTokens >= model.longContextThresholdTokens;
  if (relieved && !passed && random() < model.contextLift) {
    passed = true;
  }

  // A miss on an omitted tool costs recovery tokens/latency and can break pass.
  const omittedCount = selection.omitted.length;
  if (omittedCount > 0 && random() < model.missRate) {
    missed = true;
    // recovery eats tokens/latency; on a long task this may flip a pass to fail
    tokens += model.missRecoveryTokens;
    durationMs += model.missRecoveryLatencyMs;
    if (passed && selection.omitted.includes(selection.omitted[0]!)) {
      passed = false;
    }
  }

  return {
    caseId: outcome.caseId,
    policy,
    schemaTokens,
    fullSchemaTokens: selection.fullSchemaTokens,
    tokens,
    durationMs,
    missed,
    safetyComplete: true,
    passed,
  };
}

export function aggregateToolSelection(
  runs: ToolRunMetrics[],
  policy: ToolExposurePolicy,
  cost?: CostModelOptions,
): ToolAggregate {
  const passed = runs.filter((r) => r.passed).length;
  const schemaTokensTotal = runs.reduce((s, r) => s + r.schemaTokens, 0);
  const fullSchemaTokensTotal = runs.reduce((s, r) => s + r.fullSchemaTokens, 0);
  const costResult: CostResult = scoreCost(
    {
      status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
      violations: runs.some((r) => !r.safetyComplete) ? ["tool_selection_safety_invariant"] : [],
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
    policy,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    schemaTokensTotal,
    schemaSavingsRatio:
      fullSchemaTokensTotal > 0
        ? 1 - schemaTokensTotal / fullSchemaTokensTotal
        : 0,
    misses: runs.filter((r) => r.missed).length,
    safetyCompleteAll: runs.every((r) => r.safetyComplete),
    totalTokens: runs.reduce((s, r) => s + r.tokens, 0),
    totalDurationMs: runs.reduce((s, r) => s + r.durationMs, 0),
    costScore: costResult.score,
  };
}

interface ToolGateInput {
  passDelta: number;
  schemaSavingsRatio: number;
  missRatio: number;
  safetyComplete: boolean;
  costScoreDelta: number;
  gate?: {
    minimumPassLift?: number;
    minimumSchemaSavings?: number;
    maxMissRatio?: number;
  };
}

export function decideToolSelectionPromotion(input: ToolGateInput): ToolDecisionSummary {
  const minimumPassLift = input.gate?.minimumPassLift ?? 0; // default: no regression required
  const minimumSchemaSavings = input.gate?.minimumSchemaSavings ?? 0.1;
  const maxMissRatio = input.gate?.maxMissRatio ?? 0.3;

  if (!input.safetyComplete) {
    return {
      promote: false,
      code: "safety_invariant_failed",
      reason: "rejected: a selected subset omitted a safety-critical tool; the safety subset invariant is absolute (安全边界不变)",
      minimumPassLift,
      minimumSchemaSavings,
      maxMissRatio,
    };
  }
  if (input.schemaSavingsRatio < minimumSchemaSavings) {
    return {
      promote: false,
      code: "savings_trivial",
      reason: `rejected: schema-token savings ${round(input.schemaSavingsRatio)} < ${minimumSchemaSavings}; a subset that barely saves context is not worth the miss risk`,
      minimumPassLift,
      minimumSchemaSavings,
      maxMissRatio,
    };
  }
  if (input.passDelta < minimumPassLift) {
    return {
      promote: false,
      code: "no_lift",
      reason: `rejected: pass-rate delta ${round(input.passDelta)} < ${minimumPassLift}; subset offered token savings but no quality benefit`,
      minimumPassLift,
      minimumSchemaSavings,
      maxMissRatio,
    };
  }
  if (input.missRatio > maxMissRatio) {
    return {
      promote: false,
      code: "coverage_regression",
      reason: `rejected: tool-miss ratio ${round(input.missRatio, 3)} exceeds tolerance ${maxMissRatio}; the subset dropped too many needed tools`,
      minimumPassLift,
      minimumSchemaSavings,
      maxMissRatio,
    };
  }
  if (input.costScoreDelta <= 0) {
    return {
      promote: false,
      code: "cost_negative",
      reason: `rejected: cost-model delta ${round(input.costScoreDelta)} is not positive`,
      minimumPassLift,
      minimumSchemaSavings,
      maxMissRatio,
    };
  }
  return {
    promote: true,
    code: "promote",
    reason: `promote: schema savings ${round(input.schemaSavingsRatio)} (≥ ${minimumSchemaSavings}), pass delta ${round(input.passDelta)} (≥ ${minimumPassLift}), miss ratio ${round(input.missRatio, 3)} (≤ ${maxMissRatio}), cost +${round(input.costScoreDelta)}`,
    minimumPassLift,
    minimumSchemaSavings,
    maxMissRatio,
  };
}

/** Run the Dynamic Tool Selection experiment end-to-end. */
export async function runToolSelectionExperiment(
  cases: EvalCase[],
  runWorker: (caseDef: EvalCase) => Promise<EvalOutcome>,
  options: RunToolSelectionOptions = {},
): Promise<ToolComparison> {
  const baseline: ToolRunMetrics[] = [];
  const challenger: ToolRunMetrics[] = [];

  for (const caseDef of cases) {
    const outcome = await runWorker(caseDef);
    const selection = selectRelevantTools(caseDef, options.toolset);
    baseline.push(
      simulateToolSelectionRun(outcome, selection, "full_catalog", {
        model: options.model,
        seed: options.seed,
      }),
    );
    challenger.push(
      simulateToolSelectionRun(outcome, selection, "dynamic_subset", {
        model: options.model,
        seed: options.seed,
      }),
    );
  }

  const baselineAgg = aggregateToolSelection(baseline, "full_catalog", options.cost);
  const challengerAgg = aggregateToolSelection(challenger, "dynamic_subset", options.cost);

  const tokenDeltaRatio =
    baselineAgg.totalTokens === 0
      ? 0
      : (challengerAgg.totalTokens - baselineAgg.totalTokens) / baselineAgg.totalTokens;
  const latencyDeltaRatio =
    baselineAgg.totalDurationMs === 0
      ? 0
      : (challengerAgg.totalDurationMs - baselineAgg.totalDurationMs) / baselineAgg.totalDurationMs;

  const decision = decideToolSelectionPromotion({
    passDelta: challengerAgg.passRate - baselineAgg.passRate,
    schemaSavingsRatio: challengerAgg.schemaSavingsRatio,
    missRatio:
      challengerAgg.misses === 0
        ? 0
        : challengerAgg.misses / Math.max(1, challenger.length),
    safetyComplete: challengerAgg.safetyCompleteAll,
    costScoreDelta: challengerAgg.costScore - baselineAgg.costScore,
    gate: options.gate,
  });

  return {
    baseline: baselineAgg,
    challenger: challengerAgg,
    cases: challenger,
    passDelta: challengerAgg.passRate - baselineAgg.passRate,
    schemaSavingsRatio: challengerAgg.schemaSavingsRatio,
    missedToolCount: challengerAgg.misses,
    tokenDeltaRatio,
    latencyDeltaRatio,
    costScoreDelta: challengerAgg.costScore - baselineAgg.costScore,
    decision,
  };
}

export function renderToolComparison(cmp: ToolComparison): string {
  return [
    "Dynamic Tool Selection Experiment",
    `cases: ${cmp.cases.length}`,
    `decision: ${cmp.decision.promote ? "PROMOTE" : "REJECT"} (${cmp.decision.code})`,
    cmp.decision.reason,
    "",
    `  pass rate                   ${round(cmp.baseline.passRate, 3)} → ${round(cmp.challenger.passRate, 3)}  (Δ ${round(cmp.passDelta, 3)})`,
    `  schema tokens               ${cmp.baseline.schemaTokensTotal} → ${cmp.challenger.schemaTokensTotal}  (Δ ${round(cmp.schemaSavingsRatio * 100, 1)}% saved)`,
    `  tool misses / safety        ${cmp.missedToolCount} / ${cmp.challenger.safetyCompleteAll ? "complete" : "VIOLATED"}`,
    `  tokens                      ${cmp.baseline.totalTokens} → ${cmp.challenger.totalTokens}  (Δ ${round(cmp.tokenDeltaRatio * 100, 1)}%)`,
    `  latency (ms)                ${cmp.baseline.totalDurationMs} → ${cmp.challenger.totalDurationMs}  (Δ ${round(cmp.latencyDeltaRatio * 100, 1)}%)`,
    `  cost score                  ${cmp.baseline.costScore.toFixed(3)} → ${cmp.challenger.costScore.toFixed(3)}  (Δ ${round(cmp.costScoreDelta, 3)})`,
  ].join("\n");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}