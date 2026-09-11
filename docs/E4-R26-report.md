# E4-R26 Report — 总验收、计划入口与文档收口

- 审查基线（reviewedSourceSha）：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 门禁被测 SHA（testedSourceSha）：`adc9e3e`（R21–R25 全部修复 + 计划入口/README 文档提交）
- 本报告提交 = documentationCommitSha（与 testedSourceSha 区分，避免自引用循环）
- 状态：PASS（逐条关闭矩阵见下；CI 远端验证 NOT_RUN——未授权 push）
- 真实模型调用：0；本计划全部离线。fake/scripted provider 调用数以测试输出为准，未混写为 0。

## 1. 关闭矩阵（F01–F05 / V01）

| 缺陷 | 实现文件（符号） | 负例（真实测试名） | 正例（真实测试名） | 测试命令（实测） | 被测 SHA | 状态 |
|---|---|---|---|---|---|---|
| F01 release 证据消费链统一 | `apps/cli/src/release-verify.ts` `parseRawEvidence`+`reverifyGateEvidenceRefs`；`gate-evidence-v2.ts` | `e4-r21-release-reverify.test.ts`: "a tampered log blocks release READY"; "RELEASE_REF_REVERIFY…"; "a DELETED log blocks release READY"; "a file at the same relative path under the cwd cannot change the bundle verdict" | "valid complete bundle (all gates/platforms) → both loaders succeed"; "bundle still verifies after MOVED" | `vitest run apps/cli/src/e4-r21-release-reverify.test.ts` + `e4-r21` 目标集 | `89e1d9e` 起 | PASS |
| F02 executionPlan 严格解析与交叉绑定 | `packages/evaluation/src/execution-plan.ts` `parseExecutionPlan`；`champion-eval-v3.ts`/`promotion-envelope.ts` 消费 | `e4-r22-execution-plan.test.ts`: "EMPTY_EXECUTION_PLAN…never promote"; "ARRAY…UNKNOWN schemaVersion"; "a plan field changed while keeping OLD planDigest is rejected"; "applied policy differing from the PLAN's policy"; "cross-binding violations…stable reasons"; "expectedSampleKeys disagreeing…rejected" | "control: a COMPLETE confirmed plan → ACCEPT and promotion bundle loads OK" | `vitest run packages/evaluation/src/e4-r22-execution-plan.test.ts` | `0d73148` 前提交链 | PASS |
| F03 观察记录未绑定被请求 runId | `apps/cli/src/observation-evidence.ts` `loadObservationEvidence`/`isSafeObservationRunId`；`commands.ts` usage-audit 分支 | `usage-audit.test.ts`: "rows copied verbatim from an OLD run file … NOT observed"; "testName not declared…never observed"; "traversal-shaped runIds rejected"；CLI: `usage-audit --strict` 无 `--run` exit 1 | e4-09 命名运行 → 独立 `usage-audit --run <id> --strict` 七能力 observed（exit 0） | `node apps/cli/dist/main.js usage-audit --run e4-r24-verify2-… --strict` | `2ade6ca`/`9c693e4` | PASS |
| F04 observation commit 早于最终结果 | `apps/cli/test-infra/observation-vitest-reporter.ts` `finallyPassed`/`onTestRunEnd`；`observation-evidence.ts` `commitObservationRun`；CI 步骤 | `e4-r24-final-result-protocol.test.ts`: "assert-fail run…committed 0, dropped 1"; "hook-fail run…committed 0, dropped 2" | "green run…committed exactly ONE row; independent strict audit observes" | `vitest run apps/cli/src/e4-r24-final-result-protocol.test.ts`（真实 vitest 子进程） | `2ade6ca` | PASS |
| F05 源码指纹绑定状态文本而非内容 | `apps/cli/src/benchmark-command.ts` `probeSourceSnapshot`（内容级指纹 + clean 语义）；`runPairedPromotion` 执行期/结束后复核 | `benchmark-command.test.ts`: "A→B edit of the SAME file…status text is identical → fingerprint changes"; "NON-repo / probe-failing…clean=false" | "identical content → STABLE"; "ignored outputs do NOT dirty"; "request capture…budget reaches the request; temperature is NOT a request parameter" | `vitest run apps/cli/src/benchmark-command.test.ts`（62/62） | `de5663e` | PASS |
| V01 恢复复合存储故障 | `packages/core/src/runtime/session-actor.ts` `durableTurnIsTerminal` + `recoverHead`/`discoverRecoverableTurns` | `recovery-durable.test.ts`: "V01-b … action is NOT re-run"（修复前 RETRY_SCHEDULED 重跑）; "V01-c whole-store outage fails closed" | "V01-a…queue frozen, prompt not consumed"; "V01-a-restart…no replay, consume after heal" | `vitest run packages/core/src/runtime/recovery-durable.test.ts`（12/12） | `1175acb` | PASS |

## 2. 生产入口消费链手工检查（不只单测）

- E4-R24：`node apps/cli/dist/main.js usage-audit --run e4-r24-verify2-20260911-1344 --strict`
  实测 exit 0、七项 `PASS … level=observed`；同一 CLI 无 `--run` 的 `--strict` 实测 exit 1。
  `.github/workflows/ci.yml` `verify` job 在 Build 后新增同名 `usage-audit --run "$E2E_OBSERVATION_RUN_ID" --strict`
  独立步骤 + 证据上传。
- E4-R23：`probeSourceSnapshot` 由 `runBenchmarkCommand`（真实 CLI benchmark 入口）调用；
  e4-09 生产 E2E（命名运行）在干净树通过（5/5，committed 7 rows），说明执行期/结束后复核
  在真实链路上生效。
- E4-R25：`durableTurnIsTerminal` 由 session-actor 的恢复协调生产路径调用（非测试假件）；
  `packages/core packages/harness` 658 测试全过覆盖该路径。

## 3. 门禁结果（干净固定 commit `adc9e3e`）

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| typecheck / build（`tsc -b`） | `pnpm typecheck` | exit 0 |
| 全仓测试 | `pnpm test` | **314 files / 5674 passed / 1 skipped**，exit 0 |
| docs | `pnpm docs:verify` | **ALL CHECKS PASS**（含 plan.md 唯一入口检查） |
| 定向回归 | R21/R22/R23/R24/R25 目标集 + core/harness（658）+ race（15） | 全过（各任务报告） |

- 运行前后工作树 clean：`git status --short` 为空（报告提交前）；provider 类别：真实模型调用 0，
  fake/scripted 用于测试与离线 E2E。
- CI（远端）：**NOT_RUN** —— 本计划默认离线，未授权 push；推送后须以精确 SHA
  （`adc9e3e` 及后续文档提交）查 run/jobs/artifacts 才能写远端结论。
- R21 Windows→Linux 跨平台 bundle 消费：本地只能验证目录移动/cwd 改变场景（既有测试
  "bundle still verifies after MOVED"），真实 Windows→Linux CI 消费标注 NOT_RUN，不冒充。

## 4. 文档收口

- `plan.md` 唯一入口已更新：R21–R25 标记完成并指向各自报告，R26 进行中；历史计划保留。
- `README.md`：过时测试数量（"248 files, ~4800 tests"）改为指向 CI/实测输出；真实模型
  示例改为 **dry-run → `--plan-digest` + `--max-model-calls` 确认** 的离线协议（不产生付费调用）。
- `docs:verify` 通过；未改写任何历史报告（保留原时间与源码语境）。

## 5. 三个结论的边界（R26 要求显式区分）

- **runtimeReleaseReady（工程门禁）**：本次修复（F01–F05/V01）后本地全部门禁绿；
  但本轮改动未推送、CI 未运行，远端 Ready 结论 NOT_RUN——不把本地绿当远端证明。
- **promotion evidence integrity（证据完整性）**：executionPlan 交叉绑定、内容级源码指纹、
  观察记录的 runId/最终结果绑定、release 输出复核均已落地并有负例/正例证据。
- **champion quality（模型质量）**：本计划未做付费 benchmark，`championPromotion.status=NOT_RUN`
  保持原状；下一阶段如需提升质量，回 benchmark→failure cluster→hypothesis→challenger→
  paired eval 流程，以实际失败证据立项。

## 6. 残余限制

- CI 远端验证、真实模型 champion 评估、正式 release 三项不在本计划自动执行范围（未付费、
  未 push、未发布）。
- F05 指纹不防写权限持有者篡改；F04 观察证据依赖 vitest 最终结果约定；V01 崩溃窗口
  （runTurn 效果产生后、main-store turn 终态前）保持有界 at-least-once——各任务报告如实说明。
- 本轮所有改动在本地 main；分支领先 origin/main 若干提交（历史 R20 及本轮 R21–R25、R26 文档）。