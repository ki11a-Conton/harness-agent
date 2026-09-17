# E4-R92 report — the authorization-ready real A/B plan

**Task.** After R88–R91 are accepted, prepare an auditable plan for the real small
A/B. Per plan §R92 this task is *planning only*: it performs the offline checks
and the fake-provider rehearsal, and it **does not send a single real provider
request**. Plan §R92 line 197 is explicit that the deliverable is the plan.

| Item | Value |
| --- | --- |
| Verdict | **`READY_FOR_AUTHORIZATION` / `NOT_RUN`** |
| Real provider calls | **0** (structurally — the rehearsal module accepts no provider) |
| Network | none |
| Holdout cases read per-case | **none** |
| Cases selected | 8, non-holdout dev set (R87-frozen) |
| Arm identity mode | `isolated-checkout-build` |
| Fix scope | `single-fix-H2` |
| Plan digest | `ffe3bea77e27283917847536a08d351e33f26d2ac0773b59fc590926868970f1` |
| Expires | `2026-10-16T08:27:46.000Z` (created from the candidate commit time + 30 days) |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS on a clean tree (see §7) |
| Paid A/B executed | **NO** — not authorized |

**This report is not paid authorization.** The plan runs only after the user
approves the exact digest above.

---

## 1. What was built

Four modules, all offline:

| Module | Role |
| --- | --- |
| `packages/evaluation/src/r92-authorization.ts` | The envelope contract, cap classification, static validation, digest, and the pre-provider gate |
| `packages/evaluation/src/r92-rehearsal.ts` | The 12-scenario fake-provider matrix against the REAL paired executor |
| `packages/evaluation/src/r92-plan.ts` | Builds the authorization-ready plan from real repository facts and renders the approval package |
| `scripts/e4/r92-authorization-request.mjs` | The driver: runs the rehearsal, then emits the plan and approval package |

The selection digest (R87's `0d8af323…`) covers **case choice only** and is
deliberately *not* used as the paid-authorization digest, per plan §R92 line 208.
The authorization digest is separate and binds the surface line 209 requires:
actual SHAs, case content fingerprints, provider/model/endpoint identity,
configuration, limits, arms, repetitions, serialism, expiry and the global budget.

## 2. Why these two arms are two checkouts (not a runtime switch)

Plan §R92 line 202 permits either two isolated checkouts/builds **or** an
explicitly-declared same-version controlled switch, and forbids mixing the two.
This plan declares `isolated-checkout-build`, and that is not a stylistic choice:

The H2 fix is a Runtime behaviour change reached through `streakResultAware`.
That flag is reachable **only** from the R87 in-process replay module
(`packages/core/src/runtime/r87-zero-call-replay-ab.ts`); the benchmark CLI never
exposes it, and none of the 9 `CANDIDATE_FEATURES` ids in `candidate-matrix.ts`
is the H2 gate. So H2 arms **cannot** be expressed as a `--candidate` switch. A
switch would have been a mislabelled checkout, which line 222 forbids.

| Arm | Commit | Role |
| --- | --- | --- |
| baseline | `e9776ba66190ea63b1bacb685c91aa900b6935e7` | pre-R86, progress-blind streak gate |
| candidate | `a20373743b56de6a3a110fecdd254737ece71afa` | baseline + the H2 fix |

Verified, not assumed: `git merge-base --is-ancestor` confirms the H2 fix commit
`ec91c28` is an ancestor of the candidate and **not** of the baseline.

Per-arm identity is bound separately (`arms.baseline.executionPlanDigest` and
`arms.candidate.executionPlanDigest`) because two isolated checkouts necessarily
produce two different plan digests — the plan binds `sourceSha` and
`treeFingerprint`. A single shared digest would hide one arm's build identity.

## 3. Fix scope: H2 alone, stated separately from joint verification

`e9776ba → a203737` contains **exactly one functional commit** (`ec91c28`, the
H2 fix); the only other commit in that range is `a203737` itself, which touches
`docs/E4-R86-report.md` alone. `ec91c28` changes 17 files — 8 functional source
files (`apps/cli/src/benchmark-command.ts`, `packages/contracts/src/event.ts`,
`packages/contracts/src/event-payloads.ts`, `packages/core/src/runtime/runtime.ts`,
`packages/core/src/runtime/tool-call-controller.ts`,
`packages/core/src/state/agent-state.ts`, `packages/evaluation/src/manifest.ts`,
`packages/observability/src/metrics.ts`), 6 test files, and 3 non-source files
(`.gitattributes`, `.github/workflows/ci.yml`, `docs/E4-R86-report.md`). All of
them implement the single H2 mechanism: exporting
`DEFAULT_ENABLED_STALL_PATTERNS`, adding `progressCancelled`/`wouldBeStreak`,
adding `resultFingerprintOf`/`noteExecutedCall`, and emitting
`stall.progress_detected`. So `single-fix-H2` is the accurate label, and a TARGET
delta is attributable to H2.

Plan §R92 line 213 requires joint multi-fix verification to be stated
**separately** so gains are not all credited to H2. `jointAttributionNote` is
therefore `null` for this plan, and the approval package states that if a later
experiment changes several fixes at once it must declare so and must not credit
the joint delta to H2.

## 4. The case set is the R87 frozen selection, reused deliberately

Plan §R92 line 212 forbids changing the sample after seeing candidate results.
Re-choosing a fresh 8 cases now would be exactly that, so the plan reuses the
**R87 selection that was frozen and digest-committed before any candidate result
existed**:

`regression/reg-16-cicd-step`, `stress/stress-many-artifacts`,
`stress/stress-very-long-json` (3 TARGET) and
`regression/reg-24-error-handling`, `regression/reg-03-add-import`,
`regression/reg-14-stack`, `regression/reg-17-gcd`,
`regression/reg-06-json-parse-test` (5 COUNTEREXAMPLE).

Two properties were **measured** rather than assumed:

- **Non-holdout**: none of the 8 carries a `holdout/` prefix. The envelope rejects
  any holdout case outright.
- **Not confounded by R91**: the R91 fix changed how `.cmd`/`.ps1` shims are
  launched. The plan counts each case's verifiers that resolve to a Windows script
  shim, and the measured count is **0** — the 3 TARGETs use `kind: "artifact"`
  (no command) and the 5 COUNTEREXAMPLEs use real `node`/`python3` executables.
  So an H2 delta on this set cannot be an artifact of the R91 executor fix.

Case order is the selection's declared order, and content fingerprints are
computed with the same `caseInputFingerprintV1` field set the execution identity
binds, so plan and identity cannot drift apart.

## 5. Caps: what the call layer can actually enforce

Plan §R92 line 211 is the governing rule: *"如果调用层不能执行所声明的硬上限，
先把该项标 BLOCKED；不能通过文字宣称已限制"* — if the call layer cannot execute a
declared hard cap, mark it BLOCKED; a textual claim is not enough. Each cap below
was classified by reading its actual measured call site.

| Cap | Scope | Value | Enforcement | Blocked |
| --- | --- | --- | --- | --- |
| `maxModelCalls` | campaign-wide | 320 | **runtime-enforced** | no |
| `maxLogicalRuns` | campaign-wide | 16 | preflight-only | no |
| `maxEstimatedTokens` | campaign-wide | undeclared | preflight-only | no |
| `maxEstimatedCostUsd` | campaign-wide | undeclared | **unprovable** | no |
| `maxToolCalls` | per-case | 100 | **runtime-enforced** | no |
| `maxDurationMs` | per-case | 600 000 | **runtime-enforced** | no |

- **`maxModelCalls` is genuinely runtime-enforced** — but only under a declared
  condition. `createBudgetedProvider` throws *before* the call when
  `budget.exhausted()`, sets `hitCap`, and `runPairedExperiment` breaks the loop
  after each arm. The catch is that this is a *single-invocation* budget:
  `run-campaign.ps1` currently passes a **per-case** `--max-model-calls 60` with no
  campaign-wide counter. The cap is therefore classified `runtime-enforced` only
  because `invocationMode` is `single-invocation-over-frozen-list`; under any
  other invocation mode it degrades to `preflight-only` + `blocked: true`.
- **`maxLogicalRuns` is preflight-only, not BLOCKED**, because its count is exact
  (`caseCount × repetitions × armCount = 16`) — it is a checkable plan invariant,
  not a runtime interrupt.
- **`maxEstimatedTokens` / `maxEstimatedCostUsd` are undeclared, not blocked.**
  Line 211 makes a *declared but unenforceable* cap BLOCKED. No token hard-cap
  layer exists in `RunLimits` at all, and `maxEstimatedCostUsd` is additionally
  non-hard (`isHardLimit` excludes it). Declaring a number here would be precisely
  the textual claim line 211 forbids, so the plan declares nothing and names the
  unknown instead. Had a value been declared, `blocked` becomes `true`
  automatically — that branch is tested.
- `maxToolCalls` (100) and `maxDurationMs` (600 000) come from the CLI's real
  per-case `limits` and are enforced during the run.

`r92CapViolations` also rejects a cap that *claims* `runtime-enforced` while
measured as preflight/unprovable, and requires a campaign-wide `maxModelCalls` to
exist at all — a plan with no global budget is refused.

## 6. Offline rehearsal: 12/12 scenarios, 0 external requests

`runR92Rehearsal` is handed **no provider**. It constructs every provider
in-process, so "0 external requests" is structural rather than an assertion — the
report field is `providerRequests`, which must be `> 0` for the running
scenarios, proving the runs were real and not vacuous.

Measured result (`node scripts/e4/r92-authorization-request.mjs`):

| Scenario | Authorized | Run | Code | Stopped as agreed | Provider reqs |
| --- | --- | --- | --- | --- | --- |
| authorized-happy-path | true | RAN | — | yes | 16 |
| unauthorized | false | NOT_RUN | `PAID_AUTHORIZATION_REQUIRED` | yes | 0 |
| expired-authorization | false | NOT_RUN | `AUTHORIZATION_EXPIRED` | yes | 0 |
| wrong-digest | false | NOT_RUN | `AUTHORIZATION_DIGEST_MISMATCH` | yes | 0 |
| identity-drift | false | NOT_RUN | `IDENTITY_DRIFT` | yes | 0 |
| budget-exhaustion | true | RAN | — | yes | 1 |
| provider-429 | true | RAN | — | yes | 16 |
| provider-5xx | true | RAN | — | yes | 16 |
| disconnect | true | RAN | — | yes | 16 |
| persistence-failure | true | RAN | — | yes | 0 |
| mid-run-stop | true | RAN | — | yes | 16 |
| blocked-cap | false | NOT_RUN | `CAP_NOT_ENFORCEABLE` | yes | 0 |

**Total: 12 scenarios, 0 failed, 81 fake-provider requests, 0 external requests.**

The 16-call scenarios are 8 cases × 2 arms driven through the budgeted provider —
i.e. the happy path exercises provider + budget + journal + pair finalization, not
a canned arm body. The 5 refusal scenarios all stop at **0 provider requests**,
which is the line-221 requirement that refusal happen before the first provider
request; the global `providerRequests: 81` is asserted too, so those zeros cannot
pass vacuously. The budget scenario shows **1** request: the arm attempts two
against a cap of 1, and the second is refused at the call site.

### Three defects this rehearsal caught (all fixed)

1. **The happy path was vacuous.** It originally passed `runArm: async (arm) =>
   fakeOutcome(...)` with `maxModelCalls: 4`, so it never touched the provider and
   reported `providerRequests: 0` while claiming completion. The arms now drive
   `ctx.provider.createClient(...)`, and the scenario asserts `calls > 0`.
2. **The rehearsal was not re-runnable.** The executor reads an existing journal
   as a *resume* request and rejects it when the identity differs, so a second run
   in the same `workDir` ran nothing (0 provider calls) yet reported every
   scenario as "stopped as agreed". A rehearsal that cannot be re-run is not
   evidence. `runR92Rehearsal` now starts from a clean `workDir`, and every
   running scenario carries a `refused(result)` guard so a `resume-rejected`
   result can never be read as agreement. A regression test fails with
   `expected +0 to be 81` without the fix.
3. **The budget scenario under-proved its claim.** See §7 — the arm now attempts
   two calls against a cap of 1 so the refusal is observed *at the call site*.

## 7. Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| R92 suites | 3 files, 60 tests passed |
| `pnpm test` | **PASS** — 339 files, 6191 passed / 3 skipped, 0 failed (clean tree) |
| `pnpm docs:verify` | ALL CHECKS PASS |
| External provider requests during any R92 check | **0** |

The full suite initially failed with **2 failures** in
`packages/security/src/no-silent-catch.test.ts` (P14-6): the rehearsal contained
two silent `catch {}` blocks and one `.catch(() => undefined)`. The scan is right
that comments are not observability, so each catch now records its error and the
scenario asserts on it. That change was not cosmetic — it exposed a real gap:

- **budget-exhaustion was proving less than it claimed.** With a cap of 1 the arm
  made exactly one call, so the budget never threw *at the call site*; the stop
  came from the executor's post-arm check. The arm now attempts **two** calls
  against a cap of 1, so the second is refused by the budgeted provider *before*
  reaching the transport. The test asserts exactly one request reaches the
  transport — the property that makes the cap runtime-enforced rather than
  advisory.
- **mid-run-stop could have been vacuous.** The injected stop was swallowed, so a
  failed injection would have turned the "resume" into a plain first run. The
  stop is now observed and asserted.
- **persistence-failure** now asserts a real error message surfaced, so
  `surfaced` cannot be true for an empty reason.

The 12-scenario verdicts are unchanged; only their evidential strength increased.

The digest is a pure function of repository facts plus the validity window:
`createdAt` is anchored to the candidate commit's committer timestamp rather than
wall-clock "now". This matters — with a wall-clock default, regenerating the plan
later produced a *different* digest, so the user would have approved a value the
gate must then refuse. Three consecutive driver runs now yield the identical
digest `ffe3bea7…`, and a test asserts `createdAt` equals the commit timestamp.

## 7b. A red CI gate found on `origin/main` — and fixed here

Plan §R92 line 223 requires the Ubuntu cold-start/offline gates to **keep
passing in CI**. Checking that claim rather than assuming it exposed a real
failure: `origin/main` was `567ca03` (E4-R89), and its CI run was **red** —
https://github.com/ki11a-Conton/harness-agent/actions/runs/35173144683

| Run | Commit | Result |
| --- | --- | --- |
| 35167911660 | `20f01b9` (R88) | success |
| 35173144683 | `567ca03` (R89) | **failure** — job `offline cold-start (ubuntu)`, step *"Verify the workflow itself cannot authorize a paid run"* |

**Root cause, reproduced locally.** The E4-R82 cold-start job scans
`.github/workflows/ci.yml` for a paid-authorization literal:

```
grep -nE 'RUN_PAID_BENCHMARKS\s*[:=]\s*["'"'"']?1' .github/workflows/ci.yml
```

E4-R89 added a **negative control** to the same workflow, spelling that literal
out in full inside a PowerShell regex (`ci.yml` line 576). The guard therefore
matched its own control string and exited 1. Reproduced by running the exact
bash grep against the workflow at `b10e01f` (fails), `20f01b9` (passes) and
`567ca03` (fails) — the introduction point is confirmed by `git log -S`.

This was invisible locally because the guard lives **only** in the cold-start
job; `pnpm test` never executes it, and R90–R92 were never pushed, so no CI run
covered them either.

**Fix.** The control is now assembled from fragments, so the contiguous literal
never appears in the file while the control still exercises the detector:

```powershell
$controlSample = '$env:RUN_PAID_BENCHMARKS' + ' = ' + '"1"'
```

Verified both directions: the bash guard now passes on `ci.yml`, the assembled
sample still matches the detector regex (`control matches = 1`), and a new local
mirror of the guard runs under `pnpm test`
(`packages/security/src/workflow-paid-authorization.test.ts`) so this class of
defect can no longer reach CI unseen. The mirror includes a non-vacuity check
that the pattern still detects the original defect shape.

The E4-R89 conclusion (F3/F4/F5 fixed, RED and GREEN reproduced locally) is
unaffected: the workflow *guard* broke, not the runner contract. R89's report
never claimed CI was green — its §10 said the run id was still to be filled in —
and it now records this follow-up.

## 7c. The next run was red too — two more real defects, both fixed

Fixing §7b produced a new red run, which is the honest state of the record:

| Run | Commit | Result |
| --- | --- | --- |
| 35185496622 | `bb909de` | **failure — 4 jobs**: `install · … (ubuntu-latest)`, `install · … (windows-latest)`, `coverage gate (ubuntu)`, `offline cold-start (ubuntu)` |

This run is the **first and only** CI coverage R90, R91 and R92 ever received
(none was pushed individually). It failed, so it cannot be cited as evidence
that those revisions pass in CI. Two independent real defects caused all four
jobs, and both were invisible on the author's Windows box:

**Defect 1 — the R92 plan builder could not run in CI at all.**
`r92-plan.test.ts` failed **10 of 11** tests with
`fatal: bad object a20373743b56de6a3a110fecdd254737ece71afa`. The builder called
`git show -s --format=%cI <sha>` and `git merge-base --is-ancestor` on historical
commits to derive `createdAt` and the H2-fix ancestry. `actions/checkout` clones
**shallow (depth 1)**, so those objects are absent in CI — while passing locally,
where the full history exists. A plan that cannot be regenerated in CI cannot be
verified there, which defeats the artifact's whole purpose.

Fixed by pinning `R92_BASELINE_COMMITTED_AT` / `R92_CANDIDATE_COMMITTED_AT` as
constants and making ancestry **three-valued**: `true` on success, `false` only on
git's documented exit 1, and `null` when the object is missing. A `null` now
renders as `UNKNOWN (commit absent from this clone)`; previously
`String(undefined)`-style coercion would have printed `false`, asserting the H2
fix is *absent* from a revision that was merely uninspectable — a false claim
dressed as a fact.

A drift guard was added so a pinned constant cannot silently diverge from the
commit it describes: the test asserts both constants against `git show` when
history is present, and **skips** in a depth-1 clone rather than passing
vacuously. It was mutation-tested — shifting the pin by one second fails it
(`expected '2026-09-16T08:27:46.000Z' to be '2026-09-16T08:27:47.000Z'`).

**Defect 2 — a Windows-only test ran on Linux.**
The `offline cold-start (ubuntu)` job failed on
`runs a real .cmd shim resolved by BARE NAME through runArgv end-to-end`. That
test spawns a `.cmd` shim but sat in an **unguarded** `describe` block, so it ran
on Linux, where `planArgvLaunch` correctly hands the bare name to POSIX `spawn`
and POSIX has no `PATHEXT` — the file exists only as `r91endtoend.cmd`, so
`spawn r91endtoend ENOENT`. Fixed with `it.skipIf(!isWindows)` (`skipIf`, not an
early `return`, so a POSIX run reports **SKIPPED** and cannot be mistaken for a
pass). RED→GREEN proven by forcing `process.platform = "linux"`: the test went
`×` failed → `↓` skipped, a delta of exactly that one test.

A regression guard now prevents the whole class:
`packages/tools/src/process/windows-fixture-guard.test.ts` statically fails when
a test file references a `.cmd`/`.bat`/`.ps1` fixture without a platform guard,
and includes its own non-vacuity checks.

### Correction to an earlier claim in this report

An intermediate diagnosis in this work asserted that CI's tree was **dirty** at
`pnpm test` time, on the strength of reproducing `e4-09-production-e2e` and
`benchmark-command` failures in a scratch clone. **That claim was wrong.** The
dirt was self-inflicted: the scratch clone had fixed sources `Copy-Item`'d into
it (`git status` showed ` M packages/evaluation/src/r92-plan.{ts,test.ts}`), which
is exactly what the promotion clean-tree gate refuses. With a genuinely clean
clone those two suites pass.

Confirmed directly rather than argued: a **clean depth-1 clone** at this lineage
with CI's exact env vars (`CI`, `OPENAI_API_KEY=""`, `E2E_OBSERVATION_*`,
`E4_09_DIAG_DIR`, `E4_R55_PARENT_DIAG_DIR`) gives

```
Test Files  341 passed (341)
     Tests  6198 passed | 3 skipped (6201)
```

exit 0, 0 failed — and `git status --porcelain` is empty **after** the run, not
only before it. The CI sequence was also replayed step by step
(`install --frozen-lockfile` → `typecheck` → `build`), checking for dirt after
each: clean throughout. `core.autocrlf=true` (GitHub's Windows runner default)
was tested and produces **0** porcelain lines, ruling out line-ending churn.
There is no CI-specific dirt source; the hypothesis is withdrawn.

The lesson worth keeping: a scratch-clone reproduction must be proven clean
*before* its failures are attributed to CI.

## 7d. A third red run — one defect, three ubuntu jobs

Fixing §7c's two defects made the **windows** job go green, which is what makes
F8's fix measurable rather than asserted. But the run was still red:

| Run | Commit | Result |
| --- | --- | --- |
| 35191203869 | `fd6a5f5` | **failure — 3 ubuntu jobs**: `Unit and integration tests`, `coverage gate (thresholds fail the job)`, `offline cold-start (ubuntu)` at `Linux oracle`. `install · … (windows-latest)` = **success** |

All three trace to **one** cause. The first two run the whole suite — the coverage
gate runs `pnpm test:coverage`, i.e. every test, and only *then* checks the
per-package thresholds — and the third runs `executor.test.ts` directly at its
`Linux oracle` step. So a single failing Linux test reddens all three.

**It was not a coverage-threshold dip — measured, not argued.** Every one of the
8 packages passes on Windows. The remaining doubt was whether *skipping* the
Windows-only tests on Linux could drop `packages/tools` below its 85/68 gate,
since that is the only package whose tests are platform-conditional. It does not:
running the full `pnpm test:coverage` with `isWindows` forced to `false` — exactly
the test set ubuntu executes — gives `tools/src` **89.84 % lines / 79.38 %
branches** and **exit 0**. The coverage job was therefore red purely because a
test failed inside it, which is the gate's design: it runs the whole suite and
only then checks thresholds, making a test failure and a threshold failure
indistinguishable from the job list alone.

**Outcome: the next run was fully green.**

**Defect 3 — two tests relied on the host folding case.**
In the *unguarded* `describe("E4-R91: argv launch planning
(platform-parameterised)")` — deliberately unguarded so the decision table is
exercised on both platforms — two tests wrote a lowercase fixture
(`toolname.cmd`, `casetool.cmd`) and then resolved it by **bare name**:

```ts
const shim = join(dir, "toolname.cmd");
writeFileSync(shim, "@echo off\r\n", "utf8");
expect(eq(resolveWindowsCommand("toolname", env), shim)).toBe(true);
```

`resolveWindowsCommand` appends the **PATHEXT spelling verbatim** — uppercase
`.CMD` — and asks the filesystem whether that path exists. Windows folds case, so
one lowercase file answers a probe for `toolname.CMD`; that is why the production
path is correct and why these tests passed on every Windows gate, including the
author's box. **ext4 does not fold case**, so the probe misses, the bare name
resolves to `null`, and the assertion fails *only* on Linux.

Fixed by writing each fixture under **both** casings, so the tests assert *our*
resolution logic (append the PATHEXT extension, search PATH) instead of
accidentally asserting the host filesystem's case folding. On Windows the two
writes collapse into one file, so the fixture is unchanged there.

**Why this needed an emulation.** The obvious check — write both casings and read
the directory back — **cannot distinguish the fix from the bug on Windows**:
Windows physically collapses `tool.cmd` and `tool.CMD` into a single directory
entry, so the check reports the same one file either way. (It reported exactly
that when first tried, which is what exposed the flaw in the check.) The decisive
harness instead records the **exact spelling** of every path written and answers
`existsSync` only for an exact-case hit, falling back to a readdir exact-match for
real repository files. Under that emulation:

```
original committed executor.test.ts  ->  4 failed / 26 passed
fixed    executor.test.ts            ->  30 passed
```

Both halves ran against the **same** emulation, so the RED/GREEN pair is
identity-consistent. Two of the four pre-fix failures sit inside
`skipIf(!isWindows)` blocks and are skipped on a real Linux host; the two in the
unguarded `describe` are precisely what runs on ubuntu-latest.

**A second regression guard, and a vacuity trap in it.** `windows-fixture-guard.test.ts`
gains an independent static scan, `unguardedCaseFoldingReliance`, flagging any
unguarded test that calls `resolveWindowsCommand` while only ever writing a
lowercase script fixture. Mutation-tested against the pre-fix file it names
exactly the two offenders:

```
435: writes toolname, toolname but probes the PATHEXT spelling
520: writes casetool but probes the PATHEXT spelling
```

The **first version of that scan was vacuous**, and the way it failed is worth
recording: E4-R91's own explanatory comment contains the prose
``PATHEXT spelling (`.CMD`)``, and the "an uppercase fixture is already present"
escape hatch matched that backtick-quoted text — so the scan **passed against the
very file it was written to catch**. It was caught only by mutation-testing the
guard against the known-bad input, not by reading it. Comments are now blanked
(length-preserving, so reported line numbers stay exact) before scanning, and the
uppercase pattern requires a non-empty stem.

**Honest limit, and how it was closed.** F9's RED/GREEN rests on a faithful
**emulation**, not on a real Linux host: this environment has no WSL distribution
and no Docker, so no ext4 filesystem is reachable. The emulation models exactly
the property in question (exact-case existence) and nothing else. The defect
itself is not in doubt — `existsSync(join(dir, "toolname.CMD"))` is unambiguously
false on ext4 when only `toolname.cmd` was written — but the emulation was, until
the run below, the strongest available evidence rather than direct proof.

**Confirmed by CI — the run went green.**

| Run | Commit | Result |
| --- | --- | --- |
| 35195500738 | `5d04b2c` | **success — all 5 jobs** |

```
success  install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)
success  install · typecheck · test · build · benchmark-smoke · audit (windows-latest)
success  coverage gate (ubuntu)
success  offline cold-start (ubuntu)
success  release attestation (P38-12)
```

This is the first fully green run since `20f01b9` (R88), and it is the run that
retires the emulation caveat: `ubuntu-latest` has a genuine case-sensitive
filesystem, and the three jobs that were red at `fd6a5f5` are green at `5d04b2c`.
It also independently confirms the two claims that rested on local measurement —
that `coverage gate` was red because of a failing test rather than a threshold
dip, and that `offline cold-start`'s `Linux oracle` step passes once the
case-folding dependency is removed.

**The pattern across all three red runs.** F7, F8 and F9 share one shape: the
local environment was not the CI environment, and the difference was invisible
from Windows. F7 needed a *shallow* clone, F8 a *non-Windows* platform, F9 a
*case-sensitive* filesystem. None could be found by running the suite harder on
the machine that wrote it; what found them was reading the failing job list and
asking what each job does that the local run does not.

## 8. Enforcement status — the honest gap
The gate is implemented and its refusals are **proven** offline (§6). It is,
however, **not yet wired into the generic `agent benchmark` path**. The three
environment variables are therefore currently a convention enforced by the R92
campaign driver, which does not exist yet and will be written only after
authorization. This is stated plainly rather than papered over, because claiming a
limit in prose is exactly what line 211 forbids. **The paid A/B must be launched
through that driver, never through a bare `agent benchmark` invocation.**

The same obligation covers the campaign-wide cap: it is runtime-enforced only
because one invocation is declared to own the whole frozen list. If the driver
fans out per case, the global cap degrades to per-case and the plan must be
**regenerated** rather than quietly reinterpreted.

## 9. What has NOT been done

- No real provider request. No score. No pass-rate claim of any kind.
- The 86 paid cases were not re-run, and holdout cases were not consumed.
- The paid A/B was not executed — it is unauthorized.
- Even if the small A/B later succeeds, no automatic full 86-case re-run and no
  further holdout consumption is authorized by this plan.
- No historical evidence file was modified.

CI all-green, synthetic mechanism improvement and real task pass-rate improvement
are three different claims and are not conflated here.

## 10. Approval materials

Produced by `node scripts/e4/r92-authorization-request.mjs` into `.ci/r92-auth/`:

| Item | Value |
| --- | --- |
| Plan digest (approve this exact value) | `ffe3bea77e27283917847536a08d351e33f26d2ac0773b59fc590926868970f1` |
| Expires | `2026-10-16T08:27:46.000Z` |
| Baseline SHA | `e9776ba66190ea63b1bacb685c91aa900b6935e7` |
| Candidate SHA | `a20373743b56de6a3a110fecdd254737ece71afa` |
| Case list | 8 non-holdout dev-set cases (R87-frozen order, §4) |
| Selection digest | `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae` |
| Endpoint identity | `ee071e382ae11baecc06ca51545a6d4f3fa74cb3ea12b605d63d0b19ae84fea7` (normalized digest, never a raw URL) |
| Call cap | 320 campaign-wide, runtime-enforced |
| Time cap | 600 000 ms per case, runtime-enforced |
| Token cap | **none declared** — no runtime token layer exists |
| Cost-unknown items | USD total; token total; provider-side rate/spend limits |
| Output location | `.ci/r92-ab` |

To authorize, the run requires `E4_R92_PAID_AUTH=1`, `RUN_PAID_BENCHMARKS=1` and
`E4_R92_PAID_AUTH_DIGEST=<the digest above>` — plus a human decision on this plan.
