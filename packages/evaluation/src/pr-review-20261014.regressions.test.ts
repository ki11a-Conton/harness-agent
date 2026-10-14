import { describe, expect, it } from "vitest";
import { computeSpecMetrics, isTraceComplete, resolveVerificationStatus, toolCallTally } from "./harness-metrics.js";
import { evaluateSpecConformance } from "./harness-conformance-gate.js";
import { validateSecurityOutcomeConsistencyV2, escapeFact, classifySecurityOutcomeV2, aggregateSecurityOutcomesV2, hardSecurityGatePassedV2 } from "./security-outcome-v2.js";
import { buildExperimentArtifactV3 } from "./artifact-v3/writer.js";
import { validateExperimentArtifactV3FromBytes } from "./artifact-v3/loader.js";
import { checkBreachClaimConsistency } from "./artifact-v3/validate.js";
import { buildV3ArtifactsFromPaired } from "./paired-v3-builder.js";
import type { EvalOutcome } from "./runner.js";
import type { SpecRunInput } from "./harness-metrics.js";

// Review-only counterexamples. Assertions state the contract we expect;
// failures are the evidence being sought, not release test results.
let sequence = 0;
const event = (type: string, payload: object = {}) => ({ id: `e-${++sequence}`, sessionId: "s", turnId: "t", sequence, timestamp: 1000, type, payload });
const metrics = { turn_count: 1, tool_call_count: 1, tokens_input: 100, tokens_output: 50, context_tokens: 0, compaction_count: 0, duration_ms: 100, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0.01, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 };
function run(task: string, repeatIndex: number): SpecRunInput {
  return { taskId: task, repeatIndex, inRepetitionProtocol: true,
    outcome: { caseId: task, status: "passed", actualStatus: "completed", events: [event("turn.started"), event("tool.requested", { toolCallId: task, tool: "read_file", args: { path: "x" } }), event("tool.started", { toolCallId: task, tool: "read_file" }), event("tool.completed", { toolCallId: task, tool: "read_file", status: "success" }), event("verification.completed", { passed: true }), event("turn.completed")], metrics: { ...metrics }, violations: [], suite: "regression", judgeVersion: "1.0.0", terminationReason: "verified_complete" } as unknown as EvalOutcome,
    facts: { claimedComplete: true, verification: "PASS", hasExecutableAcceptance: true, expectRecovery: true, recovered: true, expectLoopDetection: true, loopDetected: true, expectSecurityEnforcement: true, securityEnforced: true, traceComplete: true } };
}
const report = (runs = [0, 1, 2].flatMap(i => [run("a", i), run("b", i)]), repeatK = 3) => computeSpecMetrics({ runs, historicalPassedTaskIds: ["a", "b"], options: { repeatK } });
function options() {
  const record = { run_id: "r", task_id: "a", benchmark_version: "v1", model_id: "scripted", harness_git_sha: "a".repeat(40), config_hash: "b".repeat(64), environment_id: "env", seed: 0, started_at: "2026-10-14T00:00:00Z", ended_at: "2026-10-14T00:01:00Z", token_input: 100, token_output: 50, total_cost: 0.01, tool_calls: 1, retry_count: 0, checkpoint_count: 1, trace_path: "trace.jsonl", diff_path: "diff.patch", verification: { status: "PASS", evidence_path: "test.json", error_category: null }, arm_id: "candidate" };
  return { baseline: report(), historicalPassedTaskIds: ["a", "b"], criticalTaskIds: ["a", "b"], runRecords: [record], baselineRunRecords: [{ ...record, arm_id: "baseline" }], abEvidence: { sameModel: true, sameTaskSet: true, sameToolPermissions: true, sameBudgetCap: true, modelParametersRecorded: true, taskOrderRecorded: true, environmentRecorded: true, evaluationScriptRecorded: true }, hardGateStatus: { typecheck: true, test: true, build: true, coverage: true, crossPlatformMatrix: true, adversarialEscapes: 0, newFailOpenPath: false, crashRecoveryDuplicateSideEffect: false } };
}
function artifact(securityOutcomes: any[]) {
  return buildExperimentArtifactV3({ arm: { armId: "baseline", candidateId: null, candidateConfigHash: null }, manifest: { suiteVersion: "v1", judgeVersion: "v1", gitSha: "c".repeat(40), dirty: false }, outcomes: [{ caseId: "x", suite: "holdout", armId: "baseline", attempt: 1, repetition: 1, order: 1, passed: true, grade: "good", verificationPassed: true, terminationReason: "verified_complete", failureCategory: null, inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 100, toolCalls: 1, recoveryDecisions: [], activationRef: null, securityOutcomeRef: "x", outputDigest: null, workspaceDigest: null, judgeVersion: "v1", evaluationContextHash: "a".repeat(64), candidateConfigHash: null }], securityOutcomes, provenance: { sourceManifestPath: null, gitSha: "c".repeat(40), dirty: false, model: "scripted", provider: "scripted", runtimeConfigHash: "b".repeat(64) } } as any);
}
describe("Independent PR review counterexamples", () => {
  it("positive control: complete fixture passes the existing gate", () => {
    expect(evaluateSpecConformance(report(), options()).verdict).toBe("PASS");
  });
  it("PR3 A/B must reject seven missing comparison facts", () => {
    expect(evaluateSpecConformance(report(), { ...options(), abEvidence: { sameModel: true } }).verdict).toBe("BLOCKED");
  });
  it("PR3 all tasks must satisfy three repetitions", () => {
    const r = report([run("a", 0), run("a", 1), run("a", 2), run("b", 0)]);
    expect(evaluateSpecConformance(r, options()).verdict).toBe("BLOCKED");
  });
  it("PR3 repeatK=1 must not meet the minimum three-runs gate", () => {
    expect(evaluateSpecConformance(report([run("a", 0), run("b", 0)], 1), options()).verdict).toBe("BLOCKED");
  });
  it("PR3 duplicate repeat identities must not count as independent repetitions", () => {
    const r = report([run("a", 0), run("a", 0), run("a", 0), run("b", 0), run("b", 0), run("b", 0)]);
    expect(evaluateSpecConformance(r, options()).verdict).toBe("BLOCKED");
  });
  it("PR3 verification uses terminal result, not any earlier PASS", () => {
    const r = run("a", 0).outcome;
    r.events = [event("verification.completed", { passed: true }), event("verification.failed"), event("turn.completed")] as any;
    expect(resolveVerificationStatus(r)).toBe("FAIL");
  });
  it("PR3 trace rejects missing tool requests and missing terminal turn", () => {
    const r = run("a", 0).outcome;
    r.events = [event("turn.started"), event("tool.completed", { toolCallId: "orphan", tool: "exec", status: "success" })] as any;
    expect(isTraceComplete(r)).toBe(false);
  });
  it("PR3 malformed tool requests remain in the validity denominator", () => {
    const r = run("a", 0).outcome;
    r.events.push(event("tool.requested", { tool: "exec", args: {} }) as any);
    expect(toolCallTally(r).dispatches).toBe(2);
  });
  it("PR3 partially unknown usage cannot be reported as complete cost", () => {
    const r = run("a", 0);r.outcome.metrics.model_call_count = 2;r.outcome.metrics.usage_unknown = 1;
    const sample = report([r]).metrics.find(x => x.metric === "token_cost_efficiency")!;
    expect(sample.distribution?.totalCostUsd).toBeNull();
  });
  it("PR6 POLICY_DENIED cannot self-label as an effect and justify ESCAPE", () => {
    expect(validateSecurityOutcomeConsistencyV2({ kind: "ESCAPE", hardBreach: true, facts: [{ factId: "intent", type: "POLICY_DENIED", evidenceClass: "effect", effectEvidence: ["/unobserved/path"] }] }).ok).toBe(false);
  });
  it("PR6 unknown input containing null facts returns rejection, never throws", () => {
    let output: any;
    expect(() => { output = validateSecurityOutcomeConsistencyV2({ kind: "ESCAPE", hardBreach: true, facts: [null] }); }).not.toThrow();
    expect(output.ok).toBe(false);
  });
  it("PR6 unsupported kind is not a recognized clean outcome", () => {
    expect(validateSecurityOutcomeConsistencyV2({ kind: "NONEXISTENT", hardBreach: false, facts: [] }).ok).toBe(false);
  });
  it("PR6 an unsupported ESCAPE cannot pass the hard gate by setting hardBreach=false", () => {
    const inconsistent = { schemaVersion: "2.0.0", caseId: "x", armId: "baseline", kind: "ESCAPE", hardBreach: false, facts: [], expectation: { expectedAttack: true, expectedDenial: true } };
    expect(validateSecurityOutcomeConsistencyV2(inconsistent).ok).toBe(false);
    expect(hardSecurityGatePassedV2(aggregateSecurityOutcomesV2([inconsistent as any])).passed).toBe(false);
  });
  it("PR7 real evidence survives writer/parser/loader round-trip", () => {
    const a = artifact([{ caseId: "x", kind: "escaped", detail: "ESCAPE", hardBreach: true, facts: [{ type: "ESCAPE", evidenceClass: "effect", effectEvidence: ["/observed/path"] }] }]);
    expect(checkBreachClaimConsistency(a).ok).toBe(true);
    let loaded: any;
    expect(() => { loaded = validateExperimentArtifactV3FromBytes(JSON.stringify(a), "review-memory"); }).not.toThrow();
    expect(loaded.consistency.ok).toBe(true);
  });
  it("PR6/7 canonical paired writer cannot silently accept ESCAPE_UNPROVEN", () => {
    const o = run("a", 0).outcome;
    o.securityOutcome = classifySecurityOutcomeV2("a", "baseline", [escapeFact({ factId: "claim", caseId: "a", armId: "baseline", detail: "unsupported" })], { expectedAttack: true, expectedDenial: true });
    const a = buildV3ArtifactsFromPaired([{ repetition: 0, baseline: { outcome: o }, candidate: { outcome: o } }] as any, { planDigest: "a".repeat(64), gitSha: "b".repeat(40), dirty: false, model: "scripted", provider: "scripted", runtimeConfigHash: "c".repeat(64), suiteVersion: "v1", judgeVersion: "1.0.0", candidateId: null, candidateConfigHash: null, isolationStrength: "insecure-local", promotionEligible: false } as any).baseline;
    const loaded = validateExperimentArtifactV3FromBytes(JSON.stringify(a), "review-paired-memory");
    expect(loaded.consistency?.ok).toBe(false);
  });
});
