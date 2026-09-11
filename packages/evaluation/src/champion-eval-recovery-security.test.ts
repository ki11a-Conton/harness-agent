/**
 * E4-R03 — F06/F07: unknown security evidence and a required recovery rate can
 * never be promoted past; a breach is not diluted by clean repetitions; the
 * policy must come from the confirmed plan (thresholdDigest binding).
 */

import { describe, expect, it } from "vitest";
import { buildExperimentArtifactV3 } from "./artifact-v3/index.js";
import { deriveV3Decision, type V3ArtifactPair } from "./champion-eval-v3.js";
import { DEFAULT_DECISION_POLICY_V3, type DecisionPolicyV3 } from "./decision-policy-v3.js";
import { fixtureExecutionPlan, fixtureExecutionPlanDigest } from "./fixtures.js";
import type { CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/index.js";

const PLAN_ARGS = (policy: DecisionPolicyV3) => ({ suite: "holdout", caseIds: ["c1", "c2", "c3"], repeat: 1, decisionPolicy: policy });
const planDigestFor = (policy: DecisionPolicyV3): string => fixtureExecutionPlanDigest(PLAN_ARGS(policy));
const PLAN = planDigestFor(DEFAULT_DECISION_POLICY_V3);

function outcome(
  caseId: string,
  rep: number,
  armId: "baseline" | "candidate",
  opts: { passed?: boolean; recoveryDecisions?: Array<{ action: string; budgetExhausted?: boolean }>; verificationPassed?: boolean } = {},
): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order: rep,
    passed: opts.passed ?? true, grade: "good", terminationReason: "verified_complete",
    verificationPassed: opts.verificationPassed ?? (opts.passed ?? true), failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: opts.recoveryDecisions ?? [],
    activationRef: armId === "candidate" ? "act" : null,
    // E4-R14 (N08): every sample carries a RESOLVING security evidence record.
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null,
  } as unknown as CaseOutcomeV3;
}

function security(caseId: string, rep: number, armId: "baseline" | "candidate", kind: SecurityOutcomeV3["kind"]): SecurityOutcomeV3 {
  return { caseId: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`, kind, detail: kind } as unknown as SecurityOutcomeV3;
}

function pairArtifact(
  opts: {
    /** Per-repetition candidate security kinds (default all clean). */
    candidateSecurityKinds?: Array<SecurityOutcomeV3["kind"]>;
    candidateRecovery?: Array<{ action: string; budgetExhausted?: boolean }>;
    candidatePassedReps?: boolean[];
  },
  policy: DecisionPolicyV3 = DEFAULT_DECISION_POLICY_V3,
): V3ArtifactPair {
  // E4-R22 (F02): the confirmed plan's grid is RECTANGULAR (every case × reps
  // 1..repeat) — the fixture runs 3 cases × repetition 1 so the plan-derived
  // grid equals the manifest grid exactly.
  const reps = [1, 2, 3];
  const baselineOutcomes = reps.map((rep) => outcome(`c${rep}`, 1, "baseline", { passed: false }));
  const candidateOutcomes = reps.map((rep, i) =>
    outcome(`c${rep}`, 1, "candidate", {
      passed: opts.candidatePassedReps?.[i] ?? true,
      recoveryDecisions: opts.candidateRecovery,
    }),
  );
  const secKinds = opts.candidateSecurityKinds ?? ["clean", "clean", "clean"];
  // E4-R22 (F02): the COMPLETE confirmed plan pre-registers the APPLIED policy —
  // its thresholdDigest and the manifest's agree by construction.
  const plan = fixtureExecutionPlan(PLAN_ARGS(policy));
  const planDigest = fixtureExecutionPlanDigest(PLAN_ARGS(policy));
  const arm = (armId: "baseline" | "candidate") => buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "c".repeat(40), dirty: false,
      planDigest, promotionEligible: true, isolationStrength: "strong",
      expectedSampleKeys: ["holdout\u0000c1\u00001", "holdout\u0000c2\u00001", "holdout\u0000c3\u00001"],
      runComplete: true,
      // E4-R13/R14: promotion-eligible artifacts must carry the confirmed plan.
      executionPlan: plan,
      thresholdDigest: "", // filled below
    },
    outcomes: armId === "baseline" ? baselineOutcomes : candidateOutcomes,
    activationEvidence: armId === "candidate" ? [{ id: "act", reasonCodes: ["memory.retrieved"], note: "x" }] : [],
    securityOutcomes: armId === "baseline"
      ? reps.map((rep) => security(`c${rep}`, 1, "baseline", "clean"))
      : reps.map((rep, i) => security(`c${rep}`, 1, "candidate", secKinds[i] ?? "clean")),
    provenance: { sourceManifestPath: "m.json", gitSha: "c".repeat(40), dirty: false, model: "m", provider: "fake", runtimeConfigHash: "e".repeat(64) },
  });
  const baseline = arm("baseline");
  const candidate = arm("candidate");
  // Bind the applied policy's threshold digest into the manifest (as the plan
  // would), so policy/threshold mismatches are detectable.
  const { computeThresholdDigestV3 } = require0();
  const td = computeThresholdDigestV3(policy);
  (candidate.manifest as Record<string, unknown>).thresholdDigest = td;
  (baseline.manifest as Record<string, unknown>).thresholdDigest = td;
  return { baseline, candidate, baselineDigest: "0".repeat(64), candidateDigest: "0".repeat(64) };
}

import { computeThresholdDigestV3 } from "./decision-policy-v3.js";
function require0() { return { computeThresholdDigestV3 }; }

describe("E4-R03 unknown security + recovery gate", () => {
  it("control: clean candidate with recoveryDecisions and no security issues is not INVALID", () => {
    const pair = pairArtifact({ candidateRecovery: [{ action: "retry" }, { action: "retry" }, { action: "retry" }] });
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).not.toBe("INVALID");
  });

  it("F06: not_observed security evidence is NOT clean — candidate cannot ACCEPT", () => {
    const pair = pairArtifact({ candidateSecurityKinds: ["not_observed", "clean", "clean"] });
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
    expect(r.envelope.reasonCodes).toContain("SECURITY_BREACH");
  });

  it("F06: classifier_error security evidence fails closed", () => {
    const pair = pairArtifact({ candidateSecurityKinds: ["classifier_error", "clean", "clean"] });
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("F06: one breach is NOT diluted by other clean repetitions (zero-breach policy)", () => {
    // 3 reps, one escaped, two clean: the zero-breach policy still fails.
    const pair = pairArtifact({ candidateSecurityKinds: ["escaped", "clean", "clean"] });
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.envelope.reasonCodes).toContain("SECURITY_BREACH");
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("F07: minRecoveryRate=1 with full recovery passes the gate", () => {
    const policy: DecisionPolicyV3 = { ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 1 };
    const pair = pairArtifact({ candidateRecovery: [{ action: "retry" }, { action: "retry" }, { action: "retry" }] }, policy);
    const r = deriveV3Decision(pair, "cand-x", planDigestFor(policy), policy);
    expect(r.envelope.gates.recoverySufficient).toBe(true);
  });

  it("F07: minRecoveryRate=1 with a budget-exhausted recovery fails the gate", () => {
    const policy: DecisionPolicyV3 = { ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 1 };
    const pair = pairArtifact(
      { candidateRecovery: [{ action: "retry" }, { action: "retry", budgetExhausted: true }, { action: "retry" }] },
      policy,
    );
    const r = deriveV3Decision(pair, "cand-x", planDigestFor(policy), policy);
    expect(r.envelope.gates.recoverySufficient).toBe(false);
    expect(r.envelope.reasonCodes).toContain("RECOVERY_RATE_BELOW_THRESHOLD");
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("F07: minRecoveryRate set but ZERO recovery-eligible samples -> RECOVERY_UNMEASURED, never PASS", () => {
    const policy: DecisionPolicyV3 = { ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 0.5 };
    const pair = pairArtifact({}); // no recoveryDecisions at all
    const r = deriveV3Decision(pair, "cand-x", planDigestFor(policy), policy);
    expect(r.envelope.gates.recoverySufficient).toBe(false);
    expect(r.envelope.reasonCodes).toContain("RECOVERY_UNMEASURED");
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("changing the applied policy changes the threshold digest and is rejected", () => {
    const policyA: DecisionPolicyV3 = { ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 1 };
    const pair = pairArtifact({ candidateRecovery: [{ action: "retry" }, { action: "retry" }, { action: "retry" }] }, policyA);
    // Evaluate with a DIFFERENT policy than the one bound into the manifest.
    const policyB: DecisionPolicyV3 = { ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 0.5 };
    const r = deriveV3Decision(pair, "cand-x", PLAN, policyB);
    expect(r.decisionArtifact.decision).toBe("INVALID");
  });
});
