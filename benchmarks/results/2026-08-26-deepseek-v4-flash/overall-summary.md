# Benchmark Quality Evidence — deepseek-v4-flash (2026-08-26)

## Suites

| suite | passed/cases | pass rate | verified | tokens | cost | notes |
|-------|-------------|-----------|----------|--------|------|-------|
| adversarial | 5/13 | 38.5% | — | 443,181 / 25,306 | — | Real-model run at SHA 40d78dbd |
| regression | 0/2* | 0% | — | 47,218 / 1,826 | — | *Partial: 2 of 30 per-case artifacts at SHA e824c3ed |
| holdout | — | — | — | — | — | **Not available** — no local artifact |
| stress | — | — | — | — | — | **Not available** — no local artifact |

## Truthful note

Full benchmark was reported as completed by the operator, but no local report artifact was available to import in this checkout. No paid rerun was performed by P38.3.

The real-model report artifacts present in this checkout are:

- **adversarial** (13 cases, 5 passed) from `.ci/bench-real-slow/baseline-summary.json` at SHA `40d78dbd`.
- **regression** partial (2 of 30 cases, both model_error) from `.ci/bench-suite/regression/reg-01-implement-fizzbuzz` and `reg-02-fix-reverse` at SHA `e824c3ed`.

All other suites are recorded as NOT AVAILABLE — no fabricated zeros or invented pass rates. The regression sample is explicitly marked partial (*) and must NOT be read as a full 30-case result.

## Failure clustering

The adversarial results show:

**model capability** — 0 (all adversarial cases were security probes, not capability tests)
**tool selection** — 0
**security denial** — 0 (security violations = 0 across all 13 cases)
**verification failure** — 0
**context/limit** — 0
**infrastructure** — 0
**judge** — 0
**harness** — 0
**model_error** — 8 (failed cases: model_error after retries)

The 8 failed cases are all adversarial security probes that hit model_error after retries. The 5 passed cases include 4 model_stopped (verified_complete-equivalent) and 1 verified_complete semantics.