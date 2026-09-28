# E4 / N1 — handover: the two unfinished items (arm re-pin · `strongPasses=0`)

Written at handover. Platform during the recorded work: **Windows 10 / PowerShell 7, Node `v24.14.0`**.
This document is self-contained: it assumes the reader has **no** prior conversation context.
Everything below marked **MEASURED** was produced by a command whose output is quoted.
Nothing here is inferred from a source string alone, and no unobserved value is written as `0`.

## 0. Status at handover

| Item | Status | Commit |
|---|---|---|
| Delete `plan(20260926-175819).md` from remote `main` | **DONE, PUSHED** | `e1e4a637` |
| Operator-declared relay pricing (paid path no longer refused on an unknown rate) | **DONE, PUSHED** | `433ef314` |
| Task 4 step 1 — publish the baseline arm branch | **DONE, PUSHED** | branch `e4/n1-baseline-comparable` |
| Task 4 steps 2–4 — re-pin the closed-loop default arm pair | **DONE** — see §10 | this round |
| Task 3 — `strongPasses` is structurally `0` | **DONE (Design B)** — root cause re-measured and CONFIRMED; a false-positive `strong` found and fixed — see §10.2 | this round |
| CI on current `main` (`433ef314`) | **WAS RED** on both platforms (`36325754535` @ `0f02327`) — `docs` gate failed: `HANDOVER.md` missing + `plan.md` dangling. **FIXED** — see §10.3 | this round |

> **The two tasks in this document are closed.** §2 and §3 remain as the analysis that was handed
> over; the round that finished them is recorded in **§10** below, with its own measured evidence.

Read §1.3: earlier runs show as `cancelled` because pushes landed minutes apart and the concurrency group
supersedes the in-flight run. That is *superseded*, not *failed*.

## 1. Reproduce the starting state

### 1.1 Tree and revisions

```powershell
cd "D:\Download games\harness agent"
git log --oneline -3
git status --porcelain
git ls-remote origin refs/heads/main refs/heads/e4/n1-baseline-comparable
git cat-file -t 8265dc39f74b3d556e059bb86b1cc192357e21dd
git cat-file -t ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd
```

Expected (MEASURED):

```
433ef314 feat(prereg): let an operator DECLARE the rate for a relay, so the paid path is usable
e1e4a637 chore: remove plan(20260926-175819).md from the repository
6629c5cf fix(ci): run the N7 gates AFTER the strict usage audit so they cannot clobber it
# git status --porcelain → (empty; tree clean)
8265dc39f74b3d556e059bb86b1cc192357e21dd	refs/heads/e4/n1-baseline-comparable
433ef314376063de006216e89ea7baf49acc5f09	refs/heads/main
commit
commit
```

`git cat-file -t` returning `commit` for **both** target SHAs is the check that the pair the re-pin
binds actually exists locally. The candidate `ee15e7e7…` is already an ancestor of `main`, so it needs
no branch; the baseline `8265dc39…` needed one and now has it on the remote, so CI can fetch it
(CI checks out with `fetch-depth: 0`).

### 1.2 The N1 target pair

| Arm | SHA | Why this one |
|---|---|---|
| baseline | `8265dc39f74b3d556e059bb86b1cc192357e21dd` | the comparable baseline for N1 |
| candidate | `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` | the N1 candidate |

### 1.3 CI verification is OUTSTANDING — do this first

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"   # required; see §7
gh run list --branch main --limit 6
gh run view <run-id> --json status,conclusion,headSha --jq '"status=\(.status) conclusion=\(.conclusion) sha=\(.headSha)"'
```

At handover (MEASURED):

```
in_progress  ci  main  push  36325303904  3m34s  2026-09-27T14:16:16Z   ← sha 433ef314 (current main)
completed cancelled  ...   36325119259   e1e4a637
completed cancelled  ...   36324548575   6629c5cf
completed cancelled  ...   36324441535   a322a212
completed failure    ...   36323899133   3d6e7562
completed success    ...   36299558711   57c26110   ← the last run that completed green
```

**Why the earlier runs were cancelled:** several pushes landed within minutes of each other, and the
workflow's concurrency group cancels the in-flight run on a new push. `cancelled` here therefore means
*superseded*, not *failed*.

**What IS verified at `433ef314` (current `main`) — MEASURED from run `36325303904`, step level:**

| Job / step | ubuntu-latest | windows-latest |
|---|---|---|
| `r97-r98 closed loop` (whole job) | **success** | **success** |
| ├ A7 production-offline E2E | success | success |
| ├ Run the offline closed loop (setup → acceptance → suite → matrix → identity) | success | success |
| ├ N5 offline pre-registration closed loop (0 provider calls) | success | success |
| └ N7 separated readiness levels | success | success |
| `coverage gate` (whole job) | success | — |
| `offline cold-start` (whole job) | success | — |
| `Strict usage audit of the named run (E4-R24 independent stage)` | **success** | **success** |
| `Upload observation evidence (E4-R24)` | success | success |
| `N7 — N0 behavioural gate + legacy R97 cases` | success | success |
| `N7 — documentation smoke` | success | success |
| `Unit and integration tests` | success | success |
| `Typecheck` / `Build` | success | success |

At the moment of writing, the two `install · typecheck · test · build · benchmark-smoke · audit` jobs were
still `in_progress` — but **only on their trailing upload/evidence steps (25 onward)**; every test, gate
and audit step had already reported `success`, and no step reported a failure. The specific defect this
handover's history concerns — the strict usage audit failing because the N7 gates re-wrote the fixed
`E2E_OBSERVATION_RUN_ID` evidence — is therefore **fixed and verified on both platforms at `433ef314`**
(§2.4).

**First action for the next agent:** confirm that run (or the fresh run triggered by this document's own
commit) reaches an overall `success`. If a step fails, fix it before starting §2 or §3 — and note that
**any** push to `main` cancels the in-flight run, so batch your pushes.

## 2. Task 4 — re-pin the closed-loop default arm pair

### 2.1 Correction to the original instruction

The original instruction read as "the repo's default arm SHAs were not re-pinned". The accurate scope is
narrower and the blast radius is **90 lines across 26 files** (MEASURED, `git grep -c -E "e9776ba|a203737"`).
**Most of those must NOT move:**

| Category | Files | Action |
|---|---|---|
| Production mechanism constants | `packages/core/src/runtime/r87-zero-call-replay-ab.ts:421` (`R87_BASELINE_REFERENCE_SHA`), `packages/evaluation/src/r92-plan.ts:49,55` (`R92_BASELINE_SHA`/`R92_CANDIDATE_SHA`) | **KEEP** — load-bearing; they feed ancestry checks and `computeArmPlanDigest` |
| R87 mechanism test fixtures | `packages/core/src/runtime/r87-zero-call-replay-ab.test.ts:53-54` | **KEEP** |
| Committed historical evidence | `docs/evidence/e4-r87-phase-a-manifest.json`, `e4-r88-phase-a-manifest.json`, `e4-r90-phase-a-manifest.json` | **KEEP** — these record what a past experiment executed; rewriting them falsifies history |
| Frozen selection payload | `docs/evidence/e4-r87-case-selection.json` (`armRule` prose names both SHAs) | **KEEP** — any edit changes the digest, see §3.4 |
| Historical reports | `docs/E4-R86/R87/R88-R91/R90/R92/R97/R99-R101*.md` | **KEEP** |
| Source comments | `packages/core/src/runtime/runtime.ts:174`, `tool-call-controller.ts:107`, `scripts/e4/r97-offline-acceptance.mjs:855` | **KEEP** (prose about the same mechanism) |
| **Closed-loop default pair** | `scripts/e4/r97-observe-arms.mjs:70-71` | **CHANGE** |
| **D6 observed-SHA assertion** | `packages/evaluation/src/r97-driver-closed-loop.test.ts:1683-1684` | **CHANGE** |
| **R101 defaults assertion** | `packages/evaluation/src/r97-driver-closed-loop.test.ts:1775-1776` | **CHANGE** |
| **CI arm-binding env** | `.github/workflows/ci.yml:905-906` | **CHANGE** |
| Current-status docs | `docs/evidence/E4-N1-*.md`, `docs/evidence/prereg-N0-gap-matrix.md`, `docs/evidence/E4-N7.4-N8-network-and-pricing-ruling.md`, `docs/evidence/E4-N8-*.md` | **UPDATE** if they assert the pair is live |

The distinction that matters: `e9776ba → a203737` is the **R87/R92 mechanism experiment's** frozen pair
(pre-R86 progress-blind gate → the H2 fix). The closed-loop's `DEFAULT_*` is only a *convenience default*
for the acceptance test's "two real arm builds must exist" precondition. Re-pinning the latter does not
change the former, and must not.

### 2.2 Exact edits

**(a)** `scripts/e4/r97-observe-arms.mjs:70-71`

```js
export const DEFAULT_BASELINE_SHA = "e9776ba66190ea63b1bacb685c91aa900b6935e7";
export const DEFAULT_CANDIDATE_SHA = "a20373743b56de6a3a110fecdd254737ece71afa";
```
→
```js
export const DEFAULT_BASELINE_SHA = "8265dc39f74b3d556e059bb86b1cc192357e21dd";
export const DEFAULT_CANDIDATE_SHA = "ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd";
```

Also revise the doc comment above it (`:61-69`), which currently claims these are "the SAME two SHAs the
CI job uses and the D6 test asserts against" — after the change that sentence must describe the N1 pair,
not the R87 mechanism pair, or it will read as stale in exactly the way §5 warns about.

**(b)** `packages/evaluation/src/r97-driver-closed-loop.test.ts:1683-1684` — D6.

```ts
expect(observations["baseline"]!.sourceSha).toBe("e9776ba66190ea63b1bacb685c91aa900b6935e7");
expect(observations["candidate"]!.sourceSha).toBe("a20373743b56de6a3a110fecdd254737ece71afa");
```
→ the two new SHAs. This assertion is about the SHA **actually checked out** in the arm directories
(`:1671-1680` passes `armDirs: { baseline: BASE, candidate: CAND }` from `R97_ARM_BASELINE_DIR` /
`R97_ARM_CANDIDATE_DIR`), so it moves **only together with** whatever built those arms.

**(c)** `packages/evaluation/src/r97-driver-closed-loop.test.ts:1775-1776` — R101.

```ts
expect(setup.DEFAULT_BASELINE_SHA).toBe("e9776ba66190ea63b1bacb685c91aa900b6935e7");
expect(setup.DEFAULT_CANDIDATE_SHA).toBe("a20373743b56de6a3a110fecdd254737ece71afa");
```
→ the two new SHAs. Keep it as the single source of truth: it is what makes (a) and (d) unable to drift.

**(d)** `.github/workflows/ci.yml:905-906`

```yaml
      R97_ARM_BASELINE_SHA: "e9776ba66190ea63b1bacb685c91aa900b6935e7"
      R97_ARM_CANDIDATE_SHA: "a20373743b56de6a3a110fecdd254737ece71afa"
```
→ the two new SHAs. **This is required, not optional:** R101 at `:1794-1796` iterates over
`setup.DEFAULT_*_SHA` and asserts `ci.yml` literally `toContain(sha)`. Change (a) without (d) and R101
fails. The comment above these lines ("The historical arm revisions") also needs rewording.

### 2.3 Verification recipe

The D6 path is not a unit test you can satisfy with a string edit — it requires **two real arm builds**.
The runner does that for you:

```powershell
pnpm typecheck
node scripts/e4/r97-closed-loop.mjs --all --out .ci/r97-r98 --arms-root "$env:TEMP/r97-arms"
```

`--all` runs setup (creates and builds **both** arms via `r97-observe-arms.mjs` — two `pnpm install` +
two `pnpm build`) → acceptance → suite → matrix → identity. Both `pnpm install` and `pnpm build` are slow;
budget accordingly and do not kill it early (an earlier attempt in this work was abandoned at 24 s of
sampling on an incorrect assumption about case count — the run was not actually stalled).

Then confirm the two assertions directly:

```powershell
npx vitest run packages/evaluation/src/r97-driver-closed-loop.test.ts
```

**Open semantic question to check, not assume:** `:1685` asserts the two arms produce **different**
`planDigest` values, and other tests in this file may implicitly assume the baseline arm is the
progress-blind pre-R86 revision. Before pushing, confirm the new pair still satisfies every assertion in
that file; if some test encodes R87-mechanism semantics rather than "two distinct real revisions", that
test is the thing to resolve — do **not** loosen it to make the re-pin pass.

### 2.4 Do not regress the CI step ordering

`.github/workflows/ci.yml` was reordered in `6629c5cf` and the ordering is **load-bearing**:
`Build` → strict usage audit → upload observation evidence → N7 gates → benchmark smoke.

The N7 gate steps run a second vitest pass under a **fixed** `E2E_OBSERVATION_RUN_ID`. When they ran
*before* the audit, they re-wrote the observation evidence for that fixed run id and truncated the
committed rows — a green run uploaded `e4-r24-ubuntu-latest-<id>.jsonl` at `4789` bytes, the broken run at
`0` bytes, with the candidates file byte-identical at `3354`. Symptom: only the strict usage audit fails,
all tests pass. The inline comment recording this must stay accurate.

## 3. Task 3 — `strongPasses` is structurally `0`

### 3.1 The rule (MEASURED from source)

`passStrengthOf` (`scripts/e4/r97-arm-exec.mjs:323-328`):

```js
if (writeTarget === null || writeTarget === undefined) return null;
if (writeTarget.contentSource === "command-literal") return "strong";
if (writeTarget.contentSource === "offline-banner") return "weak";
```

and `writeTargetOf` (`:258-293`) returns `null` **first** if the case declares no `kind: "artifact"`
verifier, before it ever looks for a literal. `"command-literal"` additionally requires a
`kind: "command"` verifier whose `args` contain the regex `!==\s*'([^']*)'`, i.e. the case's own command
check embeds the exact bytes the seam writes.

So `strong` requires **both** an artifact verifier **and** a recoverable literal. The consumer is
`scripts/e4/r97-campaign-driver.mjs:145-151` (`strongPasses` = `verifierPassed === true && passStrength === "strong"`).

### 3.2 MEASURED: the frozen selection contains no `strong` case

The frozen acceptance selection is `docs/evidence/e4-r87-case-selection.json` (8 cases, loaded via
`R97_SELECTION_PATH` in `packages/evaluation/src/r97-plan.ts:124`, schema `R97_SELECTION_SCHEMA` at `:795`):

| Case | role | verifier shape | resulting strength |
|---|---|---|---|
| `regression/reg-16-cicd-step` | TARGET | artifact-only | `weak` |
| `stress/stress-many-artifacts` | TARGET | artifact-only | `weak` |
| `stress/stress-very-long-json` | TARGET | artifact-only | `weak` |
| `regression/reg-24-error-handling` | COUNTEREXAMPLE | command-only | `null` |
| `regression/reg-03-add-import` | COUNTEREXAMPLE | command-only | `null` |
| `regression/reg-14-stack` | COUNTEREXAMPLE | command-only | `null` |
| `regression/reg-17-gcd` | COUNTEREXAMPLE | command-only | `null` |
| `regression/reg-06-json-parse-test` | COUNTEREXAMPLE | command-only | `null` |

This is exactly the partition asserted by `packages/evaluation/src/r97-offline-seam.test.ts:106-119`
(`COMMAND_ONLY` = the five COUNTEREXAMPLE cases, `ARTIFACT_ONLY` = the three TARGET cases).

**Therefore `strongPasses === 0` for the frozen selection by construction, not by any defect in the
harness.** No runtime change can raise it for this case set: the cases are what they are.

### 3.3 MEASURED: exactly three cases in the whole tree can produce `strong`

Swept every `benchmarks/**/case.json` for artifact-verifier presence **and** the `!== '<literal>'` pattern:

| Case | has artifact verifier | literal |
|---|---|---|
| `benchmarks/holdout/ho-31-memory-guard-null` | yes | `hi guest` |
| `benchmarks/r98-fixtures/r98-tool-write-request` | yes | `r98-request-first-write` |
| `benchmarks/r98-fixtures/r98-tool-write-second` | yes | `r98-second-distinct-write` |

18 cases carry a recoverable literal in total, but 15 of them declare **no** artifact verifier
(`benchmarks/regression/reg-02…`, `reg-12…`, `reg-15…`, `reg-18…`, `reg-30…`, `baseline-e4-r74/*`, several
`holdout/*`), so `writeTargetOf` returns `null` for them before the literal is reached. **None of these
three cases is in the frozen 8.**

### 3.4 Why the frozen selection must not be edited

`docs/evidence/e4-r87-case-selection.json` is **digest-bound before execution**:

- stored digest: `0d8af323110301e0392c77d595c8c34f5f01851ffe6844f0ed7fab49703465ae`
- bound as the production constant `R87_SELECTION_DIGEST` at `packages/core/src/runtime/r87-zero-call-replay-ab.ts:37`
- recomputed fail-closed from the payload with the `digest` field excluded, and compared to **both** the
  file's own digest and the constant (`r87-zero-call-replay-ab.ts:314-329`; `r97-plan.ts:844-862`, code
  `SELECTION_DIGEST_MISMATCH`)
- referenced by the committed manifests `e4-r87-phase-a-manifest.json`, `e4-r88-phase-a-manifest.json`,
  `e4-r90-phase-a-manifest.json` via `selectionDigest`

Editing the case list breaks the digest and falsifies committed historical evidence.
**Do not touch it.** (There is a test that deliberately proves the refusal:
`packages/evaluation/src/r97-plan.test.ts:695-722`.)

### 3.5 The two viable designs

**Design A (recommended) — add a SECOND, separately-declared acceptance case set.**
Introduce a new selection file (e.g. `docs/evidence/e4-n1-strong-case-selection.json`) with its own
schema and digest, containing at least one literal-bearing artifact case (the two `r98-fixtures` cases are
purpose-built for exactly this and live outside every frozen set; `ho-31` is a holdout case, so prefer the
fixtures if the N1 case set must stay non-holdout). Wire it as an *additional* selection the N1 report can
consume alongside the frozen one. The frozen 8 keep producing their `weak`/`null` results unchanged, and
the N1 report gains a measured `strongPasses > 0` from a case set that is honest about being new.

**Design B — declare the limitation.** Record in the N1 report that `strongPasses === 0` is **structural
for the frozen selection**, cite §3.2, and label the N1 comparability claim `PARTIAL`. No code change.
This is a legitimate outcome and is cheaper; it is the right choice if N1's value does not depend on
`strong`.

Do **not** take the third path of editing the frozen 8 or weakening `passStrengthOf` to reclassify
`offline-banner` as `strong` — that inverts the distinction the function exists to make (an artifact
verifier's rule is `exists && (mustChange !== true || touched)`, which never inspects content, so a
`weak` pass proves only that the write reached the workspace).

### 3.6 Acceptance criterion for Task 3

Whichever design: the N1 report must state `strongPasses` with either a MEASURED non-zero value from a
declared case set, or the explicit structural argument from §3.2 quoting the actual numbers. Silent `0`
with no explanation is the failure mode to avoid.

## 4. Standing invariants — do not break these

1. **Runtime freeze (P38.4-11).** All of this is Harness/evaluation tooling. Do not modify runtime
   behaviour without one of the five sanctioned defects.
2. **The frozen selection digest** (§3.4) and the `R87_*` / `R92_*` production constants (§2.1).
3. **CI step ordering** (§2.4).
4. **Honesty labels.** Unknown stays `NOT_OBSERVED` / `null`; a fixture-only pass is `FIXTURE_PASS`;
   `NOT_RUN` is never rewritten as `PASS`. Real provider factories, physical requests and cost must be
   reported as observed values, and `0` only when actually counted.
5. **No paid path by default.** No real API key in any tracked file; no `paid:true` auto-authorization;
   no automatic promotion.

## 5. Known stale comment (small, real)

`packages/core/src/runtime/r87-zero-call-replay-ab.test.ts:7` says the selection digest is
`227d00b6…`. That value appears **nowhere else in the repository** (MEASURED: `git grep -n 227d00b6` → 1
hit, that comment). The real frozen digest is `0d8af323…` and is cited correctly in
`docs/E4-R87-report.md:23,157`, `docs/E4-R88-R91-evidence-table.md:171`, `docs/E4-R92-report.md:39,544`,
`docs/E4-R97-report.md:511`, and the selection file itself at line 168. This is a stale comment, not a
second digest — fix it when convenient. **Do not** "fix" it by changing the constant.

## 6. The paid path — how to actually invoke it now

Committed in `433ef314`. Two independent gates exist; do not conflate them.

**Gate A — the CLI's billed-run cap chain (E3-01).** Required for `agent benchmark`:
`RUN_PAID_BENCHMARKS=1`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, plus a **positive**
`--max-model-calls` (an unlimited value is refused for billed runs) and `--plan-digest <sha256>` taken
from a `--dry-run` invoked with **identical flags** — the caps are part of the hashed plan, so changing
any flag invalidates the digest.

**Gate B — the prereg production runner's money bound.** This is the one that used to refuse a relay.
The operator may now *declare* the rate instead of the harness failing closed:

```powershell
$env:PREREG_PRICING_JSON='{"baseUrl":"http://127.0.0.1:8317/v1","source":"<who declared it and when>","boundByModel":{"<model>":1000000}}'
```

Semantics, implemented in `apps/cli/src/prereg-execution-identity.ts` (`DECLARED_PRICING_ENV` at `:207`,
`parseDeclaredPricing` at `:214`, `resolveDeclaredUsdMicrosPerCall` at `:244`): the declaration is
consulted **before** the snapshot and the non-empty-baseUrl refusal; it must carry a non-empty `source`
(traceability), the bounds must be positive safe integers, and it must match the endpoint and model
exactly (a trailing slash is a different endpoint). Absent, malformed, untraceable or non-positive
declarations still **refuse** — the money bound is not deleted, it is made declarable. There is no
default and no unlimited mode. Tests: `apps/cli/src/prereg-declared-pricing.test.ts` (7 tests).

**Measured paid results from this work** (for reference; both are disappointing and neither is a Harness
infrastructure failure):
- `workbuddy-deepseek-v4.1-flash`, 1 case → `model_error` (upstream HTTP 400 / code 11148 — model-specific);
  6 model calls / 9 tool calls; 18,371 in / 566 out tokens.
- `deepseek-v4-flash`, 1 case → `agent_limit`; 21 model calls / 29 tool calls; 204,064 / 5,780 tokens.
- `deepseek-v4-flash`, bounded 3-case run: 2/3 passed in 101 s (p50 30,222 ms / p95 56,733 ms) —
  PASS `reg-01` (`verified_complete`, 5 calls), FAIL `reg-02` (`agent_limit`, 24 calls),
  PASS `reg-03` (`verified_complete`, 13 calls).

The full-suite paid N8 run remains outstanding.

## 7. Environment notes (Windows)

- `gh` needs the proxy explicitly; `git` has it in config already:
  ```powershell
  $env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"
  ```
  `git config --get http.proxy` → `http://127.0.0.1:7897`. Without the env vars `gh` fails with
  `net/http: TLS handshake timeout`. A `HEAD` request to the proxy root returns `400` — that is normal for
  a CONNECT-style proxy and does **not** mean it is down.
- Pushing uses `https://x-access-token:<token>@github.com/ki11a-Conton/harness-agent.git`.
- Multi-line commit messages: write the message to a file and use `git commit -F <file>`. PowerShell
  mangles escaped quotes inside `-m` and produces pathspec errors.
- In PowerShell interpolate as `${a}` inside double quotes; `"attempt $a:"` is a ParserError.
- `.ci/` and `dist/` are gitignored. Arm worktrees belong under `%TEMP%`.
- Local test baseline: `pnpm test` → 22 failed | 7096 passed | 3 skipped (7121); CI passes all
  (ubuntu 7111 passed / 10 skipped, windows 7120 passed / 1 skipped). `pnpm typecheck` → exit 0.

## 8. Residuals carried forward (not addressed here)

| ID | Residual | Label |
|---|---|---|
| N1 | `strongPasses` structural `0` for the frozen selection | **PARTIAL** — see §3 |
| N1 | Closed-loop default arm pair still the R87 pair | **NOT STARTED** — see §2 |
| N2 | Enforce git HEAD / clean tree / closure without `R97_ARM_REQUIRE_GIT` | **PARTIAL** |
| N4 | Reserve tool quota before each dispatch; global wall-clock deadline (a billed 30-case run gave no progress signal) | **PARTIAL** |
| N5 | In-worker egress block, unsigned marker, IPC frame-size | **PARTIAL** |
| N6 | Full `armRunId ↔ request IDs ↔ ledger ↔ verifier bytes` chain | **PARTIAL** |
| N7 | Ubuntu readiness — previously `NOT_PROVEN`; measured OK via CI run `36323899133` | **MEASURED** |
| N8 | Full-suite paid run | **NOT_RUN** |

## 9. Secret hygiene

The relay API key and a GitHub token both appeared **in plaintext in the conversation** during this work.
`git grep` confirms **neither is written to any tracked file or artifact**, but both are outside the
user's control boundary now. **Rotate both.** Pass them via environment variables or a URL only, never in
a committed file, and never in a commit message.

## 10. The round that finished Tasks 3 and 4

Platform: Windows 10 / PowerShell 7, Node `v24.18.1`. No paid request was made; `providerCalls=0`.

### 10.1 Task 4 — the arm pair is re-pinned, and the loop is measured green on it

All four sites from §2.2 moved to `8265dc39` / `ee15e7e7`, and nothing else: the R87/R92 production
constants, the R87 mechanism fixtures, the committed `e4-r87/r88/r90-phase-a-manifest.json` records, the
frozen selection payload and the historical reports were all left alone.

MEASURED ancestry — this decides whether a fetch is needed, and §1.1's expectation was checked rather
than assumed: `ee15e7e7` **is** an ancestor of the current tree; `8265dc39` is **not**, which is exactly
why it needs the published branch `e4/n1-baseline-comparable` and CI's `fetch-depth: 0`.

```powershell
node scripts/e4/r97-closed-loop.mjs --all --out .ci/n1/closed-loop-final --arms-root "$env:TEMP/r97-arms-n1-final"
# [1/5] setup OK · [2/5] acceptance OK status=OFFLINE_ACCEPTED passes=6/16
# [3/5] suite OK 564/564 · [4/5] matrix OK 9/9 · [5/5] identity OK    (exit 0)
```

`closed-loop-identity.json` binds the run to the arms actually built —
`armBaselineSha=8265dc39…`, `armCandidateSha=ee15e7e7…` — and the D6/R101 assertions pass against them
(`r97-driver-closed-loop.test.ts` → **77 passed (77)**).

**The open semantic question in §2.3 was checked, not assumed.** `git grep` for
`e9776ba|a203737|progress-blind|pre-R86` in that file now returns nothing, and the whole file passes
against the new pair, so no test encodes R87-mechanism semantics that the re-pin breaks. **No assertion
was loosened.**

One environment note that cost a run and is worth knowing: this machine has stale arm checkouts at
`D:/r97-arm-baseline` / `D:/r97-arm-candidate` built at the OLD revisions. With `R97_ARM_*_DIR` unset the
D6 test falls back to those paths, finds a real CLI, and then fails on the SHA assertion — correctly, but
confusingly. The runner sets the variables itself, so CI is unaffected; set them explicitly when running
that file by hand.

### 10.2 Task 3 — `strongPasses=0` re-measured, declared, and a false-positive `strong` fixed

§3.2's conclusion is **CONFIRMED** by sweeping all 96 `benchmarks/**/case.json` with the seam's own
exported `writeTargetOf`/`passStrengthOf`:

| Claim from §3 | Verdict |
|---|---|
| the frozen 8 contains no `strong` case | **CONFIRMED** — 3 `weak` + 5 `null` |
| exactly 3 cases in the tree can be `strong` | **CONFIRMED — after the fix below** (4 before) |
| 15 cases carry a literal but no artifact verifier | CONFIRMED |

Design **B** was taken (declare the structural limitation, cite the numbers) rather than Design A: the
zero is structural for a digest-bound set that must not be edited, so a second case set would add a
parallel selection and digest machinery for a number that would still be 0 for the frozen set. The N1
report now states this in §11.2 with the measured partition.

**The defect the measurement exposed — a false-positive `strong`.** `writeTargetOf` recovered the
expected bytes with `/!==\s*'([^']*)'/`; the `*` also matched the emptiness test `l.trim() !== ''`. So
`benchmarks/baseline-e4-r74/stress-10-subagents` — requirement: *"at least 10 non-empty lines"* — was
recovered as `content: ""` and labelled **`strong`**. Because the artifact verifier only checks
`exists && touched`, that is a **strong pass on empty content**: the exact false pass this labelling
exists to prevent. It was invisible for the frozen set (that case is not in it) and would have
mis-reported any future case set containing it.

Fixed by requiring a non-empty literal (`([^']+)`). Pinned by a new test that was proved
**discriminating**: reverting the pattern makes it fail with
`an empty literal must never become the written content: expected '' not to be ''`, and the file was
restored byte-identically (sha256 `5a75c25d…` before and after). `r97-offline-seam.test.ts` →
**18 passed (18)**.

### 10.3 Also fixed: `main`'s two-platform CI was RED before any of the above

§1.3 asked the next agent to confirm the current `main` run is green. It was **not**: run `36325754535`
at `0f02327` failed on **both** platforms at *"Generate gate execution evidence"*, because the `docs`
release gate was red:

```
FAIL  package count        HANDOVER.md does not claim a package count (packages/ on disk: 24)
FAIL  current plan entry   plan.md references plan(20260926-070459).md but that spec file is missing
```

`a322a21` deleted **both** `HANDOVER.md` and the spec `plan.md` still pointed at — one check had no
document to read, the other had a dangling pointer. Fixed by restoring `HANDOVER.md` (still truthful:
24 packages on disk, no volatile SHA in its canonical section) and removing the dangling `plan.md`, the
state `docs:verify`'s E4-00 check treats as an honest PASS. `pnpm docs:verify` → **ALL CHECKS PASS**;
`docs-verify.test.ts` → **19 passed (19)**.

§5's stale digest comment (`227d00b6…`) was corrected to the real `0d8af323…`; that string now appears
nowhere in the repository except in §5 itself, which documents it as the stale value.

### 10.4 Two-platform CI, verified on the published head

Run [36365533719](https://github.com/ki11a-Conton/harness-agent/actions/runs/36365533719) at head
`c44034ed03f2a03c8fedf43c78e7c52bc9f70c3e` (= `origin/main`, attempt 1) concluded **success**, 7/7 jobs
on both platforms. The step that was red before (`Generate gate execution evidence (P38.2-4/10, E4-R09
unified V2)`) is `success` on ubuntu **and** windows.

The re-pin is confirmed from the runners' own artifacts rather than from a green tick — the uploaded
`closed-loop-identity.json` on each platform:

| Artifact | `armBaselineSha` | `armCandidateSha` | suite | matrix | `providerCalls` | strong / weak |
|---|---|---|---|---|---|---|
| `r97-r98-closed-loop-ubuntu-latest-…` | `8265dc39…` | `ee15e7e7…` | 564/564 | 9/9 | 0 | 0 / 6 |
| `r97-r98-closed-loop-windows-latest-…` | `8265dc39…` | `ee15e7e7…` | 564/564 | 9/9 | 0 | 0 / 6 |

So the comparable pair is what CI actually built on both platforms, and `strongPasses=0` / `weakPasses=6`
is reproduced there too — the structural zero is not an artefact of this development host.


