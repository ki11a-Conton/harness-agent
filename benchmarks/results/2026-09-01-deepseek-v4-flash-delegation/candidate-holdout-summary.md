# Benchmark holdout

- generated: 2026-09-01T03:13:35.583Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 32

## Run manifest

- git: 3cf62ab8a8e6108349dbc9724785aef9ec023901 (dirty)
- candidate: delegation
- runtime config hash: dd8b3a6d7f76d8dfce7128e7b54e0479b373d21a77f51fc26ef34bcdeba67160
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 28.1% (9/32) |
| latency p50 | 213025 ms |
| latency p95 | 342364 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 25.0 |
| avg tool calls | 31.5 |
| avg input tokens | 154091.9 |
| avg output tokens | 8414.3 |
| retry rate | 96.9% (avg 3.9/case) |
| recovery rate | 19.0% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 33 |
| human interventions | 0 |
| failures by category | infrastructure 1 |
| avg cost score | 41.0 |
| security violations (hard gate) | 12 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 48.8, reliability 64.5, security 62.5, latency 22, tokens 30.9, tool_calls 65.7, retries 96.5 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 44 |
| retry.tool | 126 |
| retry.verification | 33 |
| retry.compaction | 113 |
| retry.provider | 270 |
| retry.sandbox | 0 |
| retry.stallRecovery | 16 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 21 |
| verified_complete | 9 |
| tool_limit | 1 |
| verification_failed | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 67279 | 11 | 14 | 5 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 185035 | 19 | 28 | 13 | 4 | 18.8% | 0 | none | tool_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 247684 | 30 | 33 | 3 | 2 | 20.0% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 70582 | 11 | 16 | 1 | 2 | 50.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 77779 | 13 | 15 | 3 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 185453 | 30 | 29 | 11 | 0 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ❌ | 281690 | 30 | 35 | 13 | 4 | 0.0% | 0 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 197771 | 30 | 39 | 8 | 6 | 18.2% | 4 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ❌ | 215552 | 30 | 31 | 10 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-10-validate-schema | holdout | ❌ | 213076 | 30 | 41 | 4 | 2 | 28.6% | 10 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 241825 | 30 | 44 | 17 | 10 | 10.0% | 16 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ✅ | 145863 | 23 | 32 | 7 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 342364 | 30 | 31 | 9 | 4 | 0.0% | 0 | none | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 46006 | 9 | 10 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 259938 | 30 | 39 | 5 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 33589 | 5 | 5 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 212107 | 29 | 31 | 7 | 8 | 12.5% | 8 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 213025 | 30 | 31 | 4 | 4 | 50.0% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 254100 | 29 | 40 | 5 | 2 | 33.3% | 13 | failed | verification_failed | 2 |
| ho-20-normalize | holdout | ❌ | 257066 | 30 | 32 | 8 | 4 | 10.0% | 0 | failed | agent_limit | 2 |
| ho-21-build-report | holdout | ✅ | 52251 | 9 | 9 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 273452 | 30 | 30 | 4 | 4 | 16.7% | 0 | failed | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 273253 | 30 | 54 | 16 | 10 | 29.2% | 16 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 277160 | 30 | 38 | 7 | 4 | 38.5% | 3 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 196331 | 30 | 28 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 330591 | 30 | 45 | 10 | 4 | 15.4% | 7 | failed | agent_limit | 2 |
| ho-27-pagination | holdout | ❌ | 248257 | 30 | 38 | 6 | 4 | 41.7% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 347531 | 30 | 49 | 5 | 4 | 62.5% | 0 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 65615 | 11 | 15 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 201110 | 30 | 39 | 8 | 4 | 0.0% | 1 | failed | agent_limit | 2 |
| ho-31-memory-guard-null | holdout | ❌ | 195184 | 30 | 33 | 3 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-32-memory-build-tip | holdout | ❌ | 328163 | 30 | 54 | 16 | 2 | 22.7% | 35 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.