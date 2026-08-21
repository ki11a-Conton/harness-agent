import type { AgentEvent, EventStore, SessionId } from "@ar/contracts";
import type { AgentRuntime } from "@ar/core";
import { type RunMetrics } from "@ar/observability";
import type { EvalCase, EvalSuite } from "./eval-case.js";
export type EvalStatus = "passed" | "failed" | "error";
/**
 * P0-6 failure classification — where a case outcome came from, independent
 * of pass/fail:
 *
 * - model:          the model/provider failed (turn ended with a model error).
 * - harness:        the runtime/harness threw an internal error (a bug).
 * - judge:          the judge itself failed to evaluate (event store error).
 * - infrastructure: environmental — wall-clock timeout, workspace/setup
 *                   failure, or a benchmark-runner exception. A timeout is
 *                   classified here because it is the benchmark infrastructure
 *                   imposing its budget; the detail ("timed out after Xms")
 *                   stays in `reason`.
 */
export type FailureCategory = "model" | "harness" | "judge" | "infrastructure";
export interface EvalOutcome {
    caseId: string;
    status: EvalStatus;
    /** Turn outcome status ("completed" | "failed" | "cancelled"), or "error" when the runtime threw. */
    actualStatus: string;
    events: AgentEvent[];
    metrics: RunMetrics;
    violations: string[];
    reason?: string;
    /** Structured termination reason from the runtime (plan.md Phase 2); see
     *  baseline.ts terminationReason() for the event-derived fallback. */
    terminationReason?: string;
    /** P0-6: failure classification (model | harness | judge | infrastructure).
     *  Absent for clean agent-side outcomes that simply failed the task. */
    failureCategory?: FailureCategory;
    /** Suite + judge version for regression reporting (Phase 6.5). */
    suite: EvalSuite;
    judgeVersion: string;
}
/**
 * Behavioral network attempt patterns (Phase 6.5 `forbidden.network`).
 * Judgment operates on the exec command text from tool.requested events —
 * the model *attempting* a network operation is the failure, exactly like
 * `forbidden.commands`. These are behavior-level classifiers, not runtime
 * enforcement (the runtime network gate is Phase 9).
 */
export declare const NETWORK_EXEC_PATTERNS: string[];
/**
 * Behavior-level evaluator (§74): judges an EvalCase from the turn outcome and
 * the event trail, never from model wording (specification gaming defense §76).
 *
 * Verification specs are executed by the existing TaskSpec/Verifier mechanism
 * (the runtime's VERIFY-001 gate, wired by the harness via `task` + `verifier`
 * runtime deps); the runner only observes `verification.*` events.
 */
export declare class EvalRunner {
    run(caseDef: EvalCase, deps: {
        runtime: AgentRuntime;
        sessionId: SessionId;
        events: EventStore;
    }): Promise<EvalOutcome>;
}
//# sourceMappingURL=runner.d.ts.map