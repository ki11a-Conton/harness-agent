# N7 进度与证据记录 — 上下文安全证据新鲜度策略 v2 挑战者

本文件是 **N7 轮的过程记录**。不可变规格保持原字节：[plan(20261006-144930).md](../../../plan(20261006-144930).md)（按上一轮惯例，规格内状态表不修改，进度一律记录在本文件）；任务合同 [AGENT-NEXT7-20261006.md](../../../tasks/AGENT-NEXT7-20261006.md)。当前计划入口 [plan.md](../../../plan.md)。

- 本轮基线：`ea79130902824d73dafd6fd6bf02f8a8e38fe264`（审查基线）；N7-2 提交 `e99cb3f1`。
- 首次交付时的用户决定：**不迁移到 Linux 强隔离环境**（接受"效果已测、资格不足"的结案方式；Windows 上不得假造 promotion）。后续用户要求补齐执行任务，当前工程与真实环境状态见 §6。
- 门限（8 条）与上一轮完全一致，未放宽；seed 冻结；仅改 Agent 策略层。

## 状态

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| N7-1 写 v2 策略文本并注册 | **DONE** | 下方 §1 |
| N7-2 建全新评测语料（88 用例） | **DONE** | 下方 §2 |
| N7-3 预注册（任何模型结果之前） | **DONE** | 下方 §3 |
| N7-4 基础设施资格门 + campaign | **真实 campaign 已执行（3 次尝试）；run3 完成 512/512 arms，1 个作废 arm → INFRASTRUCTURE_FAILED** | §6、§7 |
| N7-5 双实验判定 | **主实验判定已执行 → NOT_PROVEN；holdout 未跑，联合判定未执行** | §7；[结果记录](N7-RESULT-20261007.md) |
| N7-6 证据、发布与回退 | **主实验失败归档已发布（`execution/main/`）；未 promotion** | §7；[结果记录](N7-RESULT-20261007.md)；[完成报告](execution/acceptance/COMPLETION.md) |

## 1. N7-1 — v2 策略文本与注册（DONE）

| 事实 | 值 |
| --- | --- |
| v2 版本标识 | `context-safe-tool-call-efficiency:v2` |
| v2 文本 SHA256 | `52a80e9c30904b7e3b31d5e7506c9e48300b1ebf4220278c14bd42974809333c` |
| v2 文本长度 | 2185 字节 |
| **v1 文本与 digest（逐字节不变）** | `ce66f3b091752fdb38774914d2d3e5f736c0684930d5162f25ecdb5bed2d56c2`（与 N5 预注册记录一致） |

改动（全部在 Agent 策略层，未触碰 Runtime/Core/压缩/权限/沙箱/验证/依赖）：

- `packages/evaluation/src/mechanism-guidance.ts`：新增 `CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2` 与 `contextSafeToolCallEfficiencyV2GuidanceDigest()`；v1 常量原文未动。
- `candidate-registry.ts`：注册 `context_safe_tool_call_efficiency_v2`（`enabledPatch: { contextSafeToolCallEfficiencyV2: "v2" }`），与 v1 共用 `completionGuidance` 槽位。
- `arm-factory.ts`：新增 `RuntimeMechanisms.contextSafeToolCallEfficiencyV2` 与 v2 分支；`promptAdditionsDigest` 绑定 **v2 真实字节**。
- `mechanism-contract.ts`：新增 v2 契约（`requiredActivationEvents` 与 v1 相同，**未新增事件类型**）。
- `activation-evidence.ts`：v2 激活证明按事件的 **`guidanceVersion === v2`** 判定，v1 注入不能给 v2 记激活。
- `benchmark-command.ts`：单一模型可见提示构建器新增 v2 分支；激活事件版本随臂切换；执行身份机制映射按需追加（既有臂 config hash 不变）。
- `champion-harness-config.ts` / `champion-application.ts`：v2 是独立安装要求；v1 与 v2 同时声明被 **拒绝**（同一槽位互斥）。

验收证据（离线、0 付费调用）：

- `packages/evaluation/src/context-safe-tool-call-efficiency-v2.regressions.test.ts` — 8 tests PASS：v1 冻结字节/digest 不变；v2 独立版本/文本/digest；**单规则变更**（共享 bullet 逐字节相同，v1 独有句不在 v2、v2 独有句不在 v1）；注册表/arm/契约/preflight 真实接通；基线臂与 v1 臂身份不受扰动；旧分派器按 v2 版本判定激活（v1 注入 → `activation_zero`）；执行绑定证据的 payload digest 必须等于 v2 digest；未新增事件类型、未新增工具参数。
- `apps/cli/src/context-safe-tool-call-efficiency-v2.integration.test.ts` — 5 tests PASS：真实 Harness 循环 + 真实 ModelRequest 中系统提示**包含确切 v2 文本**、不含 v1 文本；装 v1 时不含 v2 独有句；默认（未安装）两者皆无；`runtimeConfigForHash`/`computeRuntimeConfigHash`/单一提示构建器三处身份一致且与 v1、baseline 均不同；champion 安装计划只接受单一引导机制。

## 2. N7-2 — 全新评测语料（DONE）

| 集合 | 用例数 | 组成 | 清单摘要（`manifestDigest`） |
| --- | --- | --- | --- |
| `benchmarks/n7-evidence` | 64 | 证据缺失 48 = compact-drop 20 + preview 12 + rehydrate 10 + partial 6；控制 16 = visible 8 + changed 4 + diagnostic 4 | `03a77f3f060e9040ed9ae61bdff8d7e849e646881aa6922f9c52b3c9bcd08fa1` |
| `benchmarks/n7-holdout` | 24 | 证据缺失 16 = 8 + 4 + 2 + 2；控制 8 = 4 + 2 + 2 | `7e8e42fd8f21324342f073bb339763864f9767e01d52972822bb343fe48b2a28` |

- **共 88 个用例**，全部为 N7 新撰写内容：与 N6 语料无夹具字节、无任务文本、无 case id 重叠；holdout 属于不同证据家族（`lib/` 模块 + `lab/`、`registry/`、`config/` 下的 TSV/INI/JSON/仪器日志载体）。
- **判别力证明（逐用例）**：`docs/evidence/agent-next7-20261006/verifier-discrimination.json` — 88/88 verifier 在**未修复夹具上失败**、在**参考修复后通过**，0 失败；记录摘要 `cd5f5b0d79074d9fddb6943b0f691e43f847f6abd6b9111bd0dbfd8b38dc8330`。生成器 `--check` 可复算全部字节。
- 回归测试 `packages/evaluation/src/n7-evidence-cases.regressions.test.ts` — 19 tests PASS：组成、加载器、选择边界、无重命名副本、磁盘字节→digest、176 次红/绿执行、条件构造（>16 KiB / case-local 预算）、**git 跟踪**、证明与在线清单一致、holdout 独立性。
- 作者化脚本：`scripts/research/agent-next7-20261006/`（构建器、两份主集数据、holdout 数据、生成器、判别力证明运行器）。作者化与证明全程 0 模型调用、0 网络。

## 3. N7-3 预注册（DONE，在任何模型结果之前）

冻结产物：[main-preregistration.json](main-preregistration.json)、[holdout-preregistration.json](holdout-preregistration.json)；口径汇总见 [README.md](README.md)。

| 项目 | 主实验 | 独立 holdout |
| --- | --- | --- |
| 候选文本 | v2 `52a80e9c…9333c` | 同左 |
| 对照臂 | `tool_call_efficiency_v1` `ebddf5eb…9619` | 运行时解析 champion（C0/`null`，arm `00d2c921…`，validity=QUARANTINED_PENDING_REEVALUATION，applied=true） |
| 用例 / 重复 | 64 / 4 | 24 / 4 |
| **logical arm runs** | **512**（AB 128 / BA 128） | **192**（AB 48 / BA 48） |
| `preregistrationDigest` | `d824d5938e45bf5962b476e76fbfc0ce7f4264475d1c8d9d8afd6907f1330b2c` | `6ef59a6cc2a5687608d25bf182d07aef160f2f4996ac63e4857eeadf122a8258` |
| 冻结 seed | 20261007 | 20261008 |
| dry-run | 512 runs / `paidProviderCalls=0` / `modelQuality=NOT_RUN` | 192 runs / 同左 |

实现方式（不复制、不手改 digest）：把 N6 构建器**按默认值泛化**为 `ContextSafePlanSpec`（`schemaVersion`/`candidateId`/`comparisonArmId`/两臂 guidance 版本与 digest/`gates`/`repetitions`/`expectedCases`/`expectedLogicalRuns`），默认值 `CONTEXT_SAFE_V1_PLAN_SPEC` 与 N6 现值完全一致；N7 侧 [context-safe-tool-call-efficiency-v2-preregistration.ts](../../../packages/evaluation/src/context-safe-tool-call-efficiency-v2-preregistration.ts) 只提供自己的 spec 与额外 fail-closed 校验。

验收证据：
- [context-safe-tool-call-efficiency-v2-preregistration.test.ts](../../../packages/evaluation/src/context-safe-tool-call-efficiency-v2-preregistration.test.ts) — 13 tests PASS：512/192 与 AB-BA 平衡、dry-run 0 付费调用、已提交产物等于现场重建、绑定 v2 真实文本 digest（并等于 v2 臂的 `promptAdditionsDigest`）、**门限与 N6 逐值相同**、任一可调输入变化即改变 identity（seed/预算/请求档/模型/源码 SHA/用例内容/选择出处/臂 digest/门限）、错误用例数与非 48-hex SHA 与同臂与伪造候选臂 digest 全部 fail-closed、holdout 缺 champion provenance 被拒、主/holdout 用例互不泄漏、产物不含原始端点或凭据形状、且不携带任何模型质量或 promotion 声明。
- [context-safe-tool-call-efficiency-preregistration.test.ts](../../../packages/evaluation/src/context-safe-tool-call-efficiency-preregistration.test.ts) — 14 tests PASS（含第 10 项新断言：用 v1 默认 spec 重建的 N6 主产物与已提交 N6 产物**逐字节一致**）。
- 两个冻结脚本 `--check` 均 PASS（可复算、0 付费调用）。
- 未授权付费 preflight：0 次调用；本轮**从未**读取或写入凭据。

## 4. 首次 N7-3 交付时发现的副作用（历史记录）

1. **注册新候选会移动"基线臂快照"摘要**：`arm-factory.ts buildSnapshot` 在 baseline 臂上把**每个已注册候选**列为 OFF，因此登记 v2 后 baseline 臂 digest 变化。受影响的既有测试 `context-safe-tool-call-efficiency-preregistration.test.ts` 第 5 项原本断言"已提交 holdout 产物 == 现场重建"。处理方式：**不改写已冻结的 N6 产物**，改为断言"除 baseline 臂快照与由此导出的根身份外，其余字段逐字节一致"，并显式记录冻结值 `74b8465e…6466f` 与现场值不同及其原因；同时断言冻结产物自身 dry-run 仍为 192 logical runs / 0 付费调用。v1 与既有候选的**文本与 digest 未变**（测试第 1 项固定 `ce66f3b0…`）。
2. **全仓测试基线对比**：全仓 `pnpm test` 有 15 个文件失败。其中 **11 个文件在 `e99cb3f1`（未含本轮改动）上以同样方式失败**（symlink 权限、worker 终止超时、平台 oracle 等环境性问题），另有 2 个文件（`apps/cli/src/cli.test.ts`、`apps/web/src/harness.integration.test.ts`）在并行满载下失败、单独复跑通过（负载波动）。真正由本轮引入并已修复的只有 `candidate-registry.test.ts`（新增登记项需出现在矩阵列表）与上述预注册复算测试。
3. `pnpm typecheck` 通过；`pnpm docs:verify` ALL CHECKS PASS（含 E2-12、E4-00）。

## 5. 首次 N7-3 交付时未执行的部分（历史记录）

- **N7-4 不执行（操作者决定：两个实验实测约 9–10 小时，本轮不做）**。因此本轮**没有任何模型调用**：无 soak、无 campaign、无 raw request/tool event/usage 证据，也没有任何效果、质量或成本结论。
- N7-5（双实验判定）因此未执行；N7-6 只完成了预注册证据归档与 SHA256 索引，没有 judged 结果可发布。
- 未完成部分若要继续：先跑 24 次调用 soak（0 传输失败、0 `model_not_found`、usage 完整），再在绑定 SHA 的 clean worktree 上跑主实验 512 runs 与 holdout 192 runs（熔断 + journal 断点续跑），然后用与 N5/N6 相同的门限做 ITT 判定（bite 命中子集仅作佐证）。
- **资格限制（不可绕过）**：本机 win32 无 OS 级写隔离后端，所有运行均为 `insecure-local`、`promotionEligible: false`；即使在 Windows 上全部门限通过，也只能得出"**效果已测、隔离资格不足**"的结论，除非将来在强隔离环境按同一预注册复跑。
- 候选状态保持不变：`context_safe_tool_call_efficiency_v2` 为 `candidate`，**未测效果 / 未 promotion**；v1 仍为 `candidate` / NOT_PROVEN，其文本与 digest 未被本轮修改。

## 6. N7-4 / N7-5 / N7-6 执行链工程补齐（2026-10-06）

按用户后续要求，先提交 [执行补齐计划](../../../plan(20261006-n7-execution-chain).md)，再实施独立 N7 研究入口。旧 N6 runner 拒绝主实验 512 runs，holdout 仍安装 v1，旧 judge 也固定 N6/v1；不能直接复用这些入口作为 N7 执行器。旧脚本保持原字节，新入口复用既有 Harness/paired executor、原工具/verifier、安全边界、durable ledger 与 cost budget。

- 实际 clean 源码与强制重建的 dist 重新绑定；原预注册 SHA 只作 lineage，不冒充当前执行源码。两实验真实 CLI dry-run 分别 512/192，AB/BA 平衡，v2 安装及实际对照正确，0 模型调用。
- 新增 24-call soak 与 retry/usage 计量、原冻结预算/deadline、断点原件、完整 ITT 判定、条件实际命中 PP 佐证、两实验联合判定及不可覆盖归档。局部或合成证据不作为模型获胜；单个实验通过不具备晋级结论；不改 champion。
- **clean `85564f0650f5efe715d6fe25e0c3fbef8b58db0c` 全仓：8967 PASS / 0 FAIL / 12 项旧 skip，485 个测试文件**。55 项新增回归全过且无 skip；typecheck、docs、冻结语料/预注册复算通过；source/dist 逐文件指纹在全仓测试前后完全一致。旧 skip 来源的 4 个测试文件与基线相同。
- 494 个原件与补齐基线 `d92d727…` 逐字节一致，包括 N7 策略/语料/预注册、不可变规格和旧 N6 脚本。生产 Runtime/Core/权限/沙箱/工具/verifier/依赖未改。完整可复算原件见 [验收报告](execution/acceptance/COMPLETION.md) 和 [SHA256 索引](execution/acceptance/artifact-index.json)。
- 当前执行环境为 Linux 管理工作区，但实际 bwrap capability self-test 失败，不能仅凭平台声称 strong。`OPENAI_API_KEY` 与有效价目未配置，8317 端点连接拒绝。因此真实 soak/campaign/效果仍为 **BLOCKED/NOT_RUN**，真实模型调用 **0**，候选 **NOT_PROVEN / 未 promotion**。这是当前环境阻塞，与 §5 的首次交付记录分开。
- 原 duration **30 分钟**、工具总额 **600** 保持执行；预计 9–10 小时的实测需要在结果前重新预注册预算。补环境后，在实际 clean SHA 上重新 prepare/确认 binding digest，再按 [使用入口](execution/README.md) 执行；显式 insecure-local 实测永久不具备 promotion 资格。

> **P 轮重新冻结（2026-10-06）**：登记 `verified_completion_gate_v1` 后，baseline 臂快照（枚举全部已注册候选为 OFF）使 champion 解析出的对照臂摘要移动，故 holdout 预注册按本轮冻结脚本重新冻结：`preregistrationDigest` `967da1dd…5664` → `7b675621…7321`，对照臂 `ee589c7e…` → `00d2c921…`；**24 用例 / 192 runs / 门限 / provider / 预算 / provenance 均不变**，且重新冻结发生在任何 N7 模型结果之前（paid calls = 0）。验收记录（`holdout-prereg.log`、`unchanged-originals.json`、`artifact-index.json`、`RAW-MANIFEST.json`）已同步更新并重新自校验通过。

> **N7 预算修订（2026-10-07）**：实测吞吐约 0.83 分钟/arm，512 arms 需约 7.1 小时，故按操作者批准**只把 `budget.maxDurationMs` 由 30 分钟改为 12 小时**（门限／用例／臂／重复／seed／provider／token·工具·USD 上限均未改），两件预注册重新冻结：主 `7c7d0b56…` → `3aef9df0…`、holdout `7b675621…` → `49fea730…`。修订发生在一次基础设施中断、未做效果判定的运行之后；该运行标记 infrastructure-failed、不用于推断。详见 [BUDGET-AMENDMENT.md](BUDGET-AMENDMENT.md)。

> **N7 容量上限修订（修订 #2，2026-10-07）**：campaign #2 跑满 512/512 arms 但 `INFRASTRUCTURE_FAILED, 36/256 pairs` —— `maxToolCalls` 600、`maxInputTokens` 3,000,000 在约 72 arms 处即撞顶，之后每个 arm 被预算拒绝（`TOOL_BUDGET_EXHAUSTED` / `model_error`）而判 `invalid-arm`。按批准只放大四个容量维度（工具 32,000／输入 80,000,000／输出 4,000,000／总量 90,000,000），门限与设计全部不变；两件预注册重新冻结：主 `3aef9df0…` → `d824d593…`、holdout `49fea730…` → `6ef59a6c…`。详见 [BUDGET-AMENDMENT.md](BUDGET-AMENDMENT.md)。

## 7. 真实执行结果（2026-10-07）— 主实验 NOT_PROVEN

本轮共三次真实 campaign 尝试，全部标记为基础设施失败、均不作为模型质量推断依据；已提交记录见 [aborted-runs/summary.json](aborted-runs/summary.json)（含 run3 的作废 arm 归因与计费口径）：

| 尝试 | 结果 | 说明 |
| --- | --- | --- |
| run1 `run-20261006-215646` | 16/512 arms 被会话重启打断 | 不可续跑（attempt 索引为空），0 定案 |
| run2 `run2-20261007-103254` | 512/512 arms，`INFRASTRUCTURE_FAILED, 36/256 pairs` | N5 期容量上限（工具 600／输入 3M）在 ~72 arms 撞顶 → 220 个 `invalid-arm` |
| **run3 `run3-20261007-111347`** | **512/512 arms，`INFRASTRUCTURE_FAILED, 255/256 pairs`；判定 `NOT_PROVEN`** | 有效容量下跑完；1 个作废 arm（E1-02 越界写）+ 两处对账门限失败；**已归档并发布** |

run3 关键事实：执行 binding `6a882ee3…`、冻结主预注册 `d824d593…`、7.1 小时、9,171 次模型调用（0 传输失败／0 重试／0 usage 缺失）、43.15M input / 1.07M output tokens、声明上界计费 9,169,000,000 µ$（硬上限的 9.2%）、工具 15,420/32,000。判定 13 条门限 **6 PASS / 7 FAIL**：`candidate_activation_proven`（256/256 候选臂激活证据）等 6 条通过；`infrastructure_qualified`、`full_frozen_grid`、`missing_group_lift_pp`（**+0.00 pp**，要求 ≥ +5 pp）、`paired_bootstrap_95pct_lower_bound_pp`（**−5.73 pp**）、`usage_complete_and_reconciled`、`durable_budget_proven`、`tokens_within_110pct`（**+14.7%**，上限 +10%）失败。描述性数字（不作推断）：整体 143 → 146、控制组 60 → 63、missing 组 83 → 83，两臂假完成率均约 42%。

本场暴露 **4 处测量缺陷**（仅记录，修复计划待操作者批准后另写）：**D1** campaign 合格线（≥95%）与 judge 的 `full_frozen_grid`（0 作废）不自洽，且 `--resume` 会跳过已进 journal 的作废 arm、无法自愈；**D2** 30 次/run 调用上限边界上 tape 比 arm metrics 多记 65,659 tokens（2 个 candidate arm），使 `reconciliation` 与两条门限必失败；**D3** 模型在工作区外写临时文件被归类为 `failureCategory=infrastructure`，直接作废整场测量而非按行为计分；**D4** 已提交的归档复算入口 `scripts/research/agent-next7-20261006/verify-n7-archive.mjs` 存在语法错误（缺一个 `)`，`node --check` 可复现），即该入口从未被任何测试或流程执行过——本场归档改用等价脚本校验。

**未执行**：独立 holdout（192 runs）、N7-5 联合判定、任何 promotion 动作。候选 `context_safe_tool_call_efficiency_v2` 仍为 `candidate` / NOT_PROVEN，champion 未改动。完整结论、门限全表、缺陷细节与复算方式见 [N7-RESULT-20261007.md](N7-RESULT-20261007.md)。
