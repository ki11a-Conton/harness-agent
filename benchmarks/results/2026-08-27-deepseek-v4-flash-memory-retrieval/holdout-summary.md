# Benchmark holdout

- generated: 2026-08-28T04:25:30.617Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: c9e43ffd9368310696892a93dd6c32238e52477e (dirty)
- candidate: memory_retrieval
- runtime config hash: 1eb60ac1eb8e7fcfe7c6b72eb80ad121b4dc2680c5e66ce288985186ff4475a6
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 30.0% (9/30) |
| latency p50 | 177489 ms |
| latency p95 | 866292 ms |
| model calls p50 | 19 |
| model calls p95 | 30 |
| avg model calls | 18.9 |
| avg tool calls | 22.6 |
| avg input tokens | 82750.9 |
| avg output tokens | 4889.1 |
| retry rate | 86.7% (avg 3.4/case) |
| recovery rate | 31.2% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 29 |
| human interventions | 0 |
| failures by category | model 5 |
| avg cost score | 49.8 |
| security violations (hard gate) | 9 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 51, reliability 74.7, security 70, latency 31.0, tokens 47.0, tool_calls 80.6, retries 92.9 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 65 |
| retry.tool | 102 |
| retry.verification | 29 |
| retry.compaction | 10 |
| retry.provider | 158 |
| retry.sandbox | 0 |
| retry.stallRecovery | 10 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| verified_complete | 9 |
| agent_limit | 8 |
| verification_failed | 5 |
| model_error | 5 |
| time_limit | 2 |
| tool_limit | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 38414 | 8 | 9 | 3 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 177489 | 12 | 15 | 1 | 0 | 71.4% | 5 | failed | verification_failed | 2 |
| ho-03-convert-format | holdout | ❌ | 299682 | 30 | 34 | 7 | 4 | 57.9% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ❌ | 77282 | 8 | 11 | 5 | 4 | 28.6% | 0 | none | model_error | 2 |
| ho-05-complexity | holdout | ✅ | 146851 | 18 | 22 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 198716 | 22 | 22 | 10 | 0 | 31.3% | 0 | failed | tool_limit | 2 |
| ho-07-permissions | holdout | ✅ | 179229 | 26 | 29 | 7 | 4 | 22.2% | 0 | passed | verified_complete | 0 |
| ho-08-optimize | holdout | ❌ | 155258 | 19 | 28 | 10 | 4 | 31.3% | 0 | failed | model_error | 2 |
| ho-09-document-api | holdout | ✅ | 74543 | 14 | 16 | 4 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 294876 | 30 | 30 | 11 | 4 | 0.0% | 0 | none | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 212106 | 27 | 33 | 8 | 10 | 25.0% | 0 | failed | verification_failed | 2 |
| ho-12-refactor-esm | holdout | ✅ | 82855 | 14 | 20 | 4 | 4 | 42.9% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 285706 | 30 | 34 | 4 | 4 | 44.4% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 23555 | 9 | 10 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 27702 | 6 | 6 | 1 | 2 | 50.0% | 0 | failed | model_error | 2 |
| ho-16-analyze-query | holdout | ✅ | 155731 | 17 | 17 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ❌ | 866292 | 1 | 1 | 1 | 2 | 50.0% | 0 | none | time_limit | 2 |
| ho-18-race-condition | holdout | ❌ | 218942 | 30 | 40 | 7 | 4 | 20.0% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 217705 | 27 | 34 | 10 | 6 | 31.3% | 0 | failed | model_error | 2 |
| ho-20-normalize | holdout | ❌ | 138994 | 19 | 22 | 3 | 4 | 42.9% | 0 | failed | verification_failed | 2 |
| ho-21-build-report | holdout | ✅ | 16808 | 5 | 4 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 141357 | 19 | 22 | 3 | 4 | 33.3% | 0 | failed | verification_failed | 2 |
| ho-23-retry-logic | holdout | ❌ | 268264 | 30 | 34 | 8 | 6 | 18.2% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 255091 | 30 | 29 | 8 | 6 | 47.1% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 79965 | 10 | 8 | 1 | 0 | 60.0% | 0 | failed | verification_failed | 2 |
| ho-26-analyze-errors | holdout | ❌ | 201652 | 19 | 30 | 5 | 0 | 28.6% | 1 | none | model_error | 2 |
| ho-27-pagination | holdout | ❌ | 227200 | 30 | 42 | 3 | 4 | 20.0% | 4 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 213810 | 30 | 40 | 11 | 4 | 7.7% | 0 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 22622 | 6 | 6 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 1049143 | 22 | 29 | 7 | 4 | 38.5% | 0 | failed | time_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.