# E4-R01 Report — one execution identity across preflight, journal and V3

## Defect (F01, F02)

`runPairedPromotion` re-derived a digest it called `planDigest` from only
`suite / cases / repetitions / orderSeed` and named the resume journal directory
with it. That value is a **schedule** description, not an experiment identity, so:

- **F01** — two genuinely different experiments (other candidate, other
  provider/model, edited case **input**, other source tree, other decision
  policy, other isolation posture, other budget) shared one journal directory and
  could silently reuse each other's arm records. The CLI's `--plan-digest`
  confirmation covered the *execution* plan, so the confirmed identity and the
  resumed identity were never the same thing. (This session's paid runs are a live
  example: the same digest was reused across different provider/model values.)
- **F02** — an incomplete run could still emit `promotionEligible=true` V3 for
  whichever subset happened to pair up.

## Two identities, now kept distinct

| role | function | what it describes |
|---|---|---|
| `scheduleDigest` | `computePairedPlanDigest` / `computeScheduleDigestV1` | the AB/BA grid: suite, cases, repetitions, orderSeed |
| `executionIdentityDigest` | `computeExecutionIdentityDigestV1` | **the experiment**: schedule + case input fingerprints + arm config hashes + provider/model/effective params + sourceSha/tree fingerprint + all four limits + billingClass + isolation backend/strength/self-test + promotionEligible + DecisionPolicy + thresholdDigest |
| `planDigest` (preflight) | `computeBenchmarkPlanDigest` | the confirmed BenchmarkExecutionPlan, carried into execution instead of being re-derived |

Secrets (API keys/tokens) are never fields of the identity; only non-sensitive
effective configuration or a fingerprint of it.

## Real mismatch evidence

Comparing a journal identity against a changed experiment (values truncated):

```text
scheduleDigest          = d07b6e73a1de7a7b...
identityDigest(base)    = 79f7b0d8c2430e50...
identityDigest(changed) = 1819c2b23aea79a9...
violations:
  - candidate: journal cand-a != current cand-B
  - caseFingerprints.c2: journal h2 != current h2-EDITED
  - isolationStrength: journal none != current strong
  - limits.maxModelCalls: journal null != current 5
  - promotionEligible: journal false != current true
  - providerId: journal p != current other
journal dir differs: true
```

Note `caseFingerprints.c2` — editing a case file while keeping its id changes the
identity, which the old schedule digest could not see.

## What changed

- `packages/evaluation/src/paired-execution-identity.ts` (new): the identity
  type, `buildExecutionIdentityV1` (single constructor, so a confirmed plan and a
  resuming executor cannot drift), `computeExecutionIdentityDigestV1`,
  `executionIdentityViolationsV1` (field-level, secret-free messages),
  `caseInputFingerprintV1`.
- `paired-executor.ts`: writes an `identity.json` journal header and verifies it
  **before** the provider is wrapped or called; mismatch → `resume-rejected` with
  `violations`; a headerless (pre-R01) journal is refused **and preserved**
  untouched. Budget remains cumulative across resumes (consumed calls are
  re-seeded, so a new process cannot re-spend a granted allowance; extra budget
  needs a deliberately new authorized plan).
- `apps/cli/src/benchmark-command.ts`: the confirmed `PreflightResult` is threaded
  into `executeBenchmark` → `runPairedPromotion` (also for `smoke`); the journal
  directory is named by the **execution identity** digest; the artifact records
  `planDigest` (execution), `scheduleDigest` and `executionIdentityDigest`.
  `PreflightResult` now also carries `isolationBackendId` and `billingClass`.
- **F02**: `promotionEligible` requires strong isolation **and** a complete run
  (`complete && partialPairs.length === 0`); otherwise `incompleteReason` is
  `budget-halted` / `partial-pairs` / `interrupted` and eligibility is false — a
  finished-but-partial subset can never be promoted.
- V3 manifests carry `executionIdentityDigest`, `scheduleDigest`,
  `expectedSampleKeys`, `runComplete`, `incompleteReason` (optional, backward
  compatible), so an artifact states which experiment produced it and whether it
  was whole.
- Repetition handling unchanged: the executor's 0-based index is converted to
  V3's 1-based exactly once, at the builder seam; `attempt`, transport retries and
  independent repetitions stay separate counters.

## Tests

- `paired-execution-identity.test.ts` (+7): each security-relevant field
  (candidate, provider/model, case input, sourceSha, policy, thresholdDigest,
  isolation, budget) refused; **`provider.callCount === 0`** asserted on every
  rejection; legacy headerless journal refused and preserved; unchanged identity
  resumes with no duplicated arm work; digest stability.
- `paired-v3-identity.test.ts` (+3): identity/completeness recorded in the
  manifest; **F02** partial run not eligible despite an exactly-paired subset;
  old callers unaffected.
- `paired-executor.test.ts`: resume tests updated to supply identity; the
  digest-mismatch case strengthened to assert the named violating field and that
  the provider was never called. The arm-file count assertion excludes the new
  `identity.json` header (it counts arm journals, as intended).

## Verification

```text
pnpm typecheck (tsc -b, whole repo)   clean
packages/evaluation + apps/cli         1247 passed / 102 files
identity + paired groups                19 passed / 3 files (R01 subset)
```

No real provider calls; everything offline with fake providers.

## Explicitly not claimed

- This task proves the **call chain and identity binding**. The `insecure-local`
  and fake-backend values used in tests are **not** OS-confinement evidence, and
  `promotionEligible` in tests is a property of the constructed identity, not a
  claim that a real strong backend ran.
- E4 does **not** close with this task: R02–R10 remain (strict V3 reading and
  per-sample facts, sample-grid/policy/security completeness, promotion identity
  mis-binding and read order, application proof, recovery durability details,
  runtime-evidence-based `observed`, GateEvidenceV2 strictness and V2 release
  wiring, and the documentation close-out).
