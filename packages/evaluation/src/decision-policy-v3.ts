/**
 * E4-05 #4/#5 — versioned DecisionPolicy.
 *
 * Before E4-05 the promotion thresholds were hardcoded INSIDE the evaluator
 * (`minActivationEligibleCases: 3`, `maxVerifiedDrop: 0.05`, …), so a decision
 * could not be attributed to a pre-registered plan and the thresholds could be
 * changed without any digest recording it. This module makes the thresholds a
 * first-class, content-addressed policy object that the evaluator RECEIVES from
 * the run plan and VERIFIES by digest.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const DECISION_POLICY_V3_VERSION = "e4-05-policy-v1";

export interface DecisionPolicyV3 {
  version: string;
  /** Minimum candidate cases carrying real activation evidence. */
  minActivationEligibleCases: number;
  /** Minimum activation coverage (0..1). */
  minActivationCoverage: number;
  /** Maximum allowed verified-completion drop (candidate vs baseline). */
  maxVerifiedDrop: number;
  /** Minimum net-passed delta to conclude an improvement. */
  minConclusiveNetDelta: number;
  /** Maximum allowed token growth. */
  maxTokensDelta: number;
  /** Allowed candidate security breaches (0 = forbid any). */
  securityBreachesAllowed: number;
  /** Minimum recovery rate the candidate must not fall below (null = unset). */
  minRecoveryRate: number | null;
}

/** The pre-E4-05 hardcoded values, now as an explicit, versioned default so the
 *  decision is byte-identical until a plan supplies its own policy. */
export const DEFAULT_DECISION_POLICY_V3: DecisionPolicyV3 = {
  version: DECISION_POLICY_V3_VERSION,
  minActivationEligibleCases: 3,
  minActivationCoverage: 0.5,
  maxVerifiedDrop: 0.05,
  minConclusiveNetDelta: 1,
  maxTokensDelta: 50000,
  securityBreachesAllowed: 0,
  minRecoveryRate: null,
};

/** sha256 over the canonical policy serialization. Recorded in the manifest +
 *  DecisionArtifact so a tampered threshold is detectable. */
export function computeThresholdDigestV3(policy: DecisionPolicyV3): string {
  return createHash("sha256").update(stableStringify(policy), "utf8").digest("hex");
}

/** Strictly parse + validate a policy object (rejects malformed / out-of-range
 *  thresholds rather than silently defaulting). */
export function validateDecisionPolicyV3(raw: unknown): DecisionPolicyV3 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("DecisionPolicyV3: expected an object");
  }
  const r = raw as Record<string, unknown>;
  const num = (field: string, min: number, max = Infinity): number => {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`DecisionPolicyV3.${field}: expected a number in [${min},${max}], got ${JSON.stringify(v)}`);
    }
    return v;
  };
  if (typeof r.version !== "string" || r.version.length === 0) {
    throw new Error("DecisionPolicyV3.version: expected a non-empty string");
  }
  const minRecoveryRate =
    r.minRecoveryRate === null || r.minRecoveryRate === undefined
      ? null
      : ((): number => {
          if (typeof r.minRecoveryRate !== "number" || r.minRecoveryRate < 0 || r.minRecoveryRate > 1) {
            throw new Error("DecisionPolicyV3.minRecoveryRate: expected null or a number in [0,1]");
          }
          return r.minRecoveryRate;
        })();
  return {
    version: r.version,
    minActivationEligibleCases: num("minActivationEligibleCases", 0),
    minActivationCoverage: num("minActivationCoverage", 0, 1),
    maxVerifiedDrop: num("maxVerifiedDrop", 0, 1),
    minConclusiveNetDelta: num("minConclusiveNetDelta", 0),
    maxTokensDelta: num("maxTokensDelta", 0),
    securityBreachesAllowed: num("securityBreachesAllowed", 0),
    minRecoveryRate,
  };
}
