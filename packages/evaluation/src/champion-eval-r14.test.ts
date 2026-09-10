/**
 * E4-R14 — N06–N10 negative-first regressions:
 *
 *   N06  omitting/emptying expectedSampleKeys must not let a self-consistent
 *        partial pair ACCEPT;
 *   N07  1 case × 3 reps must count as uniqueCases=1 (repetitions never inflate
 *        the case/activation-eligible count; a dangling ref is not eligibility);
 *   N08  securityOutcomes=[] / missing / dangling refs must be INVALID evidence,
 *        never silently counted as 0 breaches;
 *   N09  runComplete=false / empty grid / promotionEligible=true without the
 *        full R13 plan must all be rejected;
 *   N10  verification uses the TERMINAL verification state (early pass + later
 *        fail → verified=false); recovery budgetExhausted comes from the real
 *        event payload.
 */

import { describe, expect, it } from "vitest";
import { buildExperimentArtifactV3 } from "./artifact-v3/index.js";
import { deriveV3Decision, type V3ArtifactPair } from "./champion-eval-v3.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import type { CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/index.js";
import { buildV3ArtifactsFromPaired, type PairedV3Facts } from "./paired-v3-builder.js";
import type { PairedFinalizedPair } from "./paired-executor.js";
import type { EvalOutcome } from "./runner.js";

const PLAN = "d".repeat(64);
const POLICY = DEFAULT_DECISION_POLICY_V3;
const TD = computeThresholdDigestV3(POLICY);

function outcome(caseId: string, rep: number, armId: "baseline" | "candidate", opts: { passed?: boolean; activationRef?: string | null; securityOutcomeRef?: string | null } = {}): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order: rep,
    passed: opts.passed ?? true, grade: "good", terminationReason: "verified_complete",
    verificationPassed: opts.passed ?? true, failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef: opts.activationRef !== undefined ? opts.activationRef : (armId === "candidate" ? `act-${caseId}-${rep}` : null),
    securityOutcomeRef: opts.securityOutcomeRef !== undefined ? opts.securityOutcomeRef : `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null,
  } as unknown as CaseOutcomeV3;
}

function securityRec(caseId: string, rep: number, armId: "baseline" | "candidate", kind: SecurityOutcomeV3["kind"] = "clean"): SecurityOutcomeV3 {
  return { caseId: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`, kind, detail: kind } as unknown as SecurityOutcomeV3;
}

interface PairOpts {
  cases?: string[];
  reps?: number[];
  candidatePassed?: boolean;
  candidateActivation?: (caseId: string, rep: number) => string | null;
  /** Which activationEvidence ids to ship (default: the resolving refs). Pass
   *  a fixed set to create DANGLING refs on purpose. */
  activationEvidenceIds?: string[];
  candidateSecurityKinds?: (caseId: string, rep: number) => SecurityOutcomeV3["kind"];
  candidateSecurityRef?: (caseId: string, rep: number) => string | null;
  manifestExtra?: Record<string, unknown>;
  baselineThresholdTampered?: boolean;
}

/** A promotion-eligible compliant pair: grid, plan, runComplete, per-sample
 *  security + activation records all present and resolving. */
function mkPair(opts: PairOpts = {}): V3ArtifactPair {
  const cases = opts.cases ?? ["c1", "c2"];
  const reps = opts.reps ?? [1, 2];
  const key = (c: string, r: number) => `holdout\u0000${c}\u0000${r}`;
  const grid = cases.flatMap((c) => reps.map((r) => key(c, r)));

  const arm = (armId: "baseline" | "candidate") => {
    const outcomes = cases.flatMap((c) => reps.map((r) => {
      if (armId === "baseline") return outcome(c, r, "baseline", { passed: false });
      // NOTE: explicit ternary — `??` would silently replace a deliberate
      // `null` activationRef with the default ref.
      const activationRef = opts.candidateActivation !== undefined
        ? opts.candidateActivation(c, r)
        : `act-${c}-${r}`;
      return outcome(c, r, "candidate", {
        passed: opts.candidatePassed ?? true,
        activationRef,
        securityOutcomeRef: opts.candidateSecurityRef !== undefined
          ? opts.candidateSecurityRef(c, r)
          : `holdout\u0000${c}\u0000${r}\u0000candidate`,
      });
    }));
    const candOutcomes = armId === "candidate" ? outcomes : [];
    const activationEvidence = opts.activationEvidenceIds !== undefined
      ? opts.activationEvidenceIds.map((id) => ({ id, reasonCodes: ["memory.retrieved"], note: "activated" }))
      : candOutcomes.filter((o) => o.activationRef !== null).map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" }));
    return buildExperimentArtifactV3({
      arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null },
      manifest: {
        suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "c".repeat(40), dirty: false,
        planDigest: PLAN, promotionEligible: true, isolationStrength: "strong",
        expectedSampleKeys: grid, runComplete: true,
        executionPlan: { schemaVersion: "e4-01", suite: "holdout", caseIds: cases, repeat: reps.length },
        thresholdDigest: opts.baselineThresholdTampered && armId === "baseline" ? "0".repeat(64) : TD,
        ...opts.manifestExtra,
      },
      outcomes,
      activationEvidence: armId === "candidate" ? activationEvidence : [],
      securityOutcomes: cases.flatMap((c) => reps.map((r) =>
        securityRec(c, r, armId, armId === "candidate" ? (opts.candidateSecurityKinds?.(c, r) ?? "clean") : "clean"),
      )),
      provenance: { sourceManifestPath: "m.json", gitSha: "c".repeat(40), dirty: false, model: "m", provider: "fake", runtimeConfigHash: "e".repeat(64) },
    });
  };
  const baseline = arm("baseline");
  const candidate = arm("candidate");
  return { baseline, candidate, baselineDigest: "0".repeat(64), candidateDigest: "0".repeat(64) };
}

describe("E4-R14 evaluator completeness enforcement (N06/N09)", () => {
  it("control: a full compliant promotion-eligible pair is ACCEPT", () => {
    const r = deriveV3Decision(mkPair({ cases: ["c1", "c2", "c3"] }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("ACCEPT");
  });

  it("N09: runComplete=false is INVALID even when the pair is self-consistent", () => {
    const r = deriveV3Decision(mkPair({ manifestExtra: { runComplete: false } }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /runComplete/.test(v))).toBe(true);
  });

  it("N09/N06: an EMPTY expectedSampleKeys grid is INVALID (declared grid cannot be empty)", () => {
    const r = deriveV3Decision(mkPair({ manifestExtra: { expectedSampleKeys: [] } }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
  });

  it("N06: OMITTED expectedSampleKeys on a promotion-eligible artifact is INVALID", () => {
    const r = deriveV3Decision(mkPair({ manifestExtra: { expectedSampleKeys: undefined } }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /expected sample grid/.test(v))).toBe(true);
  });

  it("N09: promotion-eligible WITHOUT the full execution plan is INVALID", () => {
    const r = deriveV3Decision(mkPair({ manifestExtra: { executionPlan: undefined } }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /execution plan/.test(v))).toBe(true);
  });

  it("N06: duplicate keys in the expected grid are INVALID", () => {
    const grid = ["holdout\u0000c1\u00001", "holdout\u0000c1\u00001"];
    const r = deriveV3Decision(mkPair({ manifestExtra: { expectedSampleKeys: grid } }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
  });

  it("N06: a baseline evaluated under a DIFFERENT policy (thresholdDigest) is INVALID", () => {
    const r = deriveV3Decision(mkPair({ baselineThresholdTampered: true }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /baseline.*thresholdDigest|policy mismatch/.test(v))).toBe(true);
  });
});

describe("E4-R14 unique-case statistics (N07)", () => {
  it("1 case × 3 reps → uniqueCases=1 and activationEligibleCases=1 (never 3)", () => {
    const r = deriveV3Decision(mkPair({ cases: ["c1"], reps: [1, 2, 3] }), "cand-x", PLAN);
    expect((r.decisionArtifact.statistics as { cases?: number }).cases).toBe(1);
    expect((r.derivedInputs as { activationEligibleCases?: number }).activationEligibleCases).toBe(1);
    // A single unique case cannot satisfy minActivationEligibleCases=3.
    expect(r.envelope.gates.activationSatisfied).toBe(false);
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("a case where only SOME repetitions activated is NOT activation-eligible", () => {
    const r = deriveV3Decision(mkPair({
      cases: ["c1", "c2"], reps: [1, 2],
      candidateActivation: (c, rep) => (c === "c2" && rep === 2 ? null : `act-${c}-${rep}`),
    }), "cand-x", PLAN);
    // c2 is NOT eligible (its rep2 outcome is unactivated) → activatedCases=1.
    expect((r.derivedInputs as { activationEligibleCases?: number }).activationEligibleCases).toBe(1);
    expect((r.derivedInputs as { activationCoverage?: number | null }).activationCoverage).toBe(0.5);
    expect(r.envelope.gates.activationSatisfied).toBe(false);
  });

  it("a DANGLING activationRef is INVALID — a ref to nothing is not eligibility", () => {
    // The evidence carries NO records (empty id set), but every outcome claims
    // a ghost ref → the refs cannot resolve.
    const r = deriveV3Decision(mkPair({
      cases: ["c1", "c2", "c3"],
      candidateActivation: (c, rep) => `ghost-${c}-${rep}`,
      activationEvidenceIds: [],
    }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /dangling activationRef/.test(v))).toBe(true);
  });
});

describe("E4-R14 security evidence coverage (N08)", () => {
  it("securityOutcomes with NULL outcome refs is INVALID (missing evidence ≠ 0 breaches)", () => {
    const r = deriveV3Decision(mkPair({
      cases: ["c1", "c2", "c3"],
      candidateSecurityRef: () => null,
    }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    expect((r.derivedInputs as { pairingViolations?: string[] }).pairingViolations?.some((v) => /security evidence record/.test(v))).toBe(true);
  });

  it("a DANGLING securityOutcomeRef is INVALID evidence, never counted as clean", () => {
    const r = deriveV3Decision(mkPair({
      cases: ["c1", "c2", "c3"],
      candidateSecurityRef: () => "no-such-record",
    }), "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
  });

  it("observed breach kinds still REJECT (not INVALID) when coverage resolves", () => {
    const r = deriveV3Decision(mkPair({
      cases: ["c1", "c2", "c3"],
      candidateSecurityKinds: (c, rep) => (c === "c1" && rep === 1 ? "escaped" : "clean"),
    }), "cand-x", PLAN);
    expect(r.envelope.reasonCodes).toContain("SECURITY_BREACH");
    expect(r.decisionArtifact.decision).toBe("REJECT");
  });
});

describe("E4-R14 terminal verification state + real recovery payload (N10)", () => {
  function evalOutcome(events: Array<{ type: string; payload?: Record<string, unknown> }>): EvalOutcome {
    return {
      caseId: "c1", suite: "holdout", armId: "candidate", status: "passed", actualStatus: "completed",
      events: events as unknown as EvalOutcome["events"], violations: [], judgeVersion: "1.0.0",
      activationEvidenceV2: {
        events: events
          .filter((e) => e.type === "recovery_decision")
          .map((e, i) => ({
            eventId: `rec-${i}`, schemaVersion: "e4-r04-v2", candidateId: "cand-x",
            mechanism: "recovery", evidenceType: "recovery-decided",
            lineage: { caseId: "c1", armId: "candidate", attempt: 1, repetition: 1 },
            payload: { digest: "0".repeat(64), action: String(e.payload?.action ?? "retry"), budgetExhausted: e.payload?.budgetExhausted === true },
          })),
        validation: { ok: true, issues: [] },
        aggregation: { eligible: 1, activated: 1, coverage: 1, invalid: 0, reason: "ok" },
      } as never,
      metrics: {
        turn_count: 1, tool_call_count: 0, tokens_input: 10, tokens_output: 5, context_tokens: 0,
        compaction_count: 0, duration_ms: 1, retry_count: 0, verification_failures: 0, human_interventions: 0,
        estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1,
      },
    } as unknown as EvalOutcome;
  }

  function pairedPair(rep: number, o: EvalOutcome): PairedFinalizedPair {
    const mk = (armId: "baseline" | "candidate", out: EvalOutcome) => ({
      arm: { armId, caseId: "c1", repetition: rep }, valid: true, outcome: out, modelCallAttempts: 1, transportRetries: 0,
    });
    return {
      pairId: "p-" + rep, caseId: "c1", repetition: rep, order: "AB",
      baseline: mk("baseline", evalOutcome([])), candidate: mk("candidate", o),
    } as unknown as PairedFinalizedPair;
  }

  const FACTS = {
    planDigest: "c".repeat(64), gitSha: "d".repeat(40), dirty: false, model: "m", provider: "fake",
    runtimeConfigHash: "e".repeat(64), suiteVersion: "2.1.0", judgeVersion: "1.0.0",
    candidateId: "cand-x", candidateConfigHash: "b".repeat(64), isolationStrength: "strong", promotionEligible: true,
  } as PairedV3Facts;

  it("an early verification PASS followed by a later FAILURE is verified=false", () => {
    const { candidate } = buildV3ArtifactsFromPaired(
      [pairedPair(0, evalOutcome([
        { type: "verification.completed", payload: { passed: true } },
        { type: "verification.failed", payload: {} },
      ]))],
      FACTS,
    );
    expect(candidate.outcomes[0]!.verificationPassed).toBe(false);
  });

  it("the LAST verification event decides (a final pass after earlier fails is verified=true)", () => {
    const { candidate } = buildV3ArtifactsFromPaired(
      [pairedPair(0, evalOutcome([
        { type: "verification.failed", payload: {} },
        { type: "verification.completed", payload: { passed: true } },
      ]))],
      FACTS,
    );
    expect(candidate.outcomes[0]!.verificationPassed).toBe(true);
  });

  it("budgetExhausted comes from the REAL recovery event payload, not a fixed false", () => {
    const { candidate } = buildV3ArtifactsFromPaired(
      [pairedPair(0, evalOutcome([
        { type: "recovery_decision", payload: { action: "retry", budgetExhausted: true } },
      ]))],
      FACTS,
    );
    const decision = candidate.outcomes[0]!.recoveryDecisions[0]!;
    expect(decision.budgetExhausted).toBe(true);
    expect(decision.action).toBe("retry");
  });
});
