# E4 / N4 — really constrain tool calls (and run duration)

Plan: `plan(20260926-175819).md` §N4 (line 75).
Round baseline SHA: `67ded22917db084cfadb70c690d7d4babc95d91c`.
Pre-N4 HEAD: `e648ef0595e76702fe2eb890db326eb64b971756` (N0/N1a/N2/N3 landed).
Post-N4 HEAD: `35eeb5f4e45512b8abdf51c65c766d2be84965d1`.
Platform measured on: Windows 10 / PowerShell 7, Node `v24.14.0`, vitest `4.1.10`, pnpm workspace.

Rule this round: no real API key, no paid endpoint, no `paid:true` auto-authorization, no
promotion. Unknown values are `NOT_OBSERVED`, never `0`. Source-string matching is not used as
behavior evidence.

## 1. Labels (honest, per deliverable)

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N4.1 | The held tool reservation is an upper **bound**; a settle above it freezes the campaign | **PASS** | N4.1/N4.2: refusal + `charged.toolCalls` stays `0` + the reservation remains outstanding |
| N4.2 | A refused settle/charge writes **nothing** (all-or-nothing across dimensions) | **PASS** | N4.2: in-bound token actuals are NOT written when the tool dimension is over-held |
| N4.3 | `charge()` validates every dimension and enforces every cap | **PASS** | N4.3/N4.4/N4.5: negative, non-integer, over-cap and zero-quota cases all refuse and write nothing |
| N4.4 | The campaign tool dimension is **consumed** by the tool calls a run makes, and bounded | **PASS** | N4.6/N4.7: 2 declared tool calls charge exactly 2; above the cap freezes with `BUDGET_EXHAUSTED` |
| N4.5 | Two arms **share** one campaign quota; it survives a reopen (crash/restart/resume) | **PASS** | N4.8/N4.9: the second arm gets no fresh allowance; a reopened campaign still sees the charge |
| N4.6 | Reserve tool quota **before each physical `ToolOrchestrator` dispatch** (plan §N4 item 1) | **NOT_PROVEN** — not implemented | Tool consumption happens at the model-response boundary. No pre-dispatch reservation hook exists in the real tool path this round |
| N4.7 | Global wall-clock deadline injected into worker/provider/tool cancellation (plan §N4 item 3) | **NOT_PROVEN** — not implemented | No cross-worker deadline; `maxDurationMs` still binds by refusing the NEXT call |
| N4.8 | E2E observable for tool-charge values | **NOT_OBSERVED** | The offline E2E does not surface `charged.toolCalls`; its report has no tool-charge key. The script is unchanged and still passes 124/124 |
| N4.9 | Ubuntu applicability | **NOT_PROVEN** | All measurements are Windows-local; two-platform CI wiring is N7's scope |
| N4.10 | The offline closed loop keeps working after the budget tightened | **FIXTURE_PASS** | E2E exit `0`, `treeClean=true`, `ok=true`, 124/124 unchanged |

## 2. The defects being closed (measured, not assumed)

All three were RED counterexamples in the N0 gate before this change.

**(a) The tool dimension was not a bound.** `settle`'s held-bound check looped over
`["inputTokens", "outputTokens", "usdMicros"]` — `toolCalls` was absent, so an actual of `9` was
charged against a held reservation of `1`:

```
[N4] settling a toolCalls actual ABOVE the held reservation must be refused   → RED
```

**(b) `charge()` was completely unvalidated and uncapped.** It wrote whatever it was given:
`charge({ inputTokens: -5 })` resolved and durably wrote `-5`, silently **crediting** the campaign;
an over-cap charge was recorded as if the bound had been respected.

```
[N4] charge() must reject a NEGATIVE actual instead of writing it into the ledger   → RED
```

**(c) The tool dimension was inert.** `costDeltaForAttempt()` reserved `toolCalls: 0` for every
attempt and the settle path never passed a tool count, so `maxToolCalls` could never be consumed —
no matter how many tools a run invoked.

```
[N4] a completed call that CARRIES tool calls must consume the maxToolCalls dimension   → RED
```

## 3. Change list

`packages/evaluation/src/tool-call-efficiency-formal-run.ts`
- `CostBudget.settle`: the held-bound check now includes `"toolCalls"` alongside
  `inputTokens`/`outputTokens`/`usdMicros`, so a tool actual above the pre-send reservation throws
  and freezes the campaign instead of being charged. The check runs **before** any mutation, so a
  refused settle releases nothing and charges nothing (all-or-nothing). Docstring updated.
- `CostBudget.charge`: now performs the same static validation as `settle` (every dimension must be
  a non-negative safe integer, checked outside the lock) and enforces **every** cap under the same
  campaign lock (`charged + reserved + delta` must fit each dimension), throwing
  `E4-N3: BUDGET_EXHAUSTED: charge refused — …` **before** mutating, so a refused charge writes
  nothing.
- `FormalBudgetStats` gained `chargedToolCalls: number` (additive).
- `createFormalBudgetedProvider`: the `completed` branch now accumulates
  `ev.result.toolCalls.length` and, after the token/USD settle, consumes that count via
  `costBudget.charge({ toolCalls })`, incrementing `stats.chargedToolCalls`. A comment records why
  this is a `charge` and not a `settle` (no pre-send tool bound exists at this layer) and that
  item 1's pre-dispatch reservation is not done here.

`packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` (new, 9 cases)
- Behavioral acceptance for the bound, all-or-nothing, `charge` validation/caps, zero quota,
  consumption, cap freeze, shared two-arm quota, and durability across a reopen.

## 4. Old RED → new GREEN

`pnpm test:n0-gaps` before N4: exit `1`, `Tests 8 failed | 4 passed (12)`.
`pnpm test:n0-gaps` after N4: exit `1`, `Tests 5 failed | 7 passed (12)` — the three N4
counterexamples are GREEN; the 5 remaining REDs are N5a/N5b and N6a/N6b/N6c (later tasks).

| Case | Pre-N4 | Post-N4 |
|---|---|---|
| `[N4]` settle `toolCalls: 9` over held `1` | charged `9` (accepted) | **REFUSED**, charged `0`, reservation still held |
| `[N4]` `charge({ inputTokens: -5 })` | resolved, wrote `-5` | **throws**, ledger stays `0` |
| `[N4]` completed response carrying 2 tool calls | `charged.toolCalls === 0` | `charged.toolCalls === 2` |

New suite: `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts`
→ exit `0`, `Test Files 1 passed`, `Tests 9 passed`:

| Case | Scenario | Asserted behavior |
|---|---|---|
| N4.1 | settle `toolCalls: 9` over held `1` | throws, charged `0`, reserved still `1` |
| N4.2 | refuse a settle whose tool actual is over-held while tokens are in-bound | charged tokens stay `0`; reserved untouched (all-or-nothing) |
| N4.3 | `charge` with negative / non-integer on each dimension | throws for each; ledger stays `0` on every dimension |
| N4.4 | `charge` over the tool cap | `BUDGET_EXHAUSTED`; charged stays at the cap value |
| N4.5 | `maxToolCalls = 0` | both `charge` and `reserve` for a tool call are refused |
| N4.6 | completed response carrying 2 tool calls | `charged.toolCalls === 2` |
| N4.7 | response carrying more tool calls than the cap | `BUDGET_EXHAUSTED`; charged stays `0` |
| N4.8 | two arms over ONE budget, cap `2` | first arm consumes `2`; second arm refused, still `2` |
| N4.9 | reopen the campaign from disk | the charge is still visible and a further tool charge is refused |

## 5. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `pnpm typecheck` | `0` | `tsc -b`, no diagnostics |
| `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` | `0` | `Test Files 1 passed`, `Tests 9 passed` |
| `pnpm test:n0-gaps` | `1` | `Test Files 2 failed (2)`, `Tests 5 failed | 7 passed (12)` — N4 GREEN; N5/N6 still RED (`.ci/n0/n4-n0gaps.log`) |
| `pnpm test:red-next-gaps` | `0` | `Test Files 2 passed`, `Tests 14 passed` (`.ci/n0/n4-rednext.log`) |
| affected suites (`tool-call-efficiency-formal-run`, `…-formal-gaps`, `prereg-command`, `prereg-formal-gaps`, `prereg-arm-executor`) | `0` | `Test Files 5 passed`, `Tests 115 passed` |
| `pnpm test` | `1` | `Test Files 6 failed | 370 passed (376)`, `Tests 23 failed | 7077 passed | 3 skipped (7103)` (`.ci/n0/n4-full.log`) |
| `pnpm build` | `0` | release CLI `apps/cli/dist` rebuilt |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n4.json` (clean tree) | `0` | `prereg-production-e2e: PASS` (`.ci/n0/e2e-n4.log`) |
| `pnpm docs:verify` (working tree as-is) | `1` | `FAIL package count` + `FAIL current plan entry (E4-00)` |
| `pnpm docs:verify` (only the user's two uncommitted deletions set aside) | `0` | `ALL CHECKS PASS` |

**Attribution of the `pnpm test` failures (measured).** Diffing the FAIL set of `.ci/n0/n3-full.log`
(pre-N4, 23 lines) against `.ci/n0/n4-full.log` (post-N4, 23 lines) yields an **empty diff in both
directions**: identical failing tests, identical count. Passing tests rose `7068 → 7077`, exactly
the 9 new N4 cases. N4 introduced **zero** new failures. The pre-existing failures are the same
load-sensitive set documented in [`E4-N3-report.md`](./E4-N3-report.md) §5
(`cli`, `benchmark-command`, `e4-09-production-e2e`, `e4-r55-failure-wiring`,
`e4-r77-baseline-oracle`, `r97-arm-worker-contract`).

Post-N4 HEAD: `35eeb5f4e45512b8abdf51c65c766d2be84965d1`.

## 6. Observable provider-factory / physical-request / cost values

Clean-tree E2E, `treeClean=true`, `ok=true`, **unchanged from N3**:

| Observable | Value |
|---|---|
| `positiveExecution.providerFactoryCalls` | `1` |
| `positiveExecution.physicalProviderCalls` | `124` |
| `positiveExecution.ledgerCommitted` / `ledgerRemaining` | `124` / `3596` |
| `positiveExecution.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveExecution.decision` | `INCONCLUSIVE` |
| `positiveForward.physicalStubRequests` | `124` |
| `positiveForward.ledgerGranted` / `committed` / `remaining` / `unknown` / `transportRetries` | `3720` / `124` / `3596` / `0` / `0` |
| `positiveForward.decision` / `decisionReasonCodes` | `INCONCLUSIVE` / `["EFFECT_BELOW_THRESHOLD"]` |
| tool-charge observable in the E2E report | **`NOT_OBSERVED`** — the script surfaces no `charged.toolCalls` key |
| `counts.externalProviderCalls` / `counts.costUsdMicros` | `NOT_OBSERVED` (nothing billed; paid run BLOCKED) |
| `readiness.paidExperimentRun` / `championPromotion` | `NOT_RUN` / `NOT_RUN` |

## 7. Windows / Ubuntu applicability

- All evidence above is Windows-local.
- The budget logic is pure in-process file arithmetic under a campaign lock; it has no platform
  branch, but it is **not** exercised on Ubuntu in this round. Ubuntu stays `NOT_PROVEN` (N7).
- The plan's §N4 acceptance asks for replayable offline tests on Windows **and** Ubuntu; only the
  Windows half is executed here. Per §N4 line 87, paid state remains **BLOCKED**.

## 8. Residual limits

1. **Item 1 is NOT implemented.** The plan requires reserving shared campaign tool quota *before
   each physical `ToolOrchestrator` dispatch*, settling by real dispatch/retry. What is
   implemented consumes the declared tool calls at the **model-response boundary**. Consequence:
   the guarantee is "the campaign tool dimension is consumed and hard-capped, and two arms share
   one durable quota", **not** "physical tool dispatches are limited before the quota is exceeded".
   The plan's dispatch-count acceptance criterion is therefore **NOT_PROVEN**, and this report does
   not claim it.
2. **A pre-send tool bound does not exist at the model boundary**, which is *why* the consumption
   uses the cap-checked `charge` path rather than `settle`. If a model declares N tool calls and
   they exceed the remaining quota, the campaign freezes (`BUDGET_EXHAUSTED`) — the response is
   already received, so the tools are refused rather than never requested. Fail closed, but later
   than item 1 intends.
3. **Item 3 is NOT implemented.** There is no global wall-clock deadline propagated into worker and
   provider/tool cancellation; `maxDurationMs` still binds by refusing the *next* call, so an
   over-time run is not actively terminated and per-call vs global duration are not separated.
   Clock-jump and restart-reset handling are likewise not addressed.
4. **`cannotAffordMore()` still has no production caller**, so the "refuse before dispatch" check is
   advisory rather than enforced on the tool path.
5. **Counting semantics for read-only / failed / cancelled tool calls are not frozen into the
   prereg** (§N4 item 1). Only the declared calls of a `completed` response are counted today.
6. **Unknown tool state is charged conservatively**, but a `completed` response that declares tool
   calls nobody dispatches is still charged — conservative (over-counts), never a refund.
7. Pre-existing whole-suite failures remain (see §5) and are not caused by N4.
8. **`pnpm docs:verify` fails for a reason outside this round.** Measured, not assumed:
   `HANDOVER.md` and `plan(20260926-070459).md` both exist at `HEAD` but are deleted in the
   working tree (the user's pre-existing entries, left untouched). With only those two deletions
   temporarily set aside, the same command prints `ALL CHECKS PASS` and exits `0`. Both reported
   failures (`package count`, `current plan entry`) are working-tree artifacts, not consequences
   of N4 or of committed content.

## 9. Reproduction

```powershell
# 1. typecheck, then the N4 acceptance suite
pnpm typecheck                                                                          # exit 0
pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts     # exit 0, 9 passed

# 2. the N0 gate: N4 flips GREEN, N5/N6 stay RED
pnpm test:n0-gaps                                                                        # exit 1, 5 failed | 7 passed

# 3. the historical regression gate (must stay green)
pnpm test:red-next-gaps                                                                  # exit 0, 14 passed

# 4. whole suite + attribution against the pre-N4 log
pnpm test                                                                                # exit 1; FAIL set identical to .ci/n0/n3-full.log

# 5. the offline closed loop (requires a CLEAN tree)
git stash push -u -- "HANDOVER.md" "plan(20260926-070459).md" "plan(20260926-175819).md"
node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n4.json                       # exit 0, PASS
git stash pop
```

`.ci/` is gitignored (`.gitignore` line 9); the raw logs named above live there and are referenced,
not committed.
