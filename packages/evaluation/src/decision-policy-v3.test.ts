/**
 * E4-05 #5 — DecisionPolicyV3 digest + validation.
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_POLICY_V3_VERSION,
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  validateDecisionPolicyV3,
} from "./decision-policy-v3.js";

describe("E4-05 DecisionPolicyV3", () => {
  it("default policy carries the versioned id", () => {
    expect(DEFAULT_DECISION_POLICY_V3.version).toBe(DECISION_POLICY_V3_VERSION);
  });

  it("threshold digest is deterministic + sensitive to any threshold change", () => {
    const d1 = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
    const d2 = computeThresholdDigestV3({ ...DEFAULT_DECISION_POLICY_V3 });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    // a single threshold change flips the digest (tamper-evident)
    const changed = computeThresholdDigestV3({ ...DEFAULT_DECISION_POLICY_V3, maxVerifiedDrop: 0.9 });
    expect(changed).not.toBe(d1);
    // same planDigest but different policy → different threshold digest
    const stricter = computeThresholdDigestV3({ ...DEFAULT_DECISION_POLICY_V3, minConclusiveNetDelta: 99 });
    expect(stricter).not.toBe(d1);
  });

  it("validate round-trips a valid policy and rejects malformed ones", () => {
    expect(validateDecisionPolicyV3(DEFAULT_DECISION_POLICY_V3)).toEqual(DEFAULT_DECISION_POLICY_V3);
    expect(() => validateDecisionPolicyV3(null)).toThrow();
    expect(() => validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, minActivationCoverage: -0.1 })).toThrow();
    expect(() => validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, maxTokensDelta: "big" })).toThrow();
    expect(() => validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: 5 })).toThrow();
    // minRecoveryRate null is allowed
    expect(validateDecisionPolicyV3({ ...DEFAULT_DECISION_POLICY_V3, minRecoveryRate: null }).minRecoveryRate).toBeNull();
  });
});
