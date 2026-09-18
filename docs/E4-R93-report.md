# E4-R93 report — the manifest validator now checks the whole schema and the whole semantics

Plan: `plan(20260917-083737).md` §R93 (finding A).
Baseline SHA: `232ae5f1b39b4c1907be31da908daa8bd7499233` (verified: `git rev-parse HEAD` == this SHA at start of work).
Zero real provider requests. Zero paid calls. `ScriptedModelProvider` only.

## 1. The defect (finding A), restated from source

`validateManifest` in `packages/core/src/runtime/r87-zero-call-replay-ab.ts` compared
exactly **three** fields of the declared summary against the recomputed one:

```ts
if (declaredSummary.verdict !== recomputedSummary.verdict) reasonCodes.push("SUMMARY_MISMATCH");
if (declaredSummary.completeness !== recomputedSummary.completeness) { ... }
if (declaredSummary.observedRecords !== recomputedSummary.observedRecords) { ... }
```

Everything else that can move a conclusion was unchecked: the mechanism metric
(`baselineTargetFires` / `candidateTargetFires` / `improvement`), `securityViolations`,
`verifiedCompletion`, `expectedRecords`, `counterexampleOutcomeDiffs`, `issues`; the
top-level `limits`, `caseOrder`, `scope.*`, `baselineSha` / `candidateSha`; each arm's
`sourceSha`, `streakResultAware`, `limits`; `identity.arms` (duplicate / unknown arm);
`providerCalls`; and `gate`.

Two further gaps:

- **Malformed JSON threw.** `validateManifest(null, selection)` died with
  `TypeError: Cannot read properties of null (reading 'schemaVersion')` instead of
  returning a structured `INVALID`. `identity.arms` as a string, a `records` string and
  a `[null]` record all produced unhandled `TypeError`s.
- **No trusted-expectation input.** The validator could only compare a manifest against
  itself, so it could never express "this must be the identity I obtained out of band".

## 2. What was built

`validateManifest(manifest: unknown, selection, opts?)` is now a full-schema,
full-semantics validator. It takes `unknown` (not a typed `Manifest`) and does not rely
on TypeScript assertions anywhere.

**Structural validation.** `isPlainObject` / `isNonEmptyString` / `isPositiveSafeInt` /
`isNonNegativeSafeInt` guards over every field. Unknown enums, missing objects, wrong
types and non-array containers each produce a named reason code. Nothing throws.

**Full summary comparison.** All nine summary fields are compared by canonical form,
with `mechanismMetric` decomposed into its three sub-fields so the reported detail names
the *offending sub-field* rather than its parent. Reason codes inside a manifest's own
`issues` array are checked against the closed `EVIDENCE_REASON_CODES` set.

**Cross-field consistency.** The identity's own `selectionDigest` / `selectionSchema`
must match the frozen selection (without this, recomputation would silently substitute
the caller's selection for a tampered one). `scope.executedSourceSha` /
`historicalReferenceSha` must equal `identity.*`; `scope.historicalReferenceSha` must
equal `baselineSha`; `scope.historicalReferenceCheckedOut` must be `false`; the synthetic
mapping counts must match. Each arm's `arm` / `sourceSha` / `streakResultAware` /
`limits` must match the frozen semantics, and every arm container key must be a known arm.

**Record-level placement.** Each record is validated against the canonical
`evidenceRecord` projection (closed field set, correct types, non-negative safe
integers, real booleans) and must sit in the arm its own `arm` field names. This closes a
gap the aggregate arm hash cannot: swapping two *outcome-identical* records between arms
leaves both arm hashes unchanged.

**A new status: `UNSUPPORTED`.** Distinct from `INVALID`:

| Situation | Status |
|---|---|
| `real_version_ab` + `emulated_semantics` | `INVALID` — the claim contradicts itself |
| `real_version_ab` + `isolated_build`, no two build digests | `UNSUPPORTED` — self-consistent, unsubstantiated |
| `real_version_ab` + `isolated_build`, two distinct digests | `VALID` |

The plan requires that flipping an enum must not be enough to claim a real two-version
A/B. A `real_version_ab` claim now needs `armBuildDigests` with two distinct non-empty
values. `buildManifest` emits that field only for a `real_version_ab` claim; a synthetic
mechanism experiment carries no build digests, because there are no two builds.

**Trusted expectation.** An optional `opts.expected` (`experimentId`, `selectionDigest`,
`executedSourceSha`, `fixtureDigest`) yields `IDENTITY_UNTRUSTED` on mismatch.

**Content integrity vs. source authenticity, separated.** The `VALID` detail string now
reads:

> `internally consistent: verdict MECHANISM_VALIDATED; identity well-formed. Internal consistency does NOT prove that the named code executed.`

The doc comment states the same in both directions: the validator proves internal
consistency, and the manifest is the only witness to its own execution.

**No value echo.** Failures report field *paths* and reasons only. A test injects
`sk-live-SECRETCANARY…` into a `caseId` and a `terminationReason` and asserts the
serialized result does not contain it.

## 3. RED → GREEN

**RED**, against the unmodified implementation, with the new test file present:

```
pnpm vitest run packages/core/src/runtime/r93-manifest-full-validation.test.ts
Test Files  1 failed (1)
     Tests  56 failed | 25 passed (81)
[exit code: 1]
```

The failures were for the intended reasons, not test-harness errors. Verified directly:

```
TypeError: Cannot read properties of null (reading 'schemaVersion')
TypeError: Cannot read properties of undefined (reading 'schemaVersion')
TypeError: ((intermediate value) ?? []).map is not a function
TypeError: records.map is not a function
TypeError: Cannot read properties of null (reading 'verdict')
```

and, for the field-level mutations, `AssertionError: expected 'VALID' to be 'INVALID'`
— i.e. the pre-fix validator genuinely blessed a manifest whose `limits`, `caseOrder`,
`scope`, arm identity, `providerCalls` or `gate` had been edited.

Two of the 25 initially-passing tests were the *pre-existing* checks
(`verdict`, `selectionDigest`, `identity.fixtureDigest`, `identity.limits`,
`identity.executedSourceSha`), which is expected: those fields were already covered.

**GREEN**, after the rewrite:

```
pnpm vitest run packages/core/src/runtime/r93-manifest-full-validation.test.ts
Test Files  1 passed (1)
     Tests  91 passed (91)
```

## 4. The one existing test that changed behaviour — and why it is correct

`r88-replay-evidence-gate.test.ts` "R90: an emulated-switch experiment may not claim a
real version A/B" asserted `INVALID` + `EXPERIMENT_ID_MISMATCH`; after the first
implementation it received `UNSUPPORTED`.

This was **not** papered over by relaxing the test. The two cases are genuinely
different defects, and collapsing them would have lost information:

- `real_version_ab` **with** `emulated_semantics` is a self-contradiction → `INVALID`
  (this is what R88's test describes, and it still passes unchanged).
- `real_version_ab` with `isolated_build` but no build digests is internally
  consistent and merely unsubstantiated → `UNSUPPORTED`.

The implementation was corrected to make exactly that distinction, and both behaviours
are now pinned by tests in the new file.

## 5. Non-vacuity — the trap that bit E4-R92's guard

A strict validator can be satisfied by rejecting everything. Three defences:

1. **The real artifact must still be blessed.** The committed
   `docs/evidence/e4-r90-phase-a-manifest.json` is loaded from disk and asserted
   `VALID` with `reasonCodes === []`. Confirmed by direct execution:

   ```
   STATUS: VALID
   CODES: []
   DETAIL: internally consistent: verdict MECHANISM_VALIDATED; identity well-formed.
           Internal consistency does NOT prove that the named code executed.
   ```

2. **Every rejection is attributable to its own mutation**, because the same
   construction path with no mutation is `VALID`.

3. **The mutation table cannot silently go stale.** Three "CLOSED SCHEMA" tests assert
   the exact key sets of `summary` (and `mechanismMetric`), the manifest, `identity`,
   `scope` and an evidence record. Adding a field to any of them fails the suite,
   forcing the author to extend the validator and the mutation table together. This was
   mutation-verified: injecting a `sneakyNewField` into both the `Summary` interface and
   the `computeSummary` return produced

   ```
   × CLOSED SCHEMA: the summary field set is exactly the one the validator compares
   +   "sneakyNewField",
   ```

   and the source was restored afterwards (`sneakyNewField` occurrences: 0).

## 6. Verification

| Command | Result |
|---|---|
| `pnpm vitest run packages/core/src/runtime/r93-manifest-full-validation.test.ts` | **91 passed** |
| `pnpm vitest run …/r87-zero-call-replay-ab.test.ts …/r88-replay-evidence-gate.test.ts` | **43 passed** (16 + 27) |
| `pnpm vitest run packages/core` | 46 files, **615 passed**, 0 failed |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `git diff --check` | exit 0 (no whitespace errors) |
| `pnpm test` in an isolated clean checkout at `399c311` | 342 files, **6295 passed \| 3 skipped**, exit 0 |

### 6.1 The dirty-tree precondition, and the isolated clean re-verification

The plan (§1, line 46) requires that when the pre-existing clean-tree guard fires because
of a dirty working tree, that is recorded as an **environment precondition** and re-verified
in an isolated clean checkout — never resolved by stashing or deleting the user's files.

Running `pnpm test` in the working tree at `399c311` produced:

```
Test Files  3 failed | 339 passed (342)
     Tests  6 failed | 6289 passed | 3 skipped (6298)
[exit code: 1]
```

All six failures are the documented clean-tree guard — `e4-r55-failure-wiring`,
`e4-09-production-e2e` (×4) and `benchmark-command` — and the dirty entries were exactly
the user's own two plan files (`D plan(20260917-001821).md`, `?? plan(20260917-083737).md`).
They were left untouched.

Re-verified in a detached worktree of the same commit, with an empty `git status --porcelain`:

```
git worktree add D:\r93-clean-wt 399c311
# HEAD 399c31172cc792074cbf96a9808cac37873f17cf, porcelain empty
pnpm test
Test Files  342 passed (342)
     Tests  6295 passed | 3 skipped (6298)
[exit code: 0]
```

The six failures are therefore attributable **only** to the dirty-tree precondition, not to
this change. The clean worktree was removed after the run.

Preserved behaviour, explicitly re-checked: legacy v1 and superseded v2 stay
`LEGACY_UNVERIFIED` with `LEGACY_SCHEMA`; an unknown schema is `INVALID` with
`SCHEMA_UNSUPPORTED`; an empty or single-arm matrix is still never `MECHANISM_VALIDATED`
(R88's fix intact); key order does not affect the result; a changed `caseOrder` is
rejected.

## 7. Honest limits

- **This is a test-and-validator change, not a runtime change.** It does not touch the
  agent runtime's execution path, so the Runtime Freeze (P38.4-11) criteria are not
  engaged: no runtime behaviour was modified.
- **Internal consistency is not proof of execution.** The validator proves a manifest
  agrees with its own records and the frozen selection. It cannot prove that the code
  named in `executedSourceSha` ever ran, because the manifest is the only witness. The
  `VALID` detail string says so.
- **`armBuildDigests` is a shape, not yet a mechanism.** The `real_version_ab` path now
  refuses a claim without two distinct build digests, but nothing in this change
  *produces* those digests — there is still no real two-checkout driver. The field is a
  guard against an unsubstantiated claim, not evidence that such a claim was ever
  properly made.
- **No real two-version A/B was run**, and no paid call was made.
- The findings the plan lists as **B, C** (R94), **D, E** (R95), **F** (R97) and **G**
  (R96) are untouched by this change.
- `docs/evidence/e4-r90-phase-a-manifest.json` was **not** modified. It is still
  `VALID` under the stricter validator, which is the strongest available evidence that
  R93 tightened the check rather than changing the contract.

## 8. Files

- `packages/core/src/runtime/r87-zero-call-replay-ab.ts` — `EVIDENCE_REASON_CODES` array
  + closed code set, strict structural guards, `TrustedExpectation` /
  `ValidateManifestOptions`, `armBuildDigests`, rewritten `validateManifest`,
  `UNSUPPORTED` status.
- `packages/core/src/runtime/r93-manifest-full-validation.test.ts` — new, 91 tests.
