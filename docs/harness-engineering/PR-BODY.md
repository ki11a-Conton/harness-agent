# PR: 规格一致性补齐（核心指标口径 + 硬门槛 + 故障注入验收）

> 分支：`pr/harness-engineering-conformance-20261008`（基于 `main` / `bab0e78e`）
> 规格输入：《Harness Agent：核心能力、量化指标与工程验收标准》v1.0（2026-10-08）
> 付费模型调用：**0 次**；真实模型质量结论：**未产生**（仍为 `NOT_PROVEN`）

## 一、这个 PR 解决什么问题

规格给了一套"合格的 Harness Agent"应该达到的**指标与验收口径**。仓库里其实已经有大量对应能力（Runtime、Tool Orchestrator、Permission Engine、Sandbox、Checkpoint、Observability、Evaluation Harness、Promotion Gate），缺的不是模块，而是：

1. 把规格 §三 的 **12 个指标**变成**可计算、可复跑、缺样本可识别**的口径层（而不是散落的字段）；
2. 把规格 §六 的**硬门槛**（安全 100%、循环防护 100%、Trace 100%、完成声明精度 ≥99%、回归 0）变成 **fail-closed 判定**，并保证"加权总分不能放行硬门槛失败"；
3. 把规格 §五 的 **5 类故障注入**里仓库尚未覆盖的格子补成**可执行断言**（不是文档承诺）；
4. 如实产出一份**规格 ↔ 仓库**的一致性矩阵，把"已有 / 新增 / 没覆盖"逐条写清楚（`docs/harness-engineering/SPEC-CONFORMANCE.md`）。

**本 PR 不做**：不跑真实模型实验、不给出任何 pass@1/pass^k 实测数值、不新建真实任务基准、不改动既有门限的严格性、不触碰冻结证据。

## 二、改动清单

| 类别 | 文件 | 用例数 | 说明 |
| --- | --- | ---: | --- |
| 指标口径 | `packages/evaluation/src/harness-metrics.ts` | — | 规格 §三 12 指标：5 轴分层 + 每层样本量 + `INSUFFICIENT_SAMPLE`（缺数据绝不折算为 0）；pass@1 / pass@k / pass^k 口径分离并断言**实测值 ≠ 理想公式值**；§六 评分卡权重仅作补充信息 |
| 硬门槛判定 | `packages/evaluation/src/harness-conformance-gate.ts` | — | 规格 §六/§七 的 **11 个硬门槛** fail-closed（安全/循环/Trace 各 100%、完成声明精度 ≥99%、关键回归 0、重复协议、A/B 可比性、记录字段完整…）；`verdict` **只由硬门槛决定**（加权分不在决策路径上）；与既有 `promotion-gate.ts` 叠加取更严者，只增不减 |
| 指标测试 | `packages/evaluation/src/harness-metrics.test.ts` | 41 | 12 指标正常/空样本两态、5 轴分层样本量、pass@1/pass@k/pass^k 区分、评分卡 |
| 门限测试 | `packages/evaluation/src/harness-conformance-gate.test.ts` | 35 | 三项 100% 硬门槛被 1 例失败打掉、精度 98.9% 被拒（99% 恰好通过）、回归按**任务**计数、缺样本 → BLOCKED、满分评分卡 + 1 例安全失败仍 BLOCKED |
| 故障注入（§五 1/2/5 类） | `packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts` | 12 | 压缩后约束/进度/证据保留且副作用只发生一次；同 turn 混合错误分类 + 重试上限 + 明确失败；崩溃落在持久化边界后**破坏性写入仍为 1**、幂等键、`RESUME_FAILED` 不盲跑 |
| 故障注入（§五 3/4 类 + §八.4） | `packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts` | 20 | 未验证不得宣称完成（完整失败证据包 + 回注纠正）；三类注入面先证明敌意字节进入可见上下文、再断言拒绝与审计事件；跨工作区/敏感命令越权被拒且目标文件确未创建；审批未决不自动 allow、过期即 expired |
| 导出集成 | `packages/evaluation/src/index.ts` | — | 仅新增两条 `export *`（Lead 集成，`tsc -b packages/evaluation` exit 0） |
| 文档 | `docs/harness-engineering/{SPEC-CONFORMANCE,EVIDENCE-INDEX,PR-BODY}.md` | — | 规格↔仓库一致性矩阵、证据索引与复跑、本描述 |

合计 **108 个新增用例**（41 + 35 + 12 + 20），全部离线确定性测试。

## 三、怎么验证

```bash
pnpm exec vitest run packages/evaluation/src/harness-metrics.test.ts \
  packages/evaluation/src/harness-conformance-gate.test.ts \
  packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts \
  packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts
pnpm typecheck
pnpm docs:verify
```

Lead 已独立复跑：4 个文件 **108/108 通过**；`tsc -b packages/evaluation` exit 0；`docs:verify` ALL CHECKS PASS。邻居回归由子代理执行（21 files / 2190 tests PASS）。断言非空洞性由 **10 组变异验证**证明（详见 [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) §4）。

## 三·五、本 PR 发现但**未修**的既有缺陷（附最小复现）

本 PR 只做新增，**不改生产代码**；发现的两处既有缺陷以"已 pin 的断言 + 文档"方式留痕（详见 [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) §5）：

| 编号 | 位置 | 现象 | 影响 |
| --- | --- | --- | --- |
| DEFECT-1 | `packages/core/src/runtime/tool-call-controller.ts:747-757` | `recovery.decided` 在 `retryPolicy !== "safe"` 判断**之前**发出，且把 `retry` 映射为 `action:"retry_safe"`；非 safe / `retryable:false` 的工具实际未重试却留下 "retrying" 记录 | **trace 撒谎**，损害规格指标 #9（Trace 完整率）与 §五-2 可审计性 |
| DEFECT-2 | `packages/core/src/runtime/tool-call-controller.ts:571-578`、`:588-595` | `security.permission_denied` 只在运行时自身闸门发出；orchestrator（真实权限引擎）返回 `denied` 时只发 `tool.failed` | 工具层权限拒绝在**安全事件流上不可见**，削弱指标 #8 可测性 |

## 四、未覆盖与风险（如实声明）

见 [SPEC-CONFORMANCE.md](SPEC-CONFORMANCE.md) 第六节。核心 10 条，其中三条最需评审关注：

1. **本 PR 没有任何真实指标数值**（0 付费调用）：12 个指标只有口径与门限，无 pass@1/pass^k/成本/延迟实测值；真实模型质量仍为 `NOT_PROVEN`。
2. **`auto_verification_coverage` 的分母是"被观测任务数"** —— 基准集若跑漏会**高估**覆盖率，需传入基准任务清单才能修正。
3. **故障注入类指标（#4/#7/#8）依赖调用方注入 ground truth**，根因是**契约层缺字段**（`session.resumed`/`checkpoint.created` 无"状态一致/已续跑"证据），未标注的真实评测会一律 `BLOCKED`（刻意 fail-closed）。

其余：无新建真实任务基准、无强隔离环境复验、无原始轨迹长期归档规程、§七 记录字段映射未建立（`load-runs.ts:43` 的 `events: []` 断层）、未实现置信区间、`percentile()` 空数组约定不一致。

## 五、与规格的对应关系

逐条映射见 [SPEC-CONFORMANCE.md](SPEC-CONFORMANCE.md)（§二 10 能力 / §三 12 指标 / §五 5 类故障 / §六 评分卡 / §七 评测计划）。
