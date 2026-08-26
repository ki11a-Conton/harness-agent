# CAPABILITY MATRIX

> NOT RELEASE EVIDENCE — informational repository snapshot. Official release verification uses CI-generated artifacts at immutable `github.sha`.

- generatedAt: 2026-08-26T04:54:58.628Z
- gitSha: 302a7223921618e6a6004b4fe6a89abda7753a34

## Summary

| status | count |
| --- | --- |
| total | 21 |
| implemented | 10 |
| wired | 2 |
| tested | 9 |
| benchmarked | 0 |
| missing | 0 |

## Records

- profile: interactive-ephemeral

## Records

| id | status | implemented | productionWired | snapshotAuthoritative | durability(actual/req/sat) | securityMode | testDeclared | integrationTested | benchmarkDeclared | benchmarkExercised | degraded | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| context_pipeline | tested | true | true | true | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/context; runtime_dependency:AgentRuntimeDeps.context (context pipeline + budget + instruction discovery passed) |
| checkpoint_store | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/checkpoint |
| artifact_store | tested | true | true | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/core; store:stores.artifacts=InMemoryArtifactStore |
| memory_store | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/memory |
| memory_retrieval | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/memory |
| learning | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/learning |
| delegation | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/agents |
| scheduler | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/agents |
| ask_user_durable | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/core |
| approval_durable | implemented | true | false | false | memory/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/security; store:stores.approval=InMemoryApprovalStore (not durable across restart) |
| mcp_connected | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/mcp |
| plugin_host | implemented | true | false | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/plugins |
| advanced_tools | tested | true | true | true | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/tools; registered_tool:grep_search; registered_tool:repo_tree; registered_tool:symbol_search; registered_tool:repo_map; registered_tool:discover_commands; registered_tool:env_snapshot |
| usage_accounting | tested | true | true | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/observability |
| run_budget | tested | true | true | false | none/none/true | sandboxed | true | true | false | false | - | runtime_dependency:packages/contracts |
| regression_suite | tested | true | true | false | none/none/true | sandboxed | true | true | true | false | - | benchmark_case:benchmarks/regression (30 case(s) on disk (README claims 30)) |
| holdout_suite | tested | true | true | false | none/none/true | sandboxed | true | true | true | false | - | benchmark_case:benchmarks/holdout (30 case(s) on disk (README claims 30)) |
| adversarial_suite | tested | true | true | false | none/none/true | sandboxed | true | true | true | false | - | benchmark_case:benchmarks/adversarial (13 case(s) on disk (README claims 13)) |
| stress_suite | tested | true | true | false | none/none/true | sandboxed | true | true | true | false | - | benchmark_case:benchmarks/stress (11 case(s) on disk (README claims 11)) |
| ci_linux | wired | true | true | false | none/none/true | sandboxed | false | false | false | false | - | ci_job:.github/workflows/ci.yml (ubuntu-latest job) |
| ci_windows | wired | true | true | false | none/none/true | sandboxed | false | false | false | false | - | ci_job:.github/workflows/ci.yml (windows-latest job) |

## Documentation truthfulness (benchmarks/README.md claims vs on-disk suites)

| suite | claimed | actual | planned | truthful |
| --- | --- | --- | --- | --- |
| regression | 30 | 30 | false | true |
| holdout | 30 | 30 | false | true |
| adversarial | 13 | 13 | false | true |
| stress | 11 | 11 | false | true |

audit verdict (P36-8): documentationClaims=PASS; profileRequirements=PASS; evidenceFresh=FAIL; requiredEvidenceFresh=PASS
