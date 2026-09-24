# Benchmark holdout

- generated: 2026-08-27T04:42:21.317Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: fbf6797719c01d760c96ceb886f58cb1f2969574 (dirty)
- candidate: champion baseline
- runtime config hash: 38e470042c862efd8f6fa950ce3eefa45ae4e7817a806d9b1b88dfc1c7b5a8cf
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 30.0% (9/30) |
| latency p50 | 186801 ms |
| latency p95 | 347233 ms |
| model calls p50 | 24 |
| model calls p95 | 30 |
| avg model calls | 21.7 |
| avg tool calls | 24.5 |
| avg input tokens | 99029.8 |
| avg output tokens | 6260.4 |
| retry rate | 100.0% (avg 4.4/case) |
| recovery rate | 26.7% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 42 |
| human interventions | 0 |
| failures by category | model 5 |
| avg cost score | 46.5 |
| security violations (hard gate) | 8 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 51, reliability 63.3, security 73.3, latency 25.9, tokens 46.2, tool_calls 79.5, retries 94.7 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 55 |
| retry.tool | 132 |
| retry.verification | 42 |
| retry.compaction | 23 |
| retry.provider | 186 |
| retry.sandbox | 0 |
| retry.stallRecovery | 11 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| verified_complete | 9 |
| agent_limit | 9 |
| verification_failed | 7 |
| model_error | 5 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 71851 | 12 | 14 | 7 | 10 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 347233 | 30 | 40 | 11 | 14 | 20.0% | 0 | failed | agent_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 189205 | 26 | 29 | 6 | 4 | 30.0% | 0 | failed | verification_failed | 2 |
| ho-04-audit-deps | holdout | ✅ | 89115 | 12 | 18 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 139036 | 17 | 25 | 8 | 4 | 20.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 139819 | 24 | 22 | 5 | 2 | 25.0% | 0 | failed | verification_failed | 2 |
| ho-07-permissions | holdout | ❌ | 277610 | 28 | 38 | 10 | 4 | 52.2% | 0 | failed | model_error | 2 |
| ho-08-optimize | holdout | ❌ | 251786 | 30 | 31 | 8 | 4 | 43.8% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 21842 | 8 | 7 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 283447 | 30 | 42 | 9 | 2 | 33.3% | 23 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 189178 | 24 | 24 | 6 | 6 | 22.2% | 0 | failed | verification_failed | 2 |
| ho-12-refactor-esm | holdout | ✅ | 25221 | 8 | 10 | 3 | 4 | 25.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 394163 | 30 | 32 | 4 | 2 | 28.6% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 82736 | 13 | 13 | 6 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 211072 | 26 | 28 | 6 | 2 | 36.4% | 0 | failed | model_error | 2 |
| ho-16-analyze-query | holdout | ✅ | 95342 | 17 | 20 | 8 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 96309 | 13 | 13 | 5 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 67402 | 11 | 10 | 3 | 4 | 33.3% | 0 | failed | verification_failed | 2 |
| ho-19-cache | holdout | ❌ | 270607 | 30 | 44 | 6 | 6 | 36.4% | 0 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 98837 | 16 | 17 | 1 | 2 | 60.0% | 0 | failed | model_error | 2 |
| ho-21-build-report | holdout | ❌ | 80207 | 14 | 11 | 5 | 4 | 25.0% | 0 | failed | verification_failed | 2 |
| ho-22-fix-vuln | holdout | ❌ | 283517 | 27 | 31 | 6 | 4 | 41.7% | 0 | failed | model_error | 2 |
| ho-23-retry-logic | holdout | ❌ | 216030 | 29 | 26 | 4 | 4 | 50.0% | 0 | failed | verification_failed | 2 |
| ho-24-extract-constants | holdout | ❌ | 199040 | 30 | 30 | 12 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 250128 | 30 | 35 | 9 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 136901 | 19 | 22 | 6 | 4 | 22.2% | 0 | failed | verification_failed | 2 |
| ho-27-pagination | holdout | ❌ | 236248 | 30 | 32 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 263690 | 30 | 28 | 9 | 4 | 37.5% | 0 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 107692 | 17 | 16 | 4 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 186801 | 21 | 26 | 6 | 4 | 30.0% | 0 | failed | model_error | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.