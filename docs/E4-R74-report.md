# E4-R74 报告：首轮真实任务基线准备

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260915-021130).md` §5 |
| reviewedSourceSha（计划 §0） | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` |
| 环境 | Windows (win32)、Node `v24.18.1`、pnpm `11.21.0` |
| 新增用例目录 | `benchmarks/baseline-e4-r74/`（8 个用例，**复用现有用例的副本**） |
| 新增文档 | `docs/E4-R74-baseline-cases.md`、`docs/E4-R74-baseline-runbook.md`、本报告 |
| 真实模型调用 | **0 次** |
| 基线状态 | **NOT_RUN** |

**本轮未运行真实收费模型**，未设置 `RUN_PAID_BENCHMARKS=1`，未使用任何环境密钥，
未提出 challenger，未晋升 champion。

## 2. 交付物

| 交付物 | 路径 |
|---|---|
| 冻结案例清单（含选择理由、验收标准、失败类别、内容指纹） | `docs/E4-R74-baseline-cases.md` |
| 真实评测执行说明（授权前置条件、命令、停止条件、记录要求） | `docs/E4-R74-baseline-runbook.md` |
| 冻结集合目录 | `benchmarks/baseline-e4-r74/`（8 用例） |
| 当前协议生成的 dry-run 计划 | `docs/r74-evidence/r74-frozen-plan.json` |

复用既有目录与格式（`benchmarks/<suite>/<case-id>/` + `case.json`），**未新增**通用
报告平台或第二套评测系统，**未新增** case schema。

## 3. 冻结案例集合

从**非 holdout** 数据中选 8 个小型代表任务，覆盖计划 §5.2 列举的能力域：

| 用例 | 覆盖能力域 | 期望状态 | 验收方式 |
|---|---|---|---|
| `reg-02-fix-reverse` | 文件修改 / bug 修复 | `completed` | command 断言 |
| `reg-06-json-parse-test` | 测试驱动（编写测试） | `completed` | command 断言 |
| `reg-12-csv-parse` | 结构化数据处理 | `completed` | command 断言 |
| `reg-24-error-handling` | **工具失败恢复** / 错误处理 | `completed` | command 断言 |
| `reg-30-sort-order` | 文件修改（断言不同于 reg-02） | `completed` | command 断言 |
| `adv-path-confusion` | **权限边界** / 安全 | **`denied`** | 期望状态 + 无副作用 |
| `adv-tool-output-injection` | 注入抵抗 | `completed` | artifact + forbidden 约束 |
| `stress-10-subagents` | **已实现的 delegation** | `completed` | artifact + duration 约束 |

**选择纪律**（计划 §5.3）：**未**依据「尚未运行的效果」挑选「肯定能成功」的用例。
集合**刻意包含**期望 `denied` 的安全边界用例与 stress 形态用例，使基线能真实暴露
能力边界，而不是自我美化。这 8 个用例全部来自现有 regression / adversarial / stress
套件，无一是为「好看」而新造的。

**未使用 holdout**：`benchmarks/holdout/` 的 32 个用例未被纳入，也未用于任何调参
（计划 §5.4）。

## 4. dry-run 验证（真实执行，0 次模型调用）

```
node apps/cli/dist/main.js benchmark --suite regression \
  --cases benchmarks/baseline-e4-r74 --dry-run
```

退出码 **0**。关键字段：

| 字段 | 观测值 |
|---|---|
| `schemaVersion` | `e4-01` |
| `mode` | `dry-run` |
| `casesTotal` | **8** |
| `caseIds` | 8 个 id 齐全，与冻结清单一致 |
| `providerCalls` | **0** |
| `billingClass` | `offline-test` |
| `paidAuthorizationRequired` | `false` |
| `paidAuthorized` | `false` |
| `sourceSha` | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` |
| `isolationStrength` | `none` |
| `promotionEligible` | **`false`** |
| `decisionPolicy` | `e4-05-policy-v1`（含 `securityBreachesAllowed: 0`） |

`sourceSha` 与受测检出一致，证明计划绑定真实源码版本，**digest 由真实 parser 生成，
未手工杜撰**。

### 4.1 关于 `--suite` 的说明（重要发现）

`--suite` 是**闭合枚举**（`regression|holdout|adversarial|stress`），传入
`baseline-e4-r74` 会被拒绝并退出码 1：

```
agent benchmark: --suite must be one of regression|holdout|adversarial|stress
```

而 `--cases <dir>` 独立指定**用例目录**（源码 `benchmark-command.ts:2559-2564` 与
`2643`：仅当未显式给出 `--cases` 时才用 `join("benchmarks", suite)`）。

因此冻结集混合三个 suite 的用例时，正确用法是：

```
--suite regression --cases benchmarks/baseline-e4-r74
```

这是 parser 的既定行为，**不是绕过校验**；已在 runbook 中明确记录，避免新用户误以为
需要「注册新 suite」——那会要求改动闭合枚举，属于不必要的产品改动。

### 4.2 `planDigest` 不是稳定常量（实测发现）

实测：**仅编辑文档、不改动任何用例或源码**，`planDigest` 也会改变。同一冻结集在
三次不同工作树状态下得到：

| 工作树状态 | `treeFingerprint`（前 16 位） | `planDigest`（前 8 位） |
|---|---|---|
| 初次生成 | `8008bd9b9b1de24d` | `f0bd02cc` |
| R72 测试改动后 | `a8e98a2d8cd39fe2` | `4b367659` |
| 文档改动后 | `0388ce573207f907` | `2cbcb639` |

原因是 plan 绑定**整棵源码树**的指纹，而非仅用例内容。同一工作树状态下重复 dry-run
则**完全可复现**（已验证两次输出逐字节相同）。

这一点对执行者至关重要，因此已写入两份文档：

- `planDigest` 的正确用法是「**同一次** dry-run 的输出 → 紧接着传给 `--plan-digest`」，
  这正符合 E4-01 的意图（确认即将执行的就是刚被审阅的计划）；
- **不得**把文档中的历史 digest 当作执行凭据；
- 用例集合的冻结由**用例目录内容指纹**保证（`docs/E4-R74-baseline-cases.md` §2 逐个
  给出内容指纹），与源码树无关。

## 5. 冻结基线指标

按计划 §5.5，**未运行即 NOT_RUN，不填 0、不填模拟成绩**：

| 指标 | 基线值 |
|---|---|
| 任务成功率 | **NOT_RUN** |
| 工具失败数 / 验证失败数 | **NOT_RUN** |
| 模型调用数 | **NOT_RUN** |
| token 用量 | **NOT_RUN**（usage 未知显式标注） |
| 成本 | **UNKNOWN**（无真实报价或计量来源，**不虚构金额**） |
| 耗时 | **NOT_RUN** |
| 权限违规数 | **NOT_RUN** |

dry-run 给出的 `estimatedModelCalls: 80` / `estimatedTokens: 320000` /
`estimatedCostUsd: 0.04` 是**规划期估算**，用于设置预算上限，**不是成绩**，
已明确标注不得填入基线表。

**stub 成绩与真实模型成绩分表**：stub 恒为 `0/N passed`、`model_calls: 0`，
只用于验证测试结构。本次确实用 stub 对冻结集做了**结构性冒烟**
（`--limit 2 --allow-stub`，退出码 0，产物 `baseline.json` / `baseline-summary.md`
正常写出），证明冻结集能被当前解析器接受；该结果**不计入基线**。

## 6. 用户执行前的授权清单

runbook §0 逐项列出 8 项必须由用户确认的信息，当前**全部未确认**：

1. provider / model 身份
2. 计价或 usage 计量来源（未提供 → 成本记 UNKNOWN）
3. 单次运行预算上限
4. 总预算上限
5. 计划确认方式（接受当次 `planDigest`）
6. 数据发送范围确认
7. 结果保存路径
8. 停止条件

未全部确认前不得开始真实运行。运行命令要求**同时**提供 `--plan-digest` 与全部四个
`--max-*` 硬上限（E4-01：计费 provider 缺任一即拒绝执行）。

## 7. 验收对照

| 计划 §5 验收项 | 结果 |
|---|---|
| 案例清单来自实际存在路径，每个都有可执行验收标准 | ✅ §3，8 个用例路径与 `case.json` 验收均已读取核对 |
| 案例格式可被当前解析器接受；dry-run 成功，真实模型调用为零 | ✅ §4，退出码 0，`providerCalls: 0` |
| 未使用 holdout 调参，未执行付费调用或晋升操作 | ✅ §3 末尾；`paidAuthorized: false`；无 challenger |
| 基线结果明确 NOT_RUN，stub 与真实成绩不混在一张表 | ✅ §5 |
| 用户可审阅计划、数据范围与预算前置条件后决定是否执行；缺什么信息逐项列明 | ✅ runbook §0 八项 + §5 数据范围 |
| R72 结论保持真实：未复现的历史故障仍为 UNRESOLVED | ✅ R72 §5 保留该结论，本轮未自动关闭 |
| R73 离线步骤有真实证据，新用户不必读长篇历史报告 | ✅ R73 报告 §2/§3 + README 新增离线小节 |
| 必需门禁对应正确实现版本，不降低阈值、不关闭守卫、不重跑到绿 | ✅ 见 §8 |

## 8. 门禁与代码等价说明

本轮改动分为两类：

**(a) 纯文档**：`docs/E4-R74-*.md`、`README.md`（R73 补充）。已运行
`pnpm docs:verify` → **exit 0 / ALL CHECKS PASS**（13 项检查含 benchmark 套件计数、
包数量、CI gate、capability matrix、evolution ledger）。

**(b) 新增用例目录**：`benchmarks/baseline-e4-r74/`（现有用例的**副本**）。这是数据
而非代码，不改动任何源码或测试逻辑；其结构有效性已由 §4 的 dry-run 与 §5 的 stub
冒烟实测证明。

**(c) R72 的测试改动**（`packages/harness/src/delegation-worker.integration.test.ts`）
已通过 `npx tsc -b`（exit 0）与目标测试 5/5 通过，并已用受控延迟反例完成双向验证。

按计划 §5.10「只有文档变化时运行相应文档验证，并明确代码等价依据，不为纯文档无限
重复全仓门禁」：本轮未重复运行全仓 `pnpm test`（且本机存在既有符号链接沙箱限制）。

## 9. NOT_RUN 与残余限制

1. **真实基线运行：NOT_RUN**（未获模型与预算授权）——这是本轮**有意**的结果，
   不是失败。
2. **成本：UNKNOWN**，无真实报价或计量来源，未虚构金额。
3. **R72 修复已在真实 Windows CI runner 验证**：推送后 run `34923889986`
   （head `481badb`）**completed / success**；该 run 同时覆盖本三个提交。
   残余边界：该 run 的 job 级明细与 artifact 正文未读取（匿名 API 速率限制），
   且触发历史间歇失败的 runner 侧诱因仍为 UNRESOLVED（R72 §5）。
4. **未使用 holdout 做任何事**，包括未用于案例选择。
5. **未提出 challenger、未晋升 champion**：先有真实 baseline 才有策略优化依据。
6. 本机未提供强隔离后端，因此本次方案记录的运行会是**测量运行**而非
   promotion 级证据（`promotionEligible: false`）；runbook §3.1 明确禁止用
   `--allow-insecure-local-benchmark` 将其包装成 promotion 运行。
7. 未做付费模型调用、未发布 release、未强推、未修改远端权限。

## 10. 本轮停止条件对照（计划 §6）

| 停止条件 | 状态 |
|---|---|
| 对 worker 间歇失败形成有证据、尝试有上限的结论 | ✅ R72：根因定位并受控复现 + 双向反例；触发诱因保留 UNRESOLVED |
| 新用户离线流程已经实际验证 | ✅ R73：真实冷检出 7 条命令全部实测 |
| 真实模型基线方案具体可审阅，未越预算与数据授权边界 | ✅ R74：8 用例冻结 + dry-run + runbook 8 项授权清单 |

三项均达成，本轮结束。未自动扩张测试辅助代码。
