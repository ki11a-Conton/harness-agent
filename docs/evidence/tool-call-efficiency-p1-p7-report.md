# tool_call_efficiency_v1 — 预注册可执行闭环阶段报告（N0–N7 + S0–S7 + A0–A7 + B0–B6）

> 本文件是 **N0–N7 / S0–S7 / A0–A7 / B0–B6** 各阶段的任务报告。它记录**已执行并验证**的事实，
> 不把计划项写成已完成。
> 状态规则：P5 只有在 N1–N5 可执行闭环落地并经 CI 验证后才可写 PASS；N7 / S7 / B7 在用户另行明确付费
> 授权前一律 **BLOCKED / PAID_NOT_RUN**。runtime ready 与 champion promotion 分开陈述。
> 最新一轮为 **§B（B0–B6）**：它把 `productionOfflineReady` 拆成三个可分别断言的子项（见 §B.2），
> 并给出正式比较的观测规范（§B.4）与待审批模板（§B.5）。

- 阶段起点（固定审查 HEAD）：`1964c66bd3438846e7ef3b8ce76533ed29f3b450`
- 上一轮审查基线：`6d027c8936bccefa6ecb47d1ebfa56a56c89efe3`
- 外部付费模型调用：N0–N6 = **0**；S0–S6 = **0**；N7 / S7 = **PAID_NOT_RUN**。
- 模型效果 / champion promotion：**UNKNOWN / NOT_RUN**（离线正确性证据不等于模型效果证据）。
- N0–N6 结论：**PASS**（N5 可执行闭环已由两平台 CI 验证，见 §N6）；N7：**BLOCKED / PAID_NOT_RUN**。
- S0–S6 结论：**PASS**（离线，见 §S）；远端 CI 对 `801774d`（含实现 `7fb389e`）run `36130057745`
  **七 job 全 success**（含两平台 closed-loop）；S7：**BLOCKED / PAID_NOT_RUN**。

---

## N0 — 固定新基线并建立回归保护

结论：**PASS**（基线固定、P1–P4 未回归；P5 缺口经代码事实确认）
起始 SHA：`1964c66bd3438846e7ef3b8ce76533ed29f3b450`（工作树干净，分支 `main`）

### 0.1 基线

| 项 | 值 |
| --- | --- |
| 实际 HEAD | `1964c66bd3438846e7ef3b8ce76533ed29f3b450` |
| 分支 / 工作树 | `main` / 干净（`git status --short` 空） |
| 与审查基线差异 | `git log --oneline 6d027c8..1964c66`：4 个提交 |

4 个新增提交（6d027c8..1964c66）：

| SHA | 说明 |
| --- | --- |
| `e4b3b7c` | P1–P4：生产安装 / request-boundary 激活 / manifest system-prompt identity / guidance v2 |
| `30d56f7` | P5：preregistration builder + test + export |
| `138dbdd` | 报告收口（P5/P6） |
| `1964c66` | 报告记录 P6 双平台 CI 证据 |

### 0.2 P5 真实缺口（代码事实，不是推断）

对 `buildToolCallEfficiencyPreregistration` / `preregistrationDigest` / `preflightPaid` / `Preregistration`
做全仓搜索（排除 `*.test.ts`），非测试生产引用只有：

| 文件 | 类型 | 是否在 provider 前验证 |
| --- | --- | --- |
| `packages/evaluation/src/tool-call-efficiency-preregistration.ts` | 模块自身 | — |
| `packages/evaluation/src/index.ts` | 仅 re-export（`export * from "./tool-call-efficiency-preregistration.js"`） | 否 |
| `docs/E4-R99-R101-report.md` | 文档 | 否 |

**结论：没有任何正式入口（CLI / driver / worker）在 provider 构造前读取、重算或要求 approval 绑定该 digest。**
当前基线的正确答案是“**没有** consumer”。P5 只是 builder/test/export，**不得**写成已完成闭环。

### 0.3 回归矩阵（保护 P1–P4 与 baseline 非污染）

| 不变量 | 保护测试（文件） | 本轮观测 |
| --- | --- | --- |
| 生产 champion 安装**同一份**权威 guidance，且绑定模型可见 bytes | `apps/cli/src/champion-application-p1.test.ts`（4 例） | PASS |
| 与旧 budget-aware guidance **互斥**（不可并装） | 同上（`refuses the mutually-exclusive pair`） | PASS |
| 真实 request boundary 观察 guidance block（非标签） | `apps/cli/src/benchmark-command.test.ts`（N5 case） | PASS |
| activation evidence v2：prompt-guidance 必须携带 `guidanceVersion` 且 digest == 已批准 arm 摘要 | `packages/evaluation/src/activation-evidence-v2.ts` + `activation-evidence-execution.test.ts` | PASS |
| manifest / run identity 覆盖真实 system prompt | `packages/evaluation/src/manifest.test.ts`（31 例） | PASS |
| guidance v2 语义（model iteration ≠ tool calls；重试规则收窄） | `packages/evaluation/src/tool-call-efficiency.test.ts`（7 例） | PASS |
| baseline 无 candidate contamination | 上述 `tool-call-efficiency.test.ts` + `benchmark-command.test.ts` | PASS |
| activation evidence 基础契约 | `packages/evaluation/src/activation-evidence.test.ts`（13 例） | PASS |

本轮未新增测试：现有命名已足够清楚，且 P1–P4 保护已可机检；按 N0 要求“不为整理改生产代码”，保持零代码改动。

### 0.4 验收命令（实际运行）

| 命令 | 退出码 | 观测 |
| --- | --- | --- |
| `git status --short` | 0 | 空（检查前后一致，未覆盖用户改动） |
| `pnpm typecheck` | 0 | `tsc -b` 全仓通过 |
| `pnpm exec vitest run apps/cli/src/champion-application-p1.test.ts apps/cli/src/benchmark-command.test.ts packages/evaluation/src/tool-call-efficiency.test.ts packages/evaluation/src/activation-evidence.test.ts packages/evaluation/src/manifest.test.ts` | 0 | **5 files / 152 passed / 0 failed** |

### 0.5 零调用证明

- 上述测试均使用 `ScriptedModelProvider` / 纯函数，未构造真实 provider，未读取 API key，未产生网络请求。
- 外部 provider 调用：**0**；费用：**0**。

### 0.6 剩余风险 / 下一任务

- P5 仍无正式 consumer（F1），digest 覆盖不足（F4），repetitions 允许 1（F2），预算为自报估计（F3），
  eligible 集合自报（F5），AB/BA balance 非硬条件（F6），contract 与 decision policy 未统一冻结（F7）。
  以上由 N1–N4 关闭。
- **N1 是否解锁：是。**

---

## 阶段提交（1964c66..HEAD）

| SHA | 任务 | 说明 |
| --- | --- | --- |
| `99f3d55` | N0 | docs(evidence)：固定 N0 基线并记录 P1–P4 回归保护 |
| `04e6c92` | N1 | fix(evaluation)：canonical preregistration v2 身份完整化 |
| `af79700` | N2 + N3 | feat(evaluation)：正式 paired run 以 v2 预注册为门禁（含 authorization + 原子 ledger 预算） |
| `e434637` | N4 | fix(evaluation)：统一 eligibility 与 champion decision 契约 |
| `711e932` | N5-A/B/C | feat：paired-campaign 驱动 + CLI `prereg build/validate/run` + 离线 E2E |
| `f5d5045` | N5-D/E + N6 | tamper matrix 扩展、18 项 mutation gate、双平台 CI 证据脚本与文档 |

---

## N1 — canonical preregistration v2（完整冻结实验身份）

结论：**PASS**
提交：`04e6c92`
改动：`packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts`（production）+ 同名测试。

- schema 升级为 `tool-call-efficiency-preregistration-v2`（未原地改变 v1 语义）。
- 冻结身份：subject source/arms/clean-tree/runtime-config、guidance + mechanism-contract digest、
  provider/model/normalized-endpoint/request-profile digest、suite + selection provenance + 每 case
  content/eligibility digest、judge/verifier/scorer + 完整 decision policy digest、schedule（repetitions/
  order/plan/logicalRuns/AB-BA）、真实 per-run 模型调用上限与 campaign worst case、isolation/executor schema。
- 单一 canonicalization（`stableStringify`）+ 单一 loader `parseAndValidatePreregistrationV2`；
  **derived 字段由 loader 重算并比对**（`DERIVED_TAMPERED`）。
- fail-closed：schema/类型/非法数/重复或未知 key/holdout/duplicate/unknown case 全部拒绝；
  `repetitions >= 2`；AB/BA 不平衡抛错。
- endpoint 仅以规范化 digest 入 identity，key 永不进入 artifact 或日志。
- v1 仍可读取但 **不能** 通过 `assertFormalExecutionPreregistration` 授权正式执行（`WRONG_SCHEMA`）。

验收：`packages/evaluation/src/tool-call-efficiency-preregistration-v2.test.ts` — **49 passed**。

---

## N2 — 正式 CLI/driver 执行边界强制消费预注册

结论：**PASS**
提交：`af79700`
改动：`packages/evaluation/src/tool-call-efficiency-formal-run.ts`（production）+ 测试；`apps/cli/src/prereg-command.ts`、`apps/cli/src/commands.ts`（N5 中接入）。

- 正式入口 `agent prereg run` 的 `openPreregisteredCampaignGate` 顺序为：实验语义 override 拒绝 →
  strict schema/canonical digest 验证 → 在当前 subject 上**重算身份**并比对（source/arms/guidance/
  contract/runtime/provider/model/endpoint/request-profile/每 case content/policy）→ 独立 authorization
  digest+caps → 同 digest resume state → 原子 ledger → **最后**才构造 provider。
- 每个 pre-provider 失败路径均要求 `providerFactoryCalls = 0`（比 `providerCalls = 0` 更强）。
- resume 记录必须携带同一 `preregistrationDigest` / `planDigest` / arm 身份，否则拒绝入账。

验收：`packages/evaluation/src/tool-call-efficiency-formal-run.test.ts` — **36 passed**；
`apps/cli/src/prereg-command.test.ts` 中全部 pre-provider 反例断言 factory = 0。

---

## N3 — 真实调用上界 + 原子 ledger + 独立 authorization

结论：**PASS**（离线强制；无付费调用）
提交：`af79700`（与 N2 同一提交；预算/授权在 formal-run 边界实现）

- 删除 v1 `callsPerArmRun ?? 1` 对正式运行的影响：campaign worst case 由
  `maxModelCallsPerRun × logicalRuns` 计算。当前冻结 fixture（8 cases × 2 repetitions × 2 arms × 30）=
  **32 logical runs / worst-case 960 model calls**（见本文件 N6 evidence 的 `identity` 字段，digest 可复算）。
- authorization 是**独立只读** artifact：绑定 exact preregistration digest、subject/arm digest、
  provider/model/endpoint digest、calls/tokens/USD caps、issued/expires、paid flag；代码从不替用户生成授权。
- 复用 R97 原子 budget ledger：调用前 reserve、返回后 settle；cap 触发即停发新请求并使结果不可 ACCEPT。
- 反例覆盖：预算比 worst case 少 1、token cap 收窄、auth digest 不同、缺 paid flag、过期 —— 全部在
  provider factory 之前拒绝。

---

## N4 — 统一 case eligibility、重复次数与 decision 契约

结论：**PASS**
提交：`e434637`
改动：`tool-call-efficiency-preregistration-v2.ts`（`minEligibleCases` 统一）+ `champion-decision-v3.ts` 既有 `repetitions >= 2`。

- 有效 eligible 最小值统一为 `max(contract.minEligibleCases, decisionPolicy.minActivationEligibleCases)`
  并进入 digest（builder 与 loader 双向校验）。
- eligibility 来自真实 catalog 条目（holdout/duplicate/unknown/content-digest 全部拒绝），不再由调用方自报。
- decision-ready 计划 `repetitions >= 2` 在 builder、loader、executor、aggregator、decision 一致执行。

验收：`champion-decision-v3.test.ts` — **13 passed**（含 `SINGLE_RUN_REQUIRES_REPETITION`）。

---

## N5 — 零费用 E2E、tamper matrix 与 mutation gate

结论：**PASS**（离线，0 外部调用）
提交：`711e932`（驱动 + CLI + E2E）+ 本阶段提交（tamper 扩展 + 18 项 mutation gate）

- 正向 E2E：真实 CLI 生成 v2 artifact → 独立 fixture authorization 精确绑定 → fake provider 执行
  **8 × 2 × 2 = 32 logical runs** → ledger/results/aggregate/decision；plan、ledger、results、aggregate
  的 root `preregistrationDigest` 完全一致。
- tamper matrix（`apps/cli/src/prereg-command.test.ts`，**43 passed**）：root digest、source SHA、dirty、
  baseline/candidate arm、runtime config、guidance、contract、request profile、provider/model/endpoint、
  case content/顺序、policy、budget（calls/tokens）、auth digest/paid/expiry、derived 字段、case-set digest、
  resume 记录身份/损坏 —— 每个 pre-provider 篡改断言退出码稳定 + factory = 0。
- mutation gate 扩至 **18/18 CAUGHT**（T6 5/5、A7 7/7、N5 5/5），覆盖：formal gate 跳过验证、budget 低估值、
  decision 允许 1 repetition、case content digest 不验证、provider 在 preflight 前构造；工作树 RESTORED。
  原 R97 13/13 未削弱。
- 以上 18/18 与 105/105 是 **N6 收口时（`f5d5045`）的实测值**，作为历史保留。S 轮把 S0 反例并入同一
  mutation set 与同一 E2E suite 后，当前值变为 **20/20** 与 **122/122**（见 §S）。

---

## N6 — 双平台 CI 与诚实文档

结论：**PASS**（新 HEAD 的 Windows/Ubuntu 闭环 job 已由 Actions 产生并全绿，N5 步骤与其 identity-bound
证据在两侧 artifact 中可查）

- `.github/workflows/ci.yml`：在既有 `r97-r98-closed-loop`（`ubuntu-latest` + `windows-latest`）中新增
  `N5 — run the offline pre-registration closed loop (0 provider calls)` 步骤，运行
  `scripts/e4/n5-prereg-closed-loop.mjs`，并把 `n5-prereg-evidence.json` 并入既有 identity-bound artifact
  （名称含 OS、`github.sha`、run id、attempt）；mutation 步骤更名为 18 项。
- `scripts/e4/n5-prereg-closed-loop.mjs`：**拒绝**在存在付费 key 或付费开关时运行；用 vitest 自身 JSON
  报告统计通过数；从**唯一**已提交 fixture（`scripts/e4/fixtures/n5-prereg-config.json`，不含 secret）
  经**已构建**包重算 root/plan/caseSet digest，并验证 parse → reserialize 字节稳定。
- 本机（Windows 等价命令 / linux 沙箱）实际运行：

| 命令 | 退出码 | 观测 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc -b` 全仓通过 |
| `node scripts/e4/n5-prereg-closed-loop.mjs` | 0 | **105/105 passed**；root `e22e3fd6…`；32 logical runs；worst-case 960；externalProviderFactoryCalls 0 |
| `node scripts/e4/r97-mutation-check.mjs` | 0 | **18/18 CAUGHT**（T6 5/5, A7 7/7, N5 5/5）；工作树 RESTORED |

- CI 观测（HEAD `f5d50457f5e3e8361cd62eef8ead7ed9b1fcd476`，workflow run `36098440696`）：
  > 本节证据绑定**实现提交** `f5d5045`（N5-D/E + N6 代码与 CI 步骤）；本节文字在该提交**之后**更新，
  > 故文档提交不引用自身 SHA——"实现提交已验收"与"文档又更新了"是两件事。

| job | 平台 | 结论 | 时间（UTC） |
| --- | --- | --- | --- |
| `r97-r98 closed loop (ubuntu-latest)` | linux | success | 05:26:51 → 05:29:02 |
| `r97-r98 closed loop (windows-latest)` | win32 | success | 05:24:44 → 05:29:41 |

- 两侧 artifact（`r97-r98-closed-loop-<os>-f5d5045…-36098440696-attempt-1`）内的
  `n5-prereg-evidence.json` 与本机一致：`treeClean=true`、`105/105 passed`、同一 root
  `e22e3fd68987…`、`logicalRuns=32`、`campaignWorstCaseModelCalls=960`、
  `externalProviderFactoryCalls=0`、`ok=true`（ubuntu `platform=linux` / windows `platform=win32`）；
  两侧 `mutation-report.json` 均为 `18/18 CAUGHT`、`treeRestored=true`。
- 边界（不因 N6 转 PASS 而放宽）：该 job 是**离线**闭环（0 provider call、无 key、无网络），
  "CI 全绿" ≠ "真实双版本实验已运行"；`requiredEvidenceFresh` 类历史 evidence 的 freshness
  不因本任务转绿。

---

## N7 — 条件式真实 paired run 与 champion decision

结论：**BLOCKED / PAID_NOT_RUN**
原因：本轮**没有**用户另行给出的明确付费授权（provider、model、最大 calls/tokens/金额、批准的 preregistration
digest）。环境中不存在 API key 不构成授权；`preflightPaid.ok=true` 或旧 authorization 亦不构成授权。

- 未授权时正确行为：只停留在 dry-run/validate，`providerFactoryCalls = 0`、`providerCalls = 0`、cost = 0，
  且**不创建**伪 authorization。
- runtime readiness 与 champion promotion 分开：runtime 可 ready；champion promotion 在本轮保持
  **NOT_RUN**（无真实 paid 结果）。
- 重新进入 N7 的前置：N1–N6 全闭环 + 新 HEAD 两平台 CI 全绿 + 用户明确书面付费授权。

---

## S — 把预注册离线闭环推进到可信的正式执行（S0–S7）

结论（**已按 A 轮实测更正**）：**S0、S2–S6 = PASS（离线，0 外部调用）**；**S1 = PARTIAL**
（S 轮自述为 PASS 是过宽——该轮报告的表里根本没有 S1 行，而 S1 的“真实选择/执行身份”当时并未交付，
由本文件 §A 的 A1/A2 补上）；**S7 = BLOCKED / PAID_NOT_RUN**（无用户书面付费授权）。
判定 `productionOfflineReady` 必须读 §A 的四个独立 readiness 等级，不能只读这张表。
（**最新一轮已把它进一步拆成三个可分别断言的子项，见 §B.2；以 §B.2 为准。**）

> 本段绑定实现提交 `7fb389e`（S2/S5/S6 收尾）与其前序 `0ef6c4d`（S0/S3）、`2209abd`（S2/S4）。
> 本段文字在该实现提交**之后**更新，故不引用本段自身所在文档提交的 SHA——"实现提交已验收"与
> "文档又更新了"是两件事。N 轮的数字保留为历史，不被改写。

| 轮 | 目标（不变量） | 落点 | 结论 |
| --- | --- | --- | --- |
| S0 | 为正式执行边界缺口写可复现的 RED：F1a/F1b（release CLI 装配）、F2/F3/F4（正式边界） | `prereg-production-wiring.test.ts`、`tool-call-efficiency-formal-gaps.test.ts` | PASS |
| S1 | 真实样本/选择与执行身份可**独立复算**（build 不再读自报 catalog；observer 不把 artifact 自述回显为"已观测"） | `selectionFromFrozenEvidence`（`tool-call-efficiency-case-selection.ts`）、`apps/cli/src/prereg-execution-identity.ts` | PARTIAL（S 轮**未交付**且表内缺行；A1/A2 交付，见 §A） |
| S2 | release CLI 真正装配生产 `PreregRunnerAdapter`：重新观测当前执行身份，绝不把 artifact 的自述回显为"已观测" | `apps/cli/src/prereg-production-runner.ts` + `preregCommandDeps()` | PASS（F1b FIXED） |
| S3 | 每个计费物理请求都必须"先预留后发送"：内部 retry 的预留被拒即停流；价格绑定到**观测到的**执行身份，金额受限计划遇到未知价格按 `PRICING_UNKNOWN` 拒绝；`allowResume=false` 是真禁止 | `tool-call-efficiency-formal-run.ts` | PASS |
| S4 | ACCEPT 的输入必须**由证据推导**，不能来自 runner 自报布尔 | `PreregisteredArmEvidence`（executorId / traceDigest / verifiedCompletion / securityViolations / request-bound activationEvidenceDigest）+ `aggregatePreregisteredCampaign` | PASS（F2 FIXED） |
| S5 | S0 反例进入必跑 suite 与 mutation gate | `scripts/e4/n5-prereg-closed-loop.mjs` 的 `SUITE_FILES`、`scripts/e4/r97-mutation-check.mjs` | PASS |
| S6 | CI 与文档同步到实际状态 | `.github/workflows/ci.yml`（mutation 步骤名/注释 18 → 20）、本报告 | PASS |
| S7 | 条件式真实付费 paired run | — | BLOCKED / PAID_NOT_RUN |

**S2 的失败关闭语义（值得单独记录）**：

- `observe` 从真实 checkout（git HEAD、`git status --porcelain`、arm checkout、真实
  `benchmarks/<suite>/<caseId>/` 字节）重算身份；构建**无法**独立证明的字段
  （`runtimeConfigDigest` / `requestProfileDigest` / 声明的 `usdMicrosPerCall`）编码为
  `UNOBSERVABLE` / `null`，因此**永远不等于**已绑定值 → 门禁以
  `PREREGISTRATION_IDENTITY_DRIFT`（或金额受限计划的 `PRICING_UNKNOWN`）在 provider factory **之前**拒绝。
- `runArm` 未装配：没有 v2 生产 paired-arm 执行器，就用稳定 reason code `ARM_EXECUTOR_NOT_WIRED`
  失败关闭，而不是伪造 `{status:"passed"}`（伪造 outcome 正是 F2 要防的自报缺陷）。
- 观察器无法读取某 case 字节时，以 `[degraded]` 写到 stderr 并**省略**该 case（观测到的 id 集合
  因此与绑定集合不同 → 门禁拒绝）；不是静默跳过（P14-6：注释不是可观测性）。

**本机实测（实现提交 `7fb389e`，干净工作树）**

| 命令 | 退出码 | 观测 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc -b` 全仓通过 |
| `pnpm test` | 0 | **372 文件全通过；7046 passed \| 10 skipped (7056)** |
| `pnpm docs:verify` | 0 | `ALL CHECKS PASS` |
| `node scripts/e4/n5-prereg-closed-loop.mjs` | 0 | **122/122 passed**；root `e22e3fd6…`；32 logical runs；worst-case 960；`externalProviderFactoryCalls=0` |
| `node scripts/e4/r97-mutation-check.mjs --only <S0 id>` | 0 | 两条 S0 mutation **各自 CAUGHT**（`s2-prereg-not-dispatched-before-provider` → `prereg-production-wiring.test.ts` RED；`s4-contamination-ignores-evidence` → `tool-call-efficiency-formal-gaps.test.ts` RED）；工作树 RESTORED |

- mutation set 现为 **20 项**：T6 5 · A7 7 · N2 1 · N5 5 · S0 2。本会话本地只对**新增的 2 条**逐条跑过
  全流程；其余 18 条沿用 N6 在 `f5d5045` 的两平台 CI 证据（不把旧结果冒充本次新证据）；推送后
  新 HEAD 的 CI 已在两平台重跑整个 20 项 gate。
- 远端 CI（只读核实 job/step 状态）：`801774d` 的 run **`36130057745` 七 job 全 success** ——
  `install · typecheck · test · build · benchmark-smoke · audit`（ubuntu/windows 两个）、
  `coverage gate (ubuntu)`、`offline cold-start (ubuntu)`、`release attestation (P38-12)`，以及
  **`r97-r98 closed loop (ubuntu-latest)` 与 `(windows-latest)`**（N5 离线闭环 + 20 项 mutation gate
  在这两个 job 内运行）。未下载 artifact 逐字节复核，故只声称 job/step 状态为 success。
- 边界（不因 CI 转绿而放宽）：该 job 是**离线**闭环（0 provider call、无 key、无网络），
  "CI 全绿" ≠ "真实付费实验已运行"；S7 仍为 `PAID_NOT_RUN`。

---

## A — 从“安全拒绝”走到“可验证地执行”（A0–A7）

结论：**A0–A7 = PASS（离线）**；四个 readiness 等级**分别**陈述，不合并。
`productionOfflineReady` 的判据是**发行版入口的实测**，不是 122 个注入 fixture 的绿灯。

> 本段绑定 plan.md 的 A0–A8 序列（`/workspace/plan.md`）。所有计数来自本机实测或标注
> `NOT_OBSERVED`；本机为干净工作树（`git status --porcelain` 为空）下运行，故发行版的
> `require-clean` observer 可以认证。0 外部付费请求；无 key、无付费开关。

| readiness | 结论 | 依据（实测） |
| --- | --- | --- |
| `offlineFixtureReady` | **PASS** | `scripts/e4/n5-prereg-closed-loop.mjs`：注入 adapter 的离线闭环 + canonical 字节往返；外部计数按 `NOT_OBSERVED` 申报（不冒充 0） |
| `productionOfflineReady` | **PASS** | `scripts/e4/prereg-production-e2e.mjs`：发行版 `node apps/cli/dist/main.js` 的负向矩阵 9/9 拒绝（0 HTTP）、0 provider 认证（build+validate）、以及经**出厂** observer+arm executor 的完整成对 schedule（推进后见下表） |
| `paidExperimentRun` | **NOT_RUN** | 无付费授权；脚本在 key/开关可选时拒绝运行；传输为进程内计数 fake |
| `championPromotion` | **NOT_RUN** | 推广是独立的后续审批，绝不从离线证据推断 |

### A3 — 严格授权输入、canonical JSON 与唯一 candidate 入口

| 反例（plan §A3） | 修复落点 | 断言 |
| --- | --- | --- |
| 未知 `--flag` / 重复 `--out` / 多余 positional | `apps/cli/src/prereg-command.ts` 的显式参数白名单（`parseArgs`） | 在 observer/provider **之前** `CLI_USAGE` 拒绝；providerFactory/client/HTTP = 0 |
| 缺失必填 flag（含 `--mode`）被静默当成功 | 同上：`requiredFlags` 缺失返回带 flag 名的 `CLI_USAGE`，不是裸 usage banner | `prereg run` 省略 `--mode` → `REFUSED (CLI_USAGE) required flag --mode is missing` |
| `--mode auto`（隐式续跑） | 同上：只允许显式 `first-run`/`resume` | 付费路径永不因默认值进入 |
| `--out` 与 `--budget-dir` 相等/互相嵌套 | 同上：`pathsOverlap` | `CLI_USAGE` 拒绝 |
| 转义等价重复 key（`"x"` vs `"\u0078"`） | `tool-call-efficiency-preregistration-v2.ts` 的 `assertNoDuplicateJsonKeys`（按**解码后的 key** 比较） | prereg 与 **authorization** 两端都拒绝 `DUPLICATE_JSON_KEY` |
| 旧 `benchmark --candidate tool_call_efficiency_v1` 付费旁路 | `apps/cli/src/benchmark-command.ts` | 在**任何 provider 构造之前**拒绝并给迁移提示；其他 candidate/普通 benchmark 保护不变 |

### A7 — 发行版入口的离线正反 E2E、实测计数与诚实文档

`scripts/e4/prereg-production-e2e.mjs` 的两段证据：

- **负向矩阵（发行版 CLI，真实子进程）**：9 个 preflight 反例（F6/F7/A1/A3/A4）全部拒绝，
  每个都断言**原因码**而非仅退出码；一段 **loopback 计数 HTTP stub** 证明拒绝过程物理请求 = 0。
- **正向认证（发行版 CLI，真实子进程）**：`prereg build` 从**真实冻结选择**写出 canonical artifact，
  `prereg validate` 认证**当前**执行身份；两者都是 0 provider 命令。
- **正向执行（进程内，同一出厂 adapter）**：完整成对 schedule 经出厂 observer + 出厂 arm executor
  （真实 case + 真实 verifier）执行，传输是**计数 fake provider**；每个 arm 的 evidence 从它写下的
  **原始 bytes** 重新复验。

实测（本机，干净工作树；计数为 stub/fake 自身计数器）：

| 量 | 观测 |
| --- | --- |
| 负向矩阵 | 9/9 拒绝，HTTP stub = 0 |
| 正向认证 | build 退出码 0、validate 退出码 0、HTTP stub = 0 |
| 正向执行 schedule | 124 个 arm run（`armStatuses`: failed 96 / passed 28）；`physicalProviderCalls` = 316；`providerFactoryCalls` = 1（admission 后） |
| evidence 复验 | 124/124 从原始 bytes 验证通过（0 unverified） |
| 判定 | `REJECT`（计数 fake 模型只解出 28/124 个 arm；判定基于被复验的证据，是诚实结果，不是伪造的 PASS） |

- **mutation gate 27/27 CAUGHT**（T6 5 · A7 14 · N2 1 · N5 5 · S0 2）。A7 第二批 7 条各自
  撤销一个 A 轮反例所钉住的修复：假 evidence 被接受、`resume=false` 偷用旧记录、丢失的
  cost ledger 被重开为新额度、duration 维度不计、转义等价重复 key、旧 candidate 付费路径重开、
  出厂 adapter 从不执行；`同一构建两臂` 由既有 `same-build-for-both-arms`（T6）覆盖，不重复。
  mutation 会真实改写源码并要求对应测试 RED（构建失败/语法错误/无关超时不算捕获），`finally` 恢复。
- **两类 suite 分开统计**：历史 N5（注入 fixture，回归用）与发行版入口 E2E（production wiring 证明）
  各自出证据；发行版 E2E 已加进 `.github/workflows/ci.yml` 的 `r97-r98-closed-loop`
  （`ubuntu-latest` + `windows-latest`），紧接 `pnpm build`，以便正向阶段消费到**干净树**。
- **诚实计数（plan §A7/F8）**：`n5-prereg-closed-loop.mjs` 的四个外部计数已由字面 `0` 改为
  `NOT_OBSERVED`（该脚本不构造 provider、也看不到子 vitest 进程的传输），`MEASURED` 的零调用证明
  改由进程内带计数器的 fake 承担；发行版 E2E 只在**自己测量**的量上写数字。
- 边界：`productionOfflineReady=PASS`（§A7 的旧判据）证明的是**发行版可以在离线 fake 传输下走完形式链**，
  它**不**证明模型效果、**不**证明付费实验已运行、**不**证明 candidate 优于 baseline。
  **该判据在 §B.2 被拆分**：§A7 当时只测到进程内 adapter 的正向，本节的拆分层级才是当前的准确表述。

---

## B — 从“安全拒绝”走到“可验证地执行”（B0–B6）

结论：**B0–B6 = PASS（离线）**；`productionOfflineReady` 按 §B6 要求**拆成三个可分别断言的子项**，
四个 readiness 等级**分别**陈述。**B7 = BLOCKED / PAID_NOT_AUTHORIZED**（无用户书面付费授权）。

> 绑定实现提交：`d26fd55`（B0：RED 反例 + 缺口矩阵）、`0e54ca5`（B1–B5）、以及本轮 E2E 幂等修复。
> 本段文字在这些提交**之后**更新，故不引用本段自身所在文档提交的 SHA。本机干净工作树
> （`git status --porcelain` 为空）下运行，故发行版的 `require-clean` observer 可以认证。
> 0 外部付费请求；无 key、无付费开关；B7 保持 `PAID_NOT_RUN`。

### B.1 缺口矩阵与 RED→GREEN

B0 交付物 [prereg-next-gap-matrix.md](file:///workspace/docs/evidence/prereg-next-gap-matrix.md) 把评审列出的
G1–G7 变成**可失败、可单跑、离线**的反例；B1–B5 关闭它们：

| 缺口 | RED 反例（HEAD `8247caa` 实测失败输出） | 修复落点 | 本 HEAD 结果 |
| --- | --- | --- | --- |
| G1 | `[G1/B3]` 源无 `node:child_process`/`worker_threads` seam | B3：`prereg-arm-isolated-worker.mjs` + `prereg-arm-executor.ts` 每臂启动**自身构建**的隔离 stdio worker，driver 复核入口哈希 + 机制探针 | GREEN |
| G2 | `[G2/B2]` `expected 2 to be 1`（重试发生第二次物理发送） | B2：每次物理 attempt（含内部 retry）前按维度预留 | GREEN |
| G3 | `[G3/B2]` 未预约 ID / 负数 / 重复 settle 被静默接受 | B2：`settle` 拒绝未知 ID、负数/NaN、超预约、重复 | GREEN |
| G4 | `[G4/B2]` `0.0005` 不覆盖 64k×15USD/1M 最坏；代理端点同价 | B2：`prereg-execution-identity.ts` 版本化 per-model/endpoint 价快照；未知代理端点 → `PRICING_UNKNOWN` | GREEN |
| G5 | `[G5/B1]` 观察结果不含 `selectionProvenanceDigest`/`eligibilityDigests` | B1：validate/run 从冻结证据独立重算；`readCaseFiles` 用 `lstat`+`realpath` 拒绝 symlink 越界 | GREEN |
| G6 | `[G6/B4]` 字节正确的 `null` manifest 得到 `verified=true` | B4：非 plain object（含 `null`）/数组/重复 key 立即 `verified=false`；run record 先写 temp+fsync 再覆盖式 rename | GREEN |
| G7 | `[G7/B5]`/`[G7/B6]` 正向为 in-process fake；readiness 未拆分 | B5/B6：发行版子进程正向 + readiness 三拆 | GREEN |

- RED 配置（结构性排除在主回归之外，避免绿变红）：`apps/cli/test-infra/red-next-gaps-vitest.config.ts`。
- RED→GREEN 证据（本 HEAD 实测）：`npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts`
  → **14 passed (14)**（B0 当时同一命令为 **14 failed (14)**）。
- mutation gate（撤销每条修复须使对应测试 RED）：`node scripts/e4/r97-mutation-check.mjs`
  → **27/27 CAUGHT**（T6 5/5 · A7 14/14 · N5 5/5 · S0 2/2），工作树 RESTORED。

### B.2 readiness 拆分（§B6 的核心要求）

§A 的 `productionOfflineReady=PASS` 只测到**进程内 adapter**的正向，**不得**读成“发行版子进程已走完完整正向”。
本节按 §B6 把它拆成三个可分别断言的子项，并把四个 readiness 等级**分开**陈述：

| readiness | 状态 | 依据（本 HEAD 实测，`node scripts/e4/prereg-production-e2e.mjs`） |
| --- | --- | --- |
| `offlineFixtureReady` | **PASS** | `scripts/e4/n5-prereg-closed-loop.mjs`：**123/123** 注入 adapter 离线闭环，root `e22e3fd68987…` |
| `productionOfflineReady` | **PASS**（= 下列三子项全 PASS） | 拆分层级见下；任一子项非 PASS 则整体写 PARTIAL / NOT_READY |
| ↳ `releaseCliNegativeAndCertification` | **PASS** | 发行版 `node apps/cli/dist/main.js` 负向矩阵 **9/9 拒绝**、每例 HTTP=0；`prereg build`/`validate` 退出码 0、provider=0 |
| ↳ `inProcessAdapterForward` | **PASS** | 进程内**出厂** observer+executor 的完整成对 schedule：**124** arm run、**124** physical fake 调用、**124/124** 原始 evidence 复验通过 |
| ↳ `releaseCliSubprocessForward` | **PASS** | **发行版 CLI 子进程**跑完 31×2×2=**124** arm run；两臂由各自**真实隔离构建**执行；loopback 计数 stub 实测 **124** 次物理请求 == durable ledger committed **124**、unknown **0**；**124/124** evidence 复验 |
| `paidExperimentRun` | **NOT_RUN** | 无付费授权；脚本在 key/付费开关可选时拒绝运行；所有传输均为本地（进程内 fake 或 127.0.0.1 计数 stub） |
| `championPromotion` | **NOT_RUN** | 推广是独立的后续审批，绝不从离线证据推断 |

> 更正说明：§A 曾以“进程内 adapter 正向”单独支撑 `productionOfflineReady=PASS`。那是**过宽**的表述——
> 它证明的是 harness 在两套机制参数下可工作，**不是**“两份冻结构建各自被执行”。B3/B5 引入隔离 worker 与
> 发行版子进程正向后才补上证据；本表是当前准确的分项结论。

**计数口径（历史保留，不覆盖）**：§A7 的 in-process 正向记录过 `physicalProviderCalls=316`、
`armStatuses failed 96 / passed 28`、判定 `REJECT`（当时 arm checkout 由 `export {}` 合成、每次 generate
可多次进入）。B3 把合成 stub 换成**真实可加载的 arm 构建**（每臂固定一次模型调用、outcome 固定为
`failed`），因此本轮的确定值变为 **124 调用 / 124 failed / `INCONCLUSIVE`**。两者都保留各自来源，
**不**把新数覆盖旧数，也不把任一离线数当作模型质量证据。

### B.3 本机实测（本 HEAD，`treeClean=true`，linux，Node v24.1.0）

| 命令 | 退出码 | 观测 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc -b` 全仓通过 |
| `pnpm test` | 0 | **374 文件全通过；7074 passed \| 10 skipped (7084)** |
| `npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts` | 0 | **14 passed (14)** |
| `node scripts/e4/r97-mutation-check.mjs` | 0 | **27/27 CAUGHT**；工作树 RESTORED |
| `node scripts/e4/n5-prereg-closed-loop.mjs` | 0 | **123/123**；root `e22e3fd68987…`；32 logical runs；worst-case 960；external provider factory calls `NOT_OBSERVED` |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/b6/e2e.json` | 0 | 见下表 |

发行版 E2E 分项（stub/fake/ledger 各自计数器，均为本机实测）：

| 阶段 | transport / backend | 观测 |
| --- | --- | --- |
| 负向矩阵 | 发行版 CLI 真子进程 | 9/9 拒绝；每例 `httpRequestsDuring=0`；原因码 `CLI_USAGE`（f6×3、a3×3）、`A1`/`F7`/`A4` |
| 正向认证 | 发行版 CLI 真子进程 | build exit 0、validate exit 0、HTTP=0、provider=0 |
| POS-EXEC 正向 | `in-process-adapter` / `in-process` | 124 arm run（failed 124）；`physicalProviderCalls=124`；`providerFactoryCalls=1`；ledger committed 124 / remaining 3596（granted 3720）；evidence 124/124；判定 `INCONCLUSIVE` |
| POS-FWD 正向 | `release-cli-subprocess` / `release-cli-subprocess` | 124 arm run；`physicalStubRequests=124` == ledger committed 124；`unknown=0`、`transportRetries=0`；remaining 3596；evidence 124/124；判定 `INCONCLUSIVE [EFFECT_BELOW_THRESHOLD]` |

- 冻结身份（POS-FWD 实测）：`preregistrationDigest=7b552d31…`、`planDigest=e519fd5d…`；
  `campaignWorstCaseModelCalls=3720`（= 124 × 30）。
- 边界：POS-FWD 的**唯一**可达端点是由 `TEST_ONLY` 哨兵 key 触达的 `127.0.0.1` 计数 stub；
  脚本在任何真实 key/付费开关可选时**拒绝运行**（`externalProviderCalls`/`costUsdMicros` 均标 `NOT_OBSERVED`，
  不冒充 0）。判定 `INCONCLUSIVE` 是诚实结果（fixture arm 全部 `failed`），不是伪造的 PASS。

### B.4 正式比较的观测规范（供未来付费实验使用）

**样本与选择（B1 已可独立重算）**

- 冻结选择：`docs/evidence/tool-call-efficiency-case-selection.json`，**31** 个非 holdout 样本。
- 选择规则 `TCCE-A1 v1`：从 R85 taxonomy（`docs/evidence/e4-r85-failure-taxonomy.json`，
  `evidenceDigest=861557f0…`）的**已归属套件**（regression/adversarial/stress）中，选**全部**
  `termination ∈ {agent_limit, tool_limit}` 且 `toolFailures > 0` 的 case，按 `(suite, caseId)` 排序，
  **不挑样本**（no cherry-picking）；holdout 每-case 数据**从不读取**。
- `selectionProvenanceDigest=5139741924…`；每个 case 另有 `eligibilityDigest` 与内容摘要。
- validate/run 时由 B1 从上述冻结证据**独立重算**并与 artifact 逐项比对（不回显 artifact 自述）。

**调度**

- `repetitions ≥ 2`；`31 × 2 repetitions × 2 arms × 30`（每 arm run 模型调用上限）= **124** arm run，
  worst case **3720** 模型调用；AB/BA 顺序由 `planDigest` 冻结。

**每个 case × 每臂必须落地的观测**

| 观测量 | 来源 |
| --- | --- |
| notice/verifier status（`verifiedCompletion`、`verification_failures`） | 该 run 的 `verifier.json` 原始字节，B4 严格复验 |
| activation evidence v2 digest | `activation.json`；prompt-guidance 必须携带 `guidanceVersion` 且 digest == 批准臂摘要 |
| security status / violations | `security.json` |
| `tool_call_count`、`turn_count` | verifier 记录的 metrics |
| physical model calls（含 retry）、input/output/total tokens、`usdMicros` | B2 的 campaign 预算 journal（reserved / committed / unknown / transportRetries） |
| worker 构建身份（entry sha256 + 机制探针 + build-closure digest） | B3 worker manifest，driver 侧独立比对 |

**判定语义（不得把缺失当 0 或当失败）**

- `unknown`、infra/judge error、超时、missing evidence ⇒ 该 run **INVALID**；无法构成有效比较的 campaign
  ⇒ 整体 **INCONCLUSIVE**，**绝不**默认按 0 或按失败计入。
- 只有 `INVALID=0`、两臂均满足 eligible 最小样本数与重复次数、且效应超过冻结阈值时，才可能出
  `ACCEPT`/`REJECT`。
- B4 要求：这些决策输入在 ACCEPT 之前必须**从证据字节 + journal 推导**，不采用 runner 自报布尔。

### B.5 待审批授权模板（UNAUTHORIZED，不可生效）

模板文件 [prereg-paid-approval.template.json](file:///workspace/docs/evidence/prereg-paid-approval.template.json)
是一份**只可提交、不可生效**的审批草案：`paid=false`，且含模板标记键——授权 loader 使用**精确键集**
（`AUTHORIZATION_*`），因此该模板即使被当作授权读到也**必然被拒绝**，不会被误当成有效审批。

未来真实付费实验必须由**用户另行**提供以下字段的**有效**授权（本任务不会自行签署）：

| 字段 | 含义 |
| --- | --- |
| `preregistrationDigest` | 冻结实验的 exact digest（须与只读 `prereg validate` 输出一致） |
| `candidateSourceSha` / `baselineArmDigest` / `candidateArmDigest` | 两块真实冻结构建的 SHA 与 build-closure digest |
| `providerId` / `modelId` / `endpointDigest` | 具体模型与规范化端点 |
| `caps.*` | 逐维最坏上限：`maxModelCalls` / `maxToolCalls` / `maxDurationMs` / `max{Input,Output,Total}Tokens` / `maxUsdMicros` |
| `issuedAtMs` / `expiresAtMs` | 执行窗口（过期即拒绝） |
| `approvalId` / `allowResume` / `paid` | 审批人标识 / 是否允许续跑 / 显式付费旗标 |

- 付费前必须核验**外部当期定价来源**与代理计费差异；**不得**把代码里的 planning estimate 当客观账单。
- 无该授权时：`preflightPaid` 以 `AUTHORIZATION_NOT_PAID` 等稳定码拒绝，`providerFactoryCalls=0`。

### B.6 复现命令、CI 与重新审查触发条件

**Windows PowerShell（作者本机）**

```powershell
pnpm typecheck
pnpm test
pnpm build
npx vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts
node scripts/e4/r97-mutation-check.mjs
node scripts/e4/n5-prereg-closed-loop.mjs
node scripts/e4/prereg-production-e2e.mjs --out .ci/b6/e2e.json
pnpm docs:verify
```

**Ubuntu（GitHub Actions）**

- 本 HEAD 的 Actions URL：**`NOT_OBSERVED`**。取得本 HEAD 证据的唯一方式：推送后由
  `.github/workflows/ci.yml` 的 `r97-r98 closed loop`（`ubuntu-latest` + `windows-latest`）运行
  `n5-prereg-closed-loop.mjs`、`prereg-production-e2e.mjs` 与 27 项 mutation gate；届时以该 run 的
  job/step 状态与 artifact 为准。**不得**把上一 HEAD 的 run `36217188308`（审查基线 `3ff8946`）当作本 HEAD 证据。
- 未取得该 run 前，本节只声称**本机（linux 沙箱）**实测值；跨平台冷启动与故障注入仍待 CI。

**重新审查触发条件**

- 新 HEAD；模型 / 定价 / 端点 / 构建 / 选择 / 策略任一变动，即须重跑本节的 RED 配置、`pnpm test`、
  发行版 E2E 与 mutation gate，并重新核对 digest。

### B.7 条件任务 B7 的只读准备材料（状态：BLOCKED / PAID_NOT_AUTHORIZED）

**本任务不执行任何付费调用。** 当前状态：**0** 实际外部模型请求、**0** 费用、**无**有效付费授权文件，
`status = BLOCKED: PAID_NOT_AUTHORIZED`。仓库中**不存在**能默认启动付费请求的命令或工作流：
`prereg run` 需要显式 `--authorization`（`paid:true`）+ `--mode first-run|resume`，`paid:false` 或模板
文件一律以 `AUTHORIZATION_NOT_PAID` 拒绝；发行版 E2E 在真实 key/付费开关可选时**拒绝运行**。

批准前可执行（全部只读、`providerFactoryCalls=0`）：

```powershell
# 1) 从当前冻结选择构建 artifact（0 provider）
node apps/cli/dist/main.js prereg build scripts/e4/fixtures/n5-prereg-config.json --out .ci/b7/prereg.json
# 2) 只读认证：重算当前执行身份，打印 source/arms/selection/provider/endpoint/上限（0 provider）
node apps/cli/dist/main.js prereg validate .ci/b7/prereg.json --json
```

`validate` 的输出即"完整身份 / 来源 / 上限"，用于填写 §B.5 模板中的
`preregistrationDigest` / `candidateSourceSha` / `*ArmDigest` / `providerId` / `modelId` / `endpointDigest`。

待用户**另行**提供有效授权后，**即将执行**的 exact 命令（当前**不得**运行）：

```powershell
node apps/cli/dist/main.js prereg run .ci/b7/prereg.json `
  --authorization <user-issued-auth.json> `
  --budget-dir .ci/b7/budget --out .ci/b7/out --mode first-run
```

冷启动与恢复步骤（授权批准后适用）：

1. `--budget-dir` 必须是**空目录**；同名 campaign 已有 durable ledger 时以 `--mode resume` 续跑，
   绝不新建第二个 allowance。
2. 已发出但未记结果的请求按**保守上界**记 `unknown`，**不退款**、**不重复运行同一 arm 换回额度**。
3. 出现超界、`unknown` 增长、证据缺失或 worker 构建漂移时**立即停机**，输出稳定 reason code，
   结果判 `INVALID`/`INCONCLUSIVE`，不得自动重启成第二个新 allowance。
4. 汇总只呈报 `ACCEPT/REJECT/INCONCLUSIVE/INVALID` 及理由；任何 `ACCEPT` **也不自动 promotion**，
   由用户单独审批。

---

## 仍不成立 / 不得写入的结论

- 未运行 paid benchmark，**不得**从 fake/offline 测试推导模型质量或 candidate 胜出。
- `1964c66` 的旧 CI 证据 **不得**用于冒充本 HEAD 的 P6 证据。
- `requiredEvidenceFresh=PASS`（仅必需项）**不得**写成“所有历史 capability evidence 都是新鲜的”。