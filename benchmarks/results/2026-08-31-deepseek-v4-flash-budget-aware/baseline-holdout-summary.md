# Benchmark holdout

- generated: 2026-08-31T04:07:45.803Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 32

## Run manifest

- git: c8fd5f87d7d410b88c8e025b53b5e5d24b4789ed (dirty)
- candidate: champion baseline
- runtime config hash: 3f4183ea3f197698807713ee2b949723b4903eefdb950e576874b640d547eefb
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 31.3% (10/32) |
| latency p50 | 187819 ms |
| latency p95 | 396966 ms |
| model calls p50 | 24 |
| model calls p95 | 30 |
| avg model calls | 22.4 |
| avg tool calls | 28.9 |
| avg input tokens | 133509.3 |
| avg output tokens | 7561.4 |
| retry rate | 96.9% (avg 4/case) |
| recovery rate | 22.6% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 29 |
| human interventions | 0 |
| failures by category | model 4 |
| avg cost score | 47.9 |
| security violations (hard gate) | 11 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 51.9, reliability 67.2, security 65.6, latency 26.9, tokens 37.6, tool_calls 71.4, retries 93.4 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 68 |
| retry.tool | 128 |
| retry.verification | 29 |
| retry.compaction | 122 |
| retry.provider | 154 |
| retry.sandbox | 0 |
| retry.stallRecovery | 17 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 14 |
| verified_complete | 10 |
| model_error | 4 |
| verification_failed | 3 |
| tool_limit | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 87871 | 12 | 14 | 6 | 8 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 396966 | 30 | 46 | 20 | 2 | 19.2% | 40 | failed | agent_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 144441 | 17 | 23 | 4 | 2 | 37.5% | 0 | failed | model_error | 2 |
| ho-04-audit-deps | holdout | ✅ | 93841 | 14 | 19 | 5 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 187819 | 24 | 27 | 3 | 2 | 25.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 127204 | 19 | 21 | 11 | 2 | 0.0% | 0 | none | tool_limit | 2 |
| ho-07-permissions | holdout | ❌ | 212985 | 30 | 38 | 12 | 10 | 0.0% | 0 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 182985 | 21 | 24 | 7 | 6 | 27.3% | 0 | failed | model_error | 2 |
| ho-09-document-api | holdout | ✅ | 83108 | 12 | 12 | 3 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 268122 | 30 | 46 | 12 | 2 | 23.5% | 17 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 273875 | 30 | 33 | 6 | 4 | 41.7% | 0 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ✅ | 116190 | 14 | 20 | 9 | 12 | 25.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 328297 | 30 | 36 | 3 | 4 | 33.3% | 6 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 30042 | 9 | 10 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 187274 | 19 | 22 | 6 | 2 | 53.3% | 0 | failed | model_error | 2 |
| ho-16-analyze-query | holdout | ✅ | 61309 | 8 | 10 | 3 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 32744 | 10 | 10 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 192925 | 24 | 29 | 3 | 4 | 33.3% | 0 | failed | verification_failed | 2 |
| ho-19-cache | holdout | ❌ | 255002 | 28 | 43 | 8 | 2 | 18.2% | 0 | failed | verification_failed | 2 |
| ho-20-normalize | holdout | ❌ | 229408 | 25 | 29 | 7 | 4 | 27.3% | 12 | failed | verification_failed | 2 |
| ho-21-build-report | holdout | ✅ | 35387 | 8 | 7 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 183806 | 30 | 34 | 11 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 177777 | 23 | 32 | 7 | 4 | 38.5% | 0 | failed | model_error | 2 |
| ho-24-extract-constants | holdout | ❌ | 253900 | 30 | 42 | 4 | 2 | 54.5% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 278512 | 30 | 37 | 9 | 4 | 28.6% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 482299 | 30 | 49 | 17 | 6 | 14.3% | 34 | failed | agent_limit | 2 |
| ho-27-pagination | holdout | ❌ | 263394 | 30 | 39 | 7 | 2 | 27.3% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 231683 | 30 | 53 | 11 | 4 | 20.0% | 13 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 30510 | 9 | 8 | 2 | 0 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 329973 | 30 | 35 | 15 | 4 | 30.4% | 0 | failed | agent_limit | 2 |
| ho-31-memory-guard-null | holdout | ❌ | 243721 | 30 | 39 | 9 | 6 | 33.3% | 0 | failed | agent_limit | 2 |
| ho-32-memory-build-tip | holdout | ❌ | 213491 | 30 | 37 | 15 | 4 | 0.0% | 0 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.