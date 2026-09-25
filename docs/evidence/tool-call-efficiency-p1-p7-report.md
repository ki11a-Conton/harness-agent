# tool_call_efficiency_v1 — 预注册可执行闭环阶段报告（N0–N7 + S0–S7）

> 本文件是 **N0–N7 阶段**与后续 **S0–S7 阶段**的任务报告。它记录**已执行并验证**的事实，不把计划项
> 写成已完成。
> 状态规则：P5 只有在 N1–N5 可执行闭环落地并经 CI 验证后才可写 PASS；N7 / S7 在用户另行明确付费
> 授权前一律 **BLOCKED / PAID_NOT_RUN**。runtime ready 与 champion promotion 分开陈述。

- 阶段起点（固定审查 HEAD）：`1964c66bd3438846e7ef3b8ce76533ed29f3b450`
- 上一轮审查基线：`6d027c8936bccefa6ecb47d1ebfa56a56c89efe3`
- 外部付费模型调用：N0–N6 = **0**；S0–S6 = **0**；N7 / S7 = **PAID_NOT_RUN**。
- 模型效果 / champion promotion：**UNKNOWN / NOT_RUN**（离线正确性证据不等于模型效果证据）。
- N0–N6 结论：**PASS**（N5 可执行闭环已由两平台 CI 验证，见 §N6）；N7：**BLOCKED / PAID_NOT_RUN**。
- S0–S6 结论：**PASS**（离线，见 §S；远端 CI 对实现提交 `7fb389e` 为 **NOT_RUN**，未 push）；
  S7：**BLOCKED / PAID_NOT_RUN**。

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

结论：**S0–S6 = PASS（离线，0 外部调用）**；**S7 = BLOCKED / PAID_NOT_RUN**（无用户书面付费授权）。

> 本段绑定实现提交 `7fb389e`（S2/S5/S6 收尾）与其前序 `0ef6c4d`（S0/S3）、`2209abd`（S2/S4）。
> 本段文字在该实现提交**之后**更新，故不引用本段自身所在文档提交的 SHA——"实现提交已验收"与
> "文档又更新了"是两件事。N 轮的数字保留为历史，不被改写。

| 轮 | 目标（不变量） | 落点 | 结论 |
| --- | --- | --- | --- |
| S0 | 为正式执行边界缺口写可复现的 RED：F1a/F1b（release CLI 装配）、F2/F3/F4（正式边界） | `prereg-production-wiring.test.ts`、`tool-call-efficiency-formal-gaps.test.ts` | PASS |
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
  全流程；其余 18 条沿用 N6 在 `f5d5045` 的两平台 CI 证据（不把旧结果冒充本次新证据）。
- 远端 CI：本会话**未** push，故 `7fb389e` 的双平台 job 状态为 **NOT_RUN**；不得据此声称两平台成功。
  新 HEAD 的 CI 需在推送后由该 SHA 自己的 run 确认。

---

## 仍不成立 / 不得写入的结论

- 未运行 paid benchmark，**不得**从 fake/offline 测试推导模型质量或 candidate 胜出。
- `1964c66` 的旧 CI 证据 **不得**用于冒充本 HEAD 的 P6 证据。
- `requiredEvidenceFresh=PASS`（仅必需项）**不得**写成“所有历史 capability evidence 都是新鲜的”。