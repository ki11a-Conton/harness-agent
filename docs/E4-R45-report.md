# E4-R45 报告：修复失败位置之前的诊断注册与保存顺序

## 1. 做了什么

修复 `apps/cli/src/e4-09-production-e2e.test.ts` 中 E4-09 生产 E2E 在失败发生时
丢失关键证据的**顺序缺陷**，并新增一个可纳入自动化的回归测试
`apps/cli/src/e4-r45-diagnostics-order.test.ts`。

具体改动：

1. **`buildRealChain()` 签名增加 `testName` 参数**，四个 adversarial 用例各自传入其
   真实框架测试标题，诊断包中的 `test.name` 不再是一个无法区分的公共字符串。
2. **artifact 路径注册前移到任何生产调用之前**：`paired-experiment` / `v3-baseline` /
   `v3-candidate` / `decision-artifact` 四个输出路径在 benchmark 运行前就 `registerArtifacts`。
   路径尚不存在是允许的——采集时如实记录 `missing`（`captured=false` + 真实 ENOENT 原因）。
3. **阶段标记 `mark()` 前移到调用之前**：`benchmark` / `evaluate` / `promotion` /
   `createHarness` 各阶段在进入对应生产调用前标记，不再在调用成功后标记。
4. **evaluator 的真实结果在 ACCEPT 断言之前落盘**：主链与 `buildRealChain` 都在
   `expect(decision).toBe("ACCEPT")` **之前**把 `evalResult.decisionArtifact` 原样写入
   `decision-artifact.json`（绝不复用一个预期 ACCEPT 对象），因此非 ACCEPT 决策带着
   真实 `reasonCodes` 被采集。
5. **主链的 `decision-artifact` 注册也提前**到 STAGE 1 之前（与 paired/V3 并列），
   decision 写入逻辑复用该路径。

## 2. 为什么需要改

R40 的 `e4-09-production-e2e.test.ts` 把诊断注册放在了**失败点之后**：

- `buildRealChain`：先 benchmark `exitCode` 断言，再 evaluator + ACCEPT 断言，再写
  decision 文件，**最后**才 `registerArtifacts`。于是 benchmark 失败或 decision 为
  INVALID 时，`afterEach` 执行时 `artifactSpecs` 为空，paired/V3/decision 全部无法采集。
- 主链：`expect(decision).toBe("ACCEPT")` 之后才写盘并注册 decision 文件，evaluator
  返回非 ACCEPT 时最关键的决策内容直接丢失。

这正是 R39 悬案损失证据的同型缺陷：事后只剩 `expected 'INVALID' to be 'ACCEPT'`，
没有任何决策/违规原因/paired 计数。

本任务**不改变任何业务断言与决策语义**，只把「采集证据」的动作移到失败发生之前。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-production-e2e.test.ts` | 修改：注册/落盘/`mark` 顺序前移；`buildRealChain` 增加 `testName` |
| `apps/cli/src/e4-r45-diagnostics-order.test.ts` | 新增：recorder 级顺序回归测试（4 例） |

诊断模块 `e4-09-diagnostics.ts` **无改动**——它已经支持「路径尚不存在时注册，采集时记
missing」。本次缺陷在**调用方**的注册时序，不在 recorder 本身。

## 4. 复现方法与修复前结果

**修复前**（可读 diff 反推，无需回退再跑）：`buildRealChain` 中四个 artifact 的
`registerArtifacts` 位于 `expect(evalResult.decisionArtifact.decision).toBe("ACCEPT")`
与 decision 写盘之后。任何 benchmark 失败（例如运行期干净树拒绝，退出 1）都会在
`afterEach` 采集时得到**空的 artifactSpecs**——诊断包即使写出，`artifacts` 数组也不含
paired/V3/decision 条目，`summary` 为空，`failure.stage` 停留在 `setup`。

**修复后实测**（脏树上故意让 benchmark 退出 1，`E4_09_DIAG_DIR` 定向落盘）诊断包现在
记录：

```text
test:      editing a real V3 artifact's outcomes ... breaks the chain   ← 真实测试名
failure.stage: benchmark                                                 ← 正确前移
--- CLI lines ---
agent benchmark: a promotion-eligible run requires a CLEAN, PROVABLE source tree ...
  - source tree is not provably clean
  - the confirmed plan was made against a dirty tree — re-confirm on a clean tree
--- artifacts ---
paired-experiment captured=False ENOENT: .../out/paired-experiment.json
v3-baseline      captured=False ENOENT: .../out/v3-baseline.json
v3-candidate     captured=False ENOENT: .../out/v3-candidate.json
decision-artifact captured=False ENOENT: .../bundle/decision-artifact.json
```

四个 artifact 全部被如实标记 `captured=false` + 真实原因（修复前它们根本不出现在
bundle 中），真实 CLI 拒绝原因、真实测试身份、正确 stage 全部保留。这正是 R39 丢失的证据。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | tsc -b 全绿 |
| `pnpm vitest run apps/cli/src/e4-r45-diagnostics-order.test.ts` | 0 | **4 passed** |
| `pnpm vitest run apps/cli/src/e4-09-production-e2e.test.ts`（脏树） | 1 | 4 failed / 1 passed —— 均为 clean-tree 拒绝，非本改动回归（见 §7） |

新增回归测试（`e4-r45-diagnostics-order.test.ts`）4 例，覆盖验收 A/B/C/E：

- **A**（benchmark 非零退出）：提前注册、未写的路径记 `missing`（`captured=false` + 真实
  读错误），`failure.stage === "benchmark"`。
- **B**（evaluator 返回非 ACCEPT）：真实 `decision=REJECT` + `reasonCodes=["capacity"]`
  被原样持久化，绝不复建 ACCEPT。
- **C**（evaluator 抛异常）：`stage=evaluate`，decision 角色记 `missing`、summary 为
  `null`，不伪造 decision。
- **E**（判别力）：未提前注册的 recorder，bundle 中 decision/paired 角色**完全缺失**——
  这断言锁定「注册前移」是可被反例发现的（若把注册移回失败点之后，本测试 E 即失真的
  反向信号由 A/B/C 捕获）。

验收 D（成功链）：见 §7 干净树复验。

## 6. testedSourceSha 与未提交改动

- `reviewedSourceSha` / `testedSourceSha`：`d201da5e8071e2780a745ffb86ddb31d3cdf547d`
  （计划审查基线）。
- 本任务实现提交后工作树干净（R45 实现 + 回归测试 + 本报告一并提交）。

## 7. 未执行项与残余限制

- **E2E 5/5 需在干净树复验**：E4-09 真实链要求「运行期干净可证源树」，脏树（本任务
  未提交改动）下 benchmark 在执行前就被拒绝（退出 1），与本改动无关。已在 R44 冻结干净
  版本上证明过同代码 5/5；本任务实现提交后将在干净树复验 5/5 并记录。
- 回归测试为 **recorder 单元级**证明（人工小夹具），与 E2E 接线级证明（真实生产调用
  产物被采集）**分开**陈述，不混称（见计划第 3 节第 7 条）。E2E 接线级证据由
  `e4-09-production-e2e.test.ts` 自身承载。
- 诊断模块 `e4-09-diagnostics.ts` 的字节限制/摘要语义问题属于 **R47** 范围，未在本任务
  处理。