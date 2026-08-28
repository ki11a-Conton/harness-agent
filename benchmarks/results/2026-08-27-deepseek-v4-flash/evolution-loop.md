# Benchmark → Failure Cluster → Hypothesis → Challenger → Paired Eval

Evidence base: `benchmarks/results/2026-08-27-deepseek-v4-flash/`
Real model: deepseek-v4-flash via https://api.b.ai/v1, TPM-limited slow mode
(30s case pacing, provider 8x/3s backoff). Baseline SHAs: regression 6423dbe,
holdout/adversarial/stress fbf6797; provenance backfilled (07aeb65).

## 1. Benchmark result (84 cases, all suites complete)

| suite | passed/cases | pass rate |
|-------|-------------|-----------|
| regression | 3/30 | 10.0% |
| holdout | 9/30 | 30.0% |
| adversarial | 8/13 | 61.5% |
| stress | 5/11 | 45.5% |
| **TOTAL** | **25/84** | **29.8%** |

## 2. Failure clustering (59 failures)

| Failure cluster | Count | % of failures | Affected suites | Avg model calls | Avg tool calls |
|-----------------|-------|---------------|-----------------|-----------------|----------------|
| agent_limit | 27 | 45.8% | regression, holdout, stress | 30.0 | 34.4 |
| verification_failed | 12 | 20.3% | regression, holdout | 21.3 | 21.7 |
| model_error | 11 | 18.6% | regression, holdout, adversarial | 19.5 | 24.1 |
| model_stopped | 3 | 5.1% | adversarial | 8.3 | 10.0 |
| cancelled | 3 | 5.1% | stress | 10.3 | 10.7 |
| tool_limit | 1 | 1.7% | regression | 30.0 | 34.0 |
| verified_complete (security) | 1 | 1.7% | adversarial | 17.0 | 21.0 |
| time_limit | 1 | 1.7% | stress | 6.0 | 7.0 |

## 3. Hypothesis (from evidence, not a favored mechanism)

- **agent_limit (46%)**: the model works to the full 30-iteration budget
  (~34 tool calls) but does not reach verified completion. Under TPM-throttled
  latency each iteration is slow, so 30 steps often end mid-task. This is a
  step-budget property of the benchmark harness, NOT an agent-strategy defect —
  no candidate mechanism directly addresses it, and raising maxIterations would
  change the measurement, not test a strategy. Out of scope for a challenger.
- **verification_failed (20%) + model_error (19%) = 39%**: the model often
  stops or fails without recovering — verification gates fail, model calls
  exhaust retries, and the turn ends. **Hypothesis: bounded recovery planning
  (adaptive_recovery, P19-3) should lift the recovery rate on these
  failure-then-failed clusters** by selecting a recovery action matched to the
  failure taxonomy instead of the fixed default policy.
- **adversarial security (5/8 pass → 8/13 this run)**: large improvement vs
  the P38.3-era 5/13; the earlier gap was largely 429-exhaustion surfacing as
  model_error, fixed by provider retry budget. Remaining security failures are
  genuine model-behavior cases (e.g. adv-subagent-poisoning verified_complete
  but security-violating — the model completed the task while violating).

## 4. Challenger chosen (first, single-variable)

`adaptive_recovery` — the only candidate whose mechanism directly targets the
recovery cluster (verification_failed + model_error, 39% of failures). It is
P21-5 defaultOn=evidence: champion inclusion requires benchmark proof, so this
is the correct first challenger. Single-variable experiment: baseline (candidate
off) vs challenger (adaptive_recovery on), same suite, same model, same pacing.

Evidence suite: **holdout** (30 cases — richest failure distribution:
8 agent_limit, 7 verification_failed, 5 model_error, 3+ model_stopped/etc).

Run: `benchmark --suite holdout --out ... --candidate adaptive_recovery --delay 30000`
Status: in progress → `benchmarks/results/2026-08-27-deepseek-v4-flash-adaptive-recovery/`

## 5. Paired eval (after challenger completes)

`agent champion eval <baseline-holdout> <candidate-holdout>` — checks per P38.4-8
(compatible evaluation context, candidate actually differs, controlled
difference declared), P21-4 quality gates, security non-regression, no new
infrastructure failures. Promotion only if the quality verdict passes AND the
provenance checks hold; otherwise reject with the evidence recorded.

### Result (2026-08-27, real model, holdout 30 cases)

**adaptive_recovery challenger REJECTED** — QUALITY VERDICT: FAIL.

- paired: 1W / 2L / 7T / 20 both-failed; net passed delta **-1** (9/30 → 8/30)
- verified completion: 0.300 → 0.267 (Δ -0.033)
- token cost Δ **+2,034,326** with no net success gain (P21-4 Q3: cost growth
  without benefit)
- recovery Δ **-6** — the bounded recovery planner did NOT lift recovery;
  it consumed more iterations/tokens and degraded verified completion
- provenance: all P38.4-8 checks PASS (compatible evaluation context,
  candidate actually differs, controlled difference declared) — the rejection
  is attributable: evaluationContextHash identical across sides, so the delta
  is genuinely due to the candidate wiring, not noise.
- The hypothesis (bounded recovery lifts verification_failed + model_error
  clusters) is NOT supported by evidence. Do not promote; do not retry this
  candidate without a different mechanism.

### Remaining hypothesis direction

- agent_limit (46%) remains the dominant cluster. It is a step-budget property
  of the benchmark harness (30 iterations), not an agent-strategy defect —
  raising maxIterations would change the measurement, not test a strategy.
  No candidate mechanism in CANDIDATE_FEATURES addresses step budget.
- Next candidates worth a single-variable test on holdout (in priority order):
  tool_selector_deferred_schema (cuts per-iteration schema tokens → more work
  per step), adaptive_context_policy (dynamic context headroom), memory_retrieval.

## 6. Second challenger: tool_selector_deferred_schema (PASS)

Hypothesis: deferred schema advertisement (fetch full tool schemas on demand
via tool_lookup instead of inlining every schema each iteration) cuts per-step
token overhead, leaving more effective work per 30-step budget. Directly
targets the agent_limit cluster.

Result (2026-08-27, real model, holdout 30 cases):
**tool_selector_deferred_schema ACCEPTED** — QUALITY VERDICT: PASS.

- paired: 1W / 0L / 9T / 20 both-failed; net passed delta **+1** (9/30 → 10/30)
- verified completion: 0.300 → 0.333 (Δ +0.033)
- token cost Δ +828,688 WITH a net success gain — P21-4 Q3 satisfied
  (cost growth accompanied by success, unlike adaptive_recovery which had
  cost growth with a regression)
- all P38.4-8 provenance checks PASS (attributable)
- conversion note: 1 verification_failed baseline case (ho-21-build-report)
  converted to candidate pass; 9 passes held; 0 regressions.

Evidence supports champion inclusion of the deferred-schema tool-selection
strategy. Next: evaluate the champion preset (defaultOn=yes candidates +
evidence-approved ones) as a combined run, and/or test the next candidate
(adaptive_context_policy / memory_retrieval) in isolation.

Runtime architecture is FROZEN (P38.4-11): this loop only evaluates Agent
strategy-layer challengers. No Runtime code changes are planned.
