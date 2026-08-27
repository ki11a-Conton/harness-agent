# Benchmark holdout

- generated: 2026-08-27T07:29:53.905Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: 07aeb65efcbf4b282f1d7a724c5d5d6650b37567
- candidate: adaptive_recovery
- runtime config hash: 2e0e9b288c0ec0808e8293727d201acb12739710fc49c5537015637ad3f9db7e
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 26.7% (8/30) |
| latency p50 | 220580 ms |
| latency p95 | 469214 ms |
| model calls p50 | 28 |
| model calls p95 | 30 |
| avg model calls | 22.7 |
| avg tool calls | 27.5 |
| avg input tokens | 165729.5 |
| avg output tokens | 7371.5 |
| retry rate | 100.0% (avg 4.2/case) |
| recovery rate | 23.7% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 33 |
| human interventions | 0 |
| failures by category | model 3 |
| avg cost score | 31.5 |
| security violations (hard gate) | 16 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 48.7, reliability 65, security 46.7, latency 27.3, tokens 37.8, tool_calls 72.6, retries 96.6 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 56 |
| retry.tool | 126 |
| retry.verification | 33 |
| retry.compaction | 93 |
| retry.provider | 148 |
| retry.sandbox | 0 |
| retry.stallRecovery | 10 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 15 |
| verified_complete | 8 |
| model_error | 3 |
| verification_failed | 3 |
| time_limit | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ❌ | 19260 | 5 | 10 | 7 | 6 | 22.2% | 0 | none | model_error | 2 |
| ho-02-parse-log | holdout | ❌ | 328377 | 24 | 38 | 9 | 2 | 16.7% | 42 | failed | model_error | 2 |
| ho-03-convert-format | holdout | ❌ | 269930 | 30 | 32 | 9 | 6 | 16.7% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 123547 | 19 | 21 | 4 | 2 | 20.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 220997 | 20 | 24 | 9 | 6 | 35.7% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 429817 | 30 | 29 | 3 | 2 | 42.9% | 0 | failed | agent_limit | 2 |
| ho-07-permissions | holdout | ❌ | 267301 | 30 | 34 | 9 | 4 | 0.0% | 0 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 185242 | 27 | 30 | 3 | 2 | 42.9% | 5 | failed | verification_failed | 2 |
| ho-09-document-api | holdout | ✅ | 38913 | 7 | 7 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 955778 | 15 | 15 | 6 | 4 | 30.0% | 0 | failed | time_limit | 2 |
| ho-11-release-notes | holdout | ❌ | 371619 | 30 | 42 | 10 | 4 | 21.4% | 0 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ❌ | 69938 | 10 | 18 | 8 | 8 | 27.3% | 0 | none | model_error | 2 |
| ho-13-debug-flaky | holdout | ❌ | 463903 | 30 | 37 | 9 | 4 | 33.3% | 0 | failed | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 96305 | 14 | 13 | 5 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 469214 | 30 | 44 | 10 | 4 | 38.9% | 8 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 28787 | 7 | 8 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ✅ | 25964 | 8 | 8 | 3 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-18-race-condition | holdout | ❌ | 308987 | 30 | 29 | 7 | 6 | 20.0% | 0 | failed | agent_limit | 2 |
| ho-19-cache | holdout | ❌ | 348141 | 30 | 43 | 8 | 4 | 30.8% | 0 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 206557 | 28 | 28 | 4 | 4 | 28.6% | 0 | failed | verification_failed | 2 |
| ho-21-build-report | holdout | ✅ | 178060 | 19 | 27 | 12 | 2 | 29.4% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 259166 | 30 | 28 | 6 | 2 | 56.3% | 0 | failed | agent_limit | 2 |
| ho-23-retry-logic | holdout | ❌ | 316335 | 30 | 39 | 7 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 220580 | 30 | 34 | 6 | 4 | 22.2% | 0 | failed | agent_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 195251 | 30 | 35 | 8 | 4 | 18.2% | 0 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 394015 | 30 | 46 | 14 | 4 | 6.3% | 33 | failed | agent_limit | 2 |
| ho-27-pagination | holdout | ❌ | 186348 | 30 | 38 | 9 | 6 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 206223 | 30 | 39 | 9 | 6 | 9.1% | 5 | failed | agent_limit | 2 |
| ho-29-benchmark | holdout | ✅ | 30173 | 7 | 8 | 1 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 239158 | 22 | 21 | 8 | 10 | 25.0% | 0 | failed | verification_failed | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.