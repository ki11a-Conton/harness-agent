# Benchmark stress

- generated: 2026-08-21T06:11:58.610Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 11

## Run manifest

- git: 3a1ab34db792d57f372a496c814520379bbedd21 (dirty)
- runtime config hash: 4dd8dedd4599385c9d2da167ea3b1604cf2d8a1c3f939f150163aa7b779ad685
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 0.0% (0/11) |
| latency p50 | 3884 ms |
| latency p95 | 6737 ms |
| model calls p50 | 0 |
| model calls p95 | 2 |
| avg model calls | 0.4 |
| avg tool calls | 0.5 |
| avg input tokens | 468.7 |
| avg output tokens | 18.8 |
| retry rate | 27.3% (avg 0.5/case) |
| recovery rate | 88.0% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 0 |
| human interventions | 0 |
| failures by category | model 11 |
| avg cost score | 72 |
| security violations (hard gate) | 0 |
| avg cost dimensions | quality 30, reliability 100, security 100, latency 100, tokens 100, tool_calls 100, retries 100 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 22 |
| retry.tool | 6 |
| retry.verification | 0 |
| retry.compaction | 0 |
| retry.provider | 54 |
| retry.sandbox | 0 |
| retry.stallRecovery | 0 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| model_error | 11 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stress-10-subagents | stress | ❌ | 6737 | 2 | 3 | 1 | 2 | 66.7% | 0 | none | model_error | 3 |
| stress-context-near-limit | stress | ❌ | 5248 | 1 | 2 | 1 | 2 | 66.7% | 0 | none | model_error | 2 |
| stress-deep-directory | stress | ❌ | 6001 | 1 | 1 | 1 | 2 | 66.7% | 0 | none | model_error | 2 |
| stress-huge-generated-logs | stress | ❌ | 3758 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-many-artifacts | stress | ❌ | 3936 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-many-small-files | stress | ❌ | 3542 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-rapid-cancellation | stress | ❌ | 3513 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-repeated-tool-failures | stress | ❌ | 3731 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-slow-mcp | stress | ❌ | 4146 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 3 |
| stress-slow-verifier | stress | ❌ | 3738 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |
| stress-very-long-json | stress | ❌ | 3884 | 0 | 0 | 0 | 0 | 100.0% | 0 | none | model_error | 2 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.