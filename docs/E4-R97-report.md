# E4-R97 report — the real campaign driver: gate before provider, cross-process budget, finalized plan

**Task.** Plan §R97 (finding F): distinguish a DRAFT from a
`FINALIZED_AUTHORIZATION_PLAN`; generate the real plan from **two actual
checkouts/builds** with independently observed identity; wire the R92 gate into
the campaign driver **before** the provider is constructed or called; implement a
campaign-wide budget shared across arms, processes and recovery; and by default
emit only the approval material, executing no real model.

**Scope.** `packages/evaluation/src/r97-{budget-ledger,plan}.ts` (+ tests),
`packages/evaluation/src/r97-driver-closed-loop.test.ts`,
`packages/evaluation/src/index.ts`, `scripts/e4/r97-campaign-driver.mjs`,
`docs/E4-R97-report.md`.

| Item | Value |
| --- | --- |
| Implementation SHA | `a437252` — the R97 chain is `e584cdd` (driver/ledger/plan) → `f8b3df5` (zero-call rehearsal) → `a437252` (driver-version binding) |
| CI run | [`35317337663`](https://github.com/ki11a-Conton/harness-agent/actions/runs/35317337663) @ `f8b3df5` — **5/5 jobs success**, incl. **windows-latest** and **ubuntu-latest**, `offline cold-start (ubuntu)`, `coverage gate`, `release attestation`. `a437252`'s run is [`35319690746`](https://github.com/ki11a-Conton/harness-agent/actions/runs/35319690746) |
| Real provider calls | **0** — no provider is constructed on any path exercised here |
| Network | none (a real `node` child process is spawned; no socket is opened) |
| Paid steps executed | **none** |
| `pnpm typecheck` (working tree **and** clean checkout) | exit 0 |
| `pnpm build` (working tree **and** clean checkout) | exit 0 |
| R97 tests | 86 passed / 86 (3 files: ledger 25, plan 31, driver 30) — identical in the working tree and in a clean checkout |
| `packages/evaluation` suite | 94 files, 1363 passed |
| R93 / R92+R95 / R94 gates (clean checkout) | 91 passed / 98 passed / 106 assertions PASSED |
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

### 3.3 Another defect the CLI found

Driving the real CLI with `--rehearse --out <new dir>` died with
`ENOENT: ... rehearsal-run-state.jsonl`: `runReplayAb` writes the run-state file
itself, and the output directory did not exist yet. The directory is now created
before the first pass. This is the same class of defect as the shape mismatches
in §2.4 — visible only by running the actual entry point, invisible to a unit
test of the pure function.

## 4. A further defect: the plan advertised a bound field it did not bind

Plan line 214 lists 驱动器版本 (driver version) among the values the finalized
material must freeze, and line 229 requires that changing any bound field
invalidates the old approval. The R97 approval package printed, in its
"What is being authorized" list:

```
- Driver that would execute it: `e4-r97-campaign-driver-v1`
```

That line was **not true as a binding**. `driverVersion` was a top-level field of
the plan result, outside the authorization envelope, so it was **outside
`planDigest`**, and nothing in the driver ever compared its own version to the
plan's. Measured, with the tamper applied to a real plan artifact:

```
driver DRIVER_VERSION:      e4-r97-campaign-driver-v1
tampered plan.driverVersion: e4-r97-campaign-driver-v99-IMPOSSIBLE
planDigest unchanged by the tamper: true
```

This was not hypothetical: commit `f8b3df5` rewrote the driver (adding the whole
rehearsal and changing its refusal surface) while the approved digest
`b5ac1fb4…` stayed byte-identical. An approval that does not cover the executor
does not cover the code that would run.

### 4.1 The fix

- `driverVersion` is now a field of `R92AuthorizationV1`, so it is covered by
  `computeR92AuthorizationDigestV1` and therefore by `planDigest`.
- The driver asserts equality with its **own** `DRIVER_VERSION` as **STEP 0**,
  before the gate and therefore before any provider can exist, returning
  `NOT_RUN` / `DRIVER_VERSION_MISMATCH`. Binding into the digest proves a *human*
  approved that version; only the executor comparing itself proves the code
  *running* is that version. Both halves are required.
- A plan that binds **no** driver version is refused too — absent is not
  "compatible with everything".
- `driverVersion` stays **optional** in the shared R92 type on purpose: the R92
  plan is a real committed artifact whose own text says its driver *"does not
  exist yet and will be written only after you approve"*, so R92 could not name
  one. Requiring it there would be a retroactive lie. R97's readiness check is
  what **requires** it (`DRIVER_VERSION_UNBOUND` → `NOT_READY`), so the
  requirement lands at the step that decides whether a plan may finalize.

Verified with the real artifact:

```
driverVersion in envelope : "e4-r97-campaign-driver-v1"
recomputed == approved   : true
tampered digest differs  : true
issues with REAL caps, driver unbound : ["DRIVER_VERSION_UNBOUND"]
issues with REAL caps, driver bound   : []
```

Mutation-checked: disabling the STEP 0 comparison (`if (false)`) makes **2** D8
tests fail; restoring it passes 4/4.

**The approved digest therefore changed: `b5ac1fb4…` → `676e8774…`.** That is the
correct outcome of the fix — the old digest did not cover the executor, so it is
superseded rather than reused.

## 5. RED → GREEN

Every item was written as a failing test first:

| Test file | RED (before) | GREEN (after) |
| --- | --- | --- |
| `r97-budget-ledger.test.ts` | 25 tests — no ledger module existed | 25 passed |
| `r97-plan.test.ts` | 31 tests — no DRAFT/FINALIZED distinction existed | 31 passed |
| `r97-driver-closed-loop.test.ts` | 30 tests — no driver existed; D7 first failed as `TypeError: rehearsal is not a function` (5 failures), D8 as `expected undefined to be 'e4-r97-campaign-driver-v1'` + 2× `expected 'REFUSED' to be 'NOT_RUN'` | 30 passed |

The strongest RED is the driver closed loop: before R97 there was no entry point
to drive, so D1–D8 could not even be expressed. Three tests were **rewritten**
after measuring the real behaviour — the array-equality order assertion, the P5
parse shape, and the D7 rehearsal — because each original expectation encoded a
contract the real entry point does not have; the corrected tests assert the
measured contract. D8 is the opposite case: a defect found by re-reading the
acceptance criteria against the code, with the RED written before the fix.

## 6. Acceptance, against plan §R97 lines 224–232

| Plan requirement | Evidence |
| --- | --- |
| Unauthorized / wrong digest / bad date / expired / case drift / build drift / budget exhausted → **0** out-of-bounds fake-provider requests | D1: every refusal path asserts `providerRequests === 0` and `logicalCalls === 0`; provider construction asserted **0** on all 10 pre-provider paths (the budget-exhausted path is post-authorization and is asserted on requests only) |
| Two-arm fixture with a **combined cap of 3** — one arm 2, second arm at most 1; **restart does not refresh** | G2 restart/re-grant + G5 real cross-process test (spawns `node`) |
| Unknown requests count against the reserved allowance | G3 recovery; unknown stays at reserved, no refund |
| Normal path's complete paired result **passes the R93 validator**; interruption path uses the R94 state contract | §3: `--rehearse` → `VALID`; `--interrupt-after-first-arm` → `VALID` with `resumedExecuted: 8`; mutation-checked so a rubber stamp fails |
| Zero-call rehearsal before asking for approval | §3: 16 records, 0 provider calls, 0 network, no real provider constructed |
| Finalized plan digest **exactly equals** the real dry-run digest | §2.3 table; both arms' digests are the CLI's own |
| Changing any bound field invalidates the old approval | §4: `driverVersion` is inside the digest, so changing it moves `planDigest` (D8); P4 approval package + P3 readiness refusals |
| Clean checkout succeeds on Windows **and** Ubuntu offline CI | Windows: `D:\r97-clean` @ `a437252` — typecheck 0, build 0, R97 86/86, R93 91/91, R94 106 assertions, R92+R95 98/98. Ubuntu + Windows: run `35317337663` @ `f8b3df5`, **5/5 jobs success** |
| Original Ubuntu cold-start preserved | job `offline cold-start (ubuntu)` success on `f8b3df5` |
| Deliverable is `READY_FOR_AUTHORIZATION` / `NOT_RUN` with exact digest, SHA, cases, executable caps, unknown cost | §7 below |
| **0** real HTTP requests without new approval; no automatic 86-case run, no holdout, no new paid cases | Driver default prints `NOT_RUN`; no provider constructed; holdout untouched |

### 6.1 The clean-checkout run, verbatim

`D:\r97-clean` is a `git worktree add --detach`, `git status --porcelain` empty,
installed with `pnpm install --frozen-lockfile --offline`. Run at `a437252` (the
commit that binds the driver version), with earlier figures in brackets for the
subsets that existed then:

```
TYPECHECK_EXIT=0
BUILD_EXIT=0
R97:      Test Files 3 passed (3)   Tests  86 passed (86)   [was 77 at e584cdd, 82 at f8b3df5]
R93:      Test Files 1 passed (1)   Tests  91 passed (91)
R92+R95:  Test Files 2 passed (2)   Tests  98 passed (98)
R94 selfcheck: PASSED (0 provider calls, 0 network, 0 cost), 106 assertions
rehearsal via the clean CLI: validationStatus VALID, 16 records, COMPLETE, providerCalls 0
```

This is plan §R97 line 230 and §R96's clean-tree precondition satisfied
honestly: the *working tree* is not clean (the user's two plan files), so the
clean claim is made against a genuine clean checkout rather than by stashing
someone else's files.

### 6.2 Why the working-tree `pnpm test` shows 6 failures, and why they are not R97

In the **working tree** `pnpm test` reports `6 failed | 6464 passed | 3 skipped`.
All six failures are one precondition, stated by the test itself:

```
AssertionError: E4-R55 requires a CLEAN committed working tree: the production
benchmark refuses to produce a promotion-eligible run on a tree that is not
provably clean, so every child case would fail for an unrelated reason.
Commit or stash first.   (apps/cli/src/e4-r55-failure-wiring.test.ts:1277)
```

The working tree carries the user's two plan files — `plan(20260917-001821).md`
deleted and `plan(20260917-083737).md` untracked — which plan §1 line 46 records
as an environment precondition that must **not** be resolved by deleting or
stashing the user's changes.

The same three test files were run in the clean `f8b3df5` checkout:

```
apps/cli/src/e4-r55-failure-wiring.test.ts + e4-09-production-e2e.test.ts
  + benchmark-command.test.ts
Test Files  3 passed (3)     Tests  161 passed | 2 skipped (163)
```

**0 failures.** The six are therefore attributable to the dirty tree and not to
any R97 change. The passed count moved `6455 → 6464` (+9), exactly the nine tests
added (5 in D7, 4 in D8), and no previously passing test regressed.

## 7. The deliverable — exact values

| Field | Value |
| --- | --- |
| Status | **`FINALIZED_AUTHORIZATION_PLAN` — READY_FOR_AUTHORIZATION / NOT_RUN** |
| **Plan digest (approve this exact value)** | `676e8774c3a9691a62f3113480490711701f0040f1df2e46d76c52e3aceca7cb` |
| Created | `2026-09-18T07:22:16.027Z` |
| **Expires** | `2026-10-18T07:22:16.027Z` |
| Driver version (bound into the digest) | `e4-r97-campaign-driver-v1` |
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

## 8. Runtime Freeze assessment (P38.4-11)

R97 adds two new modules under `packages/evaluation`, a new test file, and a new
script. It changes two existing files:

- `packages/evaluation/src/index.ts` — two `export *` lines;
- `packages/evaluation/src/r92-authorization.ts` — adds the optional
  `driverVersion` field to the authorization envelope (§4), so it is covered by
  the existing digest function.

The freeze is therefore assessed rather than assumed. §4 qualifies under
**criterion 3 (release integrity defect)**: an approval document advertised a
bound executor version that the approved digest did not cover, so a rewritten
driver could run under a byte-identical approval. That is an integrity defect in
the authorization artifact itself, with a deterministic reproducer (the
`driverVersion` tamper leaves `planDigest` unchanged). No existing behaviour is
rewritten: the field is optional, no R92/R95 test changed, and all 98 of those
tests plus the 11 R92-rehearsal tests pass unmodified.

The R94 `Test-IsLink` fix and the `9840130` fixture fix belong to R94 and qualify
there as release-integrity defects in the runner's containment control.

## 9. Honest limits

- **`driverVersion` is a LABEL, not a code hash.** Binding it means a *renamed*
  driver is refused and a rewritten driver is expected to bump the label. Nothing
  forces that bump: a change made without editing `DRIVER_VERSION` still runs
  under an unchanged digest. The honest bound would be a hash of the driver
  source; a version string is what plan line 214 names, and it is strictly
  stronger than the previous state (where the field was outside the digest and
  unchecked entirely).
- **The R92 plan still binds no driver version, and that is deliberate.** Its own
  committed text says its driver "does not exist yet", so requiring one would be a
  retroactive claim. R92's envelope therefore keeps `driverVersion` absent; only
  R97's readiness check requires it.
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

## 10. Files

| File | Change |
| --- | --- |
| `packages/evaluation/src/r97-budget-ledger.ts` | **new** — file-backed campaign budget: reserve/commit/abandon/recover, unknown-at-reserved, bootstrap under the lock |
| `packages/evaluation/src/r97-budget-ledger.test.ts` | **new** — 25 tests / 6 describes, incl. a real cross-process spawn and the deterministic lock regression |
| `packages/evaluation/src/r97-plan.ts` | **new** — DRAFT / FINALIZED_AUTHORIZATION_PLAN / NOT_READY derivation, arm observation parsing, readiness checks incl. `DRIVER_VERSION_UNBOUND` |
| `packages/evaluation/src/r97-plan.test.ts` | **new** — 30 tests / 6 describes, incl. the anti-copy and hostile-parse groups |
| `packages/evaluation/src/r97-driver-closed-loop.test.ts` | **new** — 30 tests / 8 describes, incl. the real two-arm E2E, the zero-call rehearsal (D7), and the driver-version binding (D8) |
| `packages/evaluation/src/r92-authorization.ts` | `driverVersion?: string` on `R92AuthorizationV1`, so it is covered by the authorization digest; non-empty when present |
| `packages/evaluation/src/index.ts` | 2 `export *` lines |
| `scripts/e4/r97-campaign-driver.mjs` | **new** — the real driver; `--fake-provider` default `NOT_RUN`; `runZeroCallRehearsal` + `--rehearse` for the R93-validated zero-call rehearsal |
