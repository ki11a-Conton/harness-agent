# N3 — 生产 tool-dispatch journal 与严格 request/tool 关联（F30-4）

> 按 `plan(20260930-061557).md` §10 的统一格式撰写。

```text
任务：N3
状态：DONE
实现 commit：fix(e4): N3/F30-4 — a durable tool-dispatch journal and a strict request/tool binding
             （本文件随该提交一起落地，故无法自引用自身 full SHA；提交后由
              `git log -1 --format=%H` 取得，见 task-2 的完成报告。）
起始基线：00c8660a（docs: rewrite HANDOVER.md for the N1-N6 round and delete the stale E4-R0/R7 handover）
          提交时 HEAD 的父提交；N6/F30-7 的修复 213a63e9 位于起始基线与本次提交之间。
```

## 修复的问题（F30-4，P0）

**触发条件。** `scripts/e4/readiness-evidence-verify.mjs::bindRequestDispatchJournals` 对
tool-dispatch 侧只做**一个**判断：「存在一个对象，其 `reservationId` 非空且出现在 request
journal 里」。于是下列全部被判为 `budgetEvidenceReady = MEASURED`：

| 输入 | 旧行为（实测） |
| --- | --- |
| 重复的 dispatch reservation id | **MEASURED** |
| arm 与 schedule 矛盾的记录（arm 字段从未被读取） | **MEASURED** |
| `outcome='banana'`（未定义枚举值，任何非 null 即算 settled） | **MEASURED** |
| `reservations: []` 且无任何覆盖声明 | **MEASURED** |
| **真实独立**的 tool reservation id `b:tool:1` | **NOT_PROVEN** `DISPATCH_RESERVATION_UNBOUND` |

最后一行是同一缺陷的另一半：它要求 tool reservationId **等于**模型的 quota
reservationId，而这两者是**不同命名空间里的不同标识**，于是真实证据反而被拒。

**修复后的行为。** tool-dispatch 侧由一份**版本化**契约判定
（`scripts/e4/n3-dispatch-journal-contract.mjs`，schema tag
`e4-n3-tool-dispatch-journal-v1`）：必填字段与类型、**闭合的** settlement / refusal 枚举、
两个标识符各自的唯一性、**连续 1..N 的事件序号**与权威 `eventCount`、覆盖证明、
按**存在性**解析的 parent request/attempt，以及与该 durable ledger 的**计数守恒**。
tool id 与 model quota id **永不比较相等**；两者混用会被
`DISPATCH_ID_NAMESPACE_COLLISION` 拒绝。

**producer。** `packages/evaluation/src/n3-tool-dispatch-journal.ts` 在同目录、同
`withR97CampaignLock` 临界区、同 fsync-then-rename 原子替换协议下追加
`dispatch-journal.json`（与 `cost-budget.json` 并列），因此 r5 既有的
`dispatch*.json` 拷贝路径与 `findDispatchJournal` 的首选文件名都无需改动。
`reserve()` 在**返回之前**落盘受理事实；`settle` 在 ledger 落定**之后**落盘；
granted 无 settled 的崩溃窗口保留**上界**并报 UNKNOWN。

## 修改文件

| 文件 | 作用 |
| --- | --- |
| `packages/evaluation/src/n3-tool-dispatch-journal.ts` | **新增** producer：版本化 schema + durable、append-only、可恢复的 journal |
| `scripts/e4/n3-dispatch-journal-contract.mjs` | **新增** 共享的严格契约（readiness 与 R5 各复算**同一份**校验） |
| `apps/cli/src/n3-dispatch-journal.test.ts` | **新增** 13 个 F30-4 反例 + 5 个 producer 用例 + 1 个真实链路 E2E |
| `packages/evaluation/src/tool-call-efficiency-formal-run.ts` | `DurableToolDispatchBudget.reserve(request, context?)`、`coverage` 钩子、把 reserve/refusal/settle 写进 journal、admission 接线 |
| `apps/cli/src/prereg-arm-executor.ts` | 传 tool reservation id / orderIndex / parent request+attempt；arm run 前后 begin/close 覆盖 |
| `scripts/e4/readiness-evidence-verify.mjs` | 用共享契约替换旧的宽松判定；新增 `budgetFacts` 计数守恒；umbrella 码分级 |
| `scripts/e4/r5-real-formal.mjs` | KEPT-bundle verifier 用**同一**契约复算 dispatch journal；缺 journal 继续 NOT_PROVEN |
| `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | BIND-1..11 迁移到新契约；BIND-9/BIND-10 改写；BIND-11 由「无 producer」反转为「有 producer 且已接线」 |
| `scripts/e4/r97-mutation-check.mjs` | 登记 4 条 round `"N3"` + 1 条 round `"N6"`（F30-7）mutation |
| `packages/evaluation/src/r97-mutation-check.test.ts` | round 白名单加 `"N3"`/`"N6"`，加两条 exact-count 断言 |
| `packages/evaluation/src/index.ts` | 导出 N3 模块 |
| `docs/evidence/n3-dispatch-journal.md` | 本文件 |

## 反例：旧实现 vs 新实现（同一组 fixture）

旧实现取证方式（**未使用 `git stash`**）：把旧版 verifier 摘到仓库**外**再引用——

```powershell
git show 00c8660a:scripts/e4/readiness-evidence-verify.mjs | Set-Content -Path "$env:TEMP\old-verify.mjs" -Encoding utf8
node "$env:TEMP\n3-old-probe.mjs"
```

旧实现的实测输出（原样）：

```text
=== OLD implementation @ 00c8660a ===
  MEASURED   | DUPLICATE dispatch reservation id | null
  MEASURED   | WRONG ARM (arm field never read) | null
  MEASURED   | outcome='banana' (illegal enum) | null
  MEASURED   | EMPTY reservations, no coverage | null
  NOT_PROVEN | REAL independent tool id b:tool:1 | REQUEST_DISPATCH_JOURNAL_NOT_BOUND: DISPATCH_RESERVATION_UNBOUND: dispatch reservation b:t
```

同一组 fixture 在新实现下的结果（逐条为 `apps/cli/src/n3-dispatch-journal.test.ts` 的断言）：

| 维度 | 旧实现 | 新实现 | 新码 |
| --- | --- | --- | --- |
| 重复 dispatch / tool reservation | MEASURED | NOT_PROVEN | `DISPATCH_DUPLICATE_DISPATCH_ID` / `DISPATCH_DUPLICATE_TOOL_RESERVATION` |
| 错误 arm | MEASURED | NOT_PROVEN | `DISPATCH_EVENT_ARM_MISMATCH` |
| `outcome='banana'` | MEASURED | NOT_PROVEN | `DISPATCH_SETTLEMENT_INVALID` |
| 空 reservations 且无覆盖声明 | MEASURED | NOT_PROVEN | `DISPATCH_JOURNAL_NO_COVERAGE` / `DISPATCH_JOURNAL_EMPTY_UNCOVERED` |
| 真实独立 `b:tool:1`（经 parent 绑定） | NOT_PROVEN（误判） | **MEASURED** | — |

**是否真正经过生产路径：是。** 反例与正向用例都不依赖 helper 伪造：正向 E2E 走的是
真实 `CostBudget` + 真实 `openR97BudgetLedger` + 真实 `createFormalBudgetedProvider`
+ 真实 `createDurableToolDispatchBudget` + 真实 `createPreregArmExecutor` + 真实隔离
worker 子进程 + 真实 `ToolOrchestrator` 分发点；readiness 只从落盘的原始字节重算。

## 实际命令与测试结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run apps/cli/src/n3-dispatch-journal.test.ts` | **19 passed (19)** |
| `npx vitest run apps/cli/src/r5-formal-gate.test.ts` | **25 passed (25)** |
| `npx vitest run apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | **42 passed (42)** |
| `npx vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts apps/cli/src/r0-f5-pricing-declaration-gaps.test.ts` | **48 passed (48) / 2 files** |
| `npx vitest run packages/evaluation/src/r97-mutation-check.test.ts` | **35 passed (35)** |
| `npx tsc -b` | **exit 0** |

未运行项（如实记录）：全量 `pnpm test` **NOT_RUN**（本机 Node v24.14.0 与 CI 的
node 22 存在环境差异，且 `r97-driver-closed-loop` / `r97-arm-worker-contract` 在本机
分别需要 ~264 s / ~304 s；按 Lead 指示只用定向测试）。CI 在起始基线 `00c8660a` 上的
8 个 job 全绿（run `36688955701`）。

## 实际 tool dispatch 数

真实 E2E 中 **1 次真实 dispatch**：模型一次 `completed` 响应声明了 **2** 个 tool call，
而 campaign cap = 1，因此 journal 恰好 3 个事件、`eventCount = 3`：

```text
reserve_granted:null
settled:dispatched
reserve_refused:null          # refusalReason = TOOL_BUDGET_EXHAUSTED
```

`ToolOrchestrator` 只在通过全部 fail-closed 闸门后、tool body 运行前 reservation，
因此「模型声明 2 次」与「实际 dispatch 1 次」在证据里是可区分的：被拒项以
`reserve_refused` 可见，且**不计入消费**。

## budget / journal / manifest 派生计数

| 来源 | 字段 | 实测值 |
| --- | --- | --- |
| dispatch journal | `eventCount` | 3 |
| dispatch journal | `coverage.armRuns.length` | 1 |
| dispatch journal | `coverage.armRuns[0].reserveFrames` | 2 |
| dispatch journal | `coverage.armRuns[0].settleFrames` | 1 |
| dispatch journal | `coverage.armRuns[0].closedAtMs` | 非 null（覆盖已闭合） |
| durable ledger | `charged.toolCalls` | 1 |
| durable ledger | `reserved.toolCalls` | 0 |
| 模型侧（provider 统计） | `declaredToolCalls` | 2 |
| request journal | `entries.length` | 1（`<armRunId>:r1`，attempt 0） |
| readiness 重算 | `toolDispatch.reserveGranted / reserveRefused / settledDispatched / dispatchCount` | 1 / 1 / 1 / 1 |
| manifest | `armBuildDigest` / `armEntrySha256` | 各 64-hex |
| manifest | 字节一致性 | `manifestBytes === stableStringify(manifest) + "\n"` |

计数守恒（由 verifier 重算，不是自报）：
`charged.toolCalls == dispatched + unknown`（1 == 1 + 0）且
`reserved.toolCalls == granted-but-unsettled`（0 == 0）。

**三种 ID 各自独立**：`toolReservationId = <armRunId>:tool:1`、
`dispatchId` = durable `CostBudget` 的 tool 维度 reservation id（两者不等，已在测试中
断言）、模型 quota reservation id 仅通过 `parentRequestId = <armRunId>:r1` +
`parentAttemptId = 0` 的**存在性**关联。

## mutation 表（自动化载重性保护）

5 条已登记；`packages/evaluation/src/r97-mutation-check.test.ts` 的锚点唯一性校验
（`anchorOccurrences`，CRLF 归一化）与 round exact-count 断言均通过（35/35）。

| id | round | 目标文件 | 绑定测试 | 结果 |
| --- | --- | --- | --- | --- |
| `n3-only-checks-id-existence` | N3 | `scripts/e4/n3-dispatch-journal-contract.mjs` | `an omitted field is never read as a value` | **KILLED** |
| `n3-any-outcome-counts-as-settled` | N3 | 同上 | `an undefined settlement value is refused by the closed enum` | **KILLED** |
| `n3-does-not-check-arm` | N3 | 同上 | `a dispatch attributed to the WRONG ARM is refused` | **KILLED** |
| `n3-does-not-check-complete-coverage` | N3 | 同上 | `a real zero-tool run passes ONLY with an exported coverage proof` | **KILLED** |
| `f30-7-cwd-first-evidence-root` | N6 | `scripts/e4/dual-platform-acceptance.mjs` | `DP-W` | **KILLED** |

每条锚点在当前文件中**恰好出现 1 次**；施加后定向测试 exit 1（基线同测试 exit 0），
测试文件被**字节级还原**并校验 sha256：contract 文件 `bd11e0a50a59`、
dual-platform 文件 `58ae2400b07d`（前后一致）。

F30-7 那条的 `replace` **不是**照抄 n6-resolver 草稿里的 `outcome(resolve(recorded), "cwd")`，
而是按当前 `resolveEvidenceRoot` 的真实返回形状写：复用该文件自己的
`outcome(...)` 工厂与 `tried`/`candidates` 审计数组，使变异后的 verdict **形状**仍是真实
形状（否则测的是形状而不是行为），并复现 pre-fix 的 cwd 优先扫描顺序。

## Windows / Ubuntu

- **Windows**：本机 Windows + PowerShell 7.6.5（`pwsh.exe`，`7.6.5` / `Core`）。
  上表全部命令与结果均为本机实测；artifact 为 `.ci/n3-dispatch-journal-scratch/`
  下的临时运行目录（git 忽略，按测试生命周期清理）与 `.ci/r5-evidence`（r5 门禁自建）。
- **Ubuntu**：**NOT_RUN**（本机只有 Windows；Linux 冷启动与正式双平台验收由 GitHub Actions 完成）。
  本任务未 push，因此没有本 SHA 的 CI URL / run / attempt / artifact。

## 付费模型请求数

**0。** 全程离线：E2E 使用的模型是仓库内的脚本化 provider，`createFormalBudgetedProvider`
只做预算与 journal 记账，**不打开任何 transport**。

## 离线 physical generate 数

**1**（E2E 中脚本化 provider 的 `generate()` 被进入 1 次，对应 request journal 的 1 条
`<armRunId>:r1` 记录）。零网络、零付费。

## 未知消费 / 未结算项

**null（无）。** 本次 E2E 的 `charged.toolCalls = 1`、`reserved.toolCalls = 0`，
不存在未结算的上界。契约对 UNKNOWN 的规则是**明确**的：granted 而无 settled 事件
→ `DISPATCH_SETTLE_INCOMPLETE`，umbrella 为 `DISPATCH_UNKNOWN_RETAINED`，等级保持
NOT_PROVEN，**上界保留**，既不会被填成 `0` 也不会被写成 `not_executed`
（由 `N3 producer keeps an unsettled grant as UNKNOWN with its upper bound retained`
与 BIND-9 钉住）。

## 原始证据与可复验入口

- producer 原始文件：`<budgetDir>/dispatch-journal.json`（与 `cost-budget.json` 同目录；
  E2E 中为 `.ci/n3-dispatch-journal-scratch/e2e-*/budget/`）。
- 契约复算入口：`node -e` 导入 `scripts/e4/readiness-evidence-verify.mjs` 的
  `bindRequestDispatchJournals({ entries, scheduleArms, dispatchJournal,
  dispatchJournalFile, dispatchJournalProblem, budgetFacts })`；返回值中的
  `facts.toolDispatch` 即重算出的计数。
- bundle 复算入口：`node scripts/e4/r5-real-formal.mjs --verify <bundleRoot>`，
  dispatch journal 若存在则按**同一**契约校验，缺失则以 `DISPATCH_JOURNAL_MISSING`
  保持 NOT_PROVEN。
- 旧实现对照：`git show 00c8660a:scripts/e4/readiness-evidence-verify.mjs`。

## 剩余问题

1. **自动化 mutation gate 本体 NOT_RUN。** `scripts/e4/r97-mutation-check.mjs` 的
   pre-flight 在树不干净时以 `EXIT_DIRTY_TREE=4` 拒绝运行，而 N2 的 in-flight 文件
   （`main.ts` / `provider.ts` / `prereg-command.ts` / `prereg-production-runner.ts` /
   `n2-*.test.ts`）让工作树在本次会话中始终是脏的。因此 5 条 mutation 的
   **kill 结论是用手工 apply + 定向测试 + 字节级还原（sha256 校验）取得的**，
   **不是**自动化 gate 跑出来的。条目已登记并锚点校验通过，CI 在干净树上会真正执行它们。
2. **`prereg-production-e2e.mjs` 写的 `cost-journal.json` 不含 `charged.toolCalls` /
   `reserved.toolCalls`**（它只写 `{schemaVersion, journalSchemaVersion,
   chargedTotalTokens, entries}`）。计数守恒只能对**完整**拷贝
   `cost-budget.json`（r5 的路径）成立；对 e2e 路径的 bundle，契约会以
   `DISPATCH_BUDGET_TOOL_COUNTS_ABSENT` 保持 NOT_PROVEN，而不是假定 0。
   该 producer 不在本任务 write scope 内，**未改动**——这是一处明确的、fail-closed 的
   集成缺口，留给 N5/N6 收口。
3. **带重试的尝试归因是保守的。** 若一个逻辑请求发生过物理重试，producer 记
   `parentAttemptId` 无法证明是第几次物理尝试，契约以
   `DISPATCH_PARENT_ATTEMPT_AMBIGUOUS` 保持 NOT_PROVEN，而不是猜 `0`。
   离线脚本化 provider 不重试，故正向路径不受影响。
4. **`r5-real-formal.mjs` 的 `--setup-pair` 是死旗标**（Lead 已确认，声明于 L931、
   解析于 L942，无消费点），且本机 git 到 github 不通，因此 N3 的 bundle 证据走的是
   自建离线组合根 + r5 既有的 `dispatch*.json` 拷贝路径，**未**使用 `--setup-pair`。
   该旗标本身不在本任务 scope 内，未改动。
5. **`tsc -b` 的即时状态**：提交前实测 `exit 0`（n2-cli 已修掉
   `apps/cli/src/n2-script-scope.test.ts` 的两处 TS18048）。若提交时该文件再次被改脏，
   与本任务无关，不应据此阻塞本次提交。
```
