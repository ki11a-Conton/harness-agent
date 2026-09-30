# N4 — pricing expiry gates every physical send and retry (F30-5)

Plan: `plan(20260930-061557).md` §7. Task: `task-13`.

```text
任务：N4 — 把 pricing expiry 接入每一次物理发送与 retry（F30-5）
状态：DONE
实现 commit：git log --grep "N4/F30-5" --format=%H -1（见 "Commit" 一节说明）
起始基线：94a847a（review baseline）；driver HEAD 83f8ee8（clean tree）
修复的问题：见下 "Defect + trigger"
修改文件：见下 "Files"
反例：见下 "Counter-example"
实际命令：见下 "Commands"
测试结果：见下 "Results"
Windows：本地 dev 验收，本文件
Ubuntu：NOT_RUN（由 GitHub Actions / N6 负责）
付费模型请求数：0
离线 physical generate 数：见下 "Counters"
实际 tool dispatch 数：0（本任务不涉及 tool dispatch）
未知消费/未结算项：见下 "Counters"
原始证据：本文件 + 下列测试文件
剩余问题：见下 "Residual limits"
```

## Commit

The implementation is the single commit on top of driver HEAD
`83f8ee8ed6eaed89d0e413eb7922f7f55dcaa4fe`, with subject:

> `fix(evaluation): N4/F30-5 — pricing expiry gates every physical send and retry`

Review baseline `94a847a`. Four files, ~977 insertions / 4 deletions, and no other
path. The commit's exact SHA is reported in the handoff message and is always
recoverable with `git log -1 --format=%H` (or
`git log --grep "N4/F30-5" --format=%H -1`), which is the authoritative record.

This document deliberately does NOT embed its own commit's SHA: the evidence file
is part of that commit, so any embedded SHA would be invalidated by the next amend
(the commit hash covers the file that would contain it). The subject line above is
stable across amends and is what the SHA is resolved from.

Not pushed — the Lead handles pushing.

## Defect + trigger

**Defect (F30-5).** `createFormalBudgetedProvider`
(`packages/evaluation/src/tool-call-efficiency-formal-run.ts`) received
`usdMicrosPerCall: number | null` and a campaign `deadlineAtMs`. It had **no
price-validity input at all**, and the admission call site passed only the
amount. An *amount* cannot express a *validity window*: a price that was correct
at admission and has since expired is indistinguishable from one that is still
valid. A campaign therefore kept sending — and, more importantly, kept
**retrying** — on a price nobody could still stand behind.

The observation type already carried the basis level, and its own comment stated
the gap outright: `usdMicrosPerCall` + `budget.maxUsdMicros` alone cannot bind the
basis. `AUTHORIZATION_EXPIRED` is a **different** concept (the authorization
window at admission) and is not a substitute.

**Trigger.** A frozen pricing basis whose window covers admission, plus a clock
that advances past `expiresAtMs` before a later physical send or retry:

* old behaviour: the send **left the process** (transport entered) — the retry
  became a second billed request on an expired price;
* new behaviour: the send is refused with a `PRICING_*` error, the transport is
  never entered, and the already-dispatched attempt still settles at its
  **original** reservation.

## The change

1. **`PricingExecutionGuard`** — a narrow, frozen value object carrying the few
   facts the send path must re-check: amount, basis digest, source level,
   currency, `issuedAtMs`/`expiresAtMs`, covered vs required token ceiling, and an
   optional expected basis digest. It is a **narrow type, not the resolved CLI
   basis**, because `packages/evaluation` must not depend on `apps/cli`. The caller
   resolves it once and hands over a snapshot, so a later environment change
   cannot silently "refresh" the price mid-campaign.
2. **`checkPricingExecutionGuard(guard, nowMs)`** — one pure pre-send decision,
   returning a `PRICING_*` reason or `null`. If a caller supplies no guard, the
   pre-change behaviour is preserved exactly.
3. **Two gates in the real wrapper** — the *initial send* boundary (checked
   **before** any cost/ledger reservation, so a refused send strands nothing) and
   the *retry* boundary (checked **before** the retry's reservations and before
   the retry leaves). A retry is a new billable request, so it re-checks the same
   frozen basis against the current clock.
4. **Separate classification.** New codes `PRICING_WINDOW_EXPIRED`,
   `PRICING_NOT_EXECUTABLE`, `PRICING_COVERAGE_INSUFFICIENT`,
   `PRICING_BASIS_DRIFT`, thrown as `E4-N4: …` and counted in a new
   `stats.pricingRefusedCalls`. A pricing refusal is **never** a provider/transport
   error, so it cannot be swallowed and re-driven by an outer retry loop.
5. **Admission threading** — `openPreregisteredCampaignGate` accepts
   `pricingGuard` and hands it to `createFormalBudgetedProvider`, so the production
   path actually passes it rather than it being an unused option.

### Timezone / millisecond boundary handling

* All comparisons are on **absolute epoch milliseconds**. No local time, no
  timezone, no date parsing inside the gate — the guard carries integers, so a
  machine in any timezone behaves identically.
* The window test is `nowMs >= expiresAtMs`: a price is valid **up to but not
  including** its expiry instant. This matches `checkAuthorizationV2` (`nowMs >=
  auth.expiresAtMs`) and `pricingExecutionEligibility` in `apps/cli`, so the two
  layers cannot disagree by one millisecond.
* `nowMs < issuedAtMs` is a separate "not yet effective" refusal.
* Pinned by test **N4.8**: `expiresAtMs - 1` ⇒ the send happens; `expiresAtMs`
  exactly ⇒ refused. ISO strings appear only in the human-readable message, which
  is rendered with `toISOString()` (UTC) and is never compared.

## Files

| File | Change |
| --- | --- |
| `packages/evaluation/src/tool-call-efficiency-formal-run.ts` | guard type, `checkPricingExecutionGuard`, the four `PRICING_*` codes, `stats.pricingRefusedCalls`, the initial-send and retry gates, `pricingGuard` on both the wrapper opts and the campaign-gate opts |
| `packages/evaluation/src/tool-call-efficiency-pricing-send-guard.test.ts` | **NEW** — the 9 behavioural tests driving the real wrapper |
| `packages/evaluation/src/tool-call-efficiency-pricing-basis-wiring.test.ts` | +W15: end-to-end proof that the gate threads the guard into the ADMITTED send path |

## Counter-example (old vs new, and does it traverse the production path?)

**Yes — every case below calls the real production path.**
`createFormalBudgetedProvider(...).provider.createClient(...).generate(...)` is
driven, and W15 additionally goes through the shipped
`openPreregisteredCampaignGate` and then drives the **ADMITTED** provider's own
`generate`. No test asserts only on `checkPricingExecutionGuard`'s return value;
that is the exact "helper test green instead of production send acceptance"
failure the plan forbids.

| Scenario | Old behaviour | New behaviour |
| --- | --- | --- |
| price already expired at send time (N4.1) | transport entered, request sent | transport entered **0** times, `E4-N4: PRICING_WINDOW_EXPIRED`, 0 reservations stranded |
| valid at admission, expired at the retry (N4.2) | retry became a **2nd physical send** | exactly **1** send; retry refused before leaving; first attempt settled conservatively |
| expired before admission (N4.3) | sent | 0 sends, refused |
| coverage below the envelope (N4.4) | sent | 0 sends, `PRICING_COVERAGE_INSUFFICIENT` |
| no windowed validity / legacy (N4.5) | sent | 0 sends, `PRICING_NOT_EXECUTABLE` |
| basis digest drift (N4.6) | sent | 0 sends, `PRICING_BASIS_DRIFT` |
| LIVE window (N4.7 control) | sent | still sends (the gate is not a blanket refusal) |
| boundary ±1 ms (N4.8) | sent at expiry | sends at `-1 ms`, refused at exactly `expiresAtMs` |
| resumed new request after expiry (N4.9) | sent | 0 sends on the resumed campaign |
| **end-to-end (W15)** | ADMITTED campaign sent on an expired price | ADMITTED campaign's `generate` refused, transport **0**, `pricingRefusedCalls == 1`; the live-window control sends |

### Mutation evidence (the tests genuinely catch the defect)

Each gate was disabled in turn and the suite re-run:

* retry gate disabled ⇒ **N4.2 fails** (1 failed | 8 passed);
* initial-send gate disabled ⇒ **7 fail** (7 failed | 2 passed).

Both gates are load-bearing; neither is decorative. Restored and re-verified after.

## Commands

```text
npx vitest run packages/evaluation/src/tool-call-efficiency-pricing-send-guard.test.ts
npx vitest run packages/evaluation/src/tool-call-efficiency-pricing-basis-wiring.test.ts
npx vitest run packages/evaluation/src/tool-call-efficiency-pricing-send-guard.test.ts \
  packages/evaluation/src/tool-call-efficiency-pricing-basis-wiring.test.ts \
  packages/evaluation/src/tool-call-efficiency-pricing-admission.test.ts \
  packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts \
  packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts \
  packages/evaluation/src/prereg-n0-gaps.test.ts \
  apps/cli/src/prereg-declared-pricing.test.ts
npx tsc -b
```

The full `pnpm test` / `pnpm build` are deliberately **NOT_RUN** here: task-12/N1
is editing different files in the same working directory this wave, and the Lead
runs the full suite at the end of the wave.

## Results

| Command | Result |
| --- | --- |
| `npx vitest run …pricing-send-guard.test.ts` | **9 passed (9)**, exit 0 |
| `npx vitest run …pricing-basis-wiring.test.ts` | **16 passed (16)**, exit 0 |
| combined targeted regression (7 files) | **6 files passed, 144 passed (144)**, exit 0 |
| `npx tsc -b` | **exit 0** |
| RED before the implementation | 8 failed \| 1 passed (control only) |
| mutation: retry gate off | 1 failed \| 8 passed |
| mutation: initial gate off | 7 failed \| 2 passed |

Preserved and still green: the legacy-refusal suite (`prereg-declared-pricing`,
73 tests incl. the F6.10 production assertion), duplicate-key / unknown-field /
illegal-number / forged-`provider_verified` tests, the N0 gap suite, the
deadline suite (`tool-call-efficiency-tool-budget`, incl. the mid-stream stall
case) and the formal gap suite.

## Counters (measured, per test)

`factory` = provider-factory entries; `attempt` = physical transport entries;
`reserve` = cost reservations; `settle` = charged USD micros.

| Test | factory | physical attempts (sends) | reserve | settle (charged µUSD) |
| --- | --- | --- | --- | --- |
| N4.1 expired at send | 1 (gate builds the provider) | **0** | 0 (refused before reserving) | 0 |
| N4.2 expired at retry | 1 | **1** | 1 (initial only) | > 0 — conservative, original reservation |
| N4.3 expired pre-admission | 1 | **0** | 0 | 0 |
| N4.4 coverage short | 1 | **0** | 0 | 0 |
| N4.5 legacy, no window | 1 | **0** | 0 | 0 |
| N4.6 basis drift | 1 | **0** | 0 | 0 |
| N4.7 control (live window) | 1 | **1** | 1 | > 0 (measured usage) |
| N4.8 boundary | 1 each | **1** at `-1 ms`, **0** at expiry | 1 / 0 | > 0 / 0 |
| N4.9 resume after expiry | 1 | **0** | 0 | 0 |
| W15 end-to-end | 1 per campaign | **0** expired, **1** live control | 0 / 1 | 0 / > 0 |

**Paid requests = 0.** The transport is an in-process async generator; no key is
read, no endpoint is contacted, no network is used.

**Unknown consumption / unsettled items = null** (none). Every dispatched attempt
in these tests either completed with usage or settled at its reserved upper bound;
nothing was left unsettled, and no case wrote `0` merely because a price expired —
N4.2 asserts the opposite: the already-sent attempt settles at its **original**
reservation rather than being refunded to zero.

## How the acceptance table is satisfied

| plan §7 row | Status | Where |
| --- | --- | --- |
| legacy with no valid window | **satisfied this round, at the send path** | N4.5 (0 sends, `PRICING_NOT_EXECUTABLE`). The review/run/resume refusal was already delivered in S5/F6 (`legacy_not_executable`); this adds the send-boundary enforcement. |
| expired before admission | satisfied | N4.3 (0 sends, explicit pricing error) |
| expired after admission, before first send | satisfied | W15 (ADMITTED, then transport 0) |
| first attempt fails → backoff → price expires | satisfied for the send/retry semantics | N4.2 (first attempt settles conservatively; **no second physical send**) |
| price expires after the request was sent | satisfied | N4.2 (original reservation retained, settles > 0, never refunded to zero) |
| valid operator-declared window | satisfied (control) | N4.7 + W15 live control (ADMITTED and sends) |
| env conflict / basisDigest drift / insufficient coverage | satisfied at the send layer | N4.6 (`PRICING_BASIS_DRIFT`), N4.4 (`PRICING_COVERAGE_INSUFFICIENT`); the env-conflict admission refusals remain in the S5/F6 suites |

## Residual limits (declared, not hidden)

1. **`pricingGuard` is optional, and the CLI does not yet pass it.** The guard is
   enforced whenever it is supplied, and `openPreregisteredCampaignGate` threads
   it through end-to-end (W15). The production **CLI** does not yet construct one,
   because `apps/cli/src/prereg-command.ts` and `prereg-production-runner.ts` are
   READ-ONLY for this task (owned by N2 next wave). Until N2 wires it, the send
   gate is proven-but-not-yet-armed on the real CLI entry point. **This is the one
   acceptance item this task cannot close from its write scope**, and it is stated
   as a gap rather than as done.
2. **Backoff itself is not modelled.** No case sleeps through a real backoff
   timer; the clock is advanced deterministically at the retry event. The
   send-boundary semantics are covered; wall-clock backoff timing is not.
3. **Ubuntu: NOT_RUN.** Local Windows only, per plan §2 item 6.
4. **Full `pnpm test` / `pnpm build`: NOT_RUN** by instruction (task-12/N1 shares
   this working directory this wave).
5. Only `generate`'s send path is covered. `listModels` performs no billed send
   and is not gated.
