# Benchmark regression

- generated: 2026-08-27T02:44:35.198Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: 6423dbeed9b6c6db3c42c999dbf780b2aabc23a5 (dirty)
- candidate: champion baseline
- runtime config hash: 77339e0683ed5416ca69a4a89583afa8a4789ad12995be42647af91c51184413
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 10.0% (3/30) |
| latency p50 | 220892 ms |
| latency p95 | 298698 ms |
| model calls p50 | 30 |
| model calls p95 | 30 |
| avg model calls | 24.9 |
| avg tool calls | 28.3 |
| avg input tokens | 139490.1 |
| avg output tokens | 6277.4 |
| retry rate | 96.7% (avg 3.5/case) |
| recovery rate | 29.5% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 46 |
| human interventions | 0 |
| failures by category | model 5 |
| avg cost score | 39.1 |
| security violations (hard gate) | 10 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 37, reliability 56.8, security 66.7, latency 19.4, tokens 34.0, tool_calls 71.4, retries 90.5 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 82 |
| retry.tool | 106 |
| retry.verification | 46 |
| retry.compaction | 39 |
| retry.provider | 229 |
| retry.sandbox | 0 |
| retry.stallRecovery | 17 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| agent_limit | 16 |
| verification_failed | 5 |
| model_error | 5 |
| verified_complete | 3 |
| tool_limit | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reg-01-implement-fizzbuzz | regression | ❌ | 223544 | 30 | 34 | 10 | 2 | 21.4% | 0 | failed | tool_limit | 2 |
| reg-02-fix-reverse | regression | ❌ | 261971 | 30 | 38 | 12 | 6 | 35.0% | 0 | failed | agent_limit | 2 |
| reg-03-add-import | regression | ❌ | 85180 | 14 | 11 | 4 | 4 | 37.5% | 0 | failed | verification_failed | 2 |
| reg-04-fibonacci | regression | ❌ | 261418 | 30 | 29 | 6 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| reg-05-off-by-one | regression | ✅ | 71844 | 11 | 13 | 1 | 2 | 50.0% | 0 | passed | verified_complete | 0 |
| reg-06-json-parse-test | regression | ❌ | 194761 | 30 | 30 | 12 | 2 | 0.0% | 0 | none | agent_limit | 2 |
| reg-07-refactor-duplicate | regression | ❌ | 170834 | 19 | 20 | 2 | 4 | 57.1% | 0 | failed | verification_failed | 2 |
| reg-08-quicksort | regression | ❌ | 238584 | 30 | 39 | 14 | 6 | 21.1% | 0 | failed | agent_limit | 2 |
| reg-09-null-check | regression | ❌ | 184117 | 24 | 24 | 5 | 4 | 40.0% | 2 | failed | verification_failed | 2 |
| reg-10-env-config | regression | ❌ | 299779 | 30 | 34 | 7 | 4 | 46.7% | 0 | failed | agent_limit | 2 |
| reg-11-binary-search | regression | ❌ | 155152 | 19 | 24 | 9 | 4 | 28.6% | 0 | failed | model_error | 2 |
| reg-12-csv-parse | regression | ❌ | 213724 | 28 | 32 | 7 | 4 | 33.3% | 6 | failed | verification_failed | 2 |
| reg-13-markdown-doc | regression | ❌ | 91010 | 11 | 17 | 7 | 6 | 22.2% | 0 | none | model_error | 2 |
| reg-14-stack | regression | ❌ | 199431 | 23 | 29 | 5 | 2 | 25.0% | 0 | failed | verification_failed | 2 |
| reg-15-infinite-loop | regression | ❌ | 271720 | 30 | 38 | 10 | 6 | 47.6% | 12 | failed | agent_limit | 2 |
| reg-16-cicd-step | regression | ✅ | 271170 | 27 | 33 | 4 | 0 | 33.3% | 3 | passed | verified_complete | 0 |
| reg-17-gcd | regression | ❌ | 288860 | 30 | 35 | 12 | 4 | 31.6% | 0 | failed | agent_limit | 2 |
| reg-18-date-format | regression | ❌ | 221239 | 30 | 33 | 11 | 2 | 25.0% | 0 | failed | agent_limit | 2 |
| reg-19-config-validator | regression | ❌ | 276688 | 30 | 31 | 3 | 2 | 63.6% | 0 | failed | agent_limit | 2 |
| reg-20-linked-list | regression | ❌ | 220892 | 30 | 36 | 9 | 2 | 23.1% | 1 | failed | agent_limit | 2 |
| reg-21-regex | regression | ❌ | 228220 | 30 | 29 | 5 | 2 | 33.3% | 13 | failed | agent_limit | 2 |
| reg-22-api-stub | regression | ❌ | 215965 | 30 | 32 | 11 | 6 | 14.3% | 0 | failed | agent_limit | 2 |
| reg-23-anagram | regression | ❌ | 275117 | 30 | 35 | 9 | 4 | 0.0% | 0 | failed | agent_limit | 2 |
| reg-24-error-handling | regression | ❌ | 96594 | 14 | 16 | 7 | 4 | 20.0% | 0 | failed | model_error | 2 |
| reg-25-shell-script | regression | ❌ | 106667 | 13 | 13 | 3 | 4 | 50.0% | 0 | failed | model_error | 2 |
| reg-26-queue | regression | ❌ | 177334 | 30 | 31 | 9 | 8 | 0.0% | 0 | failed | agent_limit | 2 |
| reg-27-type-annotation | regression | ❌ | 262573 | 30 | 32 | 7 | 2 | 42.9% | 2 | failed | agent_limit | 2 |
| reg-28-logging | regression | ✅ | 28952 | 9 | 11 | 4 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| reg-29-palindrome | regression | ❌ | 279460 | 30 | 42 | 9 | 2 | 16.7% | 0 | failed | agent_limit | 2 |
| reg-30-sort-order | regression | ❌ | 298698 | 26 | 28 | 7 | 2 | 46.7% | 0 | failed | model_error | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.