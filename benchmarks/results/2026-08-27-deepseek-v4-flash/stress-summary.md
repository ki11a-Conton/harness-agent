# Benchmark stress

- generated: 2026-08-27T06:50:12.240Z
- benchmark version: 2.0.0
- model: openai/deepseek-v4-flash
- cases: 11

## Run manifest

- git: fbf6797719c01d760c96ceb886f58cb1f2969574 (dirty)
- candidate: champion baseline
- runtime config hash: 6bbb35dc5fcdf26f374f1e4ad3a623bfc9997dd12fe6648760eaa6b15f57d136
- suite version: 2.1.0
- judge version: 1.0.0
- temperature: default
- platform: win32 / v24.18.1

## Summary

| metric | value |
| --- | --- |
| success rate | 45.5% (5/11) |
| latency p50 | 76372 ms |
| latency p95 | 249660 ms |
| model calls p50 | 10 |
| model calls p95 | 30 |
| avg model calls | 13.1 |
| avg tool calls | 19.6 |
| avg input tokens | 99154.5 |
| avg output tokens | 2642.1 |
| retry rate | 72.7% (avg 5.8/case) |
| recovery rate | 17.2% |
| context overflows | 0 |
| false completes | 0 |
| verification failures | 4 |
| human interventions | 0 |
| failures by category | infrastructure 3 |
| avg cost score | 71.9 |
| security violations (hard gate) | 1 |

> This report is a **measurement** (the benchmark ran and produced a valid
> report). It is NOT a quality verdict. Quality assessment happens separately
> against a frozen champion (`agent champion eval baseline-runs.json
> candidate-runs.json`). A low pass rate here means this run's measurement
> failed its cases — it does not by itself promote or demote the agent.
| avg cost dimensions | quality 61.8, reliability 82.7, security 90.9, latency 43.5, tokens 65.8, tool_calls 85.7, retries 97.0 |

## Retry taxonomy

| kind | total |
| --- | --- |
| retry.model | 14 |
| retry.tool | 64 |
| retry.verification | 4 |
| retry.compaction | 50 |
| retry.provider | 46 |
| retry.sandbox | 0 |
| retry.stallRecovery | 3 |
| retry.reconciliation | 0 |
| retry.mcpReconnect | 0 |

## Termination reasons

| reason | count |
| --- | --- |
| verified_complete | 5 |
| cancelled | 3 |
| agent_limit | 2 |
| time_limit | 1 |

## Per-case

| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stress-10-subagents | stress | ❌ | 249660 | 6 | 7 | 6 | 4 | 12.5% | 0 | failed | time_limit | 2 |
| stress-context-near-limit | stress | ✅ | 18049 | 7 | 7 | 2 | 2 | 0.0% | 0 | passed | verified_complete | 0 |
| stress-deep-directory | stress | ❌ | 206900 | 30 | 35 | 10 | 6 | 26.7% | 4 | failed | agent_limit | 2 |
| stress-huge-generated-logs | stress | ❌ | 210751 | 30 | 35 | 9 | 0 | 9.1% | 46 | failed | agent_limit | 2 |
| stress-many-artifacts | stress | ✅ | 125355 | 13 | 71 | 22 | 40 | 21.4% | 0 | passed | verified_complete | 0 |
| stress-many-small-files | stress | ✅ | 5760 | 3 | 2 | 0 | 0 | 0.0% | 0 | passed | verified_complete | 0 |
| stress-rapid-cancellation | stress | ❌ | 60031 | 10 | 11 | 4 | 2 | 0.0% | 0 | none | cancelled | 2 |
| stress-repeated-tool-failures | stress | ✅ | 76372 | 14 | 16 | 3 | 4 | 0.0% | 0 | passed | verified_complete | 0 |
| stress-slow-mcp | stress | ❌ | 90022 | 13 | 13 | 6 | 2 | 0.0% | 0 | none | cancelled | 2 |
| stress-slow-verifier | stress | ❌ | 59998 | 8 | 8 | 4 | 0 | 33.3% | 0 | none | cancelled | 2 |
| stress-very-long-json | stress | ✅ | 73472 | 10 | 11 | 3 | 4 | 25.0% | 0 | passed | verified_complete | 0 |

## Notes

- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.
- `false_complete` = turn completed but judge says not done (model claimed done without evidence).
- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.
- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.