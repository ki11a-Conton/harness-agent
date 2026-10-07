# N7 预算修订记录（仅 `budget.maxDurationMs`）— 2026-10-07

本文件是一次**预注册修订**的正式记录。修订经操作者批准，发生在**任何效果判定之前**，且只改一个维度。

## 1. 为什么要修订（实测事实，不是推测）

第一次真实 campaign（本地研究模式 `insecure-local`）：

| 事实 | 证据 |
| --- | --- |
| 启动 | 2026-10-06 21:57:56，绑定 `71ed12fd5b3db626caaa326452cf273482752190cbf7d1fdccf28d013482c8a4`，soak 24/24 QUALIFIED |
| 中断 | 进程在 2026-10-06 22:12:07 后无任何写入；会话/机器重启，后台作业消失；停在 **16/512 arms** |
| 中断时已产生 | 411 次模型调用（全部 `completed=true`、`retries=[]`、`failure=null`）、9 个完整 pair、计费台账按声明上界计入 `charged.durationMs = 797,627`、`usdMicros = 411,000,000` |
| 不可续跑原因 1 | `attempts/0001/` 为空（进程在 attempt 中途被杀，未写不可变索引）；resume 需校验上一 attempt 的 `artifact-index.json`／`raw-index.json` → **`n7[ENOENT]`**（链自身 fail-closed 拒绝） |
| 不可续跑原因 2 | `budget/cost-budget.json`：`campaignDeadlineAtMs = 1791296876584`（= 启动 + 30 分钟，2026-10-06 22:27:56），`deadlineSource: "created"`（不随 resume 重新锚定）→ deadline 已过期 |
| **实测吞吐** | 2.1 秒/次调用、**约 0.83 分钟/arm** → 512 arms ≈ **7.1 小时**（holdout 192 arms ≈ 2.7 小时） |

结论：预注册的 campaign 时长 **30 分钟** 与实测所需的 **~7.1 小时** 相差约 14 倍，**冻结的 campaign 在算术上不可能跑完**。这一点在上一轮 `execution/acceptance/COMPLETION.md` 中已有预告："预计需要 9–10 小时的完整 campaign 必须在模型结果之前显式重新预注册预算，不能自动续 deadline 或增加 cap。"

## 2. 改了什么、没改什么

| 项目 | 旧值 | 新值 |
| --- | --- | --- |
| `budget.maxDurationMs` | `1_800_000`（30 分钟） | **`43_200_000`（12 小时）** |
| 主实验 `preregistrationDigest` | `7c7d0b56ce6e22446fc7e1262dbb68b5310d3bd998eeb75c9f5b399c401f5b9b` | `3aef9df0cfd2d4c2b2200a61a5e5994ca52ca3dc0a6311cea634c7db571c0e7b` |
| holdout `preregistrationDigest` | `7b675621258c1c63a3c7f429c71b4b274c571d3b2684c31b1d7fb98ec7e97321` | `49fea7303e60db9c6cd91419a2341b8e47d466b6811a9d8600fdfb859818fba5` |

**逐值未改动**（由 `--check` 与回归测试保证）：8 条门限、用例集（64 主 / 24 holdout）、重复数 4、臂与 AB/BA 平衡（128/128、48/48）、order seed（20261007 / 20261008）、provider／model／请求档、`maxModelCallsPerRun`=30、`maxToolCalls`=600、`maxInputTokens`/`maxOutputTokens`/`maxTotalTokens`、`maxUsdMicros`=100,000,000,000、champion provenance。N6 的 `maxDurationMs` 保持 `1_800_000` 不变，因此 **N6 产物仍逐字节可复算**。

## 3. 偏差声明（如实）

- 本修订发生在一次**已被基础设施中断、且从未产出任何 verdict** 的运行之后；该运行标记为 **infrastructure-failed**，其原件保留但不用于任何推断（无 judge、无 effect、无 promotion 主张）。
- 修订只涉及**容量/超时**维度，不涉及任何判定门限或统计口径，因此不构成"看到结果后调参"。
- 执行采用已批准的本地研究模式 `--allow-insecure-local-benchmark`：绑定为 `insecure-local`，**永久 promotion-ineligible**；即使全部门限通过，结论上限也只是"效果已测、隔离资格不足"。
- 修订后的 campaign **从零开始一场全新运行**（新输出目录），不与被中断的 run 混合统计。

## 4. 随之更新的记录

- `main-preregistration.json` / `holdout-preregistration.json`（重新冻结，`--check` PASS）；
- `scripts/research/agent-next7-20261006/freeze-n7-{preregistration,holdout-preregistration}.mjs` 与 `packages/evaluation/src/context-safe-tool-call-efficiency-v2-preregistration.test.ts` 中的预算值；
- `execution/acceptance/`：`main-prereg.log`、`holdout-prereg.log`（按 `checks.json` 记录的同一命令重新生成）、`unchanged-originals.json`（两条条目 + `updatedInLaterRounds`）、`RAW-MANIFEST.json`、`artifact-index.json`（顺序：原件 → 清单 → 索引）、`COMPLETION.md` 追加记录；
- `N7-PROGRESS.md`、`README.md` 的摘要单元格与修订说明；
- P 轮预注册套件中引用的 N7 摘要字面量。

## 5. 后续执行顺序（结果之前已定）

```
prepare (--allow-insecure-local-benchmark) → 新绑定 digest
soak (24 调用) → 必须 24/24 QUALIFIED
main campaign (512 logical runs / 256 pairs，全新目录)
holdout campaign (192 / 96)
n7-judge main + holdout（8 条门限 + ITT/PP）
n7-decision（主/holdout 联合判定）
archive-n7-evidence main + holdout
```

只有当两个实验与工程门全部通过、且诚实标注隔离资格不足时，才报告"效果已测"；任一门未过即如实报告 NOT_PROVEN，并保留失败原件。

## 修订 #2（2026-10-07）：campaign 容量上限

第二次真实 campaign **跑满了 512/512 arms**，但判定为 **`INFRASTRUCTURE_FAILED, 36/256 pairs`** —— campaign 级容量上限仍是 N5 时代的值，从未按 N7 的 512-run 设计放大。

| 上限 | 冻结值 | 失败时已计入 | 新值（本次修订） |
| --- | --- | --- | --- |
| `maxToolCalls` | 600 | **600（撞顶）** | **32,000** |
| `maxInputTokens` | 3,000,000 | **2,969,213（撞顶）** | **80,000,000** |
| `maxOutputTokens` | 400,000 | 138,890 | **4,000,000** |
| `maxTotalTokens` | 4,000,000 | 3,108,103 | **90,000,000** |
| `maxDurationMs` | 43,200,000（修订 #1 已改） | 1,749,017 | 43,200,000（不变） |
| `maxModelCallsPerRun` / `maxUsdMicros` | 30 / $100,000 | 747 calls / $747 | 不变 |

- 撞顶后的臂以 `TOOL_BUDGET_EXHAUSTED` 与 `MODEL_ERROR: BUDGET_EXHAUSTED: initial cost reservation refused (input-token cap would be exceeded)` 结束 → `terminationReason = model_error` → `isStrictValidArm = false` → **220/256 对判为 `invalid-arm`**（基础设施门限要求完整配对 ≥95%）。
- 尺寸依据（实测）：最重臂 54 次工具调用、128,724 输入 token、3,096 输出 token；512 arms 需要约 27.6k 工具调用与 65.9M 输入 token，故取 32,000 / 80,000,000 并留余量。
- 门限、用例集、臂、重复、seed、provider、`maxModelCallsPerRun`、USD 上限**逐值未改**；N6 的值保持原样（N6 产物仍可复算）。
- 新 digest：主 `d824d5938e45bf5962b476e76fbfc0ce7f4264475d1c8d9d8afd6907f1330b2c`、holdout `6ef59a6cc2a5687608d25bf182d07aef160f2f4996ac63e4857eeadf122a8258`。
- **偏差声明**：本修订同样发生在已判定为 infrastructure-failed、且无任何效果 verdict 的运行之后；campaign #2 的原件保留但**不用于推断**；修订后重新 prepare／soak 并**从零**开始一场全新 campaign。
- **附带观察（非本轮结论）**：campaign #2 中两个臂的绝大多数 run 都以 `tool_limit`／`grade: unverified_complete` 结束，即**模型在这些任务上倾向于"未验证就宣称完成"，并且把预算烧在工具循环上**。这正是 P 轮候选 `verified_completion_gate_v1` 所针对的失败簇；但该观察来自一场被判定为基础设施失败的运行，**不得**作为任何效果结论。
