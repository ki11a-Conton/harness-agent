# E4-05 Report: Exact Pairing, Repetition Counting, and Plan-Bound Decision Policy

## Objective

Fix the V3 evaluator so it compares **(caseId, repetition)** pairs exactly (not
just caseId sets), counts repetitions honestly, and binds the promotion
thresholds to a versioned, digest-verified DecisionPolicy instead of hardcoded
literals.

## Completion status

Implemented in commits `102ecd4` (pairing) and `0042a6c` (policy).

## 1. Canonical PairKey + exact multiset pairing (`102ecd4`)

The high-risk defect: the evaluator keyed outcomes by `caseId` alone, so a
baseline with repetition 1 and a candidate with repetitions 1–2 collapsed into
one map entry and could be scored as a complete, favorable pair.

- `pairKeyV3(o) = suite ␀ caseId ␀ repetition` (NUL-separated, canonical).
- `evaluatePairing(baseline, candidate)` builds a `Map<PairKey, …>` per arm and:
  - flags a **duplicate PairKey** on insert (two outcomes for the same
    suite/case/rep);
  - requires the two arms to have **identical key SETS** (missing / extra keys
    are violations);
  - validates the **repetition set** per case: repetition 0 is a violation and
    gaps in 1..N are violations (contiguity);
  - computes `netPassedDelta` and per-repetition deltas over **paired keys
    only** — no zero-filling of an arm's missing repetitions.

This closes the mispairing ACCEPT path.

## 2. Versioned, digest-verified DecisionPolicy (`0042a6c`)

Thresholds were hardcoded inside the evaluator, so a decision could not be
attributed to a pre-registered plan and thresholds could drift with no record.

- `decision-policy-v3.ts`: `DecisionPolicyV3` (minActivationEligibleCases,
  minActivationCoverage, maxVerifiedDrop, minConclusiveNetDelta, maxTokensDelta,
  securityBreachesAllowed, minRecoveryRate) + a versioned
  `DEFAULT_DECISION_POLICY_V3` (byte-identical to the old literals) +
  `computeThresholdDigestV3` + strict `validateDecisionPolicyV3`.
- `deriveV3Decision` now RECEIVES a policy, reads every threshold from it, and
  verifies `manifest.thresholdDigest == digest(applied policy)` (a tampered
  threshold → INVALID) and `manifest.repeat == observed repetitions` (plan /
  manifest / outcome disagreement → INVALID).
- `runV3ChampionEval` reads the FULL validated policy from
  `manifest.decisionPolicy` (not just a planDigest string).
- `DecisionArtifactV3` carries `thresholdDigest` + `policyVersion`.

## Tests

- `paired-key.test.ts` (9): duplicate key, key-set mismatch, repetition 0,
  repetition gaps, deltas over paired keys only, per-rep sum equals net.
- `decision-policy-v3.test.ts` (3): digest determinism + sensitivity (same
  planDigest, different policy → different digest); validate round-trip; rejects
  out-of-range.
- `champion-eval-v3.test.ts`: mispairing regression (rep-collapsed pair no
  longer ACCEPTs) + policy tests (manifest thresholdDigest mismatch → INVALID;
  manifest.repeat mismatch → INVALID; a stricter policy flips ACCEPT →
  INCONCLUSIVE with a matching digest; malformed policy rejected).

## Acceptance

- `tsc -b` clean.
- Full `packages/evaluation` + `apps/cli/src` green at the time of the commits
  (1177 passed, 96 files).

## Deliverables

- canonical PairKey: complete.
- exact multiset validator: complete.
- versioned DecisionPolicy: complete.
- mismatch regression test: complete.
- E4-05 report: complete.
