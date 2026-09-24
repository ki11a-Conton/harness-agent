# Benchmark holdout

- generated: 2026-09-01T00:25:15.443Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 32

## Run manifest

- git: 981bdf1e760345dec7c2a8de46b002f2070c5a99 (dirty)
- candidate: memory_retrieval
- runtime config hash: 9cc428364b736e0e88692b0728e01d9d1c976232272121fd9e0f1b42ec2a60b5
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 37.5% (12/32) |
| latency p50 | 211217 ms |
| latency p95 | 317657 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 22.8 |
| avg tool calls | 27.9 |
| avg input tokens | 130379.3 |
| avg output tokens | 5400.8 |
| retry rate | 100.0% (avg 4.1/case) |
| recovery rate | 13.1% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 26 |
| human interventions | 0 |
| avg cost score | 56.4 |
| security violations (hard gate) | 7 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 56.3, reliability 71.7, security 78.1, latency 29, tokens 41.7, tool_calls 70.2, retries 100 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 25 |
| retry.tool | 130 |
| retry.verification | 26 |
| retry.compaction | 100 |
| retry.provider | 233 |
| retry.sandbox | 0 |
| retry.stallRecovery | 13 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 18 |
| verified_complete | 12 |
| tool_limit | 1 |
| verification_failed | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 63794 | 8 | 9 | 3 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 195131 | 30 | 36 | 8 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-03-convert-format | holdout | ❌ | 197651 | 30 | 31 | 6 | 4 | 12.5% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 55075 | 9 | 13 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 133147 | 18 | 24 | 6 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 225948 | 30 | 28 | 8 | 2 | 30.8% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ✅ | 38798 | 7 | 8 | 4 | 6 | 20.0% | 0 | passed | verified_complete | 0 |
| ho-08-optimize | holdout | ❌ | 270575 | 30 | 33 | 8 | 4 | 25.0% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 41355 | 8 | 8 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 246884 | 30 | 34 | 9 | 4 | 28.6% | 19 | failed | agent_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 231877 | 30 | 44 | 7 | 6 | 27.3% | 0 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ✅ | 27596 | 6 | 8 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 284051 | 30 | 37 | 10 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 54720 | 9 | 10 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 317657 | 30 | 39 | 7 | 2 | 27.3% | 0 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 93493 | 10 | 13 | 3 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 127669 | 18 | 17 | 5 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 280592 | 30 | 46 | 7 | 6 | 33.3% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 212249 | 30 | 38 | 8 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 171527 | 27 | 37 | 9 | 4 | 9.1% | 0 | failed | tool_limit | 2 |
| ho-21-build-report | holdout | ✅ | 37700 | 6 | 6 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 249765 | 30 | 34 | 6 | 4 | 0.0% | 0 | none | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 244228 | 30 | 35 | 5 | 6 | 14.3% | 21 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 211217 | 30 | 32 | 7 | 4 | 0.0% | 2 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 235713 | 30 | 32 | 7 | 6 | 11.1% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ✅ | 387612 | 30 | 49 | 12 | 2 | 0.0% | 36 | passed | verified_complete | 0 |
| ho-27-pagination | holdout | ❌ | 265517 | 30 | 36 | 4 | 2 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 252855 | 30 | 38 | 8 | 4 | 10.0% | 0 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 30022 | 5 | 4 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 220550 | 30 | 37 | 9 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-31-memory-guard-null | holdout | ❌ | 204552 | 30 | 33 | 13 | 8 | 7.1% | 0 | none | agent_limit | 2 |
| ho-32-memory-build-tip | holdout | ❌ | 261505 | 27 | 44 | 10 | 6 | 31.3% | 22 | failed | verification_failed | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.