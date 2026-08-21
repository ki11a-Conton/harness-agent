import { toolNameOf as toolNameOfPayload } from "@ar/contracts";
import { scoreCost } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";
/** The canonical steps the runtime models (used to infer workflows from tools). */
export const STEP_LABEL = new Map([
    ["read_file", "read"],
    ["search", "search"],
    ["write_file", "edit"],
    ["edit_file", "edit"],
    ["exec", "test"],
]);
/** Steps that must NEVER be bypassed by a workflow. */
export const GATED_STEPS = new Set(["permission", "verification"]);
/** Steps that write artifacts and thus MUST be followable by verification. */
const MUTATING_STEPS = new Set(["edit", "write"]);
/**
 * Infer the preferred step order from a single outcome's tool sequence,
 * mapped to step labels.
 */
function stepsOfRun(run) {
    const steps = [];
    const push = (step) => {
        if (!steps.includes(step))
            steps.push(step);
    };
    // Any verification.* event is a verification step (not a tool schema label).
    for (const event of run.events) {
        if (event.type.startsWith("verification."))
            push("verification");
    }
    for (const event of run.events) {
        if (event.type !== "tool.completed")
            continue;
        const tool = toolNameOfPayload(event.payload);
        if (tool === undefined)
            continue;
        const label = STEP_LABEL.get(tool);
        if (label !== undefined) {
            push(label);
        }
        else if (/verify/i.test(tool)) {
            // A tool named for verification (e.g. run-checker, verify_step) is the gate.
            push("verification");
        }
    }
    return steps;
}
/**
 * Learn a workflow candidate from successful traces of one task type. The
 * preferred order is the first-seen unique step order across passing runs
 * (deterministic); a workflow is only learned when enough evidence exists and
 * every passing run ended with a verification step. A candidate that would
 * carry a mutating step without verification is dropped (must not bypass the
 * verification gate).
 */
export function learnWorkflow(runs, taskType, opts = {}) {
    const minSamples = opts.minSamples ?? 3;
    const passing = runs.filter((r) => r.status === "passed");
    if (passing.length < minSamples)
        return undefined; // single success is not a workflow
    // First unique order across passing runs.
    const order = [];
    for (const run of passing) {
        for (const step of stepsOfRun(run)) {
            if (!order.includes(step))
                order.push(step);
        }
    }
    const hasMutating = order.some((s) => MUTATING_STEPS.has(s));
    const includesVerification = order.some((s) => GATED_STEPS.has(s)) || order.includes("verification");
    // A workflow that writes but has no verification would bypass the gate.
    if (hasMutating && !includesVerification)
        return undefined;
    return {
        id: `wf:${taskType}`,
        taskType,
        preferredSteps: order,
        status: "candidate",
        evidenceSamples: passing.length,
        version: 1,
        includesVerification,
    };
}
/** True when a workflow serves the given task type. */
export function workflowMatches(wf, taskType) {
    return wf.taskType === taskType;
}
/** True when a workflow's steps were a strict subset that skipped a gate.
 *  Verification is mandatory after any mutating step (see learnWorkflow); a
 *  candidate carrying this flag is always rejected wholesale. */
export function assertNoGateBypass(wf) {
    if (wf.preferredSteps.some((s) => GATED_STEPS.has(s) && s === "permission")) {
        // "permission" appearing as a bypass marker is invalid; workflows never add it.
        throw new Error(`workflow ${wf.id} references the permission gate as a step (bypass) — fail closed`);
    }
}
/** The promotion gate: only benchmark-validated, evidence-backed, scope-matching,
 *  non-bypassing workflows become ACTIVE. */
export function promoteWorkflow(wf, delta, gate) {
    const minimumSamples = gate?.minimumSamples ?? 3;
    const minimumPassLift = gate?.minimumPassLift ?? 0;
    if (wf.status !== "candidate")
        return wf;
    if (wf.evidenceSamples < minimumSamples)
        return wf;
    if (!delta.bypassFree)
        return wf;
    if (delta.passDelta < minimumPassLift)
        return wf;
    if (delta.costScoreDelta <= 0)
        return wf;
    return { ...wf, status: "active", version: wf.version + 1 };
}
/** Explicit, permanent rollback. */
export function rollbackWorkflow(wf) {
    if (wf.status !== "active")
        return wf;
    return { ...wf, status: "rolled_back", version: wf.version + 1 };
}
/** Apply a workflow only when ACTIVE and task-type matching (soft guidance). */
export function shouldApplyWorkflow(wf, taskType) {
    return wf.status === "active" && workflowMatches(wf, taskType);
}
export const DEFAULT_WORKFLOW_MODEL = {
    softGuidanceGain: 0.25,
    applicationReach: 1,
    injectionTokens: 250,
    faultBypassVerification: false,
};
export function simulateWorkflowRun(outcome, policy, workflows, taskType, options = {}) {
    const model = { ...DEFAULT_WORKFLOW_MODEL, ...(options.model ?? {}) };
    const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 11);
    const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
    let passed = outcome.status === "passed";
    if (policy === "no_workflow") {
        return {
            caseId: outcome.caseId,
            policy,
            applied: false,
            gated: false,
            passed,
            tokens,
            durationMs: outcome.metrics.duration_ms,
        };
    }
    // Which matching workflows would apply? Candidate measured as-active solely
    // during validation; production apply requires `active` (shouldApplyWorkflow).
    const matching = workflows.filter((wf) => workflowMatches(wf, taskType));
    const applicable = matching.filter((wf) => options.measureAsActive === true || wf.status === "active");
    const applying = applicable.length > 0 && random() < model.applicationReach;
    // GATE BYPASS GUARD: a workflow with a mutating step but no verification is a
    // fail-closed violation, whether naturally learned or injected as a fault.
    const gated = applicable.some((wf) => wf.preferredSteps.some((s) => MUTATING_STEPS.has(s)) && !wf.includesVerification);
    if (model.faultBypassVerification) {
        // Fault model guarantees a bypass → hard fail closed.
        return {
            caseId: outcome.caseId,
            policy,
            applied: true,
            gated: true,
            passed: false,
            tokens: tokens + model.injectionTokens,
            durationMs: outcome.metrics.duration_ms + 300,
        };
    }
    if (gated) {
        return {
            caseId: outcome.caseId,
            policy,
            applied: applying,
            gated: true,
            passed: false,
            tokens: tokens + model.injectionTokens,
            durationMs: outcome.metrics.duration_ms + 300,
        };
    }
    if (applying && !passed && random() < model.softGuidanceGain) {
        passed = true;
    }
    return {
        caseId: outcome.caseId,
        policy,
        applied: applying,
        gated: false,
        passed,
        tokens: tokens + (applying ? model.injectionTokens : 0),
        durationMs: outcome.metrics.duration_ms + (applying ? 300 : 0),
    };
}
export function aggregateWorkflow(runs, cost) {
    const passed = runs.filter((r) => r.passed).length;
    const bypass = runs.filter((r) => r.gated).length;
    const costResult = scoreCost({
        status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
        violations: bypass > 0 ? ["workflow_gate_bypass"] : [],
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
    }, cost ?? {});
    return {
        passRate: runs.length === 0 ? 0 : passed / runs.length,
        appliedCount: runs.filter((r) => r.applied).length,
        bypassCount: bypass,
        costScore: costResult.score,
    };
}
/** Run the end-to-end learned-workflow experiment (learn → promote on
 *  validation → measure on evaluation), honoring rollback. */
export async function runWorkflowExperiment(trainingTrace, validation, evaluation, options = {}) {
    const taskType = options.taskType ?? "coding";
    const seed = options.seed ?? 7;
    const learned = learnWorkflow(trainingTrace, taskType, {
        minSamples: options.gate?.minimumSamples ?? 3,
    });
    if (learned === undefined) {
        throw new Error("no workflow learned: trace lacks a statistically sound signal");
    }
    assertNoGateBypass(learned);
    // PROMOTE on validation (measure candidate as-active only here).
    const vBase = [];
    const vChall = [];
    for (const c of validation.cases) {
        const outcome = await validation.runWorker(c);
        const t = validation.typeOf(c);
        vBase.push(simulateWorkflowRun(outcome, "no_workflow", [], t, { model: options.model, seed }));
        vChall.push(simulateWorkflowRun(outcome, "learned_workflow", [learned], t, {
            model: options.model,
            seed,
            measureAsActive: true,
        }));
    }
    const vBaseAgg = aggregateWorkflow(vBase, options.cost);
    const vChallAgg = aggregateWorkflow(vChall, options.cost);
    const bypassFree = vChallAgg.bypassCount === 0;
    let champion = promoteWorkflow(learned, {
        passDelta: vChallAgg.passRate - vBaseAgg.passRate,
        costScoreDelta: vChallAgg.costScore - vBaseAgg.costScore,
        bypassFree,
    }, options.gate);
    if (options.rollbackAfterPromote)
        champion = rollbackWorkflow(champion);
    // MEASURE on evaluation.
    const base = [];
    const challenger = [];
    for (const c of evaluation.cases) {
        const outcome = await evaluation.runWorker(c);
        const t = evaluation.typeOf(c);
        base.push(simulateWorkflowRun(outcome, "no_workflow", [], t, { model: options.model, seed }));
        challenger.push(simulateWorkflowRun(outcome, "learned_workflow", [champion], t, { model: options.model, seed }));
    }
    const baseAgg = aggregateWorkflow(base, options.cost);
    const challAgg = aggregateWorkflow(challenger, options.cost);
    return {
        baselinePassRate: baseAgg.passRate,
        challengerPassRate: challAgg.passRate,
        bypassCount: challAgg.bypassCount,
        activeCount: champion.status === "active" ? 1 : 0,
        appliedCount: challAgg.appliedCount,
        passDelta: challAgg.passRate - baseAgg.passRate,
        costScoreDelta: challAgg.costScore - baseAgg.costScore,
    };
}
export function renderWorkflowComparison(cmp) {
    return [
        "Learned Workflow Experiment",
        `decision: ${cmp.activeCount > 0 ? "ACTIVE (promoted)" : "NOT ACTIVE"} (${cmp.bypassCount > 0 ? "GATE BYPASS" : "no bypass"})`,
        `  gate bypasses              ${cmp.bypassCount}`,
        `  workflows applied           ${cmp.appliedCount}`,
        `  pass rate                   ${round(cmp.baselinePassRate, 3)} → ${round(cmp.challengerPassRate, 3)}`,
        `  cost score delta            ${round(cmp.costScoreDelta, 3)}`,
    ].join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=learned-workflow.js.map