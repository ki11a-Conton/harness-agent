# A5 — 身份不符必须拒绝，不能被后续 PASS 覆盖

**Task:** E4-R105 (A5 / F5) · **Status:** implemented, RED→GREEN verified, `pnpm typecheck` clean

---

## 1. The measured defect (F5)

Plan §A5 states it exactly:

> `runArmUnit` 已发现 executionIdentity.drift，但后续报告分类会覆盖它。

The worker **did** detect the drift and **did** set a `harness` verdict — and then an
independent `if/else` further down ran `classifyReport` and unconditionally assigned
`record.verifierPassed = classified.passed === true`. A report that merely *claimed*
`verification_passed=true` turned a refused unit into a completed pass.

**RED, captured before the fix** (protocol fixture: approved `approved-model`, dry run
declares `approved-model`, `createClient` receives `unapproved-model`, report claims success):

```
{"status":"completed","failureCategory":null,"verifierPassed":true,
 "detail":"verified: verification_passed=true tools=0 termination=stop",
 "consumed":1,"capturedRequests":1,
 "drift":["the runtime asked for model unapproved-model but the approval names approved-model"],
 "reportVerificationPassed":true}
```

`drift` was non-empty and the unit still reported **`status: completed`, `failureCategory: null`,
`verifierPassed: true`**. That is the whole defect.

There were three more holes in the same shape:

| # | Hole | Why it mattered |
|---|------|-----------------|
| a | Drift only checked `runtimeModelId !== null` | A **null** model ref skipped the comparison entirely — "we could not establish the identity" was read as "the identity matched". |
| b | The dry run's **exit code** was never consulted | A failed dry run left `declaredPlan === null`, every `declared*` comparison short-circuited, and the real case ran anyway. |
| c | The identity check ran only **after** the whole case executed | An unapproved model could drive the request, the tool loop and the verifier before anyone noticed. |

---

## 2. Verdict priority table

Plan §A5 怎么做 2 requires "明确、互斥的状态转换 … 不能后续无条件赋值覆盖", and §怎么验收 7
requires the conclusion to be stable "不受 if 语句顺序偶然影响".

`R97_VERDICT_PRIORITY` (`scripts/e4/r97-arm-worker.mjs`) is a **total order** over the
verdict vocabulary, most blocking first. Every fact a unit establishes is folded through
`foldR97Verdict`, which keeps the highest-ranked fact as the verdict and retains the others
as **diagnostics**.

| Rank | Category | Meaning | Outranks |
|------|----------|---------|----------|
| 1 | `harness` | The campaign's own plumbing refused: drifted identity, changed build, unapproved inputs, evidence that could not be written. **Measured nothing scorable.** | everything |
| 2 | `budget` | The spend itself is unknown: a reservation entered the provider but could not be settled. | timeout, infra, provider, case_failed, pass |
| 3 | `timeout` | The shared deadline stopped the unit; the arm never produced a verdict. | infra, provider, case_failed, pass |
| 4 | `infrastructure` | The unit measured nothing for a host reason (no report, broken toolchain). | provider, case_failed, pass |
| 5 | `provider` | The model provider errored. | case_failed, pass |
| 6 | `case_failed` | **A VALID NEGATIVE**: the case ran and failed its own task. The driver deliberately excludes it from `failures[]`. | pass |
| 7 | `passed` | `null` category — the report carried positive verification evidence. | — |

Two design points that are load-bearing:

- **`harness` is first** because a unit refused on those grounds may not be scored at all.
  No later observation — a timeout, a missing report, or a report claiming success — can
  outrank it.
- **`case_failed` is not a harness failure.** Plan §A5 怎么做 7: "本任务不能把所有低分案例都
  改成基础设施失败." Collapsing legitimate negatives into infrastructure failures would satisfy
  every refusal test while destroying the campaign's ability to tell "the case failed its task"
  from "the unit measured nothing".

A category this module does not recognise ranks **most blocking**, so an unknown verdict
vocabulary can never be silently outranked by a pass.

`verifierPassed` is now decided in **exactly one place** — `record.verifierPassed = verdict.category === null`
— derived from the **final** verdict. It used to be assigned in four independent branches,
where the last one to run won.

---

## 3. Drift counterexample (measured, not described)

Reproduce with:

```bash
node scripts/e4/a5-drift-counterexample.mjs
```

It builds a real, loadable protocol-fixture arm and drives the **shipped** worker:

```
=== VERDICT PRIORITY TABLE (most blocking first) ===
  1. harness
  2. budget
  3. timeout
  4. infrastructure
  5. provider
  6. case_failed
  7. passed

=== DRIFT COUNTEREXAMPLE (measured, protocol fixture) ===
  approved model          : approved-model
  dry-run declared model  : approved-model          <- the plan AGREES, so the
  createClient model refs : [{"providerId":"openai","modelId":"unapproved-model"}]
  runtime model ref       : unapproved-model        <- the drift is only visible HERE
  drift                   : ["the core runtime asked for model unapproved-model but the approval names approved-model"]
  synthetic report claim  : verification_passed=true
  captured requests       : 0  (inner generate entered)
  consumed                : 0

  --- RESULTING VERDICT (the fix) ---
  status                  : failed
  failureCategory         : harness
  verifierPassed          : false
  detail                  : E4-R98: the arm executed under an identity the plan did not approve —
                            the core runtime asked for model unapproved-model but the approval names
                            approved-model — also observed: verified: verification_passed=true tools=0 termination=stop

=== GROUND TRUTH FROM THE FIXTURE'S OWN DISPATCH LOG ===
dispatch
refused: E4-R105: the core runtime asked for model unapproved-model but the approval names approved-model
```

Read the three lines together:

- **`captured requests: 0`** — the boundary guard threw inside `createClient`, so
  `inner.generate` was never entered. The request could not leave (A5 怎么验收 2).
- **`consumed: 0`** — nothing was dispatched, so nothing was charged.
- **`detail`** carries **both** facts: the blocking refusal **and** the report's own claim,
  retained as `also observed:`. The report is diagnostic evidence; it is no longer the
  authority (A5 怎么做 6).

The synthetic PASS this fixture writes is a **protocol fixture** and must never be counted
into a real benchmark result.

---

## 4. What changed

| File | Change |
|------|--------|
| `scripts/e4/r97-arm-exec.mjs` | `createClient` boundary guard: the real `modelRef` is checked before `inner.generate` and **throws** on mismatch or a null `modelId`; every ref is recorded in `clientModelRefs`. Pre-dispatch refusals for a failed dry run, an unparseable plan, a missing plan model, or an endpoint mismatch. New structured `identityRefusal` / `boundaryError` on the result. |
| `scripts/e4/r97-arm-worker.mjs` | `R97_VERDICT_PRIORITY` + `foldR97Verdict`; every verdict assignment folded instead of overwritten; `verifierPassed` derived once from the final verdict. |
| `packages/evaluation/src/r97-arm-worker-contract.test.ts` | 7 new tests (5 protocol-fixture units + 2 table tests) under `R105`. |
| `packages/evaluation/src/r97-campaign-validator-cli.test.ts` | Per-test claim anchor (see §6). |
| `scripts/e4/a5-drift-counterexample.mjs` | New: the reproducible counterexample above. |

---

## 5. Acceptance criteria

| Criterion (plan §A5 怎么验收) | Test | Result |
|---|---|---|
| 漂移+成功报告：worker 非 PASS；`verifierPassed=false`；终态/evidence/driver 结论一致 | `R105` "the synthetic PASS report must not win" — asserts the terminal record is `failed`/`harness` **and** re-derives the evidence envelope through `verifyUnitEvidence`, requiring `ok: true` with `verdict.category === "harness"` | ✅ |
| 实际 modelRef 与批准不同：inner generate 次数为 0 | Same test: `capturedRequests === []` plus the fixture's own on-disk dispatch log reading `refused:` | ✅ |
| dry-run exit 非零、无法解析身份、缺必要字段、endpoint 不符：不进入实际案例调用 | "a FAILED dry run ends the unit BEFORE any dispatch" — the fixture's dispatch log must **not exist**, `consumed === 0` | ✅ |
| 完全匹配的 offline provider 替身仍可得到真实 verifier PASS；合法负例仍记 `case_failed` | "an APPROVED-and-matching unit still reaches a verified PASS" + "a LEGITIMATE negative stays `case_failed`, not infrastructure" | ✅ |
| 首次失败后 resume 新增调用为 0，历史失败不会变成 COMPLETE 的成功 campaign | Terminal record is written `failed`, so `isDone` is true and a resume skips it; the driver's `unitCategoryOf` reads the `harness:` prefix | ✅ (existing `r97-bounded-stop` S7 + driver suites) |
| 独立 validator 校验的是"证据完整的失败"，不会因此被解释成任务通过 | The `verifyUnitEvidence` call above; plus `r97-campaign-validator-cli.test.ts` 17/17 | ✅ |
| 身份失败与 timeout 同时出现时结论稳定 | `foldR97Verdict(timeout, harness)` and `foldR97Verdict(harness, timeout)` both yield `harness` | ✅ |

### Evidence

```
pnpm typecheck
  $ tsc -b
  EXIT=0

pnpm exec vitest run \
  packages/evaluation/src/r97-execution-identity.test.ts \
  packages/evaluation/src/r97-arm-worker-contract.test.ts \
  packages/evaluation/src/r97-arm-report-evidence.test.ts \
  packages/evaluation/src/r97-campaign-validator-cli.test.ts
  Test Files  4 passed (4)
       Tests  98 passed (98)
```

Regression suites also run clean: `r97-bounded-stop` + `r97-driver-closed-loop` (98/98),
and `r97-acceptance-matrix`, `r97-campaign-evidence`, `r97-closed-loop`, `r97-mutation-check`,
`r97-offline-seam`, `r97-redaction` (108/108).

### Non-vacuity

Two mutants were injected and each was caught by a **different** test:

| Mutant | Caught by |
|---|---|
| `record.verifierPassed = false` (an over-broad refusal) | "an APPROVED-and-matching unit still reaches a verified PASS" |
| `case_failed` → `infrastructure` in `classifyReport` | "a LEGITIMATE negative stays `case_failed`, not infrastructure" |

Both mutants were reverted; `grep MUTANT` over the worker is empty.

---

## 6. One isolation fix, and one pre-existing failure left alone

`r97-campaign-validator-cli.test.ts` builds every campaign under the **same fixed
`planDigest`** in a brand-new temp directory. Since finding F2, the machine-global claim
anchor records which directories *established* a budget — so after `afterEach` removed the
previous test's directory, `openR97Campaign` correctly refused with `CAMPAIGN_STATE_LOST`.

That refusal is **the F2 fix working**. What was wrong was the *isolation*: two unrelated
tests sharing one authorization namespace. A per-test claim anchor restores what each test
measures, which is what plan §A2 怎么做 6 asks for ("普通测试应使用独立的 claim namespace")
and what six sibling R97 suites already do. The file went 17/17.

**Left alone, deliberately.** `r97-execution-state-ownership.test.ts` fails the same way
when run after other suites in one process. It is outside A5's scope, imports neither
changed module, and fails inside frozen `r97-budget-ledger.ts`. Verified pre-existing:

```bash
# fails when the shared machine-global anchor already holds another suite's dirs
pnpm exec vitest run packages/evaluation/src/r97-execution-state-ownership.test.ts
# → 1 failed (CAMPAIGN_STATE_LOST)

# passes with an isolated anchor, proving the failure is the shared namespace
$env:R97_CAMPAIGN_CLAIMS_DIR = <fresh dir>
pnpm exec vitest run packages/evaluation/src/r97-execution-state-ownership.test.ts
# → 20 passed (20)
```

This is reported rather than silently fixed because it belongs to a different task's scope.

---

## 7. Honest limits

- **The PASS these tests produce is a protocol-fixture pass.** It comes from a synthetic arm
  written by the test file, not from the frozen benchmark arms. It supports **no** claim about
  model quality, win rate or promotability.
- **The offline path still proves nothing about the paid experiment.** That remains `NOT_RUN`.
- **Provider-id drift is not compared**, deliberately. Plan §A5 怎么做 4 allows the scripted
  substitute to differ from the approved provider; that relationship is modelled **separately**
  (`executingProviderId` / `providerIsOfflineSubstitute`) rather than generalised into "all
  provider differences are ignored".
- **A drift only observable after execution is still refused** (A5 怎么做 5), and the budget it
  already spent is **kept** — refunding it would be the silent re-grant the channel exists to
  prevent.
