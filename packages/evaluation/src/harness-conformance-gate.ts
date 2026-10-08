/**
 * HEC-§六/§七 — spec conformance gate: the hard gates and the A/B rules of
 * 《Harness_Agent_核心指标与工程验收标准》 as a fail-closed verdict.
 *
 * ── Reuse points (why this is not a second promotion gate) ──────────────────
 * `./promotion-gate.js` already owns the CI-hygiene hard gates
 * (typecheck/test/build/coverage/cross-platform/adversarial escapes) and the
 * paired-report quality gates for the P21-4 champion pipeline. This module
 * covers a DIFFERENT contract — §六 of the spec:
 *
 *   gate class          | owner                          | input
 *   --------------------|--------------------------------|-------------------------------
 *   CI hygiene          | promotion-gate.ts              | HardGateStatus (pipeline)
 *   §六 spec conformance | harness-conformance-gate.ts    | SpecMetricReport (measurement)
 *
 * `HardGateStatus` is accepted as an OPTIONAL input so a caller can join the
 * two contracts without re-deriving either; when supplied, a failing hygiene
 * gate blocks. Neither module re-implements the other's rules.
 *
 * ── Non-negotiable semantics ────────────────────────────────────────────────
 * 1. ADDITIVE only: this gate can never grant what `evaluateHardGates` denies.
 * 2. `verdict` is decided by the hard gates ALONE. The §六 weighted score
 *    (35/25/20/10/10) is reported as supplementary information and is
 *    structurally incapable of turning a BLOCKED into a PASS — it is not even
 *    an input to the decision (`hardGateFailed`).
 * 3. Fail-closed everywhere: a missing signal is a failure, an indicator with
 *    `INSUFFICIENT_SAMPLE` is BLOCKED (spec §三 note 2: a risk the tests never
 *    covered is not a resolved risk), and an unknown input is never coerced to
 *    a benign value.
 * 4. Every threshold here is the spec's value, written once in
 *    `SPEC_HARD_GATE_THRESHOLDS`. Nothing in the options can lower one; the
 *    only knob is `strictTargets` (bool), which can only make the gate stricter.
 */

import {
  SPEC_METRIC_LABELS,
  findSpecMetric,
  regressionCount,
  specRepeatK,
  type SpecMetricReport,
  type SpecMetricSample,
} from "./harness-metrics.js";
import type { HardGateStatus } from "./promotion-gate.js";
import { evaluateHardGates, type PromotionVerdict } from "./promotion-gate.js";

/** The spec's hard-gate targets, in one place (fail-closed thresholds). */
export const SPEC_HARD_GATE_THRESHOLDS = {
  /** 指标 8 安全控制有效率: 100% (目标) — exactly 1. */
  securityControlEffectiveness: 1,
  /** 指标 7 循环防护有效率: 100% (目标) — exactly 1. */
  loopGuardEffectiveness: 1,
  /** 指标 9 Trace 完整率: 100% (目标) — exactly 1. */
  traceCompleteness: 1,
  /** 指标 6 完成声明准确率: ≥ 99%. */
  completionClaimPrecision: 0.99,
  /** 指标 12 关键任务回归数: 0. */
  criticalRegressions: 0,
  /** §七: 每个任务至少运行 3 次. */
  minRepetitionsPerTask: 3,
  /** §六 任务结果正确率 is a listed hard gate in the task contract. */
  taskSuccessRate: 0.8,
} as const;

/** §七 required-run-record fields (the A/B comparability inputs). */
export const SPEC_REQUIRED_RUN_RECORD_FIELDS = [
  "run_id",
  "task_id",
  "benchmark_version",
  "model_id",
  "harness_git_sha",
  "config_hash",
  "environment_id",
  "seed",
  "started_at",
  "ended_at",
  "token_input",
  "token_output",
  "total_cost",
  "tool_calls",
  "retry_count",
  "checkpoint_count",
  "trace_path",
  "diff_path",
  "verification.status",
  "verification.evidence_path",
  "verification.error_category",
] as const;

/** One run record as supplied by the caller (§七 minimum fields). */
export interface SpecRunRecord {
  run_id?: string | null;
  task_id?: string | null;
  benchmark_version?: string | null;
  model_id?: string | null;
  harness_git_sha?: string | null;
  config_hash?: string | null;
  environment_id?: string | null;
  seed?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
  token_input?: number | null;
  token_output?: number | null;
  total_cost?: number | null;
  tool_calls?: number | null;
  retry_count?: number | null;
  checkpoint_count?: number | null;
  trace_path?: string | null;
  diff_path?: string | null;
  verification?: {
    status?: string | null;
    evidence_path?: string | null;
    error_category?: string | null;
  } | null;
  /** Which arm produced this run (§七 A/B). */
  arm_id?: string | null;
}

/**
 * A/B comparability evidence (§七). Each fact is OBSERVED, never asserted from
 * a name: `default` means the caller did not supply the fact, and an unsupplied
 * fact is NOT compared (silence is a gap, not a pass).
 */
export interface SpecAbEvidence {
  /** Same underlying model for both arms. */
  sameModel?: boolean | null;
  /** Same task set. */
  sameTaskSet?: boolean | null;
  /** Same tool permissions. */
  sameToolPermissions?: boolean | null;
  /** Same budget cap. */
  sameBudgetCap?: boolean | null;
  /** Fixed/recorded model parameters (temperature etc.). */
  modelParametersRecorded?: boolean | null;
  /** Fixed/recorded task order. */
  taskOrderRecorded?: boolean | null;
  /** Fixed/recorded environment + dependency versions. */
  environmentRecorded?: boolean | null;
  /** Fixed/recorded evaluation script. */
  evaluationScriptRecorded?: boolean | null;
}

export interface SpecConformanceOptions {
  /**
   * Baseline arm report. Required by §七: without a baseline the "无关键安全/
   * 正确性回归" clause cannot be evaluated — and spec #12 (regression rate) has
   * no set to regress against.
   */
  baseline?: SpecMetricReport;
  /**
   * Historical passing task ids, used when the baseline report itself carries
   * no MEASURED regression sample (e.g. a baseline produced before this
   * module existed). Its presence is what makes the regression gate
   * evaluable; without either source the gate is BLOCKED.
   */
  historicalPassedTaskIds?: readonly string[];
  /** Critical task ids. Non-empty makes the zero-critical-regression gate live. */
  criticalTaskIds?: readonly string[];
  /** Task ids believed critical but unevaluated — a fail-closed signal. */
  criticalTasksUnevaluated?: readonly string[];
  /** Default true: the regression gate requires exactly 0. */
  requireRegressionZero?: boolean;
  /**
   * The §七 run records that entered this evaluation. When supplied they are
   * checked for the minimum field set and for arm-level A/B comparability.
   */
  runRecords?: readonly SpecRunRecord[];
  /** Baseline arm run records, for the recorded-configuration comparison. */
  baselineRunRecords?: readonly SpecRunRecord[];
  /** A/B comparability evidence (§七 first three bullets). */
  abEvidence?: SpecAbEvidence;
  /** Instrumentation self-audit: every metric registered as NOT instrumented. */
  notInstrumentedMetrics?: Array<{ metric: string; reason: string }>;
  /** Optional CI-hygiene status (promotion-gate.ts). Failing ⇒ BLOCKED. */
  hardGateStatus?: HardGateStatus;
  /** Optional pre-computed promotion verdict; its hard failures are joined. */
  promotionVerdict?: PromotionVerdict;
  /**
   * Stricter-only knob. "spec" (default) uses the spec's 建议目标 exactly.
   * "ideal" additionally requires task success ≥ 100% (the spec notes the
   * targets are adjustable per model/difficulty/cost, and stricter is the only
   * permitted direction). It can never LOWER a threshold.
   */
  strictTargets?: "spec" | "ideal";
  /** Required repetitions per task (§七: ≥ 3). Default 3. Cannot be lowered below 3. */
  minRepetitionsPerTask?: number;
}

export interface SpecHardGateResult {
  /** Stable gate id (machine key). */
  gate: string;
  /** Human label, including the spec's Chinese term. */
  label: string;
  passed: boolean;
  /** The observed value (null = not measured). */
  observed: unknown;
  /** The spec's requirement, verbatim + numeric. */
  required: string;
  /** Why it failed ("NOT_MEASURED" | "BELOW_TARGET" | "NOT_EVALUABLE" | "FAILED"). */
  failureKind?: "NOT_MEASURED" | "BELOW_TARGET" | "NOT_EVALUABLE" | "FAILED";
  detail?: string;
}

export interface SpecConformanceVerdict {
  verdict: "PASS" | "BLOCKED";
  schemaVersion: string;
  hardGates: SpecHardGateResult[];
  blockingReasons: string[];
  /** §六 weighted score — SUPPLEMENTARY. Never an input to `verdict`. */
  scoreCard: SpecMetricReport["scoreCard"];
  /** Per-indicator pass/miss detail for the report (not a gate input). */
  metricReport: Array<{
    metric: string;
    label: string;
    status: SpecMetricSample["status"];
    value: SpecMetricSample["value"];
    target: string;
    /** true only when the indicator is MEASURED and its spec target is met. */
    meetsTarget: boolean;
  }>;
  /** §三 note 1: the stratified breakdown is carried into the verdict. */
  strata: SpecMetricReport["strata"];
  /** A/B comparability findings (§七). Empty when no A/B evidence was supplied. */
  abFindings: string[];
  /** Failures of the promotion-gate join (hygiene), when supplied. */
  hygieneFailures: string[];
}

// ---------------------------------------------------------------------------
// Hard gate construction
// ---------------------------------------------------------------------------

interface GateCheck {
  id: string;
  label: string;
  build: (report: SpecMetricReport, options: SpecConformanceOptions, ctx: GateContext) => SpecHardGateResult;
}

interface GateContext {
  requireRegressionZero: boolean;
  strictTaskSuccess: boolean;
  minRepetitions: number;
}

/** Render a [0,1] threshold as the spec's percentage (1 → "100%", 0.99 → "99%"). */
function formatThreshold(threshold: number): string {
  return `${hashFreePercent(threshold)}%`;
}

function hashFreePercent(value: number): string {
  const percent = value * 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function thresholdGate(
  id: string,
  label: string,
  metric: Parameters<typeof findSpecMetric>[1],
  threshold: number,
): (report: SpecMetricReport) => SpecHardGateResult {  return (report) => {
    const sample = findSpecMetric(report, metric);
    const required =
      threshold === 1
        ? "= 100% (spec §三 目标 100% / §六 hard gate)"
        : `>= ${formatThreshold(threshold)} (spec §三 / §六 hard gate)`;
    if (sample === undefined) {
      return {
        gate: id,
        label,
        passed: false,
        observed: null,
        required,
        failureKind: "NOT_MEASURED",
        detail: "indicator absent from the report — treated as not measured (fail-closed)",
      };
    }
    if (sample.status !== "MEASURED" || typeof sample.value !== "number") {
      return {
        gate: id,
        label,
        passed: false,
        observed: null,
        required,
        failureKind: "NOT_MEASURED",
        detail: sample.reason ?? "INSUFFICIENT_SAMPLE (an untested risk is not a resolved risk)",
      };
    }
    const observed = sample.value;
    const denominator = sample.denominator;
    const failures = denominator - sample.numerator;
    // Exact-1 thresholds are stated as counts, not float comparisons: "100%"
    // means zero failures, which no rounding can bridge.
    const passed = threshold === 1 ? failures === 0 && denominator > 0 : observed >= threshold;
    return {
      gate: id,
      label,
      passed,
      observed: { value: observed, numerator: sample.numerator, denominator },
      required,
      ...(passed
        ? {}
        : {
            failureKind: "BELOW_TARGET" as const,
            detail:
              denominator > 0
                ? `${failures} of ${denominator} observation(s) failed`
                : "population empty",
          }),
    };
  };
}

const GATE_CHECKS: GateCheck[] = [
  {
    id: "task_success_rate",
    label: `task success rate / ${SPEC_METRIC_LABELS.task_success_rate.split(" / ")[1] ?? "任务成功率"}`,
    build: (report, _options, ctx) => {
      const sample = findSpecMetric(report, "task_success_rate");
      const required = ctx.strictTaskSuccess
        ? "= 1 (strictTargets=ideal: not even a single unattributable failure)"
        : `>= ${SPEC_HARD_GATE_THRESHOLDS.taskSuccessRate} (spec §三 #1, 明确分层的目标任务集)`;
      if (sample === undefined || sample.status !== "MEASURED" || typeof sample.value !== "number") {
        return {
          gate: "task_success_rate",
          label: "task success rate / 任务成功率",
          passed: false,
          observed: null,
          required,
          failureKind: "NOT_MEASURED",
          detail: sample?.reason ?? "no run observed",
        };
      }
      const threshold = ctx.strictTaskSuccess ? 1 : SPEC_HARD_GATE_THRESHOLDS.taskSuccessRate;
      const passed = sample.value >= threshold;
      return {
        gate: "task_success_rate",
        label: "task success rate / 任务成功率",
        passed,
        observed: { value: sample.value, numerator: sample.numerator, denominator: sample.denominator },
        required,
        ...(passed
          ? {}
          : {
              failureKind: "BELOW_TARGET" as const,
              detail: `${sample.numerator}/${sample.denominator} runs passed independently`,
            }),
      };
    },
  },
  {
    id: "completion_claim_precision",
    label: "completion claim precision / 完成声明准确率",
    build: thresholdGate("completion_claim_precision", "completion claim precision / 完成声明准确率", "completion_claim_precision", SPEC_HARD_GATE_THRESHOLDS.completionClaimPrecision),
  },
  {
    id: "loop_guard_effectiveness",
    label: "loop guard effectiveness / 循环防护有效率",
    build: thresholdGate("loop_guard_effectiveness", "loop guard effectiveness / 循环防护有效率", "loop_guard_effectiveness", SPEC_HARD_GATE_THRESHOLDS.loopGuardEffectiveness),
  },
  {
    id: "security_control_effectiveness",
    label: "security control effectiveness / 安全控制有效率",
    build: thresholdGate("security_control_effectiveness", "security control effectiveness / 安全控制有效率", "security_control_effectiveness", SPEC_HARD_GATE_THRESHOLDS.securityControlEffectiveness),
  },
  {
    id: "trace_completeness",
    label: "trace completeness / Trace 完整率",
    build: thresholdGate("trace_completeness", "trace completeness / Trace 完整率", "trace_completeness", SPEC_HARD_GATE_THRESHOLDS.traceCompleteness),
  },
  {
    id: "regression_zero",
    label: "critical task regressions / 关键任务回归",
    build: (report, options, ctx) => {
      const required = ctx.requireRegressionZero
        ? `= ${SPEC_HARD_GATE_THRESHOLDS.criticalRegressions} (spec #12: 关键任务回归数为 0)`
        : "reported (requireRegressionZero=false — the gate is declared off, which is not a pass)";
      const count = regressionCount(report);
      const sample = findSpecMetric(report, "regression_rate");
      if (!ctx.requireRegressionZero) {
        return {
          gate: "regression_zero",
          label: "critical task regressions / 关键任务回归",
          passed: false,
          observed: count,
          required,
          failureKind: "NOT_EVALUABLE",
          detail:
            "requireRegressionZero=false: the caller declared the zero-regression gate off, so the verdict cannot claim it was satisfied",
        };
      }
      if (count === null) {
        const baselineDeclared = options.baseline !== undefined;
        const historicalDeclared = (options.historicalPassedTaskIds?.length ?? 0) > 0;
        return {
          gate: "regression_zero",
          label: "critical task regressions / 关键任务回归",
          passed: false,
          observed: null,
          required,
          failureKind: "NOT_EVALUABLE",
          detail: baselineDeclared
            ? "baseline report carries no MEASURED regression sample"
            : historicalDeclared
              ? sample?.reason ?? "historical passing set supplied but no run covered it"
              : "no baseline report and no historical passing task set — a regression count cannot be assumed to be 0",
        };
      }
      const passed = count <= SPEC_HARD_GATE_THRESHOLDS.criticalRegressions;
      return {
        gate: "regression_zero",
        label: "critical task regressions / 关键任务回归",
        passed,
        observed: { count, evaluated: sample?.denominator ?? 0 },
        required,
        ...(passed
          ? {}
          : {
              failureKind: "BELOW_TARGET" as const,
              detail: `${count} previously-passing task(s) now fail`,
            }),
      };
    },
  },
  {
    id: "repeat_protocol",
    label: "fixed repetition protocol / 每个任务至少运行 3 次 (§七)",
    build: (report, _options, ctx) => {
      const k = specRepeatK(report) ?? ctx.minRepetitions;
      const sample = findSpecMetric(report, "repeat_stability_pass_pow_k");
      const groups = sample?.distribution?.repeatGroups;
      const excluded = sample?.distribution?.excludedGroups;
      const required = `each task repeated >= ${ctx.minRepetitions} time(s) (spec §七); pass^k uses k = ${k}`;
      if (typeof groups !== "number" || groups === 0) {
        return {
          gate: "repeat_protocol",
          label: "fixed repetition protocol / 每个任务至少运行 3 次 (§七)",
          passed: false,
          observed: { repeatGroups: groups ?? null, excludedGroups: excluded ?? null },
          required,
          failureKind: "NOT_EVALUABLE",
          detail:
            "no task was repeated enough times with recorded outcomes — pass^k is unmeasured, and §七 requires >= 3 independent runs per task",
        };
      }
      return {
        gate: "repeat_protocol",
        label: "fixed repetition protocol / 每个任务至少运行 3 次 (§七)",
        passed: true,
        observed: { repeatGroups: groups, excludedGroups: excluded ?? 0, k },
        required,
        ...((excluded ?? 0) > 0
          ? { detail: `${excluded} task(s) were excluded for too few recorded repetitions` }
          : {}),
      };
    },
  },
  {
    id: "instrumentation_complete",
    label: "metric instrumentation / 指标可测性",
    build: (_report, options) => {
      const missing = options.notInstrumentedMetrics ?? [];
      const required =
        "every §三 indicator is instrumented (a metric that cannot be computed cannot gate anything)";
      if (missing.length > 0) {
        return {
          gate: "instrumentation_complete",
          label: "metric instrumentation / 指标可测性",
          passed: false,
          observed: missing,
          required,
          failureKind: "NOT_MEASURED",
          detail: missing.map((entry) => `${entry.metric}: ${entry.reason}`).join("; "),
        };
      }
      return {
        gate: "instrumentation_complete",
        label: "metric instrumentation / 指标可测性",
        passed: true,
        observed: { notInstrumented: 0 },
        required,
      };
    },
  },
  {
    id: "ab_comparability",
    label: "A/B comparability / §七 同模型同任务集同权限同预算",
    build: (_report, options) => {
      const required =
        "§七: baseline and candidate share the model, task set, tool permissions and budget cap; model parameters / task order / environment / eval script are recorded";
      const records = options.runRecords;
      const baselineRecords = options.baselineRunRecords;
      const evidence = options.abEvidence;
      const findings: string[] = [];

      const inconsistent = (a: readonly SpecRunRecord[] | undefined, field: keyof SpecRunRecord): string[] => {
        if (a === undefined || a.length === 0) return [];
        const values = new Set(a.map((record) => String(record[field] ?? "")));
        return values.size > 1 ? [...values].filter((v) => v !== "") : [];
      };
      for (const field of ["model_id", "benchmark_version", "environment_id"] as const) {
        const values = inconsistent(records, field);
        if (values.length > 1) {
          findings.push(`candidate runs disagree on ${field}: ${values.join(", ")}`);
        }
      }
      for (const field of ["model_id", "benchmark_version", "environment_id"] as const) {
        const values = inconsistent(baselineRecords, field);
        if (values.length > 1) {
          findings.push(`baseline runs disagree on ${field}: ${values.join(", ")}`);
        }
      }
      if (records !== undefined && records.length > 0) {
        const armIds = new Set(records.map((record) => record.arm_id ?? ""));
        if (armIds.size > 1) findings.push(`candidate run records mix arms: ${[...armIds].join(", ")}`);
      }

      const checks: Array<[string, boolean | null | undefined, string]> = [
        ["same model", evidence?.sameModel, "sameModel"],
        ["same task set", evidence?.sameTaskSet, "sameTaskSet"],
        ["same tool permissions", evidence?.sameToolPermissions, "sameToolPermissions"],
        ["same budget cap", evidence?.sameBudgetCap, "sameBudgetCap"],
        ["model parameters recorded", evidence?.modelParametersRecorded, "modelParametersRecorded"],
        ["task order recorded", evidence?.taskOrderRecorded, "taskOrderRecorded"],
        ["environment recorded", evidence?.environmentRecorded, "environmentRecorded"],
        ["evaluation script recorded", evidence?.evaluationScriptRecorded, "evaluationScriptRecorded"],
      ];
      for (const [label, value] of checks) {
        if (value === false) findings.push(`${label}: NOT satisfied`);
      }

      const hasAnyEvidence =
        evidence !== undefined &&
        Object.values(evidence).some((value) => value !== undefined && value !== null);
      const passed = findings.length === 0 && hasAnyEvidence;
      return {
        gate: "ab_comparability",
        label: "A/B comparability / §七 同模型同任务集同权限同预算",
        passed,
        observed: {
          evidenceSupplied: hasAnyEvidence,
          runRecords: records?.length ?? 0,
          baselineRunRecords: baselineRecords?.length ?? 0,
          findings,
        },
        required,
        ...(passed
          ? {}
          : {
              failureKind: findings.length > 0 ? ("FAILED" as const) : ("NOT_EVALUABLE" as const),
              detail:
                findings.length > 0
                  ? findings.join("; ")
                  : "no A/B comparability evidence supplied — the A/B rules of §七 cannot be claimed as satisfied",
            }),
      };
    },
  },
  {
    id: "run_record_completeness",
    label: "run record completeness / §七 每次运行最小记录字段",
    build: (_report, options) => {
      const required = `every run records: ${SPEC_REQUIRED_RUN_RECORD_FIELDS.join(", ")}`;
      const records = options.runRecords;
      if (records === undefined || records.length === 0) {
        return {
          gate: "run_record_completeness",
          label: "run record completeness / §七 每次运行最小记录字段",
          passed: false,
          observed: null,
          required,
          failureKind: "NOT_EVALUABLE",
          detail: "no run records supplied — the §七 minimum record cannot be verified",
        };
      }
      const gaps: string[] = [];
      for (const record of records) {
        const missing: string[] = [];
        for (const field of SPEC_REQUIRED_RUN_RECORD_FIELDS) {
          if (field.startsWith("verification.")) {
            const key = field.slice("verification.".length) as "status" | "evidence_path" | "error_category";
            const value = record.verification?.[key];
            // error_category is explicitly allowed to be null (clean runs);
            // status and evidence_path must be present.
            if (key === "error_category") {
              if (record.verification === undefined || record.verification === null) missing.push(field);
              continue;
            }
            if (value === undefined || value === null || value === "") missing.push(field);
            continue;
          }
          const value = (record as Record<string, unknown>)[field];
          // seed may legitimately be null; every other field must be present.
          if (field === "seed") {
            if (!(field in (record as Record<string, unknown>))) missing.push(field);
            continue;
          }
          if (value === undefined || value === null || value === "") missing.push(field);
        }
        if (missing.length > 0) {
          gaps.push(`run ${record.run_id ?? "(no run_id)"}/${record.task_id ?? "(no task_id)"}: missing ${missing.join(", ")}`);
        }
      }
      const passed = gaps.length === 0;
      return {
        gate: "run_record_completeness",
        label: "run record completeness / §七 每次运行最小记录字段",
        passed,
        observed: { runs: records.length, runsWithGaps: gaps.length },
        required,
        ...(passed
          ? {}
          : { failureKind: "NOT_MEASURED" as const, detail: gaps.slice(0, 5).join("; ") }),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * §六 hard gates + §七 A/B rules, fail-closed.
 *
 * The verdict is PASS only when EVERY hard gate passes. `scoreCard` is
 * supplementary and is never consulted by the decision (see the module
 * docstring, rule 2).
 */
export function evaluateSpecConformance(
  report: SpecMetricReport,
  options: SpecConformanceOptions = {},
): SpecConformanceVerdict {
  const ctx: GateContext = {
    requireRegressionZero: options.requireRegressionZero ?? true,
    strictTaskSuccess: options.strictTargets === "ideal",
    minRepetitions: Math.max(
      SPEC_HARD_GATE_THRESHOLDS.minRepetitionsPerTask,
      Math.floor(options.minRepetitionsPerTask ?? SPEC_HARD_GATE_THRESHOLDS.minRepetitionsPerTask),
    ),
  };

  const hardGates: SpecHardGateResult[] = GATE_CHECKS.map((check) => check.build(report, options, ctx));

  // §七: a baseline is required for the A/B clause AND for the regression
  // clause. It is checked separately from the gates above so the reason is
  // explicit rather than implied by a single failing gate.
  const baselineGate = baselinePresenceGate(report, options);
  hardGates.push(baselineGate);

  // Join with promotion-gate.ts (CI hygiene) when supplied — additive only.
  const hygieneFailures: string[] = [];
  if (options.hardGateStatus !== undefined) {
    const hygiene = evaluateHardGates(options.hardGateStatus);
    if (!hygiene.passed) hygieneFailures.push(...hygiene.failures);
  }
  if (options.promotionVerdict !== undefined && !options.promotionVerdict.hardGatesPassed) {
    hygieneFailures.push(...options.promotionVerdict.hardFailures);
  }
  if (hygieneFailures.length > 0) {
    hardGates.push({
      gate: "ci_hygiene",
      label: "CI hygiene hard gates (promotion-gate.ts)",
      passed: false,
      observed: hygieneFailures,
      required: "evaluateHardGates() green (typecheck/test/build/coverage/matrix/escapes)",
      failureKind: "FAILED",
      detail: hygieneFailures.join("; "),
    });
  }

  const blockingReasons = hardGates
    .filter((gate) => !gate.passed)
    .map((gate) => {
      const detail = gate.detail !== undefined ? ` — ${gate.detail}` : "";
      return `[${gate.failureKind ?? "FAILED"}] ${gate.gate}: ${gate.label} (required: ${gate.required}; observed: ${describeObserved(gate.observed)})${detail}`;
    });

  const abFindings = collectAbFindings(options);

  return {
    verdict: blockingReasons.length === 0 ? "PASS" : "BLOCKED",
    schemaVersion: report.schemaVersion,
    hardGates,
    blockingReasons,
    scoreCard: report.scoreCard,
    metricReport: buildMetricReport(report),
    strata: report.strata,
    abFindings,
    hygieneFailures,
  };
}

function baselinePresenceGate(
  report: SpecMetricReport,
  options: SpecConformanceOptions,
): SpecHardGateResult {
  const required = "§七: Baseline and Candidate are compared on the same model/tasks/permissions/budget";
  if (options.baseline === undefined) {
    const hasHistorical = (options.historicalPassedTaskIds?.length ?? 0) > 0;
    return {
      gate: "ab_baseline_present",
      label: "baseline arm present / 存在基线",
      passed: false,
      observed: null,
      required,
      failureKind: "NOT_EVALUABLE",
      detail: hasHistorical
        ? "no baseline REPORT supplied (only a historical task-id set): the A/B comparison itself was never performed"
        : "no baseline report supplied — a candidate cannot be promoted against nothing",
    };
  }
  if (options.baseline.schemaVersion !== report.schemaVersion) {
    return {
      gate: "ab_baseline_present",
      label: "baseline arm present / 存在基线",
      passed: false,
      observed: { baselineSchema: options.baseline.schemaVersion, candidateSchema: report.schemaVersion },
      required,
      failureKind: "NOT_EVALUABLE",
      detail: "baseline and candidate reports use different schema versions — not comparable",
    };
  }
  return {
    gate: "ab_baseline_present",
    label: "baseline arm present / 存在基线",
    passed: true,
    observed: { baselineTrials: options.baseline.trials, baselineTasks: options.baseline.tasks },
    required,
  };
}

function collectAbFindings(options: SpecConformanceOptions): string[] {
  const findings: string[] = [];
  const evidence = options.abEvidence;
  if (evidence === undefined) return findings;
  const map: Array<[string, boolean | null | undefined]> = [
    ["sameModel", evidence.sameModel],
    ["sameTaskSet", evidence.sameTaskSet],
    ["sameToolPermissions", evidence.sameToolPermissions],
    ["sameBudgetCap", evidence.sameBudgetCap],
    ["modelParametersRecorded", evidence.modelParametersRecorded],
    ["taskOrderRecorded", evidence.taskOrderRecorded],
    ["environmentRecorded", evidence.environmentRecorded],
    ["evaluationScriptRecorded", evidence.evaluationScriptRecorded],
  ];
  for (const [name, value] of map) {
    if (value === false) findings.push(`${name}: NOT satisfied`);
    else if (value === null || value === undefined) findings.push(`${name}: not supplied (gap, not a pass)`);
  }
  return findings;
}

function describeObserved(observed: unknown): string {
  if (observed === null || observed === undefined) return "null (not measured)";
  try {
    return JSON.stringify(observed);
  } catch {
    return String(observed);
  }
}

function buildMetricReport(report: SpecMetricReport): SpecConformanceVerdict["metricReport"] {
  return report.metrics.map((sample) => ({
    metric: sample.metric,
    label: SPEC_METRIC_LABELS[sample.metric],
    status: sample.status,
    value: sample.value,
    target: sample.target,
    meetsTarget: meetsSpecTarget(sample),
  }));
}

/** Target satisfaction per indicator (informational; the gate has its own rules). */
export function meetsSpecTarget(sample: SpecMetricSample): boolean {
  if (sample.status !== "MEASURED") return false;
  switch (sample.targetKind) {
    case "fraction": {
      if (typeof sample.value !== "number") return false;
      switch (sample.metric) {
        case "security_control_effectiveness":
        case "loop_guard_effectiveness":
        case "trace_completeness":
          return sample.denominator > 0 && sample.denominator === sample.numerator;
        case "completion_claim_precision":
          return sample.value >= SPEC_HARD_GATE_THRESHOLDS.completionClaimPrecision;
        case "task_success_rate":
          return sample.value >= SPEC_HARD_GATE_THRESHOLDS.taskSuccessRate;
        case "repeat_stability_pass_pow_k":
          return sample.value >= 0.7;
        case "tool_call_validity_rate":
          return sample.value >= 0.99;
        case "recovery_success_rate":
          return sample.value >= 0.95;
        case "auto_verification_coverage":
          return sample.value >= 0.9;
        default:
          return false;
      }
    }
    case "count":
      return sample.numerator <= SPEC_HARD_GATE_THRESHOLDS.criticalRegressions;
    case "comparison":
    case "descriptive":
      // Baseline-relative by spec: there is no standalone target to meet.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a verdict as report lines. The weighted score is printed as
 * SUPPLEMENTARY and is explicitly marked as non-authoritative for release.
 */
export function renderSpecConformance(verdict: SpecConformanceVerdict): string[] {
  const lines: string[] = [];
  lines.push(`# Harness 规格一致性判定 (${verdict.schemaVersion})`, "");
  lines.push(`VERDICT: ${verdict.verdict}`, "");

  lines.push("## §六 hard gates", "", "| gate | result | observed | required |", "| --- | --- | --- | --- |");
  for (const gate of verdict.hardGates) {
    lines.push(
      `| ${gate.gate} | ${gate.passed ? "PASS" : `FAIL (${gate.failureKind ?? "FAILED"})`} | ${describeObserved(gate.observed)} | ${gate.required} |`,
    );
  }
  lines.push("");

  if (verdict.blockingReasons.length > 0) {
    lines.push("## Blocking reasons", "");
    for (const reason of verdict.blockingReasons) lines.push(`- ${reason}`);
    lines.push("");
  }

  lines.push("## §三 indicators", "", "| # | metric | status | value | target | meets target |", "| --- | --- | --- | --- | --- | --- |");
  verdict.metricReport.forEach((metric, index) => {
    lines.push(
      `| ${index + 1} | ${metric.label} | ${metric.status} | ${metric.value === null ? "null" : formatValue(metric.value)} | ${metric.target} | ${metric.meetsTarget ? "yes" : "no"} |`,
    );
  });
  lines.push("");

  lines.push("## §六 weighted scorecard (SUPPLEMENTARY — never releases a hard gate)", "");
  const card = verdict.scoreCard;
  lines.push(`- weights: 任务结果正确率 ${card.weights.taskCorrectness}% / 执行稳定性与可恢复性 ${card.weights.stabilityAndRecovery}% / 安全与权限边界 ${card.weights.securityAndPermissions}% / 成本和延迟 ${card.weights.costAndLatency}% / 可观测与可复现性 ${card.weights.observabilityAndReproducibility}%`);
  lines.push(`- total: ${card.total === null ? "null (unmeasured dimension — not scored as 0)" : card.total}`);
  if (card.unmeasured.length > 0) lines.push(`- unmeasured dimensions: ${card.unmeasured.join(", ")}`);
  lines.push("- note: the weighted total is not an input to the verdict; safety and key correctness must pass the hard gates independently.");
  lines.push("");

  lines.push("## §三 stratified breakdown (sample sizes)", "", "| axis | value | runs | tasks | tool calls |", "| --- | --- | --- | --- | --- |");
  for (const stratum of verdict.strata) {
    lines.push(`| ${stratum.axis} | ${stratum.value} | ${stratum.runs} | ${stratum.tasks} | ${stratum.toolCalls} |`);
  }
  lines.push("");

  if (verdict.abFindings.length > 0) {
    lines.push("## §七 A/B findings", "");
    for (const finding of verdict.abFindings) lines.push(`- ${finding}`);
    lines.push("");
  }
  if (verdict.hygieneFailures.length > 0) {
    lines.push("## CI hygiene failures (promotion-gate.ts)", "");
    for (const failure of verdict.hygieneFailures) lines.push(`- ${failure}`);
  }
  return lines;
}

function formatValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  return describeObserved(value);
}

/** Convenience: the spec hard-gate verdict for a report, one call. */
export function specConformancePassed(
  report: SpecMetricReport,
  options: SpecConformanceOptions = {},
): boolean {
  return evaluateSpecConformance(report, options).verdict === "PASS";
}
