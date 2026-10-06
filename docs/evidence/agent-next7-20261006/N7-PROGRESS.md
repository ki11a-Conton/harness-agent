# N7 进度与证据记录 — 上下文安全证据新鲜度策略 v2 挑战者

本文件是 **N7 轮的过程记录**。不可变规格保持原字节：[plan(20261006-144930).md](../../../plan(20261006-144930).md)（按上一轮惯例，规格内状态表不修改，进度一律记录在本文件）；任务合同 [AGENT-NEXT7-20261006.md](../../../tasks/AGENT-NEXT7-20261006.md)。当前计划入口 [plan.md](../../../plan.md)。

- 本轮基线：`ea79130902824d73dafd6fd6bf02f8a8e38fe264`（审查基线）；N7-2 提交 `e99cb3f1`。
- 用户决定：**不迁移到 Linux 强隔离环境**（接受"效果已测、资格不足"的结案方式；Windows 上不得假造 promotion）。
- 门限（8 条）与上一轮完全一致，未放宽；seed 冻结；仅改 Agent 策略层。

## 状态

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| N7-1 写 v2 策略文本并注册 | **DONE** | 下方 §1 |
| N7-2 建全新评测语料（88 用例） | **DONE** | 下方 §2 |
| N7-3 预注册（任何模型结果之前） | TODO | 待建 N7 预注册模块，dry-run 必须为 512 logical arm runs/实验 |
| N7-4 基础设施资格门 + campaign | TODO | 先 24 次调用 soak，再 512 runs/实验 |
| N7-5 双实验判定 | TODO | 9 条门限（ITT；bite 仅作佐证） |
| N7-6 证据、发布与回退 | TODO | 不足即保持 candidate / NOT_PROVEN |

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

## 3. 本轮已发现的副作用（如实记录，未修饰）

1. **注册新候选会移动"基线臂快照"摘要**：`arm-factory.ts buildSnapshot` 在 baseline 臂上把**每个已注册候选**列为 OFF，因此登记 v2 后 baseline 臂 digest 变化。受影响的既有测试 `context-safe-tool-call-efficiency-preregistration.test.ts` 第 5 项原本断言"已提交 holdout 产物 == 现场重建"。处理方式：**不改写已冻结的 N6 产物**，改为断言"除 baseline 臂快照与由此导出的根身份外，其余字段逐字节一致"，并显式记录冻结值 `74b8465e…6466f` 与现场值不同及其原因；同时断言冻结产物自身 dry-run 仍为 192 logical runs / 0 付费调用。v1 与既有候选的**文本与 digest 未变**（测试第 1 项固定 `ce66f3b0…`）。
2. **全仓测试基线对比**：全仓 `pnpm test` 有 15 个文件失败。其中 **11 个文件在 `e99cb3f1`（未含本轮改动）上以同样方式失败**（symlink 权限、worker 终止超时、平台 oracle 等环境性问题），另有 2 个文件（`apps/cli/src/cli.test.ts`、`apps/web/src/harness.integration.test.ts`）在并行满载下失败、单独复跑通过（负载波动）。真正由本轮引入并已修复的只有 `candidate-registry.test.ts`（新增登记项需出现在矩阵列表）与上述预注册复算测试。
3. `pnpm typecheck` 通过；`pnpm docs:verify` ALL CHECKS PASS（含 E2-12、E4-00）。

## 4. 尚未完成（N7-3…N7-6）

- **N7-3**：v2 预注册模块与冻结（v2 文本 SHA256、64 用例集与独立 holdout、AB/BA、provider/model/请求档/预算硬上限、两臂 digest、冻结 seed、门限不变），`dryRun` 必须精确 **2×64×4 = 512 logical arm runs/实验**、付费 0。
  - 已核对的实施路线：N6 构建器 `buildContextSafePreregistration(options)` 的参数面（`ContextSafePreregistrationOptions`）已覆盖 subject/provider/cases/suite/evaluation/schedule/budget，N6 专有的只是 schema 常量、`CONTEXT_SAFE_CANDIDATE_ID`/`CONTEXT_SAFE_COMPARISON_ARM_ID` 与 `24 × 4` 调度常量。因此 N7-3 采用**带默认值的泛化**：新增可选 `candidateId`/`comparisonArmId`/`schemaVersion`/`repetitions`，默认值等于 N6 现值 —— 于是 N6 已提交产物的字节与 digest 保持不变（由既有 N6 预注册测试断言），N7 侧再以 v2 文本 digest、64 用例集、4 次重复换取 512 logical runs。**不得**通过复制 N6 常量再手改 digest 的方式绕过。
- **N7-4**：24 次调用 soak（0 传输失败、0 `model_not_found`、usage 完整）→ 两个 campaign（各 512 runs，约 4–5 小时/实验，合计约 9–10 小时），带熔断与 journal 断点续跑；从绑定的 clean worktree 运行（避免 E2-09 宿主突变哨兵）。
- **N7-5**：用同一 9 条门限判定（ITT；bite 命中子集仅佐证）。
- **N7-6**：证据归档与 SHA256 索引；未达门则保持 `candidate` / NOT_PROVEN。
- **资格限制（不可绕过）**：本机 win32 无 OS 级写隔离后端，所有运行均为 `insecure-local`、`promotionEligible: false`；因此即使在 Windows 上全部门限通过，也只能得出"**效果已测、隔离资格不足**"的结论，除非将来在强隔离环境按同一预注册复跑。
