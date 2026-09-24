# E4-R33 Report — 让 execution-plan 规模校验先于危险操作（H03）

- reviewedSourceSha（计划基线）：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- testedSourceSha：**dirty worktree on `bcf3f42c`**（本轮 R32/R33 改动未提交；被测即工作树源码 + 重建 dist）
- 状态：**PASS**（确定性复现 + 最小 parser 修复 + 范围内正例 / 范围外结构化拒绝 + 回归）
- 真实模型调用：0（全部离线 parser / evaluator，scripted provider）
- 变更文件：
  - `packages/evaluation/src/execution-plan.ts`
  - `packages/evaluation/src/e4-r33-execution-plan-scale.test.ts`（新增，7 例）

## 1. 问题与范围

计划 review 记录 `testedSourceSha≈bcf3f42`、`previousBaseline 493866f0`。H03（P2）：

> 130000 个唯一 case、repeat=1，低于公布的 1000000 sample 上限，parser 在数组 spread 处抛 `RangeError`，尚未到达规模校验。

范围声明：证明的是**共享 parser 对合法容量抛异常、且容量的实现路径不可达**，不声称已造成生产服务远程拒绝服务。

## 2. 复现（修复前，确定性）

计划给的离线片段（`fixtureExecutionPlan` + 130000 case）实测：

```text
$ node _r33-repro.mjs            # 修复前
THREW: RangeError - Maximum call stack size exceeded
small control (3 cases × 2 reps): {"smallAccepted":true,"smallIssues":[]}
```

130000 × 1 = 130000 ≪ 公布的 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000`，却因 `caseIds.push(...caseIdsRaw)`
的**实参展开**撞上引擎实参上限而抛 `RangeError`。

测试固定后（`-t R33`，源码临时回退到 HEAD）：

```text
 × R33-b: a 130,000-case × 1-repeat plan (contract-valid: limit=null) PARSES — no RangeError 143ms
 × R33-c2: the caseCount factor alone can exceed the cap (repeat=1) and is refused before ANY per-case work 563ms
RangeError: Maximum call stack size exceeded
 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
```

## 3. 根因与修改点（`packages/evaluation/src/execution-plan.ts`）

三处确定性缺陷：

| # | 位置（修复前） | 缺陷 |
|---|---|---|
| 1 | `caseIds.push(...(caseIdsRaw as string[]))` | 实参展开 → 大数组 `RangeError: Maximum call stack size exceeded`，**合法**提示计划无法解析 |
| 2 | `if (!caseIds.includes(k))` | 逐个 fingerprint key 做线性成员查询 → `O(caseCount × keyCount)` 二次方，公布的容量上限**没有可实现的校验路径** |
| 3 | 规模/`limit` 校验在**最后** | 超限计划要先付完 `O(caseCount)` fingerprint 绑定才被拒绝，与「拒绝发生在不必要的大规模拷贝、网格展开之前」相反 |

修复：

1. **无展开拷贝**：`if (idsOk) for (const c of caseIdsRaw) caseIds.push(c as string);`
2. **O(1) 成员查询**：`const plannedIds = new Set(caseIds);` 取代 `caseIds.includes(k)`；duplicate / missing / unplanned 语义不变。
3. **容量护栏提前 + 提前返回**：在**数组类型/长度检查之后、任何逐 case 遍历之前**，用 `repeat × caseIdsRaw.length` 做乘积安全性与上限校验；不安全或超限时**立即返回**结构化 issue：

```ts
const gridRepeat = r["repeat"];
if (Array.isArray(caseIdsRaw) && caseIdsRaw.length > 0 &&
    typeof gridRepeat === "number" && Number.isSafeInteger(gridRepeat) && gridRepeat >= 1) {
  const product = gridRepeat * caseIdsRaw.length;
  if (!Number.isSafeInteger(product)) return { plan: null, issues: [...issues, `…overflows a safe integer`] };
  if (product > EXECUTION_PLAN_MAX_PLANNED_SAMPLES) return { plan: null, issues: [...issues, `…planned-sample cap (refuse before expansion)`] };
}
```

护栏只用**已通过 `safeCount("repeat", 1)` 的整数 repeat**参与，因此小数的 `repeat` 不会在这里被误用为乘数；
`limit` 自相矛盾校验紧随 `caseIds` 解析之后（O(1)）。**默认保留公开上限 1_000_000**（未按复现值下调）。

**grid helper 调用方核查**（计划 §4 怎么做 #6）：`expectedSampleKeysFromExecutionPlan` 的两个非测试调用方
（`execution-plan.ts:crossBindExecutionPlan`、`paired-v3-builder.ts:247`）都**先经 `parseExecutionPlan` 验证**
（后者在 `parsed.plan === null` 时直接抛错），不存在直接展开未验证输入的入口 → **不需要**额外的边界保护，故未改动任何 helper API。

## 4. 验收对照

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| 正常 3 case × 2 repeat：6 个唯一 sample key，原 canonical digest 保持不变 | ✅ | **R33-a**：`issues===[]`、keys 长度 6、集合大小 6、`toEqual(GRID)`；digest 与 `computeExecutionPlanDigest(plan)` 及 `fixtureExecutionPlanDigest` **三者相等** |
| 130000 case × 1 repeat：按现合同成功解析，无 `RangeError` | ✅ | **R33-b**：`limit=null` 合同一致 → `plan!==null`、`issues===[]`、派生网格长度 130000；修复前为 `RangeError` |
| `caseCount` 本身超限 / `repeat × caseCount` 超限 / 乘积不安全：均结构化拒绝，不展开网格、不抛异常 | ✅ | **R33-c**（超限 `planned-sample cap` + `refuse before expansion`；不安全 `overflows a safe integer`）、**R33-c2**（1,000,001 case、`caseFingerprints:{}` → **issues 恰好 1 条**且无 `64-hex fingerprint` 展开 ⇒ 确实在逐 case 工作之前拒绝） |
| 四预算字段、null/0 语义、负数/小数/缺字段反例仍按 R28 拒绝 | ✅ | **R33-d**：小数 repeat / `maxModelCalls:-1` / 缺 `maxLogicalRuns` / 字符串 `maxEstimatedCostUsd` 均被拒；`maxLogicalRuns:null`、`maxModelCalls:0` 仍接受 |
| 大规模重复 case、缺 fingerprint、多余 fingerprint 均仍正确拒绝 | ✅ | **R33-e**：重复 caseIds → `unique non-empty strings`；缺 fingerprint → `must carry a 64-hex fingerprint for planned case`；多余 fingerprint → `UNPLANNED case` |
| 真实 evaluator / promotion-loader 对超限计划给出可解释拒绝，不泄漏原始 `RangeError`；正例继续通过 | ✅ | **R33-f**：真实 `runV3ChampionEval` → `decision==="INVALID"`，`pairingViolations` 含 `planned-sample cap`、**不含** `RangeError`；同一真实链路对正常计划**不**报该原因 |
| 大规模测试放入必要的 parser 单测；不重复构造百万数据、不设机器敏感毫秒门限 | ✅ | 130k 数组在整个文件内**共享单例**（`bigCaseIds` cache）；只有 R33-c2 构造 ~1M ids（实测 ≈0.12 s / 38 MB），且**不**构造 fingerprint 映射；无时间断言 |
| 运行 R28 及新增 R33 测试、R27 eligibility 测试、`pnpm typecheck` | ✅ | 见第 5 节 |

## 5. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/evaluation/src/e4-r33-execution-plan-scale.test.ts`（**修复后**） | **7/7 PASS**，exit 0，456 ms |
| 同上，**修复前**（源码临时回退 `git checkout HEAD --`） | **2 failed \| 5 passed**（R33-b、R33-c2 → `RangeError`） |
| `vitest run packages/evaluation` | **82 files / 1019 tests PASS**，exit 0（含 R27 eligibility、R28 fields、R22 plan 等全部回归） |
| `pnpm typecheck`（`tsc -b` 全仓） | **exit 0** |

注：计划复现片段（§4）用的是 `fixtureExecutionPlan` 默认 `limit: 100`，与 130000 case 自相矛盾 —— 修复后该片段返回
**结构化 issue（1 条 limit 矛盾）** 而非 `RangeError`；「合法容量」的验收用合同一致的 `limit=null` 计划（R33-b）证明。

## 6. 残余限制与诚实边界

- **上限未改动**：`EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000` 保持不变；本修复只让该上限**可达且可拒绝**，未把上限调到复现值以下逃避修复。
- **提前返回改变 issue 列表**：网格超限/不安全时现在**只**返回该结构化 issue（外加此前已收集的标量字段 issue），不再附带逐 case 的 fingerprint issue —— 这是「拒绝先于大规模工作」的直接结果，且所有既有断言用 `.some(...)` 匹配，未依赖 issue 顺序。
- **未声称拒绝服务已发生**：本任务只证明共享 parser 对合法输入抛异常/对超限输入给出结构化拒绝，未声称任何生产服务受影响。
- **digest 协议与输入顺序语义未变**：无排序/归一化，canonical digest 逐字节保持（R33-a 用三方比较固定）。
- **本轮改动未提交**：testedSourceSha 标记为 **dirty worktree on `bcf3f42c`**；远端 CI 核实按 R35 收口，不得用基线 `bcf3f42c` 的旧 CI 证明 R33 新代码。
