# E4 / N3 — paid-amount admission and rate source

Plan: `plan(20260926-175819).md` §N3 (line 61).
Round baseline SHA: `67ded22917db084cfadb70c690d7d4babc95d91c`.
Pre-N3 HEAD: `7a53d9ef04bc2cd2e442399abee0c26cde86de4c` (N0/N1/N2 landed).
Post-N3 HEAD: `a2c65e449f36c9fdc2c50415624c7536c36cde23`.
Platform measured on: Windows 10 / PowerShell 7, Node `v24.14.0`, vitest `4.1.10`, pnpm workspace.

Rule this round: no real API key, no paid endpoint, no `paid:true` auto-authorization, no
promotion. Unknown values are `NOT_OBSERVED`, never `0`. Source-string matching is not used as
behavior evidence anywhere below.

## 1. Labels (honest, per deliverable)

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N3.1 | `paid:true` fails closed without a non-null `maxUsdMicros` **and** a known per-call price | **PASS** | 10/10 behavioral cases, each asserting refusal code + provider factory `0` + transport `0`; the old counterexample flipped RED→GREEN |
| N3.2 | A *verifiable* current rate source (retrievable provider page, fetch time, currency, billing category, recomputable formula incl. input/output/cache/tool tiering and rounding) | **NOT_PROVEN** | The shipped snapshot carries a prose `source` string and one `usdMicrosPerCall` figure. No retrievable page, no fetch timestamp, no currency field, no recomputable formula. Per §N3 line 73 this is the accepted "no verifiable current rate ⇒ code fails closed + paid blocked" outcome; nothing was fabricated to fill the gap |
| N3.3 | Rate-snapshot **digest** bound into prereg / authorization / ledger; a rate change forces re-preregistration + re-authorization | **NOT_PROVEN** — not implemented | Not attempted this round; would re-digest every fixture. Recorded as a residual limit, not claimed |
| N3.4 | Amount/token/model-call re-check before each physical send and internal retry; provider over-report / unknown usage / unclear billing category → `UNKNOWN/FROZEN`, no refund, no auto new campaign | **NOT_PROVEN** — not implemented | Out of this round's scope; the existing per-request reservation is unchanged |
| N3.5 | Offline 124/124 synthetic closed loop still runs after the gate tightened | **FIXTURE_PASS** | `prereg-production-e2e.mjs` exit `0`, `treeClean=true`, `ok=true`; admitted as the separately-identified fixture class, never as a paid approval |
| N3.6 | A real paid admission with a real verifiable rate | **BLOCKED** | `paidExperimentRun=NOT_RUN`, `externalProviderCalls=NOT_OBSERVED`, `costUsdMicros=NOT_OBSERVED`; no authorization exists and the script refuses a selectable paid key/switch |
| N3.7 | Ubuntu applicability | **NOT_PROVEN** | All measurements are Windows-local; the two-platform CI wiring is N7's scope |

## 2. The defect being closed (measured, not assumed)

Before this change the money bound was gated **only** on `maxUsdMicros !== null`:

```ts
if (artifact.budget.maxUsdMicros !== null && usdMicrosPerCall === null) { /* refuse */ }
```

so a `paid:true` authorization with `maxUsdMicros: null` (an *unbounded* paid campaign) and an
*unknown* observed price was ADMITTED and a provider factory was constructed. Measured at
pre-N3 HEAD via the N0 gate (raw log `.ci/n0/n0-red.log`, gitignored):

```
× [N3] maxUsdMicros=null + usdMicrosPerCall=null must be REFUSED before any provider factory call
AssertionError: expected 'ADMITTED' to be 'REFUSED' // Object.is equality
Received: "ADMITTED"
```

The observed price is genuinely unknown in exactly the shapes the plan names. Measured directly
against the **built** identity module (`.ci/n0/probe-price.mjs`), exit `0`:

| Environment shape | resolved `providerId` | `endpointBaseUrl` | `usdMicrosPerCall` | known? |
|---|---|---|---|---|
| no `OPENAI_KEY`, no base URL (the unbilled stub) | `stub` | — | `0` | known |
| `TEST_ONLY` key + loopback base URL (a proxy) | `openai` | `http://127.0.0.1:39999/v1` | `null` | **unknown** |
| key, default first-party endpoint | `openai` | — | `2500000` | known |
| key, unlisted model on the default endpoint | `openai` | — | `null` | **unknown** |

## 3. Change list

`packages/evaluation/src/tool-call-efficiency-formal-run.ts`
- Added `FIXTURE_MODE_SYNTHETIC_OFFLINE` (`"synthetic-offline-v1"`) with the rationale that the
  synthetic harness is **separately identified** and is **not** a paid-admission configuration.
- `ToolCallEfficiencyAuthorizationV2` gained additive, optional `fixtureMode?: string`.
- `parseAndValidateAuthorizationV2`: allows the new key, accepts only the one recognized value
  (`INVALID_FIXTURE_MODE`), and refuses the marker together with `paid:true`
  (`FIXTURE_MODE_CANNOT_BE_PAID`) — a fixture can never ride the paid flag.
- `FormalRunCode` gained `PAID_WITHOUT_USD_CAP` and `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`.
- `PreregisteredCampaignObservationV2` gained `endpointIsLoopback: boolean` (re-observed, never
  read from the artifact).
- `checkAuthorizationV2`: admits either the PAID class or the separately-identified FIXTURE class;
  `paid:false` **without** the marker still refuses `AUTHORIZATION_NOT_PAID` (negative case kept).
- New gate STEP 3b, before any budget/ledger/provider construction, splits the two classes:
  - PAID → `maxUsdMicros === null` ⇒ `PAID_WITHOUT_USD_CAP`; and `usdMicrosPerCall === null` ⇒
    `PRICING_UNKNOWN`.
  - FIXTURE → admitted only when the **observed** transport proves itself non-billable
    (`usdMicrosPerCall === 0` for the unbilled stub, or `endpointIsLoopback === true`); otherwise
    `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`.
  - The pre-auth money-bound rule is deliberately left in place, so a money-**bounded** prereg
    with an unknown price is refused even in the fixture class (pinned by N3.11).

`apps/cli/src/prereg-production-runner.ts`
- `observeExecutionIdentity` now re-derives `endpointIsLoopback` from the live endpoint.
- New exported `endpointIsLoopbackAddress(baseUrl)`: `true` only for `localhost`, `::1`,
  `0:0:0:0:0:0:0:1` or `127.0.0.0/8`; `null`/empty/non-loopback/unparseable ⇒ `false`, so it can
  never certify a billable transport as non-billable.

`scripts/e4/prereg-production-e2e.mjs`
- POS-EXEC and POS-FWD authorizations moved from `paid:true` to `paid:false` +
  `fixtureMode: "synthetic-offline-v1"` (they bill nothing).
- Report now carries `authorizationFixture` labelled `FIXTURE_PASS (synthetic class, NOT a paid
  approval)`, a new readiness key `positivePhasesAdmissionClass`, and a `productionOfflineReady`
  clause stating that a PAID admission additionally requires a non-null `maxUsdMicros` and a
  verifiable price.

`packages/evaluation/src/tool-call-efficiency-pricing-admission.test.ts` (new, 10 cases)
- Per-class behavioral acceptance with a provider factory that THROWS if entered, so factory `0`
  and transport `0` are hard evidence.

Test helpers in 6 files gained `endpointIsLoopback: false` (the new required observation field):
`packages/evaluation/src/{prereg-n0-gaps,prereg-next-gaps,tool-call-efficiency-formal-gaps,tool-call-efficiency-formal-run}.test.ts`,
`apps/cli/src/{prereg-command,prereg-formal-gaps}.test.ts`. Assertions were not changed.

## 4. Old RED → new GREEN

Pre-N3: `pnpm test:n0-gaps` → exit `1`, `Tests 9 failed | 3 passed (12)` (`.ci/n0/n0-red.log`,
`n0-red.log:283` records `11 failed | 1 passed (12)` for the evaluation file alone).

| Case | Pre-N3 behavior | Post-N3 behavior |
|---|---|---|
| `[N3]` `maxUsdMicros=null` + `usdMicrosPerCall=null` + `paid:true` | **ADMITTED** (`AssertionError: expected 'ADMITTED' to be 'REFUSED'`) | **REFUSED** `PAID_WITHOUT_USD_CAP`, factory `0` |

Post-N3: `pnpm test:n0-gaps` → exit `1`, `Tests 8 failed | 4 passed (12)` — the N3 case flipped
GREEN; N4×3, N5×2, N6×3 remain RED by design (later tasks).

New suite, all GREEN (exit `0`, `Test Files 1 passed`, `Tests 10 passed`):

| Case | Scenario | Asserted behavior |
|---|---|---|
| N3.1 | `paid:true`, `maxUsdMicros:null`, unknown price | REFUSED `PAID_WITHOUT_USD_CAP`, factory `0`, transport `0` |
| N3.2 | money-bounded, unknown price (unlisted model / proxy) | REFUSED `PRICING_UNKNOWN`, factory `0`, transport `0` |
| N3.3 | negative observed price | REFUSED `PRICING_UNKNOWN`, factory `0`, transport `0` |
| N3.4 | non-integer observed price | REFUSED `PRICING_UNKNOWN`, factory `0`, transport `0` |
| N3.6 | `fixtureMode` + `paid:true` | REFUSED `AUTHORIZATION_INVALID`, factory `0`, transport `0` |
| N3.7 | unrecognized `fixtureMode` value | REFUSED `AUTHORIZATION_INVALID`, factory `0` |
| N3.8 | `paid:false` without the marker | REFUSED `AUTHORIZATION_NOT_PAID`, factory `0` |
| N3.9 | fixture over a **billable** transport | REFUSED `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`, factory `0`, transport `0` |
| N3.10 | **positive control**: fixture over a proven loopback endpoint | ADMITTED, transport `0` |
| N3.11 | fixture, bounded prereg, unknown price | REFUSED `PRICING_UNKNOWN`, factory `0`, transport `0` |

## 5. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `pnpm typecheck` | `0` | `tsc -b`, no diagnostics (`.ci/n0/n3-typecheck.log`) |
| `pnpm build` | `0` | release CLI `apps/cli/dist` rebuilt |
| `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-pricing-admission.test.ts` | `0` | `Test Files 1 passed`, `Tests 10 passed` |
| `pnpm test:n0-gaps` | `1` | `Test Files 2 failed (2)`, `Tests 8 failed | 4 passed (12)` — N3 GREEN, N4/N5/N6 still RED (`.ci/n0/n3-n0gaps.log`) |
| `pnpm test:red-next-gaps` | `0` | `Test Files 2 passed`, `Tests 14 passed` (`.ci/n0/n3-rednext.log`) |
| `pnpm test` | `1` | `Test Files 6 failed | 369 passed (375)`, `Tests 23 failed | 7068 passed | 3 skipped (7094)` (`.ci/n0/n3-full.log`) |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n3.json` (clean tree) | `0` | `prereg-production-e2e: PASS` (`.ci/n0/e2e-n3.log`) |
| `node .ci/n0/probe-price.mjs` | `0` | observed-price table in §2 |

**Attribution of the `pnpm test` failures (measured, not assumed).** Comparing the FAIL set of
`.ci/n0/full-final.log` (pre-N3, 23 lines) against `.ci/n0/n3-full.log` (post-N3, 23 lines) yields
an **empty diff**: identical failing tests, identical count. Passing tests rose from `7058` to
`7068` — exactly the 10 new N3 cases. N3 introduced **zero** new failures. The pre-existing
failure set is load-sensitive and non-deterministic at a *fixed* SHA (the whole-suite baseline at
`1299e5cb` recorded `17` failures in `.ci/n0/full-baseline-sha.log` versus `23` here); the failing
files are `apps/cli/src/{cli,benchmark-command,e4-09-production-e2e,e4-r55-failure-wiring}.test.ts`
and `packages/evaluation/src/{e4-r77-baseline-oracle,r97-arm-worker-contract}.test.ts`.

## 6. Observable provider-factory / physical-request / cost values

From `.ci/n0/e2e-n3.json`, `treeClean=true`, `ok=true`:

| Observable | Value |
|---|---|
| `positiveCertification.httpRequestsDuring` | `0` |
| `positiveExecution.providerFactoryCalls` | `1` |
| `positiveExecution.physicalProviderCalls` | `124` |
| `positiveExecution.ledgerCommitted` / `ledgerRemaining` | `124` / `3596` |
| `positiveExecution.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveExecution.decision` | `INCONCLUSIVE` |
| `positiveForward.physicalStubRequests` | `124` |
| `positiveForward.httpRequestsDuringBuildAndValidate` | `0` |
| `positiveForward.ledgerGranted` / `committed` / `remaining` / `unknown` / `transportRetries` | `3720` / `124` / `3596` / `0` / `0` |
| `positiveForward.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveForward.decision` | `INCONCLUSIVE` |
| `counts.externalProviderCalls` | `NOT_OBSERVED` (no externally-billed provider exists here) |
| `counts.costUsdMicros` | `NOT_OBSERVED` (nothing was billed; a paid run is BLOCKED) |
| `readiness.paidExperimentRun` | `NOT_RUN` |
| `readiness.championPromotion` | `NOT_RUN` |
| `readiness.positivePhasesAdmissionClass` | `FIXTURE_PASS (N3 synthetic-fixture class: paid:false + fixtureMode=…)` |
| `readiness.realDualFrozenBuildAndRealVerifier` | `NOT_PROVEN` (N1 scope) |

The `INCONCLUSIVE` verdict is unchanged and is **not** rewritten as a model-quality or promotion
conclusion.

## 7. Windows / Ubuntu applicability

- All evidence above is Windows-local.
- `endpointIsLoopbackAddress` uses `new URL` plus a host regex over `localhost` / `::1` /
  `127.0.0.0/8`; it has no platform-specific behavior, but it is **not** exercised on Ubuntu in
  this round — Ubuntu remains `NOT_PROVEN` and belongs to N7's two-platform CI wiring.
- The admission refusals are pure in-process logic and platform-independent by construction; that
  argument is stated as reasoning, not claimed as measured Ubuntu evidence.

## 8. Residual limits

1. **A new admission class was added to a frozen runtime contract.** Plan §N2 line 56 requires the
   synthetic fixture mode to be separately identified and to not be a paid-admission
   configuration, which is what `fixtureMode` implements. It is additive (an absent key keeps
   previous semantics exactly) and parser-locked (`fixtureMode` + `paid:true` is refused), but it
   is a real contract surface. It is **not** a widening of the paid path: the PAID class gained
   two new refusals and lost none.
2. **`pricingUnknownPolicy` is still not read by the gate.** The refusal is now structural, so the
   field is inert — a hypothetical future `"allow"` value would not reopen the path. Fail-closed,
   but the field and the gate disagree.
3. **No verifiable rate source (N3.2) and no snapshot digest binding (N3.3).** The paid entry
   stays closed; per §N3 line 73 that is the accepted outcome when no current rate can be
   verified. Nothing was invented to satisfy it.
4. **`endpointIsLoopback` is trusted at the same level as the rest of the re-observed identity.**
   It is produced by the observer (the trusted factory) from the live environment and is never
   read from the artifact, but a dishonest observer could set it — it is not an independent
   network boundary. Real egress isolation is N5's scope.
5. **The fixture branch's non-billable proof is `usdMicrosPerCall === 0` or loopback.** A price of
   `0` is what the unbilled stub genuinely resolves to; the fixture marker is required in
   addition, so a paid approval cannot reach this branch.
6. **N3 does not implement the per-send/per-retry re-check or the `UNKNOWN/FROZEN` no-refund
   state** (§N3 line 71). Deferred and reported as `NOT_PROVEN`.
7. Pre-existing whole-suite failures remain (see §5) and are not caused by N3.

## 9. Reproduction

```powershell
# 1. typecheck, then the dedicated N3 acceptance suite
pnpm typecheck                                                    # exit 0
pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-pricing-admission.test.ts  # exit 0, 10 passed

# 2. the N0 gate: N3 flips GREEN, N4/N5/N6 stay RED
pnpm test:n0-gaps                                                 # exit 1, 8 failed | 4 passed

# 3. the historical regression gate (must stay green)
pnpm test:red-next-gaps                                           # exit 0, 14 passed

# 4. whole suite + attribution against the pre-N3 log
pnpm test                                                         # exit 1; FAIL set identical to .ci/n0/full-final.log

# 5. the offline closed loop (requires a CLEAN tree)
git stash push -u -- "HANDOVER.md" "plan(20260926-070459).md" "plan(20260926-175819).md"
node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n3.json   # exit 0, PASS
git stash pop
```

`.ci/` is gitignored (`.gitignore` line 9); the raw logs named above live there and are referenced,
not committed.
