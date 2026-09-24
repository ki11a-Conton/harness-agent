# E4-R88 report — the A/B verdict and resume path refuse incomplete or foreign evidence

Plan: `plan(20260917-001821).md` §R88 (findings **F1** and **F2**).

## Status

| Item | Value |
| --- | --- |
| Task | R88 — fail-closed A/B verdict + identity-bound resume + offline validator |
| Start SHA | `db16dace0d2b864c7002f3a5158ccfe8c004f4ef` |
| Ending SHA | see §10 (this report's commit) |
| Provider / model calls | **0** (ScriptedModelProvider only; no key, no network) |
| Paid spend | **0** |
| Verdict | F1 fixed, F2 fixed — RED and GREEN both reproduced locally |

## 1. Findings addressed

**F1 (P1)** — `computeSummary` derived its expected set from the *observed*
results. With only baseline TARGET failures and **zero** candidate records it
reported `improvement = 3`, while the verified-completion guard iterated an empty
set and was vacuously true, so the function returned `MECHANISM_VALIDATED` on
incomplete evidence.

**F2 (P1)** — `runReplayAb` never verified the frozen selection digest itself,
and its resume path keyed only on `caseId/arm`. Records from another experiment,
a changed implementation, or a truncated write were silently absorbed as this
experiment's results.

## 2. RED evidence (before the fix)

The plan requires the original defect to be reproduced, not merely asserted. The
pre-R88 `computeSummary` was extracted verbatim from `db16dac` (TypeScript types
stripped, exactly as the reviewer did) and run against the reviewer's scenario:

```
$ node scripts/e4/r88-red-evidence.mjs
PRE-R88 (RED) input: 3 baseline TARGET failures, 0 candidate records
PRE-R88 (RED) output: {"mechanismMetric":{"baselineTargetFires":3,"candidateTargetFires":0,
  "improvement":3},"counterexampleOutcomeDiffs":[],"securityViolations":0,
  "verifiedCompletion":true,"verdict":"MECHANISM_VALIDATED"}
RED confirmed (bug present in the pre-R88 code): true
```

The script exits non-zero if the pre-R88 defect is *not* reproduced, so it stays
a live reproducer rather than a transcript.

`improvement = 3` and `verdict = MECHANISM_VALIDATED` on evidence that contains
**no candidate record at all**. This is the exact defect F1 describes.

The in-suite RED reproducers were then written first and confirmed failing
against the pre-R88 implementation:

```
$ pnpm exec vitest run packages/core/src/runtime/r88-replay-evidence-gate.test.ts
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

- `F1 RED repro: baseline TARGET failures with zero candidate records must NOT be MECHANISM_VALIDATED` — passed even pre-fix once phrased with the frozen
  selection; the exact vacuous-guard repro is the script above and the
  `baselineTargets` case in the suite.
- `F2a: runReplayAb must fail closed when the selection digest does not verify` — **failed** pre-fix.
- `F2b: resume must not silently absorb records that are not part of this experiment` — **failed** pre-fix.

## 3. GREEN evidence (after the fix)

```
$ pnpm exec vitest run packages/core/src/runtime/r88-replay-evidence-gate.test.ts \
                       packages/core/src/runtime/r87-zero-call-replay-ab.test.ts
 Test Files  2 passed (2)
      Tests  37 passed (37)
```

R88 suite: 25 tests. R87 suite: 12 tests (updated to the v2 API; all original
intent preserved — the mechanism metric is still 3 → 0, counterexamples still
outcome-invariant, paid gate still `NOT_RUN`).

## 4. What was implemented

### 4.1 F1 — the verdict is now driven by the FROZEN selection

`computeSummary(records, selection, arms)` now:

- computes the expected matrix as `selection.cases × declared arms` — **never**
  from the observed records;
- reports `expectedRecords`, `observedRecords`, `completeness`
  (`COMPLETE`/`PARTIAL`) and a list of stable `EvidenceIssue` reason codes;
- **REJECTS** on any structural defect: `DUPLICATE_RECORD`, `UNKNOWN_CASE`,
  `CASE_SUITE_MISMATCH`, `CASE_ROLE_MISMATCH`, `METRIC_NOT_FINITE`,
  `METRIC_NEGATIVE`, `ARM_UNEXPECTED`;
- **REJECTS** on any semantic regression: `EXPECT_NOT_MET` (a candidate that
  fails for a non-target reason is not an improvement),
  `COUNTEREXAMPLE_REGRESSION`, `SECURITY_VIOLATION`,
  `VERIFIED_COMPLETION_REGRESSED`;
- treats a **single-arm** run as `PARTIAL` + `ARM_MISSING` — a formal A/B
  requires both arms (plan §R88: "正式 A/B 必須两臂齐全。单臂执行可以保存中间
  状态，但状态只能 PARTIAL/INCONCLUSIVE");
- returns `MECHANISM_VALIDATED` **only** when the matrix is `COMPLETE`, no issue
  was raised, and the mechanism metric genuinely improved.

A `NO_MECHANISM_IMPROVEMENT` code distinguishes "the candidate did not help" on
a complete matrix (REJECTED) from genuinely insufficient evidence (INCONCLUSIVE).

### 4.2 F2 — identity-bound, strictly validated resume

- `runReplayAb` calls `verifySelectionDigest(selection)` **itself**, so a
  tampered selection fails closed regardless of whether the caller remembered to
  load it via `loadCaseSelection()`.
- New versioned state schema `e4-r88-run-state-v1`. Line 1 is a **header**
  binding `schemaVersion`, `selectionDigest`, `implementationSha`, **both arms'
  semantics**, `limits`, `fixtureDigest`, and the derived `experimentId`
  (canonical digest of that payload). Every result line binds the same
  `experimentId` and carries a stable per-record `hash`.
- On start the whole state is validated **before any arm runs**: schema,
  experiment id, case membership, declared arm, duplicate detection and
  per-record hash recomputation. Foreign → `EXPERIMENT_ID_MISMATCH`, stale →
  same, unknown case → `UNKNOWN_CASE`, undeclared arm → `ARM_UNEXPECTED`,
  repeat → `DUPLICATE_RECORD`, edited record → `RECORD_HASH_MISMATCH`.
- Crash semantics: a truncated **tail** line is an unconfirmed mid-write
  fragment — reported in `incompleteRecovered` and re-run; a malformed
  **non-tail** line is corruption and fails closed (`STATE_TRUNCATED`). A stale
  `.tmp` is discarded, so a record only counts as done once it is in the main
  file.
- Arms may be **added** (single-arm intermediate state extended into a full A/B,
  same `experimentId`) but never silently **dropped**.
- The arm semantics bound into the identity always cover both arms, so the
  declared subset does not fork the experiment id.

### 4.3 Offline manifest validator

`validateManifest(manifest, selection)` independently recomputes the experiment
identity, every arm hash and the verdict from the manifest's **own** records,
and returns `VALID` / `INVALID` with reason codes, or `LEGACY_UNVERIFIED` for
the historical v1 schema. It constructs no provider and opens no network
(asserted by a source scan in the suite).

### 4.4 Schema versioning and legacy preservation

- New manifest schema `e4-r88-phase-a-manifest-v2`, emitted to
  `docs/evidence/e4-r88-phase-a-manifest.json`.
- The historical `docs/evidence/e4-r87-phase-a-manifest-v1` file is **not
  touched** — verified byte-identical before/after the emit test, and asserted in
  CI. Its v1 hashes remain reproducible through the preserved `legacyArmHash`,
  but it is reported as `LEGACY_UNVERIFIED` and is never blessed as verified
  evidence (plan §R88: "旧格式保持可读但标注 legacy/unverified").
- The v2 arm hash deliberately **excludes `durationMs`**, so a resume reproduces
  the fresh run's hashes exactly (plan §R88 验收).

## 5. Acceptance criteria (plan §R88 怎么验收)

| Criterion | Evidence | Result |
| --- | --- | --- |
| All negative cases return stable reason codes, never `MECHANISM_VALIDATED` | 25-test R88 suite | PASS |
| A complete legal synthetic A/B still validates | `verdict = MECHANISM_VALIDATED`, `completeness = COMPLETE` | PASS |
| Counterexample regression or security violation is refused | `COUNTEREXAMPLE_REGRESSION` / `SECURITY_VIOLATION` tests | PASS |
| Reusing old state after selection/config/implementation SHA change fails **before** any arm runs | `EXPERIMENT_ID_MISMATCH` test asserts the state file is untouched | PASS |
| Interrupted resume runs only the missing legal arms; full resume hashes match the fresh run | serial/resume + hash-equality tests | PASS |
| The offline validator calls no model; Windows and Ubuntu run the same suite | source scan test + CI step on both OSes | PASS |
| Report separates RED and GREEN and distinguishes synthetic provider interaction from external HTTP | this report §2/§3 + zero-call accounting in §6 | PASS |

## 6. Provider accounting — 0 calls

Both suites use `ScriptedModelProvider` only. The module source is scanned in-test
for `createProvider`, `new OpenAI`, `apiKey`, `OPENAI_API_KEY`, `fetch(` and
`http.request`; the manifest records `providerCalls: 0`. No key is read, no
endpoint is contacted. This is a **synthetic in-process mechanism experiment** —
it is not a real-provider A/B and makes no claim about live model behaviour.

**Honest scope limit:** "resume does not re-bill" is a local-file guarantee. This
offline replay does **not** prove paid exactly-once semantics across a network
boundary, and neither the code comments nor this report claim otherwise.

## 7. Commands and exit codes

| Command | Exit | Note |
| --- | --- | --- |
| `node scripts/e4/r88-red-evidence.mjs` | 0 | RED evidence: pre-R88 verdict = `MECHANISM_VALIDATED` on incomplete evidence |
| `pnpm exec vitest run packages/core/src/runtime/r88-replay-evidence-gate.test.ts` (pre-fix) | 1 | 2 failed / 1 passed — genuine RED |
| `pnpm exec vitest run …r88-replay-evidence-gate.test.ts …r87-zero-call-replay-ab.test.ts` | 0 | 2 files / 37 tests passed |
| `pnpm typecheck` | 0 | `tsc -b` across all packages |
| `pnpm build` | 0 | `tsc -b` |
| `pnpm test` | see §8 | 6 failures, all documented clean-tree guards (uncommitted tree) |
| `pnpm docs:verify` | 0 | ALL CHECKS PASS |
| `git diff --check` | 0 | clean |

## 8. Full-suite note

`pnpm test` on the **uncommitted** tree: `335 passed / 3 failed` files,
`6095 passed / 6 failed / 3 skipped`. All 6 failures are the known
clean-tree guards that require a committed tree (`E4-R55` requires a provably
clean working tree; the `E4-09`/`E4-R41` production-path tests build on it).
These are the same 6 that failed pre-commit during R86/R87 and they pass once the
work is committed — see §10.

## 9. Files

- `packages/core/src/runtime/r87-zero-call-replay-ab.ts` — evidence gate, identity-bound resume, v2 manifest, offline validator
- `packages/core/src/runtime/r88-replay-evidence-gate.test.ts` — 25-test R88 suite (NEW)
- `packages/core/src/runtime/r87-zero-call-replay-ab.test.ts` — updated to the v2 API; legacy-hash test added
- `docs/evidence/e4-r88-phase-a-manifest.json` — emitted v2 manifest (NEW)
- `.github/workflows/ci.yml` — R88 CI step (both OSes) + legacy/v2 manifest assertions
- `docs/E4-R88-report.md` — this report (NEW)
- `scripts/e4/r88-red-evidence.mjs` — standalone RED reproducer (NEW)
- `docs/evidence/e4-r87-phase-a-manifest.json` — **unchanged** (legacy preserved)

## 10. CI

Run **`35167911660`** (run number 176) on the ending SHA
`20f01b988fe999638218a8be9dd5e57a78e36c29` — **completed / success**, all 5 jobs:

| Job | Conclusion |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `offline cold-start (ubuntu)` | success |
| `coverage gate (ubuntu)` | success |
| `release attestation (P38-12)` | success |

The R88 offline validator and the legacy/v2 manifest assertions therefore ran
green on **both** operating systems, which is the Linux evidence the Windows-only
dev host cannot produce locally.

Post-commit local verification on the same SHA: `pnpm test` → 336 files passed,
6103 passed / 3 skipped (6106), exit 0; `pnpm test:coverage` exit 0.

## 11. Not done / out of scope

- **R89–R92** are separate dependent tasks (campaign runner authorization,
  evidence-grade correction, Windows verifier, paid A/B preparation).
- No real provider request was made or authorized; the paid gate remains
  `NOT_RUN: PAID_AUTHORIZATION_REQUIRED`.
- The 86-case paid re-run remains explicitly out of scope and is not
  auto-started.
