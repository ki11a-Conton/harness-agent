# E4-11 Report: Exploratory Paid Reevaluation (insecure-local, NOT promotion-grade)

## Summary

Two exploratory paid attempts against user-provided endpoints. The second (a
local proxy) **finalized a pair and drove the entire chain end-to-end with a real
model**: paired executor → canonical V3 (written + strict-reloaded in-process) →
real evaluator → DecisionArtifact. It is **exploratory only** — on Windows there
is no strong isolation, so `promotionEligible=false` and no promotion is possible
or performed.

## Authorization

User authorized a paid run this round with:
- provider/model: first `qwen3.8-flash` via `https://api.b.ai/v1`; then a local
  proxy `http://127.0.0.1:8787/v1` with a proxy-managed key sentinel and model
  `auto`;
- max USD budget: user stated `99999999` (treated as an outer bound only — see
  hard caps below);
- explicit acceptance of an **insecure-local, non-promotion-grade, exploratory**
  run (no OS isolation).

Because this host is Windows (`win32`), `probeIsolationBackend().strongIsolation`
is `false`, so a promotion-eligible run is impossible here. Both runs used
`--allow-insecure-local-benchmark`, which the E4-01 gate marks **permanently
`promotionEligible=false`**. `RUN_PAID_BENCHMARKS=1` was set only in the run
process; keys were passed only via environment and are **not** present in any
tracked file, log, or artifact.

## Scope and hard caps (my own, far below the user's stated budget)

Minimal interpretable set: 1 case × 1 repetition × 2 arms = 2 logical runs.
Hard limits: `--max-model-calls 20`, `--max-estimated-tokens 200000`,
`--max-estimated-cost-usd 2`, `--seed 1`, exact case list, wall-clock per case.

## Attempt 1 — api.b.ai (`qwen3.8-flash`)

Bound to dry-run `planDigest`
`5ce8f5d65040f961f96fba7729e2e6599728757461d313121e58ce46cd0b013f`.
The baseline arm completed + `verified_complete` (the real model works), but the
candidate arm hit **HTTP 429 rate_limit** repeatedly → the pair did not finalize
→ no canonical V3. Reported usage was 0 (the endpoint returned no usage
accounting).

## Attempt 2 — local proxy (`127.0.0.1:8787`, model `auto`) — SUCCEEDED

Same minimal plan, fresh out dir, bound to the identical `--plan-digest`.
`/v1/models` health check returned `auto`. Result:

| metric | value |
|---|---|
| pairs finalized | 1/1 |
| logical runs | 2 |
| model-call attempts | 6 |
| transport retries | 0 |
| baseline arm | passed |
| candidate arm | passed |
| canonical V3 | `v3-baseline.json` + `v3-candidate.json` written + strict-reloaded in-process |
| V3 `schemaVersion` | 3.0.0; `promotionEligible=false`; `isolationStrength=insecure-local` |
| evaluator decision | **INCONCLUSIVE** |
| `pairComplete` | true |
| `netPassedDelta` | 0 (both arms passed the single trivial case) |
| `activationCoverage` | 1 |
| reason codes | `ACTIVATION_UNSATISFIED`, `EFFECT_BELOW_THRESHOLD`, `SINGLE_RUN_REQUIRES_REPETITION` |
| `evaluatorVersion` | `e4-06-evaluator-v1`; `thresholdDigest` present |
| champion state | untouched — no auto-promotion |

## Attempt 2b — local proxy, `--repeat 2` (stronger multi-repetition run)

Bound to its own dry-run digest `fd00459c…`, fresh out dir, hard caps
(`--max-model-calls 60`, `--max-estimated-cost-usd 5`):

| metric | value |
|---|---|
| pairs finalized | 2/2 |
| logical runs | 4 (2 reps × 2 arms) |
| model-call attempts | 21 |
| transport retries | 0 |
| per-rep result | baseline passed / candidate passed (both reps) |
| canonical V3 | written + strict-reloaded in-process |
| evaluator decision | **INCONCLUSIVE** |
| `pairComplete` | true |
| `netPassedDelta` | 0 |
| reason codes | `ACTIVATION_UNSATISFIED`, `EFFECT_BELOW_THRESHOLD` |

Note: with 2 repetitions the `SINGLE_RUN_REQUIRES_REPETITION` gate is now
satisfied; the remaining `EFFECT_BELOW_THRESHOLD` is honest — the real model
completes this trivial task on **both** arms, so there is no causal candidate
effect to accept. Producing a genuine ACCEPT would require a case where the
budget-aware candidate really beats baseline; that outcome is model-dependent and
was **not** fabricated here.

## Attempt 3 — distinguishing case (blocked by the proxy model's tool-call defect)

To try to produce a real (not fabricated) ACCEPT, a case was designed that gives
the budget-aware guidance a genuine causal role: fix a buggy `calc.py` whose only
verification is running `python calc_test.py` — the candidate arm is explicitly
told to prioritize running the verification command, the baseline is not.

Result: the run did **not** complete. The proxy model emitted **malformed `exec`
tool calls** (`{"arguments":{"command":"ls"}}` — a nested `arguments` object that
fails schema validation: `command: Required`). The harness handled this correctly
and fail-closed: `TOOL_SCHEMA_ERROR`, `recovery.decided: retry_safe`, then
`run.limit_reached: stallPattern repeated_error` → clean `tool_limit`
termination with `unverified_complete`. The baseline arm consumed 17 model calls
and failed; the run was stopped before the candidate arm to avoid spending
against a model that, in THIS run, could not produce a well-formed exec call.

**Observation (calibrated, not over-claimed):** the local proxy's `auto` model
emitted a **malformed `exec` tool call once** in this run (nested `arguments`
object → `TOOL_SCHEMA_ERROR` → stall → fail-closed). This proves the harness
rejected the malformed call and stopped the stall — a positive fail-closed
demonstration. It does **NOT** prove the endpoint "can never produce a
well-formed exec call": that would require more samples/other models, and the
malformation may be model- or load-specific. The correct statement is: **no
real-model ACCEPT was achieved with this provider/model on this case; the
exec-dependent attempt did not complete.**

**Consequence for ACCEPT (honest bounds):** a genuine real-model ACCEPT was not
produced here, and an exec-requiring case did not complete with this endpoint's
`auto` model in this run. The evaluator's ACCEPT path through the real chain is
demonstrated by the automated `e4-09` production-path E2E (real stages, provider
keyed on the candidate arm's real guidance marker → ACCEPT). No fabrication was
attempted; `promotionEligible=false` (insecure-local) throughout.

## What this proves

The full E3/E4 production pipeline runs end-to-end with a **real, non-scripted
model**: `benchmark` entry → real paired executor → **canonical V3** (no manual
`paired-to-v3.mjs`) → strict reload → real evaluator → `DecisionArtifact`, with
the plan bound to a user-confirmed digest and hard caps enforced. The E4-05
policy digest and E4-06 evaluator-version binding are live on real data.

## What it correctly does NOT conclude

The decision is **INCONCLUSIVE, not ACCEPT** — exactly right for a single trivial
case where both arms pass (`netPassedDelta = 0`, one repetition). Combined with
`promotionEligible=false` (insecure-local) and the unmet `release:verify`
precondition, E4-11's **promotion-grade** acceptance
(`promotionEligible=true`, a conclusive ACCEPT, strict V3 as a promotion bundle)
is **not** met and cannot be met on this host.

## To run E4-11 promotion-grade (future)

1. Linux + `bwrap`/landlock (strong isolation → `promotionEligible=true`);
2. `release:verify` passing at the target HEAD;
3. a case set where the candidate can plausibly beat baseline, with ≥2
   repetitions so `repetitionSufficient` can hold;
4. dry-run → confirm exact `planDigest` → a concrete max-USD cap → run;
   strict-load the V3; verify `pairComplete`; still do not auto-promote.

## Artifacts and hygiene

Run artifacts are in a temp dir (not the repo): `paired-experiment.json`,
`v3-baseline.json`, `v3-candidate.json`, and the `.paired-journal/` arm records.
The repo working tree is clean; no API key is present in any tracked file.
## E4-R11 calibration + movable evidence index

**Usage semantics:** the proxy endpoint returned usage-less responses for the
calls that did complete. Those runs are therefore marked budget usage
unknown/missing, NOT tokens=0 / cost=0: with no per-call usage the CLI's
max-estimated-cost-usd did not observe billable usage, and the honest summary
is "usage not reported by endpoint; cost not provable as 0". Budget-execution
semantics in this exploratory run are accordingly bounded, not claimed exact.

**Digest binding (R01 context):** Attempts 1-2 reused one --plan-digest across
different provider/model values. Under R01's execution-identity contract that
digest did NOT bind provider/model, so those runs must not be read as proof that
the "confirmed full execution plan" was verified - the plan identity became
provider/model-bound only with R01+ (executionIdentityDigest).

**Surviving original artifacts (movable evidence index, %TEMP%\e411-c17d0c9a):**
the files below are the ORIGINAL run outputs (not rebuilt from the report).
Relative to the run root - role | sha256:

- out3\v3-candidate.json  EF44258BF627820A9AD3EB48027AA826BA13FEA71BA6497CCD6E863FF6B268F8
- out3\v3-baseline.json   23B751CAE98CDE4CDB12BFBB86A4787C647A856D71F7294298F442C7EA6FC7EA
- out3\paired-experiment.json  BDD1B4F1D657A1E81FA76BE9537BBE4A7E7C76786FBB58849221428973703751
- out3\.paired-journal\9d973a9c6739d242375175e5247bf3ebc4875513031b86dc097b887f510f869c\ (4 arm files: 1AA34578.. / AF8DBED6.. / 75113F95.. / E0BCB124..)
- out2\paired-experiment.json  EB3B420FD565491132F9F60996E8B22A42F369B25677C5A0D163B279E1210D7E
- out2\v3-baseline.json   5B7162DA7FBAC8FA7F57E4F519EDE5EC712F946C6E38F57B21145025373B105F
- out2\v3-candidate.json  D0F806DA4E00D793BF389D7CCBF9F605794A431C8DA76A29B5A1A8D377A7C7F2
- out4\.paired-journal\9d973a9c6739d242375175e5247bf3ebc4875513031b86dc097b887f510f869c\952c8ab5da2b8a64a94aa682-baseline.json  9783AAB6714785CAFB7FE4948BCE3D80F5B54A7561145CE90EFF631B5C451CED  (crux-case malformed-exec stall)
- cases\c1\{calc.py,calc_test.py,case.json,request.md,expected.md}
- eval.mjs  ED64FD8A220D713323AE4D5A6FABF09BB997F57DDA9DC55FE032028B672C993E

These are the ORIGINAL bytes (the temp dir has not been rewritten; full sha256
for every surviving file was captured during this round). If the temp dir is
later deleted, the report remains but the run becomes "original evidence
unverifiable" - no fake original is rebuilt from the report.
