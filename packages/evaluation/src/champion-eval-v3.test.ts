import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildExperimentArtifactV3,
  type CaseOutcomeV3,
  type ExperimentArtifactV3Input,
} from "./artifact-v3/index.js";
import {
  loadV3ArtifactPair,
  deriveV3Decision,
  provenanceRefsComparableV3,
  buildDecisionArtifactV3,
  DECISION_ARTIFACT_V3_SCHEMA_VERSION,
  CHAMPION_EVAL_V3_POLICY_VERSION,
  type V3ArtifactPair,
} from "./champion-eval-v3.js";
import type { ChampionDecisionEnvelopeV3 } from "./champion-decision-v3.js";
import { decideChampionV3 } from "./champion-decision-v3.js";
import {
  DECISION_POLICY_V3_VERSION,
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  validateDecisionPolicyV3,
} from "./decision-policy-v3.js";

// E4-03: valid-format manifest digest fixtures.
const GIT40 = "c".repeat(40);
const HEX64 = "a".repeat(64);

function makeOutcome(overrides: Partial<CaseOutcomeV3> = {}): CaseOutcomeV3 {
  return {
    caseId: "ho-01",
    suite: "holdout",
    armId: "candidate",
    attempt: 1,
    repetition: 1,
    order: 1,
    passed: true,
    grade: "good",
    verificationPassed: true,
    terminationReason: "completed",
    failureCategory: null,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    latencyMs: 1000,
    toolCalls: 5,
    recoveryDecisions: [],
    activationRef: "ae-1",
    securityOutcomeRef: null,
    outputDigest: "out-1",
    workspaceDigest: "ws-1",
    judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64),
    candidateConfigHash: "b".repeat(64),
    ...overrides,
  };
}

/** Build a V3 artifact pair in memory (not written to disk). */
function makePair(
  opts: {
    candidatePassed?: boolean[];
    candidateRepetition?: number[];
    candidateActivated?: boolean[];
    candidateSecurityEscaped?: boolean;
    candidateVerified?: boolean[];
    baselineProvenance?: ExperimentArtifactV3Input["provenance"];
    candidateProvenance?: ExperimentArtifactV3Input["provenance"];
    candidateManifestExtra?: Record<string, unknown>;
  } = {},
): V3ArtifactPair {
  const candidatePassed = opts.candidatePassed ?? [true, true, true];
  const candidateRepetition = opts.candidateRepetition ?? [1, 2, 3];
  const candidateActivated = opts.candidateActivated ?? [true, true, true];
  const candidateVerified = opts.candidateVerified ?? [true, true, true];
  const candidateSecurityEscaped = opts.candidateSecurityEscaped ?? false;

  const baseProvenance = opts.baselineProvenance ?? {
    sourceManifestPath: "manifest.json", gitSha: "c".repeat(40), dirty: false, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "a".repeat(64),
  };
  const candProvenance = opts.candidateProvenance ?? {
    sourceManifestPath: "manifest.json", gitSha: "c".repeat(40), dirty: false, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "a".repeat(64),
  };

  const baselineOutcomes = [1, 2, 3].map((rep) => makeOutcome({
    caseId: `ho-0${rep}`, armId: "baseline", repetition: rep, passed: false, grade: "poor", verificationPassed: false,
    activationRef: null,
  }));
  const candidateOutcomes = candidatePassed.map((passed, i) => {
    const rep = candidateRepetition[i] ?? 1;
    return makeOutcome({
      caseId: `ho-0${rep}`,
      armId: "candidate",
      repetition: rep,
      passed,
      grade: passed ? "good" : "poor",
      verificationPassed: candidateVerified[i] ?? false,
      activationRef: candidateActivated[i] ? "ae-1" : null,
    });
  });

  const baseline = buildExperimentArtifactV3({
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false },
    outcomes: baselineOutcomes,
    provenance: baseProvenance,
  });
  const candidate = buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: "memory_retrieval", candidateConfigHash: "b".repeat(64) },
    manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false, planDigest: HEX64, ...(opts.candidateManifestExtra ?? {}) },
    outcomes: candidateOutcomes,
    provenance: candProvenance,
    securityOutcomes: candidateSecurityEscaped
      ? [{ caseId: "ho-01", kind: "escaped", detail: "escaped sandbox" }]
      : undefined,
  });
  return {
    baseline,
    candidate,
    baselineDigest: "base-digest",
    candidateDigest: "cand-digest",
  };
}

describe("E3-06 V3 champion eval bridge", () => {
  it("1. legacy (non-V3) artifact path -> LEGACY_NOT_PROMOTION_ELIGIBLE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e3-06-"));
    try {
      const legacyPath = join(dir, "legacy.json");
      await writeFile(legacyPath, JSON.stringify({ results: [] }), "utf8");
      const candPath = join(dir, "candidate.json");
      await writeFile(candPath, JSON.stringify({ results: [] }), "utf8");
      await expect(loadV3ArtifactPair(legacyPath, candPath)).rejects.toThrow(/LEGACY_NOT_PROMOTION_ELIGIBLE/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. V3 pair with grades/verification -> decision statistics carry real values (no ?/0→0)", () => {
    const pair = makePair();
    const { decisionArtifact, envelope } = deriveV3Decision(pair, "memory_retrieval", HEX64);
    // statistics carry real grade counts; decision is ACCEPT (3 reps, +3 delta, activated)
    expect(envelope.decision).toBe("ACCEPT");
    expect(decisionArtifact.decision).toBe("ACCEPT");
    expect(decisionArtifact.schemaVersion).toBe(DECISION_ARTIFACT_V3_SCHEMA_VERSION);
    // E4-05: the decision is bound to the versioned policy + its threshold digest.
    expect(decisionArtifact.policyVersion).toBe(DECISION_POLICY_V3_VERSION);
    expect(decisionArtifact.thresholdDigest).toBe(computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3));
    expect(decisionArtifact.candidateId).toBe("memory_retrieval");
    expect(decisionArtifact.planDigest).toBe(HEX64);
    expect(decisionArtifact.repetitions).toBe(3);
    expect(decisionArtifact.perRepetitionDeltas).toEqual([1, 1, 1]);
    expect(decisionArtifact.contentDigest.length).toBe(24);
  });

  it("3. repetitions=2 with per-repetition deltas empty -> never ACCEPT (defense)", () => {
    // Derivation always produces matching deltas, but force the defensive check.
    const pair = makePair({ candidateRepetition: [1, 2, 3], candidatePassed: [true, true, true] });
    const { derivedInputs, envelope } = deriveV3Decision(pair, "memory_retrieval", HEX64);
    // Simulate a tampered input where per-rep length != repetitions.
    const tampered = { ...derivedInputs, perRepetitionDeltas: [] };
    const env = decideChampionV3(tampered);
    expect(env.decision).toBe("INVALID");
    expect(env.reasonCodes).toContain("PER_REPETITION_INCOMPLETE");
    expect(derivedInputs.perRepetitionDeltas.length).toBe(derivedInputs.repetitions);
    // (envelope.statistics.repetitions is the source of truth)
    expect(derivedInputs.repetitions).toBe(3);
  });

  it("4. caller cannot inject digestValid:true to force promotion — entry takes paths only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e3-06-"));
    try {
      // Write a real V3 pair to disk and load via paths only.
      const pair = makePair();
      const basePath = join(dir, "baseline.json");
      const candPath = join(dir, "candidate.json");
      await writeFile(basePath, JSON.stringify(pair.baseline), "utf8");
      await writeFile(candPath, JSON.stringify(pair.candidate), "utf8");
      const loaded = await loadV3ArtifactPair(basePath, candPath);
      expect(loaded.baseline.arm.armId).toBe("baseline");
      expect(loaded.candidate.arm.armId).toBe("candidate");
      // The derived decision uses the artifact's OWN digests, not a caller value.
      const res = deriveV3Decision(loaded, null, null);
      expect(res.decisionArtifact.baselineArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. tampered input artifact changes the decision artifact digest (revalidation fails)", () => {
    const pair = makePair();
    const a1 = deriveV3Decision(pair, "memory_retrieval", HEX64).decisionArtifact;
    // Tamper: candidate outcome passes flip.
    const tamperedPair: V3ArtifactPair = {
      ...pair,
      candidate: buildExperimentArtifactV3({
        arm: { armId: "candidate", candidateId: "memory_retrieval", candidateConfigHash: "b".repeat(64) },
        manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false, planDigest: HEX64 },
        outcomes: [1, 2, 3].map((rep) => makeOutcome({
          caseId: `ho-0${rep}`, armId: "candidate", repetition: rep, passed: false, grade: "poor",
          verificationPassed: false, activationRef: "ae-1",
        })),
        provenance: pair.candidate.provenance,
      }),
      candidateDigest: "tampered-digest",
    };
    const a2 = deriveV3Decision(tamperedPair, "memory_retrieval", HEX64).decisionArtifact;
    expect(a2.decision).not.toBe("ACCEPT"); // INCONCLUSIVE — net effect 0 < threshold
    // digest binds both artifact digests
    expect(a1.candidateArtifactDigest).not.toBe(a2.candidateArtifactDigest);
  });

  it("6. provenance refs comparability derived from artifact (mismatched gitSha -> not comparable)", () => {
    const good = makePair();
    expect(provenanceRefsComparableV3(good.baseline, good.candidate).comparable).toBe(true);

    const bad = makePair({
      candidateProvenance: { sourceManifestPath: "manifest.json", gitSha: "DIFFERENT", dirty: false, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "cfg-1" },
    });
    const result = provenanceRefsComparableV3(bad.baseline, bad.candidate);
    expect(result.comparable).toBe(false);
    expect(result.reasons).toContain("gitSha mismatch");
  });

  it("7. unknown provenance (null fields) -> not comparable", () => {
    const pair = makePair({
      candidateProvenance: { sourceManifestPath: null, gitSha: null, dirty: null, model: null, provider: null, runtimeConfigHash: null },
    });
    const result = provenanceRefsComparableV3(pair.baseline, pair.candidate);
    expect(result.comparable).toBe(false);
    expect(result.reasons.some((r) => r.includes("UNKNOWN_IDENTITY"))).toBe(true);
  });

  it("8. decision artifact binds plan digest + is content-addressed", () => {
    const pair = makePair();
    const res = deriveV3Decision(pair, "memory_retrieval", HEX64);
    const da = res.decisionArtifact;
    expect(da.planDigest).toBe(HEX64);
    expect(da.gates).toHaveProperty("artifactIntegrity");
    // recompute: same envelope + digests -> same artifact (stable)
    const res2 = deriveV3Decision(pair, "memory_retrieval", HEX64);
    expect(res2.decisionArtifact.contentDigest).toBe(da.contentDigest);
  });

  it("9. security breach in candidate -> REJECT via derived gate", () => {
    const pair = makePair({ candidateSecurityEscaped: true });
    const { envelope } = deriveV3Decision(pair, "memory_retrieval", HEX64);
    expect(envelope.decision).toBe("REJECT");
    expect(envelope.reasonCodes).toContain("SECURITY_BREACH");
  });

  // E4-05: the high-risk mispairing the old caseId-only Map silently accepted.
  it("10. E4-05: candidate has an extra repetition -> INVALID (PAIR_INCOMPLETE)", () => {
    const prov = { sourceManifestPath: "m.json", gitSha: GIT40, dirty: false, model: "m", provider: "p", runtimeConfigHash: HEX64 };
    const baseline = buildExperimentArtifactV3({
      arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false },
      outcomes: [makeOutcome({ caseId: "ho-01", armId: "baseline", repetition: 1, passed: false, activationRef: null })],
      provenance: prov,
    });
    const candidate = buildExperimentArtifactV3({
      arm: { armId: "candidate", candidateId: "memory_retrieval", candidateConfigHash: "b".repeat(64) },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false, planDigest: HEX64 },
      outcomes: [
        makeOutcome({ caseId: "ho-01", armId: "candidate", repetition: 1, passed: true }),
        makeOutcome({ caseId: "ho-01", armId: "candidate", repetition: 2, passed: true }),
      ],
      provenance: prov,
    });
    const { envelope } = deriveV3Decision({ baseline, candidate, baselineDigest: "x", candidateDigest: "y" }, "memory_retrieval", HEX64);
    expect(envelope.decision).toBe("INVALID");
    expect(envelope.reasonCodes).toContain("PAIR_INCOMPLETE");
  });

  it("11. E4-05: repetition 0 -> INVALID (out of range)", () => {
    const prov = { sourceManifestPath: "m.json", gitSha: GIT40, dirty: false, model: "m", provider: "p", runtimeConfigHash: HEX64 };
    const baseline = buildExperimentArtifactV3({
      arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false },
      outcomes: [makeOutcome({ caseId: "ho-01", armId: "baseline", repetition: 0, passed: false, activationRef: null })],
      provenance: prov,
    });
    const candidate = buildExperimentArtifactV3({
      arm: { armId: "candidate", candidateId: "memory_retrieval", candidateConfigHash: "b".repeat(64) },
      manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false, planDigest: HEX64 },
      outcomes: [makeOutcome({ caseId: "ho-01", armId: "candidate", repetition: 0, passed: true })],
      provenance: prov,
    });
    const { envelope } = deriveV3Decision({ baseline, candidate, baselineDigest: "x", candidateDigest: "y" }, "memory_retrieval", HEX64);
    expect(envelope.decision).toBe("INVALID");
  });

  // E4-05 part 2: thresholds come from a verified, versioned policy.
  it("12. E4-05: manifest.thresholdDigest != applied policy -> INVALID (tamper)", () => {
    const pair = makePair({ candidateManifestExtra: { thresholdDigest: "f".repeat(64) } });
    const { envelope } = deriveV3Decision(pair, "memory_retrieval", HEX64); // default policy digest != "f"*64
    expect(envelope.decision).toBe("INVALID");
    expect(envelope.reasonCodes).toContain("PAIR_INCOMPLETE");
  });

  it("13. E4-05: manifest.repeat != observed repetitions -> INVALID", () => {
    const pair = makePair({ candidateManifestExtra: { repeat: 5 } }); // actual is 3
    const { envelope } = deriveV3Decision(pair, "memory_retrieval", HEX64);
    expect(envelope.decision).toBe("INVALID");
  });

  it("14. E4-05: a stricter policy threshold flips ACCEPT -> INCONCLUSIVE", () => {
    const strictPolicy = { ...DEFAULT_DECISION_POLICY_V3, minConclusiveNetDelta: 10 };
    // default policy, no recorded thresholdDigest → ACCEPT (delta 3 >= 1)
    const plainPair = makePair();
    expect(deriveV3Decision(plainPair, "memory_retrieval", HEX64).envelope.decision).toBe("ACCEPT");
    // strict policy applied, manifest records its digest → not INVALID, but the
    // delta (3) is below the stricter threshold (10) → INCONCLUSIVE
    const strictPair = makePair({
      candidateManifestExtra: { thresholdDigest: computeThresholdDigestV3(strictPolicy) },
    });
    const res = deriveV3Decision(strictPair, "memory_retrieval", HEX64, strictPolicy);
    expect(res.envelope.decision).toBe("INCONCLUSIVE");
    expect(res.decisionArtifact.thresholdDigest).toBe(computeThresholdDigestV3(strictPolicy));
    expect(res.decisionArtifact.policyVersion).toBe(strictPolicy.version);
  });

  it("15. E4-05: validateDecisionPolicyV3 rejects malformed thresholds", () => {
    expect(() => validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, minActivationCoverage: 2 })).toThrow();
    expect(() => validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, maxVerifiedDrop: -1 })).toThrow();
    expect(() => validateDecisionPolicyV3({ version: "" })).toThrow();
    // round-trips a valid policy
    expect(validateDecisionPolicyV3(DEFAULT_DECISION_POLICY_V3)).toEqual(DEFAULT_DECISION_POLICY_V3);
  });
});