# E4-R38 Report — 执行计划边界的有效正例与 promotion-loader 验收（J03）

- reviewedSourceSha（本计划基线）：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- testedSourceSha：**dirty worktree on `a7950fa1`**（本轮 R36+R37+R38 改动未提交；被测即工作树源码）
- 状态：**PASS（验收补强；无生产代码修复）**
- 真实模型调用：0（离线 fixture，无 provider 调用，不执行真实晋升）
- 生产代码改动：**无**。本轮未预设 parser 有新缺陷，复查结果也没有发现——R33 的容量实现被本轮独立验证为正确，因此**不重新实现、不调整容量上限**。
- 变更文件：
  - `packages/evaluation/src/e4-r38-execution-plan-boundary.test.ts`（新建，**3** 例）
  - `packages/evaluation/src/e4-r33-execution-plan-scale.test.ts`（修正 R33-f 的测试设计，仍为 **7** 例）

## 1. 问题：J03 是**验收缺口**，不是生产漏洞

R33 交付的 R33-f 有两个设计缺陷，使它无法证明它声称证明的事：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | manifest 记录 `planDigest: "0".repeat(64)`（占位） | 正例永远走不到真实绑定：一个占位 digest 会让 `manifest.planDigest != recomputed` 生效，使「拒绝」可能来自 digest 而非容量 |
| 2 | 所谓「正对照」只断言「**没有** planned-sample cap issue」 | 「没有某一种错误」≠「通过」。它没有断言 ACCEPT，也**完全没有**覆盖 promotion loader |

因此当时的证据只到「parser 拒绝超限 + evaluator 出现 cap 违规」，**缺少**：
有效正例在同一真实链路上的成功、以及 promotion-loader 边界的容量拒绝证据。

**本轮证据分级**（不把验收缺口包装成未复现的生产漏洞）：

| 维度 | 本轮之前 | 本轮之后 |
|---|---|---|
| parser 大数组/容量前置 | ✅ 已由 R33-a…e 直接证据覆盖 | 保持（R38-c 复验） |
| evaluator 容量负例 | ✅ 已由 R33-f 覆盖 | 保持并强化（正例变真实） |
| **有效正例（真实 digest → 真实 ACCEPT）** | ❌ 仅「无 cap issue」 | ✅ R38-a + R33-f 强化 |
| **promotion-loader 容量边界** | ❌ 完全缺失 | ✅ R38-b |

## 2. 做法

### 2.1 新建 `e4-r38-execution-plan-boundary.test.ts`

单一 harness `driveRealChain(dir, plan)` 用**真实生产入口**跑一对完整 artifact：
`buildExperimentArtifactV3` → `runV3ChampionEval` → `buildPromotionEnvelope` → `loadPromotionEnvelope`。

完整绑定的事实：`planDigest = computeExecutionPlanDigest(plan)`（**真实**）、`promotionEligible=true`、
`isolationStrength=strong`、`sourceSha=gitSha`、`treeFingerprint=null`、`provider/model` = provenance、
`expectedSampleKeys` = 真实 6 样本网格、`thresholdDigest` = 应用的默认策略摘要、
activation/security evidence 齐全、decision artifact 与其 digest 一致。

| 用例 | 内容 |
|---|---|
| **R38-a** | 完整基准对 → `pairingViolations === []`（**空**，不是「没有某一项」）、`decision === "ACCEPT"`、`loader.ok === true`、`loader.issues === []` |
| **R38-b** | 从**同一个**有效基准出发**只改容量因子** `repeat = 1000000 + 5`（digest 按修改后的计划重算，且断言新旧 digest 不同）→ evaluator 与 loader **都**只因容量拒绝 |
| **R38-c** | `limit=null` 的 130,000 case 仍解析成功；小计划 digest 协议不变 |

### 2.2 修正 R33-f

```diff
-          planDigest: "0".repeat(64),
+          planDigest: computeExecutionPlanDigest(plan as never),
…
-    const okPlan = fixtureExecutionPlan({ suite: "holdout", caseIds: CASES, repeat: 2 });
+    const okPlan = fixtureExecutionPlan({ suite: "holdout", caseIds: CASES, repeat: 2, modelId: "deepseek-v4-flash" });
…
-    expect(okViolations.some((v) => v.includes("planned-sample cap"))).toBe(false);
+    expect(okViolations.some((v) => v.includes("planned-sample cap"))).toBe(false);
+    expect(okViolations).toEqual([]);
+    expect(okRes.envelope.decision).toBe("ACCEPT");
```

（`modelId` 必须补上：provenance.model 是 `deepseek-v4-flash`，而 fixture 默认 `modelId="m"`——不改就会因 **provenance 绑定**失败，正例仍然证不了东西。）

## 3. 实测输出（校准后的拒绝条件）

R38-b 的 evaluator 违规——**恰好 1 条**：

```text
executionPlan grid size repeat(1000005) × caseCount(3) = 3000015 > the documented 1000000 planned-sample cap (refuse before expansion)
```

R38-b 的 loader 问题——**恰好 2 条**，且都由这一次容量拒绝解释：

```json
[
  { "code": "CANDIDATE_NOT_ELIGIBLE",
    "detail": "candidate executionPlan fails the confirmed-plan protocol (E4-R22): executionPlan grid size repeat(1000005) × caseCount(3) = 3000015 > the documented 1000000 planned-sample cap (refuse before expansion)" },
  { "code": "DECISION_ARTIFACT_INVALID",
    "detail": "decision artifact decision=\"INVALID\" is not ACCEPT" }
]
```

### 3.1 关于「计划规模与已存在 outcomes 的数量自然相关」

超限计划的派生网格是 3,000,015 个 key，而 artifact 里只有真实的 6 条 outcome/manifest 网格。
本轮**刻意不生成百万级 outcomes**：容量门禁必须在展开完整结果网格**之前**拒绝。因此必须明确说明
**`manifest.expectedSampleKeys` 对超限计划不可能成立**，且这不是本项的拒绝原因：

- `parseExecutionPlan` 先返回 `plan: null` → evaluator/loader 都**跳过** cross-bind，网格比较根本不执行；
- 证据：evaluator 违规 `toHaveLength(1)`，且**不含**任何 `expectedSampleKeys` 文本；
- 也就是说，若把门禁搬到展开之后，本用例的「恰好 1 条」断言会立刻失败——这正是它要保持的判据。

**不声称**超限计划的关联字段仍是完整执行结果。

## 4. 验收对照

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| 正常 3 case × 2 repeat 完整基准：真实 evaluator 达到预期 ACCEPT、真实 loader 成功、无无关 pairing/identity 违规 | ✅ | **R38-a**：`violations===[]`、`decision==="ACCEPT"`、`loader.ok===true`、`loader.issues===[]`；独立佐证 **E4-R27** `POSITIVE: strong + clean + complete + candidated pair still ACCEPTs and promotes`（本轮实测 18/18 通过） |
| 超限负例：两个边界均有**目标容量校验**的直接证据，不泄漏 RangeError，不靠无关错误提前失败 | ✅ | **R38-b**：evaluator `INVALID` + 1 条含 `repeat(1000005)`/`caseCount(3)`/`3000015`/`refuse before expansion` 的 cap 违规；loader `ok=false` + `CANDIDATE_NOT_ELIGIBLE`（cap detail）+ `DECISION_ARTIFACT_INVALID`；断言 `planDigest`/`expectedSampleKeys`/`ELIGIBILITY_`/`candidate*` 文本**均不出现** |
| `limit=null` 的 130000 case 解析仍成功；小计划 digest 协议保持不变 | ✅ | **R38-c**：`parsed.issues===[]`、网格长度 130000、`computeExecutionPlanDigest(plan) === fixtureExecutionPlanDigest(PLAN_ARGS)` |
| R27/R28/R33 原有测试不回退 | ✅ | 见第 5 节：R27 18 / R28 14 / R33 7 / R38 3 = **42 passed**；`packages/evaluation` 全包 **83 files / 1022 passed** |
| 测试使用离线 fixture，无真实模型调用、不执行真实 champion 晋升 | ✅ | 仅内存 artifact + 临时目录；`loadPromotionEnvelope` 只读校验，不落任何晋升状态 |
| 运行 R27/R28/R33 及新增边界测试、`pnpm typecheck`，记录真实退出码与数量 | ✅ | 见第 5 节 |

## 5. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/evaluation/src/e4-r38-execution-plan-boundary.test.ts` | **3/3 PASS**，exit 0 |
| 同上（**容量消息文本被改动**的探针） | **1 failed** → 恢复后 3/3 PASS（判别性：确实锚定容量条件与其校准文案） |
| 同上（**把 `planDigest` 换成 `"0".repeat(64)` 占位**的探针） | **R38-a failed** → 恢复后全绿（正例确实要求完整绑定） |
| `vitest run packages/evaluation/src/e4-r33-execution-plan-scale.test.ts` | **7/7 PASS**，exit 0 |
| 同上（占位 digest 探针） | **R33-f failed** → 恢复后全绿（**修复前它在占位 digest 下是 PASS 的**——这正是 J03） |
| R27 + R28 + R33 + R38 四个文件 | **4 files / 42 tests PASS**（18 + 14 + 7 + 3），exit 0 |
| `vitest run packages/evaluation`（整包） | **83 files / 1022 tests PASS**，exit 0 |
| `pnpm typecheck`（`tsc -b` 全仓） | **exit 0** |

## 6. 残余限制与诚实边界

- **未做生产修复，因为没有发现生产缺陷**：R33 的容量门禁（O(1)、位于任何逐 case 遍历之前）在本轮独立复验中表现正确；`EXECUTION_PLAN_MAX_PLANNED_SAMPLES = 1_000_000` 未调整。
- **超限负例的容量因子只用 `repeat`**（caseCount 因子由 R33-c2 覆盖）：R38-b 的目标是「同一有效基准只改一个因素」的判别力，而不是穷举边界。
- **3,000,015 这一具体数字来自 `repeat=1,000,005 × caseCount=3`**：断言用的是由常量与 caseIds 计算出的值，不是硬编码字符串，因此常量或用例规模变化时仍然精确。
- **本项是验收补强**：R38 与「生产缺陷关闭」分开记；报告中不把 R33 的 parser 结论当作本轮新发现。
- **loader 的第二条问题（`DECISION_ARTIFACT_INVALID`）是因果链的一部分**，不是无关噪声：容量拒绝 → `INVALID` → loader 拒绝非 ACCEPT 决策。断言以「恰好这两条且顺序固定」表达，任何第三条无关原因都会失败。

### 6.1 补充说明（E4-R43 / K04，2026-09-13）

上一条「断言用的是由常量与 caseIds 计算出的值，不是硬编码字符串，因此常量或用例规模变化时仍然精确」
描述的是 R38-b 的**机制正确性**（拒绝文案与实际数字一致），但它同时说明了一个**判别力缺口**：

- R38-b 的输入与预期**都**由 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 派生
  （`repeat = CAP + 5`、期望乘积 `= (CAP + 5) × caseCount`）。把生产常量改大，**输入也一起变大**，
  所以该用例仍然通过——它**锁不住**公开的 1,000,000 合同。
- 因此「调大实现常量后 R38-b 仍通过」**不能**解读为「合同已锁定」，也**不需要**用「可能超过安全整数」
  之类的解释；它是输入随实现变化的自然结果。
- **R38-b 保留**（它是对的机制检查：O(1)、展开前拒绝、文案校准、不泄漏 RangeError）。
  缺失的**固定合同**判别力由 **E4-R43** 补齐：
  `packages/evaluation/src/e4-r43-execution-plan-capacity.test.ts` 用**字面量**输入
  `repeat = 999999 / 1000000 / 1000001`（单 case、`limit: null`）断言 接受/接受/拒绝，
  并用**临时副本**把常量 mutation 成 `2_000_000` / `999_999` **真实加载**后证明该固定输入会失败。
  详见 `docs/E4-R43-report.md`。
- **本轮改动未提交**：testedSourceSha = **dirty worktree on `a7950fa1`**；远端 CI 按 R39 收口处理。
