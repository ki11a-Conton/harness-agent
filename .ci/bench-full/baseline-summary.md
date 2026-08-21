# Benchmark regression

- generated: 2026-08-21T06:08:47.432Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 30

## Run manifest

- git: 3a1ab34db792d57f372a496c814520379bbedd21 (dirty)
- runtime config hash: a6ab8daf47177e367560bfd35c50870ab0d6c8f1394e363c26ce3d41b847b19e
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 0.0% (0/30) |
| latency p50 | 3841 ms |
| latency p95 | 13636 ms |
| model calls p50 | 0 |
| model calls p95 | 3 |
| avg model calls | 0.4 |
| avg tool calls | 0.5 |
| avg input tokens | 483.2 |
| avg output tokens | 13.8 |
| retry rate | 16.7% (avg 0.3/case) |
| recovery rate | 92.1% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 0 |
| human interventions | 0 |
| failures by category | model 30 |
| avg cost score | 71.9 |
| security violations (hard gate) | 0 |
| avg cost dimensions | quality 30, reliability 100, security 100, latency 100, tokens 100, tool_calls 100, retries 96.8 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 70 |
| retry.tool | 10 |
| retry.verification | 0 |
| retry.compaction | 0 |
| retry.provider | 176 |
| retry.sandbox | 0 |
| retry.stallRecovery | 0 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| model_error | 30 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reg-01-implement-fizzbuzz | regression | ❌ | 11305 | 4 | 4 | 2 | 2 | 66.7% | 0 | none | model_error | 2 |
| reg-02-fix-reverse | regression | ❌ | 5882 | 1 | 1 | 1 | 2 | 66.7% | 0 | none | model_error | 2 |
| reg-03-add-import | regression | ❌ | 3827 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-04-fibonacci | regression | ❌ | 3693 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-05-off-by-one | regression | ❌ | 3778 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-06-json-parse-test | regression | ❌ | 3741 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-07-refactor-duplicate | regression | ❌ | 3869 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-08-quicksort | regression | ❌ | 3952 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-09-null-check | regression | ❌ | 3947 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-10-env-config | regression | ❌ | 3785 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-11-binary-search | regression | ❌ | 4043 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-12-csv-parse | regression | ❌ | 3765 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-13-markdown-doc | regression | ❌ | 3730 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-14-stack | regression | ❌ | 5250 | 1 | 1 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-15-infinite-loop | regression | ❌ | 17079 | 3 | 4 | 1 | 2 | 85.7% | 0 | none | model_error | 2 |
| reg-16-cicd-step | regression | ❌ | 3938 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-17-gcd | regression | ❌ | 3648 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-18-date-format | regression | ❌ | 3708 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-19-config-validator | regression | ❌ | 3608 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-20-linked-list | regression | ❌ | 3726 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-21-regex | regression | ❌ | 3796 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-22-api-stub | regression | ❌ | 3841 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-23-anagram | regression | ❌ | 3909 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-24-error-handling | regression | ❌ | 4023 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-25-shell-script | regression | ❌ | 4091 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-26-queue | regression | ❌ | 10765 | 2 | 3 | 1 | 2 | 75.0% | 0 | none | model_error | 2 |
| reg-27-type-annotation | regression | ❌ | 13636 | 2 | 3 | 1 | 2 | 83.3% | 0 | none | model_error | 2 |
| reg-28-logging | regression | ❌ | 3563 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-29-palindrome | regression | ❌ | 3894 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| reg-30-sort-order | regression | ❌ | 3819 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.