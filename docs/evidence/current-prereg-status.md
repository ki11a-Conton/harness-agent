# Current pre-registration status — one entry point for "where does this actually stand?"

**Scope of this document.** This is the CURRENT-status entry point the R7 round adds
(`plan(20260928-105425).md` §R7 item 4). It exists because several reports in
`docs/evidence/` describe their own round and are now stale as *current* statements. Neither
the historical reports nor the frozen sample set are edited here: superseded statements are
recorded as superseded, with their scope, date and SHA.

| | |
| --- | --- |
| Status date | 2026-09-28 (round R7, Windows 10 local measurement) |
| Repository SHA this status is written from | `2645006f9a394311f47f9e2fd4b83b3c5aed5abf` (main: R6 + R1 + R2 + R4-in-scope merged) |
| Authoring task | `task-10` (R7-core, F6) |
| Platform measured here | Windows only. Ubuntu evidence quoted below comes from downloaded GitHub Actions artifacts, not from a local Linux run. |
| Frozen 8-case selection | `docs/evidence/e4-r87-case-selection.json` — **unmodified**; its stored digest recomputes to `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae`. **6 weak passes / 0 strong passes** is the frozen result and is NOT raised by anything in this round. |

---

## 1. The layered readiness, as measured (not collapsed)

`scripts/e4/ci-readiness.mjs` reports five SEPARATED levels and deliberately has no top-level
`ok`. Running the fixed script over the **genuine GitHub Actions artifact** for
`r97-r98-closed-loop-windows-latest` (SHA `3d6e7562c2bdcdc919093ceaab7520feaa267ae7`,
run `36323899133`) produces:

```
fixtureProtocolReady: PASS
realBuildOfflineReady: BLOCKED
budgetEvidenceReady: NOT_PROVEN
paidExperimentRun: NOT_RUN
championPromotion: NOT_RUN
execution kind: SYNTHETIC_FIXTURE_BUILD (structured field)
forward basis: SYNTHETIC_FIXTURE_BUILD
platforms: this=windows windows=MEASURED ubuntu=NOT_PROVEN cross=NOT_PROVEN
```

| Level | Status | What it is actually based on |
| --- | --- | --- |
| `fixtureProtocolReady` | **PASS** | the E2E artifact's own `ok` over the offline closed loop on SYNTHETIC `writeArmCheckout` fixture arm builds. This is a fixture result and implies nothing about a real dual build. |
| `realBuildOfflineReady` | **BLOCKED** (`NO_REAL_ARM_PAIR`) | the E2E's structural `releaseCliSubprocessForwardBasis` is `SYNTHETIC_FIXTURE_BUILD`; the RELEASE CLI's own fixture-forward path is additionally `CLOSED_BY_R1` (refused pre-request). Two real pinned checkouts built from distinct source SHAs **plus the real verifier over them** remain unproven by this script. |
| `budgetEvidenceReady` | **NOT_PROVEN** | the journal now carries per-attempt `armRunId`/`requestId`/`reservationId` (R2) and total-vs-delta are separate metrics, but the attribution is **not** bound to the trusted manifest/verifier bytes and needs real arm artifacts. |
| `paidExperimentRun` | **NOT_RUN** | no paid authorization exists for this script; it never creates one. |
| `championPromotion` | **NOT_RUN** | promotion is a separate later approval. |

Measured counts in the same artifact (from the real E2E input, `e2eSha256`
`1274ecc172efa6225af0d97675009b30529a0d5d81d8092f00eb31c8cf1ec0df`): `forwardJournalChargedTokens`
248, `forwardAggregateTokensDelta` 248, `evidenceVerified` 124. That input predates R2, so it
carries no per-arm baseline/candidate split; the fixed script reports those as
`NOT_OBSERVED`/`null` rather than inventing `0`.

Command exit codes recorded by the readiness run itself: `n0GapGate=0`, `legacyRedNextGaps=0`,
`docsSmoke=0`; `typecheck`/`test`/`build` are `null` (`NOT_OBSERVED`) because that invocation was
not given `--exit-*` declarations. **Ubuntu-Actions was NOT run by this task.** Locally,
`pnpm typecheck`, `pnpm test:n0-gaps` (12/12) and `pnpm test:red-next-gaps` (14/14) are exit 0.

---

## 2. Readiness is now classified from structure, not prose (F6 fixed)

The pre-R7 rule was `readinessText.includes("SYNTHETIC") ? SYNTHETIC_FIXTURE_BUILD :
REAL_DUAL_PINNED_BUILD`, so lowercase `synthetic`, an empty string and unrelated prose all rendered
`realBuildOfflineReady = PASS`. That classifier is deleted; `readiness.productionOfflineReady` prose
is read by nothing, and no log is scanned for the word `PASS`.

A level may be raised only by:

1. a **known execution-kind enum** in the E2E artifact's structured
   `readiness.productionOfflineReadiness` (`executionKind`, or the leading enum token of
   `releaseCliSubprocessForwardBasis`); anything unrecognised or missing is `NOT_OBSERVED` →
   `NOT_PROVEN`; and
2. for `REAL_DUAL_PINNED_BUILD` only, **verified evidence**: the artifact's `ciRunSha` equals the
   run's expected SHA, a non-empty run id, the producing OS, two DISTINCT 40-hex arm source SHAs
   with build digests, a verifier that ran over every case, `typecheck`/`test`/`build` exit codes all
   0, `ok=true`, and a journal that agrees with the independently recomputed delta. A forged REAL
   enum without that evidence is `NOT_PROVEN` with the concrete failure list, never `PASS`.

Measured: the R0 reproducer `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` went from
**4 failed | 2 passed (6)** at `a85db6dc` to **16 passed (16), exit 0** (16 cases: the original R0
targets plus the §R7.3 mutation table — empty/case/unrelated prose, enum-shaped prose, forged REAL
enum, wrong SHA, missing run identity, null exit code, verifier not run / incomplete / identical
arms, journal mismatch, and a positive complete-REAL case that must PASS).

---

## 3. Platform measurement (F6's second half, fixed)

The pre-R7 script wrote `platforms.ubuntu.status = "NOT_PROVEN"` as a literal in every run,
including one executed on `ubuntu-latest`. The downloaded artifact proves it:

| Downloaded artifact | `os.platform` | `platforms.ubuntu.status` |
| --- | --- | --- |
| `ci-readiness-ubuntu-latest-…-36323899133-attempt-1/ci-readiness.json` | `linux` | **`NOT_PROVEN`** ← a real Ubuntu run reporting itself unproven |
| `ci-readiness-windows-latest-…-36323899133-attempt-1/ci-readiness.json` | `win32` | `NOT_PROVEN` |

The fixed script instead:

- records `platforms.thisProcess` as `MEASURED` for the process that actually ran, and sets the
  `windows`/`ubuntu` slot it ran on to `MEASURED`;
- leaves the other platform `NOT_OBSERVED` when no artifact is supplied (it is not hardcoded, and it
  is not assumed measured either);
- accepts `--other-platform-artifact <ci-readiness.json>` only when that artifact's `ciRunSha`
  equals this run's expected SHA **and** it reports its own platform `MEASURED`; then the slot is
  `MEASURED_SAME_SHA`, otherwise `NOT_PROVEN` with `SHA_MISMATCH` /
  `OTHER_PLATFORM_NOT_SELF_MEASURED`.

Measured with the genuine artifacts at SHA `3d6e7562…` (Linux branch exercised through a
`process.platform` preload — a **simulation on Windows, not a real Ubuntu runner**): this process
reported `this=ubuntu MEASURED`, `windows=MEASURED_SAME_SHA`, `cross=MEASURED_SAME_SHA`, with the
same five levels. Feeding the historical Ubuntu artifact in as the other platform yields
`NOT_PROVEN` (`OTHER_PLATFORM_NOT_SELF_MEASURED`) — honest, because that artifact cannot show its
own platform measured.

---

## 4. Corrections to statements that are no longer current

### 4.1 "The old pair was never re-pinned" — WRONG (superseded)

- **Superseded statement:** `docs/evidence/E4-N8-paid-run-executed.md` §6.5 — *"Nothing here re-pins
  the repository's arm defaults (`e9776ba`/`a203737`), so the prereg path remains unable to prepare
  legal arms by default."* That was true of the N8 round and is scoped to it.
- **Current fact:** the pair HAS been re-pinned and measured.
  Baseline `8265dc39f74b3d556e059bb86b1cc192357e21dd`, candidate
  `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd`; the pair's entire diff is one file, `+1/−20`
  (`packages/evaluation/src/mechanism-guidance.ts`); build-closure digests
  `09c832a9124c46c56216410cda08026dd89d37b5f96f9c8c9d6a613e8cfab0c0` (baseline) /
  `6bdb2ce094a70c55e4ea052941f684e8a12999282454d93c8b52d9434559e364` (candidate).
  Source: `docs/evidence/E4-N1-comparable-pair-and-negative-control.md` (§1–§2).
- **Raw evidence:** the document above carries the measurements and its own correction history;
  per-arm module-load records, acceptance matrix, ledger and validator reports exist as CI
  artifacts (locally inspected: `.ci/gh-artifacts/main-36323899133/r97-r98-closed-loop-*-…/`).
  The two-platform closed loop reports **564/564 suites, 9/9 matrix, 16 measured units, 6 weak
  passes, 0 strong passes** — weak labels kept, `strongPasses` unchanged.

### 4.2 "The experiment was never paid / PAID_NOT_AUTHORIZED" — scope-specific, not global

- **Superseded phrasing:** `docs/E4-R26-report.md` and `docs/E4-R35-report.md` state *未付费*
  (not paid) — correct for those EARLIER rounds, which ran before any paid authorization.
  `docs/evidence/prereg-N0-gap-matrix.md` records `BLOCKED: PAID_NOT_AUTHORIZED` for the
  *pre-registration path* in the N0/N8 round.
- **Current fact:** `docs/evidence/E4-N8-paid-run-executed.md` records **real billed
  `agent benchmark` calls** against the user's relay under an authorization given in that session
  (endpoint `http://127.0.0.1:8317/v1`, key masked and never written to a file, model
  `workbuddy-deepseek-v4.1-flash`): `GET /v1/models` OK, a `chat/completions` probe OK, and
  `agent benchmark` with `RUN_PAID_BENCHMARKS=1` — **6 model calls / 9 tools** on
  `workbuddy-deepseek-v4.1-flash` (18,371 in / 566 out, upstream `400 {"code":11148}`) and
  **21 model calls / 29 tools** on `deepseek-v4-flash` (204,064 in / 5,780 out, ended on
  `agent_limit`).
- **What those runs are NOT:** they are **not** formal `prereg run` experiments. They were ordinary
  paid `agent benchmark` runs; no preregistration/authorization pair governed them, and no quality
  claim follows from them (one ended in `agent_limit`; `cost.score=0` is not a quality verdict).
- **Raw evidence available:** partial. The N8 document records the numbers it retained, but §6
  states the full regression suite's per-case results were not yet available at writing, the
  failing request body was not retained, and the relay publishes no rates (tokens only, no USD).
  The later round that reviewed this material did **not** obtain the complete raw paid-run package;
  treat those runs as "recorded in the repository as executed", not as reproducible evidence.
- **Status of the 11148 defect:** R6's fix (`13c00e0b…`, appended to that document as §7) is
  `fixed / pending real-world verification` — no relay was contacted in R6, so the §2 hypothesis
  about the stall-recovery injection remains unproven.

### 4.3 "The offline closed loop proves production readiness" — never current

`fixtureProtocolReady = PASS` describes the SYNTHETIC fixture closed loop. It does **not** raise
`realBuildOfflineReady` (BLOCKED) and does not authorize money (`paidExperimentRun = NOT_RUN`).
Nothing in this document treats an overall green CI as pre-registration readiness.

---

## 5. Runtime Freeze — what actually changed this round

Runtime architecture is frozen (`AGENTS.md` P38.4-11). This round changed code only under the
sanctioned reasons, and each change carries a reproducer:

| Task | Defect class | Sanctioned reason | Evidence |
| --- | --- | --- | --- |
| R1 (`e4/r1-fixture-trust`, tip `cffd2818ea95fc8956e8c5be4b803ac9ee9aa1c4`) | F1 loopback accepted as proof of "non-billable"; F2 a self-written marker file trusted as a checkout | security boundary defect | RED reproduced first-hand on baseline in the R0 worktree (F1 `ADMITTED`; F2 `childRan=true, relayHits=1, upstreamHits=1`) then GREEN |
| R2 (`e4/r2-token-delta`, tip `d03984e0ea3c379d1bc4a74e47054bbde8470e81`) | F3 the campaign TOTAL used as the baseline→candidate delta | deterministic correctness defect with reproducer | RED probe reproduced first-hand (`expected 140 to be -60`; no-journal case) then GREEN |
| R6 (`e4/r6-protocol`, tip `ec98eeec4d60d47282f9bee4e96a54b9a0108371`) | F7 `isToolProtocolValid`/`assertToolProtocol` accepted orphan/duplicate/extra tool results | deterministic correctness defect with reproducer | RED re-run first-hand on baseline (4 failed | 4 passed) then GREEN |
| R4 in-scope half (merged into main `2645006f`) | F5 `PREREG_PRICING_JSON` had no validity window and no bound pricing digest, and read `process.env` instead of the injected env | deterministic correctness defect with reproducer | `apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` (R0's reproducer) |
| R0 / R7 (`e4/r0-gap-matrix`, `e4/r7-readiness`) | evidence + readiness classification | no Runtime change: docs, tests and `scripts/e4/ci-readiness.mjs` only | `docs/evidence/prereg-R0-gap-matrix.md`; the F6 suite above |

So: **code did move this round**, and the movement is bounded to R1/R2/R6 plus R4's in-scope half.
Everything else in this round is evidence and gating.

---

## 6. Still `NOT_PROVEN` / `NOT_RUN` / `BLOCKED`

1. **Real dual pinned build + the real verifier over it** — `realBuildOfflineReady = BLOCKED`
   (`NO_REAL_ARM_PAIR`). Requires two real arm builds at distinct source SHAs carried through the
   real verifier; the readiness script will accept it only with the full evidence block of §2.
2. **Budget evidence chain** — `budgetEvidenceReady = NOT_PROVEN`: per-arm journal attribution is
   recorded but not bound to the trusted manifest/verifier bytes.
3. **A paid FORMAL pre-registration experiment** — `paidExperimentRun = NOT_RUN`. Historical paid
   `agent benchmark` runs exist (§4.2); a formal `prereg run` does not, and this round does not
   authorize one.
4. **Promotion** — `championPromotion = NOT_RUN`.
5. **Ubuntu** — the fixed readiness script has not run on a real Ubuntu runner. The Ubuntu evidence
   quoted here is (a) downloaded historical artifacts and (b) a Windows `process.platform`
   simulation. Cold-start on Ubuntu still has to be executed by GitHub Actions.
6. **Model-quality verdict** — unchanged: 6 weak passes / 0 strong passes on the frozen selection,
   `INCONCLUSIVE`. No number in this document claims otherwise.

---

## 7. Historical sources and their scope (raw-evidence status)

| Document | Round / scope | SHA(s) | Raw evidence |
| --- | --- | --- | --- |
| `docs/evidence/E4-N1-comparable-pair-and-negative-control.md` | N1 — comparable pair, ABI negative control | pair `8265dc39…` / `ee15e7e7…` | measurements in-document; CI artifacts on disk (`r97-r98-closed-loop-*`) |
| `docs/evidence/E4-N1-report.md`, `E4-N1-remaining-handover.md` | N1 follow-ups / handover | N1-era | in-document; some raw runs referenced, not all retained |
| `docs/evidence/E4-N3-report.md` | N3 — pricing/paid admission | N3-era | in-document |
| `docs/evidence/E4-N4-report.md` | N4 — tool budget dimension | N4-era | in-document |
| `docs/evidence/E4-N5-report.md`, `E4-N6-report.md` | N5/N6 — closed loop, verifier | N5/N6-era | in-document |
| `docs/evidence/E4-N7-report.md` | N7 — readiness artifact introduced | `a17cf21bcf82` | `ci-readiness.json` samples quoted; sample is v1 and predates R7 |
| `docs/evidence/E4-N7.4-N8-network-and-pricing-ruling.md`, `E4-N8-paid-handover.md` | N7.4/N8 — network + pricing ruling, handover | N7.4/N8-era | in-document; **the handover's expectations are superseded by §1–§3 here** |
| `docs/evidence/E4-N8-paid-run-executed.md` | N8 — paid `agent benchmark` runs (+ R6 §7) | N8-era; R6 `13c00e0b` | PARTIAL: per-case results not available, failing body not retained, no USD rates |
| `docs/evidence/prereg-N0-gap-matrix.md`, `prereg-next-gap-matrix.md` | N0/B0 — earlier gap matrices | N0/B0-era | in-document; **their "current status" framing is superseded by this page** |
| `docs/evidence/tool-call-efficiency-p1-p7-report.md` | P1–P7 — mechanism rounds | P1–P7-era | in-document |
| `docs/evidence/R6-wire-protocol-offline.md` | R6 — wire protocol (this round) | `13c00e0b` / `a85db6dc` | in-document; local stub, 0 network |
| `docs/evidence/prereg-R0-gap-matrix.md` | R0 — baseline + F1–F7 matrix (this round) | `a85db6dc` | in-document; F1/F2/F3/F7 RED re-run first-hand by R0 |
| this file | R7 — current status | `2645006f` → R7 branch | commands and exit codes below |

---

## 8. Re-running this page's claims (offline, zero paid requests)

```text
# 1. the F6 acceptance + mutation suite (16 cases)
pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts

# 2. the readiness artifact over a real E2E artifact, with the other platform checked at the same SHA
node scripts/e4/ci-readiness.mjs \
  --e2e <prereg-production-e2e.json> --out <ci-readiness.json> \
  --expect-sha <40-hex sha> --run-id <github run id> --os-label <matrix.os> \
  --other-platform-artifact <other-platform ci-readiness.json>

# 3. the gates this document quotes
pnpm typecheck
pnpm test:n0-gaps
pnpm test:red-next-gaps
```

All of the above are local and offline: no provider, no key, no relay, no paid request.
