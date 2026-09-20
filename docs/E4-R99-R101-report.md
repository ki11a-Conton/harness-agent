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

`packages/evaluation/src/r97-arm-worker-contract.test.ts` — **28 tests, all
passing**, driving the real module (never a mock):

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

1. **No verified PASS is reachable offline.** The stub yields `MODEL_ERROR` for
   every case, so every offline unit ends `provider`/`case_failed` with
   `verifierPassed === false`. Proving "the verifier passes a real tool write"
   requires the billed provider. Plan §R99: "不为本任务调用实际付费模型." The
   suite proves **execution and verification**, not success.
2. **One reservation per unit is a promise, not a measurement.** The worker
   reserves 1 logical call per unit; the child's real per-case consumption is
   visible in its report (`model_calls`) but is not reconciled against the
   ledger. §R98 forbids assuming one call per case, and this is the remaining gap.
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
prove the paid two-version experiment ran (see §3.4), and no case PASSED its
verification offline (the stub provider yields `MODEL_ERROR`; §1.6).

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

Per-file counts: `r97-budget-ledger` 50, `r97-execution-state` 22,
`r97-plan` **55**, `r97-driver-closed-loop` **45** (0 skipped, includes the real
D6 path), `r97-arm-worker-contract` **28**, `r97-redaction` 12,
`r98-fixture-cases` 8.

**External provider requests: 0.** No test sets `OPENAI_API_KEY`; the arm worker
deletes it from every child environment it builds.

### 4.1 Historical data changes

None. No prior report, SHA or measured figure was overwritten. The R97 report's
errata section stands as written; this document adds to it rather than revising it.

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
- That any case PASSED its verification. Offline, none can.
- That the paid two-version experiment ran. It did not, and the gateway needed
  for it is broken upstream.
- That the arm worktrees created for this report are reproducible by a single
  committed command on a fresh machine — `r97-observe-arms.mjs` implements that,
  and the CI closed-loop job now rebuilds both arms on a clean runner, but the
  command itself has been exercised only on this machine.
