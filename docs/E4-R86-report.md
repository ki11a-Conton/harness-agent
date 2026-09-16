# E4-R86 — Fixing the one confirmed harness defect: a progress-blind identical-call gate

Plan: `plan(20260916-003534).md` §R86.

R85 produced exactly one `CONFIRMED_HARNESS_DEFECT` (**H2**) and one candidate that
deliberately failed the evidence bar (**H1**, `BELOW_SAMPLE_BAR`). R86 is therefore
authorised to fix **one** defect, at its narrowest responsible layer, with a
RED → GREEN reproducer, a counterexample, a security regression, and structured
evidence that the fix path is actually reachable.

**This task made 0 provider calls.** Nothing below claims a real-channel pass-rate
improvement — R86 has no paid evidence, so no such claim would be honest.

| Field | Value |
| --- | --- |
| Starting SHA | `e9776ba66190ea63b1bacb685c91aa900b6935e7` |
| Ending SHA (implementation) | `ec91c286653706c827e34670efc945356619024e` |
| Branch | `main` (tracking `origin/main`) |
| Environment (local) | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, git 2.55.0.windows.3 |
| Defects fixed | **1** of the maximum 2 (H2). H1 was not eligible (`BELOW_SAMPLE_BAR`). |
| Provider/model calls this task | **0** (0 paid, 0 free) — §9 |
| Cases re-run this task | **0** |
| Holdout data read | **none** — §8 |
| CI | run `35072796456` — **all 5 jobs success**, R86 step green on windows + ubuntu (§10.3) |
| Verdict | H2 fixed; fix path observable on Windows + Ubuntu |

---

## 1. Status summary

| Plan §R86 requirement | Status |
| --- | --- |
| 1. Turn the R85 minimal reproducer into a FAILING test, record RED | ✅ §3 — RED captured verbatim |
| 2. Fix at the narrowest responsible layer | ✅ §4 — `agent-state.ts` streak key |
| 3. Preserve security / budget / recovery / audit boundaries | ✅ §6, §7 |
| 4. Add structured events/metrics so the fix path is observable | ✅ §5 |
| §R86.2 fingerprint = normalized tool name + redacted args + result status | ✅ §4.2 |
| §R86.2 only "repeated AND result unchanged" is a stall | ✅ §4.3 |
| §R86.2 first trigger → structured feedback, terminate only past an explicit threshold | ✅ §4.3 |
| §R86.2 must not misjudge polling / pagination / retry / incremental edits | ✅ §4.4, §6.2 |
| §R86.2.5 threshold must enter the effective config AND execution-plan digest | ✅ §5.3 |
| §R86.5 must NOT raise `maxToolCalls`/worker/`maxIterationsPerTurn`/timeout as the fix | ✅ §4.5 — no limit was raised |
| §R86.6 offline replay of R85 non-holdout traces | ✅ §6 |
| `docs/E4-R86-report.md` | ✅ this file |
| `pnpm build` / `test` / `test:coverage` / `docs:verify` / `git diff --check` | ✅ §10 |
| GitHub Actions Windows + Ubuntu, Ubuntu cold-start on a fresh checkout | ✅ §10.3 |
| Provider calls 0; no "real channel improved" claim | ✅ §9 |

---

## 2. The defect, restated precisely

Two independent mechanisms in this codebase already *knew* that a repeated call
whose **result changed** is progress, not a stall:

1. `AgentState.recordToolCall` documented it verbatim: *"The result fingerprint is
   supplied by the runtime so an identical call with a DIFFERENT result is
   progress, not a stall (avoids false positives)."*
2. `AgentState.priorResultChanged` **implemented** exactly that test, and
   `ToolCallController.recordStallTrace` called it for read-only tools.

But the gate that actually **terminated the turn** — the identical-call streak in
`AgentState.noteToolCall`, consumed in `runtime.ts` as
`run.limit_reached{limit:"maxRepeatedToolCalls"}` — keyed the streak on
`name:args` **only**. It never consulted the result fingerprint. So a
verification/polling loop that kept producing *new* evidence was counted as
stagnation and killed. `recordProgress`/`clearStallWindow` cleared `recentTraces`
but never reset `identicalToolStreak`, so the progress signal could not rescue it
either.

R85's fingerprint for this defect is
`c1aae66dc97dd795d058737188f59d9a4ccf0da41b3b0054eb86d5c3f14b28d8` over **3**
affected cases (`regression/reg-16-cicd-step`, `stress/stress-many-artifacts`,
`stress/stress-very-long-json`), whose shared pattern is:

> `termination_reason=tool_limit` with **`tool_failures=0`** (not one tool call
> failed), `retry_taxonomy.stallRecovery>0` (the stall-recovery budget was fully
> consumed), and an artifact verifier whose check was **never reached** because
> the turn was terminated first.

The R85 record explicitly closed the alternative explanations: the absolute tool
budget never fired (`maxToolCalls` is 100; these cases recorded 4–12 tool calls),
the verifier never produced a judgement at all, and the provider never failed.

---

## 3. RED — the reproducer, flipped and recorded before any fix

The R85 reproducer `packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts`
was written as a *characterisation* test: it asserted the **buggy** behaviour
(terminate with `status=failed`) so that R86 would have a pin to flip. R86's first
act was to rewrite it as a permanent regression test asserting the **correct**
behaviour, run it, and capture the failure.

RED command:

```
npx vitest run packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts
```

RED result: **failed** — the runtime returned `failed` with
`run.limit_reached{limit:"maxRepeatedToolCalls",used:3,allowed:3}` where the test
now required `completed`, on six calls that each returned a *different* result.

The verbatim RED command, HEAD, test diff and failure output are captured in
`.ci/r86-red-evidence.txt` (git-ignored scratch). The assertions that failed are
the three flipped ones:

| Assertion | Buggy value (RED) | Required value (GREEN) |
| --- | --- | --- |
| final `status` | `failed` | `completed` |
| `maxRepeatedToolCalls` limit events | `1` | `0` |
| `stall.progress_detected` count | `0` | `>0` |

### 3.1 A second RED → GREEN cycle, found by reviewing my own fix

Making `resultFingerprint` **optional** introduced a new latent defect that the
first round of tests did not catch. The original branch

```ts
const sameResult = resultFingerprint !== undefined && … && equal;
this.identicalToolStreak = sameCall && sameResult ? wouldBe : 1;
```

returns `1` **forever** for any caller that omits the fingerprint, because
`sameResult` can never become true. That silently **disables stall termination**
for that caller — a safety-relevant degradation, not a cosmetic one.

RED command: `npx vitest run packages/core/src/state/agent-state.test.ts -t "supplies NO result fingerprint"`

RED output: `AssertionError: expected 1 to be 2` — `Tests 1 failed | 8 skipped`.

The fix branches explicitly: with no fingerprint the ORIGINAL pre-R86 contract is
preserved (same name+args advances the streak); with a fingerprint the
result-aware rule applies. This is recorded rather than quietly folded in, because
"the fix introduced a second bug" is exactly the kind of thing a report should not
hide.

---

## 4. The fix — narrowest responsible layer

### 4.1 Where the change went

The defect's own R85 record named the layer:

> `packages/core/src/state/agent-state.ts` (noteToolCall keys the streak on
> name+args only …) **as consumed at** `packages/core/src/runtime/runtime.ts`
> (the identical-call gate).

So the fix is in `AgentState.noteToolCall` — the streak key — and nowhere else.
No new module, no re-architecture, no new termination reason, no policy engine.

### 4.2 Fingerprint composition (plan §R86.2)

`ToolCallController.resultFingerprintOf(result)` builds the fingerprint from
**normalized result status plus redacted result identity**, never raw content:

| Result shape | Fingerprint input |
| --- | --- |
| `success` | `{status, output}` |
| `failed` + error | `{status, errorCode}` |
| anything else | `{status}` |

The status is part of the key on purpose: a `success → failed` flip is *feedback
the model can act on*, so it must break the streak too, not only an output change.
The args half of the key continues to use the existing `stableStringify(args)`
call key that the controller already computes.

The plan asks for "redacted args". The args key here is the **same key the
existing stall classifier already uses** (`computeArgsHash`/`stableStringify` over
the tool's structured arguments), and the observability payload emits only the
tool *name* and counts — never arguments, never output, never error text (§5.4).

### 4.3 "Repeated AND unchanged" is the only stall (plan §R86.2)

`noteToolCall` now distinguishes:

- **same call+args, same result** → the streak **advances** (a genuine stall).
- **same call+args, DIFFERENT result** → the streak **resets to 1** and the call
  is reported as observable progress.
- **different call or different args** → the streak resets to 1, and is *not*
  reported as progress (it is simply a different action).

The runtime's existing gate is unchanged in shape:

```ts
if (this.maxRepeatedIdenticalToolCalls > 0 && streak >= this.maxRepeatedIdenticalToolCalls) …
```

Because a changed result now yields `streak = 1`, the gate no longer fires on
progress. Termination still happens past an explicit threshold for a genuine
unchanged-result stall — proven by the counterexample test (§6.2), not merely
asserted.

### 4.4 Not misjudging legitimate polling / pagination / retry / edits

This is the requirement most easily satisfied on paper and violated in practice,
so it is tested directly rather than argued:

- **Polling / pagination** — six calls with the *same* args and *changing* results
  complete normally (`r85-h2-progress-blind-gate.test.ts`).
- **Incremental edits** — four calls with changing results complete normally, with
  **zero** stall recoveries consumed.
- **Retry after a real error** — a status flip breaks the streak, so a retry that
  changes the outcome is not counted as stagnation.
- **Genuine stall still detected** — six calls with a *constant* result still
  terminate, and still emit **no** progress event (§6.2).
- **A different tool / different args** still resets without being labelled
  progress (§6.3).

### 4.5 What was deliberately NOT done (plan §R86.5)

The plan forbids treating a budget increase as the fix. Verified against the diff:

| Limit | Before | After |
| --- | --- | --- |
| `maxToolCalls` | 100 | **100 (unchanged)** |
| worker count | 30 | **30 (unchanged)** |
| `maxIterationsPerTurn` | 30 | **30 (unchanged)** |
| turn timeout | 600 s | **600 s (unchanged)** |
| `maxRepeatedIdenticalToolCalls` | 3 (runtime default) | **3 (unchanged — now explicitly recorded, see §5.3)** |
| `maxStallRecoveries` | 1 | **1 (unchanged)** |
| `maxPatternStallRecoveries` | 1 | **1 (unchanged)** |

The stall thresholds were *pinned and recorded*, not *raised*. `BENCHMARK_STALL_POLICY`
carries the runtime defaults verbatim; the point is that they are now visible in
the effective config and digest, which is §R86.2.5.

---

## 5. Structured events and metrics — making the fix path observable

Plan §R86.4 requires that a future reader be able to tell whether the **fix path**
triggered, rather than inferring it from a final pass rate.

### 5.1 New event: `stall.progress_detected`

`runtime.ts` emits it immediately **before** the identical-call gate would run,
when and only when the just-executed call cancelled a pending streak:

```ts
if (progressCancelled === true) {
  await this.emit(sessionId, "stall.progress_detected", {
    tool: call.name,
    wouldBeStreak: wouldBeStreak ?? streak,
    allowed: this.maxRepeatedIdenticalToolCalls,
  }, turnId);
}
```

The payload is deliberately tiny and secret-free: the tool **name**, the streak
that *would* have been counted without the cancel, and the configured allowance.
`wouldBeStreak` is what makes the event diagnostic — it shows how close the
progress-blind gate came to firing.

### 5.2 It is observability-only, never durable truth

`stall.progress_detected` was added to `EVENT_TYPES` and to the typed
`EventPayloadMap` (`StallProgressDetectedPayload`), but **NOT** to
`SEMANTIC_JOURNAL_EVENTS`. It is an observability delta: it does not alter
durable session truth, resume semantics, or replay. The CI step asserts this
negatively (§10.2) so a later change cannot quietly promote it.

### 5.3 The threshold is bound into the effective config and the plan digest (plan §R86.2.5)

Three wiring points, each covered by a test:

| Location | What it does |
| --- | --- |
| `BenchmarkEffectiveConfig.stallPolicy` (`packages/evaluation/src/manifest.ts`) | New optional field: `maxRepeatedIdenticalToolCalls`, `maxStallRecoveries`, `maxPatternStallRecoveries`, `enabledStallPatterns`. Optional so pre-R86 manifests stay readable. |
| `BENCHMARK_STALL_POLICY` (`apps/cli/src/benchmark-command.ts`) | Pins the values at the benchmark boundary and feeds the **actual** `new AgentRuntime({…})` construction, so the recorded config is the config in force. |
| `runtimeConfigForHash()` | Includes `stallPolicy`, so changing a stall threshold **moves `runtimeConfigHash`**. |

Two tests prove the binding rather than describing it:

- `manifest.test.ts` — *"the stall threshold is part of the effective config hash"*:
  `maxRepeatedIdenticalToolCalls: 2` produces a **different** `runtimeConfigHash`,
  and a repeat is deterministic.
- `benchmark-command.test.ts` — *"a stall-threshold change changes the plan digest
  (threshold is digest-bound)"*: a changed `stallPolicy` changes
  `preflightBenchmark(...).planDigest`, deterministically.

### 5.4 New metric: `stall_progress_cancellations`

`RunMetrics.stall_progress_cancellations` counts `stall.progress_detected` events.
It is **optional and absent when zero**, so pre-R86 serialized metrics stay
shape-compatible — an existing test (`trace-exporter.test.ts`) asserts an exact
`toEqual` on the metrics object and would otherwise have broken. That constraint
is the reason for the conditional spread, not an accident.

### 5.5 A security regression test pins the payload shape

`r85-h2-progress-blind-gate.test.ts` runs the fix with outputs carrying a canary
secret (`S3CR3T-canary-9f8e7d6c`) and asserts:

- **no** event payload of **any** type contains the canary; and
- the `stall.progress_detected` payload has **exactly** the keys
  `["allowed","tool","wouldBeStreak"]`.

So the new event cannot become a channel for raw output, arguments, or secrets,
and adding a field to it is a deliberate, test-visible act.

---

## 6. Offline replay over the R85 non-holdout record (plan §R86.6)

`packages/core/src/runtime/r86-h2-offline-replay.test.ts` (new, 209 lines) loads
the **committed** R85 taxonomy record
`docs/evidence/e4-r85-failure-taxonomy.json`, locates the H2 record by id
`H2-stall-gate-progress-blind`, and asserts the evidence it is replaying is really
the confirmed defect (`status === "CONFIRMED_HARNESS_DEFECT"`, the hex fingerprint,
the recorded samples). It then replays the mechanism with a
`ScriptedModelProvider` — **0 provider calls**.

### 6.1 Target trace — the fingerprint no longer occurs

Six calls, same args, changing results:

| Signal | Before R86 | After R86 |
| --- | --- | --- |
| final `status` | `failed` | **`completed`** |
| `maxRepeatedToolCalls` limit events | 1 | **0** |
| `stallRecoveries` | 1 | **0** |
| `stall.progress_detected` | 0 | **> 0** |

The target failure fingerprint is **gone**, and it is not silently gone: the fix
path that removed it is *counted* by the new event. This satisfies the plan's
"the target fingerprint count drops **or** is explicitly converted into a new
structured termination" — here it drops, and the replacement signal is explicit.

### 6.2 Non-target traces are unchanged

The plan requires the change to alter the **target** mechanism only. Three
non-target traces are replayed and pinned:

| Non-target trace | Required outcome | Result |
| --- | --- | --- |
| 6 × constant result (a REAL stall) | still `failed`; limits `1`; recoveries `1`; progress events **0** | ✅ |
| 4 × different args | `completed`; limits `0`; progress events **0** | ✅ |
| alternating A→B (`alternating_loop`, `maxPatternStallRecoveries: 0`) | still `failed`; `maxRepeatedToolCalls` limits **0** | ✅ |

The first row is the important one: the fix **did not disable stall detection**.
The third row proves the *pattern*-based stall path is untouched — a different
mechanism that must keep working.

### 6.3 Counterexample tests

- `r85-h2-progress-blind-gate.test.ts` — 6 constant-result calls still terminate,
  and emit **zero** `stall.progress_detected` events. If the fix had simply
  weakened the gate, this test would fail.
- `agent-state.test.ts` — an unchanged result still advances `1, 2, 3`; a
  different call or args resets **without** being labelled progress; and a
  fingerprint-less caller keeps the original name+args streak (§3.1).

---

## 7. Boundaries preserved (plan §R86.3)

The plan requires existing security, budget, recovery and audit boundaries to
survive. These were re-run as the regression gate:

| Boundary | Evidence |
| --- | --- |
| Termination reasons | `packages/core` full suite: **42 files / 490 tests green**, including the existing identical-call, args-differ and alternating-pattern tests |
| Resume semantics | Resume/session suites green; `resetToolStreak` now also clears the result-aware state so a post-recovery streak cannot inherit stale fingerprints |
| Budget | No budget was raised (§4.5); budget-exhaustion tests green |
| Permission | `packages/security` + the runtime/controller suites: **18 files / 2,193 tests green** |
| Secret redaction | Canary test (§5.5) plus the existing secret-redaction suites green |
| Audit / event contract | `stall.progress_detected` is observability-only (§5.2); `packages/contracts` suite green |

`resetToolStreak()` clearing the new fields matters specifically for **recovery**:
the runtime calls it after a stall recovery, and a stale
`lastResultFingerprint`/`lastToolCallKey` would otherwise let a resumed streak
compare against a pre-recovery call.

---

## 8. Holdout discipline

Unchanged from R85 and re-stated because R86 touches the runtime: **no holdout
per-case data was read, printed, or committed by this task.** The only holdout
figure anywhere in R86 is the aggregate already published by R83/R85. The replay
test reads the *committed non-holdout* taxonomy record and nothing else.

---

## 9. Provider-call accounting

**0 provider calls, 0 paid, 0 free. 0 benchmark cases re-run.**

Every R86 test drives `ScriptedModelProvider` (in-memory scripted events). The new
CI step runs those same offline suites. No API key, no endpoint, no network is
required by any R86 test or CI step, and the benchmark path was not executed.

Because there is no paid evidence, this report makes **no claim** that the real
channel's pass rate improved. What is proven is narrower and honest: the
confirmed defect's mechanism is fixed, the fix path is observable, and non-target
mechanisms are unchanged.

---

## 10. Gate results

### 10.1 Local gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm build` | ✅ exit 0 |
| `pnpm test` | ✅ post-commit: **334 files / 6,066 passed / 3 skipped / 0 failed** |
| `pnpm test:coverage` | ✅ exit 0, **90.29% statements / 81.77% branches**, all per-package thresholds met |
| `pnpm docs:verify` | ✅ `ALL CHECKS PASS` |
| `git diff --check` | ✅ exit 0 (§10.1.2) |
| Provider calls | **0** |

#### 10.1.1 The six pre-commit failures, and why they are expected

Running `pnpm test` **before committing** reports 6 failures in
`e4-r55-failure-wiring.test.ts` (1), `e4-09-production-e2e.test.ts` (4) and
`benchmark-command.test.ts` (1). These are **clean-tree guards**: they assert
`git status --short` is empty, because the production benchmark refuses to produce
a promotion-eligible run on an uncommitted tree. They fail on *any* uncommitted
change and they name the dirty entries in the failure message. The same six fail
on a clean checkout with an unrelated file touched. They are **not** caused by
this task's code, and the pre-commit red is **not** claimed as a pass.

**Measured, before and after the commit:**

| Run | Files | Passed | Failed |
| --- | --- | --- | --- |
| pre-commit (dirty tree) | 3 failed / 331 passed | 6,060 | **6** (clean-tree guards) |
| post-commit (clean tree) | **334 passed** | **6,066** | **0** |

The six failures disappear purely by committing, with no code change in between —
which is exactly what a tree-state guard should do, and confirms they were never
regressions.

#### 10.1.2 A note on `git diff --check` and four CRLF-stored files

`git diff --check` initially reported trailing whitespace on added lines in four
touched files. The cause is **not** this task's content: their git blobs are
historically stored **with CRLF** (`git ls-files --eol` reports `i/crlf` for
`packages/contracts/src/contracts.test.ts`,
`packages/core/src/state/agent-state.test.ts`,
`packages/evaluation/src/manifest.ts`, `packages/observability/src/metrics.ts`),
so every added line ends in a CR, which the check reads as trailing whitespace.
This is the same false positive R84 documented for `ci.yml`, where one commit
produced 194 such warnings.

R84's fix for `ci.yml` was to pin the file to `text eol=lf`. That is the wrong
tool here: these are TypeScript sources whose real change is small, and pinning
them to LF would rewrite **every line** of each blob, burying a ~10-line change
under a whole-file renormalization. Instead `.gitattributes` declares the CR as
part of the line ending for exactly those four files:

```
packages/contracts/src/contracts.test.ts whitespace=cr-at-eol
packages/core/src/state/agent-state.test.ts whitespace=cr-at-eol
packages/evaluation/src/manifest.ts whitespace=cr-at-eol
packages/observability/src/metrics.ts whitespace=cr-at-eol
```

This is **byte-only** — no blob changes at all — and it was verified **additive**
in a scratch repository, not assumed:

| Case | Reported? |
| --- | --- |
| CRLF line, no real trailing space | not reported ✅ |
| LF line with real trailing spaces | **still reported** ✅ |
| CRLF line with real trailing spaces | **still reported** ✅ |
| blank line at EOF | **still reported** ✅ |

It therefore never suppresses a genuine whitespace error. As an independent check,
the added lines of those four files were scanned directly for a real trailing
space or tab with the CR stripped: **0** found.

### 10.2 CI step added

A new step, *"Stall-gate fix — structured evidence is observable (E4-R86)"*, runs
on **both** `windows-latest` and `ubuntu-latest`. It asserts the fix path is
reachable and observable, not merely that a pass rate moved:

1. the three offline H2 suites (reproducer, replay, state) are green;
2. the stall-threshold **digest-binding** test is green;
3. `stall.progress_detected` is declared and typed, and is **absent** from
   `SEMANTIC_JOURNAL_EVENTS` (checked negatively, so it cannot be silently
   promoted to durable truth later);
4. the `stall_progress_cancellations` metric is derived;
5. the stall policy is present in the effective config and pinned at the
   benchmark boundary.

The step body was executed locally end-to-end before being committed, so a CI
failure would indicate a genuine platform difference rather than an untested
script.

### 10.3 CI verification

Run **`35072796456`** on the implementation commit
`ec91c286653706c827e34670efc945356619024e` — **all 5 jobs success**:

| Job | Result |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | ✅ success |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | ✅ success |
| `offline cold-start (ubuntu)` | ✅ success |
| `coverage gate (ubuntu)` | ✅ success |
| `release attestation (P38-12)` | ✅ success |

The new step *"Stall-gate fix — structured evidence is observable (E4-R86)"*
executed and passed on **both** `ubuntu-latest` and `windows-latest`, which is the
plan's cross-platform requirement. Ubuntu cold-start passed on a genuinely fresh
checkout (its own step asserts `no node_modules, no dist`), so the R86 sources
build from scratch on Linux and not merely on this Windows dev host.

---

## 11. Honest limits

- **One defect, not two.** H1 was `BELOW_SAMPLE_BAR` and was therefore not
  eligible for a fix. Nothing was invented to fill the second slot.
- **No pass-rate claim.** With 0 paid calls there is no evidence about real-model
  behaviour. The three H2 cases were *not* re-run against a real provider.
- **The replay is a mechanism replay, not a case replay.** It reproduces the
  defect's mechanism with a scripted provider; the stored R85 traces do not
  contain per-tool-call sequences, so an exact case-by-case replay is impossible
  from the committed evidence. This limitation was already recorded by R85 and is
  not papered over here.
- **The fix is conservative by design.** A fingerprint-less caller keeps the old
  name+args behaviour (§3.1), so the fix cannot weaken stall detection for a
  caller that does not participate in result-aware keying.
- **`wouldBeStreak` is diagnostic only.** It is not persisted, not used for any
  decision, and not part of durable truth.

---

## 12. Files changed

| File | Change |
| --- | --- |
| `packages/core/src/state/agent-state.ts` | **The fix.** `noteToolCall` takes an optional result fingerprint; the streak advances only on same call+args+result, resets on progress; new `lastCallCancelledStreak` / `lastCallWouldBeStreak` getters; `resetToolStreak` clears the new state |
| `packages/core/src/runtime/tool-call-controller.ts` | `resultFingerprintOf()` (status + redacted result identity); `noteExecutedCall()` helper used by all 5 settlement sites; `ExecutedToolCall` carries `progressCancelled` / `wouldBeStreak` |
| `packages/core/src/runtime/runtime.ts` | Emits `stall.progress_detected` before the identical-call gate; `DEFAULT_ENABLED_STALL_PATTERNS` exported |
| `packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts` | R85 characterisation test flipped into the permanent R86 regression test (+ counterexample + security regression) |
| `packages/core/src/runtime/r86-h2-offline-replay.test.ts` | **New.** Offline replay over the committed R85 taxonomy record; target + 3 non-target traces |
| `packages/core/src/state/agent-state.test.ts` | Unit tests: progress cancels, unchanged advances, different args/call resets, fingerprint-less fallback, `resetToolStreak` clears |
| `packages/contracts/src/event.ts` | `stall.progress_detected` added to `EVENT_TYPES` (observability-only) |
| `packages/contracts/src/event-payloads.ts` | `StallProgressDetectedPayload` + map entry |
| `packages/contracts/src/contracts.test.ts` | New event added to the non-semantic deltas list |
| `packages/observability/src/metrics.ts` | `stall_progress_cancellations` (optional; absent when zero) |
| `packages/evaluation/src/manifest.ts` | `BenchmarkEffectiveConfig.stallPolicy` |
| `packages/evaluation/src/manifest.test.ts` | Threshold is part of the effective config hash |
| `apps/cli/src/benchmark-command.ts` | `BENCHMARK_STALL_POLICY` pinned and bound into the digest inputs and the real runtime construction |
| `apps/cli/src/benchmark-command.test.ts` | Threshold change moves the plan digest |
| `.github/workflows/ci.yml` | New E4-R86 observability step on both platforms |
| `.gitattributes` | `whitespace=cr-at-eol` for the four historically CRLF-stored files (§10.1.2) |
| `docs/E4-R86-report.md` | This report |

---

## 13. Conclusion

R85's single confirmed harness defect is fixed at the layer its own evidence
named, with a RED → GREEN reproducer (twice — the second cycle caught a defect in
the fix itself), a counterexample proving stall detection still works, a security
regression proving the new event cannot leak, and an offline replay over the
committed taxonomy record showing the target fingerprint is gone while three
non-target traces are unchanged. The threshold is now bound into the effective
config and the execution-plan digest, and the fix path is countable through a new
observability-only event and metric.

No limit was raised, no architecture was rewritten, no holdout data was touched,
and **0 provider calls** were made. R87 — a paid, serial, non-holdout A/B under a
fresh explicit authorization gate — remains the only way to learn whether any of
this changes real-model outcomes.
