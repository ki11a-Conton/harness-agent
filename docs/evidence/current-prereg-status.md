# Current pre-registration status — one entry point for "where does this actually stand?"

> ## CURRENT (2026-09-29) — round E4-R0/R7 per `plan(20260929-015956).md`
>
> **Everything below this banner is the PREVIOUS round (R7, SHA `910b80e`) and is kept
> as history by SHA, not deleted.** Read this banner for the current state; read the
> rest for how the levels were arrived at. Old run numbers are never mixed into
> "current".
>
> | | |
> | --- | --- |
> | Status date | 2026-09-29 (round E4-R0/R7, Windows 10 local measurement) |
> | Commits this round | `ade2a53` (S3–S7, 17 files) → `f379a69` → `ad8aa8e` (CI fix + this banner) → `659e009` (S4/F5) → `6b784c1` (Phase F) → `1726ab0` (docs E4-10 #6) → `b861b78` (ledger-lock EPERM) → `21bae0b` (Phase G) → `c0e0056` (task-10) — all on `origin/main` |
> | Prior round's SHA | `910b80e` (superseded as *current*; historical content retained below) |
> | Platform measured here | **Windows only.** No Linux host in this session; Ubuntu is GitHub Actions only and is `NOT_RUN` locally. |
> | Paid authorization | **None.** No paid request was made, `RUN_PAID_BENCHMARKS` stayed unset, and no promotion was performed. |
>
> ### The five levels, as measured now (never collapsed into one PASS)
>
> ```
> fixtureProtocolReady: PASS
> realBuildOfflineReady: NOT_PROVEN
> budgetEvidenceReady:   NOT_PROVEN
> paidExperimentRun:     NOT_RUN
> championPromotion:     NOT_RUN
> ```
>
> | Level | Status | What it is actually based on |
> | --- | --- | --- |
> | `fixtureProtocolReady` | **PASS** | the offline closed loop over SYNTHETIC fixture arm builds. On a CLEAN checkout the producer exits 0 with 124/124 scheduled arm runs, 124 physical provider calls, and the emitted bundle now verifies **124/124 arms** with `journalBinding: MEASURED` and a budget reconciled from the raw entries (1240 = 620 + 620, delta 0). This implies nothing about a real dual build. |
> | `realBuildOfflineReady` | **BLOCKED** | named blocker `NO_REAL_ARM_PAIR`. The arms are synthesized as plain directories, so `identity.arms.*.sourceSha` is honestly OMITTED and no real arm pair exists to certify. It is deliberately NOT listed among the check names in this document: the docs checker validates check NAMES only, so naming it as though it were a check would surface a false green across the whole file. Reported here as the honest level, not as a proven pass. |
> | `budgetEvidenceReady` | **NOT_PROVEN** | the request/attempt journal now cross-binds, but the tool-dispatch journal is still produced by NOTHING in this repository — `r5-real-formal.mjs` only COPIES `dispatch*.json`. So the umbrella code `REQUEST_DISPATCH_JOURNAL_NOT_BOUND` correctly stays FIRST, naming `DISPATCH_JOURNAL_MISSING` as the specific cause. The binding is now a REAL check with a reachable `MEASURED` path (11 regressions, one reaching `MEASURED`), so this is a missing-input NOT_PROVEN rather than an unimplemented one. |
> | `paidExperimentRun` | **NOT_RUN** | no paid authorization exists; the scripts never create one. |
> | `championPromotion` | **NOT_RUN** | promotion is a separate, later approval. |
>
> ### What this round actually FIXED (each with a counter-example that now passes)
>
> | Defect | Fix | Evidence |
> | --- | --- | --- |
> | F1 — formal arm tool dispatch ignored the durable budget | versioned worker RPC (`tool-budget-rpc-v1`) + reservation/settle binding | cap-1 two-real-writes counter-example: second write returns `TOOL_BUDGET_EXHAUSTED`, `filesOnDisk` has only the first |
> | F2 — deadline could not abort the in-flight model stream | one campaign deadline, owned AbortController, abort-before-kill, detached stream service loop | hanging-provider and deaf-provider counter-examples; real 127.0.0.1 HTTP stub observes a CLOSED connection |
> | F3 — readiness read self-reported JSON | readiness recomputed from raw evidence through `readiness-evidence-verify.mjs` | the forged-JSON input that previously yielded `PASS` now yields `NOT_PROVEN` with 6 independent reasons |
> | F4 — release CLI had no offline forward path | closed-enum versioned offline profile + symbol-branded capability bound to the observed identity | `provider-offline-profile` 33/33; real-provider-config ⇒ refusal, with a counting proof that the real factory is never entered |
> | F5 — `r5-real-formal.mjs` exited 0 on a failed report | strict gate with NAMED failures, kept evidence root, four-variant content matrix | `r5-formal-gate` 25/25, each asserting a nonzero exit AND its code. Proven by CONTRAST: the pre-S4 script (890 lines) contains **0** occurrences of `GATE FAIL`; the new gate names 27 failures on the same input |
> | F6 — a legacy price silently authorized unlimited billed spend | `resolvePricingBasisReadOnly` split from `resolvePricingBasis` (+ eligibility) | `legacy_not_executable`; every refusal asserts `factoryCalls === 0` **and** `transportCalls === 0`, with an `ADMITTED` positive control |
>
> ### Further defects found by RUNNING the round, not by reviewing it
>
> | Defect | How it was found | Fix |
> | --- | --- | --- |
> | **The dual-platform CI job failed on EVERY run** | the `readiness` teammate executed my exact job command line instead of reading my wiring description. It passed `--strict` with no `--require`, so it demanded three levels of which two are legitimately `NOT_PROVEN`. My own comment three lines above already said those must not be required — the command line just did not say it | `ad8aa8e`, measured both ways: without `--require` → exit 1; with `--require fixtureProtocolReady` → strict gate PASS (exit 0) while `realBuildOfflineReady` is still honestly `NOT_PROVEN` |
> | **The offline fixture pinned a PAST clock** (`NOW = 1_700_000_000_000`, 2023-11-14) so the campaign deadline was already expired and the arm refused with `ARM_DEADLINE_EXCEEDED` before its first request — on BOTH CI platforms. This was my F2 guarantee working correctly; the FIXTURE was stale | CI run `36524279295`, then reproduced locally | `6b784c1`: one clock read once, and an assertion that FIRES (mutant run exits 1 with `FIXTURE_CLOCK_CLOSED` naming the exact CI deadline) |
> | **`budget-ledger.lock` acquisition aborted on Windows `EPERM`** instead of retrying. `open(path,"wx")` reports contention as `EPERM` when the name is transiently unavailable — and that state is created by the lock's OWN release `rm` racing another acquirer's `open`. Only `EEXIST` was absorbed, so it escaped the entire retry/deadline machinery | running the clean-tree positive phase twice; then isolated by 4 probes (concurrent open+rm → 154/5000 EPERM; **sequential rm → 0/5000**) | `b861b78`: widen to `EEXIST || EPERM`, still bounded by the deadline so a wedged lock still fails closed. The regression **fails on the pre-fix code** with the exact CI error |
> | **The fixture arm declared no ABI** — `ARM_WORKER_ABI_UNSUPPORTED`, because the synthetic arm predated S1 and exported no `R97_ARM_ABI` | the clean-tree run after the clock fix | `21bae0b`: the arm now IMPORTS the ABI from the built CLI (so it cannot drift) and GENUINELY HONOURS it — a real `ToolOrchestrator` bound to the worker's forwarded budget, issuing a real `write_file` dispatch |
> | **The producer wrote no bundle ROOT** — `RAW_EVIDENCE_MISMATCH`: the verifier reads `identity.json`, `schedule.json`, `aggregate.json`, `cost-journal.json` from the evidence ROOT, and the producer wrote only the per-arm layer | the dual-platform job log, after the path fixes moved the failure forward | `174236c`: the four root files are emitted from measured data (`cost-journal.json` is the ledger's own `entries`, copied verbatim). Result: **124/124 arms verified** (was 0/124), `journalBinding: MEASURED` |
> | **The readiness step required a level that is honestly `NOT_PROVEN`** (`budgetEvidenceReady`), so the job failed every run — the same mistake as the dual-platform job, in the same round, three lines from a comment warning about it | reading the CI log for run `36530711327` | `5b8ba05`: require exactly one level, `fixtureProtocolReady`, which genuinely PASSES |
> | **The A7a producer never passed `--platform`**, so every bundle honestly recorded no platform and the join refused `IDENTITY_PLATFORM_MISSING`. `collectRunIdentity` deliberately refuses to infer it from `process.platform` (which yields `win32`/`linux`, outside the closed `PLATFORM_ENUM`), and the `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT` env fallbacks have no platform counterpart — so the omission was silent | CI run `36656606680`, then reproduced locally from a staged bundle shaped like Phase H's real output | `--platform "${{ matrix.platform }}"` on the A7a step (the N7 consumer already had it; only the producer was missing it) |
> | **The join's bundle re-verification was NOT level-scoped**, so a run requiring only `fixtureProtocolReady` still refused on `BASELINE_SOURCE_SHA_INVALID` / `CANDIDATE_SOURCE_SHA_INVALID` — the codes that truthfully say "this bundle has no real arm pair", which is exactly what a `SYNTHETIC_FIXTURE_BUILD` run is supposed to have. Requiring those made the join unsatisfiable in CI | the same refusal, read as three distinct causes rather than one | closed-set attribution: only the seven ARM-PAIR codes may be attributed to `realBuildOfflineReady`, and only when that level is not required. Everything else — including `IDENTITY_PLATFORM_MISSING` and any code this repo has not emitted yet — still blocks every level, so the scoping cannot mask a real defect |
> | **Adding a mutation needs a matching `round` tag, in FOUR places** — the union type, the doc comment, the allow-list, and (for a new round) its own exact-set assertion. I added three `round: "S7"` mutations and touched only the script, so CI failed with `s7-level-scoping-downgrades-every-problem has no round tag`. That ONE assertion failed step 3/5 of the closed loop (563/564) and took down install/coverage/both-platforms with it — five jobs, one missing string | CI run `36663863442`, which named the mutation and the assertion exactly | `ce2c7d8`: extend all four. The local blind spot is worth naming: `r97-mutation-check.test.ts` is NOT in the default `pnpm test` exclusion list, but I had been running a filtered subset. **Run the whole suite, not the subset you believe is relevant** |
> | **A test can be green for the WRONG reason, and only a fix elsewhere reveals it** — `DP-R` copied the bundle DIR into the evidence root instead of its CONTENTS, so the bundle sat one level too deep and the verifier read an EMPTY root. The test still passed because the PRE-FIX join refused on `bundleReVerified.ok` rather than on the files it had genuinely failed to find: the assertion agreed with the bug. The level-scoping fix removed that covering refusal and `DP-R` went red | fixing the level scoping, which made DP-R fail at the `exitCode === 0` assertion | `ce2c7d8`: copy the contents, and strengthen the assertion to `problems === []` + `ok === true` (the bundle DOES carry a real arm pair), which is strictly stronger than the old one |
> | **A stale `.ci/` directory on the developer's machine changes what a test resolves** — `resolveEvidenceRoot`'s FIRST candidate is `cwd`, and a leftover `.ci/prereg-production-e2e/pos-exec-runs/evidence` from an earlier run resolved there instead of to the test's own staging tree, yielding `MISSING_RAW_EVIDENCE` locally while CI (where that path does not exist at join time) is unaffected | DP-R failing locally after the level-scoping fix | not a code defect — diagnosed by clearing `.ci/prereg-production-e2e` and re-running. Recorded because it is the second time a stale local `.ci/` has mimicked a real failure |
>
> The Windows `EPERM` one is a **pre-existing** defect, not a regression from this round: the
> lock code predates it, and only a real concurrent campaign can expose it. Its regression
> test reproduces the CI-scale failure rather than exercising a happy path.
>
> ### The EPERM regression test was NOT a reliable detector — corrected by measurement
>
> The original `[EPERM-1]` provokes the defect by running 12 workers × 40 concurrent
> acquire/release cycles and hoping the ~3 % open-vs-rm race fires. Adding a mutation for
> this defect exposed that this is not reliable: **with the fix reverted, `EPERM-1` PASSED
> 6/6 runs** (480 attempts each). A regression test that passes on the broken code is not a
> detector, and the mutation gate correctly reported `MISSED` rather than claiming a catch
> that had not happened.
>
> `acquireLock` now takes an injectable `openFn` (default: the real `fs.open`;
> `withR97CampaignLock` forwards `opts.openFn`), and `[EPERM-4]` raises the exact Windows
> `EPERM` three times through that seam before delegating to the real open. Measured both
> ways: fix present → `EPERM-4` passes 4/4; fix reverted → `EPERM-4` **fails 4/4**.
> `EPERM-1` is kept, because a probabilistic counter-example that fires sometimes beats
> none — it is simply not load-bearing for the gate.
>
> Two further mutations were added for this round's own defects (the join's level scoping in
> both directions), taking the gate to **30/30 CAUGHT**, including all three new ones. One
> trap worth recording: vitest treats `-t` as a **regex**, so a filter of `[EPERM-4]` is an
> invalid character class and killed vitest at STARTUP — which the gate also reports as
> `MISSED`, correctly, because an infrastructure abort is not a caught mutation.
>
> ### `sourceSha` is deliberately ABSENT — the anti-fabrication finding
>
> `identity.arms.{baseline,candidate}.sourceSha` is OMITTED, so the bundle still reports
> `BASELINE_SOURCE_SHA_INVALID` / `CANDIDATE_SOURCE_SHA_INVALID`. That is the truthful
> encoding of "this bundle has no comparable real arm pair", and it is checkable:
> `writeArmCheckout` synthesizes the arms as PLAIN DIRECTORIES, so `<arm>/.git` does not
> exist and `git -C <arm> rev-parse --show-toplevel` answers for the ENCLOSING repo. A naive
> `rev-parse HEAD` therefore returns the SAME SHA for both arms. Measured side by side by
> the Lead on a real arm directory:
>
> ```
> naive  rev-parse HEAD  -> bb9cf96e2a52a1247d48bb9440ba4950e9ea9ab9   <- a fabrication
> guarded (the fix)      -> null                                       <- correct
> ```
>
> The producer's FIRST implementation used the naive form and it made the verifier QUIET,
> which is the most dangerous shape a bug can take. The verifier's `ARMS_IDENTICAL` check
> caught it — a check designed to catch a forger caught an honest implementation — and the
> guard now requires the arm dir to be its own repo root. The honest response was to OMIT
> the field rather than restore quiet. Making the arms real clean git checkouts at distinct
> SHAs is the `NO_REAL_ARM_PAIR` gap and is **not** claimed here.
>
> ### Why the level attribution is a CLOSED code list, not the verifier's own `levels.reason`
>
> The obvious way to scope the refusal is to ask the verifier which level a problem belongs
> to. `verifyEvidenceBundle` publishes `levels.realBuildOfflineReady.reason` — but reading
> `readiness-evidence-verify.mjs:750` shows that field is `problems.join("; ")`, i.e. the
> WHOLE problem list, not a classifier. Measured on a bundle whose only defect was a missing
> `identity.platform`, reason-matching attributed `IDENTITY_PLATFORM_MISSING` to
> `realBuildOfflineReady` alone — which would have let a bundle with no platform pass a
> fixture-only run. A test (`DP-U`) now pins that counter-example.
>
> So the attribution uses a closed set of seven codes, each verified present in the verifier,
> and requires **both** that the code is an arm-pair code **and** that the verifier reports
> that level not-`PASS`. The downgraded problems are still written into the verdict under
> `bundleReVerified.realBuildOnly.problems`, and `overall` stays `NOT_PROVEN`, so nothing is
> hidden and no run can be misread as accepted. Two-sided non-vacuity: reverting to the
> blanket refusal fails `DP-S`; downgrading *every* problem fails `DP-U`.
>
> ### Three wiring defects, all the same shape
>
> `needs: [verify, coverage]` omitted `r97-r98-closed-loop` — the job that UPLOADS the legs —
> so the join waited for nothing and its downloads found nothing. The `--evidence-root` named
> a path NOBODY CREATES, and the upload listed that same nonexistent path under
> `if-no-files-found: warn`, so it uploaded **nothing** while the job still looked green
> (measured: the artifact was 1934 bytes — the JSON alone; it is now 196 KB with the bundle).
> And the leg JSON paths were one level too shallow, because `actions/download-artifact`
> preserves the uploader's repo-root-relative paths.
>
> The pattern is worth naming: **the CI was wired from the SHAPE of the scripts rather than
> from their OUTPUTS.** Every one of these was caught by a real run; none by review. A
> `Show what each leg actually downloaded` step was added for exactly this reason, and it
> located two of them immediately. That step then had to be deepened itself: at
> `-maxdepth 3` it printed an apparently EMPTY evidence directory, because the per-arm
> artifacts live at depth 5. The lesson recorded for the next round: **print the evidence of
> success, and print it deep enough to be evidence.**
>
> ### Gaps stated as gaps — NOT marked DONE
>
> - **`plan §7` item 6 is NOT MET.** A non-holdout content task completing via a real
>   `write_file` through the real runtime → orchestrator → verifier is **not**
>   demonstrated. The scripted provider emits a well-formed `write_file` call with zero
>   network calls, but recorded real runs of `reg-12-csv-parse` cost **11/13/20/28** model
>   calls against a **3-turn** script, so a real content case would hit
>   `OFFLINE_SCRIPT_EXHAUSTED`. The script was deliberately **not** padded to the 30-turn
>   `maxIterationsPerTurn` ceiling: that would fabricate a run shape no real loop produces,
>   and every padded turn is a turn that cannot fail.
> - **The release-CLI forward run is `CLOSED_BY_R1`, reported as NOT_OBSERVED.** The shipped
>   release CLI refuses a marker-only synthetic fixture checkout before any request (0 HTTP,
>   no per-arm record). The Phase D identity rule refuses an offline profile whenever a real
>   provider configuration is present, and the release CLI accepts no fixture-bypass
>   configuration. Making it green would require weakening that rule, which re-opens the
>   "observe as X while running Y" drift it exists to prevent. Not attempted, not claimed.
> - **`realBuildOfflineReady` stays `NOT_PROVEN`.** No two real pinned checkouts built from
>   distinct source SHAs exist (N1 scope).
> - **Ubuntu `NOT_RUN` locally.** No Linux host. CI is the only Ubuntu evidence.
> - **The mutation gate was NOT re-run** this round (it must run serially in a clean
>   isolated directory; the tree had concurrent writers).
>
> ### A trap worth knowing: a phase that cannot run cannot fail
>
> Several gates refuse a dirty tree (`CLEAN_TREE_REQUIRED`) — the `prereg` observer, the
> positive phases of `prereg-production-e2e.mjs`, and the R5 formal chain. That refusal is
> correct, but it means **a dirty-tree run proves nothing about those phases**, and it is
> exactly how the stale fixture clock stayed invisible locally and then failed both CI
> platforms. To exercise such a phase, use an isolated worktree at the commit under test
> (`git worktree add --detach`), and carry changes back as a patch
> (`git diff <base> HEAD -- <file> | git apply`).
>
> For cleanup, **never** use `git checkout -- .` / `git reset --hard` / `git clean -fd` in
> a shared tree: those discard other uncommitted work. Restore only explicit paths
> (`git restore --source=HEAD -- <path>`).
>
> ### Shortest path for a Windows user
>
> ```powershell
> pnpm typecheck                      # tsc -b, exit 0
> pnpm test:formal-gate               # 81 tests: strict R5 gate (25) + dual-platform (23) + offline profile (33)
> pnpm test:r0-gaps                   # 48 tests: readiness classification + journal binding + pricing counter-examples
> node scripts/e4/r97-mutation-check.mjs   # 30/30 mutations CAUGHT, working tree restored
> node scripts/e4/prereg-production-e2e.mjs --out .ci/r97-r98/prereg-production-e2e.json
> node scripts/e4/ci-readiness.mjs --e2e .ci/r97-r98/prereg-production-e2e.json --out .ci/r97-r98/ci-readiness.json
> ```
> `node scripts/e4/r5-real-formal.mjs --verify <bundleRoot>` re-verifies a KEPT evidence
> bundle read-only and exits nonzero naming each unmet invariant. The real billed
> experiment and promotion remain a **separate, unexecuted** stage.

---

**Scope of this document.** This is the CURRENT-status entry point the R7 round adds
(`plan(20260928-105425).md` §R7 item 4). It exists because several reports in
`docs/evidence/` describe their own round and are now stale as *current* statements. Neither
the historical reports nor the frozen sample set are edited here: superseded statements are
recorded as superseded, with their scope, date and SHA.

| | |
| --- | --- |
| Status date | 2026-09-28 (round R7 close, Windows 10 local measurement) |
| Repository SHA this status is written from | `910b80e69e920125a0bfb2ab60281f56010eb5ac` (main: R1 + R2 + R3 + R3-binding + R4 + R5 + R6 + R12 + R7-core merged) |
| Authoring task | `task-10` (R7-core, F6) → extended by `task-8` (R7 close: refreshed R0 rows, gate results, mutation status) |
| Platform measured here | Windows only. Ubuntu evidence quoted below comes from downloaded GitHub Actions artifacts, not from a local Linux run. |
| Frozen 8-case selection | `docs/evidence/e4-r87-case-selection.json` — **unmodified**; its stored digest recomputes to `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae`. **6 weak passes / 0 strong passes** is the frozen result and is NOT raised by anything in this round. |

---

## 1. The layered readiness, as measured (not collapsed)

`scripts/e4/ci-readiness.mjs` reports five SEPARATED levels and deliberately has no top-level
`ok`. Running the fixed script over the **genuine GitHub Actions artifact** for
`r97-r98-closed-loop-windows-latest` (SHA `3d6e7562c2bdcdc919093ceaab7520feaa267ae7`,
run `36323899133`) produces:

```
fixtureProtocolReady: PASS
realBuildOfflineReady: BLOCKED
budgetEvidenceReady: NOT_PROVEN
paidExperimentRun: NOT_RUN
championPromotion: NOT_RUN
execution kind: SYNTHETIC_FIXTURE_BUILD (structured field)
forward basis: SYNTHETIC_FIXTURE_BUILD
platforms: this=windows windows=MEASURED ubuntu=NOT_PROVEN cross=NOT_PROVEN
```

| Level | Status | What it is actually based on |
| --- | --- | --- |
| `fixtureProtocolReady` | **PASS** | the E2E artifact's own `ok` over the offline closed loop on SYNTHETIC `writeArmCheckout` fixture arm builds. This is a fixture result and implies nothing about a real dual build. |
| `realBuildOfflineReady` | **BLOCKED** (`NO_REAL_ARM_PAIR`) | the E2E's structural `releaseCliSubprocessForwardBasis` is `SYNTHETIC_FIXTURE_BUILD`; the RELEASE CLI's own fixture-forward path is additionally `CLOSED_BY_R1` (refused pre-request). Two real pinned checkouts built from distinct source SHAs **plus the real verifier over them** remain unproven by this script. |
| `budgetEvidenceReady` | **NOT_PROVEN** | the journal now carries per-attempt `armRunId`/`requestId`/`reservationId` (R2) and total-vs-delta are separate metrics, but the attribution is **not** bound to the trusted manifest/verifier bytes and needs real arm artifacts. |
| `paidExperimentRun` | **NOT_RUN** | no paid authorization exists for this script; it never creates one. |
| `championPromotion` | **NOT_RUN** | promotion is a separate later approval. |

Measured counts in the same artifact (from the real E2E input, `e2eSha256`
`1274ecc172efa6225af0d97675009b30529a0d5d81d8092f00eb31c8cf1ec0df`): `forwardJournalChargedTokens`
248, `forwardAggregateTokensDelta` 248, `evidenceVerified` 124. That input predates R2, so it
carries no per-arm baseline/candidate split; the fixed script reports those as
`NOT_OBSERVED`/`null` rather than inventing `0`.

Command exit codes recorded by the readiness run itself: `n0GapGate=0`, `legacyRedNextGaps=0`,
`docsSmoke=0`; `typecheck`/`test`/`build` are `null` (`NOT_OBSERVED`) because that invocation was
not given `--exit-*` declarations. **Ubuntu-Actions was NOT run by this task.** Locally,
`pnpm typecheck`, `pnpm test:n0-gaps` (12/12) and `pnpm test:red-next-gaps` (14/14) are exit 0.

---

## 2. Readiness is now classified from structure, not prose (F6 fixed)

The pre-R7 rule was `readinessText.includes("SYNTHETIC") ? SYNTHETIC_FIXTURE_BUILD :
REAL_DUAL_PINNED_BUILD`, so lowercase `synthetic`, an empty string and unrelated prose all rendered
`realBuildOfflineReady = PASS`. That classifier is deleted; `readiness.productionOfflineReady` prose
is read by nothing, and no log is scanned for the word `PASS`.

A level may be raised only by:

1. a **known execution-kind enum** in the E2E artifact's structured
   `readiness.productionOfflineReadiness` (`executionKind`, or the leading enum token of
   `releaseCliSubprocessForwardBasis`); anything unrecognised or missing is `NOT_OBSERVED` →
   `NOT_PROVEN`; and
2. for `REAL_DUAL_PINNED_BUILD` only, **verified evidence**: the artifact's `ciRunSha` equals the
   run's expected SHA, a non-empty run id, the producing OS, two DISTINCT 40-hex arm source SHAs
   with build digests, a verifier that ran over every case, `typecheck`/`test`/`build` exit codes all
   0, `ok=true`, and a journal that agrees with the independently recomputed delta. A forged REAL
   enum without that evidence is `NOT_PROVEN` with the concrete failure list, never `PASS`.

Measured: the R0 reproducer `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` went from
**4 failed | 2 passed (6)** at `a85db6dc` to **16 passed (16), exit 0** (16 cases: the original R0
targets plus the §R7.3 mutation table — empty/case/unrelated prose, enum-shaped prose, forged REAL
enum, wrong SHA, missing run identity, null exit code, verifier not run / incomplete / identical
arms, journal mismatch, and a positive complete-REAL case that must PASS).

---

## 3. Platform measurement (F6's second half, fixed)

The pre-R7 script wrote `platforms.ubuntu.status = "NOT_PROVEN"` as a literal in every run,
including one executed on `ubuntu-latest`. The downloaded artifact proves it:

| Downloaded artifact | `os.platform` | `platforms.ubuntu.status` |
| --- | --- | --- |
| `ci-readiness-ubuntu-latest-…-36323899133-attempt-1/ci-readiness.json` | `linux` | **`NOT_PROVEN`** ← a real Ubuntu run reporting itself unproven |
| `ci-readiness-windows-latest-…-36323899133-attempt-1/ci-readiness.json` | `win32` | `NOT_PROVEN` |

The fixed script instead:

- records `platforms.thisProcess` as `MEASURED` for the process that actually ran, and sets the
  `windows`/`ubuntu` slot it ran on to `MEASURED`;
- leaves the other platform `NOT_OBSERVED` when no artifact is supplied (it is not hardcoded, and it
  is not assumed measured either);
- accepts `--other-platform-artifact <ci-readiness.json>` only when that artifact's `ciRunSha`
  equals this run's expected SHA **and** it reports its own platform `MEASURED`; then the slot is
  `MEASURED_SAME_SHA`, otherwise `NOT_PROVEN` with `SHA_MISMATCH` /
  `OTHER_PLATFORM_NOT_SELF_MEASURED`.

Measured with the genuine artifacts at SHA `3d6e7562…` (Linux branch exercised through a
`process.platform` preload — a **simulation on Windows, not a real Ubuntu runner**): this process
reported `this=ubuntu MEASURED`, `windows=MEASURED_SAME_SHA`, `cross=MEASURED_SAME_SHA`, with the
same five levels. Feeding the historical Ubuntu artifact in as the other platform yields
`NOT_PROVEN` (`OTHER_PLATFORM_NOT_SELF_MEASURED`) — honest, because that artifact cannot show its
own platform measured.

### 3.1 The `main` CI red at `afc84b7` was a test-side role assumption, not a product defect

`main` was green at `a85db6dc` (run `36405088815`) and red at `d4b90d44`/`afc84b7`
(runs `36435869148`, `36437529000`). The whole red was **one test**, on ubuntu only:

```
FAIL apps/cli/src/r0-f6-ci-readiness-classification.test.ts > R7-F6-H
AssertionError: expected 'MEASURED' to be 'MEASURED_SAME_SHA'
```

`R7-F6-H` asserted `platforms.ubuntu.status === "MEASURED_SAME_SHA"` while choosing the scenario
with **no** `--os-label` override, i.e. it always ran as a Windows process. In that direction
`ubuntu` is the PEER slot and returns `MEASURED_SAME_SHA`, so the suite was green locally. On a real
ubuntu runner the roles are mirrored: `platformSlot("ubuntu")` returns the early `MEASURED` (this
process *is* ubuntu) and never reaches the other-platform branch, so the same assertion failed.

This is hypothesis **(a)** from the handover — a Windows-only assumption in the test. The product is
**correct in both directions** and was not changed; the evidence above (§3, lines 106–108) already
recorded the Linux-direction output. Reproduced and pinned by running the real script with
`process.platform` forced to `linux`:

| `--os-label` | `thisProcess` | `ubuntu` slot | `windows` slot | `crossPlatform` |
| --- | --- | --- | --- | --- |
| `windows-local` (what the suite used) | windows | `MEASURED_SAME_SHA` ← old assertion | `MEASURED` | `MEASURED_SAME_SHA` |
| `ubuntu-latest` (a real CI runner) | ubuntu | **`MEASURED`** ← old assertion demanded `MEASURED_SAME_SHA` → FAIL | `MEASURED_SAME_SHA` | `MEASURED_SAME_SHA` |

Fix: `R7-F6-H` now asserts the **peer role** (whichever platform is not this process) instead of the
hardcoded name `ubuntu`, and additionally pins that this process's own slot is `MEASURED`. A new
`R7-F6-H2` runs the same scenario through the `process.platform`→`linux` preload so the mirrored
direction is exercised locally on every run instead of first executing on CI. The F6 suite is
**17 passed (17)** on Windows; the file is no longer excluded, so `pnpm test` and the
`R7 — F6 readiness classification gate` CI step both gate it.

---

## 3.2 Scope of that fix

No production source was changed for the CI red: the change is confined to
`apps/cli/src/r0-f6-ci-readiness-classification.test.ts`. The alternative the handover explicitly
forbids — re-adding the file to the `vitest.config.ts` exclude list to obtain a green tick — was
**not** taken; that would have hidden the cross-platform branch F6 exists to surface.

---

## 4. Corrections to statements that are no longer current

### 4.1 "The old pair was never re-pinned" — WRONG (superseded)

- **Superseded statement:** `docs/evidence/E4-N8-paid-run-executed.md` §6.5 — *"Nothing here re-pins
  the repository's arm defaults (`e9776ba`/`a203737`), so the prereg path remains unable to prepare
  legal arms by default."* That was true of the N8 round and is scoped to it.
- **Current fact:** the pair HAS been re-pinned and measured.
  Baseline `8265dc39f74b3d556e059bb86b1cc192357e21dd`, candidate
  `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd`; the pair's entire diff is one file, `+1/−20`
  (`packages/evaluation/src/mechanism-guidance.ts`); build-closure digests
  `09c832a9124c46c56216410cda08026dd89d37b5f96f9c8c9d6a613e8cfab0c0` (baseline) /
  `6bdb2ce094a70c55e4ea052941f684e8a12999282454d93c8b52d9434559e364` (candidate).
  Source: `docs/evidence/E4-N1-comparable-pair-and-negative-control.md` (§1–§2).
- **Raw evidence:** the document above carries the measurements and its own correction history;
  per-arm module-load records, acceptance matrix, ledger and validator reports exist as CI
  artifacts (locally inspected: `.ci/gh-artifacts/main-36323899133/r97-r98-closed-loop-*-…/`).
  The two-platform closed loop reports **564/564 suites, 9/9 matrix, 16 measured units, 6 weak
  passes, 0 strong passes** — weak labels kept, `strongPasses` unchanged.

### 4.2 "The experiment was never paid / PAID_NOT_AUTHORIZED" — scope-specific, not global

- **Superseded phrasing:** `docs/E4-R26-report.md` and `docs/E4-R35-report.md` state *未付费*
  (not paid) — correct for those EARLIER rounds, which ran before any paid authorization.
  `docs/evidence/prereg-N0-gap-matrix.md` records `BLOCKED: PAID_NOT_AUTHORIZED` for the
  *pre-registration path* in the N0/N8 round.
- **Current fact:** `docs/evidence/E4-N8-paid-run-executed.md` records **real billed
  `agent benchmark` calls** against the user's relay under an authorization given in that session
  (endpoint `http://127.0.0.1:8317/v1`, key masked and never written to a file, model
  `workbuddy-deepseek-v4.1-flash`): `GET /v1/models` OK, a `chat/completions` probe OK, and
  `agent benchmark` with `RUN_PAID_BENCHMARKS=1` — **6 model calls / 9 tools** on
  `workbuddy-deepseek-v4.1-flash` (18,371 in / 566 out, upstream `400 {"code":11148}`) and
  **21 model calls / 29 tools** on `deepseek-v4-flash` (204,064 in / 5,780 out, ended on
  `agent_limit`).
- **What those runs are NOT:** they are **not** formal `prereg run` experiments. They were ordinary
  paid `agent benchmark` runs; no preregistration/authorization pair governed them, and no quality
  claim follows from them (one ended in `agent_limit`; `cost.score=0` is not a quality verdict).
- **Raw evidence available:** partial. The N8 document records the numbers it retained, but §6
  states the full regression suite's per-case results were not yet available at writing, the
  failing request body was not retained, and the relay publishes no rates (tokens only, no USD).
  The later round that reviewed this material did **not** obtain the complete raw paid-run package;
  treat those runs as "recorded in the repository as executed", not as reproducible evidence.
- **Status of the 11148 defect:** R6's fix (`13c00e0b…`, appended to that document as §7) is
  `fixed / pending real-world verification` — no relay was contacted in R6, so the §2 hypothesis
  about the stall-recovery injection remains unproven.

### 4.3 "The offline closed loop proves production readiness" — never current

`fixtureProtocolReady = PASS` describes the SYNTHETIC fixture closed loop. It does **not** raise
`realBuildOfflineReady` (BLOCKED) and does not authorize money (`paidExperimentRun = NOT_RUN`).
Nothing in this document treats an overall green CI as pre-registration readiness.

---

## 5. Runtime Freeze — what actually changed this round

Runtime architecture is frozen (`AGENTS.md` P38.4-11). This round changed code only under the
sanctioned reasons, and each change carries a reproducer:

| Task | Defect class | Sanctioned reason | Evidence |
| --- | --- | --- | --- |
| R1 (`e4/r1-fixture-trust`, tip `cffd2818ea95fc8956e8c5be4b803ac9ee9aa1c4`) | F1 loopback accepted as proof of "non-billable"; F2 a self-written marker file trusted as a checkout | security boundary defect | RED reproduced first-hand on baseline in the R0 worktree (F1 `ADMITTED`; F2 `childRan=true, relayHits=1, upstreamHits=1`) then GREEN |
| R2 (`e4/r2-token-delta`, tip `d03984e0ea3c379d1bc4a74e47054bbde8470e81`) | F3 the campaign TOTAL used as the baseline→candidate delta | deterministic correctness defect with reproducer | RED probe reproduced first-hand (`expected 140 to be -60`; no-journal case) then GREEN |
| R6 (`e4/r6-protocol`, tip `ec98eeec4d60d47282f9bee4e96a54b9a0108371`) | F7 `isToolProtocolValid`/`assertToolProtocol` accepted orphan/duplicate/extra tool results | deterministic correctness defect with reproducer | RED re-run first-hand on baseline (4 failed | 4 passed) then GREEN |
| R4 in-scope half (merged into main `2645006f`) | F5 `PREREG_PRICING_JSON` had no validity window and no bound pricing digest, and read `process.env` instead of the injected env | deterministic correctness defect with reproducer | `apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` (R0's reproducer) |
| R0 / R7 (`e4/r0-gap-matrix`, `e4/r7-readiness`) | evidence + readiness classification | no Runtime change: docs, tests and `scripts/e4/ci-readiness.mjs` only | `docs/evidence/prereg-R0-gap-matrix.md`; the F6 suite above |

So: **code did move this round**, and the movement is bounded to R1/R2/R6 plus R4's in-scope half.
Everything else in this round is evidence and gating.

---

## 6. Still `NOT_PROVEN` / `NOT_RUN` / `BLOCKED`

1. **Real dual pinned build + the real verifier over it** — `realBuildOfflineReady = BLOCKED`
   (`NO_REAL_ARM_PAIR`). Requires two real arm builds at distinct source SHAs carried through the
   real verifier; the readiness script will accept it only with the full evidence block of §2.
2. **Budget evidence chain** — `budgetEvidenceReady = NOT_PROVEN`: per-arm journal attribution is
   recorded but not bound to the trusted manifest/verifier bytes.
3. **A paid FORMAL pre-registration experiment** — `paidExperimentRun = NOT_RUN`. Historical paid
   `agent benchmark` runs exist (§4.2); a formal `prereg run` does not, and this round does not
   authorize one.
4. **Promotion** — `championPromotion = NOT_RUN`.
5. **Ubuntu** — the F6 suite is now **gated on ubuntu** and green there (run `36508490472`, commit
   `349559d`, both `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` and
   `coverage gate (ubuntu)` succeeded). The Ubuntu case inside that suite is still a
   `process.platform` preload simulation locally; the real Ubuntu evidence is the Actions job. The
   fixed readiness script has not been run by hand on a real Ubuntu runner.
6. **Model-quality verdict** — unchanged: 6 weak passes / 0 strong passes on the frozen selection,
   `INCONCLUSIVE`. No number in this document claims otherwise.

---

## 6.1 F4/R3 deadline — the mid-stream half is now closed

The R3 round enforced the campaign deadline at **pre-send** boundaries only (initial send and every
retry). `HANDOVER-20260928-E4-R0-R7.md` residual 2 recorded the remainder: a provider stream that is
**entered** before the deadline and then **stalls** past it was not aborted, so the unit never
converged.

RED reproducer (`packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts`, `[R3-mid-stream]`,
before the fix): a provider yields one event then stalls 30 s, deadline 300 ms out.

```
AssertionError: expected false to be true      // the AbortSignal never fired
Duration 31.96s / case 30096ms                  // it waited out the entire stall
```

GREEN after the fix (`560ec24`): **355 ms**, `aborted = true`, error names
`CAMPAIGN_DEADLINE_EXCEEDED`. The fix arms one timer at the deadline that aborts a linked
controller and passes that linked signal to the inner provider; a truncated stream is reported as a
deadline abort, not a clean completion; the `finally` clears the timer and the caller listener. The
pre-send behaviour is unchanged (the existing `[N4.14/R3]` case still refuses with the transport never
entered). Sanctioned under Runtime Freeze P38.4-11 clause 4.

Still `NOT_OBSERVED` on this dimension: the **worker/CLI** leg (cancel the in-flight provider stream
on worker **timeout**, closed stdin, hung child, partial frames) — the provider leg is now covered,
the worker leg is not.

---

## 7. Historical sources and their scope (raw-evidence status)

| Document | Round / scope | SHA(s) | Raw evidence |
| --- | --- | --- | --- |
| `docs/evidence/E4-N1-comparable-pair-and-negative-control.md` | N1 — comparable pair, ABI negative control | pair `8265dc39…` / `ee15e7e7…` | measurements in-document; CI artifacts on disk (`r97-r98-closed-loop-*`) |
| `docs/evidence/E4-N1-report.md`, `E4-N1-remaining-handover.md` | N1 follow-ups / handover | N1-era | in-document; some raw runs referenced, not all retained |
| `docs/evidence/E4-N3-report.md` | N3 — pricing/paid admission | N3-era | in-document |
| `docs/evidence/E4-N4-report.md` | N4 — tool budget dimension | N4-era | in-document |
| `docs/evidence/E4-N5-report.md`, `E4-N6-report.md` | N5/N6 — closed loop, verifier | N5/N6-era | in-document |
| `docs/evidence/E4-N7-report.md` | N7 — readiness artifact introduced | `a17cf21bcf82` | `ci-readiness.json` samples quoted; sample is v1 and predates R7 |
| `docs/evidence/E4-N7.4-N8-network-and-pricing-ruling.md`, `E4-N8-paid-handover.md` | N7.4/N8 — network + pricing ruling, handover | N7.4/N8-era | in-document; **the handover's expectations are superseded by §1–§3 here** |
| `docs/evidence/E4-N8-paid-run-executed.md` | N8 — paid `agent benchmark` runs (+ R6 §7) | N8-era; R6 `13c00e0b` | PARTIAL: per-case results not available, failing body not retained, no USD rates |
| `docs/evidence/prereg-N0-gap-matrix.md`, `prereg-next-gap-matrix.md` | N0/B0 — earlier gap matrices | N0/B0-era | in-document; **their "current status" framing is superseded by this page** |
| `docs/evidence/tool-call-efficiency-p1-p7-report.md` | P1–P7 — mechanism rounds | P1–P7-era | in-document |
| `docs/evidence/R6-wire-protocol-offline.md` | R6 — wire protocol (this round) | `13c00e0b` / `a85db6dc` | in-document; local stub, 0 network |
| `docs/evidence/prereg-R0-gap-matrix.md` | R0 — baseline + F1–F7 matrix (this round) | `a85db6dc` | in-document; F1/F2/F3/F7 RED re-run first-hand by R0 |
| this file | R7 — current status | `2645006f` → R7 branch | commands and exit codes below |

---

## 8. Re-running this page's claims (offline, zero paid requests)

```text
# 1. the F6 acceptance + mutation suite (16 cases)
pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts

# 2. the readiness artifact over a real E2E artifact, with the other platform checked at the same SHA
node scripts/e4/ci-readiness.mjs \
  --e2e <prereg-production-e2e.json> --out <ci-readiness.json> \
  --expect-sha <40-hex sha> --run-id <github run id> --os-label <matrix.os> \
  --other-platform-artifact <other-platform ci-readiness.json>

# 3. the gates this document quotes
pnpm typecheck
pnpm test:n0-gaps
pnpm test:red-next-gaps
```

All of the above are local and offline: no provider, no key, no relay, no paid request.

---

## 9. R7 close (`task-8`) — the merged round on ONE SHA

**SHA measured:** `910b80e69e920125a0bfb2ab60281f56010eb5ac` (branch `e4/r7-close` = main + a
refreshed R0 row + this document; the branch commit is reported with the task). Windows 10
local only — **Ubuntu was NOT run here**; dual-platform CI and the Ubuntu cold start remain
the Actions authority.

### 9.1 Gates, with real exit codes and counts (measured locally)

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm typecheck` | `0` | clean |
| `pnpm build` | `0` | clean |
| `pnpm docs:verify` | `0` | `ALL CHECKS PASS` |
| `pnpm test:n0-gaps` | `0` | **12 passed (12)** |
| `pnpm test:red-next-gaps` | `0` | **14 passed (14)** |
| R0 gap gate (`vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts`) | `0` | **22 passed (22)** (was `8 failed \| 4 passed` before this task refreshed the two stale F5 rows) |
| `pnpm test` (full, run ONCE) | `1` | **Test Files 5 failed \| 394 passed (399)**; **Tests 22 failed \| 7347 passed \| 5 skipped (7374)** |

### 9.2 The 22 full-suite failures are PRE-EXISTING, not introduced here

They are **not all green locally and are not reported as such.** The failing set is exactly the
two categories the round already knew about, plus the same real-chain/E2E environmental class:

- `packages/evaluation/src/e4-r77-baseline-oracle.test.ts` — **7** (argv/quoting class)
- `packages/evaluation/src/r97-arm-worker-contract.test.ts` — **9** (worker-timing /
  temp-checkout class; the recorded detail is `has no loadable apps/cli/dist/benchmark-command.js
  … Cannot use import statement outside a module`, i.e. a Windows-local temp-dir ESM/CJS artifact)
- `apps/cli/src/e4-09-production-e2e.test.ts` — **4**, `apps/cli/src/e4-r55-failure-wiring.test.ts`
  — **1**, `apps/cli/src/benchmark-command.test.ts` — **1** (`E4-R41` host probe; same real-chain class)

Baseline `a85db6dc` fails the same class locally (task-12 proved the baseline name-set is a
**superset** of the merged one; this task did not re-run baseline, so that superset claim is
cited, not re-measured). **No failing name above is in a file this round changed.** CI on
ubuntu + windows is the authority for these.

### 9.3 The refreshed R0 rows (stale call sites, not weakened contracts)

`R0-F5-fold` was a stale CALL SITE: it fed `issuedAt`/`expiresAt` into the **legacy** shape,
whose allowed keys are exactly `baseUrl`/`source`/`boundByModel`, so the strict parser
correctly rejected it as `unknown_field`. It now pins **both accepted forms** (labelled legacy
mode, and the `v2_windowed` form). `R0-F5-A` demanded `null` for a validity-less declaration,
which is no longer the accepted contract (task-6 deliberately keeps that shape as an
explicitly-labelled `legacy_ephemeral` mode); it is **re-expressed** to assert what the gap was
actually about — such a declaration must be labelled `legacy_ephemeral` +
`sourceKind: "operator_declared"`, carry `issuedAt`/`expiresAt === null`, produce a different
digest from the windowed basis, and can never self-declare `provider_verified`. **No production
contract was weakened to satisfy a test.**

### 9.4 Mutation gate — one OPEN item

The anti-cheat mutation gate is **26/27 CAUGHT**. The one miss,
**`a6-forged-evidence-accepted`**, is a dead check repaired separately by `task-13`. It is
recorded here as an **OPEN item** and is **not** reported as passing, and it is not a
formal-experiment blocker by itself.

### 9.5 Formal-experiment readiness — UNCHANGED, and no paid package is emitted

`realBuildOfflineReady` is still **BLOCKED** (`NO_REAL_ARM_PAIR`) and `budgetEvidenceReady` is
still **NOT_PROVEN**; `paidExperimentRun` is **NOT_RUN**. A green CI is **not** a substitute for
formal-experiment readiness, so this document does **not** emit a pending-review
model/endpoint/price-source/amount/calls/tools/duration/window package: those conditions are
not met on this SHA. Historical paid `agent benchmark` requests remain **historical paid
benchmarks**, never renamed into formal `prereg run` experiments.
