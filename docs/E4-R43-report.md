# E4-R43 Report — 用独立固定输入锁住公开容量上限（K04）

- reviewedSourceSha（本计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- 被测工作树：本报告所属的 **R43 实现提交**（`E4-R43: …`）。
- 状态：**RESOLVED（K04，补足测试判别力）**——公开合同（1,000,000 planned samples）由
  **不依赖实现常量的固定输入**锁定，并通过**真实加载的临时副本 mutation** 证明其判别力。
- 生产代码改动：**无**（`EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 保持 `1_000_000`，容量合同未变）。
- 真实模型调用：**0**；平台：Windows（win32）

---

## 1. 根因（K04）

R38-b 的输入与预期**都**由 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 派生：

```
repeat = EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5
expectedProduct = (EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5) * caseCount
```

令常量为 C、`caseCount = 3`：输入规模是 `3 × (C + 5)`。把 C 改大，**输入同幅变大**，依旧超限 ——
所以「调大实现常量后 R38-b 仍通过」**不能**证明合同被锁定。这是**输入随实现变化**的自然结果，
**不**需要用「可能超过安全整数」之类的解释。

R38-b 本身是**有价值的机制检查**（O(1) 前置守卫、展开前拒绝、文案校准、不泄漏 RangeError），
**保留不动**；缺的是**独立的固定合同**判别力。

---

## 2. 做了什么

新增 `packages/evaluation/src/e4-r43-execution-plan-capacity.test.ts`（3 例）：

1. **固定合同**：单 case、`limit: null`、`repeat = 999999 / 1000000 / 1000001`
   （**字面量**，与被测常量无关）→ 期望 接受 / 接受 / 拒绝；拒绝必须携带**容量 issue**。
   并对「实现常量 == 合同的字面量 `1_000_000`」做一次显式断言（记录联动）。
2. **MUTATION（放宽）**：把 `execution-plan.ts` 的常量改成 `2_000_000` 的**临时副本真实加载**后，
   固定输入 `repeat = 1000001` **变为接受** ⇒ 第 1 项的「拒绝」断言在放宽后**必然失败**；
   同时 `repeat = 2000001` 仍被拒绝（守卫依然真实，不是把守卫删掉了）。
3. **MUTATION（收紧）**：常量改成 `999_999` 的副本加载后，固定输入 `repeat = 1000000`
   **变为拒绝**（带容量 issue）⇒ 第 1 项的「接受」断言在收紧后**必然失败**；
   同时 `repeat = 999999` 仍被接受。

实现要点（保证"真实加载"且**不动主工作树**）：

- 副本 = `os.tmpdir()` 下的临时目录，内含**真实 `execution-plan.ts` 源码**（仅把常量一键替换）
  + 一行 `manifest.js`（`export * from "<repo>/packages/evaluation/src/manifest.ts"`），
  使副本加载**真实的依赖实现**（不是 stub）。
  `execution-plan.ts` 只有这一个 sibling 依赖（`./manifest.js`）。
- 断言副本模块的 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 等于注入值，证明**确实加载了副本源码**。
- `afterEach` 销毁副本；`git status` 全程不受影响（副本在仓库之外）。
- **不**展开百万样本网格：只调用 parser 的 O(1) 边界校验（`parseExecutionPlan`）。

---

## 3. 验收矩阵

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| 固定合同的 max−1/max/max+1 = 接受/接受/拒绝，max+1 给出容量 issue | ✅ | 用例 1：`999999`/`1000000` → `issues == []`、`plan != null`；`1000001` → `plan == null`、cap issue 恰 1 条（含 `repeat(1000001)`/`caseCount(1)`/`1000001`/`refuse before expansion`） |
| 放宽生产常量被固定输入捕获 | ✅ | 用例 2：副本常量=2,000,000 ⇒ `1000001` 接受（cap issue 0 条）⇒ 固定拒绝断言必失败 |
| 收紧生产常量被固定输入捕获 | ✅ | 用例 3：副本常量=999,999 ⇒ `1000000` 拒绝（cap issue 1 条）⇒ 固定接受断言必失败 |
| 不产生巨型 grid | ✅ | 只用 parser 的 O(1) 校验；无百万 outcomes/grid 生成（用例耗时 ms 级，见 §4） |
| 原有效 130000 case、真实 ACCEPT/loader.ok、相对超限测试继续通过 | ✅ | R22/R28/R33/R38/R43 合并 **5 files / 34 tests passed** |
| 不修改正式容量上限 | ✅ | 生产侧**零改动**（常量仍 `1_000_000`） |
| 不新增机器敏感毫秒门限 | ✅ | 断言全部是结构/数值，无时间阈值 |
| 不把测试改动包装成生产漏洞修复 | ✅ | 本项定位为**测试判别力补足**；报告与提交信息均如此表述 |
| `pnpm typecheck` 与相关 evaluation 测试通过 | ✅ | typecheck 退出 0；见 §4 |

---

## 4. 实测命令、退出码与数量

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（`tsc -b`） | **exit 0** |
| `vitest run packages/evaluation/src/e4-r43-execution-plan-capacity.test.ts` | **1 file / 3 tests passed**（`3 passed`） |
| `vitest run e4-r22,e4-r28,e4-r33,e4-r38,e4-r43` | **5 files / 34 tests passed** |
| 真实模型调用 | **0** |

（全量 `pnpm test` / `docs:verify` 属 R44 的静止工作区最终门禁范围。）

---

## 5. 一页结论

1. **合同已锁定**：公开的 1,000,000 planned samples 现在有**固定字面量输入**的
   接受/接受/拒绝边界，**不随实现常量漂移**。
2. **判别力已证**：把常量放宽到 2,000,000 或收紧到 999,999 后，**真实加载**的副本会让固定输入
   分别失败——固定输入确实锚定该常量，而不是"跟着实现一起动"。
3. **无副作用**：生产容量上限与合同**未改**；未展开巨型网格；未引入时间门限；
   既有相对超限机制检查与有效正例（130000 case、真实 ACCEPT/loader.ok）全部保持通过。
4. **历史报告已修正**：`docs/E4-R38-report.md` §6.1 明确「R38-b 的断言随常量变化而精确」是机制
   正确性，**不等于**合同锁定；其缺口由本项补齐。

---

## 6. 残余限制

- 本项只覆盖 **`repeat × caseCount` 乘积合同**与单一 case 的边界；`caseCount` 维度的组合边界由
  R33-c2 覆盖，本轮未穷举（有意）。
- 固定输入锚定 `1_000_000` 这一**公开数字**；若产品决定改变合同，需**同时**更新固定输入与
  合同文档（这正是"锁定"应有的语义：改合同必须有显式动作），本轮未改。
- mutation 只针对**常量声明行**（注入 2,000,000 / 999,999）；未对 parser 的守卫逻辑做变异
  （那属于另一个缺陷类，非 K04 范围）。
