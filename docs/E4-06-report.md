# E4-06 — Rebuild the promotion trust boundary

## Objective

Make the promotion loader unable to advance the champion on the strength of a
JSON that merely says `ACCEPT` with correct file SHAs. The loader must verify
*what the content is*, *which plan produced it*, and *how the decision was
derived* — and reject on any inconsistency without mutating state.

## Status: core trust boundary REBUILT and verified (commits 949bfa9, 9f661a6, 7e6bae4)

### What the loader now enforces (verification order)

```
read envelope
-> schema + envelope canonical contentDigest          (DIGEST_MISMATCH)
-> role-structured artifactRefs: exactly one baseline + one candidate
   (MISSING_REQUIRED_FIELD / CROSS_BINDING_MISMATCH on duplicate role)
-> one file may not impersonate two roles             (CROSS_BINDING_MISMATCH)
-> every ref + the decision artifact resolve INSIDE the trusted bundleRoot,
   lexically and after realpath (no .. / absolute-elsewhere / symlink escape)
                                                       (PATH_OUTSIDE_BUNDLE)
-> file byte SHA of each ref                          (ARTIFACT_DIGEST_CHANGED)
-> strict-load baseline + candidate as REAL V3 artifacts: schema + refs +
   internal contentDigest + summary + eventRecords    (ARTIFACT_NOT_V3)
-> candidate manifest.promotionEligible === true      (CANDIDATE_NOT_ELIGIBLE)
-> recompute DecisionArtifact.contentDigest           (DECISION_ARTIFACT_DIGEST_INVALID)
-> cross-bind decision.candidateId / planDigest / envelope.sourceSha to the
   artifacts                                          (CROSS_BINDING_MISMATCH)
-> REPLAY the pure evaluator on the strict-loaded pair and require the FULL
   decision payload to match the stored artifact; verify thresholdDigest ==
   digest(embedded policy) and evaluatorVersion == current
                                                       (DECISION_REPLAY_MISMATCH)
-> only then may the caller enter applicationPending (CAS write happens after)
```

### DecisionArtifactV3 bindings (#4)

`schemaVersion, policyVersion, thresholdDigest, policy (full, embedded),
evaluatorVersion, candidateId, planDigest, baselineArtifactDigest,
candidateArtifactDigest, decision, reasonCodes, gates, statistics,
perRepetitionDeltas, repetitions, contentDigest`. The embedded `policy` makes
the evaluator replay self-contained; `thresholdDigest` and `evaluatorVersion`
are bound into the artifact's own content digest.

### Forged regression suite — `promotion-envelope-forgery.test.ts` (15 cases)

Positive control (a genuine writer+evaluator bundle is accepted) plus every
negative case from the acceptance matrix, each rejected with its specific code:

| forgery | code |
|---|---|
| candidate is plain text but its file SHA is correct | ARTIFACT_NOT_V3 |
| outcomes edited, only the envelope file SHA updated | ARTIFACT_NOT_V3 (internal digest) |
| DecisionArtifact.contentDigest randomized | DECISION_ARTIFACT_DIGEST_INVALID |
| thresholdDigest tampered (embedded policy unchanged) | DECISION_REPLAY_MISMATCH |
| evaluatorVersion randomized (digest recomputed) | DECISION_REPLAY_MISMATCH |
| decision flipped to ACCEPT over a failing pair | DECISION_REPLAY_MISMATCH |
| baseline ref points at the candidate file | CROSS_BINDING_MISMATCH |
| planDigest inconsistent | CROSS_BINDING_MISMATCH |
| sourceSha inconsistent | CROSS_BINDING_MISMATCH |
| envelope digest not updated after a field edit | DIGEST_MISMATCH |
| candidate promotionEligible=false | CANDIDATE_NOT_ELIGIBLE |
| path traversal (ref escapes bundle root) | PATH_OUTSIDE_BUNDLE |
| symlink escape (ref links out of bundle) | PATH_OUTSIDE_BUNDLE |
| rejected load leaves every file byte-identical | (loader is read-only) |

Positive bundle tests (`e3-13` FULL PROMOTION, `e2-final-integration` E) were
updated to use a COMPLETE real bundle whose decision is DERIVED via
`runV3ChampionEval` on a genuine 2-repetition pair — hand-filled gates are now
rejected by the replay, which is the point.

## Acceptance

- `tsc -b` clean.
- Full `packages/evaluation` + `apps/cli/src`: **1192 passed (97 files)**.
- Adversarial envelope tests (`e3-07`, `e3-13` #3) still reject.
- `git status --short` empty at each commit.

## Deferred binding (documented, pairs with E4-07)

`#2` also lists an `executionPlan` role so the applied policy is bound to the
plan whose digest is `planDigest`. The current `PairedExperimentPlan` does not
carry a `DecisionPolicy`, so this needs plan-policy plumbing (add the policy to
the plan, fold it into `computeBenchmarkPlanDigest`, emit the plan as a bundle
artifact) that belongs with **E4-07**, which wires the real
`applicationPending -> applied` lifecycle and the bundle production path.

What is already closed without it: a hand-forged `ACCEPT` over a pair that
structurally fails (security breach, incomparability, incomplete pairing, or a
soft gate) is caught by the replay; tampered thresholds are caught by
`thresholdDigest == digest(embedded policy)`; a foreign evaluator is caught by
`evaluatorVersion`. The only residual gap is a *self-consistent* policy that
differs from the one the plan committed to — closed once the plan carries the
policy and the loader cross-checks `digest(plan.policy) == thresholdDigest`
against the `executionPlan` ref.
