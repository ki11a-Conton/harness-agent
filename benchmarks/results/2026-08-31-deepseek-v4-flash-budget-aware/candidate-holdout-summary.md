# Benchmark holdout

- generated: 2026-08-31T07:46:54.461Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 32

## Run manifest

- git: c8fd5f87d7d410b88c8e025b53b5e5d24b4789ed (dirty)
- candidate: budget_aware_completion_v1
- runtime config hash: 2ecd399cb7cbada0182f93fa7d0223810bd9c79ca322abbfabd7bc5702b176f5
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 31.3% (10/32) |
| latency p50 | 215528 ms |
| latency p95 | 467632 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 22.5 |
| avg tool calls | 28.8 |
| avg input tokens | 162972.9 |
| avg output tokens | 8361.9 |
| retry rate | 90.6% (avg 4.6/case) |
| recovery rate | 22.7% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 28 |
| human interventions | 0 |
| failures by category | infrastructure 2, model 2 |
| avg cost score | 38.0 |
| security violations (hard gate) | 16 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 50, reliability 67.2, security 50, latency 23.5, tokens 38.9, tool_calls 72.0, retries 90.8 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 68 |
| retry.tool | 148 |
| retry.verification | 28 |
| retry.compaction | 167 |
| retry.provider | 216 |
| retry.sandbox | 0 |
| retry.stallRecovery | 15 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 18 |
| verified_complete | 10 |
| model_error | 3 |
| verification_failed | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 71462 | 12 | 16 | 7 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 115204 | 16 | 23 | 4 | 0 | 37.5% | 12 | failed | verification_failed | 2 |
| ho-03-convert-format | holdout | ❌ | 342877 | 30 | 42 | 8 | 6 | 55.0% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 65028 | 11 | 13 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 245561 | 21 | 25 | 6 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 271771 | 30 | 31 | 3 | 2 | 55.6% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ❌ | 262211 | 30 | 46 | 14 | 14 | 17.6% | 13 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 206758 | 30 | 40 | 7 | 2 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 31592 | 8 | 12 | 4 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 391878 | 30 | 44 | 13 | 6 | 30.0% | 34 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 108003 | 13 | 18 | 6 | 4 | 41.7% | 0 | failed | model_error | 2 |
| ho-12-refactor-esm | holdout | ✅ | 59309 | 10 | 15 | 5 | 8 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 467632 | 30 | 34 | 7 | 4 | 11.1% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 54689 | 10 | 9 | 5 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 339265 | 30 | 37 | 7 | 4 | 50.0% | 0 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 106363 | 11 | 14 | 7 | 10 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 75576 | 14 | 14 | 6 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 215528 | 30 | 39 | 12 | 6 | 7.1% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 130457 | 17 | 16 | 4 | 4 | 44.4% | 0 | failed | model_error | 2 |
| ho-20-normalize | holdout | ❌ | 234624 | 30 | 48 | 10 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-21-build-report | holdout | ✅ | 64295 | 11 | 10 | 4 | 0 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 218436 | 30 | 37 | 14 | 6 | 0.0% | 0 | none | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 271482 | 30 | 33 | 4 | 4 | 70.6% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 215775 | 30 | 38 | 11 | 2 | 7.7% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 339454 | 30 | 46 | 12 | 6 | 7.1% | 14 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 253782 | 30 | 37 | 11 | 0 | 8.3% | 46 | none | agent_limit | 2 |
| ho-27-pagination | holdout | ❌ | 318896 | 30 | 40 | 10 | 4 | 8.3% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 94182 | 11 | 13 | 8 | 6 | 27.3% | 0 | none | model_error | 2 |
| ho-29-benchmark | holdout | ✅ | 96212 | 15 | 15 | 4 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 253098 | 30 | 29 | 8 | 2 | 47.1% | 0 | failed | agent_limit | 2 |
| ho-31-memory-guard-null | holdout | ❌ | 190958 | 30 | 35 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-32-memory-build-tip | holdout | ❌ | 479715 | 30 | 51 | 15 | 6 | 15.8% | 48 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.