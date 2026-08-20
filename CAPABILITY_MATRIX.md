# CAPABILITY MATRIX

- generatedAt: 2026-08-20T09:19:15.414Z
- gitSha: 3a1ab34db792d57f372a496c814520379bbedd21

## Summary

| status | count |
| --- | --- |
| total | 21 |
| implemented | 13 |
| wired | 1 |
| tested | 3 |
| benchmarked | 2 |
| missing | 2 |

## Records

| id | status | implemented | productionWired | integrationTested | benchmarkExercised | evidence |
| --- | --- | --- | --- | --- | --- | --- |
| context_pipeline | tested | true | true | true | false | runtime_dependency:packages/context; runtime_dependency:AgentRuntimeDeps.context (context pipeline + budget + instruction discovery passed) |
| checkpoint_store | implemented | true | false | true | false | runtime_dependency:packages/checkpoint |
| artifact_store | tested | true | true | true | false | runtime_dependency:packages/core; store:stores.artifacts=InMemoryArtifactStore |
| memory_store | implemented | true | false | true | false | runtime_dependency:packages/memory |
| memory_retrieval | implemented | true | false | true | false | runtime_dependency:packages/memory |
| learning | implemented | true | false | true | false | runtime_dependency:packages/learning |
| delegation | implemented | true | false | true | false | runtime_dependency:packages/agents |
| scheduler | implemented | true | false | true | false | runtime_dependency:packages/agents |
| ask_user_durable | implemented | true | false | true | false | runtime_dependency:packages/core |
| approval_durable | implemented | true | false | true | false | runtime_dependency:packages/security; store:stores.approval=InMemoryApprovalStore (not durable across restart) |
| mcp_connected | implemented | true | false | true | false | runtime_dependency:packages/mcp |
| plugin_host | implemented | true | false | true | false | runtime_dependency:packages/plugins |
| advanced_tools | tested | true | true | true | false | runtime_dependency:packages/tools; registered_tool:grep_search; registered_tool:repo_tree; registered_tool:symbol_search; registered_tool:repo_map; registered_tool:discover_commands; registered_tool:env_snapshot |
| usage_accounting | implemented | true | false | true | false | runtime_dependency:packages/observability; runtime_dependency:packages/core/src/runtime/model-call-controller.ts (usage event dropped (case "usage": break); model.completed carries no usage — metrics cannot see tokens/cost) |
| run_budget | implemented | true | false | true | false | runtime_dependency:packages/contracts; runtime_dependency:agent.limits (maxToolCalls/maxDurationMs enforced by the runtime; RunBudgetTracker (P0-10) tracks all limits, controls are wired for maxToolCalls/maxDurationMs) |
| regression_suite | missing | false | false | true | false | benchmark_case:benchmarks/regression (directory missing (README claims 30)) |
| holdout_suite | missing | false | false | true | false | benchmark_case:benchmarks/holdout (directory missing (README claims 30)) |
| adversarial_suite | benchmarked | true | true | true | true | benchmark_case:benchmarks/adversarial (13 case(s) on disk (README claims 13)) |
| stress_suite | benchmarked | true | true | true | true | benchmark_case:benchmarks/stress (11 case(s) on disk (README claims 11)) |
| ci_linux | wired | true | true | false | false | ci_job:.github/workflows/ci.yml (ubuntu-latest job) |
| ci_windows | implemented | true | false | false | false | ci_job:.github/workflows/ci.yml (no windows-latest job) |

## Documentation truthfulness (benchmarks/README.md claims vs on-disk suites)

| suite | claimed | actual | planned | truthful |
| --- | --- | --- | --- | --- |
| regression | 30 | 0 | false | false |
| holdout | 30 | 0 | true | true |
| adversarial | 13 | 13 | false | true |
| stress | 11 | 11 | false | true |

audit: FAILED (a README claim contradicts the on-disk benchmark suites)
