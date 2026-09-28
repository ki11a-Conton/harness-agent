# R0 — baseline fact sheet and F1–F7 gap matrix

Plan: `plan(20260928-105425).md` §R0 (lines 50–69), with §R4 (F5) and §R7 (F6).
Shared task: `task-1` (owner `r0-recon`). Branch: `e4/r0-gap-matrix`.
Worktree used for every measurement: `%TEMP%\r-wave1-r0` (isolated `git worktree`, so no build
artifact, `dist/` or `.tsbuildinfo` is shared with a parallel teammate).

**Start SHA / baseline: `a85db6dcf1004ef1159f62bc0a11de53247a296c`** (`fix(benchmark,model,contracts): P2-43 …`).

Honesty rules applied in this document:

- A value that was not observed is written `NOT_OBSERVED` (or `null`); it is **never** written `0`.
- A *declared* limitation is not dressed up as an implemented behaviour.
- A row whose defect was reproduced behaviourally is labelled `confirmed`; a row with only a
  source-level observation is labelled `not_reproduced`; a row that needs a platform this machine
  does not have is labelled `environment_blocked`.
- No paid/external request was made. The user's relay (`127.0.0.1:8317`) was never contacted; it is
  not referenced by any command in this document.

---

## 1. Baseline fact sheet

| Fact | Value | Source / note |
| --- | --- | --- |
| HEAD SHA (start and end of R0 measurement) | `a85db6dcf1004ef1159f62bc0a11de53247a296c` | `git log -1 --format='%H %s'` |
| Tree state at baseline | clean except the untracked plan file in the main checkout; the R0 worktree was created from the exact SHA | `git status --porcelain` |
| `pnpm typecheck` (`tsc -b`) on the baseline tree | **exit 0** | run before any R0 file was added |
| `pnpm typecheck` (`tsc -b`) with the R0 files added | **exit 0** | confirms the new `apps/cli/src/r0-*.test.ts` files are typechecked by the cli project (`include: ["src"]`) |
| `pnpm test:n0-gaps` (previous round's RED gate) | **exit 0 — 2 files, 12 passed / 12** | prior-round counterexamples are GREEN at this SHA |
| `pnpm exec vitest run apps/cli/src/prereg-declared-pricing.test.ts` (existing F5-area suite) | **exit 0 — 1 file, 7 passed / 7** | pins the CURRENT `PREREG_PRICING_JSON` behaviour that R4 must change while keeping the mechanism working |
| `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` | **exit 0 — 1 file, 9 passed / 9** | closest existing behavioural suite for the F4 area |
| Node | `v24.14.0` | `node -v` |
| pnpm | `11.21.0` | `pnpm -v` |
| OS (local) | Windows `NT 10.0.26100.0` (`win32`, x64) | `[System.Environment]::OSVersion.VersionString` |
| Ubuntu / GitHub Actions | **NOT_RUN** — no Linux host. Every row below is Windows-local only unless stated | see §6 |
| Frozen 8-case selection `docs/evidence/e4-r87-case-selection.json` | **UNTOUCHED**. Internal digest `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae`; file sha256 `b6539c9b0611e8ad39e85a1901409f662394fc4ca9e29f7f7952042c7a8c8830`; `git diff` empty | no `strongPasses` claim is made or implied anywhere in R0 |

### 1.1 Files R0 created / modified

| Path | Kind | Why |
| --- | --- | --- |
| `apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` | NEW (RED reproducer) | F5: no validity period, no approval-bound pricing digest, `process.env` instead of the injected env |
| `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | NEW (RED reproducer) | F6: prose-based REAL classification + hardcoded Ubuntu `NOT_PROVEN` |
| `apps/cli/test-infra/r0-gaps-vitest.config.ts` | NEW (runner config) | selects exactly the two RED files, mirroring `n0-gaps-vitest.config.ts` |
| `vitest.config.ts` | MODIFIED (2 exclude entries + comment) | **required** so the deliberately-RED files are not collected by `pnpm test`; identical arrangement to the existing `prereg-n0-gaps` / `prereg-next-gaps` pairs. No test behaviour of any existing file changes |

No production source file was edited. The two RED suites stay deliberately failing until R4 (F5) and
R7 (F6) implement the target behaviour; §R0 line 63 explicitly calls for the red cases to be run
independently first and migrated into the formal dual-platform gate afterwards.

---

## 2. R0's own RED reproducers

### 2.1 Literal commands, exit codes and counts (Windows-local)

| # | Command (run from the repo root of the R0 worktree) | Exit code | Counts |
| --- | --- | --- | --- |
| C1 | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts` | **1** | 2 files failed; **9 failed / 3 passed (12)** |
| C2 | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` | **1** | **5 failed / 1 passed (6)** |
| C3 | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | **1** | **4 failed / 2 passed (6)** |
| C4 | `pnpm exec vitest run apps/cli/src/r0-f6-ci-readiness-classification.test.ts` (ROOT config) | **1** | `No test files found` — the root run does not collect the RED files (exclusion verified; the exclude list printed by vitest contains both R0 paths) |
| C5 | `pnpm exec vitest run apps/cli/src/prereg-declared-pricing.test.ts` (positive control that a normal `src` test IS collected) | **0** | 1 file, 7 passed / 7 |
| C6 | `pnpm typecheck` (`tsc -b`) | **0** | — |
| C7 | `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` | **0** | 1 file, 9 passed / 9 |
| C8 | `pnpm test:n0-gaps` | **0** | 2 files, 12 passed / 12 |
| C10 | `pnpm exec vitest run packages/contracts/src/zz-r0-verify-r6-wire-gap.test.ts` (R6's F7 RED file copied unchanged into the R0 baseline worktree; temporary, not committed, removed afterwards) | **1** | 1 file failed; **4 failed / 4 passed (8)** — first-hand baseline reproduction of R6's F7 RED (§3.3) |
| C11 | `pnpm exec vitest run packages/evaluation/src/zz-r0-verify-r1-f1.test.ts` (R1's F1 RED file, temporary copy in the R0 baseline worktree) | **1** | 1 file failed; **3 failed / 4 passed (7)** — first-hand baseline reproduction of R1's F1 RED (§3.3) |
| C12 | `pnpm exec vitest run apps/cli/src/zz-r0-verify-r1-f2.test.ts` (R1's F2 RED file, temporary copy in the R0 baseline worktree) | **1** | 1 file failed; **4 failed / 1 skipped (5)** — first-hand baseline reproduction of R1's F2 RED; `relayHits=1, upstreamHits=1` on the marker-only checkout (§3.3) |
| C13 | `pnpm exec vitest run packages/evaluation/src/zz-r0-verify-r2-f3.test.ts` (R2's F3 RED probe, temporary copy in the R0 baseline worktree) | **1** | 1 file failed; **2 failed / 0 passed (2)** — first-hand baseline reproduction of R2's F3 RED (`expected 140 to be -60`; `expected true to be false`) (§3.3) |

Zero skips were reported in C1–C3, C5, C7, C8. C4 is not a failure of a test — it is the proof that
the RED suites are outside the green regression run.

### 2.2 F5 — `PREREG_PRICING_JSON` is not a frozen identity input (`confirmed`)

Reproducer: `apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` (6 tests: 1 control, 5 RED).
All calls are pure: no provider is constructed, no socket is opened, no credential is used. The
endpoint used in the fixture is the inert string `http://127.0.0.1:45999/v1` (nothing listens there;
it is deliberately not the user's relay).

| Case | Minimal input | OLD behaviour (RED target assertion) | Target behaviour (GREEN) | Vitest failure message observed |
| --- | --- | --- | --- | --- |
| `R0-F5-A` | declaration with `baseUrl` + `source` + `boundByModel` and **no validity metadata at all** | `resolveDeclaredUsdMicrosPerCall(...)` returns `1000000` — a value declared once prices the endpoint forever | `null` (a declaration that cannot state issue/expiry is not a bound price; §R4 "缺失字段…被拒绝") | `AssertionError: expected 1000000 to be null` |
| `R0-F5-B` | declaration with `issuedAt=2020-01-01`, `expiresAt=2020-01-02` (lapsed 6 years before this run) | returns `1000000` — both fields are ignored, the stale bound is still returned | `null` (an expired declaration is void) | `AssertionError: expected 1000000 to be null` |
| `R0-F5-C` | a pre-registration/observation pair that is identical in every field `observationViolationsV2` compares, then the pricing basis is swapped (`pricingDigest` changed, `usdMicrosPerCall` 1 000 000 → 99 000 000) | the current comparison reports **`[]`** — a 99× rate change is not execution-identity drift | at least one violation naming the pricing basis | `AssertionError: expected a pricing-drift violation; got: []` |
| `R0-F5-D` | the declaration present **only** in the injected env (input 1), and present **only** in `process.env` while the call is handed `{}` (input 2) | input 1 → `null` (the injected env is ignored); input 2 → `1000000` (the global env leaks in) | input 1 → `1000000`; input 2 → `null` | `AssertionError: expected null to be 1000000` |
| `R0-F5-E` | the **production call site** `observeExecutionIdentity(root, injectedEnv)` where `injectedEnv` declares 1 000 000 µUSD/call and `process.env` declares 99 000 000 µUSD/call for the same endpoint+model | the observed price is `99000000` — `formalExecutionProfile(env)` / `env["R97_ARM_*"]` use the injected env, but `resolveUsdMicrosPerCall(providerId, query)` (no env parameter) silently reads `process.env` | `1000000` — every identity input comes from the same env | `AssertionError: expected 99000000 to be 1000000` |

Control that PASSES today (`R0-F5-fold`, 1 of the 3 passing assertions in C1): the mechanism R4 must
keep — a declaration carrying `issuedAt`/`expiresAt` prices the relay through
`resolveDeclaredUsdMicrosPerCall(query, env)`, which *does* accept an explicit env. This control
proves the RED cases above fail on their target assertion rather than on a broken fixture, a missing
module or a dependency/build failure. (R4 owns updating it if the new contract makes additional
fields mandatory, e.g. a currency or a covered token ceiling — the control encodes today's minimal
declaration shape, and §R4 #2 adds fields.)

Note on (b): the F5 defect is not only "the JSON has no expiry field". `observationViolationsV2`
(`packages/evaluation/src/tool-call-efficiency-formal-run.ts:369-412`) is the function that turns a
fresh observation into `PREREGISTRATION_IDENTITY_DRIFT`; it compares subject/prompt/provider/
dataset/evaluation digests and **never** compares `usdMicrosPerCall` or any pricing digest. So the
declared rate is an admission-time input, not an approved-and-bound identity value.

### 2.3 F6 — readiness classified from prose, Ubuntu hardcoded (`confirmed`)

Reproducer: `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` (6 tests: 2 controls, 4 RED).
It **executes the real script** `scripts/e4/ci-readiness.mjs` against mutated `--e2e` inputs and
asserts the real JSON artifact it writes. Two deliberate test-harness choices, stated plainly:

1. The three nested gate subprocesses the script starts (`pnpm test:n0-gaps`,
   `pnpm test:red-next-gaps`, docs smoke) are neutralised by a `pnpm` shim first on `PATH`, because
   the subject of these tests is the **classification**, not the gates. A real unshimmed run was
   also executed and is recorded as C9 in §2.4.
2. The Ubuntu case overrides `process.platform` to `"linux"` through a `node --import` preload so
   the Linux branch actually executes. **This is a simulation, not a real Ubuntu runner**; a real
   `ubuntu-latest` artifact is `NOT_OBSERVED` in this round (see §6).

| Case | Minimal input (`readiness.productionOfflineReady`) | OLD behaviour (RED target assertion) | Target behaviour (GREEN) | Vitest failure message observed |
| --- | --- | --- | --- | --- |
| `R0-F6-A` | `"synthetic fixture arm builds (writeArmCheckout equals this)"` (lowercase) | `forwardBasis = "REAL_DUAL_PINNED_BUILD"`, `realBuildOfflineReady = PASS` | not REAL; status not `PASS` | `AssertionError: expected 'REAL_DUAL_PINNED_BUILD' not to be 'REAL_DUAL_PINNED_BUILD'` |
| `R0-F6-B` | `""` (empty string) | `forwardBasis = "REAL_DUAL_PINNED_BUILD"`, `realBuildOfflineReady = PASS` — although the source comment promises "an unreadable statement is UNKNOWN, not real" | not REAL; status not `PASS` | same as A |
| `R0-F6-C` | `"forward closed loop completed; evidence verified by the local harness"` (unrelated prose) | `forwardBasis = "REAL_DUAL_PINNED_BUILD"`, `realBuildOfflineReady = PASS` | not REAL; status not `PASS` | same as A |
| `R0-F6-E` | the same input, but the process really runs the Linux branch (`process.platform === "linux"`, `--os-label ubuntu-latest`) | `platforms.ubuntu.status = "NOT_PROVEN"` (a hardcoded literal, `ci-readiness.mjs:164-167`) even though this process IS the Ubuntu run | `platforms.ubuntu.status = "MEASURED"` | `AssertionError: expected 'NOT_PROVEN' to be 'MEASURED'` |

Controls that PASS today (2 of the 3 passing assertions in C1; `R0-F6-0` and `R0-F6-D`):

- `R0-F6-0`: the script really executes, exits `0`, and the fixture counts really land in the
  artifact (`counts.forwardJournalChargedTokens === 248`) — so the classification inputs are real.
- `R0-F6-D`: an **absent** `readiness` field is already fail-closed (`realBasis = false` →
  `BLOCKED`). The defect is narrower and sharper than "absence is mishandled": only a
  *present-but-unrecognised string* is upgraded to REAL. `R0-F6-E` also asserts
  `artifact.os.platform === "linux"` and `platforms.windows.status === "NOT_OBSERVED"` first, so the
  Ubuntu RED cannot be a failed simulation.

### 2.4 Unshimmed, real-gate run (independent of the vitest suite)

| # | Command | Exit code | Observed |
| --- | --- | --- | --- |
| C9 | `node scripts/e4/ci-readiness.mjs --e2e <e2e.json> --out <out.json> --os-label windows-local` where the E2E body carries `{"ok":true,"readiness":{"productionOfflineReady":"synthetic fixture arm builds"}}` | **0** (45.3 s wall-clock; the three real gates ran) | stdout: `realBuildOfflineReady: PASS`, `forward basis: REAL_DUAL_PINNED_BUILD`; artifact: `platforms.ubuntu.status = "NOT_PROVEN"`, `commandExits.typecheck/test/build = null` |

C9 is the same defect C3 reports, produced by the real script with **no** PATH shim and no
platform simulation. The E2E JSON used for C9 was a minimal probe body (no counts), which is why the
shimmed suite uses a richer fixture.

---

## 3. F1–F7 gap matrix

Legend: **confirmed** = behaviourally reproduced on the target assertion at this SHA;
**not_reproduced** = no behavioural reproducer exists yet (source-level observation only);
**environment_blocked** = needs a platform/tool this machine does not have;
**PENDING_PEER** = owned by another teammate and awaiting their measured command/exit code.

| F# | Severity | Minimal input | OLD behaviour (RED) | Target behaviour (GREEN) | Exact command | Exit code | Label |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | P0 | fixture-mode admission where the observation proves only a **loopback** endpoint (`endpointIsLoopback: true`, `usdMicrosPerCall: null`) and `maxUsdMicros: null` | `endpointIsLoopback === true` is accepted as proof of a non-billable transport, so the paid branch's money cap is skipped: the gate returns `ADMITTED` | a loopback address must not prove "free"; refusal before any provider/counter activity; both loopback counting servers stay at 0 | RED and GREEN: `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-fixture-billing-boundary.test.ts packages/evaluation/src/tool-call-efficiency-fixture-transport-grant.test.ts` (R1 tip `cffd2818ea95fc8956e8c5be4b803ac9ee9aa1c4`) | RED **1** — billing-boundary `Tests 3 failed / 4 passed (7)`; target `AssertionError: code=undefined: expected 'ADMITTED' to be 'REFUSED'`. GREEN **0** — 7 passed + 4 passed; four new R1 files together `21 passed / 2 skipped (23)` | **confirmed + fixed** — R1 measured the pair; **R0 independently re-ran the RED file against unmodified baseline source in its own worktree**: exit **1**, 3 failed / 4 passed (7), same target assertion. R1's physical HTTP: relay 0 / upstream 0 on every refusal, 1/1 in the non-vacuity control; `providerFactoryCalls` 0 on every refusal |
| F2 | P0 | a checkout whose only trust signal is a self-written `.r97-synthetic-fixture-checkout` marker, with a loopback relay forwarding to a pretend billed upstream | `existsSync(marker)` alone marks the checkout trusted: the child STARTED and really reached the relay (`childRan=true, relayHits=1, upstreamHits=1`) | writing/copying/symlinking the marker or swapping the entry must not upgrade trust; refusal (`EGRESS_ISOLATION_UNAVAILABLE`) before the worker starts, relay/upstream 0 | RED and GREEN: `pnpm exec vitest run apps/cli/src/prereg-fixture-checkout-trust.test.ts apps/cli/src/prereg-fixture-checkout-grant.test.ts` (R1 tip `cffd2818ea95fc8956e8c5be4b803ac9ee9aa1c4`) | RED **1** — trust file `Tests 4 failed / 1 skipped (5)`; target `expected null to be 'EGRESS_ISOLATION_UNAVAILABLE'` with `childRan=true, relayHits=1, upstreamHits=1`. GREEN **0** — trust file 4 passed / 1 skipped; grant file 7 passed (+1 skipped) | **confirmed + fixed** — R1 measured the pair; **R0 independently re-ran the RED file against unmodified baseline source in its own worktree**: exit **1**, 4 failed / 1 skipped, same assertion. 2 SYMLINKED-marker cases are **SKIPPED on Windows** (host denies file symlinks without elevation) and are NOT claimed as observed; `providerFactoryCalls` `NOT_OBSERVED` on this path (no factory) |
| F3 | P0 | a real journal fixture with baseline = 100 tokens, candidate = 40 (also 100/100, and swapped arms); plus a no-journal run whose runner self-reports delta 0 | `tokensDelta = journalChargedTokens ?? 0` — the campaign TOTAL 140 is reported as the baseline→candidate delta; with no journal and a self-reported delta of 0, `provenanceComparable` stays true and nothing fires | total 140 / delta −60; total 200 / delta 0; swapping arms inverts only the sign and keeps total 140; a runner self-report cannot move the journal-derived delta; missing journal ⇒ not comparable | RED: `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-token-delta-red-probe.test.ts`; GREEN: the same command plus `packages/evaluation/src/tool-call-efficiency-token-attribution.test.ts` (R2 tip `d03984e0ea3c379d1bc4a74e47054bbde8470e81`) | RED **1** — `Test Files 1 failed (1)`, `Tests 2 failed / 2` (`expected 140 to be -60`; `expected true to be false`). GREEN **0** — probe 2 passed, attribution 12 passed | **confirmed + fixed** — R2 measured the RED→GREEN pair; **R0 independently re-ran the RED probe against unmodified baseline source in its own worktree**: exit **1**, 2 failed / 0 passed / 0 skipped, same two assertions. Real journal numbers from R2's offline E2E (§3.3) |
| F4 | P0 | a model response that declares N tool calls, versus the number of real `ToolOrchestrator` dispatches, plus retries | `formal-run.ts:998-1009/1052-1064` counts the tool calls **declared in the response** and charges them in the generator's `finally`: an after-the-fact tally, not a pre-dispatch reservation; no single global wall-clock deadline (the source states this in a comment — §3.2) | reserve at the real dispatch boundary; declared ≠ executed counts; one shared campaign deadline; count stays capped under retry/concurrency/resume | `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` (closest existing suite: 9/9 pass, i.e. it does NOT cover the pre-dispatch gap) | **0** (9 passed / 9) | **not_reproduced** — source-level observation only; R3 (`task-5`) is `BLOCKED by task-2` and did not run a reproducer this round. The existing N0 matrix already records this half as `NOT_PROVEN` |
| F5 | P1 | (a) a declaration with no validity period; (b) a lapsed declaration; (c) a swapped pricing basis; (d) a declaration in the injected env only / in `process.env` only; (e) `observeExecutionIdentity(root, injectedEnv)` with a conflicting global declaration | declaration accepted forever; `observationViolationsV2` returns `[]` for a 99× rate swap; `resolveUsdMicrosPerCall` returns `null` for the injected env and `1000000`/`99000000` from the global env | validity period required; pricing digest bound into the observation comparison; every identity input read from the env that was handed in | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` | **1** (5 failed / 1 passed of 6) | **confirmed** (R0 owns this reproducer) |
| F6 | P1 | `readiness.productionOfflineReady` = lowercase `synthetic` / `""` / unrelated prose; and a run whose own platform is Linux (`ubuntu-latest`) | any string other than an uppercase-`SYNTHETIC` substring is classified `REAL_DUAL_PINNED_BUILD`, rendering `realBuildOfflineReady = PASS`; `platforms.ubuntu.status` is the hardcoded literal `NOT_PROVEN` | only known enums plus matching evidence may set REAL, unknown = `NOT_PROVEN`; this platform's own measurement is recorded as `MEASURED` | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | **1** (4 failed / 2 passed of 6) | **confirmed** (R0 owns this reproducer). The Ubuntu branch is a `process.platform` **simulation**; a real `ubuntu-latest` artifact is `NOT_OBSERVED` |
| F7 | P1 / re-verification | orphan tool result (`[user, tool(a)]`), duplicate result, extra result, duplicate call id — fed to `isToolProtocolValid` / `assertToolProtocol` | the helpers only detect a MISSING result; orphan/duplicate/extra/duplicate-call-id cases all return `true` / do not throw, so they are not a complete wire-legality assertion | a single complete validity assertion at the real request boundary; invalid views rejected locally with physical HTTP 0; valid tables asserted against the serialized wire body | RED and GREEN are the same command: `pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts` (R6 source commit `13c00e0b476aab1a55b897d8427ef68bc2b8154c`, tip `ec98eeec4d60d47282f9bee4e96a54b9a0108371`) | RED **1** (1 file failed; 4 failed / 4 passed of 8) → GREEN **0** (1 file; 8 passed / 8). Targeted regression at the tip: **0** (11 files / 245 passed / 245). `pnpm typecheck` **0** | **confirmed + fixed** — R6 measured the RED→GREEN pair; **R0 independently re-ran the RED file against unmodified baseline source in its own worktree**: exit **1**, 4 failed / 4 passed, `AssertionError: expected true to be false` (×4). Physical HTTP from R6's strict local stub: wire-illegal views **0** requests (asserted per case), legal flows 2 / 2 / 2→1 / 1 / ≥1 / ≥4 |

### 3.1 What R0 did NOT do

- R0 did **not** write reproducers for F1, F2, F3 or F7 (owned by R1, R2 and R6 respectively). Their
  rows above cite the peers' own planned commands and are marked `PENDING_PEER` until the peers
  report their measured exit codes and counts; this document will be updated with those numbers
  before R0 is declared complete.
- R0 did **not** touch production source (`AGENTS.md`; Runtime Freeze P38.4-11). The only non-test
  edit is the two-line `vitest.config.ts` exclusion that keeps `pnpm test` green while the RED
  counterexamples exist.
- R0 did **not** run the full `pnpm test`, and did not run `pnpm test:red-next-gaps` (the fixed
  `E2E_OBSERVATION_RUN_ID` evidence must not be clobbered by a second Vitest pass).
- R0 did **not** modify `docs/evidence/e4-r87-case-selection.json` and makes no `strongPasses` claim.

### 3.2 Source-level verification R0 performed independently (read-only, not a reproduction)

R0 re-read each peer-owned defect site at `a85db6dc` so that no row in §3 rests on a second-hand
quote. These are **source observations**, and they are labelled as such — they are not behavioural
reproductions and they carry no exit code of their own.

| F# | File and line | What was actually read |
| --- | --- | --- |
| F1 | `packages/evaluation/src/tool-call-efficiency-formal-run.ts:1187-1194` | `const isFixture = auth.fixtureMode === FIXTURE_MODE_SYNTHETIC_OFFLINE;` then `if (!(opts.observation.usdMicrosPerCall === 0 \|\| opts.observation.endpointIsLoopback === true))` → a loopback endpoint alone satisfies the fixture non-billable precondition, and the `else` branch (`:1196-1207`) — which requires `maxUsdMicros` and a known price — is never reached |
| F2 | `apps/cli/src/prereg-arm-executor.ts:415-429` | `const fixtureTrusted = existsSync(join(armDir, FIXTURE_CHECKOUT_MARKER_FILENAME));` — file existence is the only trust input; `egressIsolationCapability()` gates only the NON-fixture path |
| F3 | `packages/evaluation/src/tool-call-efficiency-paired-campaign.ts:572-585` | `const journalTokens = ledgerTotals.journalChargedTokens ?? null;` then `const tokensDelta = journalTokens ?? 0;` — the campaign total is assigned to the baseline→candidate delta; `tokensUncorroborated` requires `journalTokens === null && selfReportedTokens !== 0`, so a self-reported delta of exactly 0 with no journal fires nothing |
| F4 | `packages/evaluation/src/tool-call-efficiency-formal-run.ts:998-1010` | the source itself states: *"Reserving tool quota BEFORE each real ToolOrchestrator dispatch (plan §N4 item 1) is NOT done here"*; the charge happens in the generator `finally` after the response is parsed |
| F7 | `packages/contracts/src/message-protocol.ts:37-75` | `findToolProtocolViolations` computes only `missing = [...requested].filter((id) => !seen.has(id))` and `continue`s when there are none; duplicate ids collapse into the `seen` Set, and orphan/extra results are the concern of a different function (`:77+`). `isToolProtocolValid` is simply `violations.length === 0` |

### 3.3 Peer-reported measured evidence cited in §3

Only measured, reported-by-the-owner facts appear here. R0 did not run the peers' suites except where
it says so explicitly.

**F7 — R6 / `task-4` (branch `e4/r6-protocol`, tip `ec98eeec4d60d47282f9bee4e96a54b9a0108371`, source commit `13c00e0b476aab1a55b897d8427ef68bc2b8154c`; baseline unchanged `a85db6dc…`)**

- RED command: `pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts` on
  UNMODIFIED baseline source → exit **1**, `Test Files 1 failed (1)`, `Tests 4 failed | 4 passed (8)`,
  target failure `AssertionError: expected true to be false` ×4 (orphan result, duplicate result,
  extra result, duplicate call id). The 4 passing controls are the shapes the old helper already
  caught (`assistant[a,b]` answered by only `a`; inserted system message; complete two-result block;
  explicit not-executed results).
- **R0's independent check**: the RED file was copied unchanged into the R0 baseline worktree and run
  there against the unmodified `a85db6dc` source (`pnpm exec vitest run
  packages/contracts/src/zz-r0-verify-r6-wire-gap.test.ts`, temporary copy, not committed). Result:
  exit **1**, 4 failed / 4 passed (8), same four `expected true to be false` assertions. The RED is
  therefore reproduced first-hand on the baseline SHA, not only relayed.
- GREEN command (same file, unchanged): exit **0**, `Tests 8 passed (8)`; targeted regression at the
  tip: 11 files / 245 passed, exit **0**; `pnpm typecheck` exit **0**.
- Physical HTTP from R6's strict `node:http` loopback stub with a throwaway key: wire-illegal views
  **0** requests (asserted per case, including end-to-end corrupt-transcript); legal flows 2 / 2 /
  2→1 (resume) / 1 (cancel) / ≥1 (ask_user) / ≥4 (stall recovery); the trim case asserted "all bodies
  legal" without an exact count (`NOT_OBSERVED`). Real-error bundle: stub answered HTTP 400 with
  `{"code":11148,…}`; the error carried `provider {kind:"http", status:400}` and a redaction-safe
  bundle, asserted free of key, user text and tool output. Relay contacted: **none** — the old
  report's hypothesis about the real 400 remains unverified; status recorded as
  `fixed / pending real-world verification`.
- This is a Runtime change under AGENTS.md Runtime Freeze P38.4-11 item 1 (deterministic correctness
  bug with a reproducer), not a re-verification-only outcome.

**F1 + F2 — R1 / `task-2` (branch `e4/r1-fixture-trust`, tip `cffd2818ea95fc8956e8c5be4b803ac9ee9aa1c4`, baseline `a85db6dc…`)**

- RED recipe (R1's, verbatim): restore the baseline sources only
  (`git checkout a85db6dc -- packages/evaluation/src/tool-call-efficiency-formal-run.ts apps/cli/src/prereg-arm-executor.ts apps/cli/src/prereg-production-runner.ts`)
  and run the same test command. The R0 worktree is already at the baseline SHA, so R0 ran the RED
  files there directly with no restore step.
- F1 RED: `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-fixture-billing-boundary.test.ts`
  → exit **1**, `Tests 3 failed | 4 passed (7)`,
  `AssertionError: code=undefined: expected 'ADMITTED' to be 'REFUSED'` (a fixture admission with
  `endpointIsLoopback: true` and `maxUsdMicros: null` was `ADMITTED` at baseline).
  **R0's independent re-run in its own baseline worktree** (file copied temporarily, not committed):
  exit **1**, 3 failed / 4 passed (7) — identical.
- F2 RED: `pnpm exec vitest run apps/cli/src/prereg-fixture-checkout-trust.test.ts` → exit **1**,
  `Tests 4 failed | 1 skipped (5)`,
  `a marker-only checkout must be refused before the worker starts (observed: code=null, detail=,
  childRan=true, relayHits=1, upstreamHits=1): expected null to be 'EGRESS_ISOLATION_UNAVAILABLE'` —
  i.e. on baseline the marker-only checkout really started the worker and it really reached the
  local relay, which forwarded to the pretend billed upstream.
  **R0's independent re-run in its own baseline worktree**: exit **1**, 4 failed / 1 skipped (5),
  identical message including `relayHits=1, upstreamHits=1`.
- GREEN (R1, at the tip): billing-boundary 7 passed; transport-grant 4 passed; combined exit **0**;
  trust file 4 passed / 1 skipped; grant file 7 passed (+1 skipped); combined exit **0**; four new
  files together `21 passed / 2 skipped (23)`, exit **0**.
- Physical HTTP on the two `127.0.0.1` counting servers (relay → pretend billed upstream): relay 0 /
  upstream 0 on every refusal; 1/1 in the non-vacuity control, which proves the counters are live and
  that a loopback address genuinely can carry the traffic. `providerFactoryCalls` 0 on every refusal;
  on the admitted injected-transport positive the gate's `providerFactoryCalls = 1` while the
  operator factory entries stayed 0 (`not.toHaveBeenCalled`).
- Skipped / not observed: the 2 **symlinked-marker** cases skip on Windows (host denies symlinks
  without elevation) and are reserved for Ubuntu CI. R1 reports `NOT_OBSERVED` for
  `providerFactoryCalls` on the F2 path (no factory there).
- Adjacent CI steps R1 ran locally on the tip: `node scripts/e4/prereg-production-e2e.mjs` exit **0**
  (negative 9/9 refusals with 0 HTTP; POS-EXEC 124 arms / 124 physical / 124 verified, operator
  factory entered 0; POS-FWD now `refusedByDesign=true refusalCode=FIXTURE_TRANSPORT_NOT_NON_BILLABLE
  httpRequests=0 armRecords=0`), `node scripts/e4/n5-prereg-closed-loop.mjs` exit **0** (127/127),
  `pnpm typecheck` exit **0**, `pnpm test:n0-gaps` 12/12 exit **0**, `pnpm test:red-next-gaps` 14/14
  exit **0** (run in R1's own worktree, so the fixed `E2E_OBSERVATION_RUN_ID` evidence of the shared
  checkout is untouched). Full `pnpm test` deliberately not run; Ubuntu-Actions not run.

**F3 — R2 / `task-3` (branch `e4/r2-token-delta`, tip `d03984e0ea3c379d1bc4a74e47054bbde8470e81`; the offline E2E ran at parent `8673af50ff53fa9edd63fe894ac51b417d84113e`; baseline `a85db6dc…`)**

- RED command: `pnpm exec vitest run packages/evaluation/src/tool-call-efficiency-token-delta-red-probe.test.ts`
  → exit **1**, `Test Files 1 failed (1)`, `Tests 2 failed / 2` (0 passed, 0 skipped):
  `[F3.a] AssertionError: expected 140 to be -60` at
  `expect(aggregate.decision.statistics.tokensDelta).toBe(-60)` — the campaign TOTAL was reported as
  the baseline→candidate DELTA; `[F3.b] AssertionError: expected true to be false` at
  `expect(aggregate.decision.gates.provenanceComparable).toBe(false)` — no journal plus a
  self-reported delta of 0 stayed "comparable".
  **R0's independent re-run in its own baseline worktree** (probe file copied temporarily, not
  committed): exit **1**, 2 failed / 0 passed, both assertions reproduced verbatim.
- GREEN (same tip): probe exit **0**, 2 passed; `tool-call-efficiency-token-attribution.test.ts`
  exit **0**, 12 passed. Literal arithmetic asserted through the real aggregate entry:
  baseline 100 / candidate 40 ⇒ total **140**, delta **−60**; baseline 100 / candidate 100 ⇒ total
  **200**, delta **0**; arm swap ⇒ −60 → +60 with total still 140; a runner self-report of 10 000 000
  tokens leaves the journal-derived delta at **−60**.
- Real journal numbers for the offline production E2E (`node scripts/e4/prereg-production-e2e.mjs`,
  exit **0**, `PASS`, at `8673af50`, win32-x64):
  - in-process: total **1240**, baseline **620**, candidate **620**, delta **0**,
    `basis = JOURNAL_PER_ARM`, requests 62/62, reservedUpperBound 0, physicalCalls 124,
    decision `INCONCLUSIVE`;
  - forward (the shipped release CLI as a subprocess): total **248**, baseline **124**,
    candidate **124**, delta **0** — the old artifact reported total 248 *and* delta 248; requests
    62/62, `physicalStubRequests` 124, `ledgerCommitted` 124, `ledgerUnknown` 0,
    `evidenceVerified` 124/124, `costMatchesJournal = true`, decision `INCONCLUSIVE`.
- Verifier strength: per-run evidence re-verified from raw artifact bytes (124/124). The
  per-request journal attribution is **not yet** bound to the manifest/verifier bytes — R2 declares
  that `NOT_PROVEN`.
- This is a Runtime change under Runtime Freeze P38.4-11 item 1 (deterministic correctness bug with a
  reproducer). Windows-local only; Ubuntu-Actions not run.

---

## 4. Observability ledger for the R0 reproducers

| Dimension | F5 suite | F6 suite |
| --- | --- | --- |
| provider factory calls | `NOT_OBSERVED` (no factory is constructed or instrumented by the reproducer) | `NOT_OBSERVED` (the readiness script never constructs a provider) |
| physical HTTP requests | `NOT_OBSERVED` — no transport is constructed, no socket is opened; the loopback string in the fixture is inert | `NOT_OBSERVED` — local child processes and files only; no network code runs |
| journal total / per-arm / delta | `NOT_OBSERVED` (not on this code path) | `NOT_OBSERVED` — the counts in the F6 fixture (248 charged tokens, 124 committed) are **fixture input**, copied through by the script, not measurements |
| verifier strength | `NOT_OBSERVED` | `NOT_OBSERVED` |
| model-declared tool calls vs actual dispatches | `NOT_OBSERVED` | `NOT_OBSERVED` |

---

## 5. Still `NOT_OBSERVED` / `BLOCKED` after R0

1. **Ubuntu / GitHub Actions**: no row in this document was executed on Linux. The F6 Ubuntu case
   is a `process.platform` simulation on Windows. A real `ubuntu-latest` run of
   `scripts/e4/ci-readiness.mjs` remains `NOT_OBSERVED` (and is exactly the artifact that currently
   hardcodes `NOT_PROVEN`).
2. **Peer-owned rows are now measured**: F1/F2 (R1, tip `cffd2818…`), F3 (R2, tip `d03984e0…`) and
   F7 (R6, tip `ec98eeec…`) all carry a RED command, a GREEN command, exit codes and counts, and R0
   independently re-ran each RED file against unmodified baseline source in its own worktree
   (C10–C13). Residual items that remain `NOT_OBSERVED` on the peer side and are **not** claimed as
   observed: the 2 symlinked-marker F2 cases (skipped on Windows, reserved for Ubuntu CI); the
   per-request journal ↔ manifest/verifier byte binding (R2 declares `NOT_PROVEN`).
3. **F4**: `not_reproduced`. The pre-dispatch reservation / global-deadline half is still
   `NOT_PROVEN`; R3 (`task-5`) is blocked by R1 and produced no reproducer this round.
4. **GREEN results for R0's own F5/F6 rows**: not produced — R0 owns no fix, so the F5 and F6 rows
   are RED→no-GREEN at this commit. Their target assertions are the acceptance criteria R4 (F5) and
   R7 (F6) must turn green; §R0 line 63 calls for the red cases to run independently first and move
   into the formal dual-platform gate after the fix. (The peer-owned rows DO carry a measured GREEN —
   see §3.3.)
5. **Provider/HTTP/journal/verifier numbers for the F5 and F6 gaps**: `NOT_OBSERVED` — neither
   defect is on a billed path, so nothing was billed and nothing is claimed.
