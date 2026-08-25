# CAPABILITY MATRIX

- generatedAt: 2026-08-24T12:27:10.256Z
- gitSha: 7a10e83821f48c54a52e8b390ddb8e822fafc89a

## Summary

| status | count |
| --- | --- |
| total | 21 |
| implemented | 12 |
| wired | 9 |
| tested | 0 |
| benchmarked | 0 |
| missing | 0 |

## Records

- profile: interactive-ephemeral

## Records

| id | status | implemented | productionWired | snapshotAuthoritative | durability(actual/req/sat) | securityMode | testDeclared | integrationTested | benchmarkDeclared | benchmarkExercised | degraded | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| context_pipeline | wired | true | true | true | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/context; runtime_dependency:AgentRuntimeDeps.context (context pipeline + budget + instruction discovery passed) |
| checkpoint_store | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/checkpoint |
| artifact_store | wired | true | true | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/core; store:stores.artifacts=InMemoryArtifactStore |
| memory_store | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/memory |
| memory_retrieval | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/memory |
| learning | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/learning |
| delegation | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/agents |
| scheduler | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/agents |
| ask_user_durable | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/core |
| approval_durable | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/security; store:stores.approval=InMemoryApprovalStore (not durable across restart) |
| mcp_connected | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/mcp |
| plugin_host | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/plugins |
| advanced_tools | wired | true | true | true | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/tools; registered_tool:grep_search; registered_tool:repo_tree; registered_tool:symbol_search; registered_tool:repo_map; registered_tool:discover_commands; registered_tool:env_snapshot |
| usage_accounting | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | - | runtime_dependency:packages/observability; runtime_dependency:packages/core/src/runtime/model-call-controller.ts (usage event dropped (case "usage": break); model.completed carries no usage — metrics cannot see tokens/cost) |
| run_budget | implemented | true | false | false | none/none/true | sandboxed | true | false | false | false | profile interactive-ephemeral requires run_budget wired but it is not | runtime_dependency:packages/contracts; runtime_dependency:agent.limits (maxToolCalls/maxDurationMs enforced by the runtime; RunBudgetTracker (P0-10) tracks all limits, controls are wired for maxToolCalls/maxDurationMs) |
| regression_suite | wired | true | true | false | none/none/true | sandboxed | true | false | true | false | - | benchmark_case:benchmarks/regression (30 case(s) on disk (README claims 30)) |
| holdout_suite | wired | true | true | false | none/none/true | sandboxed | true | false | true | false | - | benchmark_case:benchmarks/holdout (30 case(s) on disk (README claims 30)) |
| adversarial_suite | wired | true | true | false | none/none/true | sandboxed | true | false | true | false | - | benchmark_case:benchmarks/adversarial (13 case(s) on disk (README claims 13)) |
| stress_suite | wired | true | true | false | none/none/true | sandboxed | true | false | true | false | - | benchmark_case:benchmarks/stress (11 case(s) on disk (README claims 11)) |
| ci_linux | wired | true | true | false | none/none/true | sandboxed | false | false | false | false | - | ci_job:.github/workflows/ci.yml (ubuntu-latest job) |
| ci_windows | wired | true | true | false | none/none/true | sandboxed | false | false | false | false | - | ci_job:.github/workflows/ci.yml (windows-latest job) |

## Documentation truthfulness (benchmarks/README.md claims vs on-disk suites)

| suite | claimed | actual | planned | truthful |
| --- | --- | --- | --- | --- |
| regression | 30 | 30 | false | true |
| holdout | 30 | 30 | false | true |
| adversarial | 13 | 13 | false | true |
| stress | 11 | 11 | false | true |

audit verdict (P36-8): documentationClaims=PASS; profileRequirements=FAIL; evidenceFresh=FAIL
