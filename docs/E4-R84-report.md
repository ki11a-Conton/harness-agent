# E4-R84 — Freeze the R83 campaign into a verifiable, tamper-detecting evidence chain

Plan: `plan(20260916-003534).md` §R84.

The R83 report asserted 86 stored cases / 21 passing / 1,327 model calls, but its
only backing material lived in a **git-ignored** `.ci/` directory. Nothing in the
repository could re-derive a single number, and §6 of that report stated a
configuration value (`maxIterationsPerTurn = 20`) that the code contradicts. This
task turns the campaign into a machine-checkable evidence chain, corrects the
report, and keeps the operator's raw data private.

| Field | Value |
| --- | --- |
| Starting SHA | `6693a6a52fb488bbe3273625eca8c1adb0981957` |
| Ending SHA (code) | `4ed52a97df1b6a69bc3802d845e573cb1168abb5` |
| Ending SHA (CI fix) | `5a69040` — the campaign step's exit-code defect (§8.3) |
| Branch | `main` (tracking `origin/main`) |
| Environment (local) | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0 |
| Provider/model calls this task | **0** (0 paid, 0 free) — §9.2 |
| Cases re-run this task | **0** |
| Files changed | 27 (7 modified, 20 added) |
| CI | run `35046227894` — **all 5 jobs success**, ubuntu + windows (§9.1) |

Three commits carry this task, all prefixed `E4-R84:` — the implementation, the
report addendum recording the post-commit gates, and the CI exit-code fix that
the first pipeline run exposed (§8.3).

---

## 1. Status summary

| Item | Status | Evidence |
| --- | --- | --- |
| R83 raw artifacts still present | **YES** | §2 — 1,643 files / 1,789,866 bytes |
| Read-only backup outside the repo | **DONE** | §2 — SHA-256 list, 1,643 entries |
| Campaign-level fail-closed validator | **NEW** | §3 — `packages/evaluation/src/campaign-validate.ts` |
| Offline CLI: `benchmark campaign validate` | **NEW** | §3, §4 — 0 provider calls |
| Validator re-derives the R83 numbers | **PASS** | §4 — 86 / 21 / 1,327 / 4,051,523 / 440,594 |
| Tamper detection (normalized content change ⇒ non-zero) | **PASS** | §4.2 — 5 negative fixtures (**R90 correction**: the original row read "any byte change ⇒ non-zero", which overstated the guarantee — see §10) |
| Sanitized committed evidence manifest | **DONE** | §5 — `docs/evidence/e4-r83-campaign-manifest.json` |
| Runner versioned + secret-reviewed | **DONE** | §5.2 — `scripts/benchmark/run-campaign.ps1` |
| §6 `maxIterationsPerTurn` 20 → 30 corrected | **DONE** | §6 — with the default-vs-effective explanation |
| Two source SHAs preserved per case | **DONE** | §6 — 8 @ `5f2af6e`, 78 @ `dd80676` |
| Cross-platform CI (windows + ubuntu) | **PASS** | §7, §9.1 — run `35046227894`, all 5 jobs success |
| `pnpm test` / `test:coverage` / `docs:verify` | **PASS** | §8 — 330 files / 5,988 tests, 0 failed |
| Paid calls | **0** | §9.2 |

---

## 2. Pre-flight: the raw artifacts exist, so the plan's BLOCKED path does not apply

The plan (§R84 "开始前检查" 3) requires stopping with
`BLOCKED: R83_RAW_ARTIFACTS_MISSING` if the original material is gone. It is not
gone. On the operator's Windows machine:

| Path | Present |
| --- | --- |
| `.ci/run-grok-campaign.ps1` | yes (7,235 bytes) |
| `.ci/bench-grok/manifest.jsonl` | yes (86 records) |
| `.ci/bench-grok/results/<suite>/<caseId>/...` | yes (86 case dirs) |
| `.ci/bench-grok/campaign-summary.json` | yes (33,390 bytes) |

Total: **1,643 files, 1,789,866 bytes**.

Before reading any of it, a **read-only copy was made outside the repository**
(so that nothing this task does can damage the only copy):

- destination: a directory on the same machine, outside the repo, under a
  dedicated backup root;
- method: `robocopy /E /COPY:DAT` (exit code `1` = files copied, which is
  success for robocopy, not an error);
- result: 1,643 files / 1,789,866 bytes — byte count identical to the source;
- a `SHA256SUMS.txt` total manifest (1,643 entries) was written beside it.

**The backup path is deliberately not recorded here**, per the plan's rule that
reports must not expose private paths or usernames. The backup stays outside
`git` and is not a CI artifact.

---

## 3. What was built

### 3.1 `packages/evaluation/src/campaign-validate.ts` (new, 1,093 lines)

A **campaign-level** fail-closed validator. The pre-existing
`artifact-validate.ts` and `artifact-v3/validate.ts` are *per-directory*: they
can tell you whether one case's artifacts are self-consistent, but nothing could
answer "is this 86-case campaign, taken as a whole, what it claims to be?".

The single most important design decision: **the expected case set is read from
the versioned benchmark source (`benchmarks/<suite>/<caseId>/`), never from the
manifest under test.** A manifest therefore cannot certify itself. The declared
campaign shape is enforced independently:

```
adversarial 13 + stress 11 + regression 30 + holdout 32 = 86
```

25 stable reason codes, all prefixed `CAMPAIGN_`:

| Reason code | Fails when |
| --- | --- |
| `CAMPAIGN_ROOT_MISSING` | the campaign root does not exist |
| `CAMPAIGN_EMPTY` | the root exists but holds nothing |
| `CAMPAIGN_RESULTS_DIR_MISSING` | there is no `results/` |
| `CAMPAIGN_NO_CASE_ARTIFACTS` | a summary with no raw case reports (summary-only tree) |
| `CAMPAIGN_MANIFEST_MISSING` | `manifest.jsonl` is absent |
| `CAMPAIGN_MANIFEST_TRUNCATED` | a non-empty trailing line will not parse |
| `CAMPAIGN_MANIFEST_RECORD_INVALID` | a record names a case outside the expected set |
| `CAMPAIGN_MANIFEST_RESUME_MISMATCH` | the last attempt for a case disagrees with whether a final result is stored |
| `CAMPAIGN_CASE_SET_MISMATCH` | stored set ≠ expected set |
| `CAMPAIGN_MISSING_CASE` | an expected case has no stored result |
| `CAMPAIGN_DUPLICATE_CASE` | the same case appears twice |
| `CAMPAIGN_UNKNOWN_CASE` | a stored case is not in the versioned source |
| `CAMPAIGN_SUITE_COUNT_MISMATCH` | the source does not match the declared shape |
| `CAMPAIGN_SUITE_MISSING` | a declared suite has no cases |
| `CAMPAIGN_MULTIPLE_FINAL_RESULTS` | one case dir holds two final reports |
| `CAMPAIGN_ARTIFACT_UNREADABLE` / `CAMPAIGN_ARTIFACT_SCHEMA_INVALID` | a report cannot be read or parsed |
| `CAMPAIGN_ARTIFACT_HASH_MISMATCH` | a byte differs from the recorded evidence |
| `CAMPAIGN_SUMMARY_MISSING` / `_INVALID` / `_MISMATCH` | the submitted summary is absent, malformed, or disagrees with the raw data |
| `CAMPAIGN_SOURCE_SHA_DRIFT` | a case reports a SHA the summary does not declare |
| `CAMPAIGN_IDENTITY_DRIFT` | cases disagree on provider/model identity |
| `CAMPAIGN_FIELD_NOT_RECORDED` | a required field is absent from the raw data |
| `CAMPAIGN_SECRET_FOUND` | secret-shaped material in any evidence file |

Two semantics the plan calls out explicitly are implemented as hard rules:

1. **Process success ≠ case success.** `CampaignSummary` carries
   `processRunSuccesses` / `processRunFailures` (the runner exited 0 and a report
   is on disk) *separately* from `passed` / `failed` (the harness verified
   completion). The CLI prints them under separate headings. "86/86 ran" can
   never be rendered as "86/86 passed".
2. **Missing data fails, it is never back-filled.** A field the raw data does not
   contain produces `CAMPAIGN_FIELD_NOT_RECORDED` and a non-zero exit. The plan
   forbids regenerating "raw results" from the report document, so there is no
   code path that could do it.

Hash stability across platforms is deliberate: file bytes are **CRLF→LF
normalized** before hashing, and paths are **POSIX-normalized and sorted**. A
Windows and an Ubuntu checkout of identical content therefore produce an
identical `rootDigest`.

**What `rootDigest` does and does not prove (R90 correction — see §10).** The
original text above is retained verbatim as the historical claim. It is
correct but was read too strongly: `rootDigest` is a **normalized
CONTENT-integrity** digest, *not* a byte-level immutability proof. A lone `\r`
is deliberately not treated as tamper, so a CRLF↔LF rewrite of the same text
leaves `rootDigest` unchanged. That is the intended cross-platform contract and
it is asserted by a test. Where byte-level identity must be audited, R90 added a
separate, non-substituting companion — `rawRootDigest` plus a per-artifact
`rawSha256` — computed over **raw bytes with no normalization**. The two are
recorded side by side: `rootDigest` stays authoritative for the tamper gate and
keeps every previously pinned digest compatible, while `rawRootDigest` moves on
a line-ending-only change. A line-ending rewrite is thus a *content-preserving*
change, not a content change.

### 3.2 `agent benchmark campaign validate` (new subcommand)

Wired in `apps/cli/src/benchmark-command.ts` (dispatched before the existing
flag parser, so `campaign` is a reserved first token) and documented in
`benchmarkUsage()` and `apps/cli/src/commands.ts`.

```
agent benchmark campaign validate <campaign-root>
  [--json] [--cases <dir>] [--suites <a,b,c>] [--summary <file>]
  [--emit-evidence <file>] [--evidence <file>] [--expect-digest <hex>]
  [--expect <sha,...>]
```

- `--emit-evidence` writes the sanitized evidence manifest, and **refuses** to
  write anything when validation fails.
- `--evidence` reads a previously emitted manifest and turns the campaign from
  tamper-**evident** (a changed byte moves the digest) into tamper-**detecting**
  (a changed byte is a *failure*). Every recorded artifact hash must still match,
  and no unrecorded evidence file may appear.
- `--suites` derives the declared counts from the case source; without it the
  fixed 13/11/30/32 = 86 shape is enforced.

`0` provider calls by construction: the command never constructs a provider.

### 3.3 Table-driven tests — `campaign-validate.test.ts` (new, 41 tests)

Positive (valid campaign, determinism, aggregate re-derivation, evidence
round-trip) plus every negative case the plan enumerates, each asserted to fail
with its **stable reason code**:

missing case · duplicate case · unknown case · missing suite · truncated
manifest · missing manifest · summary-only tree · empty directory · missing
root · tampered token count · tampered summary · source-SHA drift · secret in an
artifact · missing field → `not_recorded` · multiple final results · artifact
hash mismatch · added evidence file · removed evidence file · malformed report ·
resume mismatch (both directions) · Windows/POSIX separators · CRLF/LF digest
stability · the committed CI fixture.

The committed fixture's digest is **pinned in the test**, and a separate test
asserts the fixture on disk contains no absolute path, no endpoint, no
key-shaped string, no real 40-hex SHA and no real R83 case id.

---

## 4. Verification against the real R83 campaign

### 4.1 The validator re-derives every number in the report

```
$ node apps/cli/dist/main.js benchmark campaign validate .ci/bench-grok
Benchmark campaign in .ci/bench-grok: VALID

  process execution:
    stored cases (runner exit 0 + report on disk): 86
    resume manifest ok=true records:               86
    resume manifest ok=false records:              0
  case outcome:
    passed (harness verified completion):          21
    failed:                                        65

  expected cases (versioned source): 86
  suites:                            4
  model calls:                       1327
  tool calls:                        1314
  tokens (in/out):                   4051523 / 440594
  root digest:                       d3247ca8858ae348235414ea1b3515caac821cd952b0e5dd138f4fa85d1782e6
  source SHAs (2):
    5f2af6efe9d596f8e424bbd649229def469ba13c  8 case(s)
    dd80676e569cedce8e6903371cd80af6e337ce7a  78 case(s)
```

Exit code **0**. Every figure the plan requires is reproduced: 86 stored, 21
passed, 1,327 model calls, 4,051,523 input tokens, 440,594 output tokens, plus
the per-suite and per-termination distributions.

These numbers were **independently recomputed from the raw reports by a separate
ad-hoc Node script** (not by the validator) and agreed exactly:

| Statistic | Value |
| --- | --- |
| cases / passed | 86 / 21 |
| modelCalls / toolCalls | 1,327 / 1,314 |
| tokens in / out | 4,051,523 / 440,594 |
| suites | adversarial 13, stress 11, regression 30, holdout 32 |
| SHAs | `5f2af6e` 8, `dd80676` 78 |
| termination | `tool_limit` 46, `verified_complete` 21, `agent_limit` 8, `verification_failed` 5, `cancelled` 3, `model_error` 1, `model_stopped` 1, `time_limit` 1 |

### 4.2 Negative verification (the plan's four required cases, plus one)

Run against **temporary copies**. The original directory was never modified (the
final row proves it).

```
$ node apps/cli/dist/main.js benchmark campaign validate .ci/bench-grok \
      --emit-evidence .ci/r84-negative-evidence.json      # exit 0
```

| # | Mutation (on a temp copy) | Exit | Stable reason codes |
| --- | --- | --- | --- |
| 0 | none (control) | **0** | — |
| 1 | delete one case | **1** | `CAMPAIGN_ARTIFACT_HASH_MISMATCH`, `CAMPAIGN_MISSING_CASE`, `CAMPAIGN_CASE_SET_MISMATCH`, `CAMPAIGN_MANIFEST_RESUME_MISMATCH`, `CAMPAIGN_SUMMARY_MISMATCH` |
| 2 | duplicate one case | **1** | `CAMPAIGN_ARTIFACT_HASH_MISMATCH`, `CAMPAIGN_MISSING_CASE`, `CAMPAIGN_MULTIPLE_FINAL_RESULTS`, `CAMPAIGN_CASE_SET_MISMATCH`, `CAMPAIGN_MANIFEST_RESUME_MISMATCH`, `CAMPAIGN_SUMMARY_MISMATCH` |
| 3 | change one token count | **1** | `CAMPAIGN_ARTIFACT_HASH_MISMATCH`, `CAMPAIGN_SUMMARY_MISMATCH` |
| 4 | change one byte in an evidence file | **1** | `CAMPAIGN_ARTIFACT_HASH_MISMATCH` |
| 5 | add an extra evidence file | **1** | `CAMPAIGN_ARTIFACT_HASH_MISMATCH` |
| — | original re-checked afterwards | **0** | — |

Case 4 is the one that requires `--evidence`: the campaign is always
tamper-*evident* (the digest moves), but only a recorded manifest makes a changed
byte an outright failure. Both properties are asserted in the test suite, and the
offline self-check exercises both on the committed fixture.

---

## 5. The committed evidence chain

### 5.1 `docs/evidence/e4-r83-campaign-manifest.json` (91,386 bytes)

Schema version 1, `kind: "campaign-evidence"`. It contains:

- `rootDigest` — `d3247ca8…1782e6`;
- `declaredSummary` — the re-derived aggregates, with `processRunSuccesses: 86`
  recorded **separately** from `passed: 21`;
- `artifactHashes` — **260** per-file SHA-256 rows, POSIX-relative;
- `cases` — **86** rows, each with exactly: `suite`, `caseId`, `sourceSha`,
  `identity`, `identityDigest`, `termination`, `passed`, `modelCalls`,
  `toolCalls`, `tokensInput`, `tokensOutput`, `durationMs`, `artifactSha256`.

It contains **no prompt, no model output, no absolute path, no key**. Verified:

| Leak probe | Hits |
| --- | --- |
| absolute Windows path (`X:\` / `X:/`) | **0** |
| user / home path (`Users`, `AppData`, `/home/`) | **0** |
| endpoint (`https://`, `http://`) | **0** |
| provider hostname / vendor token | **0** |
| `sk-…` key shape | **0** |
| Authorization / Bearer / api_key assignment | **0** |

`generatedFrom` records the campaign root as a **repository-relative** path
(`.ci/bench-grok`). Anything outside the working directory is replaced by a
stable non-reversible `external:<digest>` label, so the manifest can never leak
the operator's filesystem layout even when generated elsewhere.

Re-validating with the committed manifest is a **tamper-detecting** check:

```
$ node apps/cli/dist/main.js benchmark campaign validate .ci/bench-grok \
      --evidence docs/evidence/e4-r83-campaign-manifest.json      # exit 0
```

### 5.2 `scripts/benchmark/run-campaign.ps1` (265 lines) — the runner, versioned

The R83 runner lived in `.ci/` (git-ignored), hardcoded the operator's absolute
working directory and a specific provider endpoint, and was therefore neither
reviewable nor reusable. It has been rewritten and versioned. Every plan
requirement is met:

| Requirement (plan §R84 "怎么做" 2) | Implementation |
| --- | --- |
| key only from the environment | `-ApiKeyEnv` (default `OPENAI_API_KEY`); the value is read via `[Environment]::GetEnvironmentVariable` and never printed |
| key never in argv / log / manifest / exception text | the key is never a parameter; the manifest record stores only `ts`, `suite`, `caseId`, `ok`, `error` (a short status string), `elapsedSec` |
| per-case atomic persist, resumable, stored cases not re-billed | the report is written per case; the manifest line is appended **immediately** on case exit; a case whose report exists is skipped on relaunch |
| serial by default, no new default concurrency | one `node` process at a time; no concurrency flag exists |
| digest still required between planning and execution | per case: `--dry-run` → extract `planDigest` → execute with `--plan-digest` |
| record identity / source SHA / case / suite / limits | identity flags (`--provider/--model/--endpoint`) plus the plan-estimate rails (`--max-model-calls 60`, `--max-estimated-tokens 1000000`, `--max-estimated-cost-usd 2.0`); the report itself records the SHA |
| **no endpoint literal, no absolute path** | endpoint and model are now **required parameters**; the root defaults to the git-ignored `.ci/bench-campaign` |
| paid-run safety | refuses to start without `-ConfirmPaidRun` **and** `RUN_PAID_BENCHMARKS=1` **and** a key in the environment (exit 3 / 2) |

A subtle trap is documented in the file itself: a PowerShell `[string[]]`
parameter binds only its **first** token under `pwsh -File`, and `$suites` would
silently collide with `$Suites` (PowerShell variable names are
case-insensitive). The suite list is therefore a comma-separated `[string]` and
the working variable is `$suiteList`.

### 5.3 `scripts/benchmark/selfcheck-campaign-runner.ps1` (212 lines) — offline proof

Drives the runner's real control flow against the committed synthetic fixture
with **0 provider calls and 0 cost** (`-DryRunOnly` stops each case after the
CLI's plan digest). **51 assertions, all passing**, covering:

1. the authorization gate refuses a paid run without `-ConfirmPaidRun` (exit 3,
   and no campaign directory is created);
2. a fresh run discovers all 3 cases, records one `ok=true` manifest line each,
   and writes no endpoint/key into the manifest;
3. a relaunch **skips** every already-stored case and appends **no** new record;
4. validation re-derives the numbers, with process success (3/3) and case
   success (1/3) reported separately;
5. a report-less root **fails closed** (`CAMPAIGN_NO_CASE_ARTIFACTS`);
6. the recorded evidence manifest makes a one-byte change **and** an injected
   file both fail, naming the offending path;
7. the emitted evidence manifest leaks no path, endpoint, key or real SHA;
8. the committed fixture still matches its generator.

### 5.4 `scripts/benchmark/fixtures/r84-campaign/` — the committed CI fixture

A fully **synthetic** 3-case campaign (`adversarial` 2 + `stress` 1) with an
accompanying `generate.mjs` that writes it deterministically. The suite *names*
are real because `agent benchmark --suite` accepts only the four versioned
names; the case ids are `syn-*`, the SHAs are 8-character fakes, and the
timestamps are the Unix epoch.

Committing the **generator** rather than only its output is deliberate: a
reviewer can re-run `generate.mjs --check` and see that the fixture was not
hand-tuned to make the validator pass. `.gitattributes` pins
`scripts/benchmark/fixtures/r84-campaign/**` to `eol=lf` so a Windows checkout
cannot silently rewrite it and break the pinned digest.

---

## 6. The R83 report corrections

Three factual defects were corrected in `docs/E4-R83-report.md`.

### 6.1 `maxIterationsPerTurn`: 20 → 30

§6 claimed the case stopped at "`maxIterationsPerTurn` = 20", and §7's
termination table repeated it. The real effective value is **30**:

```
$ git show 5f2af6e:apps/cli/src/benchmark-command.ts | Select-String maxIterationsPerTurn
      maxIterationsPerTurn: 30,      # runtime deps
    maxIterationsPerTurn: 30,        # effective-config manifest
$ git show dd80676:apps/cli/src/benchmark-command.ts | Select-String maxIterationsPerTurn
      maxIterationsPerTurn: 30,
    maxIterationsPerTurn: 30,
```

Both campaign SHAs pass `30` explicitly. `20` is only the `AgentRuntime`
**default** (`packages/core/src/runtime/runtime.ts` — `deps.maxIterationsPerTurn
?? 20`), and the benchmark path always overrides it. The raw evidence agrees:
`adv-memory-poisoning` records `termination_reason: agent_limit` with
`model_calls: 21`, which is consistent with a cap of 30 and inconsistent with 20.
The correction is stated inline in §6 with that explanation, and §7's
termination table now reads `maxIterationsPerTurn = 30`.

### 6.2 Two source SHAs, preserved per case

The report already mentioned both SHAs, but the evidence chain now records them
**per case** and the summary carries the distribution explicitly:
`{5f2af6e…: 8, dd80676…: 78}`. §7.1 states plainly that this campaign is *not* a
single immutable plan. The docs-only nature of `git diff 5f2af6e dd80676` is
retained as context but is explicitly *not* used to collapse the two SHAs:

```
$ git diff --stat 5f2af6e dd80676
 docs/E4-R83-report.md | 187 ++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 187 insertions(+)
```

`CAMPAIGN_SOURCE_SHA_DRIFT` fails the campaign if a stored case reports a SHA the
summary does not declare.

### 6.3 Process success and case success separated

§7.1 previously said `86/86` and `21 passing` in a way that invited the exact
substitution the plan forbids. It now carries an explicit callout that process
execution success is **86/86** and case success is **21/86**, that the evidence
manifest records both, and that "86/86 已运行" is not "86/86 通过".

### 6.4 Failure attribution deliberately left open

§7.1 now states that the 46 `tool_limit` and 8 `agent_limit` outcomes are **not
yet attributed** — they could come from model behaviour, the tool protocol, error
feedback, the verifier, the budget, or a genuine harness defect — and that the
plan therefore forbids raising `maxToolCalls`, `maxIterationsPerTurn`, timeouts or
retries on the strength of this distribution alone. Attribution is E4-R85.

---

## 7. CI wiring

Added to the `verify` job in `.github/workflows/ci.yml`, which runs on the
`[ubuntu-latest, windows-latest]` matrix, so **both platforms** run the same
validator:

1. `pnpm benchmark:campaign:fixture-check` — the fixture matches its generator;
2. `pnpm benchmark:campaign:validate` — the committed fixture validates;
3. validate **twice** and require an identical `rootDigest`, and require
   `passed = 1` with `processRunSuccesses = 3` (the two statistics asserted
   separately);
4. tamper detection — emit the fixture's evidence manifest, change one byte, and
   require a **non-zero** exit; then inject an extra file and require a non-zero
   exit again;
5. a summary-only tree must be rejected;
6. `selfcheck-campaign-runner.ps1` (Windows only — it drives the PowerShell
   runner) runs the full offline control-flow check;
7. the committed evidence manifest is uploaded as an artifact for review.

New `package.json` scripts make steps 1–2 runnable locally:
`benchmark:campaign:validate`, `benchmark:campaign:fixture-check`.

**The operator's private campaign is never uploaded.** CI proves the *validator*
is deterministic and cross-platform using a synthetic fixture; it does not, and
cannot, prove that a particular paid run happened. The real campaign stays on the
operator's machine under the git-ignored `.ci/`, with the read-only backup
outside the repository.

---

## 8. Local gate results

All gates below were run **after** committing, on a clean tree
(`4ed52a9`), because the promotion-chain tests require it (§8.1).

| Command | Exit | Notes |
| --- | --- | --- |
| `pnpm typecheck` (`tsc -b`) | **0** | clean, no output |
| `pnpm build` (`tsc -b`) | **0** | clean |
| `pnpm test` | **0** | **330 files / 5,988 passed**, 3 skipped, **0 failed** |
| `pnpm test:coverage` | **0** | thresholds met, incl. `packages/evaluation` lines 85 / branches 70 |
| `pnpm exec vitest run packages/evaluation` | **0** | 86 files / 1,096 tests |
| `campaign-validate.test.ts` | **0** | **41 tests passed** |
| `apps/cli/src/e4-r84-campaign-cli.test.ts` | **0** | **21 tests passed** |
| `pwsh scripts/benchmark/selfcheck-campaign-runner.ps1` | **0** | **51 assertions passed**, 0 provider calls |
| `node … benchmark campaign validate .ci/bench-grok` | **0** | VALID — 86 / 21 / 1,327 / 4,051,523 / 440,594 |
| `node … campaign validate .ci/bench-grok --json` | **0** | `ok=true`, `storedCases=86`, `passed=21`, `processRunSuccesses=86`, `processRunFailures=0`, digest `d3247ca8…1782e6` |
| `node … campaign validate .ci/bench-grok --evidence …` | **0** | tamper-detecting re-check |
| 5 negative fixtures | **1** each | stable `CAMPAIGN_*` reason codes (§4.2) |
| `pnpm docs:verify` | **0** | `ALL CHECKS PASS` |
| `git diff --check` | **0** | no whitespace errors |

### 8.1 The clean-tree requirement, and why the pre-commit run was red

Before committing, `pnpm test` reported **3 failing files / 6 failing tests**:
`apps/cli/src/e4-09-production-e2e.test.ts` (4), `apps/cli/src/e4-r55-failure-wiring.test.ts` (1),
and `apps/cli/src/e4-r09-production-e2e.test.ts`-style chain tests (1). This was
**not** a regression from this task, and it was proven so rather than assumed:

- the failing assertion is the benchmark refusing to run, not a broken test:
  ```
  agent benchmark: a promotion-eligible run requires a CLEAN, PROVABLE source tree
  at execution time — commit or stash changes and re-confirm the plan
    - source tree is not provably clean
    - the confirmed plan was made against a dirty tree — re-confirm on a clean tree
  ```
- `e4-r55-failure-wiring.test.ts` states the requirement in its own message
  ("E4-R55 requires a CLEAN committed working tree … Commit or stash first"), and
  the dirty-state list it printed **was this task's own change set**;
- stashing the changes made the same file pass **5/5** at `HEAD`, and restoring
  them made it fail again — the failure tracks the dirty tree, not the code;
- after committing, `pnpm test` is **330 files / 5,988 passed / 0 failed**.

This is exactly why the plan mandates one commit per task. It is recorded here
rather than hidden, and the pre-commit red is **not** claimed as a pass.

### 8.2 A note on `git diff --check` and `.github/workflows/ci.yml`

`git diff --check` initially reported trailing whitespace on **every added line**
of `ci.yml`. The cause was not this task's content: the file's git blob was
historically stored **with CRLF** (`git ls-files --eol` reported `i/crlf`), so
each line ends in `\r`, which the check reads as trailing whitespace. The same
commit that last touched it (`0ca421e`, E4-R82) produced **194** such warnings on
that single file.

Rather than leave a noisy check, `.gitattributes` now pins
`.github/workflows/*.yml` to `text eol=lf` and the file was renormalized once.
The renormalization is **byte-only**: `git diff --ignore-cr-at-eol` against the
previous revision shows the semantic change is exactly the 81 added lines, all
five jobs (`verify`, `coverage`, `cold-start-ubuntu`, `release-attestation`, and
the `push` trigger) are intact, and `git diff --check` is now clean.

### 8.3 A real CI defect found by running the pipeline (and fixed)

The first CI run of this task (`35044982379`) **failed** — on both
`ubuntu-latest` and `windows-latest`, at the new campaign step, in 8s and 5s
respectively. Every local run of the same commands passed, so the discrepancy
was investigated rather than papered over.

**Root cause.** GitHub Actions wraps every `shell: pwsh` step as:

```powershell
$ErrorActionPreference = 'stop'
<your script>
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
```

This step's entire purpose is to run validations that **must exit non-zero** —
the last of them is the summary-only check, which is *required* to fail. The
step therefore inherited `$LASTEXITCODE = 1` from a deliberate failure and
reported the job as failed even though every assertion had passed.

**How it was proven, not guessed.** The exact `run:` block was extracted from
the committed YAML, a fresh `git clone` of the pushed commit was built, and the
block was executed under a hand-written reproduction of the Actions wrapper. It
printed all four success lines (`fixture digest`, `tamper detection OK`,
`injected-file detection OK`, `summary-only tree rejected OK`) and still exited
**1**. A minimal 3-line reproduction confirmed the mechanism (`a=1` bug,
`b=0` with `exit 0`, `c=1` when a real `throw` precedes `exit 0` — so a real
failure is never masked).

**Fix**, in the step itself:

1. an explicit `if ($LASTEXITCODE -ne 0) { throw … }` after **each** `pnpm`
   call, so a genuine failure is caught at its source instead of being silently
   overwritten later;
2. a final `exit 0`, which is reached only if every assertion passed (`throw`
   aborts first);
3. three guards against vacuous passes that the original block also had:
   `--json` output is checked for a non-null parsed object and a non-empty
   `rootDigest`, the tamper copy is confirmed to have materialised, and the
   tamper `Replace` is asserted to have actually changed the file (otherwise the
   "tamper detected" assertion would pass for the wrong reason).

Verified after the fix: the same extracted block under the same wrapper now
exits **0**, and four injected negative controls (fixture-check fails, validate
fails, mutation becomes a no-op, assertion disabled) all exit **non-zero**
except the self-referential one that deletes the assertion itself — which no
step can detect about its own source and which the 41 unit tests and the
offline self-check cover instead.

This is recorded because it is exactly the class of defect the plan warns about:
a *process* success/failure signal that had nothing to do with the *work* being
correct.

---

## 9. Unfinished items / honest limits

1. **The raw campaign is not in the repository, and cannot be.** It is
   git-ignored, it contains absolute paths in 86 `run.log` files, and the plan
   forbids publishing raw transcripts or private directories. What is committed
   is the sanitized evidence manifest; what makes it checkable is the validator,
   which the operator (or CI, via the fixture) can run. A third party with only
   the repository can verify the *format and integrity* of the committed
   manifest and reproduce the fixture digest, but cannot independently confirm
   the original paid run — that requires the operator's local artifacts.
2. **`--evidence` is what makes a byte change fail.** Without a recorded
   manifest, a change moves the root digest (tamper-evident) rather than failing
   (tamper-detecting). Both behaviours are intentional and tested; the plan's
   "any byte changed ⇒ non-zero exit" requirement is met through `--evidence`.
3. **The fixture is synthetic and small (3 cases).** It proves cross-platform
   determinism and tamper detection, not the 86-case shape. The 86-case shape is
   enforced by `CAMPAIGN_EXPECTED_SUITE_COUNTS` and by a test that reads the
   versioned `benchmarks/` source on both platforms.
4. **The local POSIX/Linux run is not possible here.** Per the plan, POSIX
   acceptance comes only from GitHub Actions `ubuntu-latest`, and it now has:
   run `35046227894` executed the validator on Ubuntu and produced the **same**
   root digest as Windows (§9.1).
5. **No failure attribution was attempted here.** R84 freezes and corrects the
   evidence; deciding *why* 46 cases hit `tool_limit` is E4-R85's job, and the
   plan forbids raising any limit before that analysis.
6. **No model was called.** 0 provider calls, 0 paid, 0 cases re-run — this is a
   structural property of the commands added (`campaign validate` never
   constructs a provider; the runner refuses without `-ConfirmPaidRun`), not an
   observation that could have gone the other way.

### 9.1 CI run

| Field | Value |
| --- | --- |
| Workflow | `.github/workflows/ci.yml` — job `verify`, matrix `ubuntu-latest` + `windows-latest` |
| Run 1 (failed) | `35044982379` — head `be0e783`; the new campaign step exited 1 on **both** platforms although every assertion passed. Root cause and fix in §8.3 |
| Run 2 (**green**) | `35046227894` — head `5a69040`; **all 5 jobs success** on both platforms |
| URL | https://github.com/ki11a-Conton/harness-agent/actions/runs/35046227894 |

Run 2 job results — every job passed:

| Job | Result |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit` (ubuntu-latest) | **success** |
| `install · typecheck · test · build · benchmark-smoke · audit` (windows-latest) | **success** |
| `coverage gate (ubuntu)` | **success** |
| `offline cold-start (ubuntu)` | **success** |
| `release attestation (P38-12)` | **success** |

This is the first POSIX/Linux execution of the validator, and it agrees with
Windows: the fixture's `rootDigest` is
`26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8` on both, and
tamper detection fires on both. The operator's private campaign was never
uploaded — CI ran entirely against the committed synthetic fixture.

### 9.2 Provider-call accounting

| Bucket | Count |
| --- | --- |
| Paid provider calls | **0** |
| Free/stub provider calls | **0** |
| Cases executed | **0** |
| Cases re-run | **0** |
| Model HTTP requests | **0** |

The only `node` invocations against the real campaign were read-only
validations of already-stored JSON. Every test in this task runs offline against
either a temp fixture or the committed synthetic fixture; the offline runner
self-check stops each case after the CLI's `--dry-run` plan digest.

---

## 10. R90 erratum — the digest is content-integrity, not byte immutability

Appended by **E4-R90**. Nothing above is deleted or rewritten: this section is
the versioned correction the plan requires (plan §R90 怎么做: "提交带
schema/version 的勘误，而非删除历史记录").

**The corrected claim.** Two places in this report described the hash guarantee
in byte-level terms:

| Location | Original wording | Correction |
| --- | --- | --- |
| §1 status table | "Tamper detection (**any byte change** ⇒ non-zero)" | The guarantee is over **normalized content**. `sha256` is computed after CRLF→LF normalization, so a line-ending-only rewrite is *not* detected — by design, because that is what makes one campaign yield one digest on Windows and Ubuntu. |
| §3.1 | "file bytes are **CRLF→LF normalized** before hashing … (a lone `\r` is consequently not treated as tamper; that is the intended contract)" | Correct as written, but the parenthetical was easy to miss next to the §1 row. It is now stated as a first-class distinction. |

**Why it matters.** A reader who believed `rootDigest` proved byte-level
immutability could wrongly conclude that a CRLF↔LF rewrite of a committed
artifact is either impossible or detected. Neither is true. The digest proves
that the *content* is unchanged; it does not and was never intended to prove
that the *bytes* are unchanged.

**What R90 added (additive, no compatibility break).**

- `CampaignValidationResult.rawRootDigest` — the same sorted
  `<path>\0<rawSha256>\n` listing, hashed over **raw bytes with no
  normalization**.
- `artifactHashes[].rawSha256` — the per-artifact raw byte hash, recorded
  **alongside** (never instead of) the existing normalized `sha256`.

`rootDigest` and every previously pinned digest — including this report's
fixture value `26167402acbde04eddad4535bfb8fbbf16c9be20f6e2b5866f26b602740525c8`
and the R85 `triageDigest` — keep their exact previous meaning and value. The
new fields are strictly additional, so byte auditing is now possible without
retroactively redefining what the old digests asserted.

**Verification.** `packages/evaluation/src/campaign-validate.test.ts` asserts
both halves of the distinction on one file: writing `a\nb\n` and then
`a\r\nb\r\n` must leave `rootDigest` **identical** while moving
`rawSha256`/`rawRootDigest`. A single test can therefore not pass by
accidentally collapsing the two facts.
