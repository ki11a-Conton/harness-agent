# E4-04 — Real Activation & Security Evidence Wiring

**Status: PARTIAL — security evidence half DONE (production-wired + tested); activation V2 recorder half PENDING (next round).**
**Branch:** `e4-production-closure` · **Commits:** `121f63e` (part 1), `8c060c7` (part 2) · **Offline:** providerCalls = 0.

## Scope (from plan §E4-04)

Wire the promotion-grade evidence recorders/classifiers into the REAL execution
chain so every outcome references traceable events, and a missing observer is
never read as clean. Six sub-requirements:

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Call `createActivationRecorderV2` in the real execution path | ⏳ PENDING |
| 2 | Call `classifySecurityOutcomeV2` in the real tool/security event path | ✅ DONE |
| 3 | Each outcome references traceable activation/security events | ✅ security DONE · ⏳ activation pending |
| 4 | Missing security evidence ≠ clean | ✅ DONE |
| 5 | `activationEligibleCases` from completed case evidence, not `Map.size` | ✅ already evidence-based (see below) |
| 6 | Delete/mark legacy `activationEvidenceFor` production path | ⏳ PENDING (still the only activation producer) |

## What is DONE — Security evidence (parts 1–2)

### The gap closed
Before E4-04 the paired→V3 conversion (`paired-to-v3.mjs`) hardcoded
`securityOutcomes: []`, so **every** case was silently reported as having no
security signal — a missing observer was indistinguishable from a clean run.
This is the single most severe E4-04 defect (a security-blind promotion gate).

### Production wiring
- `packages/evaluation/src/security-evidence-execution.ts` (new):
  `buildSecurityOutcomeFromEventsV2(input)` turns a case's **actual** event
  stream + the E1-02 workspace-escape and E2-09 host-mutation sentinels into a
  typed `SecurityOutcomeV2` via `classifySecurityOutcomeV2` + the boundary fact
  builders:
  - `security.*_denied` → `ATTACK_ATTEMPTED` + `POLICY_DENIED` on the **same**
    tool-call id ⇒ proven `CONTAINED` (not text-guessed);
  - workspace escape / host mutation ⇒ `ESCAPE` (`hardBreach: true`);
  - **E4-04 #4:** a case that *expected* attack/denial but whose observer
    produced **zero** security facts ⇒ `MISSING_EXPECTED_EVENT`, never
    `CONTAINED`/`NO_ATTACK_ATTEMPT`. This is the "missing ≠ clean" rule.
  - `securityExpectationFromCase(caseDef)` derives `expectedAttack`/
    `expectedDenial` from `caseDef.forbidden` / `expected.status`.
- `apps/cli/src/benchmark-command.ts` `runOneCase`: builds the outcome from
  `base.events` + sentinels on **both** the normal and the host-mutation return
  paths; `armId` = `candidate`/`baseline` from `opts.candidate`.
- `packages/evaluation/src/runner.ts`: `EvalOutcome.securityOutcome?`.
- `packages/evaluation/src/baseline.ts`: report row exposes `security_outcome`.
- `packages/evaluation/src/artifact-v3/{types,schema}.ts`: `SecurityOutcomeV3.kind`
  widened to `attack_attempted | escaped | blocked | clean | not_observed |
  classifier_error | legacy` so the missing-vs-clean distinction survives into
  the artifact; the parser now validates the full enum (was a 4-value set).
- `apps/cli/scripts/paired-to-v3.mjs`: maps the real V2 outcome into V3
  `securityOutcomes` (per arm) and sets each outcome's `securityOutcomeRef`
  (was `null`). V2→V3 kind map:
  `CONTAINED→blocked, ESCAPE→escaped, INVALID→classifier_error,
  MISSING_EXPECTED_EVENT→not_observed, NO_ATTACK_ATTEMPT→clean,
  UNKNOWN_LEGACY→legacy`.

### #5 — activationEligibleCases
`champion-eval-v3.ts:189` already computes
`activated = candidate.outcomes.filter(o => o.activationRef !== null).length`
— derived from per-case evidence, **not** a `Map.size`. No `Map.size`-based
eligibility exists in the promotion path. (E4-05's canonical-pair rework will
re-examine this alongside the DecisionPolicy thresholds.)

### Tests
- `security-evidence-execution.test.ts` (9): attempted+denied→CONTAINED,
  escape→ESCAPE(hard), host-mutation→ESCAPE, **adversarial-no-observer→
  MISSING_EXPECTED_EVENT (not clean)**, clean→NO_ATTACK_ATTEMPT, ordered unique
  fact ids, expectation derivation (forbidden / denied-status / plain).
- `benchmark-command.test.ts` (+1 production): `runBenchmarkCommand` end-to-end
  with a scripted provider — clean case ⇒ `security_outcome.kind ===
  NO_ATTACK_ATTEMPT` (schemaVersion 2.0.0); adversarial `forbidden.sideEffects`
  case with no denial ⇒ `MISSING_EXPECTED_EVENT`, `hardBreach:false`.

### Verification
- `tsc -b` clean.
- Full `packages/evaluation` + `apps/cli/src`: **1144 passed (92 files)**, no
  regressions from the enum widening / report field / missing-evidence override.

## What is PENDING — Activation V2 recorder (part 3, next round)

`createActivationRecorderV2` / `validateActivationV2` / `aggregateActivationV2`
(`activation-evidence-v2.ts`) exist and are unit-tested but are **not** yet
called in production; `runOneCase` still uses the legacy V1
`activationEvidenceFor` (lines ~1611, 1626). The V1 path already derives from
real events (not the candidate name) but lacks the V2 guarantees: recomputable
payload digests, lineage validation (`LINEAGE_MISMATCH`), `SELF_REPORTED_ACTIVATION`
rejection, `EMPTY_MEMORY_INJECTION` ⇒ eligibleButNotActivated, and all-pairs /
eligible-pairs / activated-pairs quality attribution.

### De-risked wiring plan (lineage sources confirmed)
1. **Thread lineage into `RunOneCaseOptions`**: add `armId?`, `repetition?`,
   `attempt?`. The paired call site (`benchmark-command.ts:555`) already has
   `arm.armId` and `arm.repetition` (ArmRunRef); pass them. Baseline call sites
   (358, 405) default `armId:"baseline"`, `repetition:1`, `attempt:1`.
2. **Record in the observer** (`benchmark-command.ts:1215` `events.onAppended`):
   for each real signal (tool_lookup / recovery.decided / memory.retrieved /
   budget-guidance), `recorder.record(ActivationEventV2)` with mechanism +
   evidenceType mapped from `armMechanisms`, `payload.digest = sha256(canonical
   payload)`, and the threaded lineage. Keep the V1 `activationEvents` array
   until the V2 path fully replaces it.
3. **Validate + aggregate** after execution: `validateActivationV2(events,
   {expectedCandidateId, expectedArmId, outcomeLineages, recomputeDigest})` and
   `aggregateActivationV2(...)`; attach `activationEvidenceV2` + validation to
   the `EvalOutcome` (new field).
4. **Consume in V3**: `paired-to-v3.mjs` (and later the E4-02 in-process builder)
   maps the V2 evidence to `ActivationEvidenceV3` + sets `activationRef` from a
   real event id (so the E4-03 `DANGLING_REF` check proves traceability).
5. **Legacy removal (#6)**: once the V2 path produces the artifact evidence,
   delete `activationEvidenceFor` from the production import and mark
   `activation-evidence.ts` legacy-only (keep for V1 readers/tests).

### Acceptance (to complete E4-04)
- New fake-execution test asserting recorder/classifier call counts, V3
  `activationRef`/`securityOutcomeRef` all resolvable, coverage computable,
  escaped/missing-evidence ⇒ not ACCEPT, and `activationEvidenceFor` has no
  production consumers.

## Notes / deferrals
- `paired-to-v3.mjs` still uses placeholder digests (`"e3-14-run"`) that E4-03
  strict-load rejects; the script is E4-02's elimination target and is not
  unit-tested, so this is tracked under E4-02, not E4-04.
- The V3 `SecurityOutcomeV3` collapses per-repetition security into one entry
  per caseId (no repetition field); acceptable for the interim manual path, to
  revisit when E4-02 builds V3 in-process.
