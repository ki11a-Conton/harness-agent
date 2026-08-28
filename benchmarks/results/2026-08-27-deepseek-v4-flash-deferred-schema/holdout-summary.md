# Benchmark holdout

- generated: 2026-08-28T00:20:52.929Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: 3ed4d635f75b4b1ccc361d964c789e424960351f
- candidate: tool_selector_deferred_schema
- runtime config hash: 3f43259ae2c4751c7fbfe8445f9fb8db0b497280aeebbfc99d09adb79cdd2788
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 33.3% (10/30) |
| latency p50 | 220232 ms |
| latency p95 | 310789 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 22.8 |
| avg tool calls | 27.5 |
| avg input tokens | 126923.6 |
| avg output tokens | 5989.5 |
| retry rate | 100.0% (avg 4.2/case) |
| recovery rate | 26.8% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 38 |
| human interventions | 0 |
| failures by category | model 2 |
| avg cost score | 39.0 |
| security violations (hard gate) | 14 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 53.3, reliability 63.7, security 53.3, latency 28.4, tokens 39.8, tool_calls 72.4, retries 94.9 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 60 |
| retry.tool | 126 |
| retry.verification | 38 |
| retry.compaction | 45 |
| retry.provider | 156 |
| retry.sandbox | 0 |
| retry.stallRecovery | 11 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 15 |
| verified_complete | 10 |
| verification_failed | 3 |
| model_error | 2 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 75785 | 11 | 16 | 5 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 220874 | 30 | 35 | 8 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 233802 | 30 | 36 | 7 | 4 | 38.5% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 33062 | 10 | 14 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 164651 | 12 | 14 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 301016 | 30 | 30 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ❌ | 290671 | 30 | 37 | 8 | 8 | 50.0% | 0 | failed | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 270017 | 30 | 41 | 9 | 4 | 37.5% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 85460 | 11 | 13 | 5 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 264460 | 30 | 33 | 3 | 2 | 55.6% | 0 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 380695 | 30 | 36 | 6 | 6 | 46.2% | 18 | failed | verification_failed | 2 |
| ho-12-refactor-esm | holdout | ✅ | 88052 | 12 | 17 | 7 | 8 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 267631 | 30 | 31 | 5 | 8 | 25.0% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 26027 | 8 | 11 | 3 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 190618 | 22 | 26 | 6 | 2 | 22.2% | 0 | failed | model_error | 2 |
| ho-16-analyze-query | holdout | ✅ | 43775 | 10 | 13 | 5 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 27951 | 8 | 8 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 303950 | 30 | 35 | 9 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 310789 | 30 | 39 | 9 | 4 | 33.3% | 0 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 248410 | 30 | 31 | 8 | 2 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-21-build-report | holdout | ✅ | 171638 | 20 | 25 | 8 | 4 | 46.7% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 213294 | 30 | 36 | 10 | 6 | 8.3% | 0 | failed | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 221448 | 30 | 38 | 7 | 2 | 27.3% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 236205 | 30 | 39 | 8 | 4 | 25.0% | 3 | failed | verification_failed | 2 |
| ho-25-cron-config | holdout | ❌ | 256408 | 30 | 47 | 14 | 4 | 37.5% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 220232 | 22 | 25 | 3 | 2 | 33.3% | 17 | failed | model_error | 2 |
| ho-27-pagination | holdout | ❌ | 156421 | 23 | 28 | 8 | 4 | 35.7% | 0 | failed | verification_failed | 2 |
| ho-28-refactor-naming | holdout | ❌ | 193152 | 30 | 36 | 9 | 4 | 16.7% | 7 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 20947 | 6 | 5 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 238189 | 30 | 29 | 8 | 2 | 35.7% | 0 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.