import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-6 — Learned Workflow experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A workflow
 * candidate is expressed ONLY as soft guidance (plan.md P3-6):
 *
 *   when task type X
 *   prefer steps A → B → C
 *
 * Two hard constraints are enforced, matching plan.md:
 *
 *  1. SOFT ONLY — a learned workflow is injected as an ordering preference for
 *     a matching task type; it is never mandatory. Scope matching is required
 *     (a non-matching task type is a no-op), and it only activates after a
 *     benchmark promotion gate, like P3-5.
 *  2. NEVER BYPASS GATES — a candidate that would bypass a permission gate or
 *     the verification gate is a fail-closed hard violation: it is rejected and
 *     any attempt to apply it fails closed. Learning never produces a workflow
 *     whose steps skip verification.
 *
 * As with the rest of P3, the challenger is a deterministic, seeded effect
 * model composed over measured outcomes.
 */
/** Lifecycle shares P3-5 semantics: candidate → (benchmark) active → rolled_back. */
export type WorkflowStatus = "candidate" | "active" | "rolled_back";
/** A scoped, versioned, soft workflow learned from successful traces. */
export interface WorkflowCandidate {
    id: string;
    /** Task type this workflow serves (e.g. "coding", "debugging"). */
    taskType: string;
    /** Preferred step order, e.g. ["read", "edit", "test", "verify"]. */
    preferredSteps: string[];
    status: WorkflowStatus;
    evidenceSamples: number;
    version: number;
    /** True when a step is a verification step (a workflow must keep it). */
    includesVerification: boolean;
}
/** The canonical steps the runtime models (used to infer workflows from tools). */
export declare const STEP_LABEL: Map<string, string>;
/** Steps that must NEVER be bypassed by a workflow. */
export declare const GATED_STEPS: Set<string>;
/**
 * Learn a workflow candidate from successful traces of one task type. The
 * preferred order is the first-seen unique step order across passing runs
 * (deterministic); a workflow is only learned when enough evidence exists and
 * every passing run ended with a verification step. A candidate that would
 * carry a mutating step without verification is dropped (must not bypass the
 * verification gate).
 */
export declare function learnWorkflow(runs: EvalOutcome[], taskType: string, opts?: {
    minSamples?: number;
}): WorkflowCandidate | undefined;
/** True when a workflow serves the given task type. */
export declare function workflowMatches(wf: WorkflowCandidate, taskType: string): boolean;
/** True when a workflow's steps were a strict subset that skipped a gate.
 *  Verification is mandatory after any mutating step (see learnWorkflow); a
 *  candidate carrying this flag is always rejected wholesale. */
export declare function assertNoGateBypass(wf: WorkflowCandidate): void;
/** The promotion gate: only benchmark-validated, evidence-backed, scope-matching,
 *  non-bypassing workflows become ACTIVE. */
export declare function promoteWorkflow(wf: WorkflowCandidate, delta: {
    passDelta: number;
    costScoreDelta: number;
    bypassFree: boolean;
}, gate?: {
    minimumSamples?: number;
    minimumPassLift?: number;
}): WorkflowCandidate;
/** Explicit, permanent rollback. */
export declare function rollbackWorkflow(wf: WorkflowCandidate): WorkflowCandidate;
/** Apply a workflow only when ACTIVE and task-type matching (soft guidance). */
export declare function shouldApplyWorkflow(wf: WorkflowCandidate, taskType: string): boolean;
export type WorkflowPolicy = "no_workflow" | "learned_workflow";
export interface WorkflowEffectModel {
    /** Pass-rate lift when a soft-ordered workflow applies to a matching type. */
    softGuidanceGain: number;
    /** Fraction of matching-type cases the guidance is actually applied to. */
    applicationReach: number;
    /** Extra tokens for injecting the guidance. */
    injectionTokens: number;
    /** Fault injection: model a workflow that would skip verification. */
    faultBypassVerification: boolean;
}
export declare const DEFAULT_WORKFLOW_MODEL: WorkflowEffectModel;
export interface WorkflowRunMetrics {
    caseId: string;
    policy: WorkflowPolicy;
    applied: boolean;
    gated: boolean;
    passed: boolean;
    tokens: number;
    durationMs: number;
}
export declare function simulateWorkflowRun(outcome: EvalOutcome, policy: WorkflowPolicy, workflows: WorkflowCandidate[], taskType: string, options?: {
    model?: Partial<WorkflowEffectModel>;
    seed?: number;
    measureAsActive?: boolean;
}): WorkflowRunMetrics;
export declare function aggregateWorkflow(runs: WorkflowRunMetrics[], cost?: CostModelOptions): {
    passRate: number;
    appliedCount: number;
    bypassCount: number;
    costScore: number;
};
export interface WorkflowComparison {
    baselinePassRate: number;
    challengerPassRate: number;
    bypassCount: number;
    activeCount: number;
    appliedCount: number;
    passDelta: number;
    costScoreDelta: number;
}
/** Run the end-to-end learned-workflow experiment (learn → promote on
 *  validation → measure on evaluation), honoring rollback. */
export declare function runWorkflowExperiment(trainingTrace: EvalOutcome[], validation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    typeOf: (c: EvalCase) => string;
}, evaluation: {
    runWorker: (c: EvalCase) => Promise<EvalOutcome>;
    cases: EvalCase[];
    typeOf: (c: EvalCase) => string;
}, options?: {
    taskType?: string;
    model?: Partial<WorkflowEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: {
        minimumSamples?: number;
        minimumPassLift?: number;
    };
    rollbackAfterPromote?: boolean;
}): Promise<WorkflowComparison>;
export declare function renderWorkflowComparison(cmp: WorkflowComparison): string;
//# sourceMappingURL=learned-workflow.d.ts.map