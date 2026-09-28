# E4 / R16 — the release-CLI fixture forward path, and why the DECLARED `trusted-build` posture cannot restore it

- **Branch:** `e4/r16-fixture-path`
- **Base:** local `main` @ `2314ce1d` (`merge R14: restore a6-forged-evidence-accepted coverage via the fixture (27/27 CAUGHT)`)
- **Scope:** `scripts/e4/prereg-production-e2e.mjs` (re-specified POS-FWD + three new MEASURED probes),
  new `apps/cli/src/prereg-declared-posture-forward-path.test.ts`.
  **`apps/cli/src/prereg-arm-executor.ts`, `prereg-command.ts`, `prereg-production-runner.ts` and
  `packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts` were READ but NOT modified**
  (no change is required, and none would have been honest).
- **Platform:** Windows-local only. **Ubuntu was NOT run** (see §5).
- **Runtime Freeze justification (P38.4-11):** *release integrity defect* (category 3). The shipped
  release CLI has no `trusted-build`-declared forward run at all, so a release gate reports
  `release-subprocess=CLOSED_BY_R1` while the declared audited posture goes unexercised. The
  disposition is a measured refusal plus test coverage — **no Runtime source was changed**.

---

## 1. Verdict (option (b) of the acceptance)

A fixture campaign **cannot** be run through the SHIPPED release CLI by declaring the R5
`trusted-build` posture, and no honest change in the allowed write scope makes it possible.
The R1 refusal is **correct and is preserved**. A bypass was **not** implemented.

The reason is **not** the one the working diagnosis assumed. Two independent blockers exist, and the
**binding** one fires *before* the arm executor is ever consulted.

### Empirical baseline (unmodified `2314ce1d`, built from the same tree)

```
prereg-production-e2e: PASS
  negative: 9/9 refusals on the release CLI (0 HTTP)
  positive certification: ok (build 0, validate 0, 0 HTTP)
  positive execution (in-process): decision=INCONCLUSIVE arms=124 physicalCalls=124 verified=124
  positive forward (release CLI subprocess): refusedByDesign=true refusalCode=FIXTURE_TRANSPORT_NOT_NON_BILLABLE exit=1 httpRequests=0 armRecords=0
  productionOfflineReadiness: ... release-subprocess=CLOSED_BY_R1 (fixture campaign refused pre-request; 0 HTTP) overall=PASS
```

The refusal code is **`FIXTURE_TRANSPORT_NOT_NON_BILLABLE`**, not `EGRESS_ISOLATION_UNAVAILABLE`.

---

## 2. The ACTUAL mechanism, with evidence

### B1 — the BINDING blocker: the transport/billing admission class (fires first)

`prereg run` → `openPreregisteredCampaignGate`, whose step order is:

| step | `packages/evaluation/src/tool-call-efficiency-formal-run.ts` | what it decides |
|---|---|---|
| STEP 3 | `:1947-1948` `checkAuthorizationV2(auth, artifact, nowMs)` | the approval binds the artifact |
| **STEP 3b** | **`:1950-2007`** | **the admission CLASS: fixture vs paid** |
| later | budget / ledger / provider / `runArm` | the actual campaign |

At STEP 3b the class is selected by `auth.fixtureMode` (`:1964`):

- **fixture class** (`paid:false` + `fixtureMode:"synthetic-offline-v1"`): requires
  `opts.nonBillableTransport` to satisfy `isNonBillableFixtureTransport` (`:1965`). That predicate
  tests a **module-private `Symbol` brand** (`NON_BILLABLE_FIXTURE_BRAND`, `:101`) that only
  `createNonBillableFixtureTransport` (`:123-136`) can stamp — it does not survive JSON, env or a
  plain object. A subprocess cannot be handed one ⇒
  `FIXTURE_TRANSPORT_NOT_NON_BILLABLE` (`:1969-1973`). **This is the observed refusal.**
- **paid class**: `checkAuthorizationV2` returns `AUTHORIZATION_NOT_PAID` unless `paid === true`
  (`:344-346`) — there is no third class; then STEP 3b requires a non-null `maxUsdMicros` (`:1996`)
  **and** a non-null `usdMicrosPerCall` (`:2001`).

The release CLI supplies neither: `apps/cli/src/main.ts:116-118` is
`preregCommandDeps() { return { runner: createProductionPreregRunner() }; }` — **no options** — and
`grep -n "nonBillable|trustedFixture|trustedBuild|isolation|fixture" apps/cli/src/prereg-command.ts`
returns **zero matches**. There is no env var, field, marker or flag that reaches
`opts.nonBillableTransport`.

**The declared `isolation` posture cannot reach this gate at all:**
`grep -n "trusted-build|trustedBuild|TRUSTED_BUILD|isolation" packages/evaluation/src/tool-call-efficiency-formal-run.ts`
→ **0 matches.** The posture is read only inside the arm executor
(`apps/cli/src/prereg-arm-executor.ts:791`, `:863-889`).

### B2 — the SECONDARY blocker: the arm checkouts are not git work trees

`writeArmCheckout` (`scripts/e4/prereg-production-e2e.mjs:504-530`) writes **plain directories** — no
`git init`, no commit. R5's posture demands a clean git work tree at a 40-hex HEAD
(`armGitHeadAndClean`, `:364-374`; refusal `TRUSTED_BUILD_NOT_PROVEN`, `:870-872`). So even if B1
were passed, declaring `trusted-build` would refuse these two checkouts.

### 2.1 Correction to the working diagnosis

r1-fixture's read-only note (relayed by the Lead) concluded that the blocker is the executor's
`process-exec` branch and that **"the positive forward run is restorable ONLY by declaring the
trusted-build posture … AND pointing the subprocess at TWO REAL, clean, git-pinned checkouts"**, and
that **"No R1 invariant needs weakening"**.

The first half is right and is now *proven* (§4): the declared posture genuinely works in a subprocess.
The conclusion is **wrong**, because it omits B1: the gate refuses at STEP 3b, i.e. **before** any
checkout is inspected, so **two real builds change nothing** while the authorization carries
`fixtureMode`. The re-specified POS-FWD proves this directly: it *does* declare
`trusted-build`/`no-os-network-sandbox` and is *still* refused with
`FIXTURE_TRANSPORT_NOT_NON_BILLABLE` at 0 HTTP.

### 2.2 Why each route out is a weakening — so it was not taken

| route | why it is refused |
|---|---|
| let an env var / marker / CLI flag construct the branded transport | **Direct R1 bypass.** R1's whole invariant: no JSON/env/marker/sentinel-key path produces the capability. |
| let the DECLARED posture stand in for the billing proof | **R1's F1 defect re-opened.** A posture whose own name says `no-os-network-sandbox` proves nothing about billing *and* restricts no egress; this artifact has `maxUsdMicros: null`, so it would run **UNCAPPED and possibly billable**. |
| use the PAID class instead | A **different admission class**, not licensed by any isolation posture, and not a fixture campaign. With the loopback counting stub the price is `null` (`endpointIsDecimal…`: a proxy endpoint is unpriceable) ⇒ `PRICING_UNKNOWN`; declaring `paid:true` for an offline stub would also falsify the E2E's `paidExperimentRun=NOT_RUN` claim. |
| give the CLI an option to inject the capability | `createProductionPreregRunner()` is the shipped composition root; parameterising it from outside *is* the env/flag/file bypass above. |

R1's refusal stays. The correct deliverable is an honest, **MEASURED** refusal.

---

## 3. What WAS delivered (no R1 invariant weakened)

### 3.1 The E2E phase is re-specified and now MEASURES the boundary

`runPositiveForward` keeps its pre-request refusal assertion **and** adds
`declaredPostureProbes` — three probes, each read against the loopback stub's own counter,
none inferred from an exit code alone:

| probe | measured |
|---|---|
| **(a) FLAG** `prereg run … --fixture-mode synthetic-offline-v1` | `CLI_USAGE` (`parseArgs` whitelist, `prereg-command.ts:152`), **0 HTTP** — an invented flag grants nothing. |
| **(b) DIGEST** re-build the SAME campaign declaring `trusted-build`/`no-os-network-sandbox` | `isolation` is in the canonical source body (`tool-call-efficiency-preregistration-v2.ts:360-366`, `:371-372`), so the root digest **MOVES**; the approval written for the `process-exec` artifact is refused **`AUTHORIZATION_DIGEST_MISMATCH`**, **0 HTTP**. *Changing the declared posture invalidates the approval.* |
| **(c) NO BYPASS** a FRESH approval bound to the trusted-build artifact | **still** `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`, **0 HTTP**, **0 arm records**. The declared posture does not license a fixture transport. |

The report gained `positiveForward.declaredPosture` (every field), a
`declaredPostureForwardRun: "NOT_OBSERVED: …"` entry in `counts` (never a fabricated `0`), a
`declaredModeRequirement` statement, and an `R16 declared posture:` stdout line. The leading
readiness enum token stays `CLOSED_BY_R1`, so `scripts/e4/ci-readiness.mjs` and
`apps/cli/src/r0-f6-ci-readiness-classification.test.ts` keep their existing classification.

### 3.2 The achievable half is now PROVEN, through the SHIPPED composition root

New `apps/cli/src/prereg-declared-posture-forward-path.test.ts`, 4/4 green
(`npx vitest run`, 2.4 s):

| test | assertion | result |
|---|---|---|
| **R16.1** | `createProductionPreregRunner()` — the exact adapter `preregCommandDeps()` builds, **no** fixture capability, **no** grant — **RUNS** an arm to `status:"passed"` under the DECLARED `trusted-build` posture, 0 provider calls. (`[prereg] trusted-build mode: baseline @ c6ee44a8… network sandbox=none`) | PASS |
| **R16.2** | the SAME runner refuses the SAME checkouts when the posture is NOT declared → `EGRESS_ISOLATION_UNAVAILABLE`, 0 calls. R1 invariant intact. | PASS |
| **R16.3** | declaring the posture moves `preregistrationDigest`; the stale approval is refused `AUTHORIZATION_DIGEST_MISMATCH`, 0 provider-factory calls. | PASS |
| **R16.4** | trusted-build artifact + fixture authorization, no capability → `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`, 0 factory, 0 transport. **CONTROL:** the same artifact WITH the injected branded capability is **ADMITTED** (operator factory never entered) — the fixture class is gated on the capability, not the posture. | PASS |

R16.1/R16.2 close a real coverage gap: R5's own suite (`prereg-trusted-build.test.ts`) builds the
executor directly (`:158`), so the **shipped** runner's honouring of a declared posture was
previously unproven.

### 3.3 Disposition of the pre-existing worktree state

The Lead reported "partial uncommitted work in `%TEMP%\r-w7-fixture`". **That worktree is mine** —
created by me for task-16 under the isolation instruction. The edits it refers to are the ones in
this branch's first commits, authored by me; I kept them (they are §3.1/§3.2).
`baseline-e2e.json` is my baseline run output; it is **not** committed (evidence is quoted in §1).

---

## 4. What the declared posture *is* for (so this is not read as "R5 is broken")

`apps/cli/src/prereg-arm-executor.ts:849-879` — the mode is **self-proving and needs no in-process
capability**: two REAL, clean, git-pinned checkouts at 40-hex HEADs with resolving, **differing**
execution closures (`:791`, `:870-875`); an injected `TrustedBuildGrant` is **binding when present**
(`:867-869`) but **not required**. That is exactly what R16.1 exercises in a subprocess-style
boundary. The mode is an **audited declaration about WHICH BYTES RUN**, and its own name states the
limitation it does not remove — `TRUSTED_BUILD_NETWORK_SANDBOX = "none"` (`:250`). It is not, and was
never, a TRANSPORT or billing claim.

---

## 5. Verification ledger

| check | platform | result |
|---|---|---|
| `node scripts/e4/prereg-production-e2e.mjs` (baseline, unmodified `2314ce1d`) | Windows-local | PASS; POS-FWD `refusedByDesign=true refusalCode=FIXTURE_TRANSPORT_NOT_NON_BILLABLE httpRequests=0 armRecords=0` |
| `node scripts/e4/prereg-production-e2e.mjs` (this branch, clean tree) | Windows-local | **PASS**; `negative 9/9 (0 HTTP)`, `overall=PASS`, `release-subprocess=CLOSED_BY_R1`. `R16 declared posture: declared=trusted-build/no-os-network-sandbox digestMoved=true staleApprovalRefused=true (AUTHORIZATION_DIGEST_MISMATCH) freshApprovalRefusal=FIXTURE_TRANSPORT_NOT_NON_BILLABLE freshHttp=0 flagRefused=true forwardRunPossibleWithoutWeakeningR1=false` |
| — digests observed by that run | Windows-local | process-exec `6dc5db7e…b8ed5`, trusted-build `b529a006…85b7` (differ ⇒ posture is digest-bound) |
| `npx vitest run apps/cli/src/prereg-declared-posture-forward-path.test.ts` | Windows-local | **4/4 PASS** |
| R1 suite `apps/cli/src/prereg-fixture-checkout-trust.test.ts` | Windows-local | **PASS** (5 tests, 1 skipped: host cannot create a file symlink — pre-existing, `:311`) |
| R1 suite `apps/cli/src/prereg-fixture-checkout-grant.test.ts` | Windows-local | **PASS** (7 tests, 1 skipped: same host symlink limitation, `:333`) |
| R1 suite `packages/evaluation/src/tool-call-efficiency-fixture-billing-boundary.test.ts` | Windows-local | **PASS** (7 tests) |
| R1 suite `packages/evaluation/src/tool-call-efficiency-fixture-transport-grant.test.ts` | Windows-local | **PASS** (4 tests) |
| all four together | Windows-local | `Test Files 4 passed (4) / Tests 21 passed | 2 skipped (23)` |
| `pnpm typecheck` (`tsc -b`) | Windows-local | **exit 0** |
| **Ubuntu** | — | **NOT run.** No Ubuntu host/runner was available to this branch; no Ubuntu claim is made. |

Constraints honoured: zero paid/external requests; the user's `8317` relay was never contacted (the
only `8317` string in the repository is TEST-NET-2 documentation usage in a pre-existing suite); no
secrets; `docs/evidence/e4-r87-case-selection.json` untouched; no full `pnpm test` run; the mutation
gate was not run (and no `r97-mutation-check` process was alive before any suite run).

**Unknowns stay unknown:** no release-CLI fixture forward run exists, so its forward cost fields are
**`NOT_OBSERVED`/`null`**, never `0`.
