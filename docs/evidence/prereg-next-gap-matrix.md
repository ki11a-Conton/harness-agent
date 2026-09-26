# prereg 下一轮缺口矩阵（B0）

> 本文件是 `plan(20260926-070459).md` §B0 的交付物：把评审列出的 G1–G7 变成**可失败、
> 可单跑、离线**的反例，并如实记录当前 HEAD 的可观测行为、预期拒绝码、对应修复任务与
> 复现命令。B0 不修改生产实现；它校准证据。

## 0. 基线与证据范围（如实声明）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 评审基线 SHA（plan 指定） | `3ff894638f51081f30417327638a88efc54769c5` | plan §前言 |
| 本工作树 HEAD | `8247caa92508176c8e037be307a601ff4d858c26` | `git rev-parse HEAD`（本地实测） |
| HEAD 相对基线的差异 | 仅新增 `plan.md` / `plan(20260926-070459).md` 文档提交；**源码文件与 3ff8946 相同** | `git log --oneline`（本地实测） |
| `git status --porcelain`（B0 起始） | `?? packages/evaluation/src/prereg-next-gaps.test.ts` | 本地实测 |
| 基线 CI | GitHub Actions run `36217188308`（7/7 jobs 成功；Windows/Ubuntu closed-loop：`prereg-production-e2e: PASS`、`n5-prereg-closed-loop: PASS — 123/123`、`27/27 mutation(s) CAUGHT`） | plan §前言（**未在本环境重跑**） |
| 本环境实际执行 | 仅离线 `vitest`（RED 反例）+ `tsc -b`；**未**对真实付费端点发请求、**未**下载 CI artifact 逐字节复核 | 本地实测 |

**在无真实 key、无付费审批的前提下**：`paidExperimentRun = NOT_RUN`、`championPromotion = NOT_RUN`。

### 0.1 上一轮 A0–A7 已实现范围（不重做）

- `prereg build` 从冻结选择与真实 case 导出 31 个非 holdout 样本（`selectionFromFrozenEvidence`）。
- `validate`/`run` 使用**独立执行身份观察**（`observeExecutionIdentity` / `formalExecutionProfile`）。
- CLI 参数与授权 JSON 有严格入口（`CLI_USAGE` 拒绝矩阵）。
- 双平台 CI 覆盖发行版拒绝矩阵；离线正向执行记录 **124 次 arm run、316 次 fake provider 进入、124/124 份原始 evidence 复验**。
- 阶段报告如实记录 **失败 96 / 通过 28**、判定 **REJECT**。

### 0.2 本轮 RED 反例如何"单跑"而不弄红绿色回归

两个 RED 文件**故意在 HEAD 上失败**，因此从根 `vitest.config.ts` 的 `include` 中
**结构性排除**（见该文件 `exclude`），并只由专用配置收集：

```
npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts
```

单条反例：

```
npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts -t "<测试名>"
```

本地实测：该专用配置 **14 failed (14)**；默认 `vitest list` 中 `prereg-next-gaps` 计数为 **0**（绿色回归不收集）。

---

## 1. 缺口矩阵

| 编号 | 旧承诺（A 轮） | HEAD 源码证据 | 当前可观测行为 | 预期拒绝码 / hard gate | 对应任务 | 复现命令（在专用配置下追加 `-t`） | 反例状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **G1** | "两份不同 digest 的冻结构建分别运行" | [prereg-arm-executor.ts](file:///workspace/apps/cli/src/prereg-arm-executor.ts#L162-L216) 计算两份 checkout 摘要后用 `candidate` 参数调用本进程 `runOneCase`；[同文件 L38-L45](file:///workspace/apps/cli/src/prereg-arm-executor.ts#L38-L45) 自述未通过 arm 自身构建执行。[prereg-production-e2e.mjs L381-L387](file:///workspace/scripts/e4/prereg-production-e2e.mjs#L381-L387) 用 `export {}` 合成"构建" | 两个**摘要**不同，但**执行体**都是当前进程 harness；无任何子进程/worker seam | 应：非真实构建不得进入 production-ready 判据；两臂必须由各自构建执行 | B3、B5 | `-t "[G1/B3]"` | **RED** |
| **G2** | "所有维度硬约束，请求前预约" | [formal-run.ts L719-L743](file:///workspace/packages/evaluation/src/tool-call-efficiency-formal-run.ts#L719-L743) 首次只预约 token/USD/时长（`toolCalls: 0`）；[L795-L825](file:///workspace/packages/evaluation/src/tool-call-efficiency-formal-run.ts#L795-L825) 收到 `retry` 只加 call ledger，**不再预约 token/USD/时长** | 一次 `generate()` 内物理重试可复用同一次成本预约，绕过其它维度的请求前预算 | 第二次物理发送前必须 `BUDGET_EXHAUSTED`，物理发送数 = 1 | B2 | `-t "[G2/B2]"` | **RED** |
| **G3** | "settle 校验实测不超预约/上限" | [formal-run.ts L584-L609](file:///workspace/packages/evaluation/src/tool-call-efficiency-formal-run.ts#L584-L609) 直接 `charged += actual`，不校验 vs 持有预约/cap；找不到 `id` 时 `held = ZERO` 以零额度结算 | 未预约 ID 可"免费"结算；负数可退款；重复 settle 会二次入账 | 未预约 ID / 负数 / 重复 settle 必须拒绝 | B2 | `-t "[G3/B2]"` | **RED** |
| **G4** | "版本化 per-call USD 上限" | [prereg-execution-identity.ts L139-L169](file:///workspace/apps/cli/src/prereg-execution-identity.ts#L139-L169) 对所有 real provider/model 用同一个 `PREFLIGHT_ESTIMATE.costPerCallUsd`（`source` 自述为 "conservative per-call planning ceiling"） | 价格与 model / endpoint / 计费类别无关；未知代理端点与默认端点同价 | 版本化、可追溯、按 provider/model/端点/计费类别的上界 + 失效条件；未知 → `PRICING_UNKNOWN` | B2 | `-t "[G4/B2]"` | **RED** |
| **G5** | "独立重算资格/选择/文件边界" | [prereg-production-runner.ts L163-L228](file:///workspace/apps/cli/src/prereg-production-runner.ts#L163-L228) 只重算 case 内容；[formal-run.ts L303-L332](file:///workspace/packages/evaluation/src/tool-call-efficiency-formal-run.ts#L303-L332) 不复核 selectionRule/eligibility/provenance；[case-selection.ts L292-L313](file:///workspace/packages/evaluation/src/tool-call-efficiency-case-selection.ts#L292-L313) `statSync(...).isDirectory()` 跟随 symlink 遍历 | 观察结果只带 `caseContentDigests`；fixture 后代软链接可越界/成环 | 观察须独立派生 `selectionProvenanceDigest` / `eligibilityDigests`；越界/环路 fail closed | B1 | `-t "[G5/B1]"` | **RED** |
| **G6** | "证据验证可拒绝，写入原子" | [prereg-run-evidence.ts L132-L161](file:///workspace/packages/evaluation/src/prereg-run-evidence.ts#L132-L161) 对合法 JSON `null`：`JSON.parse` 返回 `null`，与"解析失败"哨兵不可区分 → 不报错；[tool-call-efficiency-paired-campaign.ts L220-L228](file:///workspace/packages/evaluation/src/tool-call-efficiency-paired-campaign.ts#L220-L228) 先 `rm(target)` 再 `rename` | 字节正确的 `null` manifest 被 `verified=true`；记录写入存在无文件崩溃窗口 | 非 plain object（含 `null`）立即 `verified=false`；先写 temp+sync 再覆盖式 rename | B4 | `-t "[G6/B4]"` | **RED** |
| **G7** | "productionOfflineReady=PASS" | [prereg-production-e2e.mjs L390-L489](file:///workspace/scripts/e4/prereg-production-e2e.mjs#L390-L489) 正向 run 为 in-process + 假 provider；真实 release 子进程只跑负向与 build/validate；[L517-L540](file:///workspace/scripts/e4/prereg-production-e2e.mjs#L517-L540) 构建 aggregate 时传入 `fake.entered()` 与初始 `campaignWorstCaseModelCalls` | 标题式 PASS 超出"发行版子进程完整正向执行并核真实账本"的证据 | 正向须走 release CLI 子进程；aggregate 须读 durable ledger；readiness 降为 PARTIAL/NOT_READY | B5、B6 | `-t "[G7/B5]"` / `-t "[G7/B6]"` | **RED** |

---

## 2. 反例 × 旧代码实测结果

以下均为本地离线实测（`vitest`，无网络、无 provider、无 key）。"旧代码结果"是 HEAD 上的
**失败输出**，即你要求"先记录旧代码的失败输出"。

| 测试名 | 旧代码结果（HEAD 实测） | 目标（GREEN 判据） |
| --- | --- | --- |
| `[G2/B2] a retry whose per-call token reservation cannot be afforded must NOT reach a second physical send` | `expected 2 to be 1`（物理发送发生了 2 次；无 `BUDGET_EXHAUSTED`） | 物理发送 = 1，且抛 `BUDGET_EXHAUSTED` |
| `[G3/B2] settling a reservation id that was never reserved must be refused, not charged as a free call` | 断言 `.rejects.toThrow()` 失败：未预约 ID 结算成功，`charged.inputTokens = 1000` | 抛错，`charged.inputTokens = 0` |
| `[G3/B2] a negative actual must be refused (it would silently refund the ledger)` | 断言 `.rejects.toThrow()` 失败：负数被接受 | 抛错 |
| `[G3/B2] settling the SAME reservation twice must not charge a second time` | 断言 `.rejects.toThrow()` 失败：第二次仍入账（`charged.inputTokens = 200`） | 第二次抛错，`charged.inputTokens = 100` |
| `[G6/B4] manifest.json = null with a byte-correct sha256 must verify=false` | `expected true to be false`（`verified === true`） | `verified === false`，`problems` 含 `manifest` |
| `[G5/B1] the run observation must re-derive selection provenance + eligibility, not only case content` | 观察键集不含 `selectionProvenanceDigest` / `eligibilityDigests` | 两键均存在 |
| `[G1/B3] the arm executor must launch the arm's own build as an isolated worker (stdio/IPC child)` | `prereg-arm-executor.ts` 无 `node:child_process` / `node:worker_threads` 导入 | 存在隔离 worker seam |
| `[G1/B3] the production E2E must not synthesize an arm build from export {} stubs` | 源中匹配到 `export {}; // arm:` | 该合成构建已从 production-ready 判据移除 |
| `[G4/B2] the pricing snapshot must be a versioned per-model/endpoint source with an invalidation window` | 快照键集缺 `invalidatedAtMs` / `requestBoundByModel`，且 `source` 含 "planning" | 键齐 + 来源可追溯 |
| `[G4/B2] the per-call USD ceiling must dominate the worst case implied by the per-call token ceilings` | 可计算反例：`boundUsd (0.0005) < worstCaseUsd`（按每 1M token 15 USD、64k tokens/次） | 上界 ≥ 最坏情形（或明确拒绝付费） |
| `[G4/B2] an unknown (proxy) endpoint must not be priced as if it were the default endpoint` | 两个不同 endpoint 得到**相同** `usdMicrosPerCall` | 未知代理端点 → `null`（`PRICING_UNKNOWN`） |
| `[G7/B5] the forward execution must record its transport so in-process ≠ release-subprocess` | 源中无 `transport: "release-cli..."` / `executionBackend: "release-cli..."` | 正向执行记录传输来源 |
| `[G7/B5] the aggregate must not be fed injected fake counts / the initial budget as the ledger` | 源中匹配到 `providerCalls: fake.entered()` 与 `budgetRemaining: artifact.budget.campaignWorstCaseModelCalls` | 不再注入，读 durable ledger |
| `[G7/B6] productionOfflineReady must not claim the full forward schedule is proven by the in-process fake` | 源中含 "executes the full paired schedule through the shipped observer+executor with a counting fake transport" | readiness 拆分为 PARTIAL/NOT_READY |

### 2.1 关于 G1 / G7 反例的性质（如实说明）

G1、G7 的"修复"是架构级变更（B3 隔离 worker、B5 发行版正向）。在 HEAD 上**不存在**任何
能让"arm 自身构建确实执行"或"release 子进程走完正向"可被行为观察的 seam，因此这两项采用
**结构契约断言**（读取出厂源码字节并断言 B3/B5 明确要求的结构存在/不存在），而不是伪造一个
不存在的行为观察点。这是 plan §B0 允许的"若某反例无法复现，附测试源码和替代结论"。
行为级复现待 B3/B5 引入 worker/子进程 seam 后，在同一 RED 文件内升级为真正的进程观察。

G2/G3/G4/G5/G6 均为**行为反例**：直接调用出厂 API，失败来自目标断言，非语法/超时/skip。

---

## 3. Readiness（四个维度分别报告）

| 维度 | 状态 | 实测范围 / 来源 |
| --- | --- | --- |
| `offlineFixtureReady` | **PASS** | `scripts/e4/n5-prereg-closed-loop.mjs`；123/123（基线 CI run `36217188308`） |
| `productionOfflineReady` | **PARTIAL / NOT_READY** | 已证明：发行版负向拒绝矩阵 + build/validate（0 provider）；**当前进程** adapter 的 124-arm fake 正向。**未证明**：发行版 CLI 子进程的完整正向双构建、不可核价的真实预算（G1/G4/G7 仍 RED）。 |
| `paidExperimentRun` | **NOT_RUN** | 无付费授权；本环境无 key；RED 测试不触网 |
| `championPromotion` | **NOT_RUN** | 独立后续审批，绝不从离线证据推断 |

> 结论：B0 交付后 `productionOfflineReady` **不得**继续显示为整体 PASS —— G1/G4/G5/G7
> 的 RED 反例直接证明"发行版完整正向 + 可核价预算"尚未达成。

---

## 4. 交接与重新审查触发条件

- 本矩阵编号 **G1–G7** 交由 **B1–B6**：B1←G5；B2←G2、G3、G4；B3←G1；B4←G6；B5←G1、G7；B6←G7。
- 任一 RED 转 GREEN 后，必须在**同一新 HEAD** 重跑：`pnpm typecheck`、`pnpm test`、专用 RED 配置，以及该 HEAD 的 Windows/Ubuntu CI。
- 重新审查触发：新 HEAD；模型/定价/构建/选择/策略任一变动。
- 本文件所有"实测"数字均可由上述命令在本工作树复现；不可观察项一律标 `NOT_OBSERVED`，绝不以 `0` 冒充。