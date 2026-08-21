import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
/**
 * Head-to-head comparison benchmark (§133): run the same eval cases through
 * two harness implementations (or the same harness twice) and compare
 * outcome quality, never a single collapsed score (§149).
 */
export declare class BenchRunner {
    /**
     * Runs every case through both harnesses and compares the outcomes.
     *
     * The same `EvalCase` instance is handed to both runs, so "same model,
     * same task, same environment, different harness" (§133) is the caller's
     * contract to arrange. Cases run sequentially so the report order always
     * matches the input order.
     *
     * A throwing harness run rejects the whole comparison — no fabricated
     * outcome is produced; harness crashes surface as `EvalOutcome` with
     * `status: "error"` instead (the runner.ts convention).
     */
    runCompare(deps: {
        cases: EvalCase[];
        runA: (c: EvalCase) => Promise<EvalOutcome>;
        runB: (c: EvalCase) => Promise<EvalOutcome>;
    }): Promise<BenchReport>;
}
export interface BenchReport {
    cases: BenchCaseResult[];
    summary: {
        a: BenchTotals;
        b: BenchTotals;
    };
}
export interface BenchCaseResult {
    caseId: string;
    resultA: EvalOutcome;
    resultB: EvalOutcome;
    winner: "A" | "B" | "tie" | "both_failed";
}
/** Aggregated §149 metrics over one harness's runs. */
export interface BenchTotals {
    /** Cases that passed (`status === "passed"`). */
    success: number;
    /** Cases with zero violations. */
    safety: number;
    /** Cases whose run produced no error (`status !== "error"`). */
    reliability: number;
    /** Average `tool_call_count` per case. */
    efficiency: number;
    /** Average `duration_ms` per case. */
    latency: number;
    /** Sum of `estimated_cost` (0 when metrics are absent). */
    cost: number;
}
//# sourceMappingURL=bench.d.ts.map