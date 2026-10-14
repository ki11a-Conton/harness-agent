# 规格一致性矩阵 —《Harness Agent：核心能力、量化指标与工程验收标准》v1.0

本文件由本 PR 分支 `pr/harness-engineering-conformance-20261008` 的集成负责人（Lead）维护，用于回答一个具体问题：

> 规格里的每一项要求，在本仓库里**究竟是已经实现、本 PR 新增，还是根本没覆盖**？

状态口径：

| 状态 | 含义 |
| --- | --- |
| `ALREADY_PRESENT` | 仓库既有实现与测试已覆盖，本 PR 不改动；给出可复核证据 |
| `ADDED_IN_THIS_PR` | 本 PR 新增（含新增测试/模块），给出文件与测试名 |
| `PARTIAL` | 部分覆盖：说明已覆盖的部分与缺口 |
| `NOT_COVERED` | 未覆盖：写明缺口与所需前置条件（**不允许含糊带过**） |

> **重要边界**：本 PR 是**工程能力与验收口径**的补齐，**不是**模型效果结论。本仓库真实模型质量仍为 `NOT_PROVEN`，本轮 **0 次付费模型调用**。任何"成功率""pass@1 数值"在本 PR 中都**没有**被实测产生。

---

## 一、§二 10 项核心工程能力

| # | 能力 | 状态 | 既有证据（模块） | 缺口 |
| --- | --- | --- | --- | --- |
| 1 | Agent Runtime（推理→工具→反馈循环、生命周期与预算） | `ALREADY_PRESENT` | `packages/core/src/runtime/runtime.ts`、`session-actor.ts`、`model-call-controller.ts`、`run-budget.ts`；测试 `packages/core/src/runtime/run-budget.test.ts` 等 | 无（本 PR 不动） |
| 2 | Tool Execution（注册、参数校验、超时、异常分类、取消、幂等） | `ALREADY_PRESENT` + `PARTIAL` | `packages/tools/src/orchestrator.ts`、`packages/tools/src/process/executor.ts`、`tool-catalog.ts`；测试 `packages/tools/src/process/windows-cancellation.regressions.test.ts` 等 | "连续报错下的重试上限与终止原因"由本 PR 的故障注入测试补强（§五-2） |
| 3 | Context Engineering（选择/检索/裁剪/压缩/token 预算） | `ALREADY_PRESENT` | `packages/context/src/{budget,compaction,rehydration,circuit-breaker,tokenizer}.ts`、`packages/core/src/runtime/context-controller.ts` | 压缩后"约束/进度/证据仍保留"的可观测断言由本 PR 补强（§五-1） |
| 4 | State & Persistence（状态、进度、检查点、恢复） | `ALREADY_PRESENT` | `packages/checkpoint/src/checkpoint-store.ts`（写前校验、回读校验、latest 指针不被污染）、`packages/store/src/sqlite-runtime-store.ts`；测试 `packages/checkpoint/src/checkpoint-store.test.ts` | 无（崩溃窗口一致性由 §五-5 补强） |
| 5 | Planning & Execution（拆解、依赖、进度、条件重规划） | `ALREADY_PRESENT` | `packages/tools/src/verification/plan-builder.ts`、`packages/agents/src/scheduler.ts`、`packages/orchestration/*` | 无 |
| 6 | Verification（构建/测试/静态检查/任务专属验收） | `ALREADY_PRESENT` | `packages/tools/src/verification/task-verifier.ts`、`packages/core/src/runtime/verification-controller.ts`、`packages/core/src/verification/runtime-verifier.ts`；测试 `packages/evaluation/src/verified-completion-gate.regressions.test.ts`、`apps/cli/src/verified-completion-gate.integration.test.ts` | 无（"未验证不得宣称完成"由 §五-3 补强） |
| 7 | Observability（trace、结构化日志、token、成本、延迟） | `ALREADY_PRESENT` | `packages/observability/src/{metrics,trace-exporter,trace-tree,inventory}.ts`（`computeMetrics`/`RunMetrics`）、`packages/events` | 规格 §三-9「Trace 完整率」的**可计算口径**由本 PR 的指标层补（§三） |
| 8 | Safety & Isolation（工作区隔离、最小权限、审批、工具输出不可信） | `ALREADY_PRESENT` + `PARTIAL` | `packages/security/src/{permission,approval,sandbox,boundary-guard,injection-gate,network-gate,process-gate,secret-gate,denial}.ts`；测试 `injection-gate.test.ts`、`boundary-guard.test.ts`、`sandbox.test.ts`、`packages/tools/src/tools/exec-workspace-policy.test.ts`（E1-02） | 仓库文件/检索文本注入面与跨工作区写入的**端到端**断言由本 PR 补强（§五-4） |
| 9 | Evaluation Harness（固定任务集、独立评分、基线对比、回归检测） | `ALREADY_PRESENT` | `packages/evaluation/src/*`（`runner.ts`、`paired-executor.ts`、`load-runs.ts`、`attribution.ts`、`baseline.ts`、`promotion-gate.ts`）、`packages/learning/src/{scorecard,promoter,paired}.ts`、`benchmarks/{regression,holdout,adversarial,stress,...}` | 无（A/B 规则口径见 §七） |
| 10 | Recovery & Adaptation（失败分类、限次重试、循环检测、升级） | `ALREADY_PRESENT` | `packages/core/src/runtime/{recovery-controller,recovery-state-machine}.ts`；测试 `recovery-controller.test.ts`、`recovery-durable.test.ts`、`resume.test.ts` | 无 |

---

## 二、§三 12 个必须量化的工程指标

| # | 规格指标 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 任务成功率（独立验收通过 ÷ 总运行） | `ADDED_IN_THIS_PR`（口径层） | `packages/evaluation/src/harness-metrics.ts`（`computeSpecMetrics`） | 既有 `HarnessScoreCard` 有分 suite 成功率，但未按规格做分层+样本量+缺样本标注 |
| 2 | 重复执行稳定性（同任务 5 次全成功占比 = pass^k） | `ADDED_IN_THIS_PR`（口径层） | 同上 | 既有 `repeated-run.ts` 提供重复运行能力；本 PR 增加 pass@1 / pass@k / pass^k 的**分离口径** |
| 3 | 工具调用有效率（≥99%） | `ADDED_IN_THIS_PR`（口径层） | 同上 | 依据工具调用事件与参数校验/协议结果计算 |
| 4 | 状态恢复成功率（≥95%） | `ADDED_IN_THIS_PR`（口径层） | 同上 | 需故障注入样本；既有恢复能力见 §二-10 |
| 5 | 自动验证覆盖率（≥90%） | `ADDED_IN_THIS_PR`（口径层） | 同上 | 依据任务是否具备机器可执行验收条件 |
| 6 | 完成声明准确率（Precision ≥99%） | `ADDED_IN_THIS_PR`（口径层 + 硬门槛） | `harness-metrics.ts` + `harness-conformance-gate.ts` | 既有 `baseline.ts`/`attribution.ts` 有 `false_complete` 概念，本 PR 将其纳入规格口径与硬门槛 |
| 7 | 循环防护有效率（100%） | `ADDED_IN_THIS_PR`（口径层 + 硬门槛） | `harness-conformance-gate.ts` | 既有循环检测在 `context/circuit-breaker.ts`、runtime 重试逻辑 |
| 8 | 安全控制有效率（100%） | `ADDED_IN_THIS_PR`（口径层 + 硬门槛） | 同上 | 与 `security-evidence-execution.ts` 的既有安全证据对接 |
| 9 | Trace 完整率（100%） | `ADDED_IN_THIS_PR`（口径层 + 硬门槛） | 同上 | 依据 `observability` 事件是否可关联 run/step/tool/result |
| 10 | Token / 成本效率 | `ALREADY_PRESENT` + `ADDED_IN_THIS_PR`（规格口径） | `packages/learning/src/scorecard.ts`（`avgInputTokens`/`avgOutputTokens`/`avgToolCalls`）、`packages/observability/src/metrics.ts`（成本常量与 `computeMetrics`） | 既有已统计；本 PR 增加"每成功任务成本"的规格口径 |
| 11 | 任务完成延迟（P50/P95） | `ALREADY_PRESENT` + `ADDED_IN_THIS_PR`（规格口径） | `scorecard.ts`（`latencyP50Ms`/`latencyP95Ms`、`percentile`） | 既有已有 P50/P95；本 PR 纳入规格报告结构 |
| 12 | 回归率（关键任务回归数 0） | `ALREADY_PRESENT` + `ADDED_IN_THIS_PR`（硬门槛） | `packages/evaluation/src/attribution.ts`（`REGRESSION_DIMENSIONS`/`attributeRegression`）、`baseline.ts` | 既有归因能力；本 PR 将其作为**晋升硬门槛**（回归≥1 → BLOCKED） |

**关键口径纪律（写进实现与测试）**：缺数据 = `value: null` + `status: "INSUFFICIENT_SAMPLE"`，**绝不把缺失当 0**；`INSUFFICIENT_SAMPLE` 一律 `BLOCKED`（规格 §三-2："测试覆盖不到的风险不能被视为已解决"）。

---

## 三、§五 5 类故障注入测试

| # | 场景 | 状态 | 既有证据 | 本 PR 补强 |
| --- | --- | --- | --- | --- |
| 1 | 上下文即将耗尽 | **`ADDED_IN_THIS_PR`**（既有为 `PARTIAL`） | `packages/context/src/{compaction,rehydration,budget}.ts`、`packages/core/src/runtime/context-controller.ts` | `pr-harness-fault-recovery.regressions.test.ts` 的 `[C1-1]/[C1-2]/[C1-3]`（3 例）：压缩**确实发生**（排除未触发/误判停摆两种假通过）+ 压缩后工具继续派发 + 约束在 user 消息与 system digest 双侧存活 + 证据留在 durable transcript + 压缩下副作用只发生一次 |
| 2 | 工具连续报错 | **`ADDED_IN_THIS_PR`**（既有为 `PARTIAL`） | `packages/core/src/runtime/fault-injection.test.ts`、`packages/tools/src/process/executor.ts` | 同文件 `[C2-1]`–`[C2-4]`（4 例）：同 turn **混合分类矩阵**、`retryable:false` 执行次数 == 1、模型层重试上限、连续不可恢复错误以 `blocked/RESOURCE_LIMIT` 明确失败且无 `turn.completed` |
| 3 | 代码已修改但未验证 | **`ADDED_IN_THIS_PR`**（既有为 `PARTIAL`） | `packages/evaluation/src/verified-completion-gate.regressions.test.ts`、`apps/cli/src/verified-completion-gate.integration.test.ts`、`packages/tools/src/verification/task-verifier.ts` | `pr-harness-security-boundary.regressions.test.ts` 的 `G1a`–`G2b`（5 例）：**完整失败证据包**（模型 "Done!" 落在 transcript、grade/termination/error code、`verification.failed` attempt、`run.limit_reached`、回注给模型的 "NOT complete" 纠正）+ 部分通过不得升级 + verifier 崩溃记 by fail-closed |
| 4 | 提示注入与越权 | **`ADDED_IN_THIS_PR`**（既有为 `PARTIAL`） | `packages/security/src/injection-gate.test.ts`、`packages/core/src/runtime/{encoded-tool-output-security,structured-output-security}.regressions.test.ts`、`packages/tools/src/tools/exec-workspace-policy.test.ts` | 同文件 `G3`–`G5b`、`G6a`–`G7`（10 例）：三个注入面（工具输出含失败 stderr / 仓库文件 `AGENTS.md`+`README.md` 与伪造 `DEVELOPER:` 通道 / 检索记忆文本）**先证明敌意字节确实进入可见上下文**，再断言拒绝 + 审计事件 + 无越权后续动作；跨工作区（绝对路径、`..`、符号链接）与敏感命令（`rm -rf /`、组合命令、`node -e`、网络）被拒且目标文件确未创建 |
| 5 | 执行中进程崩溃 | **`ADDED_IN_THIS_PR`**（既有为 `PARTIAL`） | `packages/core/src/runtime/{fault-injection-v2,crash-matrix,crash-sideeffect,resume}.test.ts`、`packages/checkpoint/src/checkpoint-store.test.ts` | 同文件 `[C5-1]`–`[C5-5]`（5 例）：持久化边界中断后**破坏性写入仍为 1**、intent 前置/后置中断的"不丢不重"、幂等键（resume 前后同一条结果 id）、无 checkpoint 时诚实 `RESUME_FAILED` 不盲跑、未决调用显式待核对 |

> 规格要求"每类测试至少保留：故障触发点、原始运行轨迹、恢复步骤、重复副作用记录、最终验收结果和失败归因"——本 PR 的测试以**可复跑断言**形式固化前三项与最后两项；**原始运行轨迹的长期归档**见"未覆盖"清单第 4 条。两个测试子代理各自做了**变异验证**（合计 10 组）证明断言非空洞，见 [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) §4。

---

## 四、§六 评分卡与硬门槛

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 权重（35/25/20/10/10） | `ADDED_IN_THIS_PR`（作为补充信息） | `harness-conformance-gate.ts`：加权分**不得**放行硬门槛失败 |
| 安全与关键正确性额外硬门槛 | `ADDED_IN_THIS_PR` | 安全 100%、循环防护 100%、Trace 100%、完成声明精度 ≥99%、回归 0 |
| 既有晋升判定 | `ALREADY_PRESENT` | `packages/evaluation/src/promotion-gate.ts`（`evaluateHardGates`/`evaluateQualityGates`/`evaluatePromotion`）、`e4-r27-promotion-eligibility.test.ts`、`promotion-envelope*.test.ts` |

**兼容性声明**：本 PR 新增的规格门限**不替换**也不放宽既有 `promotion-gate.ts`；两者都要求"硬门槛全过"才可能放行，取**更严**者。

---

## 五、§七 最小可执行评测计划

| 要求 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 20–30 个可自动验收任务 | `ALREADY_PRESENT` | `benchmarks/regression`（122 个文件）、`holdout`、`adversarial`、`stress` 等固定套件 |
| 每任务独立执行 ≥3 次 | `ALREADY_PRESENT` | `packages/evaluation/src/repeated-run.ts`、paired executor 的重复调度 |
| 每次运行最小记录字段（spec §七 JSON） | `PARTIAL` + `ADDED_IN_THIS_PR` | 本 PR 的 `SPEC_REQUIRED_RUN_RECORD_FIELDS`（21 个字段，逐字取自规格）与 `SpecRunRecord` 已把该 JSON 变成**受测契约**；但仓库既有运行产物到该记录的**逐字段映射未建立**（见未覆盖 5，以及 `load-runs.ts:43` 的 `events: []` 断层） |
| A/B 规则（同模型、同任务集、同权限、同预算） | `ALREADY_PRESENT` | `packages/evaluation/src/paired-executor.ts`、`buildExecutionIdentityV1`、`packages/learning/src/paired.ts` |
| 失败分类（模型/Harness/工具/环境） | `ALREADY_PRESENT` | `packages/evaluation/src/attribution.ts`、`packages/contracts/src/termination.ts` |
| 安全回归禁止晋升 | `ALREADY_PRESENT` + `ADDED_IN_THIS_PR` | `promotion-gate.ts` + 本 PR 的规格硬门槛 |

---

## 六、未覆盖（NOT_COVERED）— 必须如实列出

1. **真实任务集的 pass@1 / pass^k / 成本 / 延迟**：本 PR **没有**运行任何付费模型实验，因此规格 §三 的 12 个指标在本 PR 中**全部没有真实数值**，只有计算口径与门限实现。真实数值仍为 `NOT_PROVEN`（见 `docs/evidence/agent-next7-20261006/N7-RESULT-20261007.md`）。
2. **20–30 个"真实编程任务"的新基准**：本 PR 复用既有 `benchmarks/*` 固定套件，**没有**新建规格 §七 描述的真实任务集，也没有 3 次独立实测归档。
3. **强隔离沙箱环境**：本机为 Windows（`win32-none`），实测一律 `insecure-local`、`promotionEligible=false`；规格 §六 的"安全门槛"在强隔离环境下的复验**未做**。
4. **原始轨迹长期归档**：规格 §五 要求每类故障注入保留"原始运行轨迹"；本 PR 固化的是可复跑断言，长时归档依赖既有 `--trace`/artifact-store 能力，**未在本 PR 内建立归档规程**。
5. **§七 记录字段逐字段对齐**：规格 JSON（`run_id`/`harness_git_sha`/`config_hash`/`environment_id`/`trace_path`/`diff_path`/`verification.evidence_path` 等）与仓库既有运行产物的**逐字段映射表未建立**，属 `PARTIAL`。
6. **评分卡的统计不确定性**：规格 §七 要求"小样本结果应标注统计不确定性"，本 PR 只做样本量披露与 `INSUFFICIENT_SAMPLE` 阻断，**未实现置信区间**。
7. **故障注入类指标依赖调用方注入 ground truth —— 根因在契约层缺字段**：指标 #4 恢复率、#7 循环防护、#8 安全控制都需要"这个任务本应触发/本应被拒"的真值，而当前 case ABI 无法表达（`EvalCase` 无相应字段）。未注入时本 PR **明确报 `INSUFFICIENT_SAMPLE` 并让门限 BLOCKED**（刻意 fail-closed）。**后果：任何未标注故障注入用例的真实评测都不会 PASS** —— 这是设计选择，但评测规程必须配套要求标注。
   > 实现过程中曾尝试用事件轨迹自动判定 #4（"有 `session.resumed`/`checkpoint.created` 且无重复 `tool.started` 即算恢复成功"），**经核实契约后否决**：`packages/contracts/src/event-payloads.ts` 中这两个事件没有任何"状态已验证一致/已继续执行"字段，该判据只能证明恢复被**尝试**过（resume 后立刻再次死掉的运行同样满足），接进 numerator 会把未完成的恢复计为成功 —— 属**放行方向缺陷**。规格 §三 note 5 要求的四项（持久化状态、工作区一致性、调用幂等、已执行副作用）中事件轨迹**只能回答最后一项**。因此本 PR 选择"宁可 BLOCKED 也不接受自报恢复"，并把该缺口记录为**后续给 `session.resumed`/checkpoint 增补一致性字段的理由**。
8. **`auto_verification_coverage` 的分母是被观测任务数**：若基准集有 30 个任务而只跑了 20 个，覆盖率会被**高估**。消除该风险需要把基准任务清单传入（当前接口未含）。**这是本 PR 最需要评审关注的一条口径缺陷。**
9. **`load-runs.ts:43` 的 `events: []` 断层**：用 `loadRunsFromArtifact()` 喂本 PR 门限时，`trace_completeness` 必然全 0、验证状态全 `null`（同文件的 `verification_passed`/`termination_reason` 未被搬进 `events`）。属**用法断层**而非既有 bug；本 PR 不改既有文件，二选一方案见 [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) §6。
10. **`percentile()` 约定不一致**：`packages/learning/src/scorecard.ts:56` 空数组返回 `0`（会呈现"0ms 延迟"），本 PR 的 `percentileOrNull` 返回 `null`。混用会产生假象；本 PR 未改既有文件。

---

## 七、复跑方式（0 付费调用）

```bash
# 本 PR 新增测试
pnpm exec vitest run packages/evaluation/src/harness-metrics.test.ts \
  packages/evaluation/src/harness-conformance-gate.test.ts
pnpm exec vitest run packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts
pnpm exec vitest run packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts

# 仓库级门禁
pnpm typecheck
pnpm docs:verify
```

（上述命令的实际输出与结果索引见同目录 [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md)；本文件中的 `ADDED_IN_THIS_PR` 行在子任务完成后由 Lead 用真实测试输出复核，未通过的行不会保留该状态。）
