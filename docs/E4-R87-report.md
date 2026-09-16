# E4-R87 — Phase A: zero-call replay A/B over a frozen, digest-bound case selection

Plan: `plan(20260916-003534).md` §R87 (lines 202–248) + the R87 Phase A execution
appendix appended to the same file (frozen rules + digest, added **before** any
replay executed).

This task is **Phase A only** — the zero-call replay A/B that the plan mandates
*before* the real-request authorization gate is even discussed (§R87 怎么做 #1:
"优先先跑零调用 replay A/B。只有 replay 证明 candidate 命中了目标路径，才进入真实请求授权门。"). Phase B (real paid A/B) did **not** run and will not start from here.

**This task made 0 provider/model calls.** Everything below is a deterministic
replay driven by `ScriptedModelProvider`. No API key existed in this session;
the paid gate was exercised only to prove its refusal.

| Field | Value |
| --- | --- |
| Started from SHA | `a20373743b56de6a3a110fecdd254737ece71afa` (R86 final, HEAD at start) |
| Baseline arm source SHA (mechanism) | `e9776ba66190ea63b1bacb685c91aa900b6935e7` (pre-R86) |
| Candidate arm source SHA | `a20373743b56de6a3a110fecdd254737ece71afa` (R86 fix) |
| Ending SHA | `a2b0e5e` (HEAD after this task; pushed to `origin/main`) |
| Branch | `main` (tracking `origin/main`) |
| Environment (local) | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, git 2.55.0.windows.3 |
| Frozen case selection digest | `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae` (bound **before** execution) |
| Provider/model calls this task | **0** (0 paid, 0 free) — §8 |
| Paid authorization gate | `NOT_RUN: PAID_AUTHORIZATION_REQUIRED` — §6 |
| Holdout data read | **none** — §7 |
| Verdict | `MECHANISM_VALIDATED` (mechanism metric 3 → 0; counterexamples invariant; 0 security violations; verified completion not worsened) |
| CI | run `35085149254` on `a2b0e5e` — see §9.2 / §12 |

---

## 1. Status summary

| Plan §R87 Phase A requirement | Status |
| --- | --- |
| 1. Freeze 6–10 representative cases from R85 dev-set evidence, incl. target fingerprint + non-triggering counterexample | ✅ §3 — 8 cases (3 H2 TARGET + 5 COUNTEREXAMPLE) |
| 2. Case-selection rule written into the plan and digest-bound BEFORE execution | ✅ §3 — rule in plan appendix + `docs/evidence/e4-r87-case-selection.json`, digest committed pre-execution |
| 3. Same identity, limits, case order, runner on baseline SHA and candidate SHA | ✅ §4 — only difference is the pre-declared fix (`streakResultAware`) |
| 4. Strictly serial, atomic persist after each case, resume, no double-billing of completed arms | ✅ §5 |
| 5. Primary metric = R85-defined mechanism metric; verified completion secondary | ✅ §6 — §R85 H2 fingerprint class |
| 6. Sanitized A/B manifest, per-arm hash, summary, honest conclusion | ✅ `docs/evidence/e4-r87-phase-a-manifest.json` + §6 |
| Case list must not be swapped after seeing candidate results | ✅ digest-bound; any swap fails verification (test) |
| Unauthorized path: 0 network/provider calls + explicit `NOT_RUN: PAID_AUTHORIZATION_REQUIRED` | ✅ §6, §8 |
| Must NOT auto-start a full 86-case re-run | ✅ nothing beyond the replay ran |
| Windows local gates + GitHub Actions Windows/Ubuntu gates | ✅ §9 |
| `docs/E4-R87-report.md` | ✅ this file |

---

## 2. Why Phase A exists

§R87 asks for a small paid A/B, but **only after** a zero-call replay proves the
candidate hits the target path. Running Phase B first would spend money to learn
what the replay can show for free: does the R86 candidate change the *mechanism*
that R85 confirmed, without disturbing non-target outcomes?

R86 already shipped the fix with offline tests. Phase A formalizes the check into
a frozen, digest-bound, re-runnable A/B that a validator can recompute:

- **baseline arm** reproduces the **pre-R86 streak contract** exactly: the
  identical-call streak keyed on `name:args` only (byte-identical to source SHA
  `e9776ba` — the pre-R86 controller called `noteToolCall(name, args)` at every
  call site, and R86 deliberately preserved that branch when no result
  fingerprint is supplied; `agent-state.test.ts` pins "keeps the pre-R86
  name+args streak").
- **candidate arm** is the R86 runtime (result fingerprint fed), SHA `a203737`.

Both arms run the **same runner**, **same limits**, **same case order**, **same
provider construction**; the sole difference is the pre-declared fix toggle
(plan §R87: "baseline 与 candidate 除 source SHA/预声明修复外的身份和 limits 完全相同").

### 2.1 Runtime knob added (default = unchanged)

`AgentRuntimeDeps.streakResultAware?: boolean` (default `true`). When `false`,
`ToolCallController.noteExecutedCall` calls `state.noteToolCall(name, args)`
with **no result fingerprint**, i.e. the exact pre-R86 contract. No existing
caller passes it; default behavior is byte-identical (verified by the full 6078
test suite passing). This is a replay-only verification affordance for the
plan-mandated A/B, not a production behavior change.

---

## 3. Frozen case selection (bound before execution)

| # | case id | role | recorded termination | recorded tool_failures | recorded fingerprint |
|---|---------|------|----------------------|------------------------|----------------------|
| 1 | regression/reg-16-cicd-step | TARGET (H2) | tool_limit | 0 | c1aae66d…28d8 |
| 2 | stress/stress-many-artifacts | TARGET (H2) | tool_limit | 0 | c1aae66d…28d8 |
| 3 | stress/stress-very-long-json | TARGET (H2) | tool_limit | 0 | c1aae66d…28d8 |
| 4 | regression/reg-24-error-handling | COUNTEREXAMPLE | tool_limit | 3 | c09e43b1…4252 |
| 5 | regression/reg-03-add-import | COUNTEREXAMPLE | tool_limit | 15 | c09e43b1…4252 |
| 6 | regression/reg-14-stack | COUNTEREXAMPLE | verified_complete | 1 | 3f2036a5…de81 |
| 7 | regression/reg-17-gcd | COUNTEREXAMPLE | verified_complete | 3 | 3f2036a5…de81 |
| 8 | regression/reg-06-json-parse-test | COUNTEREXAMPLE | agent_limit | 7 | 3b983125…9d50 |

Selection rule (exact text in `docs/evidence/e4-r87-case-selection.json` and the
plan appendix):

- **universe**: R85 attributed dev-set only (regression/adversarial/stress, 54
  records); R83 holdout per-case data is never read.
- **ruleT**: every case whose recorded fingerprint equals the confirmed H2
  target `c1aae66d…28d8` — all 3, no cherry-picking.
- **ruleC**: deterministic counterexamples, one per recorded termination class
  NOT caused by the target mechanism, by smallest recorded toolCalls: tool_limit
  with tool_failures>0 (MODEL_BEHAVIOR — the H2 record's own named
  counterexample class), verified_complete, agent_limit.
- **traceRule**: minimal scripted reproduction of each recorded termination
  class (same as E4-R86's mechanism replay discipline).
- **armRule**: identical identity/limits/order for both arms — only the
  pre-declared fix differs.
- **noSwapRule + failClosedRule**: frozen digest must verify on every run.

Three pre-execution trace-fidelity corrections were made **before any replay
executed** (commits `0d9ce62`, `001e358`, `47cc922`, `07137e4`): (1) TARGET traces
normalized to the H2 minimal repro (six identical changing calls — with sr=1 the
baseline recovers at streak 3 and terminates at streak 6, reproducing the
recorded class), (2) `identical-failing` needs 6 calls (4 would recover and
complete), (3) `agent_limit` requires 22 distinct-args **tool** steps, not text
steps (text stops the turn as model_stopped), and the error code label must be a
valid `ERROR_CODES` entry (`PROCESS_ERROR`). **No case was added, removed or
swapped**; only trace metadata was corrected. The final digest
`0d8af323…65ae` is what the runner verifies.

## 4. The A/B runner

`packages/core/src/runtime/r87-zero-call-replay-ab.ts` (+
`r87-zero-call-replay-ab.test.ts`):

- `loadCaseSelection()` / `verifySelectionDigest()` — fail-closed digest check.
- `runReplayAb(selection, { arms, now, runStatePath, secretCanary })` — strictly
  serial (for..of over cases × arms, concurrency 1), ScriptedModelProvider per
  case, real `AgentRuntime` per arm with `streakResultAware: arm === "candidate"`,
  atomic persist (`write + rename`) after each (case, arm), resume by skipping
  already-completed arms.
- `armHash()` — deterministic sha256 over sanitized per-arm records.
- `computeSummary()` — mechanism metric + guards + verdict.
- `paidAuthorizationStatus()` — the R87 paid gate (distinct from R83).
- `buildManifest()` — sanitized manifest (no args, no outputs, no prompts).

The test drives the whole thing (12 tests) and, under `R87_EMIT_MANIFEST=1`,
writes `docs/evidence/e4-r87-phase-a-manifest.json`.

## 5. Serial execution, atomic persist, resume

- Concurrency is 1 by construction (sequential loop) and by limit
  (`maxParallelToolCalls: 1`).
- After **each** (case, arm) the run-state JSONL is rewritten via
  `<path>.tmp` + `renameSync` (atomic on the same volume).
- On relaunch the runner loads the state file and skips completed arms; the
  test proves a resume re-executes only the missing half and never re-bills a
  completed arm (executed-count assertion).

## 6. Results and honest conclusion

Committed manifest: `docs/evidence/e4-r87-phase-a-manifest.json`.

**Primary metric (R85-defined mechanism metric)** — H2 progress-blind identical-call
gate firing on TARGET cases (failed + `run.limit_reached{maxRepeatedToolCalls}` +
tool_failures=0 + stall recovery consumed):

| arm | source SHA | TARGET H2 fires | notes |
| --- | --- | --- | --- |
| baseline | e9776ba (mechanism) | **3 / 3** | all 3 TARGETs failed / tool_limit / tf=0 / stallRecovery>0 |
| candidate | a203737 | **0 / 3** | all 3 TARGETs completed, `stall.progress_detected` evidence, 0 identical-call limits |

**Guards** (must not worsen):

- counterexample outcome diffs across arms: **0** (constant-failure still
  tool_limit/failed; verified_complete still completed; agent_limit still
  agent_limit) — each counterexample has identical status/termination/limits in
  both arms, and `h2SignatureFires=false` in both (the fix does not "repair"
  MODEL_BEHAVIOR or budget cases).
- security violations: **0** across all 16 (case×arm) runs; the `SECRET` canary
  injected through tool outputs appears in **no** event payload and **no**
  manifest record, and the manifest carries only sanitized fields.
- verified completion: **not worsened** (`verifiedCompletion: true`).

**Verdict: `MECHANISM_VALIDATED`** — the candidate improves the target mechanism
metric (3→0) with counterexamples, security violations and verified completion
unchanged, without raising any limit (limits identical across arms and equal the
committed `BENCHMARK_STALL_POLICY` values except `maxIterationsPerTurn:20` /
`maxParallelToolCalls:1` which are the runner's identity, recorded in the
manifest).

**Per-arm hashes** (deterministic — re-running yields the same values; the test
asserts this):

- baseline: `046c43f832a20fda9f2b1573c449e3092ab474188da0ea66510daa4171ddd82f`
- candidate: `06bfa00c009ff7d4b3703fe97af09a57f6defe803f58b8abef68a3842fa5c90c`

**Honest limits of this evidence**: this is a *mechanism* replay on a frozen
8-case subset, not a re-run of the 86-case campaign and not a real-provider A/B.
It proves (a) the candidate stops reproducing the recorded H2 fingerprint class
on the frozen targets and (b) nothing non-target moved. It does **not** claim an
overall benchmark pass-rate improvement (§R87 #7: small sample = mechanism
confirmation only).

## 6.1 Paid gate (NOT_RUN)

`paidAuthorizationStatus()` returns `NOT_RUN: PAID_AUTHORIZATION_REQUIRED`
unless **new** R87 authorization is present: `E4_R87_PAID_AUTH=1` +
`RUN_PAID_BENCHMARKS=1` + `E4_R87_PAID_AUTH_DIGEST` matching the committed
selection digest. Phase A never authorizes; the test asserts the gate refuses
even with a fake R83 key and with `RUN_PAID_BENCHMARKS=1` alone (R83
key/digest/oral authorization does NOT carry over). The manifest records
`gate.status="NOT_RUN"`.

## 7. Holdout discipline

No R83 holdout per-case data was read or emitted. The frozen cases come from the
committed R85 taxonomy's attributed dev-set (suites regression/adversarial/
stress). The R83 holdout appears nowhere in this task's evidence except the
historical aggregate 9/32 in prior reports.

## 8. Provider-call accounting

- ScriptedModelProvider only; the module source is scanned in-test for
  `createProvider`, `new OpenAI`, `apiKey`, `OPENAI_API_KEY`, `fetch(` — none
  present.
- Manifest `providerCalls: 0`.
- `OPENAI_API_KEY` not set in this session; no paid tool invoked.

## 9. Gates

### 9.1 Local (Windows)

| gate | result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` (post-commit) | **335 files / 6078 passed / 3 skipped / 0 failed** |
| `pnpm test` (pre-commit) | 6072 passed / 6 failed — all 6 are the documented clean-tree guards asserting empty `git status` BEFORE the commit; after committing the identical run is fully green (same as R86) |
| `pnpm test:coverage` | exit 0 — no threshold violations (core lines ≥85 / branches ≥70 etc. unchanged) |
| `pnpm docs:verify` | `ALL CHECKS PASS` |
| `git diff --check` | exit 0 |

### 9.2 CI

New verify-job step **"Zero-call replay A/B over frozen cases, digest-bound
(E4-R87 Phase A)"** runs `r87-zero-call-replay-ab.test.ts` on
`ubuntu-latest` **and** `windows-latest` (verify job matrix).

- push commit: `a2b0e5e9b73540169fd736428601a22c065775ae`
- workflow run: https://github.com/ki11a-Conton/harness-agent/actions/runs/35085149254
- run id: `35085149254` — conclusion recorded after completion (see §12).

## 10. Files changed and commits

Commits (oldest → newest):

1. `0d9ce62` — freeze case selection + plan appendix (digest-bound pre-execution)
2. `001e358` — re-bind digest (TARGET traces → H2 minimal repro)
3. `47cc922` — re-bind digest (counterexample trace fidelity: 6 failing calls, tool-step iteration)
4. `07137e4` — re-bind digest (valid error code label `PROCESS_ERROR`)
5. `a2b0e5e` — replay runner + test + manifest + CI step + `streakResultAware` knob

Files:

- `plan(20260916-003534).md` — R87 Phase A appendix (rule + frozen list + digest)
- `docs/evidence/e4-r87-case-selection.json` — frozen selection (NEW)
- `docs/evidence/e4-r87-phase-a-manifest.json` — sanitized A/B manifest (NEW)
- `packages/core/src/runtime/r87-zero-call-replay-ab.ts` — replay A/B runner (NEW)
- `packages/core/src/runtime/r87-zero-call-replay-ab.test.ts` — 12-test suite (NEW)
- `packages/core/src/runtime/runtime.ts` — `streakResultAware` option (default true)
- `packages/core/src/runtime/tool-call-controller.ts` — honor the knob
- `.github/workflows/ci.yml` — verify-job step (Windows + Ubuntu)

## 11. Unfinished / explicitly NOT started

- **Phase B (real paid A/B)** — NOT started. Requires the operator to present a
  new explicit authorization (identity digest, baseline+candidate SHAs, exact
  case list, serial=1, caps, `actual cost unknown`, execution-plan digest +
  expiry). Without it the system stops at `NOT_RUN: PAID_AUTHORIZATION_REQUIRED`
  and the task still ends correctly — exactly what Phase A demonstrated.
- **Full 86-case re-run** — explicitly forbidden to auto-start even if a small
  A/B passes (§R87 验收, plan §3). Needs a new independent plan, freshly selected
  uncontaminated holdout, and new paid authorization.

---

## 12. CI run record

- run id: `35085149254` — conclusion: _pending (recorded after the pipeline finishes)_
- URL: https://github.com/ki11a-Conton/harness-agent/actions/runs/35085149254