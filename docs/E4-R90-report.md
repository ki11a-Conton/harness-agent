# E4-R90 — evidence-grade correction: separate mechanism reproduction from historical case causation

Plan: `plan(20260917-001821).md` §R90 (lines 125–158).

This task **corrects what the existing evidence is allowed to claim**. It does
not retract the R86 fix and does not weaken any regression test that proves the
mechanism; it separates two facts that the earlier artifacts had collapsed into
one number.

**This task made 0 provider/model calls.** Every command below is offline.

| Field | Value |
| --- | --- |
| Task | R90 (F6 + report fact-boundary correction) |
| Baseline SHA (start) | `567ca0305ffccaff9ffc3f586952d0aed7fb9c55` |
| Branch | `main` |
| Environment (local) | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, git 2.55.0.windows.3 |
| Provider/model calls | **0** (0 paid, 0 free) — §7 |
| Network calls | **0** |
| Paid authorization gate | `NOT_RUN: PAID_AUTHORIZATION_REQUIRED` (unchanged) |
| Holdout per-case data read | **none** — §6 |
| Historical evidence modified | **none** (v1/v2 artifacts byte-identical) — §5 |
| `pnpm typecheck` | PASS (`tsc -b`, 0 errors) |
| `pnpm test` | PASS — 336 files, 6116 passed / 3 skipped, 0 failed (§7) |
| `pnpm docs:verify` | PASS — ALL CHECKS PASS |

---

## 1. The defect: four over-strong claims

| # | Finding | Where it was wrong | Fix |
| --- | --- | --- | --- |
| **F6a** | "机制缺陷已复现" and "历史 case 确认受影响" were one number | `TriageCandidate.affectedCases` counted feature matches and was read as confirmed victims | Split into `mechanismStatus`, `caseAttributionStatus`, `candidateCases`, `confirmedAffectedCases`, `evidenceRefs`; schema 1 → 2 |
| **F6b** | R87 read as a replay of historical traces | Three TARGET labels of ONE synthetic trace; `sourceSha` implied a historical checkout that never ran | `executedSourceSha` / `historicalReferenceSha` / `baselineMode` / `syntheticScenarios`; manifest v2 → v3 |
| **F6c** | `toolFailures > 0` ⇒ `MODEL_BEHAVIOR` | A tool error can originate in the harness, the environment or a schema; the model may never have received usable feedback | Conviction now requires recorded feedback evidence; otherwise `INSUFFICIENT_EVIDENCE` + `tool_failure_provenance_unknown` |
| **F6d** | "any byte change ⇒ non-zero" | `rootDigest` is CRLF→LF **normalized**, so it proves content integrity, not byte immutability | Added `rawRootDigest` + per-artifact `rawSha256`, recorded alongside; R84 report erratum §10 |

### 1.1 Why F6c mattered most

The old rule read the *count* of tool failures as proof of *who caused them*.
That inference is invalid in exactly the case that matters: a tool that is
itself broken, an environment that rejects a valid call, or a schema mismatch
all produce failures the model cannot act on correctly. The rule therefore
convicted the model for harness defects — the precise failure mode R85's
taxonomy exists to prevent.

On the real R83 campaign this rule was not a corner case. **43** stored cases
carry `termination_reason == tool_limit` with `tool_failures > 0`. Of those,
**27** sit in the attributed (non-holdout) suites — `adversarial` 10,
`regression` 14, `stress` 3 — and under the old rule **every one of the 27** was
attributed to `MODEL_BEHAVIOR` on the failure count alone. The remaining **16**
are holdout cases, which this tool never reads per-case (they are reported only
as an aggregate), so they were never attributed under either rule.

After the correction all **27** are `INSUFFICIENT_EVIDENCE`, and
`MODEL_BEHAVIOR` is **0** across the real development set. That is not
over-correction: the stored reports contain no per-call feedback record for any
of them, so the evidence genuinely cannot distinguish "the model chose badly"
from "the tool/environment/schema misled it". Only **1** of the stored R83
reports contains any `side effect: tool…` per-call evidence at all, which is why
the honest answer is `UNKNOWN` rather than a revised guess.

Verified directly against the real campaign data
(`.ci/bench-grok`, read-only, never modified):

| Check | Result |
| --- | --- |
| Cases with `tool_limit` + `tool_failures > 0` (whole campaign) | 43 |
| …in attributed (non-holdout) suites | 27 |
| …attributed to `MODEL_BEHAVIOR` **after** R90 | **0** |
| …attributed to `INSUFFICIENT_EVIDENCE` after R90 | 27 |
| Cases convicted on a failure count without feedback evidence | **0** |

---

## 2. What was built

### 2.1 Candidate evidence split (plan §R90 #1)

`packages/evaluation/src/campaign-triage.ts`:

```ts
export type TriageMechanismStatus =
  | "MECHANISM_REPRODUCED" | "MECHANISM_NOT_REPRODUCED" | "UNKNOWN";

export type TriageCaseAttributionStatus =
  | "CONFIRMED_AFFECTED" | "CANDIDATE_ONLY" | "UNKNOWN";
```

`TriageCandidate` now carries all five fields. The rule, implemented once in
`attributionOf()`:

- `CONFIRMED_AFFECTED` — **only** when recorded raw events prove the defect
  fired for at least one case.
- `CANDIDATE_ONLY` — the events *were* recorded and none shows the defect
  firing, so the cases match the feature but are not victims.
- `UNKNOWN` — no per-call event exists to decide either way.

A candidate match is never promoted to a confirmed case, and
`confirmedAffectedCases.length <= candidateCases.length` is asserted.

For H2 the confirming event is `resultChangeEvidence === "changed"` — the
repeated identical call returned a **different** result and the gate still
fired. For H1 the confirming event is the stored violation text itself
(`spawn <cmd> ENOENT`), which is a raw event, so H1 cases are genuinely
confirmed.

### 2.2 The mandatory counterexample (plan §R90 #2)

`classifyCase` now reads the trajectory, not just the aggregate counters:

| Recorded trajectory | Class | Secondary tag |
| --- | --- | --- |
| result **changed** (observable progress) | `HARNESS_CONTROL_FLOW` | `progress_blind_gate_fired` |
| result **unchanged** (genuine stall) | `MODEL_BEHAVIOR` | `verification_not_reached` |
| **no event recorded** | `INSUFFICIENT_EVIDENCE` | `result_change_unknown` |

The trajectory is also part of `failureSignature`, so the three cases produce
**three distinct fingerprints**. This is asserted twice: once at unit level
(`classifyCase`) and once **end-to-end through the real campaign reader**
(`writeSyntheticCampaign` → `triageCampaign`), with the test first proving the
aggregate counters are byte-equal before showing the conclusions diverge.

### 2.3 Executed identity (plan §R90 #2)

`packages/core/src/runtime/r87-zero-call-replay-ab.ts`:

```ts
export const R90_MANIFEST_SCHEMA = "e4-r90-phase-a-manifest-v3";
export type BaselineMode = "emulated_semantics" | "isolated_build";
export type ExperimentKind = "synthetic_mechanism" | "real_version_ab";
```

The identity digest now binds `executedSourceSha`, `historicalReferenceSha`,
`baselineMode`, `experimentKind` and `syntheticScenarios`, so a manifest that
silently re-labels any of them is a *different experiment* and fails
verification. `validateManifest` additionally rejects:

- `executedSourceSha !== implementationSha`;
- `experimentKind === "real_version_ab"` while
  `baselineMode !== "isolated_build"` — an emulated switch may not claim a real
  two-version A/B.

The manifest carries a `scope` block whose `statement` says, in prose a reviewer
can quote, what the artifact does and does not prove.

### 2.4 Raw-byte audit (plan §R90 #4)

`packages/evaluation/src/campaign-validate.ts`:

```ts
async function rawHashFile(abs: string): Promise<string> {
  return sha256Bytes(await readFile(abs));   // no normalization
}
```

`artifactHashes[]` gains `rawSha256`; the result gains `rawRootDigest`. Both are
**additive**: `sha256` and `rootDigest` keep their exact previous values, so the
pinned fixture digest `26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8`
is unchanged and every existing consumer keeps working.

### 2.5 Config difference declared (plan §R90 #7)

```ts
export const REPLAY_CONFIG_DIFFERENCES = {
  maxIterationsPerTurn: { replay: 20, benchmark: 30, retroClaimed: false, note: "…" },
} as const;
```

The historical evidence is never retro-described as 20 or as 30.

---

## 3. RED → GREEN

### 3.1 RED (before implementation)

```
❯ packages/evaluation/src/campaign-triage.test.ts (53 tests | 5 failed)
❯ packages/core/src/runtime/r87-zero-call-replay-ab.test.ts (16 tests | 4 failed)
❯ packages/evaluation/src/campaign-validate.test.ts (42 tests | 1 failed)
    Tests  10 failed
```

Every failure was for the intended reason — a missing field/export or the old
over-strong classification — and none was an unrelated error:

| Failing assertion | Reason |
| --- | --- |
| `tool_limit` + `toolFailures: 7` ⇒ `MODEL_BEHAVIOR` | the F6c defect itself |
| `syn-repeated-error` ⇒ `MODEL_BEHAVIOR` | same, through the fixture path |
| `failureFingerprint(constant) !== failureFingerprint(changing)` | trajectory absent from the signature |
| `candidateCases` / `confirmedAffectedCases` / `mechanismStatus` | fields did not exist |
| `rawSha256` `.toMatch()` got `undefined` | field did not exist |
| `identity.executedSourceSha` undefined | field did not exist |
| v2 manifest ⇒ `VALID` instead of `LEGACY_UNVERIFIED` | v2 still blessed |

Two tests written in the first pass passed **vacuously** (the fixture had no
candidates, so the loop body never ran). They were rewritten to drive the
synthetic campaign and assert `candidates.length > 0` first. A vacuous green is
not evidence.

### 3.2 GREEN (after implementation)

```
packages/evaluation/src/campaign-triage.test.ts        55 passed
packages/evaluation/src/campaign-validate.test.ts      42 passed
packages/core/src/runtime/r87-zero-call-replay-ab.test.ts  16 passed
packages/core/src/runtime/r88-replay-evidence-gate.test.ts 27 passed
packages/core/src/runtime/r86-h2-offline-replay.test.ts     passed
packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts passed
```

R86's changing-result positive case, its constant-result counterexample and the
security tests all still pass. **The R86 fix is not retracted.**

---

## 4. R87 verdict, re-examined

| Question | Answer |
| --- | --- |
| Was the mechanism reproduced and removed? | **Yes** — `MECHANISM_VALIDATED` stands, 3 → 0 on the scripted trace |
| How many independent mechanism scenarios? | **1** (`identical-changing`), labelled against 3 TARGET cases |
| Did the baseline arm execute historical code? | **No** — same runtime, `streakResultAware: false`; `baselineMode: emulated_semantics` |
| Was any historical R83 case confirmed affected? | **UNKNOWN** — no per-call result events exist in the stored artifacts |
| Was a real two-version A/B performed? | **No** — `experimentKind: synthetic_mechanism`; a real version A/B needs two SHAs in isolated checkouts/builds |

The verdict `MECHANISM_VALIDATED` is therefore unchanged, while the *scope* of
what it proves is now stated rather than inferred.

---

## 5. Versioned erratum, not deletion (plan §R90 #9)

No historical artifact was modified or removed. Verified by SHA-256:

| Artifact | Schema | SHA-256 | Status |
| --- | --- | --- | --- |
| `docs/evidence/e4-r87-phase-a-manifest.json` | `e4-r87-phase-a-manifest-v1` | `cfecb471…` | unchanged, `LEGACY_UNVERIFIED` |
| `docs/evidence/e4-r88-phase-a-manifest.json` | `e4-r88-phase-a-manifest-v2` | `d3bd5a1d90225a3bd88f1c9ea10f79d371118244bcd3f116856bb9fb0912ec69` | **byte-identical to its pre-R90 value**, now `LEGACY_UNVERIFIED` |
| `docs/evidence/e4-r90-phase-a-manifest.json` | `e4-r90-phase-a-manifest-v3` | `4e2c563b…` | **new** — carries the corrected identity |

The emit-mode test asserts both older files remain byte-identical while v3 is
written, so a future change cannot silently rewrite history.

Reports were corrected **in place, additively**: the original wording is
retained and the correction is appended as a dated, attributable section. The
R84 status table row now reads "normalized content change" with a pointer to the
erratum.

| Report | Correction |
| --- | --- |
| `docs/E4-R84-report.md` | §1 row reworded; new **§10** erratum explaining normalized content integrity vs byte immutability and the additive `rawSha256`/`rawRootDigest` |
| `docs/E4-R87-report.md` | R90 note: synthetic mechanism experiment, 1 independent scenario, emulated baseline, executed-vs-reference SHA, 20-vs-30 config difference |
| `docs/E4-R85-report.md` | §5.1 class-distribution correction (27 → 0 `MODEL_BEHAVIOR`, 5 → 32 `INSUFFICIENT_EVIDENCE`), §7 fixture-scenario row marked superseded, §10.1 H2 row re-labelled candidates/UNKNOWN, §11 limit #4 corrected |

The R85 report needed the same F6c correction as the code: it had justified the
27 `MODEL_BEHAVIOR` cases with "the tools returned errors, the feedback was
correct", which is the count-to-cause inference this task removes. That claim is
preserved verbatim and marked superseded rather than silently edited.

---

## 6. Holdout discipline

No holdout per-case file was read or emitted. The triage path still skips
restricted suites *before* `loadCaseDeclarations`, and the holdout block is
derived by subtraction from the validator's totals. The existing
holdout-non-reading tests pass unchanged.

---

## 7. Verification

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **PASS** — `tsc -b`, 0 errors |
| Full test suite | `pnpm test` | **PASS** — 336 files, 6116 passed / 3 skipped (6119), 0 failed |
| Docs | `pnpm docs:verify` | **PASS** — ALL CHECKS PASS |
| Fixture digest determinism | triage run twice into separate dirs | **byte-identical** |
| R84 fixture root digest | `campaign validate` | `26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8` — **unchanged** |

### 7.1 A note on three local failures

Three suites (`e4-r55-failure-wiring`, `e4-09-production-e2e`,
`benchmark-command`) fail **only while the working tree is dirty**, and they say
so themselves: *"E4-R55 requires a CLEAN committed working tree."* This was
verified rather than assumed — the changes were stashed, the three suites were
re-run on the clean tree, and all **161 passed / 2 skipped**. They are a
working-tree gate, not a regression from this task, and they pass again once
R90 is committed.

### 7.2 CI digest re-pin (deliberate, not a weakened gate)

The R85 fixture `triageDigest` changed from
`831eabb24f206646a23a123772b79af2f4c42bf195639de50e17d81759dea91b` to
`8481ee0be8f07e2fa262fd32f8ecab1ed7baa6701e7f6c3c9cb233806a33456c`.

This is unavoidable and correct: the taxonomy schema went 1 → 2 and the result
now carries the candidate-split fields, so the digest over the analysis body
must move. The CI step was updated to pin the **new** digest exactly, and three
assertions were **added** while none were removed:

1. `schemaVersion === 2`;
2. every candidate separates mechanism from attribution, with
   `affectedCases === candidateCases.length` and no `CONFIRMED_AFFECTED`
   without a confirmed case;
3. no case is `MODEL_BEHAVIOR` on a tool-failure count alone.

The R88 step likewise now asserts v1 **and** the superseded v2 are both intact
and unmodified, and the previously-present
`expectedRecords === observedRecords` check was retained.

### 7.3 CI coverage of R90 — corrected

R90 was never pushed on its own. Its first CI coverage came at `bb909de` (run
35185496622), and **that run failed four jobs**, so it is not evidence that R90
passed in CI. The failures were two unrelated defects, both diagnosed and fixed
in E4-R92 (see `docs/E4-R92-report.md` §7c):

1. the R92 plan builder read git history that a **shallow** `actions/checkout`
   clone does not contain (`fatal: bad object a20373743…`, 10 of 11 tests);
2. an R91 test that spawned a `.cmd` shim ran unguarded on Linux
   (`spawn r91endtoend ENOENT`).

Neither is an R90 defect: R90's own assertions (schemaVersion 2, the
mechanism/attribution split, the `MODEL_BEHAVIOR` prohibition) were not implicated.
The local verification table in §7 stands on its own measurements. What is
withdrawn is any implication that `bb909de`'s run certified R90 in CI — it did
not, and a green run at the corrected HEAD is still pending.

---

## 8. Acceptance criteria (plan §R90 怎么验收)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Identical aggregate counts with different trajectories are not forced into one conclusion | **PASS** | §2.2 — 3 classes, 3 fingerprints, asserted end-to-end |
| Report and manifest show the real `executedSourceSha`; emulated baseline and synthetic trace declared | **PASS** | §2.3, §5 — v3 manifest + `scope.statement` |
| Any real-improvement claim needs real event evidence; otherwise explicitly `UNKNOWN` | **PASS** | §2.1 — `caseAttributionStatus: UNKNOWN`; the 27 real attributed cases are no longer convicted |
| CRLF/LF normalization and raw-byte tests each match their own declaration | **PASS** | §2.4 — one test asserts both halves |
| R86 changing-result positive, constant-result counterexample and security tests still pass | **PASS** | §3.2 — 51 core tests green |
| Zero provider HTTP calls | **PASS** | §7 — 0 paid, 0 free, 0 network |

---

## 9. Honest limits / not done

- **No historical case is confirmed affected.** For H2 the answer is `UNKNOWN`,
  and that is the truthful result: the per-call events needed to decide it were
  never stored. This task did **not** manufacture or reconstruct them.
- **No real two-version A/B.** R90 does not perform one and does not claim one.
  That remains R92's subject, and only with explicit paid authorization.
- **The 30-iteration boundary is not newly tested.** `REPLAY_CONFIG_DIFFERENCES`
  declares the difference and forbids retro-claiming; the plan called a
  30-boundary synthetic test optional ("必要时"), and none was added.
- **The R85 taxonomy artifact was not regenerated.** `docs/evidence/e4-r85-failure-taxonomy.json`
  still carries `triageDigest b71c4e74…` under the old schema-1 shape. It is
  historical evidence and was deliberately left untouched; the corrected
  classification is produced by the code and verified against the synthetic
  fixture. Regenerating it would change what a committed artifact asserts, which
  requires its own decision rather than a silent rewrite.
