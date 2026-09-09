# E4-R02 Report — V3 strict read + per-sample fact preservation

## Scope

Fixed F03 (evaluator read unverified bytes) and F04 (security outcomes collapsed
by `caseId`, losing repetitions). R02's remaining items (reduction over the
complete event stream vs. truncated display, verification "last-wins", recovery
decision provenance) are covered here where they touch the strict read/builder;
any that require new execution-path plumbing beyond this read boundary are noted
as remaining, not silently skipped.

## F03 — evaluator must use the SAME strict read as the loader

**Reproduced:** zeroing a valid V3's `candidate.contentDigest` (64 zeros) was
rejected by `loadExperimentArtifactV3` but `runV3ChampionEval` still returned
`decision: ACCEPT` with `digestValid: true`, because `loadV3ArtifactPair` only
`JSON.parse`-d its inputs and `deriveV3Decision` hardcoded `digestValid = true`.

**Fix (loader.ts + champion-eval-v3.ts):**
- Extracted the ONE strict read path —
  `validateExperimentArtifactV3FromBytes(bytes, source)`: bytes → parse → schema →
  contentDigest → refs → eventRecords → summary (every field) → provenance.
  `loadExperimentArtifactV3` is now a thin file wrapper over it, so both readers
  share identical semantics.
- `loadV3ArtifactPair` keeps the `LEGACY_NOT_PROMOTION_ELIGIBLE` gate for non-V3
  shapes, then runs **both** artifacts through the strict reader. A tampered
  digest / forged summary / dangling ref now fails the evaluator with the same
  `SCHEMA` error the loader raises. `digestValid` is no longer an assumption — it
  derives from a validated load.

**Loader vs evaluator — before this fix / after (all three tampers):**

| tamper | strict loader | evaluator before | evaluator after |
|---|---|---|---|
| `contentDigest` → 64 zeros | CONTENT_DIGEST_MISMATCH | **ACCEPT, digestValid=true** | rejected |
| `summary.passed` → 999 | SUMMARY_MISMATCH | **ACCEPT** | rejected |
| `activationRef` → ghost | DANGLING_REF | **ACCEPT** | rejected |

Test `champion-eval-strict-read.test.ts` (+4): control ACCEPT plus each tamper
asserted rejected by **both** readers. (The fixture fix in `champion-eval-v3`'s
`makePair` — emitting matching `activationEvidence` for its `ae-1` ref — is
itself a latent fixture defect the stricter gate caught.)

## F04 — security outcomes are per-sample, never a `Map<caseId>` overwrite

**Reproduced:** case `ho-01` rep1=ESCAPE + rep2=NO_ATTACK_ATTEMPT collapsed to a
single `clean` record because `securityOutcomeFrom` keyed the artifact's
`securityOutcomes` by `caseId` and `securityOutcomeRef` pointed at that same
`caseId`. The rep1 escape evidence vanished and both outcomes referenced one
record — exactly the "两个 outcome 引同一个 caseId" defect.

**Fix (paired-v3-builder.ts):** each `SecurityOutcomeV3` id and each outcome's
`securityOutcomeRef` are the per-sample key
`suite\u0000caseId\u0000repetition\u0000arm`. Two repetitions keep two records;
a baseline outcome can never borrow a candidate's record; the kind union is
carried 1:1 (no flattening ESCAPE vs NO_ATTACK_ATTEMPT vs MISSING_EXPECTED_EVENT
into a clean/breach boolean).

**Real artifact excerpt after the fix** (two reps of `ho-01`, candidate arm):

```text
securityOutcomes (per-sample ids):
  kind=escaped id="adversarial\0ho-01\01\0candidate" detail=ESCAPE rep=1 arm=candidate: unauthorized_escape
  kind=clean   id="adversarial\0ho-01\02\0candidate" detail=NO_ATTACK_ATTEMPT rep=2 arm=candidate
outcome refs:
  case=ho-01 rep=1 securityOutcomeRef="adversarial\0ho-01\01\0candidate"
  case=ho-01 rep=2 securityOutcomeRef="adversarial\0ho-01\02\0candidate"
```

The escape at rep1 is present and distinct; rep1 and rep2 reference different
records. Regression `paired-v3-security-per-sample.test.ts` (+2) pins both facts.

## R02 items addressed vs. remaining (honest)

Addressed here: F03 (strict read shared), F04 (per-sample security + distinct
ids + 1:1 kind preservation), per-sample uniqueness (suite·case·rep·arm) via the
builder, dangling/duplicate/cross-ref rejection (now enforced on BOTH readers),
activation evidence still tied to real recorder event ids.

**Not yet done in this task (tracked, not claimed):**
- #9 reduction over the *complete* event stream — the builder already carries
  full `eventRecords` chunks; deriving security/verification strictly from the
  untruncated stream (not the display-trimmed `events`) is verified in R03/R08
  event-flow tests.
- #11 verification "last valid result wins" and #12 recovery-decision provenance
  (real action/budgetExhausted/attempt/event ref, explicit unknown vs. a guessed
  default) are builder/evaluator refinements validated by R03's completeness gate;
  not asserted complete here.
- #13 loader re-verifying R01 manifest fields (repeat/policy/completion) is
  exercised by R03/R04.

## Verification

```text
pnpm typecheck (tsc -b whole repo)   clean (exit 0)
packages/evaluation                  green at each R02 commit
full offline suite                    see below (R02 commits)
```

- No real provider calls; everything offline with fake fixtures.
- No isolation event in any test is presented as a real OS sandbox — these are
  constructed `SecurityOutcomeV2` inputs, i.e. read/write fidelity, not
  confinement proof.

## Commits

- `3b2c4e3` F03 strict read shared (loader + evaluator) + tests
- `cfc1c4a` F04 per-sample security ids in the builder
- `738ed71` F04 per-sample regression test
