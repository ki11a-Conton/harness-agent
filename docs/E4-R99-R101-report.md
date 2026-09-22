# E4-R99 / R100 / R101 — report

Scope: plan `plan(20260919-091015).md`, tasks **R99** (the driver must really
execute the two harnesses' cases, tools and verifiers), **R100** (re-observe
identity at the execution boundary), **R101** (run the real closed loop on a
clean CI runner and close the round).

Baseline SHA when this work started: `d5af97493319bdf349ca54cc49bef855809bc3ce`.
Every claim below is either a command whose output is quoted, or an explicit
`NOT_RUN` / `BLOCKED`. Nothing in this report is inferred from a green suite.

---

## 0. The finding that dominates this round

**R99's arm worker could not execute a single case.** The module existed and was
syntactically valid, but three independent defects each made every unit refuse
before dispatch. They were found by *running* it, not by reading it.

### 0.1 RED — the reproducer

```
$ node .ci/r99-probe/probe.mjs .ci/r99-probe        # runArmUnit against the repo's own build
APPROVED planDigest = 3540d4b91b482d4865b444245be10272b3c1938065b7ee1181f54e22ef09b272
STATUS failed | CATEGORY provider | verifierPassed undefined
DETAIL E4-R98: the arm's CLI exited 1: agent benchmark: RUN_PAID_BENCHMARKS=1 is required for an external billed provider — an API key alone is not authorization
```

Three distinct causes, in the order they surfaced:

1. **`dispatchArgs` never passed `--plan-digest`.** The CLI's `--provider openai`
   makes a plan `external-billed` from the *planned identity*
   (`billingClassForProvider(providerId, providerId !== STUB_PROVIDER_ID)`), not
   from key presence — so the paid guard applies even on the keyless stub path.
   The worker computed the digest from the child's own dry run and then simply
   never passed it. Measured CLI refusal:
   `a paid (external-billed) run must pass --plan-digest <digest> from a prior --dry-run`.
2. **`opts.planDigest` was used for two different digests.** The build-binding
   comparison `computedPlanDigest !== opts.planDigest` compared the arm CLI's
   *execution-plan* digest against the R97 *authorization-envelope* digest. These
   are different kinds of value. Measured: the envelope digest and
   `authorization.arms[arm].executionPlanDigest` are never equal.
3. **Even against the right kind, the granularity is wrong.** The approved
   `executionPlanDigest` covers the **full frozen case set (8 cases)**, while a
   unit stages **one** case, and the CLI's digest binds the case set. Measured:

   ```
   1 case : 382dcf311d65e6dacd4df49c0152def75a2f930fbb25813cdd9ce34681dd0263  runs=1
   2 cases: 6a79cd3e3d8705ccf2720c359a6f6fc7402fbb6e6470dfe142ccb5b306bfd1bc  runs=2
   DIFFERENT -> case set IS bound in planDigest
   ```

   So a per-case dry run can never reproduce a full-set digest. This was a
   design error in the module, not a typo.

### 0.2 GREEN — after the fix

```
$ node .ci/r99-verify/v.mjs .ci/r99-verify
STATUS failed | CAT verifierPassed false
DETAIL case did not pass: model_error (verification_passed=false)
```

The verdict text is now **report-derived**: `verification_passed=` is built only
by `classifyReport` from a parsed `baseline.json`. A unit that never dispatched
cannot produce it. The case really ran through the arm's own built CLI, its own
tool loop and its own verifier.

### 0.3 What was fixed, precisely

| Defect | Fix | Where |
|---|---|---|
| `--plan-digest` never passed | pass the digest the child's own dry run computed, over the same staged cases and the same `--out` | `r97-arm-worker.mjs` `dispatchArgs` |
| envelope digest used as build binding | compare the arm's approved **`sourceSha`** against the observed checkout HEAD, before any child exists | `r97-arm-worker.mjs` `runArmUnit` |
| `consumedFor(category)` charged 1 for every category | commit the **measured** `consumed`, set to 1 only after the dispatch child actually starts | `r97-arm-worker.mjs` STEP 5 |
| keyless child died on the paid guard | `childEnvironment()` deletes `OPENAI_API_KEY` **and** sets `RUN_PAID_BENCHMARKS=1`, so the transport is provably the stub while the same code path runs; `allowRealProvider` is the explicit opt-in | `r97-arm-worker.mjs` |
| header limitation (b) claimed `--plan-digest` was impossible | corrected: the CLI exempts `--dry-run` and requires the digest for the real billed execution, which is exactly what the worker performs | `r97-arm-worker.mjs` header |

The third row is a **budget** correctness fix, and it is testable: a unit refused
on a build mismatch now leaves **no ledger file at all**.

```
MISMATCH -> failed | harness | E4-R98: this checkout's HEAD is d5af974… but the approval binds arm candidate to 0000…
NO LEDGER -> build mismatch touched zero budget (correct)
```

---

## 1. R99 — the driver really executes both harnesses

### 1.1 Status: DONE (offline), NOT_RUN (paid)

### 1.2 What was built

`scripts/e4/r97-arm-worker.mjs` (already present, now correct and tested) plus a
new driver mode that routes units through it.

**The split is the plan's own** (§R99 怎么做): "父 driver 排序/预算/授权/持久化，
arm worker 在对应 checkout 的构建里执行 case."

- `runDriver({ …, armWorker })` — when `armWorker` is supplied the driver enters
  **arm-worker mode**: it constructs **no provider at all**
  (`makeProvider` is never called; the probe passes a `makeProvider` that throws
  and the run succeeds), and each unit is executed by that arm's own built CLI.
- The worker performs the *same* ordered protocol against the *same* ledger and
  execution-state directories (reserve → begin → dispatch → commit → terminal
  write), so the driver does **not** also reserve: doing both would charge one
  case twice.

### 1.3 Acceptance evidence (measured, offline)

Real observations from two **genuinely distinct historical checkouts**, built for
this report:

```
$ git worktree add --detach D:\r97-arm-baseline  e9776ba66190ea63b1bacb685c91aa900b6935e7
$ git worktree add --detach D:\r97-arm-candidate a20373743b56de6a3a110fecdd254737ece71afa
$ (cd D:\r97-arm-baseline  && pnpm install && pnpm build)   # main.js exists: True
$ (cd D:\r97-arm-candidate && pnpm install && pnpm build)   # main.js exists: True
$ git -C D:\r97-arm-baseline status --porcelain     # (empty) CLEAN
$ git -C D:\r97-arm-candidate status --porcelain    # (empty) CLEAN
```

Full two-arm campaign in arm-worker mode:

```
observed baseline: e9776ba66190ea63b1bacb685c91aa900b6935e7 candidate: a20373743b56de6a3a110fecdd254737ece71afa
plan: FINALIZED_AUTHORIZATION_PLAN issues: []
STATUS: PARTIAL | CODE: CASE_FAILURES | MODE: arm-worker
workerUnits: 16 | consumed: 16 | verifiedPasses: 0
suitesPresent: ["regression","stress"] | execObs ok: true
categories: {"provider":16}
sample detail: case did not pass: model_error (verification_passed=false)
```

Reading this honestly:

- **16 units** = 8 frozen cases × 2 arms. Every unit really executed inside its
  own arm's build and produced a report-derived verdict.
- `categories: {"provider": 16}` means all 16 hit the **stub's `MODEL_ERROR`**.
  That is the expected offline outcome, not a defect: `--provider` accepts only
  `openai` and the stub is selected by the *absence* of a key. The offline path
  **cannot** produce a pass; see §1.6.
- `verifiedPasses: 0` is therefore correct and is **not** a pass rate claim.
- `suitesPresent: ["regression","stress"]` — the mixed frozen list keeps its true
  suites instead of being relabelled under the CLI's single-valued `--suite`.

### 1.4 Resume — zero new calls (measured)

A second run of the identical campaign:

```
STATUS: COMPLETE | CODE: null | MODE: arm-worker
workerUnits: 0 | consumed: 0 | verifiedPasses: 0
suitesPresent: ["regression","stress"] | execObs ok: true
```

**0 units re-executed, 0 logical calls consumed.** This is the R98 F2 resume
contract holding through the new execution path.

### 1.5 The contract test

`packages/evaluation/src/r97-arm-worker-contract.test.ts` — **28 tests at the time
this section was written; 37 today**, all
passing, driving the real module (never a mock):

> **CORRECTED:** the file has grown from 28 to **37** tests as T4/T6 added the
> identity, missing-case and evidence-survival cases. Re-derived from
> `.ci/r97-r98-fresh/r97-r98.json` during the §7.21 pass. The 28 below describes the
> state this section was written against and is kept as measured then.

- the two real-execution tests assert report-derived verdict text, durable
  ledger entries and durable execution-state records;
- `TWO DIFFERENT CASES each enter their OWN context` proves the two R98 fixtures
  stage from their own directories, produce **different** `resultHash` values,
  and are each charged exactly once — the fixed `content: "r97"` placeholder
  cannot satisfy this;
- negative controls: no `--plan-digest` when none was supplied, an empty digest
  is not emitted as a flag value, a wrong approved SHA refuses **before**
  dispatch, and a missing case directory is never substituted.

### 1.6 Honest limits (unchanged and newly measured)

> **CORRECTED IN E4-R101-A (T6) — see §7.4.** Item 1 below was written against the
> child-CLI dispatch and is **false** of the seam T6 adopted: injecting a scripted
> provider through each arm's own `runBenchmarkCommand(argv, providerOverride)`
> produces a real verified PASS offline (measured 6/16, all `weak`). The text is
> kept as written so the change of belief is visible, and the corrected reading is
> in §7.4.

1. **No verified PASS is reachable offline.** The stub yields `MODEL_ERROR` for
   every case, so every offline unit ends `provider`/`case_failed` with
   `verifierPassed === false`. Proving "the verifier passes a real tool write"
   requires the billed provider. Plan §R99: "不为本任务调用实际付费模型." The
   suite proves **execution and verification**, not success.
2. **One reservation per unit is a promise, not a measurement.** The worker
   reserves 1 logical call per unit; the child's real per-case consumption is
   visible in its report (`model_calls`) but is not reconciled against the
   ledger. §R98 forbids assuming one call per case, and this is the remaining gap.

   > **PARTLY SUPERSEDED — re-measured in §8.10.** The first sentence is now FALSE
   > of the ledger: the worker still takes ONE reservation up front for the
   > `running` record, but the budget channel takes one per REAL call, so the
   > ledger is a measurement rather than a promise. The second sentence survives
   > only at PER-CASE granularity, and for a different reason than stated here.
3. **`resultHash` digests `arm|case|verdict|detail`**, not a per-case artifact
   hash. An artifact-level hash is not implemented.
4. **Two arms on one revision would be refused.** `ARMS_NOT_DISTINCT` in
   `r97-plan.ts` correctly refuses a same-SHA A/B, so a single-revision "A/B" is
   unrepresentable rather than mislabelled.

---

## 2. R100 — re-observe identity at the execution boundary

### 2.1 Status: DONE

### 2.2 What was wired

`runDriver` now **calls `checkExecutionObservationV1`** on the authorized path,
after the R92 gate and **before `makeProvider`**. The observation it checks is
built from the caller's independent `observation` plus two values the driver
derives **for itself**:

- `driverBuildDigest` — recomputed via `computeDriverBuildDigestV1` over
  `R97_DRIVER_ARTIFACTS`, **never** read back from the plan (reading it back
  would compare the plan against itself);
- `expandedPlanDigest` — `computeR92AuthorizationDigestV1(envelope)` as expanded
  **now**.

`plan.planObservation` is never read, so the F5 failure mode is unrepresentable.

**Ordering is deliberate.** The check runs *after* the R92 gate so the gate's
established codes (`IDENTITY_DRIFT`, `AUTHORIZATION_*`) keep their meaning, and
the new codes (`EXEC_OBS_DRIVER_BUILD_DRIFT`, `EXEC_OBS_PLAN_DIGEST_MISMATCH`)
add only what the gate does not cover. Ordering it first would have relabelled
every existing gate refusal — a vocabulary change masquerading as a new check.
This was measured: the first attempt failed 7 tests exactly that way.

### 2.3 The silent fallback is gone

`fingerprintCaseInCheckout` previously did:

```js
await loadBenchmarkCase(join(armDir, …)).catch(() => loadBenchmarkCase(join(repoRoot, …)))
```

so a case **missing from an arm** was silently fingerprinted from the **driver's
own tree** — and because both arms would fall back to the *same* tree, the two
"independent" observations could agree by construction. That is the "one harness
run twice" failure this whole round exists to remove.

Now it throws a named `NOT_READY` refusal quoting the arm directory. It is
**exported** so the rule is tested directly, and the test is a genuine control:
the victim case is asserted **absent from the arm** and **present in the repo**,
so the old fallback demonstrably had something to find.

### 2.4 The suite inventory is consumed

The driver reads `authorization.caseInventory` and uses each case's **true**
suite (never re-derived from the case id's prefix). `result.suiteInventory` and
`result.suitesPresent` are reported, and the measured campaign shows
`["regression","stress"]` — a mixed-suite run is visible *as mixed*.

### 2.5 Run completeness vs task pass rate are separate fields

Per §R99 做什么 5 and §R99 怎么验收 ("COMPLETE 表示预定单位都有终态，passed/failed
表示验证结果"):

- `completedUnits` / `workerUnits` — how many units reached a terminal state;
- `measuredUnits` — units that reached a **verifier verdict** (pass or fail);
- `verifiedPasses` — units the verifier **passed**.

These were computed only on the COMPLETE path at first, so a PARTIAL run reported
`verifiedPasses: undefined` — indistinguishable from "not measured". Measured and
fixed: they are now computed **before** the exit-path branches, so every outcome
reports them.

### 2.6 R100 tests

Four new tests in `r97-driver-closed-loop.test.ts`:

- the execution-boundary check **runs** on the authorized path and reports
  `ok: true` with no codes;
- a **driver-build change** is refused — the test re-signs the envelope
  (`computeR92AuthorizationDigestV1`) so the forged `driverBuildDigest` is the
  *only* drift, otherwise the R92 gate refuses first and the test would pass for
  the wrong reason. This is asserted as
  `codes: ["EXEC_OBS_DRIVER_BUILD_DRIFT"]`, not as a loose regex;
- a **tampered envelope relabelled at the top level** is refused;
- the **suite inventory** matches the approved envelope case for case.

---

## 3. R101 — the closed loop on a clean runner

### 3.1 Status: DONE for the offline closed loop — CI ran and is green (§3.5); paid experiment NOT_RUN (§3.4)

CI has now really executed, on GitHub's ubuntu runners, and its failures drove
the fixes — the first two runs and what each one proved:

| run | head | outcome | what it proved / fix |
|---|---|---|---|
| [35482804955](https://github.com/ki11a-Conton/harness-agent/actions/runs/35482804955) | `6113675` | **FAILURE** (3 jobs) | (a) `r97-r98-closed-loop` failed the R99 `--plan-digest` assertion on a **green** suite — the default vitest reporter never prints a fast test's own line, so a name-based `grep ✓` can fail even when the test passed; (b) main test + coverage jobs failed — the D6 precondition test (F7: missing arms = explicit FAILURE) fails on any runner without the arm checkouts, and the general `pnpm test` has none; (c) `P14-6` security scan flagged `.catch(() => {})` in `r97-budget-ledger.ts` |
| [35486451101](https://github.com/ki11a-Conton/harness-agent/actions/runs/35486451101) | `7aa8b72` | **FAILURE** (only the closed-loop job) | main test (win+ubuntu), coverage gate and cold-start all **green** — the verbose-reporter fix, the D6 file exclusion and the P14-6 fix hold on a clean runner. The closed-loop KEY-tests step then failed its driver-file count: `grep -cF "✓ packages/evaluation/src/…"` counted 0 on ubuntu while the name-based greps in the same step matched — the verbose lines carry the file path in a form the exact pattern did not assume (relative vs absolute). Counts now go through "lines mentioning the file name that carry `✓`/`↓`", with a diagnostic dump on any shortfall |
| [35487313801](https://github.com/ki11a-Conton/harness-agent/actions/runs/35487313801) | `1ed8b92` | **SUCCESS — all six jobs green** | the whole workflow is green on a clean runner: main test suite (win+ubuntu), coverage gate, cold-start, and the closed-loop job with every assertion step passing (R99 arm-worker execution, KEY-tests count 45/0, D6 two-arm observation, G5 cross-process contention, evidence recorded and uploaded) |

### 3.2 The author-machine dependency is removed

The D6 acceptance path was gated by `it.skipIf(!haveArms)` on hard-coded
`D:/r97-arm-*` paths. Two independent defects:

1. the paths were **author-private** — unreachable on any runner;
2. a missing arm produced a **green skip**, so a runner with no arms reported
   success for a path it never executed.

Now:

- directories come from `R97_ARM_BASELINE_DIR` / `R97_ARM_CANDIDATE_DIR`, which
  the CI job publishes into `$GITHUB_ENV`;
- **the skip is gone.** A separate test asserts the precondition, so a missing
  arm is an explicit **failure** carrying the exact paths it looked in and how to
  satisfy them.

Measured both directions:

```
# arms present (built above):
✓ both arms are observed by the real CLI dry-run and the plan FINALIZES
  Test Files  1 passed (1)   Tests  2 passed | 37 skipped (39)     # -t D6

# arms absent:
FAIL  the two real arm builds MUST exist — a missing arm is a FAILURE, never a skip
- Expected: true
+ Received: false
  Test Files  1 failed (1)  Tests  1 failed | 38 skipped (39)  [exit code: 1]
```

### 3.3 CI job changes

`.github/workflows/ci.yml`, job `r97-r98-closed-loop` (as finally fixed):

- the suite step runs the seven R97/R98 files with `--reporter=verbose`, because
  the default reporter only prints a *slow* passing test's own line — measured
  on run 35482804955 when the fast `--plan-digest` test was invisible to a
  name-based grep even though the suite was green;
- assertion steps match test lines by **name + `✓` marker** (skipped lines carry
  `↓`, failed lines `×`, so neither can satisfy a `✓` check), never by an exact
  path prefix — measured on run 35486451101 when an exact
  `✓ packages/evaluation/src/…` count was 0 on ubuntu while name greps matched;
  any count shortfall dumps the first matching log lines;
- the arms-gated file `r97-driver-closed-loop.test.ts` is **excluded from the
  general `pnpm test` / `pnpm test:coverage`** (same `--exclude` mechanism
  already used for perf/soak/forensics) and runs for real only in this job,
  which builds both arms at their frozen SHAs — a general test run without arms
  must not fail on a precondition the general job cannot satisfy, and F7 still
  forbids a silent skip where the arms ARE the point;
- a new step asserts the **arm-worker execution tests passed** by name —
  including the `--plan-digest` dispatch assertion, so the P0 regression above
  cannot return green;
- the "not skipped" gate counts `✓`-carrying lines mentioning each file name;
  `EXPECTED_MIN` is 36 against a measured **45** declared `it(` blocks.

`ci.yml` remains structurally validated only (job-name extraction, **0 tab
characters**, manual inspection) because `js-yaml` is not a dependency of this
repo.

### 3.4 The paid experiment remains NOT_RUN

The user's LLM gateway (`http://127.0.0.1:3006/v1`) rejects every chat completion
with HTTP 429 / `upstream_status: 400`. R98–R101 require **zero external model
calls**, so they are unaffected — but no paid two-version experiment can be run
against that gateway, and none was attempted. `OFFLINE_ACCEPTED` is kept distinct
from "the experiment executed".

### 3.5 Final verdict

**Run [35487313801](https://github.com/ki11a-Conton/harness-agent/actions/runs/35487313801)
(head `1ed8b92`): SUCCESS — all six jobs green on a clean runner.**

- `install · typecheck · test · build · benchmark-smoke · audit`
  (ubuntu-latest **and** windows-latest): **success** — the general suite is
  green on both platforms with the arms-gated driver file excluded from it;
- `coverage gate (ubuntu)`: **success** — all eight per-package threshold gates
  hold (matches the local packages-only coverage run, exit 0);
- `offline cold-start (ubuntu)`: **success**;
- `r97-r98 closed loop (ubuntu)`: **success** — the two arm checkouts were
  built at their frozen historical SHAs on the runner, all seven R97/R98 files
  executed with `--reporter=verbose`, and every assertion step passed: R99
  arm-worker real execution (report-derived verdict + two distinct case
  contexts), the `--plan-digest` dispatch pin, the driver file count
  (45 executed / 0 skipped ≥ 36), the D6 two-arm observation path, the G5
  cross-process budget contention tests, and the evidence record/upload;
- `release attestation (P38-12)`: **success** (it only runs when the dependent
  jobs are green).

Scope of this green, stated: it proves the **offline** two-checkout closed loop
runs and is verified on a clean CI runner — R101's acceptance
("Windows/Ubuntu required integration job真跑两臂路径且成功"). It does **not**
prove the paid two-version experiment ran (see §3.4).

> **CORRECTED IN E4-R101-A (T6):** the sentence that followed here said "no case
> PASSED its verification offline (the stub provider yields `MODEL_ERROR`)". That
> was true of the child-CLI dispatch described in this section, and is **false** of
> the seam T6 adopted, which produces real verified passes offline. See §7.4 for
> the measurement (`6/16`, all `weak`) and for why that is still not a model-quality
> claim. This section's description of the CI job is also superseded by §7.3: the
> job is now a Windows+Ubuntu matrix running one cross-platform Node command, with
> the bash steps removed.

---

## 4. Verification commands and results

All commands run on Windows (pwsh), Node v24.18.1, with `OPENAI_API_KEY` unset
and `RUN_PAID_BENCHMARKS` unset in the parent shell.

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `npx vitest run` (7 R97–R99 files) | **220 passed / 220**, 0 skipped |
| `npx vitest run apps/cli/src/audit.benchmark-profile.test.ts` | 11 passed (frozen counts intact) |
| `node apps/cli/dist/main.js docs:verify` | ALL CHECKS PASS (exit 0) |
| `node --check scripts/e4/r97-arm-worker.mjs` | exit 0 |
| `node --check scripts/e4/r97-campaign-driver.mjs` | exit 0 |
| `node --check scripts/e4/r97-observe-arms.mjs` | exit 0 |
| `node scripts/e4/r97-observe-arms.mjs --root <fresh temp dir>` | exit 0, both arms built and clean |
| `vitest run --reporter=verbose` (7 R97–R99 files, bash `tee`) | **220 passed / 220**, 0 skipped |
| closed-loop assertion replica over that verbose log | ALL CLOSED-LOOP ASSERTIONS PASSED (driver 45 executed / 0 skipped, D6 + G5 present) |
| `vitest run packages/security/src/no-silent-catch.test.ts packages/evaluation/src/r97-budget-ledger.test.ts` | 54 passed (P14-6 fix holds) |
| `vitest run --exclude '**/r97-driver-closed-loop.test.ts' packages/evaluation` with `R97_ARM_*_DIR` → nonexistent | 97 files / 1452 passed, exit 0 (a fresh runner's main-suite view) |
| `vitest run --coverage` over `packages/**` with the same exclude | exit 0 — all 8 per-package threshold gates hold |

### 4.1 E4-R101-A (T6) — the final integration block, re-run

Run on Windows (pwsh), Node v24.18.1, `OPENAI_API_KEY` and `RUN_PAID_BENCHMARKS`
unset, with `R97_ARM_BASELINE_DIR`/`R97_ARM_CANDIDATE_DIR` pointed at the two real
arm builds at `D:\r101-arms-local\{baseline,candidate}`.

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | **6759 passed / 6768**, 3 skipped, **6 failed** — all 6 in three files that require a CLEAN COMMITTED TREE (§4.2) |
| `pnpm test:coverage` | same 6 failures; **with those three files excluded the thresholds all hold: 359 files / 6604 passed, exit 0** |
| `pnpm test:security` | **2135 passed / 2135**, exit 0 |
| `pnpm docs:verify` | `ALL CHECKS PASS`, exit 0 |
| `vitest run --reporter=verbose` over the plan's 7 named files | **253 passed / 253**, 7 files, 0 skipped |
| `node scripts/e4/r97-closed-loop.mjs --all --arms-root D:/r101-arms-local` | **5/5 phases OK** — setup, acceptance `OFFLINE_ACCEPTED 6/16`, suite **448/448**, matrix **9/9**, identity |
| `node scripts/e4/r97-mutation-check.mjs` | **5/5 mutations CAUGHT**, every file restored and re-hashed |

### 4.2 The 6 failures are a DIRTY-TREE guard, not a defect — measured

The three files (`e4-09-production-e2e`, `e4-r55-failure-wiring`,
`benchmark-command`) all assert that the production benchmark refuses a
promotion-eligible run on a tree whose `git status --porcelain` is non-empty. This
was proven rather than assumed, in three steps:

1. **They pass on a clean tree.** A detached worktree at `HEAD` (`e491258`) with
   none of the T6 changes present: `e4-09` **5/5 passed**, `e4-r55` **63 passed /
   2 skipped**, `benchmark-command` **93/93 passed**.
2. **Dirtiness alone reproduces them.** In that same clean worktree, adding ONE
   unrelated untracked file (none of the T6 changes present) reproduced **exactly**
   the same `e4-09` failures (`4 failed | 1 passed`).
3. **The pre-existing deletion alone reproduces them.** In the clean worktree,
   deleting only `plan(20260917-001821).md` — the user's own pre-existing ` D`,
   untouched by this round — reproduced the same `4 failed | 1 passed`.

The R55 guard names its own cause, listing all 17 dirty entries, every one of which
is either this round's T6 work or the user's pre-existing plan deletion:

```
E4-R55 requires a CLEAN committed working tree: the production benchmark refuses to
produce a promotion-eligible run on a tree that is not provably clean, so every child
case would fail for an unrelated reason. Commit or stash first.
dirty entries (17): M .github/workflows/ci.yml … D plan(20260917-001821).md …
```

**Consequence, stated precisely — committing this round's work is NOT sufficient.**
The guard reads `git status --porcelain` (line 1261), so it stays red as long as ANY
entry is dirty. The user's ` D plan(20260917-001821).md` is such an entry, and it
predates this round: step 3 above shows that deleting **only** that file in an
otherwise clean tree reproduces the same `4 failed | 1 passed`. Clearing these 6
therefore requires the user's own deletion to be resolved (committed, restored, or
stashed) — which plan §0 forbids this round from doing — **in addition** to committing
the T6 work.

So the claim is scoped, and the scope matters: **the 6 failures are pre-existing
clean-tree guards; they are not caused by, and cannot be cleared by, the T6 code
alone; and every other test in the repository passes.** No attempt was made to make
them pass by weakening the guard, which exists to stop a promotion-eligible run being
produced on an unprovable tree.

### 4.3 A measurement error worth recording

An ad-hoc `vitest run --coverage` of my own (without the repo's `--exclude` list)
reported a **fourth** failing file, `e4-r40-forensics.test.ts`. That file is
**excluded from both `test` and `test:coverage` by `package.json`** and fails
whenever it is run directly — in the clean worktree too. The "extra failure" was
an artifact of bypassing the repo's own test selection, not a finding. Recorded
because a command that reports MORE failures than the project's own gate is
measuring the wrong thing.

Per-file counts: `r97-budget-ledger` 50, `r97-execution-state` 22,
`r97-plan` **55**, `r97-driver-closed-loop` **45** (0 skipped, includes the real
D6 path), `r97-arm-worker-contract` **28**, `r97-redaction` 12,
`r98-fixture-cases` 8.

> **UPDATED IN E4-R101-A (T6):** the seven files above now report **257** tests, and
> the closed-loop suite covers **19** R97–R101 files / **464** tests. The counts in
> this paragraph describe the R99–R101 state and are left as measured then.
>
> Re-derived from `.ci/r97-r98-fresh/r97-r98.json` during the §7.21 pass, per file:
> `r97-arm-worker-contract` **37**, `r97-budget-ledger` 50, `r97-driver-closed-loop`
> **67**, `r97-execution-state` **27**, `r97-plan` **56**, `r97-redaction` 12,
> `r98-fixture-cases` 8 — sum **257**. The 253/448 in the paragraph above was an
> intermediate figure from before §7.17's four CI-defect tests were added.

**External provider requests: 0.** No test sets `OPENAI_API_KEY`; the arm worker
deletes it from every child environment it builds.

### 4.4 Historical data changes

None. No prior report, SHA or measured figure was overwritten. The R97 report's
errata section stands as written; this document adds to it rather than revising it.
The T6 errata in §7.4/§7.5 **keep** the superseded text and mark it as superseded,
rather than deleting it — a corrected claim whose original is invisible cannot be
audited.

---

## 5. Task feedback in the plan's required structure

```text
任务：R99
状态：DONE（离线执行链路）/ NOT_RUN（付费双版本实验）
起始SHA：d5af97493319bdf349ca54cc49bef855809bc3ce
修复的发现：F1 占位执行；arm worker 三处 P0（--plan-digest 缺失、两种 digest 混用、
            逐例粒度与全集 digest 不可比），以及 consumedFor 虚计预算
RED复现命令及关键失败：runArmUnit 对仓库自身构建
            -> "the arm's CLI exited 1: … must pass --plan-digest"（未执行任何案例）
GREEN命令及结果：同上 -> "case did not pass: model_error (verification_passed=false)"
            （判定来自真实 baseline.json）；双真实历史臂 16 单元全部执行，
            16 调用计入共享预算；resume 再跑 0 单元 0 调用
实际执行环境：Windows / Node v24.18.1 / 两臂 worktree e9776ba + a203737 各自构建
CI run URL / head SHA：https://github.com/ki11a-Conton/harness-agent/actions/runs/35486451101 （7aa8b72，
              closed-loop 的 R99 断言步骤通过）；本地 bash-tee 复刻 220/220 全绿
外部provider请求：0
历史数据变化：无
剩余限制：离线 stub 无法产生 pass；逐例多轮调用未与账本对账；
            resultHash 不是逐例产物 hash
【T6 更正，2026-09-20】本行"离线 stub 无法产生 pass"已被证伪，见 §7.4：
            用 §0.4 的 `runBenchmarkCommand(argv, providerOverride)` 注入
            ScriptedModelProvider 可离线产生真实 verifier pass（实测 6/16，
            全为 weak）。但**"已有 keyless MODEL_ERROR 冒烟"不等于"成功工具链
            验收"**：MODEL_ERROR 只证明进程起来并撞上了 stub，不证明模型请求、
            工具循环与 verifier 真的跑通；后者才是 T6 的验收对象。同时，
            离线 pass 也不能被读作"模型解出 6 例"——provider 由本仓库编写，
            故 `modelCapabilityClaim: "none"`、`promotable: false`。
```

```text
任务：R100
状态：DONE
起始SHA：d5af97493319bdf349ca54cc49bef855809bc3ce
修复的发现：F5 —— driver 未调用 checkExecutionObservationV1；driver 自身 build
            digest 未比较；fingerprintCaseInCheckout 存在静默 fallback；
            suite inventory 未被报告消费；verifiedPasses 在 PARTIAL 路径为 undefined
RED复现命令及关键失败：移除 fallback 前，缺失 arm 案例会回退到 driver 副本并产生指纹；
            首次把新检查放在 R92 gate 之前 -> 7 个既有 refusal 测试失败（code 被改名）
GREEN命令及结果：r97-driver-closed-loop 45 passed / 0 skipped，含 4 个新 R100 用例
            （execObs ok、driver build drift、顶层 relabel、suite inventory）
实际执行环境：Windows / Node v24.18.1
CI run URL / head SHA：https://github.com/ki11a-Conton/harness-agent/actions/runs/35486451101 （7aa8b72，
              主测试 win+ubuntu 与 coverage gate 全绿；R100 用例随 closed-loop job 全文件执行）
外部provider请求：0
历史数据变化：无
剩余限制：CI 未运行；js-yaml 缺失导致 ci.yml 只能结构性校验
```

```text
任务：R101
状态：DONE（离线闭环，CI 已真跑并修复至 green，见 §3.5）/ NOT_RUN（付费双版本实验）
起始SHA：d5af97493319bdf349ca54cc49bef855809bc3ce
修复的发现：F7 —— D6 依赖作者私有 D:/r97-arm-* 且缺失时静默 skip；
            CI job 未运行 arm worker 契约测试
RED复现命令及关键失败：R97_ARM_*_DIR 指向不存在目录
            -> "FAIL the two real arm builds MUST exist"（旧行为为 skip=绿）
GREEN命令及结果：真实两臂构建存在时 D6 两个用例通过；ci.yml 新增断言步骤
实际执行环境：Windows / Node v24.18.1（CI：ubuntu-latest 的 closed-loop job）
CI run URL / head SHA：https://github.com/ki11a-Conton/harness-agent/actions/runs/35487313801 （1ed8b92，
              全 workflow SUCCESS，closed-loop job 全部断言步骤通过，含双臂真实构建）
外部provider请求：0
历史数据变化：无
剩余限制：付费授权缺失，最终状态为 OFFLINE_ACCEPTED / NOT_RUN（CI 已真跑全绿，见 §3.5）
```

```text
任务：E4-R101-A（T1–T6 收尾）
状态：DONE（六个任务全部实现且离线验收全绿）/ NOT_RUN（付费双版本实验，未被请求）
起始 SHA / 实现 SHA：e491258443081d10ed92fe3a8016970b47b3406d（本轮起点）/
            ff1d882（本轮实现提交，E4-R101-A T6）
            注：报告随后有一次仅修文本的提交（把本行 SHA 从 amend 前的 168c2b7 更正为
            ff1d882）。按计划要求，不为追求"最终 SHA == 报告 SHA"而继续制造纯文档提交；
            实现提交可用 `git log --oneline -2` 复核
对应发现：N1、N3、N4、N5、N6、N7、N8、N9（另在写本节时新发现 §7.7 的冗余 prepare）
RED：① node scripts/e4/r97-offline-acceptance.mjs --all
        预期：离线闭环通过；实际："driver status: PARTIAL / CASE_FAILURES …
        10 of 16 unit(s) measured nothing; 20 logical call(s) consumed"
        ——五例"仅命令型"案例被抛成 infrastructure，从未到达自己的 verifier
    ② 同一运行预期 verifiedPasses 为 6；实际 12（历史与本次被求和而非取并集）
    ③ node scripts/e4/r97-mutation-check.mjs
        预期：五个变异全部被测试捕获；实际：固定 request=r97 未被捕获
        ——seam 测试只断言脚本形状，未断言文本含自身 caseId
GREEN：node scripts/e4/r97-closed-loop.mjs --all --arms-root D:/r101-arms-local
        退出码 0 —— [1/5] setup OK · [2/5] acceptance OK status=OFFLINE_ACCEPTED
        passes=6/16 · [3/5] suite OK 448/448 · [4/5] matrix OK 9/9 · [5/5] identity OK
       node scripts/e4/r97-mutation-check.mjs 退出码 0 —— 5/5 mutations CAUGHT
       计划 §最终集成命令块 7 文件 退出码 0 —— 253 passed / 253（0 skipped）
       pnpm typecheck / pnpm build / pnpm test:security / pnpm docs:verify 退出码 0
       pnpm test 与 pnpm test:coverage 有 6 项失败，全部是三个要求"干净已提交工作树"
       的既有守卫；§4.2 用干净 worktree 逐步证明（单个无关未跟踪文件即可复现），
       排除这三个文件后 coverage 全部 8 个包阈值通过（359 files / 6604 passed，退出码 0）
provider generate / transport retry / 外部请求次数：generate 42（全部来自本仓库的
            ScriptedModelProvider）/ transport retry 0 / 外部请求 0 / providerRequests 0
持久证据路径与 validator 命令：.ci/r97-r98/{closed-loop-run.json, closed-loop-identity.json,
            r97-r98.json, acceptance-matrix.json, mutation-report.json} 与
            .ci/r97-r98/acceptance/{plan.json, driver-result.json, acceptance-summary.json,
            campaign-summary.json, case-report.json, validator-report.json, ledger/*}
            validator：node scripts/e4/r97-offline-acceptance.mjs --validate
            （实测 [5/6] validate OK，evidence ok true checked 16）
本地环境 / Windows CI / Ubuntu CI：本地 Windows / Node v24.18.1 全绿（上表）。
            CI 侧：job 已改为 ubuntu-latest + windows-latest 矩阵，两平台跑同一条
            跨平台 Node 命令，bash 步骤全部删除——但**本轮尚未在真实 runner 上执行过**，
            故不得声称两平台 CI 已绿（见剩余限制⑤）
CI URL 与 head SHA：本轮尚未推送运行。上一个已核实的运行是
            https://github.com/ki11a-Conton/harness-agent/actions/runs/35487313801 （1ed8b92，
            旧的仅 ubuntu 的 closed-loop job 全绿）；矩阵 job 的本地等价物 5/5 通过
剩余限制：① 离线 pass 全为 weak（strongPasses 0 / weakPasses 6）：TaskVerifier 的
            artifact 规则只查"存在且被 touched"，从不检查内容，故"6 个已验证通过"
            不得读作"解出 6 例"；strong 路径离线只由单测覆盖（两个 R98 fixture 案例
            不在冻结选集内）。
            ② 逐例多轮调用仍未与账本对账（账本记的是每次 generate 的预留，不是与
            arm 报告 model_calls 的逐例对账）。
            ③ resultHash 不是逐例产物 hash。
            ④ 付费双版本实验仍为 NOT_RUN，且未请求用户付费（计划 怎么做 6）。
            ⑤ 矩阵 job 尚未在真实 CI runner 上执行；本轮"两平台"证据是本地 win32
            加一条跨平台命令，不等于两次真实 runner 运行。
            ⑥ 三个要求干净工作树的既有守卫在本地为红；需先提交本轮工作再复跑。
```

---

## 6. Remaining work, stated plainly

1. **CI ran, twice, and is now fixed — the third run's verdict is in §3.5.**
   Run 35482804955 (head `6113675`) proved the R99 `--plan-digest` assertion
   could fail on a green suite (default reporter hides fast tests) and exposed
   the D6-without-arms failure and the P14-6 silent catch; run 35486451101
   (head `7aa8b72`) proved the main suite (win+ubuntu), the coverage gate and
   the cold-start are green and narrowed the remaining closed-loop failure to a
   path-prefix-sensitive count, fixed in `1ed8b92` with a diagnostic dump. The
   final closed-loop verdict — including whether the whole workflow is green —
   is recorded in §3.5.
2. **No verified pass, and no per-case ledger reconciliation** (§1.6).
3. **`R97_DRIVER_ARTIFACTS` did not list the arm worker — FIXED during this
   round.** The driver's build digest covered the driver and three evaluation
   modules but **not** `scripts/e4/r97-arm-worker.mjs`, even though the worker is
   now part of the executor: a rewritten worker could not have invalidated an
   approval, which is exactly the invariant `driverBuildDigest` exists to
   enforce. The artifact was added and a test now pins it
   (`r97-plan.test.ts` 6d), including a negative control that rewrites ONLY the
   worker in a copied artifact tree and asserts the digest moves.

   This was found by writing the honest-limits section of this report, not by a
   failing test — recorded here because the finding is more useful than the fix.

   Consequence, stated: adding an artifact moves every existing
   `driverBuildDigest`, so any plan artifact built before this change is now
   invalid. No committed artifact pinned the old digest (`.ci/` is git-ignored
   and no tracked file carries the value), so nothing in the repository was
   invalidated — but an operator holding a pre-change `plan.json` must rebuild it.

4. **`scripts/e4/r97-observe-arms.mjs` is referenced but was absent.** The D6
   help text tells an operator to run it; it did not exist in the tree. It has
   now been added as a small, committed, cross-platform setup command so the
   instruction is true rather than aspirational.

### 6.1 What is NOT claimed

- That CI was green on the first two attempts. It was not; each failure is
  itemised in §3.1 and §3.5. The green claim, if any, is scoped to the specific
  run recorded there — and the closed-loop job's verdict is only as recent as
  the last run.
- That any case PASSED its verification **by a model**. Offline, the provider is
  scripted (see §7.4 for the correction to this section's earlier form).
- That the paid two-version experiment ran. It did not, and the gateway needed
  for it is broken upstream.
- That the arm worktrees created for this report are reproducible by a single
  committed command on a fresh machine — `r97-observe-arms.mjs` implements that,
  and the CI closed-loop job now rebuilds both arms on a clean runner, but the
  command itself has been exercised only on this machine.

---

## 7. E4-R101-A (T6) — closing the acceptance gaps

Scope: plan `plan(20260920-053219).md`, six closing tasks T1–T6. Plan §0 line 14:
"本轮只做六个收尾任务，不新增通用框架，不安排模型调优或扩大实验规模." Nothing in
this section tunes a model, enlarges the experiment, or adds a framework.

### 7.1 The finding that dominates this round

**The offline closed loop could not accept itself.** Running the real campaign
(`node scripts/e4/r97-offline-acceptance.mjs --all`) against the two real arm
builds produced:

```
driver status: PARTIAL / CASE_FAILURES
reason: "arm baseline case regression/reg-03-add-import failed:
         E4-R98: E4-R98: case regression/reg-03-add-import declares no
         artifact path, so a write script cannot be derived from it
         (10 of 16 unit(s) measured nothing; 20 logical call(s) consumed)"
```

Ten of sixteen units reported **nothing**, and twelve passes were reported over
six passing units. Both are defects in the seam that drives the campaign, not in
the campaign. The plan named the shape of the first one in advance; the second
was found only by running it.

### 7.2 The six tasks, and what each one changed

| Task | The gap | The change | Evidence |
|---|---|---|---|
| **T1** | N1: the worker charged the ledger **one call per unit**, so a ceiling on units was presented as a ceiling on model calls | the worker now drives each arm's own `runBenchmarkCommand(argv, providerOverride)` with a budget-wrapped scripted provider, so **every `generate()` reserves before it can leave** | `logicalCalls 42` for 16 units (not 16); `providerRequests 0`; `r97-budget-ledger.test.ts`, `r97-campaign-lifecycle.test.ts` |
| **T2** | N3: `begin` overwrote a live `running` record; `recoverInFlight` ignored the owner; a retry left `isDone` true | ownership is checked before adoption, and a retry is eligible only via `reconciledForRetry` | `r97-execution-state.test.ts`, `r97-execution-state-ownership.test.ts` |
| **T3** | N4/N5: the driver summary read only this run's new results; `classifyReport` fell back to `results[0]`, treated `success=true` as a pass, and deleted the report in `finally` | strict `findReportRow` (0 → named refusal, >1 → ambiguity refusal); a pass requires the report's own `verification_passed`; the report is persisted | §7.4; `r97-arm-report-evidence.test.ts` |
| **T4** | N6/N7: the driver never passed the approved provider/model/endpoint/input digest to the worker; `armBuildIdentity` missed the modules actually imported | the approved identity is bound to the execution that really ran, and re-observed at the boundary | `r97-execution-identity.test.ts`, `r97-plan.test.ts` |
| **T5** | N8: `runChild` sent only SIGTERM; `SIGKILL_GRACE_MS` was unused; `stdoutChunks.length` was treated as a byte cap | a bounded stop with a real byte cap and a tree kill after the grace period | `r97-bounded-stop.test.ts` |
| **T6** | N9: no arm-worker CLI mode, D6 was dry-run only, the dedicated job was ubuntu-only | the official entry really executes; a Windows+Ubuntu matrix runs the whole offline loop | §7.3 |

### 7.3 The closed loop now runs as one command, on both platforms

`.github/workflows/ci.yml`, job `r97-r98-closed-loop`, is now a **matrix**
(`ubuntu-latest` + `windows-latest`, `fail-fast: false`) and its ~200 lines of
bash setup/build/suite/grep/evidence steps are **gone**. The job runs one
cross-platform Node command:

```
node scripts/e4/r97-closed-loop.mjs --all --out .ci/r97-r98 --arms-root "${{ runner.temp }}/r97-arms"
```

That runner performs five phases and exits non-zero on any of them:

| phase | what it proves |
|---|---|
| `setup` | both arms built at their frozen SHAs and **clean** (`r97-observe-arms.mjs`) |
| `acceptance` | the real campaign through the **official** arm-worker entry, then re-derived by the shipped validator |
| `suite` | 448 tests across 19 R97–R101 files, via `--reporter=verbose --reporter=json` |
| `matrix` | the plan's **9-row acceptance matrix**, evaluated from that JSON report |
| `identity` | a machine-readable statement of what ran and what did not |

Measured locally (Windows, Node v24.18.1, `OPENAI_API_KEY` unset):

```
[1/5] setup      OK  D:\r101-arms-local
[2/5] acceptance OK  status=OFFLINE_ACCEPTED passes=6/16
[3/5] suite      OK  448/448 test(s)
[4/5] matrix     OK  9/9 row(s)
[5/5] identity   OK  .ci\r97-r98\closed-loop-identity.json
```

> **Counts superseded:** the suite is now **464/464**. It moved 448→460 when the
> §7.10–7.12 fixes added 12 tests, and 460→464 when the CI defects in §7.17 added four
> more. The block above is the run as first measured and is kept as the historical
> record; §7.14 and §7.18 carry the current figures.
>
> **Superseded once more — see §8.6: the suite is 471/471.** The §8.2–§8.4 fixes added
> seven tests after this note was written, so 464 is no longer the current figure either.
> This is the third time this one number has moved; §8.6 is the only place that states it
> as measured against the current head.

**The bash removal is itself the fix, not a simplification.** Plan 怎么做 1–2
forbade continuing to patch "终端符号、相对路径和阈值"; the old job grepped for a
`✓` glyph and counted lines whose path prefix matched, and it failed on ubuntu
twice for exactly that reason (§3.1). A matrix row is now satisfied by a test's
own JSON `status`, which is a fact about the run rather than a fact about how a
reporter chose to print it.

### 7.4 ERRATUM — "no verified PASS is reachable offline" was WRONG

**§1.6 item 1 and §6.1 bullet 2 above are corrected here, and the old text is
kept rather than rewritten so the change of belief is visible.**

Those sections said a verified PASS is unreachable offline, because `--provider`
accepts only `openai` and the keyless stub yields `MODEL_ERROR`. That is true of
the **child-CLI dispatch** those sections were written against. It is false of
the seam T6 adopted.

Plan §0.4 identified the interface: both frozen arms export
`runBenchmarkCommand(argv, providerOverride)` from their own
`apps/cli/dist/benchmark-command.js`, and `ScriptedModelProvider` from their own
`packages/model/dist`. Injecting a scripted provider through that override drives
the **real** request, the **real** tool loop and the **real** `TaskVerifier`, with
**zero** external requests. Measured on the acceptance run: `verifiedPasses 6` of
`measuredUnits 16`, with `providerRequests 0`.

**What this does and does not mean.** It means the toolchain's verification path
is exercised end to end offline, which is what T6 had to prove. It does **not**
mean a model solved six cases: the provider is authored by this repository, so
`modelCapabilityClaim` is `"none"` and `promotable` is `false` in the run's own
output.

**And the six passes are WEAK, which the run states rather than hides:**

```
strongPasses: 0   weakPasses: 6
```

The three artifact-only frozen cases pass in each arm because `TaskVerifier`'s
artifact rule is `exists && (mustChange !== true || touched)` — it never inspects
content. `weak` therefore means "an artifact verifier was satisfied", not "the
case was solved". A `strong` pass requires content recovered from the case's own
command literal; the two R98 fixture cases that would be `strong` are not in the
frozen selection, so offline the strong path is exercised by unit tests only.

### 7.5 ERRATUM — the false pass that a `null` write produced

Found by running, not by reading. `writeTargetOf` returned `content: null` for an
artifact-only case. `write_file`'s own schema is `content: z.string()`, so the
tool call **failed**; the runtime recovered; and the artifact verifier then
reported **PASS** because the fixture file already existed and `mustChange` only
requires the path to appear in `changedPaths` — and `changedPaths` is built from
`events.onRequested`, i.e. **attempted** writes. A write that never happened
produced a verified pass.

This is recorded because it is a general property of the verifier, not a bug in
one case: **an artifact-verifier pass is only as strong as the write it depends
on.** The fix was applied in the **seam** (supply real, labelled content), never
by relaxing `mustChange` — weakening the verifier to make a case pass would have
destroyed the measurement the campaign exists to make.

### 7.6 The anti-cheat mutations really turn their tests RED

Plan 怎么做 7: "mutation/反例直接改变行为：让两臂都用一个构建、跳过 verifier、固定
request=r97、绕过预算、resume 丢历史失败，对应测试必须失败."

`scripts/e4/r97-mutation-check.mjs` applies each of the five to the **real
production source**, runs the test that exists to catch it, and requires that test
to **fail**. Each file is restored in a `finally` and **re-hashed**, so a mutation
cannot survive the gate.

```
[CAUGHT] same-build-for-both-arms      -> r97-plan.test.ts fails as required
[CAUGHT] skip-verifier                 -> r97-arm-worker-contract.test.ts fails
[CAUGHT] fixed-request-placeholder     -> r97-offline-seam.test.ts fails
[CAUGHT] bypass-budget                 -> r97-budget-ledger.test.ts fails
[CAUGHT] resume-loses-history          -> r97-driver-closed-loop.test.ts fails

r101-mutation: 5/5 mutation(s) CAUGHT by their tests
```

**The gate found two real coverage gaps on its first run, which is the point of
having it:**

1. `固定 request=r97` was **not caught**. The seam test asserted the script's
   *shape* (`script[0][0] === "text"`) but never that the text named its own case,
   so replacing every claim with the literal `"r97"` left the suite green. The
   assertion was added (`gives DIFFERENT cases DIFFERENT claim text`), and the
   mutation is now caught.
2. `跳过 verifier` was caught only after the test for that branch was **written**:
   the "`success=true` without the report's own verification evidence" branch had
   **no test at all**. A mutation is only caught by a test that exercises the
   branch, so an untested branch and a working one are indistinguishable.

A mutation that does not COMPILE is reported as broken rather than as caught — it
would be testing the type system instead of the behaviour. This happened on the
first attempt: `if (false)` made `baseline` possibly-`null` (TS18047), so the
mutation was rewritten to keep the narrowing.

### 7.7 A defect found while writing this section

`r97-offline-acceptance.mjs --all` with **explicit** `--baseline-dir` /
`--candidate-dir` still ran `--prepare`, because `--all` implies it. `stepPrepare`
ignored the explicit pair and built a **second** pair of arm worktrees (two
`pnpm install` + `pnpm build`) into a throwaway temp root — while the campaign ran
against the caller's arms and the summary recorded the **temp root** as the arms
used. The artifact therefore described a different pair than the one measured.

Fixed: an explicit pair suppresses the *inferred* prepare (an explicit `--prepare`
is still honoured), and the summary now records `baselineDir`/`candidateDir` and
reports `armsRoot: null` when the run built no arms rather than naming a directory
nothing read. Pinned by `C6: an explicit arm pair is USED, never re-prepared`.

Recorded here because the finding is more useful than the fix: **a summary that
names the wrong input is worse than no summary**, because it reads as evidence.

### 7.8 A matrix row that an UNRELATED test satisfied

Found by reading the produced `acceptance-matrix.json` rather than by a failing
test. The row **"外部 provider 未获授权"** (an unauthorized external provider) listed
as its third leg:

```
… C5: a pass is labelled STRONG or WEAK, never just 'passed'
   labels a banner-derived pass as weak
```

That test is about pass **labelling**. It has nothing to do with authorization and
passes whether or not the gate works. A row that goes green on an unrelated test is
worse than a row with no test at all: it reports coverage it does not have, which is
precisely the "green while the scenario is broken" failure the matrix exists to
prevent. The leg now names `… D1: every refusal path makes ZERO provider requests
UNAUTHORIZED: no auth env -> refused, 0 requests, provider never constructed` — the
strongest form of the row's own expectation ("provider 未构造"), because it requires
the refusal to happen **before** a provider exists rather than after one was built.

Pinned by `M7: a row is satisfied only by tests about ITS OWN scenario`, which
requires every row's tests to share vocabulary with the scenario the row names. The
check is deliberately a **keyword** check rather than a semantic one: it cannot prove
relevance, but it does catch an entry sharing no vocabulary at all with its row —
which is what happened.

### 7.9 T6 verdict

> **SUPERSEDED — see §7.14, and then §7.17–7.18.** The block below is the verdict as
> first written. It predates the three defects in §7.10–7.12, two of which were
> integrity defects that made plan 怎么验收 3 **false** at the time (a forged PASS
> validated clean). It also predates the first real two-platform CI run, which
> **failed on both platforms** (§7.17). It is kept verbatim as the historical record,
> per plan 怎么做 8 ("保留旧事实与 SHA，追加勘误"); the counts moved 448→460 and
> 253→255 when the new tests were added, and then 460→464 when the CI defects were
> fixed (§7.18).

```
status:                    OFFLINE_ACCEPTED
paidStatus:                PAID_NOT_RUN
experimentKind:            offline_closed_loop
executionMode:             arm-worker
verifiedPasses / units:    6 / 16   (strong 0, weak 6)
logicalCalls:              42
providerCalls:             0
suite:                     448 / 448
matrix:                    9 / 9
promotable:                false
modelCapabilityClaim:      none — the offline provider is scripted
```

`OFFLINE_ACCEPTED / PAID_NOT_RUN`, per plan 怎么验收 5 ("无外部付费执行时标为
`OFFLINE_ACCEPTED / PAID_NOT_RUN`"). This is not a claim that the paid two-version
experiment ran, and not a claim about model capability or win rate. The formal
transport's budget and identity are wired and exercised offline; the **paid**
execution itself was never attempted and is not being requested (plan 怎么做 6:
never write `OFFLINE_ACCEPTED` early, and never ask the user to pay).

### 7.10 A forged PASS was undetectable — plan 怎么验收 3, found by tampering real artifacts

Plan 怎么验收 3 states the criterion that this section closes:

> 最终报告能够由独立命令从这次真实产物重算，summary 篡改会失败.
> (The final report can be recomputed from this round's real artifacts by an
> independent command, and tampering with the summary fails.)

That criterion was **not** satisfied when §7.9 was first written. It was checked by
tampering the real 16-unit acceptance campaign rather than by reading the code, and
the first two tamper attempts passed correctly while the third did not:

| Tamper | Result before | Result now |
| --- | --- | --- |
| Rewrite the linked evidence FILE's verdict | refused (`EVIDENCE_BROKEN`) | refused |
| Change the record's `resultHash` | refused (`EVIDENCE_RESULT_MISMATCH`) | refused |
| **Rewrite only `execution-state.json`'s `detail`** | **`ok: true`, exit 0** | refused (`EVIDENCE_DETAIL_MISMATCH`) |

The third row is the defect. The chain bound `record.resultHash` to the envelope and
re-derived the envelope's hash from its own fields — but never bound the record's
`detail`, the verdict text. `resultHash` is deliberately not invertible, so it proves
the EVIDENCE is intact while saying nothing about the record's own prose.

**Why that field decides the number.** `r97-campaign-driver.mjs` derives the
campaign's headline `verifiedPasses` from `unitCategoryOf(r.detail)` — i.e. from the
`<category>:` prefix of that very string. Measured: rewriting the `detail` of all 16
records to `"e4-r98-arm-worker-v2 passed: verification_passed=true"`, leaving every
`resultHash` and every evidence file untouched, made the independent validator report
`ok: true, reasonCodes: []` and exit 0 while the aggregate reported **16/16 verified
passes**. The forged summary validated clean.

**The fix.** `verifyUnitEvidence` now binds both halves of the record's verdict text
— the category the aggregate reads, and the sentence — to the envelope's verdict
(`EVIDENCE_DETAIL_MISMATCH`, helper `verdictPartsOf`). Because agreement can only be
checked for a field that exists, presence is enforced one level up in
`r97-validate-campaign.mjs` (`VALIDATOR_DETAIL_MISSING`), exactly as `resultHash`
presence already was: deleting the field would otherwise turn a result into
`unitCategoryOf(undefined) === null`, a silent erasure.

Verified on the committed artifacts:

```
honest campaign              exit 0
detail rewritten to a PASS   exit 1   (EVIDENCE_DETAIL_MISMATCH, 16/16)
detail deleted               exit 1   (VALIDATOR_DETAIL_MISSING)
```

### 7.11 A second defect the fix exposed: the record leaked what the evidence redacted

Adding the binding immediately failed a real unit, which is how the second defect
surfaced. `r97-arm-worker.mjs` built the two verdict texts from **different** inputs:

```js
envelope.verdict.detail = redact(verdict.detail)          // redacted
record.detail           = `${VERSION} ${cat}: ${verdict.detail}`   // RAW
```

`redact()` does alter text — measured on five samples, three were rewritten
(`Bearer sk-…` → `Bearer <redacted>`, `api_key=…` → `api_key=<redacted-key>`,
`ghp_…` → `<redacted>`). So a verdict whose detail carries a credential produced a
record that (a) wrote the credential in cleartext into `execution-state.json`, and
(b) **disagreed** with the hashed evidence it points at. Measured with a secret-shaped
`caseId`, whose "not found" refusal embeds the caseId verbatim:

```
record   : …infrastructure: E4-R98: the report holds no result for case sk-abc1234567890abcdef
evidence : E4-R98: the report holds no result for case <redacted-key>
```

The leak is the security half; the disagreement is the integrity half — and it means
the new binding would have refused an **honest** run. Both texts are now built from one
redacted body via the exported `terminalDetailFor`, so there is no longer a second
place the raw text can enter. This is the honest limit of the earlier redaction test:
it asserted the *evidence* was redacted and never looked at the record.

### 7.12 A reused `--out` failed five steps in, with no code of its own

Found by running the closed loop twice, which is an ordinary thing to do.
`authorization.createdAt` is inside the plan digest, so the digest differs on every
run — measured: `94d77641…` then `cbb5f00f…`. A second run into the same `--out`
therefore always presents a NEW authorization to a ledger bound to the OLD campaign
header, and the driver correctly refuses `BUDGET_STATE_MISMATCH`: one budget may not
serve two authorizations (T1). The driver was right; the runner was wrong. It
discovered this five steps in — after building arms and writing a plan — and reported
a bare `status=FAILED`, indistinguishable from a genuine campaign failure.

An exported `ledgerReuseRefusal` pre-flight now runs **before any dispatch** and names
itself, so an operator can act on it:

```
[4/6] run FAILED  status=REFUSED
E4-R101: OFFLINE_OUT_REUSED: <out>/ledger already holds the campaign header of an
earlier run (campaign 88ea1b9e…, plan 94d77641…). This run would present a NEW
authorization … Point --out at a fresh directory, or delete the existing one.
```

### 7.13 Corrected fixtures — corrected, not weakened

Two test fixtures encoded the defect. They placed the worker's
`<version> <category>: ` prefix inside the **envelope's** `verdict.detail`, which the
real worker never does: measured on all 16 records of the acceptance campaign, the
envelope holds a **bare** sentence and only the terminal record carries the prefix.
The fixtures were corrected to mirror the real shape rather than the check being
relaxed to accept a shape the worker cannot produce.

### 7.14 T6 verdict, restated after 7.10–7.13

```
status:                    OFFLINE_ACCEPTED
paidStatus:                PAID_NOT_RUN
experimentKind:            offline_closed_loop
executionMode:             arm-worker
verifiedPasses / units:    6 / 16   (strong 0, weak 6)
logicalCalls:              42
providerCalls:             0
suite:                     460 / 460
matrix:                    9 / 9
plan 7-file block:         257 / 257
mutation gate:             5 / 5 CAUGHT
independent validator:     honest exit 0 · forged detail exit 1 · deleted detail exit 1
promotable:                false
modelCapabilityClaim:      none — the offline provider is scripted
```

> **CORRECTED:** this block originally read `suite: 460 / 460` and
> `plan 7-file block: 255 / 255`. Re-derived from the artifacts during the §7.21
> verification pass: the closed-loop suite reports **464/464**, and the seven files
> the plan names sum to **257**, not 255
> (`r97-arm-worker-contract` 37, `r97-budget-ledger` 50, `r97-driver-closed-loop` 67,
> `r97-execution-state` 27, `r97-plan` 56, `r97-redaction` 12, `r98-fixture-cases` 8).
> The counts moved because §7.10–§7.13 and §7.17 added tests after this block was
> written; §7.18 and §7.21 already carried the corrected figures, so this block was
> the one place still disagreeing with them.

Plan 怎么验收 3 is now satisfied against this round's real artifacts. 怎么验收 1 and
2 (the two-platform CI job, and reproduction from a clean checkout) remain the
outstanding items and are **not** claimed here: the Windows+Ubuntu matrix job has not
yet run on a real CI runner, so the cross-platform claim still rests on local win32
plus the cross-platform command. See §7.16.

### 7.15 The plan 怎么做 6 artifact list, mapped one item at a time

Plan 怎么做 6 names seven artifacts to publish: "plan、观察摘要、ledger、journal、脱敏单例
报告、最终汇总和 validator 输出". Six map onto files this round writes; one needs an
explicit statement rather than an assumed correspondence:

| Plan item | Artifact this round publishes | How it is produced |
| --- | --- | --- |
| plan | `.ci/r97-r98/acceptance/plan.json` | `stepPlan`, the authorization envelope |
| 观察摘要 | `observation-summary.json` | `stepObserve` |
| ledger | `ledger/` — `campaign-header.json`, `budget-ledger.json`, `execution-state.json` | the ledger store, opened by the driver |
| journal | **`ledger/attempts/**` — the per-unit evidence envelopes** | `writeUnitEvidence`, one per terminal unit |
| 脱敏单例报告 | `case-report.json` | `stepSummarize`, redacted |
| 最终汇总 | `acceptance-summary.json`, `campaign-summary.json` | `stepSummarize` |
| validator 输出 | `validator-report.json` | `stepValidate`, the shipped validator |

**On "journal":** the term comes from the paired-experiment path, where it names the
append-only per-run record. The R97 campaign has no file with that name; its
equivalent is the `ledger/attempts/**` tree, where every terminal unit gets an
immutable, content-hashed envelope recording the unit, the build, the verdict and the
redacted report row. That tree is published and is what the validator re-derives from.
The correspondence is stated here rather than left implicit because a reviewer looking
for a literal `journal` file would otherwise find nothing and have to guess whether the
item was dropped.

**Traceability is measured, not asserted:** all 16 terminal records' stored report rows
re-derive from their own `reportHash` (16/16), so the summary traces back through the
ledger and the evidence to the original row.

### 7.16 What is still NOT satisfied, stated plainly

> **RESOLVED — see §7.17 and §7.19.** The first bullet below was an inference when it
> was written ("has **not** executed on a real CI runner"). The job has since run, it
> first **failed on both platforms**, the causes were fixed, and the rerun is green on
> both. The text is kept as written, per plan 怎么做 8.

- **怎么验收 1 (两平台专用 job 全通过).** The `r97-r98-closed-loop` matrix job
  (`os: [ubuntu-latest, windows-latest]`) is committed and every phase it runs passes
  locally on win32, but it has **not** executed on a real CI runner. The claim "runs
  on both platforms" is therefore still an inference from a local run plus a
  platform-agnostic command, not a measurement. This is the one acceptance row this
  round cannot close from the author machine.
- **怎么验收 2 (从干净 checkout 的命令能复现).** The commands are in the repo and need
  no hand-written temporary script, but the six `clean-tree` guard failures in the
  user's workspace (§4.2) are caused by an unrelated pre-existing deletion
  (` D plan(20260917-001821).md`) that this round must not resolve unilaterally.
  > **RESOLVED — see §7.21.** The user resolved it by recording both plan entries
  > (`01bba90`), which made the tree provably clean: the three guard files went from
  > `6 failed / 155 passed` to `161 passed / 2 skipped`, and `pnpm test` to
  > `362/362 files, 6781 passed, 0 failed`.
- The paid two-version experiment remains `NOT_RUN`, was never attempted, and is not
  being requested.

### 7.17 ERRATUM — §7.16 above was written before the job ever ran, and it FAILED on both platforms

The paragraph above said the two-platform job "has not executed on a real CI runner".
It has now executed, and the first real run failed. That is recorded here rather than
quietly edited away, because the claim in §7.16 was an inference and the measurement
contradicted it.

**Run 35560959837, head `a793456`** — the first execution of the `r97-r98-closed-loop`
matrix on a real runner:

| Job | Result |
| --- | --- |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | success |
| `r97-r98 closed loop (windows-latest)` | **failure** |
| `r97-r98 closed loop (ubuntu-latest)` | **failure** |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | **failure** (step `Unit and integration tests`) |
| `install · … (ubuntu-latest)` | cancelled (superseded by run `35561161204` under `cancel-in-progress`) |
| `release attestation (P38-12)` | cancelled (its dependencies never went green) |

> **CORRECTED — the run-level conclusion is `cancelled`, not `failure`.** This table
> originally listed six jobs and the section described the run as a failure. The
> GitHub API returns seven jobs for run 35560959837 and a **workflow-level
> conclusion of `cancelled`**, because `cancel-in-progress` superseded the ubuntu
> main job and the release-attestation job while the two closed-loop jobs were
> failing. "The closed-loop job failed on both platforms" is true at the JOB level
> and is what this section's analysis rests on; "the run failed" is not what the API
> says. Found by re-querying the API during the §7.21 verification pass rather than
> by reading the report.

Two independent root causes, each visible on exactly one platform, plus a third latent
flake found while reproducing the second on a clean checkout.

#### RC1 — the mutation gate's anchors were EOL-fragile (windows-latest only)

`r97-mutation-check.test.ts` X2 compared anchors with a raw
`source.split(find).length - 1`. Two of the five anchors (`skip-verifier`,
`resume-loses-history`) span more than one line, so they contain an interior `\n`.
`git ls-files --eol` reports `i/lf` for all five target files, but `core.autocrlf=true`
— true in this repo and in a fresh clone — rewrites a Windows working tree to CRLF.
Measured in a clean clone of the failing head: the file holds 2123 CRLF endings and the
anchor matches **0** times, so the gate refused to run:

```
skip-verifier: the anchor appears 0 time(s) in scripts/e4/r97-arm-worker.mjs, expected 1
```

Ubuntu checks out LF and passed; `coverage gate (ubuntu)` — which runs
`pnpm test:coverage`, and that includes this file — also passed. Those two green jobs
are what pinned the cause to the checkout rather than to a stale anchor.

The line ending a checkout happens to use is not part of the program. Fixed by matching
through the gate's own EOL-insensitive `anchorOccurrences`, which normalizes both sides
and is now used by X2 **and** by `runOne`. The mutation is still applied to the
ORIGINAL bytes through an index map, so a file with mixed endings is not silently
rewritten end to end, and the replacement adopts the file's own ending.

#### RC2 — the driver result published an absolute host path (ubuntu-latest only)

D5 asserts the persisted driver result carries no host path, and on Linux it failed:

```
AssertionError: expected '{\n  "driverVersion": "e4-r97-campaig…' not to contain '/tmp/r97-driver-rmsDgP'
```

The leaking field was `result.campaign.rootDir`, the campaign's absolute directory.
The same field was written on Windows, where the assertion could not see it:
`JSON.stringify` escapes `\`, so the stored `C:\\Users\\…` never contains the raw
`dir`. **The leak was present on both platforms and observable on one** — the
assertion was passing on Windows for the wrong reason.

`rootDir` had no consumer. The campaign's durable header records the root, and
`R97_CAMPAIGN_ROOT_MISMATCH` is checked there, so publishing it into the result added
a leak and nothing else. `unitResults[].build.checkoutDir` was the same kind of value,
so it is now published as `publishedBuildOf(build)`: the identity
(`sourceSha`/`buildDigest`) is kept — that is what a reader can re-check — and the
location is dropped. D5 additionally walks the whole result tree, so a NEW field
carrying a path is caught rather than needing another assertion.

#### RC3 — the T4 arm-worker test killed its own subject (both platforms, load-dependent)

Found while reproducing RC2 in the clean clone, where the full loop first reported
462/463. The failing test was the T4 arm-worker entry, and its message was
`the driver printed nothing; code=1 stderr=`.

Its `runDriverCli` helper used a flat `timeout: 120_000`, while the campaign it drives
legitimately takes longer. Measured durations for the SAME test on the SAME machine:

| Run | Duration | Outcome |
| --- | --- | --- |
| clean clone, full suite | 125_613 ms | cap fired → child killed → empty stdout |
| clean clone, full suite | 117_225 ms | passed, 2.8 s of margin |
| clean clone, run alone | 107_703 ms | passed |

So the binding limit was the test's own subprocess cap, not the work: the test killed
its subject and then reported the killing as a defect in the subject. Raised to
600_000 ms — 4.8× the worst measured run, and deliberately below the enclosing 900 s
test budget so the inner cap still produces the diagnosable failure first — with a
guard test that fails if it is lowered back under the measured runtime.

**What this pair of root causes says about the pre-T6 job.** The previous ubuntu-only
job at `0075f72` ran this same test file and passed, but its gate counted
`grep -F "✓"` lines per file against `EXPECTED_MIN=36` and asserted a few named D6
tests. It never consulted a per-test status, so a single failing test stayed
invisible. Replacing that with a structured JSON gate is exactly what plan 怎么做 5
asked for ("使用结构化测试结果/稳定断言…不要继续为终端符号、相对路径和阈值写大量修补
逻辑") — and it is what surfaced RC2.

### 7.18 T6 verdict, after the fixes, on a clean checkout

Verified on a fresh clone of `00826e9` with `core.autocrlf=true` — the CRLF condition
that broke RC1 — with `git status --porcelain` empty so the tree matches CI:

```
closed loop      [1/5] setup OK · [2/5] acceptance OK status=OFFLINE_ACCEPTED passes=6/16
                 [3/5] suite OK 464/464 · [4/5] matrix OK 9/9 · [5/5] identity OK
mutation gate    5/5 CAUGHT
pnpm test        362/362 files, 6781 passed, 0 failed
pnpm typecheck   exit 0
pnpm test:security 2135/2135
pnpm docs:verify   ALL CHECKS PASS
plan 7-file block  257/257
```

The suite total moved from 460 to 464 because this round added four tests: three for
the two new defects (X5's CRLF pair, D5's host-path walk) and one guard for RC3.

> **Superseded — see §8.6.** This block is the state at `00826e9`. The current head is
> `64d95cb`, where the closed loop reports **471/471** and `pnpm test` reports
> **363/363 files, 6788 passed, 0 failed, exit 0**; the §8.2–§8.4 fixes added seven more
> tests after this was written. Kept as measured then, per plan 怎么做 8.

### 7.19 怎么验收 1 — MEASURED green on both platforms

The fixes above were pushed as `00826e9`, and the rerun is the first fully green
two-platform execution of this workflow.

**Run [35568591000](https://github.com/ki11a-Conton/harness-agent/actions/runs/35568591000),
head `00826e977077563463479af50a9a1802b052e7b6`, conclusion `success`:**

| Job | Result |
| --- | --- |
| `r97-r98 closed loop (windows-latest)` | **success** |
| `r97-r98 closed loop (ubuntu-latest)` | **success** |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | success |
| `release attestation (P38-12)` | success |

All seven jobs green. Both platforms of the dedicated matrix job passed, so plan
怎么验收 1 ("两平台专用 job 全通过，关键场景没有 skip") is now a **measurement rather
than an inference** — and the two failures it took to get here are recorded in §7.17
rather than removed from the record.

怎么验收 2 (reproduction from a clean checkout) is also measured: every number in §7.18
came from a fresh clone at `00826e9` with an empty `git status --porcelain`, which is
the CI condition. The only reproduction caveat that remains is the pre-existing
deletion in the author's workspace (§4.2), which is the user's to resolve.

**What this still does not prove.** The offline loop being green on two platforms says
nothing about model quality, win rate or promotion eligibility: the provider is
scripted, `providerCalls` is 0, and the paid two-version experiment remains `NOT_RUN`.
Per plan 怎么验收 5 the scope label stays `OFFLINE_ACCEPTED / PAID_NOT_RUN`.

### 7.20 The end conditions of plan §2, verified against this round's own artifacts

Plan §2 lists six conditions that must hold together for the round to close. Each is
checked below against the artifacts the command in §7.18 produced, not against a
restatement of intent.

| # | Plan §2 condition | Measured | Where |
| --- | --- | --- | --- |
| 1 | 每次实际调用受同一预算约束，恢复和换路径不授予新额度 | grant 320, committed 42; `logicalCalls 42` = `workerConsumedCalls 42`, all of it consumed by the 16 worker units (`measuredUnits 16`, `workerUnits 16`); a second ledger dir for one campaign id is refused `BUDGET_CAMPAIGN_DIR_DUPLICATE` | `driver-result.json`, §7.12 |
| 2 | 状态所有权正确；结果 hash、输入身份和原报告都在恢复时被验证 | `executionMode arm-worker`; `recoveredUnits 0`, `foreignOwnerUnits 0`, `reopenedForRetryUnits 0`; evidence chain re-checked 16/16 | `driver-result.json`, validator |
| 3 | 失败不会在恢复中消失；累计汇总可以从原结果独立重算 | `historicalFailures 0` on this fresh campaign; the resume-loses-history mutation is CAUGHT by its test; validator recomputes 16 terminal records from their own hashes, and forged/deleted detail both exit 1 | mutation gate, §7.10 |
| 4 | 正式入口确实执行两份构建、真实工具和 verifier；批准参数就是实际参数 | `workerUnits 16`, `providerRequests 0`, both arms present, **2 distinct `sourceSha`** across units, `checkoutDir` no longer published | `driver-result.json` |
| 5 | 超时与取消能结束真实进程树 | the bounded-stop suite passes in the CI matrix on both platforms; note the measured platform asymmetry — Windows has no SIGTERM delivery, so the POSIX path is exercised on ubuntu-latest | `r97-bounded-stop.test.ts` |
| 6 | Windows/Ubuntu CI 覆盖同一闭环，没有作者机器私有前提 | run `35569887542` on head `5a76beb`: all 7 jobs success; the loop needs only Node, no bash/WSL/Docker | §7.19 |

Independent recompute of this round's real artifacts:

```
node scripts/e4/r97-validate-campaign.mjs --campaign .ci/r97-r98/acceptance/ledger
  -> exit 0, ok=true, reasonCodes=[], terminal 16, evidenceChecked 16, evidenceFailures []
tampered detail (forged) -> exit 1      deleted detail -> exit 1      restored -> exit 0
```

With all six conditions measured, the round closes under plan §2's own instruction:
"达到以上条件后停止这轮基础设施修改". No R102+ framework work was started and no
experiment was enlarged. The paid authorization does not cover the final plan, so the
status stays `PAID_NOT_RUN`.

### 7.21 怎么验收 2 is now MEASURED in the author's workspace, not only in a clone

§7.16 bullet 2 and §7.19 recorded one item this round could not close from the author
machine: six tests in `e4-09-production-e2e.test.ts`, `e4-r55-failure-wiring.test.ts`
and `benchmark-command.test.ts` assert that `git status --porcelain` is empty, and the
author's workspace held two entries — the user's pre-existing
` D plan(20260917-001821).md` and the untracked `plan(20260920-053219).md` this round
was handed. §4.2 measured that the deletion ALONE reproduces the failures, so
committing the T6 code was never going to be sufficient.

The user resolved it, and chose the first of the three options §4.2 named: record both
entries rather than reverse either.

```
01bba90  chore: record the R88-R92 plan removal and add the R98-R101 closing plan
         D plan(20260917-001821).md   -> recorded, not restored
         ?? plan(20260920-053219).md  -> now tracked
```

The commit touches no source, test, report or measured figure. Measured after it, on
this machine, with `git status --porcelain` empty:

| Command | Before | After |
| --- | --- | --- |
| the 3 guard files | 6 failed / 155 passed / 2 skipped, exit 1 | **161 passed / 2 skipped, exit 0** |
| `pnpm test` | 6 failed (§4.1) | **362/362 files, 6781 passed, 3 skipped, 0 failed, exit 0** — and at the current head `64d95cb` it is **363/363 files, 6788 passed, 0 failed** (§8.5) |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test:security` | 2135/2135 | **2135/2135, exit 0** |
| `pnpm docs:verify` | ALL CHECKS PASS | ALL CHECKS PASS, exit 0 |
| 7-file block | 253–257 passed | **257 passed, exit 0** |
| closed loop (fresh `--out`) | — | **5/5 phases: acceptance `OFFLINE_ACCEPTED 6/16`, suite 464/464, matrix 9/9, identity OK** |
| mutation gate | 5/5 CAUGHT | **5/5 CAUGHT, exit 0** |
| validator on fresh artifacts | exit 0 | **exit 0 — 16 terminal, 16 evidence checked, 0 failures; grant 320, committed 42** |

Two things this changes and one it does not:

- **怎么验收 2** ("从干净 checkout 的命令能复现，用户无需手写临时脚本") is no longer
  qualified by the author's dirty tree. The six failures were, as §4.2 claimed,
  entirely a clean-tree guard and not a defect; committing the plan bookkeeping turns
  them green without weakening any guard.
- **The closed loop's `--out` reuse guard was exercised by accident and behaved
  correctly.** The first re-run against the pre-existing `.ci/r97-r98` failed
  `[2/5] acceptance` with `OFFLINE_OUT_REUSED`, naming the campaign and plan digest it
  would have collided with (§7.12). A fresh `--out` then passed 5/5. That is the guard
  from §7.12 firing on a real stale directory rather than on a test fixture.
- **It does not change the paid status.** The provider is still scripted,
  `externalProviderCalls` is 0, and the two-version experiment remains `PAID_NOT_RUN`.
  A clean local tree is not a model-quality result.

**Run [35673784338](https://github.com/ki11a-Conton/harness-agent/actions/runs/35673784338),
run_number 208, head `31efd9c150a5e860721be0e364a4653fcd456f05`, conclusion `success`** —
the pushed closure commits verified on a real runner:

| Job | Conclusion |
| --- | --- |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | success |
| `r97-r98 closed loop (ubuntu-latest)` | success |
| `r97-r98 closed loop (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `release attestation (P38-12)` | success |

All seven jobs green, none skipped or cancelled, and the closed-loop matrix ran on
BOTH platforms with every step — including "Run the offline closed loop" and "Prove
the suite CATCHES the plan's five anti-cheat mutations" — reporting success. This is
the run that corresponds to the report as it now stands, per plan T6 怎么验收 4
("CI head 明确对应实施提交").

> **SUPERSEDED — see §8.7.** "The report as it now stands" was true of `31efd9c`. Four
> commits landed after it, two of them behaviour fixes, so this run no longer describes
> the repository. The run that corresponds to the current head is `35693782588` at
> `7378aca`, cited in §8.7; the sentence above is kept because a superseded claim whose
> original is invisible cannot be audited (plan 怎么做 8).

---

## 8. The closing pass — four gaps found AFTER §7.21 was written
§7.21 closed the round at head `31efd9c` / run `35673784338`. That head is **not** the
head of the repository this section is written against. Four commits landed after it,
two of them behaviour fixes, and the report above never mentions them: a full-text
search for `output_limit`, `withR97CampaignLock`, `6860ee5` and `ab82bb4` in this
document returned **zero** hits before this section existed. This section closes that
gap rather than leaving the round described by a head it no longer has.

### 8.1 What moved after the last cited CI run

```
31efd9c  docs(E4-R101-A): record 怎么验收 2 as measured in the author's workspace   <- run 35673784338 head
   |
   +-- 6860ee5  fix(E4-R99-B): an output flood now ENDS the child, not just bounds memory   [T5]
   +-- ab82bb4  fix(E4-R98-B): the execution-state store now locks its read-modify-write    [T2]
   +-- 631027b  docs(E4-R99-R101): correct the three remaining unsupported test counts
   +-- 64d95cb  test(E4-R98-A): the ledger's FAILED WRITE refuses the call, and T6 now runs it [T1]
```

`origin/main` stood at `e23d541` — i.e. **four commits of this round were unpushed**, so
no CI run corresponded to them at all. That is the concrete sense in which "the round
was closed" was true of the report and not yet true of the repository.

### 8.2 T5 — an output flood bounded MEMORY and then never stopped anything

Plan T5 怎么验收 5 requires that a timeout, a cancel **and excess output** each end
execution. The third case was false: `BOUNDED_STOP_REASONS` listed `output_limit`, but
nothing ever settled with it. `ByteCap` bounded memory correctly and then said nothing,
so a flooding child ran until the **deadline** killed it. The old test encoded the
defect by asserting `reason === "timeout"` for a flood.

The fix points `ByteCap`'s new one-shot `onLimit` at the EXISTING `beginStop` sequence
with reason `output_limit`, so the polite signal, bounded grace, forced tree kill,
close await, single settle and cleanup are inherited rather than re-implemented.
`beginStop`'s own settled/reason guard plus the one-shot signal mean a flood cannot
resolve twice. `DRY_RUN_TIMEOUT_MS` — declared and never read, the same
declared-but-unused defect that made `SIGKILL_GRACE_MS` the original N8 bug — was
removed rather than wired.

Measured by the Lead on the current tree:

```
pnpm exec vitest run packages/evaluation/src/r97-bounded-stop.test.ts -t output_limit
  ✓ an output flood past the cap ends the child as `output_limit`, long before the deadline
  Tests  1 passed | 23 skipped (24)   exit 0
```

The commit's own RED record: with the wiring neutralised the new test fails with
`Expected output_limit, Received timeout` — the pre-fix behaviour.

### 8.3 T2 — the execution-state store's read-modify-write was UNLOCKED

Plan T2 怎么验收 2 requires that two processes racing the same
`case×arm×repetition` produce exactly ONE successful `begin`, and that concurrent
INDEPENDENT units do not lose records. Both clauses failed. The cause was not the atomic
write: `writeStateAtomic`'s temp-file-then-rename makes a single WRITE atomic, but the
read→mutate→write **sequence** had no mutual exclusion, so the second writer rebuilt the
whole `records` array from a snapshot taken before the first wrote (last-writer-wins).

The fix reuses the budget ledger's existing lock rather than inventing a third one:
`r97-budget-ledger.ts` exports `withR97CampaignLock`, and `r97-execution-state.ts` routes
every mutator through a new `withLockedState` that reads INSIDE the lock, mutates, and
writes before releasing. `begin`'s "one owner at a time" check and its write are now one
critical section.

**Re-measured independently by the Lead on the current tree**, with a two-process
file-barrier probe (`.ci/lead-race-probe.mjs` — real `node` children that rendezvous on a
`ready-*`/`go` barrier, not sleeps and not in-process promises):

```
=== SAME unit, two processes ===
  BEGIN_REFUSED 1 :: E4-R97: EXEC_BUSY: unit probe-exp|c1|probe|baseline|1 is already running …
  BEGIN_OK count : 1   (want 1)   -> OK
  records in file: 1
=== DIFFERENT units, two processes ===
  BEGIN_OK count : 2   (want 2)   -> OK
  records in file: 2
```

Before the fix the same probe reported `BEGIN_OK count 2` for the same unit and **1**
record for two distinct units.

### 8.4 T1 — 故障写盘 had no counterexample at all

Plan T1 怎么验收 5 names three fail-closed conditions:

> 缺少预算 IPC/ledger、故障写盘、超过授权预算时，真实与离线模式都不会绕过检查.

Two of the three had counterexamples. The third — **a failed disk write** — had none:
`ENOSPC|EACCES|EROFS|EDQUOT` returned zero hits across
`packages/evaluation/src/r97-*.test.ts`, and only the `BUDGET_EXHAUSTED` branch was ever
exercised. The plan asserted the property and nothing demonstrated it.

`packages/evaluation/src/r97-budget-write-fault.test.ts` supplies the missing
counterexample. It occupies the ATOMIC TEMP PATH with a **directory**, so the real
`writeFile` fails with a real errno while the real `budget-ledger.json` stays readable and
valid — the failure lands on the WRITE, not on the read/lock/open paths. The rejected
alternatives are recorded in the file with the measurement that rejected each; the
important one is `chmod 0o444`, which is green on Windows but **vacuous on POSIX**,
because `rename(2)` replaces a read-only destination using the directory's permissions.

**RED→GREEN measured by the Lead, independently of the suite** (`.ci/lead-write-fault-red.mjs`):

```
target sha256 (before): dc7a18002c96b8eb9401e5aedec85f47e3ef45c6e074850724c732da8aaff218
MUTATED (write failure swallowed): exit 1 (RED)
    Tests  2 failed | 2 passed (4)
    Error: expected the call to be REFUSED, but it completed without throwing
target sha256 (after) : dc7a18002c96b8eb9401e5aedec85f47e3ef45c6e074850724c732da8aaff218
restored: byte-identical
RESTORED: exit 0 (GREEN)
```

The file alone would have been a counterexample **no gate executes**, which T1 怎么验收
forbids ("并在 T6 必跑"), so it is added to `SUITE_FILES` in
`scripts/e4/r97-closed-loop.mjs`.

**Provenance, stated rather than glossed.** This file was found UNCOMMITTED in the working
tree at the start of this closing pass (created 11:31; no script in the repository
references its name). It is adopted here only after the independent RED→GREEN above, and
it is the file whose untracked status was causing six clean-tree-guard failures in
`pnpm test` — see §8.5.

### 8.5 The six "pre-existing clean-tree guard" failures are now gone

§4.2 and §7.16 explained six `pnpm test` failures as a dirty-tree guard caused by the
user's pre-existing ` D plan(20260917-001821).md`. That deletion was indeed one cause.
It was **not the only one**: after `01bba90` recorded the plan bookkeeping, the guard
listed exactly one remaining dirty entry —

```
E4-R55 requires a CLEAN committed working tree … Commit or stash first.
dirty entries (1):
  ?? packages/evaluation/src/r97-budget-write-fault.test.ts
```

— i.e. the uncommitted §8.4 file. Committing it (§8.4, `64d95cb`) clears the guard.
Measured on a clean tree at `64d95cb`:

| Command | Before | After |
| --- | --- | --- |
| `pnpm test` | 6 failed / 6782 passed, exit 1 | **363/363 files, 6788 passed, 3 skipped, 0 failed, exit 0** |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm docs:verify` | ALL CHECKS PASS | ALL CHECKS PASS, exit 0 |

This is a correction to §4.2's scope, not a contradiction of it: the deletion was
**sufficient** to reproduce the failures in a clean worktree, and it was not the only
entry keeping them red in this one.

### 8.6 T6 verdict, re-measured on the current head

The closed loop was re-run from scratch after §8.4's suite-list change, into a fresh
`--out` (the §7.12 reuse guard refuses a stale one):

```
[1/5] setup      OK  D:\r101-arms-local
[2/5] acceptance OK  status=OFFLINE_ACCEPTED passes=6/16
[3/5] suite      OK  471/471 test(s)
[4/5] matrix     OK  9/9 row(s)
[5/5] identity   OK  .ci/r97-r98-v2/closed-loop-identity.json
```

| Field | Value |
| --- | --- |
| `executionMode` | `arm-worker` |
| `verifiedPasses` / `measuredUnits` | 6 / 16 (strong 0, weak 6 — see §7.4) |
| `logicalCalls` | 42 |
| `providerCalls` | **0** |
| `suitePassedTests` / `suiteTotalTests` | **471 / 471** (was 464) |
| `matrixRowsSatisfied` / `matrixRowsTotal` | 9 / 9 |
| `promotable` | false |
| `modelCapabilityClaim` | none — the offline provider is scripted |

The suite total moved **464 → 471** because §8.2, §8.3 and §8.4 added tests after §7.14
and §7.18 were written. The plan's seven named files still sum to **257** (re-derived
per file: `r97-arm-worker-contract` 37, `r97-budget-ledger` 50, `r97-driver-closed-loop`
67, `r97-execution-state` 27, `r97-plan` 56, `r97-redaction` 12, `r98-fixture-cases` 8);
the closed-loop suite is 471 across **20** files (the 19 in §7.3 plus
`r97-budget-write-fault.test.ts`, which §8.4 adds to `SUITE_FILES`).

The independent validator and the anti-cheat gate were re-run against the SAME fresh
artifacts:

```
node scripts/e4/r97-validate-campaign.mjs --campaign .ci/r97-r98-v2/acceptance/ledger
  -> exit 0, ok=true, reasonCodes=[], terminal 16, evidenceChecked 16, evidenceFailures []
     grant 320, committed 42, remaining 278

node scripts/e4/r97-mutation-check.mjs --out .ci/r97-r98-v2/mutation-report.json
  -> 5/5 mutation(s) CAUGHT by their tests
```

And the §7.10 tamper matrix was re-run by the Lead on those artifacts, not inherited
from the earlier run:

| Tamper | Result |
| --- | --- |
| honest campaign | **exit 0**, `ok: true`, `reasonCodes: []` |
| all 16 `detail` fields rewritten to a PASS | **exit 1** — `EVIDENCE_DETAIL_MISMATCH`, 16/16 |
| `detail` field deleted | **exit 1** — `VALIDATOR_DETAIL_MISSING` |
| all 16 `resultHash` set to 64 zeros | **exit 1** — `VALIDATOR_EVIDENCE_BROKEN` |
| the linked evidence FILE's verdict rewritten | **exit 1** — `VALIDATOR_EVIDENCE_BROKEN` |

### 8.7 The two-platform CI run that corresponds to THIS head

Everything in §8.1–§8.6 was measured locally first. The four commits were then pushed as
`7378aca`, and the workflow ran on a real runner at exactly that head:

**Run [35693782588](https://github.com/ki11a-Conton/harness-agent/actions/runs/35693782588),
run_number 210, head `7378aca08708e6eced66e13a8adebaec3d4bd16a`, conclusion `success`:**

| Job | Conclusion |
| --- | --- |
| `r97-r98 closed loop (windows-latest)` | **success** |
| `r97-r98 closed loop (ubuntu-latest)` | **success** |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | success |
| `release attestation (P38-12)` | success |

All seven jobs green, none skipped and none cancelled. Both legs of the dedicated matrix
job reported success on every step, including **"Run the offline closed loop (setup ->
acceptance -> suite -> matrix -> identity)"** and **"Prove the suite CATCHES the plan's
five anti-cheat mutations"** — so the suite list §8.4 changed, the write-fault file it
added, and the mutation gate all executed on a real runner on both platforms. Each leg
uploaded its own `r97-r98-closed-loop-<os>-7378aca…-35693782588-attempt-1` artifact.

**The scope of this claim, stated precisely.** The run-level conclusion and the per-job
conclusions above were read from the GitHub API. The uploaded artifacts themselves could
NOT be downloaded to re-derive the suite total inside them, because the artifact-download
endpoint returned `401 Requires authentication` and no token is available in this
environment. So the runner-side `471/471` is **inferred** from a green step that fails
non-zero on any unsatisfied phase, not re-read from the runner's own JSON — which is
exactly the distinction §7.16 drew and got wrong once. The locally measured `471/471` in
§8.6 stands on its own artifacts.

怎么验收 1 ("两平台专用 job 全通过，关键场景没有 skip") and 怎么验收 4 ("CI head 明确对应实施
提交") are therefore satisfied at `7378aca`: the implementation commits `6860ee5`,
`ab82bb4`, `64d95cb` are all ancestors of this head, and this is the first run in which
they were exercised on a runner at all.

### 8.8 What §8 does NOT change

- **The paid two-version experiment remains `NOT_RUN`.** The provider is still scripted,
  `providerCalls` is 0, and no authorization covering a final plan exists. Per plan
  怎么做 6 this round neither performs nor requests a paid run.
- **No model-quality or promotion claim.** `promotable: false`,
  `modelCapabilityClaim: "none"`, and the six passes are `weak` (§7.4) — an artifact
  verifier was satisfied, not a case solved.
- **No new framework.** The four commits in §8.1 fix two reproduced defects, add one
  missing counterexample, and correct documentation. No R102+ work was started and no
  experiment was enlarged, per plan §2 ("达到以上条件后停止这轮基础设施修改").

### 8.9 The plan §2 end conditions, re-verified at `7378aca`

Plan §2 requires six conditions to hold together. §7.20 checked them against the
`00826e9` artifacts; this is the same table re-derived from the **`7378aca`** artifacts,
because two of the six were affected by §8.2–§8.5.

| # | Plan §2 condition | Measured at `7378aca` | Where |
| --- | --- | --- | --- |
| 1 | 每次实际调用受同一预算约束，恢复和换路径不授予新额度 | grant 320, committed 42, remaining 278; `logicalCalls 42` = `workerConsumedCalls 42` over 16 worker units; a failed ledger WRITE is now itself a counterexample (`r97-budget-write-fault.test.ts`, RED→GREEN) | `acceptance-summary.json`, validator, §8.4 |
| 2 | 状态所有权正确；结果 hash、输入身份和原报告都在恢复时被验证 | `executionMode arm-worker`, `recoveredUnits 0`, `foreignOwnerUnits 0`; the state store's read-modify-write is now LOCKED, re-measured by a two-process barrier probe: same unit 1 winner, distinct units 2 records | `driver-result.json`, §8.3 |
| 3 | 失败不会在恢复中消失；累计汇总可以从原结果独立重算 | validator exit 0 over 16 terminal records; forged `detail`, deleted `detail`, changed `resultHash` and a rewritten evidence file each exit 1 | §8.6 |
| 4 | 正式入口确实执行两份构建、真实工具和 verifier；批准参数就是实际参数 | `workerUnits 16`, `providerRequests 0`, 2 distinct `sourceSha`, suite **471/471**, matrix **9/9** | `closed-loop-identity.json`, §8.6 |
| 5 | 超时与取消能结束真实进程树 | bounded-stop 24/24, including the flood case that now settles as `output_limit` rather than running to the deadline | §8.2 |
| 6 | Windows/Ubuntu CI 覆盖同一闭环，没有作者机器私有前提 | run `35693782588` at head `7378aca`: all 7 jobs success, both closed-loop legs green on every step; the loop needs only Node — no bash, WSL or Docker | §8.7 |

With all six measured at a head that has a green two-platform CI run, the round closes
under plan §2's own instruction. The paid authorization still does not cover a final
plan, so the status remains `OFFLINE_ACCEPTED / PAID_NOT_RUN`.

### 8.10 §1.6 item 2, re-measured: the ledger IS a measurement, but not per case

§1.6 item 2 claimed two things, and they have different fates. This section separates
them because collapsing them is what let the claim survive four commits that changed it.

**Claim A — "the worker charges one reservation per unit, so the ledger counts case
starts, not model calls."** **This is FALSE now.** The worker still takes ONE
reservation up front, because the durable `running` record must carry a real
reservation id before dispatch. But that reservation is handed to the budget channel as
the pre-taken reservation for the FIRST call, and **every subsequent call reserves its
own**. Measured on the `7378aca` campaign artifacts
(`.ci/lead-reconciliation-check.mjs`, read-only):

```
=== LEDGER ===
  campaignModelCalls (grant) : 320
  entries / committed        : 42 / 42
  sum(consumed)              : 42
  distinct reservationIds    : 42

=== PER-ARM RECONCILIATION (the finest join the artifacts allow) ===
  arm        units  ledger.consumed  report.model_calls   retries  agree
  baseline      8              21                 21        0  YES
  candidate     8              21                 21        0  YES

  units (case x arm)                    : 16
  ledger committed entries == consumed  : true  (one entry per real call, all ids distinct)
  ledger total == report total          : 42 == 42 -> true
  calls per unit (NOT 1 per case-start) : 2.63
```

16 units produced **42** ledger entries, and the arms' own `model_calls` sum to the same
42 per arm. A unit therefore costs **2.63 calls on average, not 1** — which is exactly
the quantity plan §T1 怎么验收 6 requires ("不把 case 数或进程启动次数当模型调用数"). The
unit-level form of the same invariant is pinned in the suite:
`r97-arm-worker-contract.test.ts` asserts `entries.toHaveLength(measured)`,
`record.reservationIds` are all distinct, `record.consumed === measured`, and
`record.report.model_calls === measured`.

**Claim B — "the child's per-case consumption is not reconciled against the ledger."**
**This survives, but for a narrower reason than §1.6 gave.** A ledger entry is
`{ reservationId, arm, pid, reservedAt, reserved, status, consumed, transportRetries }`
— it carries **no `caseId`**. So the finest durable join is **per arm**, not per case.
Per-arm reconciliation holds exactly (21 = 21 on each side, 0 retries); a per-CASE join
is not merely unverified, it is **not expressible against the current ledger schema**.

**What this does and does not change:**

- Plan §T1 怎么验收 6 is **satisfied**: the accounting basis is the channel's measured
  admitted-call count, the arm's self-report agrees with it per arm, and no case count
  or process-start count is used as a model-call count.
- §1.6 item 2's first sentence was **wrong from `8504a45` onward** and is now marked
  superseded in place rather than deleted.
- The remaining limitation is stated precisely: **per-case** reconciliation would
  require a `caseId` on the ledger entry, which does not exist. Adding it is a schema
  change and was NOT made here — the plan's §2 closing instruction is to stop
  infrastructure modification, and the acceptance criterion it names is per-arm
  agreement plus a measured (not assumed) call count, both of which hold.
- `transportRetries` is 0 on every entry, so the retry half of §T1 怎么验收 6 is
  vacuously satisfied on this run and is not evidence that the retry path was exercised;
  the ledger's `commit(reservationId, consumed, transportRetries)` validates and stores
  it, and `r97-budget-ledger.test.ts` covers a non-zero value. Stated so the 0 is not
  read as proof.

### 8.11 The run that corresponds to the report's FINAL head

§8.7 cited `35693782588` at `7378aca`. Four documentation commits followed it
(`cc745da`, `3bae661`, `ff9ced5`, `3630256`), so the same question §8.1 raised applies
to them: does any run correspond to the head the report now describes?

Both documentation heads were checked, and both are green:

| Run | Head | Jobs | Conclusion |
| --- | --- | --- | --- |
| [35710940810](https://github.com/ki11a-Conton/harness-agent/actions/runs/35710940810) | `ff9ced5` | 7 / 7 | success |
| [35712775164](https://github.com/ki11a-Conton/harness-agent/actions/runs/35712775164) | `3630256` | 7 / 7 | success |

The API reports `total_count: 7` with all seven jobs `completed / success` for each, and
the run pages carry **zero** `failed`, `cancelled` or `skipped` markers. Both legs of the
closed loop are among them, on Windows and Ubuntu:

| Job | Conclusion |
| --- | --- |
| `r97-r98 closed loop (ubuntu-latest)` | success |
| `r97-r98 closed loop (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | success |
| `release attestation (P38-12)` | success |

Everything from `7378aca` to `3630256` touches **only** `docs/E4-R99-R101-report.md`, so
no executable path changed and the `7378aca` evidence carries over; these runs confirm
the documentation-only commits are green too. That closes the §8.1 gap completely: every
commit from `6860ee5` (the first behaviour fix that had never been pushed) to the head
this text is committed on now sits under a green two-platform run.

**Same scope limit as §8.7, restated because it is the load-bearing caveat:** the
run-level and per-job conclusions were read from the GitHub API and run pages, not
re-derived from the uploaded artifacts. The artifact-download endpoint returns
`401 Requires authentication` and the job-log endpoint `403 Forbidden`, and no token is
available in this environment, so the runner-side suite total is **inferred** from green
steps that fail non-zero on any unsatisfied phase. The locally measured `471/471` in
§8.6 stands on its own artifacts.

**Why the regress terminates here, stated as a checkable rule rather than a promise.**
This section is itself delivered by a documentation-only commit, so the head that
contains this text is one commit newer than the last head cited above — the same regress
§8.1 opened. It terminates because of a property that can be verified rather than trusted:

> A commit that changes **no executable path** cannot change any CI outcome, so a green
> run at head `H` transfers to every descendant `H'` where
> `git diff --name-only H..H'` names only documentation.

Applied to this round, and verified: the last commit that changed anything executable is
`64d95cb` (it adds `r97-budget-write-fault.test.ts` and edits the closed-loop
`SUITE_FILES`). `git diff --name-only 64d95cb 3630256` returns exactly one path,
`docs/E4-R99-R101-report.md`, and `7378aca`, `ff9ced5` and `3630256` are all
documentation-only descendants of it. So the implementation commits `6860ee5`, `ab82bb4`
and `64d95cb` are each covered by a green run at or after them, and no further commit is
appended to chase the report's own SHA.

That is also the plan's own instruction, 怎么做 9: "报告写实现 SHA 和对应 CI URL；不要
为了让报告包含自己的提交 SHA 无限追加文档 commit." The implementation SHAs are recorded
above; the runs are recorded in §8.7 and here; and the chain stops.

