# Benchmark holdout

- generated: 2026-09-01T05:05:53.592Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 32

## Run manifest

- git: 3cf62ab8a8e6108349dbc9724785aef9ec023901 (dirty)
- candidate: adaptive_recovery_v2
- runtime config hash: 6f573411910ae5c73722ee964ee8f16b55c966dca062d1a783d2d22af3d27545
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 34.4% (11/32) |
| latency p50 | 220637 ms |
| latency p95 | 519693 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 23.6 |
| avg tool calls | 29.2 |
| avg input tokens | 134567.3 |
| avg output tokens | 7890.1 |
| retry rate | 93.8% (avg 3.8/case) |
| recovery rate | 20.5% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 33 |
| human interventions | 0 |
| failures by category | model 1 |
| avg cost score | 30.7 |
| security violations (hard gate) | 19 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 54.1, reliability 68.1, security 40.6, latency 25.0, tokens 38.8, tool_calls 69.2, retries 95.6 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 45 |
| retry.tool | 122 |
| retry.verification | 33 |
| retry.compaction | 100 |
| retry.provider | 247 |
| retry.sandbox | 0 |
| retry.stallRecovery | 10 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 19 |
| verified_complete | 11 |
| verification_failed | 1 |
| model_error | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 76732 | 12 | 11 | 4 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 230558 | 30 | 48 | 7 | 0 | 20.0% | 10 | failed | agent_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 225776 | 30 | 36 | 4 | 2 | 28.6% | 32 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 114933 | 15 | 22 | 8 | 6 | 27.3% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 63738 | 10 | 12 | 2 | 2 | 50.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 225959 | 30 | 34 | 8 | 2 | 10.0% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ❌ | 361574 | 30 | 43 | 7 | 4 | 41.7% | 0 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 237273 | 30 | 38 | 13 | 8 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 156357 | 19 | 18 | 6 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 220637 | 30 | 30 | 12 | 6 | 0.0% | 0 | none | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 247267 | 30 | 36 | 6 | 2 | 46.2% | 0 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ✅ | 53709 | 9 | 15 | 3 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 534407 | 30 | 42 | 6 | 4 | 22.2% | 10 | failed | verification_failed | 2 |
| ho-14-test-matrix | holdout | ✅ | 57414 | 10 | 13 | 6 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 277223 | 30 | 35 | 6 | 2 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 51707 | 9 | 10 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 87900 | 12 | 12 | 7 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 230569 | 30 | 35 | 10 | 4 | 15.4% | 6 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 275913 | 30 | 40 | 8 | 4 | 35.7% | 0 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 238359 | 30 | 33 | 7 | 6 | 42.9% | 0 | failed | agent_limit | 2 |
| ho-21-build-report | holdout | ✅ | 12655 | 5 | 4 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 196792 | 30 | 32 | 4 | 2 | 0.0% | 0 | none | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 214321 | 30 | 37 | 5 | 4 | 25.0% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 235874 | 30 | 28 | 10 | 8 | 31.3% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 267902 | 30 | 45 | 18 | 4 | 5.0% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ✅ | 253717 | 26 | 33 | 6 | 0 | 45.5% | 0 | passed | verified_complete | 0 |
| ho-27-pagination | holdout | ❌ | 252269 | 30 | 37 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 203764 | 30 | 40 | 5 | 4 | 14.3% | 0 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 16486 | 5 | 5 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 207344 | 24 | 25 | 4 | 6 | 54.5% | 0 | failed | model_error | 2 |
| ho-31-memory-guard-null | holdout | ❌ | 181521 | 30 | 35 | 10 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-32-memory-build-tip | holdout | ❌ | 519693 | 30 | 49 | 10 | 2 | 21.4% | 42 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.