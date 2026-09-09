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
