# HANDOVER.md — 未完成任务交接（Unfinished Work）

> 本文是**未完成任务**的交接清单，由执行 Agent 维护。
> 机器可推导的事实由 `pnpm docs:verify` 校验（包数量等）；已完成的发布真值以
> 各轮 `docs/E4-*-report.md` 与 exact-SHA CI attestation 为准，不在本文重复记录。
> 版权籍：`packages/（24 个包）` 是 docs:verify 的机器校验项，不得删除或改错数字。

## 当前状态速览

- 仓库规模：`packages/（24 个包）`（工作区包，均自带 package.json）。
- 当前执行计划入口：`plan.md` → `plan(20260912-180524).md`（E4-R36…R39，2026-09-12）。
- 已推送并 CI 通过的历史批次（截至本文件编写时）：
  - P35…P38、E4-R12…E4-R20、E4-R21…E4-R26：均已推送 origin/main 且其 SHA 的 CI 四 job 全绿，
    详见对应 `docs/E4-R*-report.md` 与各自 CI run 记录。
  - E4-R27 … E4-R31（2026-09-11 计划）：**已完成并已推送** origin/main；
    不再描述为"未提交/未推送"。四 job 全绿（含两平台 strict usage audit 与
    release attestation）。逐项结论见 `docs/E4-R27-report.md` … `docs/E4-R31-report.md`。
  - E4-R32 … E4-R35（2026-09-12 计划）：**已完成并已推送** origin/main；四 job 全绿。
    逐项结论见 `docs/E4-R32-report.md` … `docs/E4-R35-report.md`。
    （以上两行的 exact SHA / run-id 见文末 Historical 快照，避免在本文静态区嵌入会失效的数字。）
- 本轮计划（E4-R36…E4-R39，2026-09-12）状态：
  - R36（J01 首次恢复发现失败后可重扫、可自愈）✅ 本轮提交 `docs/E4-R36-report.md`
  - R37（J02 升级后不再收集旧目录故意失败夹具）✅ 本轮提交 `docs/E4-R37-report.md`
  - R38（J03 执行计划边界的有效正例与 promotion-loader 验收）✅ 本轮提交
    `docs/E4-R38-report.md`（验收补强，无生产修复）
  - R39（状态同步与最终门禁收口）⚠️ **PARTIAL** 本轮提交 `docs/E4-R39-report.md`：
    关闭矩阵 + 干净树门禁 + 远端 CI 只读核实已完成；**但冻结版本上的全仓 `pnpm test`
    未取得绿**（`e4-09` 生产 E2E 在全量并发下 3/3 判 INVALID，隔离 5/5 通过，根因未定），
    且本轮实现提交自身的 Windows CI job 两次尝试均失败。详见该报告第 5、6 节。
- 环境依赖项（不因计划完成而消失）：
  - 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
    （付费 benchmark 未请求，不为此造假或付费；勿把 mock/stub 隔离当真实 OS 证明）。
  - release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
  - **未关闭的真实缺口（R39 遗留，不是猜测性任务）**：冻结版本上全仓 `pnpm test` 不绿
    （`e4-09` 有效链在全量并发下判 `INVALID`，根因未定）、本轮 SHA 的 Windows CI 主门禁失败。
- 权威的"下一轮任务"清单：仅在有**真实 benchmark 失败、生产问题或明确用户需求**时才新建。
  下一轮的最小起点见 `docs/E4-R39-report.md` 第 8 节（复现优先、不做架构重写）。

## 已完成任务（按当前计划 E4-R36…R39 顺序）

### 1. E4-R36（J01）—— 首次恢复发现失败后能够重新扫描并自行恢复 ✅ 已完成

- 位置：`packages/core/src/runtime/session-actor.ts`（`drainFollowupsInner` /
  `discoverRecoverableTurns`）。
- 问题：`_recoverableChecked` 在 await **之前**被置 true，语义是"扫描已启动"却当"发现已完成"用。
  首次扫描的暂时读取故障（`listRecoverable` / `store.getTurn` / 终态分支的 recovery record 查询）
  会（a）把异常抛成 drain 拒绝、（b）永久标记 checked → 无 timer、无重扫，promoted prompt 滞留在
  无 owner 的非终态 turn 上、（c）部分扫描半提交（读到 T1 后 T2 失败 → T2 永久丢失）。
- 修复：发现完成态只在**完整成功路径**提交；失败 ⇒ fail-closed + 复用既有 `scheduleStoreRecheck()`
  有限自愈唤醒 + **本次 pass 到此为止**（新 followup 不得越过未确认的旧恢复任务）；扫描改为
  **原子提交**（局部缓冲，整段无异常才入队，并按已入队 id 去重）。保留 R32 既有 intent 退避 /
  lease 清理 / 外部 lease 尊重 / close 语义。
- 验收：`recovery-durable.test.ts` **29/29**（新增 R36-a…f 6 例；修复前 6/6 失败，回退源码复验判别性）；
  相关 followup/crash 套件 7 files / 74 tests；`test:race` 23/23；`tsc -b` exit 0。
  详见 `docs/E4-R36-report.md`。

### 2. E4-R37（J02）—— 升级后不再收集旧目录的故意失败夹具 ✅ 已完成

- 位置：`vitest.config.ts` + `apps/cli/src/e4-r24-final-result-protocol.test.ts`。
- 问题：`.gitignore` 不是 Vitest `exclude`。旧代 `apps/cli/src/e4-r24-fixture-*.test.ts` 残留仍落在根
  `include` 内并被**收集**，一次正式全量运行会把它当真实失败（318 files / 1 failed 实测）。
- 修复：根配置按生成文件名模式窄范围排除（`...configDefaults.exclude` 显式展开以保留框架默认值）；
  不排除全部 e4-r24 / 全部 apps/cli / 正式协议测试；无清理脚本（残留存在时即验收通过）。
- 验收：修复前 `vitest list` 能列出探针残留，修复后为空；显式指名残留仍 `No test files found`；
  `e4-r24-final-result-protocol.test.ts` **5/5**；全局收集集合有/无该规则**均为 5755 个测试点**
  （无附带损害）；`tsc -b` exit 0。详见 `docs/E4-R37-report.md`。

### 3. E4-R38（J03）—— 补齐执行计划边界的有效正例与 loader 验收 ✅ 已完成（验收补强）

- 位置：新增 `packages/evaluation/src/e4-r38-execution-plan-boundary.test.ts`；
  修正 `packages/evaluation/src/e4-r33-execution-plan-scale.test.ts`。**无生产代码改动**。
- 问题（验收缺口，非生产漏洞）：R33-f 用 `planDigest: "0".repeat(64)` 占位，且"正对照"只断言
  "没有 planned-sample cap issue"——从未证明有效计划通过，也完全没有覆盖 promotion loader。
- 修复：新 harness 用真实入口（artifact → evaluator → envelope → loader）构造**完整绑定**的基准对：
  R38-a 断言 `violations===[]` + `ACCEPT` + `loader.ok===true`；R38-b 从同一基准只改容量因子
  （digest 按修改后计划重算）→ evaluator 恰 1 条容量违规、loader 恰 2 条（容量 + 决策非 ACCEPT）；
  R33-f 改为真实 digest + `ACCEPT` 断言。
- 验收：R38 **3/3**；R33 **7/7**；R27 18 / R28 14 / R33 7 / R38 3 = **42 passed**；
  `packages/evaluation` 全包 83 files / 1022 tests；`tsc -b` exit 0；占位 digest 探针使 R38-a 与
  R33-f 失败（判别性）。详见 `docs/E4-R38-report.md`。

### 4. E4-R39 —— 状态同步、完成最终门禁并结束本轮 ⚠️ PARTIAL

- 关闭矩阵 J01…J04（问题 → 实际符号/配置 → 测试名 → 实施提交 → 被测版本 → 结果 → 限制）。
- 修正 plan / HANDOVER / README（中英）的过期状态：R32…R35 已推送，不再是"进行中/待推送"。
- 在静止的干净代码版本上跑门禁（`testedSourceSha = 01c4ec74`，工作树与它逐字节一致）：
  `pnpm typecheck` **0**、`pnpm docs:verify` **ALL CHECKS PASS 0**、
  `test:race` 23 / `test:security` 2133 / `test:protocol` 52 / `test:chaos` 12 全绿；
  **但 `pnpm test` 退出码 1**：318 文件 / 1 failed | 5738 passed | 1 skipped (5740)，
  3 次运行 3 次同一失败（`e4-09-production-e2e.test.ts` 的 `buildRealChain` 判 `INVALID`）。
  该文件隔离运行 5/5 通过（4 次）、`apps/cli/src` 整目录 2/2 通过、与两个最可疑干扰源两两并发
  也通过；根因**未定**（已排除 CPU 50% 负载与人为瞬时脏树两个假设）。**不声称全仓门禁已绿。**
- 只读核查本轮实现提交自身的 CI（不用旧 SHA 的绿灯证明新代码）：
  `01c4ec74` 的 run `34687657690` —— Ubuntu 主门禁 + coverage 成功，**Windows 主门禁失败
  （两次尝试、失败点不同）**，release attestation skipped。
- 交付：`docs/E4-R39-report.md` + 一页结论（`docs/E4-STATUS.md`）。

## 执行约定（每项任务必须遵守）

1. 先读 AGENTS.md、`plan.md` 指向的当前计划、相关 tasks 文件；记录 HEAD 与工作树。
2. 不覆盖用户未提交改动；需要隔离时用 worktree，不 reset 用户工作树。
3. Runtime FROZEN：本轮仅 **R36** 因 J01 的确定性正确性复现获得最小**恢复发现**修改范围；
   其他任务不授权改造 Runtime。保留 ToolOrchestrator、PermissionEngine、SandboxManager、
   Verification、安全隔离与晋升资格门禁。
4. 负例从已通过正例派生，一次只改目标条件；不能用"另一项缺失导致提前失败"来假装
   目标门禁生效。
5. 用真实生产入口（evaluator / promotion loader / release / CLI）；helper 测试不代替
   生产接线。
6. 默认离线；不调用真实付费 provider；不降低测试门槛、不手改 ACCEPT、不删除失败用例、
   不伪造证据。
7. PASS 需逐条验收证据；未运行写 NOT_RUN；部分完成写 PARTIAL；已有修复先验证再写
   NOT_NEEDED。
8. 一项任务完成后停止扩大范围；同一最终版本的全仓门禁集中在 R39 完成。
9. 跑全量期间**不得并发编辑被跟踪文件**：工作树瞬时变脏会让干净树门禁假失败；
   并且必须 `env -u NODE_OPTIONS` 运行测试（宿主 safe-delete shim 会拦测试自身的夹具清理）。

## Historical / superseded

早期 P35…P38 批次的逐项历史说明、能力矩阵快照语义、以及"benchmark 命令成功 = 质量
通过"的提法均已由后续轮次取代，不再在此重复；如需追溯，参见 git 历史、`plan.md`
历史计划段与对应 `docs/E4-*-report.md`。本文件的权威范围是**未完成任务交接**，不当作
发布证据。

### 已推送实现与 CI 快照（会随新提交过期，仅作历史）

- E4-R27…R31 收口实现 SHA：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`（origin/main）。
- 该 SHA 的 CI：run `34666585483`，四个 job（Ubuntu 主门禁、Windows 主门禁、
  Ubuntu coverage、release attestation）成功；两平台 strict usage audit step 均成功。
- E4-R32…R35 实现 SHA：`d212d977`（R32/R33/R34 实现 + R35 关闭矩阵与全仓门禁收口），
  状态文档补记 SHA：`a7950fa1`（HANDOVER/README/plan 轮换 + R31 报告 SUPERSEDED 指引）。
  两个 SHA 的 CI run 分别为 `34685604645` 与 `34685817447`，四个 job 均成功
  （Ubuntu 主门禁、Windows 主门禁、Ubuntu coverage、release attestation；两平台
  named strict usage audit step 成功）。本轮**未下载 artifacts 逐字节重放** release 证据，
  只核实 job/step 状态。
- 注意：以上是历史事实。新提交后请以**该提交自己的 CI run** 为准；
  `testedSourceSha` 与 `documentationCommitSha` 严格区分，不能用旧 run 证明新代码。
