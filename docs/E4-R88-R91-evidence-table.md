# E4 — R88–R91 evidence table, and the R92 authorization-ready plan

Plan §三 asks for one evidence table after R88–R91: **finding, fix commit,
RED/GREEN, CI URL, remaining unknown historical impact.** This file is that
table. R92's deliverable is the authorization-ready plan, which lives in
`docs/E4-R92-report.md` and `.ci/r92-auth/approval-package.md`.

**No real provider request was made by any task in this table.** Every check is
offline: 0 model calls, no key read, no network, holdout cases never read
per-case.

---

## 1. Findings and fixes

| Finding | What was wrong | Fix commit | RED | GREEN | CI URL |
| --- | --- | --- | --- | --- | --- |
| **F1** (R88) | The A/B verdict could report `MECHANISM_VALIDATED` on **incomplete** evidence — baseline TARGET failures with **zero** candidate records were read as an improvement | `20f01b9` | `scripts/e4/r88-red-evidence.mjs` reproduces the pre-R88 `computeSummary` returning `improvement=1` / `MECHANISM_VALIDATED` on 3 baseline fires + 0 candidate records | in-suite reproducer passes post-fix; expected matrix derived from `selection.cases × declared arms`, never from observed records | https://github.com/ki11a-Conton/harness-agent/actions/runs/35167911660 |
| **F2** (R88) | The resume path accepted **foreign/stale** state | `20f01b9` | resume-state tests written first and confirmed failing | schema + selection digest + implementation SHA + arm semantics + limits + fixture digest all bound; foreign/truncated state fails closed **before any arm runs** | same run as F1 |
| **F3** (R89) | The campaign runner **created** its own paid authorization instead of reading it | `567ca03` | `scripts/benchmark/selfcheck-r89-runner.ps1` reproduces the pre-R89 behavior standalone | `RUN_PAID_BENCHMARKS=1` is REFUSED (exit 3), starts no child, echoes no key | `567ca03` → run 35173144683 was **RED**, but for the unrelated workflow-guard defect in §1's last row — the F3/F4/F5 self-check itself passed |
| **F4** (R89) | Completion was judged by "the report file exists" rather than by identity | `567ca03` | seeded-evidence reproducer passed pre-fix only because existence was the sole criterion | completion is identity-bound; crashes are explicit; `-AdoptOrphanReport` is the operator override | as F3 |
| **F5** (R89) | The runner passed a PowerShell **hashtable array** to the CLI's `--suites` | `567ca03` | splatting an array of hashtables is reproducible standalone | `--suites` value asserted `-is [string]` and equal to `"adversarial,stress"` | as F3 |
| **F6a** (R90) | "mechanism reproduced" and "historical case confirmed affected" were **one number** | `2a7877c` | triage tests written first; two passed **vacuously** until `candidates.length > 0` was asserted | `affectedCases` (mechanism) separated from `confirmedAffectedCases` (attribution); `CONFIRMED_AFFECTED` requires a confirmed case | run 35185496622 (`bb909de`) — R90 was never pushed on its own, so this is its first and only CI coverage |
| **F6b** (R90) | R87 read as a replay of **historical** traces | `2a7877c` | manifest schema assertions written first | R90 manifest declares `experimentKind: synthetic_mechanism`, `baselineMode: emulated_semantics`, `historicalReferenceCheckedOut: false` | as F6a |
| **F6c** (R90) | `toolFailures > 0` ⇒ `MODEL_BEHAVIOR` — convicting the model for harness defects | `accb6c1` | R85 reproducer flipped | all 27 real attributions become `INSUFFICIENT_EVIDENCE`; `MODEL_BEHAVIOR` 0; R85 report §5.1 corrected (5 → 32 `INSUFFICIENT_EVIDENCE`) | as F6a |
| **F6d** (R90) | "any byte change ⇒ non-zero" overclaimed `rootDigest` (it is CRLF→LF **normalized**) | `b10e01f` | hash-claim tests written first | claim corrected to content integrity, not byte immutability | as F6a |
| **F6e** (R90) | The R84 fixture digest pin was stale | `b10e01f` | CI assertion written first | re-pinned to `26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8`; three assertions **added**, none removed | as F6a |
| **H1** (R91) | Windows `.cmd`/`.ps1` shims could not be spawned under `shell: false`, so 11 declared verifiers could not start | `f85d550` | 6 new tests failed with the measured errors (`spawn EINVAL` on `.cmd`, `spawn EFTYPE` on `.ps1`); a 7th failed specifically for the `PATH`-casing bug | 30/30 executor tests; `reg-25` now `exit 0`; `reg-27` spawns and runs; injection probe refuses `a&echo PWNED><sentinel>&rem` with sentinel `false` | run 35185496622 (`bb909de`) — R91 was never pushed on its own, so this is its first and only CI coverage |
| **NEW** (R92) | `origin/main` CI was **RED**: the E4-R82 cold-start guard scans `ci.yml` for a paid-authorization literal, and E4-R89's negative control spelled that literal out, so the guard matched its own control | `bb909de` | local mirror `packages/security/src/workflow-paid-authorization.test.ts` failed naming `ci.yml` line 576 | control assembled from fragments; bash guard passes; control still matches (1 match); local mirror runs under `pnpm test` | run 35185496622 (`bb909de`) |

**On CI coverage.** R88 (`20f01b9`) and R89 (`567ca03`) each had a dedicated
pushed run. R90, R91 and R92 did **not** — they accumulated locally and reached
CI together at `bb909de`, so run 35185496622 is the first CI coverage those three
tasks ever had. Until this push, `origin/main` sat at R89 with a **red** run.

## 2. Remaining unknown historical impact

Stated rather than omitted. None of these is a claim that a defect did *not*
matter — they are the boundaries of what the stored evidence can prove.

| Finding | Remaining unknown |
| --- | --- |
| **F1/F2** | Whether any *earlier* A/B verdict was in fact computed from incomplete evidence. The R88 gate now refuses such a verdict, but prior verdicts were not re-derived; the stored reports do not record the record counts needed to decide retroactively. |
| **F3/F4/F5** | Whether the runner's self-created authorization ever coincided with a real paid run. The R83 campaign data is git-ignored and was never modified; no stored artifact records the authorization *source*. |
| **F6a/F6b** | The R87 Phase A manifest is **synthetic mechanism evidence**, not a historical replay. Whether the H2 signature actually fired in the real R83 traces is **`UNKNOWN`** — no per-call event exists to decide it either way. |
| **F6c** | The 27 real attributions are now `INSUFFICIENT_EVIDENCE`, not `MODEL_BEHAVIOR` and not `HARNESS_CONTROL_FLOW`. R85's original "count is 1" defect count is accurate as a *development-suite* count and misleading as a defect count. |
| **F6d** | `rootDigest` proves content integrity after CRLF→LF normalization; it does **not** prove byte immutability. Any earlier claim of byte-level immutability is unsupported. |
| **H1** | The defect was live during the R83 campaign (`78b69ff` is an ancestor of both campaign SHAs), but only `regression/reg-25-shell-script` records the `ENOENT` signature, because most `bash` cases are holdout and holdout per-case detail was never read. Six holdout cases (`ho-02`, `ho-06`, `ho-11`, `ho-25`, `ho-31`, `ho-32`) are now **refused** rather than fixed — fail-closed, not a regression, since pre-R91 they failed earlier with `spawn bash ENOENT`. Repairing them means rewriting verifiers as interpreter + script + argv, which changes case content and is therefore a case-definition change, not a runtime fix. |
| **NEW** | CI was red from `567ca03` (R89) until `bb909de` (R92). No artifact was corrupted — the failing job aborts before the cold-start README steps run — but the *cold-start acceptance evidence* for that window was never produced. |
| **R92** | The authorization gate is implemented and its refusals proven offline, but it is **not wired into the generic `agent benchmark` path**. Until the R92 campaign driver calls it as its first action, the three environment variables are a convention, not a mechanism. This is the single most important open item before any paid run. |

## 3. Verification gates (measured, on a clean tree)

| Task | `pnpm typecheck` | `pnpm test` | `pnpm docs:verify` |
| --- | --- | --- | --- |
| R88 | PASS | PASS | PASS |
| R89 | PASS | PASS | PASS |
| R90 | PASS | 336 files, 6116 passed / 3 skipped, 0 failed | PASS |
| R91 | PASS | 336 files, 6131 passed / 3 skipped, 0 failed | PASS |
| R92 | PASS | **340 files, 6193 passed / 3 skipped, 0 failed** | PASS |

## 4. What must not be conflated

Plan §三 line 231 is explicit, and this table follows it:

- **CI all-green** — the gates ran and passed. It says nothing about model quality.
- **Synthetic mechanism improvement** — the H2 fix changes the *mechanism* on a
  synthetic trace and on the frozen dev-set selection. It is not a task pass-rate.
- **Real task pass-rate improvement** — **not claimed anywhere.** No real score
  exists; the paid A/B is unauthorized.

R88–R91 fixed the *evidence discipline* and one Windows execution-compatibility
defect. They did not demonstrate that the harness solves more tasks.

## 5. R92 — the authorization-ready plan

Planning-only, per plan §R92 line 197. Full detail in `docs/E4-R92-report.md`.

| Item | Value |
| --- | --- |
| Status | **`READY_FOR_AUTHORIZATION` / `NOT_RUN`** |
| Real provider calls | **0** |
| Plan digest (approve this exact value) | `ffe3bea77e27283917847536a08d351e33f26d2ac0773b59fc590926868970f1` |
| Expires | `2026-10-16T08:27:46.000Z` |
| Baseline SHA | `e9776ba66190ea63b1bacb685c91aa900b6935e7` |
| Candidate SHA | `a20373743b56de6a3a110fecdd254737ece71afa` |
| Cases | 8 non-holdout dev-set cases, R87-frozen order |
| Selection digest | `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae` (case choice only — not a paid-authorization digest) |
| Arm identity mode | `isolated-checkout-build` (two real checkouts; H2 is unreachable as a `--candidate` switch) |
| Fix scope | `single-fix-H2` — `e9776ba..a203737` contains exactly one functional commit |
| Endpoint identity | `ee071e382ae11baecc06ca51545a6d4f3fa74cb3ea12b605d63d0b19ae84fea7` (normalized digest, never a raw URL) |
| Call cap | 320 campaign-wide, **runtime-enforced** |
| Time cap | 600 000 ms per case, **runtime-enforced** |
| Tool-call cap | 100 per case, **runtime-enforced** |
| Token cap | **none declared** — no runtime token layer exists |
| Cost-unknown items | USD total; token total; provider-side rate/spend limits |
| Output location | `.ci/r92-ab` |
| Rehearsal | 12/12 scenarios, 0 failed, 81 fake-provider requests, **0 external requests** |
| Promotion-eligible | `false` |

The plan is **not** paid authorization. Running it requires
`E4_R92_PAID_AUTH=1`, `RUN_PAID_BENCHMARKS=1` and
`E4_R92_PAID_AUTH_DIGEST=<the digest above>`, plus a human decision on this plan.
