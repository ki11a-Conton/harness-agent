# E4-09 Report: Real Production-Path E2E (No Hand-Fabricated Passes)

## Objective

Prove the entire E3/E4 production chain with one fully offline end-to-end test in which **every intermediate artifact is produced by the previous real production stage** — eliminating the old e3-13 pattern of running a benchmark and then hand-building V3 artifacts with fabricated `passed` / `verification` / `security` fields.

## Completion status

E4-09 is implemented in commit `00b0c48`.

## Positive production chain (all real stages)

`apps/cli/src/e4-09-production-e2e.test.ts` chains:

```text
fake cases
-> arm-aware deterministic provider (fake MODEL, real arm-driven outcomes)
-> CLI benchmark entry (runBenchmarkCommand)
-> real paired executor
-> canonical V3 (in-process writer + strict reload)
-> real champion evaluator (runV3ChampionEval)
-> DecisionArtifact
-> real promotion envelope + strict loader + CAS
-> applicationPending
-> real createHarness startup (createHarnessWithChampion)
-> applied proof
-> observable candidate behavior
```

No `buildV3ArtifactPair`, no hand-filled booleans. Every artifact is read from disk and produced by the preceding stage.

### How the candidate genuinely wins (offline, deterministic)

The paired executor runs both arms against one provider. The difference is driven by the **real arm config**, not by the test:

- The candidate arm (`budget_aware_completion_v1`) has its budget-aware completion guidance injected into the agent system prompt by the production `runOneCase` wiring — and only when a candidate is active.
- The baseline arm has no such guidance.
- The deterministic fake provider keys on that injected guidance marker: the candidate is driven to call `write_file` (producing `out.txt`), the baseline is not.
- Each case's verification is `{ kind: "artifact", path: "out.txt", mustChange: true }`, which passes only when the file exists **and** appears in `changedPaths` — so the candidate passes every repetition and the baseline fails every repetition.

This yields a real, positive net delta and a genuine `ACCEPT` from the real evaluator.

### Isolation and billing

- The isolation probe is mocked to a strong backend so the promotion run is `promotionEligible: true` / `isolationStrength: "strong"` (the offline stand-in for a real OS sandbox).
- A provider override forces `offline-test` billing: zero paid provider calls, no `RUN_PAID_BENCHMARKS`.

### Observable candidate behavior (not mere config equality)

The test asserts the candidate's real runtime ACTIONS differed:

- `candV3.outcomes.every(passed)` is true and `baseV3.outcomes.every(not passed)` is true (real outcomes from the executor);
- the provider spy records that candidate-arm calls wrote the file and baseline-arm calls never did;
- after application, the live harness runs the `champion` profile and the applied proof's `appliedConfigHash` equals its `targetConfigHash`.

## Adversarial E2E on the real chain

Four attacks, each on genuine production-stage artifacts:

| attack | rejected by |
|---|---|
| edit a real V3 candidate artifact's outcomes, refresh only the envelope file SHA | `ARTIFACT_NOT_V3` (the artifact's internal content digest no longer matches) |
| forge a decision `statistics` field and recompute the decision artifact digest | `DECISION_REPLAY_MISMATCH` (the evaluator replay reproduces the true payload) |
| point the candidate ref outside the trusted bundle root | `PATH_OUTSIDE_BUNDLE` |
| set `--max-model-calls` below the plan estimate | refused at preflight before any provider call; no promotable artifact produced |

## Manual artifact helper downgraded

`e3-13-production-path.test.ts`'s `buildV3ArtifactPair` now carries an explicit **SYNTHETIC TEST FIXTURE — NOT production-chain evidence** header: it uses the production writer but fabricates outcome rows, so it may only exercise downstream mechanics on a known-good shape. The real chain is proven in `e4-09-production-e2e.test.ts`.

## Acceptance evidence

- `tsc -b` clean.
- Full suite: **5484 passed / 1 skipped (298 files)**.
- E4-09 file: 5 tests (1 positive chain + 4 adversarial), all passing, fully offline.
- Working tree clean at `00b0c48`.

## What this proves

- Each artifact's producer is a real production stage (the chain reads only files written by the prior stage).
- No hand-overridden `passed` / `verification` / `security`.
- The positive chain reaches `applied = true` through the real `createHarness`.
- Tampering any artifact byte (while refreshing the reachable digests) breaks the chain.
- The provider-call budget guard prevents an over-budget run from yielding a promotable artifact.
