# HANDOVER.md — 未完成任务交接（Unfinished Work）

> 本文是**未完成任务**的交接清单，由执行 Agent 维护。
> 机器可推导的事实由 `pnpm docs:verify` 校验（包数量等）；已完成的发布真值以
> 各轮 `docs/E4-*-report.md` 与 exact-SHA CI attestation 为准，不在本文重复记录。
> 版权籍：`packages/（24 个包）` 是 docs:verify 的机器校验项，不得删除或改错数字。

## 当前状态速览

- 仓库规模：`packages/（24 个包）`（工作区包，均自带 package.json）。
- 当前执行计划入口：`plan.md` → `plan(20260912-021843).md`（E4-R32…R35，2026-09-12）。
- 已推送并 CI 通过的历史批次（截至本文件编写时）：
  - P35…P38、E4-R12…E4-R20、E4-R21…E4-R26：均已推送 origin/main 且其 SHA 的 CI 四 job 全绿，
    详见对应 `docs/E4-R*-report.md` 与各自 CI run 记录。
  - E4-R27 … E4-R31（2026-09-11 计划）：**已完成并已推送** origin/main；
    不再描述为"未提交/未推送"。四 job 全绿（含两平台 strict usage audit 与
    release attestation）。逐项结论见 `docs/E4-R27-report.md` … `docs/E4-R31-report.md`。
    （exact SHA / run-id 见文末 Historical 快照，避免在本文静态区嵌入会失效的数字。）
- 本轮计划（E4-R32…E4-R35，2026-09-12）状态：
  - R32（H01/H02 恢复存储组合故障 + intent 退避）✅ 本轮本地提交
    `docs/E4-R32-report.md`
  - R33（H03 execution-plan 规模校验先于危险操作）✅ 本轮本地提交
    `docs/E4-R33-report.md`
  - R34（H04 隔离故意失败的测试夹具）✅ 本轮本地提交 `docs/E4-R34-report.md`
  - R35（提交后状态更新与最终验收收口）🔄 进行中 —— 关闭矩阵 + 全仓门禁 +
    干净树 promotion E2E + 远端 CI 核查；交付 `docs/E4-R35-report.md` 与
    `docs/E4-STATUS.md` 一页结论。
- 环境依赖项（不因计划完成而消失）：
  - 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
    （付费 benchmark 未请求，不为此造假或付费；勿把 mock/stub 隔离当真实 OS 证明）。
  - release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
- 权威的"下一轮任务"清单：仅在有**真实 benchmark 失败、生产问题或明确用户需求**时才新建；
  本轮收口后无新增猜测性架构任务。

## 已完成任务（按当前计划 E4-R32…R35 顺序）

### 1. E4-R32（H01/H02）—— 恢复存储组合故障与 intent 退避 ✅ 已完成（本轮本地提交）

- 位置：`packages/core/src/runtime/session-actor.ts`（`releaseLease` /
  `recoverHead` 读取入口 / `_storeRecheckCount` 重置点 / 后台 callback 错误处理）。
- 问题：intent 写失败后 `releaseLease` 的 `getRecord` 再失败会跳过 `scheduleStoreRecheck`
  → 队头保留、`action=0`、`timer=0`、drain Promise 拒绝（H01）；连续 intent 失败时成功的
  `acquireLease` 每次提前清零退避计数 → 6 次延迟均 1000ms，与递增退避声明不符（H02）。
- 修复：清理与调度解耦（清理错误走 degraded channel，保留有限唤醒）；重检入口读取失败
  同样安排有限重检并 fail-closed；退避计数在**本轮严格持久化（lease + intent）成功后**重置；
  后台 callback 局部错误处理，不吞错、不递归立即 drain。
- 验收：`recovery-durable.test.ts` **23/23**（含 R32 新增 4 例）；`tsc -b` exit 0；
  `test:race` 23/23；runtime 全量 34 files / 410 tests PASS。详见 `docs/E4-R32-report.md`。

### 2. E4-R33（H03）—— execution-plan 规模校验先于危险操作 ✅ 已完成（本轮本地提交）

- 位置：`packages/evaluation/src/execution-plan.ts`（`parseExecutionPlan`）。
- 问题：130000 唯一 case、repeat=1（低于 1000000 公开上限）在 `caseIds.push(...caseIdsRaw)`
  处抛 `RangeError: Maximum call stack size exceeded`；`caseIds.includes(k)` 为二次方成员查询；
  容量校验在执行完 O(caseCount) 绑定之后才发生。
- 修复：无实参展开的显式循环拷贝；`Set` 成员查询；容量护栏（乘积安全性 + 文档上限 + limit
  一致性）提前到数组类型/长度检查之后、任何逐 case 遍历之前，超出即结构化拒绝并提前返回。
  保留 digest 协议与 duplicate/missing/unplanned 语义。
- 验收：`e4-r33-execution-plan-scale.test.ts` **7/7**（含修复前 `RangeError` 判别性复现）；
  R28 14/14、R27 18/18 不回归；evaluation 全量 81 files / 1012 tests PASS；`tsc -b` exit 0。
  详见 `docs/E4-R33-report.md`。

### 3. E4-R34（H04）—— 隔离故意失败的测试夹具 ✅ 已完成（本轮本地提交）

- 位置：`apps/cli/src/e4-r24-final-result-protocol.test.ts` +
  新增 `apps/cli/test-infra/observation-vitest.config.ts` + `.gitignore`。
- 问题：故意失败的 `e4-r24-fixture-*.test.ts` 生成在 `apps/cli/src/`，落入根 vitest
  `include`；清理被打断后残留会被下一次全量测试当真实测试收集并失败（E4-R31 全量首跑已实际发生）。
- 修复：夹具移出根 include 至 `apps/cli/test-infra/observation-fixtures/`（路径无 `src` 段，
  且不在 `apps/cli/tsconfig.json` 的 `include:["src"]` 内）；子进程使用专用配置（仅选择夹具目录
  + 保留生产 reporter）；子进程断言同时校验退出码 / 实际执行测试数 / committed-dropped evidence；
  清理只删自身文件；`.gitignore` 覆盖新夹具目录。
- 验收：`e4-r24-final-result-protocol.test.ts` **4/4**；benchmark 回归 66/66 ×3；
  双份 `apps/cli` 并行不再互相干扰；`tsc -b` exit 0。另对两个波动断言做有限归因
  （E4-09 promotionEligible → 干净树门禁，已归因；finalizedPairs 4→3 → NOT_REPRODUCED）。
  详见 `docs/E4-R34-report.md`。

### 4. E4-R35 —— 提交后状态更新与最终验收收口 🔄 进行中

- 建立 R32…R34 关闭矩阵（问题 ID → 生产符号 → 测试名 → 实施 ref → 被测版本 → 结果 → 限制）。
- 修正 plan / HANDOVER / README 的过期提交状态；保留历史报告当时的日期与证据。
- 在最终代码版本上运行全仓门禁（typecheck / test / docs:verify / race / security /
  protocol / chaos / e3）；干净树完成 promotion E2E。
- 只读核查最终已推送实现 SHA 的 CI（不用旧 SHA 的绿灯证明新代码）。
- 交付：`docs/E4-R35-report.md` + 一页最终结论。

## 执行约定（每项任务必须遵守）

1. 先读 AGENTS.md、`plan.md` 指向的当前计划、相关 tasks 文件；记录 HEAD 与工作树。
2. 不覆盖用户未提交改动；需要隔离时用 worktree，不 reset 用户工作树。
3. Runtime FROZEN：R32 仅因已复现的确定性缺陷获得最小恢复调度修改范围；其他任务不授权
   重写 Runtime。保留 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。
4. 负例从已通过正例派生，一次只改目标条件；不能用"另一项缺失导致提前失败"来假装
   目标门禁生效。
5. 用真实生产入口（evaluator / promotion loader / release / CLI）；helper 测试不代替
   生产接线。
6. 默认离线；不调用真实付费 provider；不降低测试门槛、不手改 ACCEPT、不删除失败用例、
   不伪造证据。
7. PASS 需逐条验收证据；未运行写 NOT_RUN；部分完成写 PARTIAL；已有修复先验证再写
   NOT_NEEDED。
8. 一项任务完成后停止扩大范围；同一最终版本的全仓门禁集中在 R35 完成。

## Historical / superseded

早期 P35…P38 批次的逐项历史说明、能力矩阵快照语义、以及"benchmark 命令成功 = 质量
通过"的提法均已由后续轮次取代，不再在此重复；如需追溯，参见 git 历史、`plan.md`
历史计划段与对应 `docs/E4-*-report.md`。本文件的权威范围是**未完成任务交接**，不当作
发布证据。

### 已推送实现与 CI 快照（会随新提交过期，仅作历史）

- E4-R27…R31 收口实现 SHA：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`（origin/main）。
- 该 SHA 的 CI：run `34666585483`，四个 job（Ubuntu 主门禁、Windows 主门禁、
  Ubuntu coverage、release attestation）成功；两平台 strict usage audit step 均成功。
- 注意：以上是历史事实。新提交后请以**该提交自己的 CI run** 为准；
  `testedSourceSha` 与 `documentationCommitSha` 严格区分，不能用旧 run 证明新代码。
