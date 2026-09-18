# E4-R97 report — the real campaign driver: gate before provider, cross-process budget, finalized plan

**Task.** Plan §R97 (finding F): distinguish a DRAFT from a
`FINALIZED_AUTHORIZATION_PLAN`; generate the real plan from **two actual
checkouts/builds** with independently observed identity; wire the R92 gate into
the campaign driver **before** the provider is constructed or called; implement a
campaign-wide budget shared across arms, processes and recovery; and by default
emit only the approval material, executing no real model.

**Scope.** `packages/evaluation/src/r97-{budget-ledger,plan}.ts` (+ tests),
`packages/evaluation/src/r97-driver-closed-loop.test.ts`,
`packages/evaluation/src/index.ts`, `scripts/e4/r97-campaign-driver.mjs`.

| Item | Value |
| --- | --- |
| Implementation SHA | `e584cdd` (`e584cddfce39602d904f68b8918c782722e64352`) |
| CI run | [`35315586748`](https://github.com/ki11a-Conton/harness-agent/actions/runs/35315586748) — ubuntu-latest **3/3 jobs success** |
| Real provider calls | **0** — no provider is constructed on any path exercised here |
| Network | none (a real `node` child process is spawned; no socket is opened) |
| Paid steps executed | **none** |
| `pnpm typecheck` (working tree **and** clean checkout) | exit 0 |
| `pnpm build` (working tree **and** clean checkout) | exit 0 |
| R97 tests | 82 passed / 82 (3 files: ledger 25, plan 31, driver 26) — the 77-test subset present at `e584cdd` also passes identically in a clean `e584cdd` checkout |
| `pnpm docs:verify` | ALL CHECKS PASS |
| `git diff --check` | clean |

---

## 1. What was actually wrong (finding F), restated

R92 built a gate and R92 built a plan module, and the two were never connected to
anything that spends money. Three concrete gaps:

1. **`r92AuthorizationGate` was only reachable through its own tests.** The real
   entry point a campaign would use — the CLI benchmark path — never called it.
   A gate that nothing invokes is a document, not a control.
2. **`r92-plan.ts` proved its own facts.** Lines 302–315 copied "observed" values
   out of the authorization object, and `computeArmPlanDigest` (341–360) produced
   a plan-time digest. Copying a declared value into an "observation" field is
   not evidence: it proves the plan agrees with itself.
3. **The budget was per-process.** Nothing existed to stop a restart, a second
   arm, or a second process from being granted a fresh allowance.

R97 closes all three by making the driver the enforcement point.

## 2. Design

### 2.1 Status is DERIVED, never declared

`buildR97AuthorizationPlan` computes the status from evidence:

| Condition | Status |
| --- | --- |
| **no** arm observed | `DRAFT` |
| one arm observed, or both observed with any issue | `NOT_READY` |
| both arms observed **and** `allIssues.length === 0` | `FINALIZED_AUTHORIZATION_PLAN` |

Splitting `DRAFT` from `NOT_READY` is deliberate: plan §R97 line 213 groups them
("NOT_READY/DRAFT"), but they are different situations for the reader — "nothing
measured yet" versus "something was measured and is incomplete" — and collapsing
them would hide which one applies.

A DRAFT carries `authorization: null`, `planDigest: null` and the draft schema;
`planDigest` is computed only on the `authorizable` branch
(`r97-plan.ts:594`). The plan status is a three-way derivation, not a stored
flag, and P1 asserts the **behaviour** of all three branches: `DRAFT` for no
observation, `NOT_READY` with `/candidate.*never observed/` for one, and
`FINALIZED_AUTHORIZATION_PLAN` with a 64-hex digest and `readinessIssues === []`
for both. A fourth test pins that a DRAFT is never authorizable and never claims
a digest **even when the caps are supplied** — a fully-specified cap set cannot
promote an unobserved plan.

### 2.2 The anti-copy rule, enforced structurally

`parseR97ArmObservation(arm, checkoutDir, raw, caseFingerprints)` takes the arm's
**own** CLI dry-run output. `facts` come from the checkout, the case files on
disk, and the real dry-run — never from the authorization object. The plan then
*checks* the observed values against the authorization; it does not read them
out of it. `r97-plan.test.ts` P2 asserts the forbidden paths are gone: the
source is stripped of block and `//` comments before scanning, so the module's
own JSDoc quoting the plan does not produce a false positive.

### 2.3 Real CLI dry-run, in each arm's own checkout

The digest bound into the plan is the one a **real CLI `--dry-run`** printed
inside that arm's checkout:

| Arm | Observed `sourceSha` | Real CLI dry-run `planDigest` |
| --- | --- | --- |
| baseline | `e9776ba66190ea63b1bacb685c91aa900b6935e7` | `c0acefbb18884dd4fe15ec485afd8ac88f91bfdebba86d3c9cb068e62e8fe6ac` |
| candidate | `a20373743b56de6a3a110fecdd254737ece71afa` | `d1c5dfd0df81d4b226e2a3ebc873c17725a8cce21df4fca7ed3c6dd3e4a4784a` |

These are not plan-time substitutes. Plan §R97 line 211 forbids using
`computeArmPlanDigest` as a stand-in, and R97 does not call it at all.

### 2.4 Four shape mismatches the real entry point exposed

Driving the actual CLI — rather than a pure gate function — found three places
where the planned contract did not match the real one. Each was a real defect in
the design, not a test nuisance:

1. **The dry-run does not print `caseFingerprints`.** A parser demanding them
   would have rejected every real observation. Fingerprints are now supplied by
   the caller, read from the arm's own case source, and `buildDryRunPlan` is not
   claimed to carry them.
2. **`caseIds` are bare names** (`reg-16-cicd-step`), not suite-prefixed
   (`regression/reg-16-cicd-step`). `R97ArmObservation` now carries `cliCaseIds`
   alongside `caseIds`, and `mapCliCaseIdsToSelection` refuses on ambiguity.
3. **`--suite` is single-valued**, but the frozen selection spans `regression`
   and `stress`. `observeArms` stages the whole frozen list into one `--cases`
   root and passes one suite label; the true suite is carried from the frozen
   selection.
4. **`loadBenchmarkCases` sorts alphabetically** (`baseline.ts:245`), so the CLI
   order can never equal the selection file's array order. Case drift became a
   **set** comparison plus a cross-arm `ARM_ORDER_MISMATCH` check, and the plan
   binds the **arm's** `plannedOrder` — the order that will actually execute.

The frozen selection's own `armRule` requires only that both arms use the same
order, which is checked separately. The plan and the approval package both state
this explicitly rather than implying the selection file's array order is the
execution order.

### 2.5 Gate before provider — and before anything else

`runDriver` order is fixed:

```
gate  →  LEDGER_REQUIRED  →  ledger.recover()  →  makeProvider()  →  per-arm/per-case reserve → generate → commit
```

The gate runs **first**; `makeProvider()` is the last thing before spending. The
test asserts the provider **construction count is 0** on every *pre-provider*
refusal path — not merely that the request count is 0. Those paths are: no auth
env, wrong digest, expired, invalid date, not-yet-valid (future `createdAt`),
case drift, build drift, arm build-digest drift, identity drift (model changed),
and an authorized run with no ledger. The one refusal that is *not* pre-provider
is **budget exhausted**: authorization has already passed there, so the provider
exists and is simply never asked to generate — the test asserts 0 requests on
that path and says so in a comment rather than claiming the constructor never
ran. The CLI without `--fake-provider` prints:

```json
{"status":"NOT_RUN","reason":"no --fake-provider: this driver never constructs a real provider by default"}
```

which is plan §R97 line 207 (default: approval material only, no real model) and
line 219 (no real provider without authorization) in one behaviour.

### 2.6 A campaign-wide budget that survives processes and recovery

`openR97BudgetLedger` is a file-backed ledger (`budget-ledger.json` +
`budget-ledger.lock`). Semantics that matter:

- **Reserve before the call, commit after.** The allowance is taken out before
  the request is made, so a crash mid-call cannot leave unaccounted spend.
- **Unknown counts at the RESERVED amount.** A `reserved` entry that never
  committed is *not* refunded — the allowance stays consumed. Only an explicit
  `abandon` returns it. This is plan §R97 line 227 ("unknown requests count
  against the reserved allowance") and line 217 ("recovery preserves consumption
  and unknown reservations").
- **No per-process re-grant.** The first-open grant is written to disk, so a
  restart reads the existing grant instead of minting 320 more calls.
- **Mismatch is fatal.** A plan-digest or grant mismatch throws; a damaged ledger
  fails closed rather than resetting.
- **Commit above reserve throws** — a process cannot spend more than it reserved.

**The lost-update race, and why the first regression test was inadequate.** The
first version wrote the first-open grant *outside* the lock. Two processes
bootstrapping one campaign both saw "no ledger"; the second's empty write erased
the first's reservation, and both racers could spend the last call. It surfaced
as an intermittent failure — roughly 1 in 6 when the suite ran in sequence, and
green when run alone.

The first regression test I wrote for it was probabilistic and **did not catch
the mutation**. It was replaced with a **deterministic** one: hold the lock,
call `readR97BudgetView(dir)` after 750 ms, and assert it is still `null` —
i.e. the bootstrap write cannot have happened outside the lock. Verified by
mutation: moving the write back outside the lock makes it fail
(`1 failed | 24 passed`). Fixing it also required distinguishing "file absent"
via `readR97LedgerFile` (returns `null`) from `read()` (substitutes an empty
ledger) — conflating those two is exactly what created the race.

## 3. The gap found by checking acceptance against the code: the R93 validator was never invoked

Plan line 228 makes "正常路径完整成对结果通过 R93 validator；中断路径使用 R94 状态合同"
an **acceptance criterion**, and line 221 asks for a "零调用演练" (zero-call
rehearsal) before asking a human to approve a plan. Auditing the driver against
those two lines found that neither was implemented: the driver exercised the
**gate** and the **budget**, but nothing in it ever produced a paired result set,
and `validateManifest` — the R93 validator — was never called from anywhere in
`scripts/e4/` at all. "Passes the R93 validator" was an untested claim, and the
earlier draft of this report asserted it on the strength of a test that only
counted logical calls.

This was measured before it was believed. A probe drove the R87 replay harness
(`runReplayAb`, `ScriptedModelProvider`, no key, no socket) over the frozen
selection and pushed the records through `buildManifest` → `validateManifest`:

```
NORMAL  : VALID [] | verdict MECHANISM_VALIDATED | providerCalls 0
RESUME  : executed 8 records 16 incompleteRecovered 0
AFTER   : VALID | completeness COMPLETE
```

The rehearsal mechanism works and validates. What was missing was the driver
calling it.

### 3.1 What was added

`runZeroCallRehearsal(opts)` in the driver, reachable as
`node scripts/e4/r97-campaign-driver.mjs --rehearse [--out <dir>] [--interrupt-after-first-arm]`:

- **Normal path** — `runReplayAb` over both arms, projected to a manifest, judged
  by `validateManifest`.
- **Interruption path** — one arm first, then a resume with both arms through the
  R94 run-state contract; the resume must re-run **only** the missing arm.
- The driver does **not** assert `VALID` on its own authority: `validationStatus`
  is whatever the validator returned, and the manifest is written to
  `rehearsal-manifest.json` so the artifact can be re-validated independently.
- `tamperManifest: "drop-a-record"` exists so a test can prove the validator is
  actually consulted.

Measured through the CLI:

| Path | `validationStatus` | records | resumed | providerCalls |
| --- | --- | --- | --- | --- |
| normal | `VALID` | 16 | 0 | **0** |
| `--interrupt-after-first-arm` | `VALID` | 16 | **8** (second arm only) | **0** |

Both report `completeness: COMPLETE`, `verdict: MECHANISM_VALIDATED`,
`network: 0`, `realProviderConstructed: false`.

### 3.2 The validator is genuinely load-bearing (mutation check)

Replacing the call with a rubber stamp —
`const validation = { status: "VALID", reasonCodes: [], detail: "rubber stamp" }` —
makes the tamper test **FAIL** (`1 failed | 21 skipped`), then passes again when
restored. The `VALID` in the table above is the validator's verdict, not the
driver's opinion of itself.

### 3.3 A second defect the CLI found

Driving the real CLI with `--rehearse --out <new dir>` died with
`ENOENT: ... rehearsal-run-state.jsonl`: `runReplayAb` writes the run-state file
itself, and the output directory did not exist yet. The directory is now created
before the first pass. This is the same class of defect as the shape mismatches
in §2.4 — visible only by running the actual entry point, invisible to a unit
test of the pure function.

## 4. RED → GREEN

Every item was written as a failing test first:

| Test file | RED (before) | GREEN (after) |
| --- | --- | --- |
| `r97-budget-ledger.test.ts` | 25 tests — no ledger module existed | 25 passed |
| `r97-plan.test.ts` | 31 tests — no DRAFT/FINALIZED distinction existed | 31 passed |
| `r97-driver-closed-loop.test.ts` | 26 tests — no driver existed; D7 first failed as `TypeError: rehearsal is not a function` (5 failures), then failed for the right reason | 26 passed |

The strongest RED is the driver closed loop: before R97 there was no entry point
to drive, so D1–D7 could not even be expressed. Three tests were **rewritten**
after measuring the real behaviour — the array-equality order assertion, the P5
parse shape, and the D7 rehearsal — because each original expectation encoded a
contract the real entry point does not have; the corrected tests assert the
measured contract.

## 5. Acceptance, against plan §R97 lines 224–232

| Plan requirement | Evidence |
| --- | --- |
| Unauthorized / wrong digest / bad date / expired / case drift / build drift / budget exhausted → **0** out-of-bounds fake-provider requests | D1: every refusal path asserts `providerRequests === 0` and `logicalCalls === 0`; provider construction asserted **0** on all 10 pre-provider paths (the budget-exhausted path is post-authorization and is asserted on requests only) |
| Two-arm fixture with a **combined cap of 3** — one arm 2, second arm at most 1; **restart does not refresh** | G2 restart/re-grant + G5 real cross-process test (spawns `node`) |
| Unknown requests count against the reserved allowance | G3 recovery; unknown stays at reserved, no refund |
| Normal path's complete paired result **passes the R93 validator**; interruption path uses the R94 state contract | §3: `--rehearse` → `VALID`; `--interrupt-after-first-arm` → `VALID` with `resumedExecuted: 8`; mutation-checked so a rubber stamp fails |
| Zero-call rehearsal before asking for approval | §3: 16 records, 0 provider calls, 0 network, no real provider constructed |
| Finalized plan digest **exactly equals** the real dry-run digest | §2.3 table; both arms' digests are the CLI's own |
| Changing any bound field invalidates the old approval | P4 approval package + P3 readiness refusals |
| Clean checkout succeeds on Windows **and** Ubuntu offline CI | Windows: `D:\r97-clean` @ `e584cdd` — typecheck 0, build 0, R97 77/77, R93 91/91, R94 106 assertions, R92+R95 98/98. Ubuntu: run `35315586748`, 3/3 jobs success |
| Original Ubuntu cold-start preserved | job `offline cold-start (ubuntu)` success on `e584cdd` |
| Deliverable is `READY_FOR_AUTHORIZATION` / `NOT_RUN` with exact digest, SHA, cases, executable caps, unknown cost | §5 below |
| **0** real HTTP requests without new approval; no automatic 86-case run, no holdout, no new paid cases | Driver default prints `NOT_RUN`; no provider constructed; holdout untouched |

### 5.1 The clean-checkout run, verbatim

`D:\r97-clean` is a `git worktree add --detach` of `e584cdd`, `git status
--porcelain` empty, installed with `pnpm install --frozen-lockfile --offline`:

```
TYPECHECK_EXIT=0
BUILD_EXIT=0
R97:      Test Files 3 passed (3)   Tests  77 passed (77)
R93:      Test Files 1 passed (1)   Tests  91 passed (91)
R92+R95:  Test Files 2 passed (2)   Tests  98 passed (98)
R94 selfcheck: PASSED (0 provider calls, 0 network, 0 cost), 106 assertions
```

This is plan §R97 line 230 and §R96's clean-tree precondition satisfied
honestly: the *working tree* is not clean (the user's two plan files), so the
clean claim is made against a genuine clean checkout rather than by stashing
someone else's files.

## 6. The deliverable — exact values

| Field | Value |
| --- | --- |
| Status | **`FINALIZED_AUTHORIZATION_PLAN` — READY_FOR_AUTHORIZATION / NOT_RUN** |
| **Plan digest (approve this exact value)** | `b5ac1fb4f046cae0e1f8298a13f45066e735b1591f14ac15c3254fd8bf6620ab` |
| Created | `2026-09-18T06:33:43.269Z` |
| **Expires** | `2026-10-18T06:33:43.269Z` |
| Driver version | `e4-r97-campaign-driver-v1` |
| Output dir | `.ci/r97-ab` (nothing written there) |
| Promotion-eligible | `false` |
| Fix scope | `single-fix-H2` |
| Cases | the R87-frozen 8 non-holdout dev cases (3 TARGET + 5 COUNTEREXAMPLE), selection digest `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae` |
| Serialism / repetitions | 1 / 1 |
| Provider / model / endpoint | `openai` / `gpt-4o-mini` / `ee071e382ae11baecc06ca51545a6d4f3fa74cb3ea12b605d63d0b19ae84fea7` |
| Actual executable cap | `maxModelCalls` 320 campaign-wide, **runtime-enforced**; `maxLogicalRuns` 16, preflight-only |
| Real HTTP requests | **0** |

Artifacts: `.ci/r97-final/plan.json`, `observations.json`, `approval-package.md`
(git-ignored working material, not committed).

## 7. Runtime Freeze assessment (P38.4-11)

R97 adds new modules under `packages/evaluation` and a new script; it modifies no
existing runtime behaviour. The one change to an existing file is two
`export * from` lines in `packages/evaluation/src/index.ts`. The freeze is
therefore not engaged for this change, and nothing here rewrites Runtime. The
R94 `Test-IsLink` fix and the `9840130` fixture fix belong to R94 and qualify
there as release-integrity defects in the runner's containment control.

## 8. Honest limits

- **The rehearsal proves the DRIVER, not the campaign.** It runs the R87
  scripted-replay harness over the frozen selection with `ScriptedModelProvider`.
  It proves the driver can produce a complete, R93-valid paired matrix with zero
  provider calls — it does **not** prove anything about a real model's behaviour,
  and `MECHANISM_VALIDATED` is a statement about the scripted mechanism only.
  The validator's own detail string says so: *"Internal consistency does NOT prove
  that the named code executed."*
- **The rehearsal's manifest is not the campaign's evidence.** It is written to
  `.ci/r97-rehearsal/rehearsal-manifest.json` as working material and is not
  committed, promoted, or counted as a result. `promotionEligible` stays `false`.
- **`tamperManifest` is a test-only hook.** It exists solely so the mutation
  argument in §3.2 is checkable; it is not reachable from the CLI.
- **The R92 gate protects the R97 driver entry, not every entry.** The generic
  `agent benchmark` CLI path still has its own independent authorization
  contract. Plan §R97 line 220 explicitly forbids reporting that all entry points
  are covered by the same gate; this report does not.
- **The budget bounds LOGICAL generate calls, not physical HTTP attempts.** A
  transport retry is a separate request that the logical cap does not count. The
  two are recorded separately and the physical count is declared an unknown cost,
  not a bounded one.
- **The fake provider is a detector, not a hard limiter.** The ceiling check can
  overshoot by one in-flight call; it proves what the driver *asked for*, and the
  ledger is what actually bounds the allowance.
- **`--maxEstimatedTokens` and `--maxEstimatedCostUsd` are not executable caps.**
  Both are preflight-only against a fixed planning constant; `isHardLimit`
  returns false for the cost cap, so neither can terminate a run. They are
  labelled `preflight-only` / `unprovable` in the plan rather than presented as
  spending bounds.
- **The two-arm observation depends on the arm worktrees existing.** The D6 test
  is `it.skipIf(!haveArms)` and checks `D:/r97-arm-baseline` and
  `D:/r97-arm-candidate`. If they are absent the test skips, and the real
  observation in §2.3 cannot be reproduced from the repository alone.
- **`--suite` is single-valued**, so the two `stress` cases are planned under the
  `regression` label while their true suite is carried from the frozen selection.
  This is a real modelling compromise, stated in the plan and here.
- **The gate is enforced in-process by the driver.** A caller that bypasses
  `runDriver` and calls a provider directly is not stopped by R97; the ledger
  file is the only durable cross-process control.
- **`maxToolCalls`/`maxDurationMs` were not raised.** No limit, timeout, retry
  count or iteration cap was changed to make any acceptance criterion green.

## 9. Files

| File | Change |
| --- | --- |
| `packages/evaluation/src/r97-budget-ledger.ts` | **new** — file-backed campaign budget: reserve/commit/abandon/recover, unknown-at-reserved, bootstrap under the lock |
| `packages/evaluation/src/r97-budget-ledger.test.ts` | **new** — 25 tests / 6 describes, incl. a real cross-process spawn and the deterministic lock regression |
| `packages/evaluation/src/r97-plan.ts` | **new** — DRAFT / FINALIZED_AUTHORIZATION_PLAN / NOT_READY derivation, arm observation parsing, readiness checks |
| `packages/evaluation/src/r97-plan.test.ts` | **new** — 30 tests / 6 describes, incl. the anti-copy and hostile-parse groups |
| `packages/evaluation/src/r97-driver-closed-loop.test.ts` | **new** — 21 tests / 6 describes, incl. the real two-arm E2E |
| `packages/evaluation/src/index.ts` | 2 `export *` lines |
| `scripts/e4/r97-campaign-driver.mjs` | **new** — the real driver; `--fake-provider` default `NOT_RUN`; `runZeroCallRehearsal` + `--rehearse` for the R93-validated zero-call rehearsal |
