# E4-11 Report: Exploratory Paid Reevaluation (insecure-local, NOT promotion-grade)

## Authorization

User authorized a paid run this round with:
- provider/model: `qwen3.8-flash` via base URL `https://api.b.ai/v1` (OpenAI-compatible);
- max USD budget: user stated `99999999`;
- explicit acceptance of an **insecure-local, non-promotion-grade, exploratory**
  run (no OS isolation).

Because this host is Windows (`win32`), `probeIsolationBackend().strongIsolation`
is `false`, so a promotion-eligible run is impossible here. The run was therefore
executed with `--allow-insecure-local-benchmark`, which the E4-01 gate marks
**permanently `promotionEligible=false`**. `RUN_PAID_BENCHMARKS=1` was set only
in the run process; the API key was passed only via environment and is **not**
present in any tracked file, log, or artifact.

## Scope and hard caps (my own, far below the user's stated budget)

Minimal interpretable set: 1 case × 1 repetition × 2 arms = 2 logical runs.
Hard limits enforced by the executor: `--max-model-calls 20`,
`--max-estimated-tokens 200000`, `--max-estimated-cost-usd 2`, `--seed 1`,
exact case list, wall-clock via per-case timeout. The user's `99999999` was
treated only as an outer bound; the operative caps were the small ones above.

## Dry-run (0 provider calls) — plan + digest

`--dry-run` produced the canonical plan and `planDigest`
`5ce8f5d65040f961f96fba7729e2e6599728757461d313121e58ce46cd0b013f`
(estimated cost $0.01, `insecure-local`, `promotionEligible=false`). The real run
was bound to that exact digest via `--plan-digest`, so preflight verified the
executed plan matched the confirmed one.

## Real run — outcome

Two invocations (initial + one journal resume), same plan/digest:

| metric | value |
|---|---|
| logical runs | 2 |
| model-call attempts | 13 per invocation (≈26 total across both) |
| transport retries | 6 per invocation |
| baseline arm | **valid, passed, `verified_complete`** — the real model completed the task through the real paired executor |
| candidate arm | **failed — `model_error`: HTTP 429 rate_limit** from the endpoint (after retries) |
| pairs finalized | 0 |
| canonical V3 written | none (V3 is emitted only when a pair finalizes) |
| `promotionEligible` | false (insecure-local) |
| reported usage / cost | 0 tokens / $0 (the endpoint returned no usage accounting; even at typical small-model rates this is pennies) |
| champion state | untouched — no auto-promotion |

## What this proves and what it does not

**Proves:** the full paid pipeline is real and works end-to-end — a genuine
external model (`qwen3.8-flash`) drove the real paired executor and the baseline
arm completed + verified a task, with the plan bound to a confirmed digest and
hard caps enforced.

**Does not achieve:** a complete, promotion-eligible paired artifact. The
candidate arm was blocked by the endpoint's HTTP 429 rate limiting (an external
constraint, not a code defect), so no pair finalized, no canonical V3 was
produced, and no promotion bundle draft exists.

## Honest verdict

E4-11's promotion-grade acceptance (`promotionEligible=true`, `pairComplete=true`,
strict V3 load) is **NOT met** and cannot be met on this host:
- Windows has no strong isolation backend → runs are permanently ineligible;
- the third-party endpoint rate-limited the candidate arm → no complete pair.

This run is recorded as **exploratory only**. No promotion was performed and none
should be inferred from it.

## To run E4-11 properly (promotion-grade)

1. A Linux host with `bwrap`/landlock (strong isolation) so `promotionEligible=true`;
2. `release:verify` passing at the target HEAD (fresh HEAD-bound gate evidence);
3. an endpoint that is not rate-limiting (or a retry/backoff that clears it);
4. dry-run → confirm the exact `planDigest` → a concrete max-USD cap → run with
   hard limits; strict-load the resulting V3; verify `pairComplete`; still do not
   auto-promote.

## Artifacts

- Run artifacts live in a temp dir (not the repo): `paired-experiment.json` +
  the `.paired-journal/<pairedPlanDigest>/` arm records. The repo working tree is
  clean; no key is present in any tracked file.
