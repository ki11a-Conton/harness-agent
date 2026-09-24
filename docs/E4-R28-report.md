# E4-R28 Report — 执行计划字段与规模约束（G02）

- 被测 SHA：`493866f03d942e85870cc658eb721cfbf2389ec2` → 本次修复提交 `f2f1b0b` 之后（R28 提交见第 4 节）
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 状态：PASS（四个 parser 反例全部拒绝 + 整数/预算/规模合同 + 真实边界验证 + 全回归）
- 真实模型调用：0（全部离线 fixture）
- 变更文件：`packages/evaluation/src/execution-plan.ts` + 新增
  `packages/evaluation/src/e4-r28-execution-plan-fields.test.ts`（14 例）

## 1. 复现（修复前）

G02：`parseExecutionPlan` 定义了 `nullableNum` 但**从未调用**——四个预算字段完全不受
校验；`repeat`/`limit` 只用有限数范围检查，没有整数要求。直接 JS 调用路径（完整 fixture
单字段变更）：

```json
{"field":"repeat","value":2.5,"accepted":true}
{"field":"maxModelCalls","value":-1,"accepted":true}
{"field":"maxLogicalRuns","accepted":true}            // 删除字段仍接受
{"field":"maxEstimatedCostUsd","value":"invalid","accepted":true}
```

同时确认：该缺口是共享 parser 的缺口；CLI 参数解析本身已拒绝负数/非整数（`--repeat` 等
flag 有 `Number.isInteger` 校验），因此不是"CLI 实际执行了负预算付费请求"。

## 2. 修复（`packages/evaluation/src/execution-plan.ts`）

### 2.1 四个预算字段真正接入 validator

| 字段 | 合同 | validator |
|---|---|---|
| `maxLogicalRuns` | null=无限；0=FORBID；正数=上限；必须**安全整数** | `nullableCount` |
| `maxModelCalls` | 同上（安全整数） | `nullableCount` |
| `maxEstimatedTokens` | 同上；token 按整数计量单位 | `nullableCount` |
| `maxEstimatedCostUsd` | null=无限；0=FORBID；正数=上限；**允许合理有限小数**（0.001 / 12.5）；NaN/Infinity/负/字符串拒绝 | `nullableCost` |

四个字段的 key **必须存在**（缺失 = 协议错误，fail-closed："我不知道预算"不能当作无限）。

### 2.2 整数合同统一（CLI 契约对齐，杜绝 parser 放宽 / 执行器取整的静默差异）

- `repeat`：安全整数 ≥ 1（2.5 / 0 / -3 / NaN / >MAX_SAFE 拒绝；`2.0` 合法——它就是整数）。
- `limit`：null=无上限；非 null 时安全整数 ≥ 1；字面 0 拒绝（CLI `--limit 0`=全量 → null）。
- `seed`：非负安全整数（CLI `--seed` 接受非负整数 PRNG 合同；负/小数拒绝）。
- `limit` 与 `caseIds` 一致性：非 null 的 `limit` **小于** `caseIds.length` 时自相矛盾——
  CLI 在规划前已 slice（`--limit N` 取前 N），网格从 `caseIds` 派生；此类 plan 拒绝。

### 2.3 网格规模守卫（展开前拒绝，不运行超大循环）

- 新常量 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000`：`repeat × caseCount` 的文档化
  乘积上限，独立于每个实验的预算字段，约束 `expectedSampleKeysFromExecutionPlan` /
  evaluator / writer 会分配的数组。
- 乘积溢出安全整数、或超过上限 → 结构化错误立即返回，任何调用方不会进入大循环。
- 配对实验在此之上还受 `maxLogicalRuns`（×2 逻辑 arm run）的二道门约束。

## 3. 验收对照

| 计划验收项 | 结果 | 证据（测试名） |
|---|---|---|
| 本轮四个 parser 反例全部被拒绝 | ✅ | `G02 REPRO: repeat=2.5` / `maxModelCalls=-1` / `deleting the maxLogicalRuns key` / `maxEstimatedCostUsd="invalid"` 四例均 `plan:null` 且含对应 issue |
| repeat=2.5、非整数 limit、非安全整数计数被拒绝 | ✅ | `repeat must be a positive SAFE integer`（1/2.0 正例，0/-1/MAX_SAFE+1/NaN/Infinity 负例）；`limit: null=...`（2.5/0/2<3 拒绝，3/100/null 正例）；`null = unlimited, 0 = forbid ... for every count budget field`（2.5/-1 拒绝） |
| null/unlimited、0/forbid 与正值上限在 parser、dry-run、执行中一致 | ✅ | 预算字段逐字段 null/0/5 三态正例 + 负例；cost 0/12.5/0.001/null 正例 |
| 成本小数合法正例不被误拒绝 | ✅ | `maxEstimatedCostUsd` 12.5 / 0.001 accepted |
| 极端重复数在网格展开前快速返回结构化错误 | ✅ | `grid scale ... refused BEFORE expansion`（cap 超限即时结构化错误） |
| 正常三 case × 两 repeat 得到六个唯一 pair key、十二个逻辑 arm run | ✅ | `normal 3 cases × 2 repeats -> 6 unique pair keys and 12 logical arm runs` |
| 完整正常 artifact 经 evaluator/replay 仍通过；非法字段经真实文件 reader 也被阻断 | ✅ | `POSITIVE: the canonical normal plan parses and its digest is stable`；`fractional-repeat plan ... REAL evaluator (decision INVALID)`；`negative/string budget ... REAL promotion loader (ok=false)` |
| typecheck 与 execution-plan/benchmark/paired identity 相关测试通过 | ✅ | 见第 4 节 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/evaluation/src/e4-r28-execution-plan-fields.test.ts` | 14/14 PASS |
| `vitest run packages/evaluation` | 81 files / **1012 tests** PASS |
| `pnpm typecheck`（tsc -b 全仓） | exit 0 |
| `vitest run apps/cli/src/benchmark-command.test.ts`（parser 收紧后 CLI 计划构建） | PASS（CLI 构建的计划均满足新整数/预算合同） |

- 本轮修复提交：`<见 git log E4-R28>`，本地 main，未推送（超范围推送按计划 R31 #4 处理）。
- 脏树下的 E2E 失败为既有的"晋升运行要求干净源码树"正确行为（CLI 生产门禁），
  干净的隔离 worktree/提交后 5/5 通过，与 R27 报告记录一致。

## 5. 残余限制与诚实边界

- 本任务不另造一套重复 schema：schemaVersion/billingClass/candidate/decisionPolicy/
  effectiveModelParams 已按现有执行合同校验（非空对象/枚举），未扩展成独立 JSON-schema 层。
- `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 为新增文档化上限；理由与兼容行为见代码常量注释
  （1M 个计划样本远超任何真实小规模实验，同时让所有网格消费者有界）。
- 剩余合同保持计划语义：normal plan 的 canonical digest 不变（`computeExecutionPlanDigest`
  协议未动，正例断言 digest 稳定）。