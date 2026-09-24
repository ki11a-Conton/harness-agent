# Benchmark holdout

- generated: 2026-08-28T02:12:25.260Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: b6ff4660297719eb7dc5ec68d77af486818a7c8a (dirty)
- candidate: adaptive_context_policy
- runtime config hash: 49e2cc8e8d0a335c1df1d80d7b94da25d96a9eb8cf1110a3b64d1bb8e758a985
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 30.0% (9/30) |
| latency p50 | 209838 ms |
| latency p95 | 909396 ms |
| model calls p50 | 26 |
| model calls p95 | 30 |
| avg model calls | 21.7 |
| avg tool calls | 26.7 |
| avg input tokens | 148266.0 |
| avg output tokens | 6340.7 |
| retry rate | 93.3% (avg 3.7/case) |
| recovery rate | 27.5% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 29 |
| human interventions | 0 |
| failures by category | model 4 |
| avg cost score | 43.4 |
| security violations (hard gate) | 12 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 51, reliability 68.8, security 60, latency 29.4, tokens 40.8, tool_calls 74.4, retries 90.5 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 69 |
| retry.tool | 110 |
| retry.verification | 29 |
| retry.compaction | 106 |
| retry.provider | 145 |
| retry.sandbox | 0 |
| retry.stallRecovery | 10 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 13 |
| verified_complete | 9 |
| model_error | 4 |
| verification_failed | 2 |
| time_limit | 2 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ho-01-review-smells | holdout | ✅ | 46452 | 9 | 13 | 4 | 8 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-02-parse-log | holdout | ❌ | 125248 | 18 | 22 | 5 | 0 | 25.0% | 18 | failed | verification_failed | 2 |
| ho-03-convert-format | holdout | ❌ | 236392 | 30 | 29 | 8 | 2 | 0.0% | 0 | failed | agent_limit | 2 |
| ho-04-audit-deps | holdout | ✅ | 34766 | 9 | 13 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-05-complexity | holdout | ✅ | 121752 | 18 | 24 | 6 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-06-migration-script | holdout | ❌ | 133627 | 10 | 11 | 4 | 4 | 28.6% | 0 | failed | model_error | 2 |
| ho-07-permissions | holdout | ❌ | 246057 | 30 | 36 | 11 | 4 | 38.9% | 0 | none | agent_limit | 2 |
| ho-08-optimize | holdout | ❌ | 209838 | 30 | 33 | 9 | 4 | 9.1% | 0 | failed | agent_limit | 2 |
| ho-09-document-api | holdout | ✅ | 31755 | 10 | 12 | 3 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-10-validate-schema | holdout | ❌ | 305204 | 26 | 32 | 4 | 2 | 66.7% | 34 | failed | model_error | 2 |
| ho-11-release-notes | holdout | ❌ | 242562 | 30 | 43 | 12 | 4 | 35.0% | 0 | failed | agent_limit | 2 |
| ho-12-refactor-esm | holdout | ✅ | 31103 | 8 | 13 | 2 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-13-debug-flaky | holdout | ❌ | 299072 | 30 | 36 | 7 | 2 | 12.5% | 0 | none | agent_limit | 2 |
| ho-14-test-matrix | holdout | ✅ | 32954 | 10 | 11 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-15-rate-limiter | holdout | ❌ | 295495 | 30 | 38 | 5 | 4 | 50.0% | 0 | failed | agent_limit | 2 |
| ho-16-analyze-query | holdout | ✅ | 111920 | 17 | 19 | 7 | 6 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-17-changelog | holdout | ❌ | 909396 | 14 | 17 | 6 | 4 | 14.3% | 0 | none | time_limit | 2 |
| ho-18-race-condition | holdout | ❌ | 270557 | 27 | 30 | 6 | 4 | 53.3% | 6 | failed | verification_failed | 2 |
| ho-19-cache | holdout | ❌ | 202333 | 30 | 30 | 12 | 4 | 0.0% | 3 | failed | agent_limit | 2 |
| ho-20-normalize | holdout | ❌ | 368566 | 30 | 40 | 7 | 4 | 38.5% | 34 | failed | agent_limit | 2 |
| ho-21-build-report | holdout | ✅ | 10172 | 4 | 3 | 1 | 0 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-22-fix-vuln | holdout | ❌ | 179583 | 24 | 28 | 5 | 4 | 33.3% | 0 | failed | model_error | 2 |
| ho-23-retry-logic | holdout | ❌ | 243655 | 30 | 33 | 8 | 4 | 40.0% | 0 | failed | agent_limit | 2 |
| ho-24-extract-constants | holdout | ❌ | 1077696 | 19 | 23 | 8 | 4 | 18.2% | 0 | failed | time_limit | 2 |
| ho-25-cron-config | holdout | ❌ | 274159 | 30 | 44 | 12 | 6 | 31.6% | 11 | failed | agent_limit | 2 |
| ho-26-analyze-errors | holdout | ❌ | 208503 | 30 | 44 | 10 | 6 | 8.3% | 0 | failed | agent_limit | 2 |
| ho-27-pagination | holdout | ❌ | 218660 | 30 | 40 | 6 | 2 | 41.7% | 0 | failed | agent_limit | 2 |
| ho-28-refactor-naming | holdout | ❌ | 266109 | 29 | 41 | 8 | 4 | 43.8% | 0 | failed | model_error | 2 |
| ho-29-benchmark | holdout | ✅ | 94161 | 10 | 11 | 4 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| ho-30-healthcheck | holdout | ❌ | 217085 | 30 | 32 | 9 | 6 | 0.0% | 0 | failed | agent_limit | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.