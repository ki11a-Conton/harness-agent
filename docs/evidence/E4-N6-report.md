# E4 / N6 — evidence, ledger and statistics recomputed from the same source

Plan: `plan(20260926-175819).md` §N6 (line 103); prompt at line 105; acceptance at line 115.
Round baseline SHA: `67ded22917db084cfadb70c690d7d4babc95d91c`.
Pre-N6 HEAD: `978209ec94c752e26a724bc4915d98e4256c9ee2` (N0/N1a/N2/N3/N4/N5 landed).
Commits this round: `42ea342d` (validator + aggregate + E2E), `67ce2884` (CLI journal wiring),
`de7a5ecf` (fixture bound to the real activation shape). Final HEAD: `de7a5ecfa856d589f46568184059ff34a0514c44`.
Platform measured on: Windows 10 / PowerShell 7, Node `v24.14.0`, vitest `4.1.10`.

Rules this round: no real API key, no paid endpoint, no `paid:true` auto-authorization, no promotion.
Unknown values are `NOT_OBSERVED`/UNKNOWN, never `0`. Source-string matching is not behavior evidence.

## 1. Labels (honest, per deliverable)

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N6.1 | Activation evidence is bound to its **content**, not merely its digest | **PASS** | 6-case suite: genuine verifies; unknown schema, wrong run identity, no events, one changed byte, deleted artifact, and an unactivated run carrying an activation artifact are all refused |
| N6.2 | `tokensDelta` comes from the **durable journal**, never from self-reports | **PASS** | N6.7 + N6.8: journal `4242` ⇒ delta `4242`; journal `0` beats a 1,000,000 self-report; no journal ⇒ delta `0` and the arms are **not** provenance-comparable |
| N6.3 | An `error` run cannot corroborate artifact integrity | **PASS** | N6.9: an all-`error` campaign ⇒ `artifactIntegrity=false`, never `ACCEPT`; N6.10: the same records pass integrity **only** when the prereg declares `maxInfraErrorRatio` |
| N6.4 | Error tolerance must be **declared**, never assumed | **PASS** | `allowedInfraErrorRatio = prereg.evaluation.maxInfraErrorRatio ?? 0`; the field is optional, validated to `[0,1]`, and absent from every existing artifact (digests unchanged) |
| N6.5 | The positive E2E `ok` predicate no longer silently excludes error records | **PASS** | Both predicates now require every **expected** arm run to be present, non-error, evidence-bearing and verified; the old `records.filter(non-error)` right-hand side collapsed to `0` for a fully-collapsed campaign |
| N6.6 | The shipped CLI's own aggregate binds the journal | **PASS** | Found by the new E2E cross-check: the release CLI reported `tokensDelta=0` while the journal it had just written held `248`. After `readCostJournalChargedTokens` wiring, journal `248` = delta `248` |
| N6.7 | `armRunId ↔ request IDs ↔ ledger reservation/commit ↔ verifier bytes` un-repeatable association (plan line 112) | **NOT_PROVEN** | Only the verifier-bytes/identity leg is bound. Request-ID ↔ reservation ↔ commit binding needs N1's real arm artifacts; §8.1 |
| N6.8 | Duplicate runs, dangling reservations, resume-after-interruption not misjudged green | **NOT_PROVEN** | Not exercised this round; N6's plan dependency on N1/N4 is only partly satisfied |
| N6.9 | Ubuntu applicability | **NOT_PROVEN** | Windows-local measurement only; two-platform CI is N7 |
| N6.10 | The offline closed loop still runs end to end | **FIXTURE_PASS** | E2E exit `0`, `treeClean=true`, 124/124, decision `INCONCLUSIVE`, overall `PASS` — synthetic fixture builds, not two real pinned checkouts |
| N6.11 | Paid execution | **BLOCKED** | `paidExperimentRun=NOT_RUN`; no admission was widened |

## 2. The defects being closed (measured, not assumed)

**(a) A digest was mistaken for a fact.** `verifyArmEvidenceFromArtifacts` compared the activation
artifact's sha256 and **never parsed its content**. The N0 counterexample —
`{ "schemaVersion": "never-checked-by-the-validator", "requestId": "never-happened" }` — verified
perfectly whenever the caller declared its digest. A hash proves the bytes did not change; it never
proves an activation happened.

**(b) Statistics were summed from the runner's self-report.** `tokensDelta` was
`Σ candidate.tokensUsed − Σ baseline.tokensUsed`. A campaign could self-report `+15_999_984` tokens
while the durable journal witnessed exactly **zero**.

**(c) An `error` record was counted as corroborated evidence.** `digestValid` was
`records.every(r => r.evidenceVerified && armEvidenceProblems(r.outcome.evidence, r.outcome.status).length === 0)`,
and `armEvidenceProblems(undefined, "error")` returns `[]` — a statement that nothing is *malformed*,
read as a statement that something was *verified*. A campaign in which **every** arm died satisfied
it, and the E2E `ok` predicate had the same hole (`records.filter(r => r.outcome.status !== "error")`
made the right-hand side `0`).

**(d) Discovered by measurement, not reasoning.** The tightened E2E cross-check failed on its first
run and exposed a fourth, real defect: the **shipped release CLI** aggregated without reading the
journal it had just written (`248` tokens on disk, `tokensDelta=0`). That is precisely plan line 113.

## 3. Change list

`packages/evaluation/src/prereg-run-evidence.ts`
- `PREREG_RUN_ACTIVATION_SCHEMA`, `ACTIVATION_KEYS`, `ACTIVATION_REQUIRED`, `ACTIVATION_IDENTITY_KEYS` added.
- The activation branch now parses the artifact, rejects unknown/missing keys, requires the activation
  schema, binds `caseId`/`armId`/`repetition`/`orderIndex` to the run identity, and requires real events.

`packages/evaluation/src/tool-call-efficiency-paired-campaign.ts`
- `tokensDelta = ledgerTotals.journalChargedTokens ?? 0`; the self-report is retained only as a signal.
- `tokensUncorroborated` (self-reported ≠ 0 with no journal) makes the arms **not**
  `provenanceComparable`, with an explicit incomparability reason.
- `digestValid` now requires `records.length > 0`, `infraErrorRatio ≤ allowedInfraErrorRatio`, and zero
  uncorroborated non-error records. Error records are uncorroborated by definition.
- `ledgerTotals.journalChargedTokens?: number | null` (`null` = explicitly UNKNOWN).

`packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts`
- `PreregEvaluationV2.maxInfraErrorRatio?: number` (optional, `[0,1]`, validated on load); added to the
  strict `expectKeys` list so an artifact *may* declare it. Absent stays absent, so no existing
  artifact's digest or behaviour changes.

`packages/evaluation/src/tool-call-efficiency-formal-run.ts`
- `readCostJournalChargedTokens(dir): Promise<number | null>` — the journal's corroborated token
  consumption; `null` (never `0`) when there is no journal. Exported via the package index.

`apps/cli/src/prereg-command.ts`
- `prereg run` passes `journalChargedTokens` from `readCostJournalChargedTokens(budgetDir)`.

`scripts/e4/prereg-production-e2e.mjs`
- `costJournalTokensFromFile(budgetDir)` (an independent re-derivation from bytes); POS-EXEC passes it
  to the aggregate; POS-FWD cross-checks the aggregate the release CLI wrote against the journal.
- Both `ok` predicates tightened (every expected arm run must be non-error + evidence-bearing +
  verified); new observables `journalChargedTokens`, `aggregateTokensDelta`.

`apps/cli/src/prereg-command.test.ts`
- Its fixture wrote a **label-only** activation (`{schemaVersion, armRunId, activated: true}` — no
  events, no run identity), accepted only because the validator stopped at the digest. It now writes
  the shape the real executor writes. **The fixture was corrected; the validator was not relaxed.**

Tests added: `packages/evaluation/src/prereg-activation-binding.test.ts` (6 cases, new) and four cases
(N6.7–N6.10) in `tool-call-efficiency-formal-gaps.test.ts`.

## 4. Old RED → new GREEN

`pnpm test:n0-gaps` before N6: exit `1`, `3 failed | 9 passed (12)`.
`pnpm test:n0-gaps` after N6: **exit `0`, `12 passed (12)` — every N0 counterexample N1a–N6c is closed.**

| Case | Pre-N6 | Post-N6 |
|---|---|---|
| `[N6a]` forged directory with honestly recomputed digests | `verified: true` | `verified: false` (activation schema/identity/events refused) |
| `[N6b]` zero-token journal vs huge self-reports | `tokensDelta = 15_999_984` | `tokensDelta = 0` |
| `[N6c]` campaign with every arm run `error` | `artifactIntegrity = true` | `artifactIntegrity = false` |

New suites (all GREEN): `prereg-activation-binding.test.ts` 6/6; N6.7–N6.10 in
`tool-call-efficiency-formal-gaps.test.ts` (21/21 in that file). Coverage beyond the headline cases:
a genuine artifact set **still verifies** (the refusal is not blanket); a right-schema/wrong-identity
activation is refused; an eventless activation is refused; one changed byte is refused; a deleted
artifact is refused; an unactivated run carrying an activation artifact is refused; a declared
100 % error allowance makes the same all-error records pass integrity but still never `ACCEPT`.

## 5. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `pnpm typecheck` | `0` | `tsc -b`, no diagnostics |
| `pnpm test:n0-gaps` | **`0`** | `Test Files 2 passed (2)`, `Tests 12 passed (12)` — the whole gate is green (`.ci/n0/n6-n0gaps.log`) |
| `pnpm exec vitest run …/prereg-activation-binding.test.ts` | `0` | `Tests 6 passed` |
| `pnpm exec vitest run …/tool-call-efficiency-formal-gaps.test.ts` | `0` | `Tests 21 passed` |
| `pnpm exec vitest run apps/cli/src/prereg-command.test.ts` | `0` | `Tests 43 passed` |
| `pnpm test:red-next-gaps` | `0` | `Tests 14 passed` |
| `pnpm test` | `1` | `Test Files 5 failed | 373 passed (378)`, `Tests 22 failed | 7092 passed | 3 skipped (7117)` (`.ci/n0/n6-full.log`) |
| `pnpm build` | `0` | release CLI rebuilt |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n6.json` (clean tree) | **`0`** | `prereg-production-e2e: PASS` (`.ci/n0/e2e-n6.log`) |

**Attribution (measured, both directions).** FAIL-set diff `.ci/n0/n5-full.log` (22) vs
`.ci/n0/n6-full.log` (22): **empty in both directions** — zero new failures, zero previously-failing
tests newly fixed. Passing tests `7082 → 7092` = exactly the 10 new N6 cases.

**One real regression WAS introduced and fixed during the round, by measurement.** The first full run
after the production changes showed a new failure: `prereg-command.test.ts > … reaches ACCEPT` became
`INVALID`. Cause: that fixture's label-only activation artifact is refused by N6.1. Fixed by binding
the fixture to the real executor shape (`de7a5ecf`), after which the FAIL set returned to empty-diff.
This is the strongest available evidence that N6.1 bites a real fixture rather than only the N0 case.

## 6. Observable provider-factory / physical-request / cost values

Clean-tree E2E, `treeClean=true`, `ok=true`, overall `PASS`:

| Observable | Value |
|---|---|
| `positiveExecution.providerFactoryCalls` | `1` |
| `positiveExecution.physicalProviderCalls` | `124` |
| `positiveExecution.ledgerCommitted` / `ledgerRemaining` | `124` / `3596` |
| `positiveExecution.journalChargedTokens` | `1240` (durable cost journal) |
| `positiveExecution.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveExecution.decision` | `INCONCLUSIVE` |
| `positiveForward.physicalStubRequests` | `124` |
| `positiveForward.ledgerGranted` / `committed` / `remaining` / `unknown` / `transportRetries` | `3720` / `124` / `3596` / `0` / `0` |
| `positiveForward.journalChargedTokens` / `aggregateTokensDelta` | `248` / `248` (now equal — the CLI reads the journal) |
| `positiveForward.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveForward.decision` / `decisionReasonCodes` | `INCONCLUSIVE` / `["EFFECT_BELOW_THRESHOLD"]` |
| forward basis | `SYNTHETIC_FIXTURE_BUILD` |
| `realDualFrozenBuildAndRealVerifier` | `NOT_PROVEN` (N1 scope) |
| E2E-level egress / allowance counters | `NOT_OBSERVED` (no such key in the report) |
| `externalProviderCalls` / `costUsdMicros` | `NOT_OBSERVED` (nothing billed; paid BLOCKED) |
| `readiness.paidExperimentRun` / `championPromotion` | `NOT_RUN` / `NOT_RUN` |

## 7. Windows / Ubuntu applicability

- All evidence is Windows-local; Ubuntu remains `NOT_PROVEN` (N7 owns the two-platform CI).
- The changes are pure in-process file parsing and arithmetic with no platform branch, but that is an
  argument, not a measurement.
- No refusal code introduced this round is platform-conditional.

## 8. Residual limits

1. **The full same-source chain is NOT proven.** Plan line 112 asks for an un-repeatable
   `armRunId ↔ request IDs ↔ ledger reservation/commit ↔ verifier bytes` association. What exists is
   the verifier-bytes/identity leg plus journal-bound token totals. Request-ID ↔ reservation ↔ commit
   binding requires artifacts from a **real** arm run (N1), which is `NOT_PROVEN`, so this cannot be
   closed offline.
2. **Duplicate runs, dangling reservations, and resume-after-interruption** are **not** covered by a
   test this round. The plan lists them in the acceptance set; they remain unproven.
3. **`maxInfraErrorRatio` is validated but never exercised in production.** No real artifact declares
   it; the default `0` means any single infra error now makes a campaign `INVALID`. That is the safe
   direction, but it also means a genuinely tolerated error rate must be pre-registered deliberately —
   and a campaign that legitimately suffers one infra error will now fail rather than degrade.
4. **A journal is still trusted by existence.** `journalChargedTokens` is read from
   `cost-budget.json` in the budget dir; nothing binds that file to the campaign's plan digest at read
   time (the ledger does its own guarding, the cost journal is not independently re-verified here).
5. **Self-reports are retained, not erased.** `tokensUsed` still lives in the records; it is no longer
   an input to `tokensDelta`. A future reader must not reintroduce it as one.
6. **The E2E does not report per-record error counts** as an observable, so the tightened predicate's
   inputs are only inspectable through the raw record files, not through the report keys.
7. Pre-existing whole-suite failures remain (see §5); N6 introduced none.

## 9. Reproduction

```powershell
# 1. typecheck
pnpm typecheck                                                                     # exit 0

# 2. the N0 gate: ALL 12 counterexamples green
pnpm test:n0-gaps                                                                  # exit 0, 12 passed

# 3. N6 acceptance suites
pnpm exec vitest run packages/evaluation/src/prereg-activation-binding.test.ts       # exit 0, 6 passed
pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts # exit 0, 21 passed

# 4. the historical regression gate (must stay green)
pnpm test:red-next-gaps                                                            # exit 0, 14 passed

# 5. whole suite + attribution against the pre-N6 log
pnpm test                                                                          # exit 1; zero new failures vs .ci/n0/n5-full.log

# 6. the offline closed loop (requires a CLEAN tree)
git stash push -u -- "HANDOVER.md" "plan(20260926-070459).md" "plan(20260926-175819).md"
pnpm build
node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n6.json                 # exit 0, PASS
git stash pop
```

`.ci/` is gitignored (`.gitignore` line 9); the raw logs named above live there and are referenced,
not committed.

---

## 10. Correction — F3 / R2 (per-arm journal attribution), appended after the fact

This section **supersedes** the cost-related claims above; the earlier text is kept as the historical
record of the N6 state at commit `a85db6dc`.

**What was wrong.** §1's table row `positiveForward.journalChargedTokens / aggregateTokensDelta =
248 / 248 ("now equal — the CLI reads the journal")` describes the DEFECT, not a fix:
`aggregatePreregisteredCampaign` computed

```ts
const tokensDelta = journalChargedTokens ?? 0;   // the campaign TOTAL, used as a DIFFERENCE
```

so a campaign that consumed 248 tokens reported a candidate-vs-baseline change of 248. A ledger
existing was treated as proof that the two arms had been compared. §8 point 4 ("a journal is still
trusted by existence") and §8 point 5 are the same defect from the other side: with no journal the
delta silently became `0`, and a self-reported delta of exactly `0` disabled the
`tokensUncorroborated` guard entirely.

**What changed (R2).**

- `cost-budget.json` now carries a per-request journal: one entry per billed PHYSICAL attempt with
  `campaignDigest, armRunId, arm, caseId, repetition, requestId, attemptId, reservationId,
  costReservationId`, plus `basis` (`MEASURED` | `RESERVED_UPPER_BOUND`) and the tokens that belong to
  that basis. A conservative reservation is stored in its own fields and can never be read as
  consumption.
- The campaign driver binds the arm-run scope immediately before `runArm` and clears it in a
  `finally`; the journal refuses a duplicate `reservationId` (one attempt is charged exactly once and
  never to two arms) and a duplicate `(armRunId, requestId, attemptId)`.
- `aggregatePreregisteredCampaign` re-derives `totalTokens` (read-only ledger total) and
  `baselineTokens` / `candidateTokens` / `deltaTokens` independently from the RAW entries, reconciles
  the attributed sum against the ledger total, and refuses (delta `null`, not `0`) on: no ledger, a
  legacy total-only ledger, an unobserved/reserved attempt, a missing arm, a duplicate or
  mis-attributed request, a foreign campaign digest, or an unrecognised schema. Output schema is
  `tool-call-efficiency-paired-aggregate-v2`.
- The E2E no longer asserts `aggregateTokensDelta === journalChargedTokens`; it recomputes
  total/baseline/candidate/delta from the raw journal bytes itself and requires the aggregate to
  match (`costMatchesJournal`).

**Evidence.** The target assertions live in
`packages/evaluation/src/tool-call-efficiency-token-delta-red-probe.test.ts` (RED on `a85db6dc`:
`expected 140 to be -60`, and `expected true to be false` for the missing-ledger comparability gate)
and the behavioural suite is
`packages/evaluation/src/tool-call-efficiency-token-attribution.test.ts` (GREEN: 100/40 → total 140,
delta −60; 100/100 → total 200, delta 0; arm swap inverts the delta and leaves the total unchanged;
self-reports cannot move the journal result; resume does not re-charge; identical validity with
different true cost moves the cost gate).

**Still NOT_PROVEN after R2.** The per-request attribution is not yet bound to the trusted execution
manifest / verifier bytes, and `budgetEvidenceReady` therefore stays `NOT_PROVEN`. The 248/248 row
above is no longer how correctness is judged: the two numbers are different metrics and equal values
are no longer evidence of anything.
