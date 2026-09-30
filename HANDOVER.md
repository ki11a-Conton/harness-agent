# HANDOVER.md — 未完成任务交接（Unfinished Work）

> 本文是**未完成任务**的交接清单，由执行 Agent 维护。
> 机器可推导的事实由 `pnpm docs:verify` 校验（例如 `packages/（24 个包）` 是机器校验项，
> 不得删除或改错数字）；已完成的发布真值以各轮 exact-SHA CI attestation 与
> `docs/evidence/*.md` 为准，不在本文重复记录。
> **本文只写"还没做完什么、下一步做什么、证据在哪"。**

## 0. 本文件的历史（为什么它是重写的）

- 旧 `HANDOVER.md` 描述的是 **E4-R36…R39 批次**（2026-09-12 前后），其引用的 `plan.md`
  早已从工作树移除，内容整体过期。
- `HANDOVER-20260928-E4-R0-R7.md`（E4-R0/R7 批次）已**删除**：它的结论已全部并入
  `docs/evidence/current-prereg-status.md` 的 CURRENT 段与 `docs/evidence/*.md`。
  删除该文件后，仓库内仅剩本文件作为**未完成任务**的唯一交接入口。

## 1. 当前状态速览

- 仓库规模：`packages/（24 个包）`（工作区包，均自带 package.json；docs:verify 机器校验项）。
- 当前执行计划：`plan(20260930-061557).md`（已提交，N1–N6）。上一版 `plan(20260929-015956).md`
  已收口，保留为历史。
- `plan.md` **不存在**（无进行中的旧式计划入口）。docs:verify 的 E4-00 在"确实不存在"时诚实
  判 PASS；**不要**留下引用缺失 spec 的悬空 `plan.md`（历史上这正是两平台 CI 变红的原因）。
- 用户本地只有 **Windows**。Linux 冷启动与正式 Ubuntu 验收**只能由 GitHub Actions 完成**；
  不得要求用户安装 Linux/WSL/Docker。

### 1.1 五级 readiness（当前实测，绝不合并成一个 PASS）

```text
fixtureProtocolReady:   PASS
realBuildOfflineReady:  BLOCKED   (NO_REAL_ARM_PAIR)
budgetEvidenceReady:    NOT_PROVEN (DISPATCH_JOURNAL_MISSING)
paidExperimentRun:      NOT_RUN
championPromotion:      NOT_RUN
```

| 等级 | 状态 | 依据 / 边界 |
| --- | --- | --- |
| `fixtureProtocolReady` | PASS | 合成 fixture arm 构建上的离线闭环：干净 checkout 上 producer 退出 0，124/124 armRun、124 次 physical provider 调用，bundle 复核 124/124，`journalBinding: MEASURED`，预算 1240 = 620 + 620（delta 0）。**这不蕴含任何真实双构建结论。** |
| `realBuildOfflineReady` | BLOCKED | 命名 blocker `NO_REAL_ARM_PAIR`。arm 目前是普通目录而非真实干净 checkout，`identity.arms.*.sourceSha` 诚实省略。这是 N5 的工作。 |
| `budgetEvidenceReady` | NOT_PROVEN | 工具 dispatch journal **仍无 producer**；`r5-real-formal.mjs` 只 COPY `dispatch*.json`。umbrella 码 `REQUEST_DISPATCH_JOURNAL_NOT_BOUND` 正确置首，具体原因 `DISPATCH_JOURNAL_MISSING`。这是 N3 的工作。 |
| `paidExperimentRun` | NOT_RUN | 无付费授权，脚本从不自行创建。 |
| `championPromotion` | NOT_RUN | 独立的后续审批阶段。 |

## 2. 本轮（N1–N6）任务状态 —— 未完成部分

| 任务 | 计划章节 | 状态 | 说明 |
| --- | --- | --- | --- |
| **N1** worker 终止与请求生命周期（F30-1） | §4 | ✅ **DONE** | 见 §3。 |
| **N4** pricing expiry 接入每次物理发送（F30-5） | §7 | ✅ **DONE（但 guard 未接入 CLI）** | 见 §4。**遗留项已并入 N2。** |
| **N2** release CLI 统一离线身份与脚本作用域（F30-2, F30-3） | §5 | ⛔ **NOT STARTED** | 已分配，无提交。**含 N4 的遗留项：把 pricing guard 真正接到 CLI。** |
| **N3** 生产 dispatch journal 与严格 request/tool 关联（F30-4） | §6 | ⛔ **NOT STARTED** | 已分配，无提交。 |
| **N5** 真实构建 pair + formal 内容矩阵 + build 绑定（F30-6） | §8 | ⛔ **BLOCKED** | 依赖 N1、N2、N3、N4 全部完成。 |
| **N6** 同 SHA 双平台终验 + bundle 解析 + 状态收尾（F30-7） | §9 | ⛔ **BLOCKED** | 依赖 N5。 |

### 2.1 上一轮（S0–S7）遗留、本轮仍未闭环

- **task-5 / S3（F4）**：Phase A–D 已完成；**Phase E 未做**（`scripts/e4/prereg-production-e2e.mjs`
  的 `runId`/`attempt`/`platform`/`dualBuild`/`evidenceRoot` 字段）。`§7 item 6`（真实内容闭环）
  **明确 NOT MET**：真实 `reg-12-csv-parse` 记录 11/13/20/28 次模型调用 vs 3-turn 脚本，
  真实内容 case 会在第 4 次调用撞 `OFFLINE_SCRIPT_EXHAUSTED`。**不要**靠把 turn 扩到 30 来"通过"。
- **task-10 / S6b**：request/attempt 与 tool-dispatch journal 的交叉绑定，在 N3 产出 journal
  之前**无法完成**；当前诚实状态是 `REQUEST_DISPATCH_JOURNAL_NOT_BOUND`，**不要**flatten 成 PASS。

## 3. N1 —— worker 终止路径统一（F30-1）✅ DONE

- **实现 commit**：`2e818af`（`fix(cli): N1/F30-1 — every worker termination path converges on one finalize`）。
- **缺陷**：`launchArmWorker` 只有 **timeout** 路径会 abort transport。worker 非 timeout 退出
  （`exit(2)`、stdout EOF、child `error`、结果帧后 child 不退出）时，driver 清掉 timer、返回
  `ARM_WORKER_FAILED`，而活跃 provider 的 `AbortSignal` 仍是 `false`，`for await` 永久停住。
  两个结构性成因：`streamOwner` 只有一个槽且 `serviceModelRequest` 无检查地**覆盖**它；
  帧循环在 EOF / result sentinel 处**不 abort 任何东西**。
- **修复**：唯一的幂等 `finalize(reason)`，所有路径收敛；**一个 worker 只允许一个活跃 model
  request**（第二个以 `ARM_WORKER_PROTOCOL_VIOLATION` 拒绝，而不是覆盖 controller）；
  `finally` 覆盖普通 exit/EOF；声明并导出 cleanup 上限；异步 stdin error 通道被记录而非吞掉。
- **反例（实测，生产 executor seam）**：
  - 修复前：`providerSignalAborted: false`、`launchPromiseSettled: false`（watchdog 触发）
  - 修复后：`providerSignalAborted: true`、`launchPromiseSettled: true`、
    `ARM_WORKER_FAILED … exit=2, termination=worker_exit, cleanupMs=1`
- **命令与结果**：`npx vitest run apps/cli/src/n1-worker-lifecycle.test.ts` → **15 passed**；
  `npx vitest run apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts` → **7 passed**；`npx tsc -b` → **exit 0**。
- **证据**：`docs/evidence/n1-worker-lifecycle.md`、`apps/cli/src/n1-worker-lifecycle.test.ts`。
- **注意**：该任务由 `worker-lifecycle` 队友执行，其回合在修复与测试变绿后、提交前被操作者停止；
  Lead 独立复跑了上述测量、删除临时 red probe 并提交。

## 4. N4 —— pricing expiry 接入物理发送与 retry（F30-5）✅ DONE，但 guard 未接入 CLI

- **实现 commit**：`e243a40`（`fix(evaluation): N4/F30-5 — pricing expiry gates every physical send and retry`）。
- **缺陷**：`createFormalBudgetedProvider` 只收到 `usdMicrosPerCall` 与 campaign deadline，
  **没有价格有效期输入**；admission 也只传金额。**金额无法表达窗口**，因此"admission 时有效、
  retry 时已过期"与"价格仍然有效"不可区分，retry 会作为真实的第二次计费请求发出。
  （`AUTHORIZATION_EXPIRED` 是**授权**窗口，不是价格窗口，不能替代。）
- **修复**：窄类型 frozen `PricingExecutionGuard`（amount / basisDigest / sourceKind / currency /
  `issuedAtMs` / `expiresAtMs` / covered vs required token ceiling / 可选 expectedBasisDigest）
  + 纯函数 `checkPricingExecutionGuard(guard, nowMs)`，在 wrapper 的**两个真实边界**执行：
  首次发送（**在**任何 cost/ledger reservation **之前**，被拒时不留下悬挂）与 retry
  （在 retry 的 reservation 之前、发出之前）。分类码 `PRICING_WINDOW_EXPIRED` /
  `PRICING_NOT_EXECUTABLE` / `PRICING_COVERAGE_INSUFFICIENT` / `PRICING_BASIS_DRIFT`，
  计入 `stats.pricingRefusedCalls`，因此 pricing 停止**不会**被误认为 provider error 而进入 retry。
  依赖方向保持：`packages/evaluation` **不** import `apps/cli`（传窄类型快照）。
- **命令与结果**：Lead 独立复跑 `tool-call-efficiency-pricing-send-guard.test.ts` +
  `tool-call-efficiency-pricing-basis-wiring.test.ts` → **25 passed**；作者报告 7 个目标文件 144 passed、
  `tsc -b` exit 0；修复前 RED 8 failed | 1 passed（仅控制组）。
- **证据**：`docs/evidence/n4-pricing-send-guard.md`。
- ⚠️ **未闭环的遗留（重要，已并入 N2 的验收表）**：guard 在**被传入时**才生效，
  且已通过 shipped gate 端到端证明；但 **CLI 目前不构造 guard**（`prereg-command.ts` /
  `prereg-production-runner.ts` 在 N4 中为只读）。因此当前状态是
  **"proven but NOT ARMED"**：真实 CLI 入口上还没有价格有效期检查。
  关闭它需要在 release composition root 用**同一份**已解析 selection 构造 guard，
  并补一个"已 ADMITTED 但价格窗口过期 ⇒ 拒绝发送、transport = 0"的组合测试。
  **只有 guard 对象存在不算闭环。**

## 5. 下一轮最小起点（按依赖顺序，不要并行改同一文件）

1. **N2（下一步，最高优先）** —— `apps/cli/src/{main,provider,prereg-command,prereg-production-runner}.ts`：
   (a) 统一一个已解析 selection，使 identity / observer / pricing / provider factory / capability **同源**；
   (b) `createOfflineScriptedProvider` 的 `turn` 游标必须属于 **armRun/conversation**，
       不能是 provider 实例级（否则 baseline 吃掉 0/1、candidate 从 2/3 开始并越过 3-turn profile）；
       **不要**简单移进 `createClient`（driver 每个 model request 都建 client，会把每次请求重置到第 1 步）；
   (c) **接入 §4 的 pricing guard**（同一 selection 构造，勿二次读 env）。
2. **N3** —— 生产 dispatch journal（版本化 schema）+ 严格关联校验。当前
   `bindRequestDispatchJournals` 会把重复 ID / 错误 arm / `outcome='banana'` 判为 `MEASURED`，
   又要求 tool reservationId 等于 model reservationId（真实独立 `b:tool:1` 反而 UNBOUND），
   且空 reservations 无覆盖声明仍判 `MEASURED`。**先补行为反例，再修 producer 与 verifier。**
3. **N5** —— 干净 checkout 上真实构建 pair、formal schedule、4 内容变体、build 交叉绑定。
4. **N6** —— 同 SHA 双平台 required levels（`fixtureProtocolReady` + `realBuildOfflineReady` +
   `budgetEvidenceReady`）、`resolveEvidenceRoot` 不得优先命中 cwd 陈旧 bundle、状态文档收尾。

## 6. 执行约定（每项任务必须遵守）

1. 先读根 `AGENTS.md` 与 `plan(20260930-061557).md` 对应章节；记录 HEAD 与工作树状态。
2. **Runtime Freeze (P38.4-11)**：Runtime 改动需至少满足一项——确定性正确性 bug（有复现）、
   安全漏洞、发布完整性缺陷、可证明源自 Harness 基础设施的 benchmark 失败、实测性能回归。
   仅"模型质量差"**不构成**改 Runtime 的许可。不要大规模重构、重命名或清理历史报告。
3. 负例从**已通过的正例**派生，一次只改**一个**维度；不能用"另一项缺失导致提前失败"假装目标门禁生效。
4. 必须用**真实生产入口**（真实 CLI / campaign / verifier）。helper 测试**不能**替代生产接线
   （N4 的验收明确点名了这个陷阱）。
5. 默认离线：不读真实 key、不访问真实 endpoint、不跑付费实验、不做 promotion。
   不得新增能从 argv/env/JSON/marker 注入任意非付费 capability 的通道。
6. **省略字段 = NOT_PROVEN；伪造字段 = F3 缺陷。** 数值未知写 `null`，**绝不填 0**。
   readiness 不得由 exit=0、日志字符串或自报 PASS 生成。
7. 完成度用 DONE / BLOCKED / PARTIAL / NOT_RUN 如实标注；未运行写 NOT_RUN，**不要**用
   "已实现但未验收"冒充 DONE。
8. 跑全量期间**不得并发编辑被跟踪文件**（工作树瞬时变脏会让干净树门禁假失败）。

### 6.1 已知陷阱（踩过的坑，别重踩）

- **`pnpm test` = `tsc -b && vitest run`，且排除若干套件。**
  `packages/evaluation/src/r97-mutation-check.test.ts` **不在**排除列表里——曾经只跑过滤子集，
  漏掉它，直接导致 CI 五个 job 失败。**跑整套，不要只跑你以为相关的那部分。**
- **vitest 把 `-t` 当正则**：`[EPERM-4]` 是非法字符类，会让 vitest 在**启动时**崩溃。
  用转义 `EPERM\-4` 或短唯一前缀。
- **干净树门禁是鸡生蛋**：gate 拒绝脏树，而编辑就会弄脏。用隔离 `git worktree add --detach`
  提交后再 `git diff <base> HEAD -- <file> | git apply` 带回。
  **绝不 `git stash`——它会静默测试错误的代码。**
- **接受纪律**：只在**当前 HEAD** 上 workflow **completed** 且必需 job 成功时报告绿。
  `concurrency: cancel-in-progress: true` 意味着**每次 push 都会取消在飞的 run**，
  因此"被取代 SHA 上的绿"**不是**验收证据。**run 还是 `in_progress` 时不要宣布完成。**
- **只改文档的提交也会启动 run 并可能取消一次绿 run。** 若需为保住在飞的验收而暂缓提交，明说。
- **PowerShell**：不支持 heredoc；`-replace` 与 `git commit -m` 会破坏含 `$` 的文本——
  **总是**把提交信息写入文件并用 `git commit -F`。

## 7. 本次交接时的验证状态（如实记录）

- 当前 HEAD：`2e818af`（工作树干净）。
- N1 / N4 的定向测试与 `tsc -b` 已通过（见 §3、§4）。
- **全仓 `pnpm test` 在 `2e818af` 上 NOT_RUN**：本轮交接前未取得该 SHA 的全量结果，
  因此**不声称全仓门禁已绿**。
- **当前 HEAD 尚无 CI 结论**：最近一次全绿是本轮 4 个提交**之前**的 SHA，已被取代；
  下一次 push 会为 `2e818af` 启动新 run，**必须**等它 completed 后再判定。

## Historical / superseded

以下内容会随新提交过期，仅作历史快照，**不得**用作新代码的验收证据。

- 上一轮收口实现 SHA 与运行号见 git 历史与 `docs/evidence/current-prereg-status.md` 的
  CURRENT 段；本轮 4 个未推送提交为 `7a095da` → `83f8ee8` → `e243a40` → `2e818af`。
- 最近一次全绿的双平台 workflow run 为 `36671123844`（8 个 job 全部 success，
  含 Windows/Ubuntu verify、双平台 closed loop、coverage、cold-start、dual-platform acceptance、
  release attestation）。该 run 对应的是**被取代的** SHA，不能证明后续提交。
- 历史 P35…P38、E4-R12…E4-R44 各批次结论见 `docs/E4-R*-report.md` 与 git 历史。
- `HANDOVER-20260928-E4-R0-R7.md` 已删除；其残留结论已并入
  `docs/evidence/current-prereg-status.md` 与 `docs/evidence/*.md`。
