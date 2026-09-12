# HANDOVER.md — 未完成任务交接（Unfinished Work）

> 本文是**未完成任务**的交接清单，由执行 Agent 维护。
> 机器可推导的事实由 `pnpm docs:verify` 校验（包数量等）；已完成的发布真值以
> 各轮 `docs/E4-*-report.md` 与 exact-SHA CI attestation 为准，不在本文重复记录。
> 版权籍：`packages/（24 个包）` 是 docs:verify 的机器校验项，不得删除或改错数字。

## 当前状态速览

- 仓库规模：`packages/（24 个包）`（工作区包，均自带 package.json）。
- 当前执行计划入口：`plan.md` → `plan(20260911-072937).md`（E4-R27…R31）。
- 已完成并**已推送**：P35…P38 收尾、E4-R12…R20（bcf34b7 CI 四 job 绿）、
  E4-R21…R26（run #112 / 2b2d3db 四 job 绿，attestation READY=true）。
- 已完成**本地提交、尚未推送**：E4-R27（f2f1b0b）、E4-R28（fb33ba9）。
- 已完成**工作树改动、尚未提交**：E4-R29、E4-R30、E4-R31（报告见 `docs/E4-R29-report.md`、
  `docs/E4-R30-report.md`、`docs/E4-R31-report.md`；代码改动文件
  `apps/cli/src/benchmark-command{,.test}.ts`、`packages/core/src/runtime/session-actor.ts`、
  `packages/core/src/runtime/recovery-durable.test.ts`；收口另加 `docs/E4-STATUS.md` 新增段、
  `plan.md`/`HANDOVER.md` 状态更新、R22/R25 superseded 指引）。
  推送后必须由**新 SHA 的新 CI run** 确认，testedSourceSha 与
  documentationCommitSha 严格区分，不能用旧 run 代替。
- 当前计划（E4-R27…R31）**五项全部完成**（R27/R28 本地提交待推送；R29/R30/R31 工作树改动，
  未提交）。逐项执行的共同规则：离线、单因素、真实生产入口验证、逐条验收证据、诚实
  NOT_RUN/PARTIAL。收口结论见 `docs/E4-R31-report.md` 与 `docs/E4-STATUS.md`。
- 远端 CI = **NOT_RUN**（未授权 push）；下一阶段只有"真实 benchmark 失败、生产问题或
  明确用户需求"才新建任务。

## 已完成任务（按当前计划 E4-R27…R31 顺序）

### 1. E4-R29（G03）—— 二进制源码指纹：原始字节身份 ✅ 已完成（工作树，未提交）

- 位置：`apps/cli/src/benchmark-command.ts` 的 `probeSourceSnapshot`。
- 问题：当前对文件 `readFileSync(path, 'utf8')` 后再哈希；无效 UTF-8 字节被解码为
  替换字符，不同原始字节（0x80 与 0x81）可能得到相同字符串 → 指纹碰撞。
- 复现锚点（离线，临时 git 仓库）：未跟踪 binary.bin 先写 `Buffer([0x80])` 计算指纹，
  再写 `Buffer([0x81])` 重新计算 → 当前 `equal: true`。
- 修复方向：直接以 **Buffer 原始字节**哈希（`hash.update(buffer)`）；路径/元数据用独立
  无歧义的结构编码；不可读与已删除分开处理（不可读 → unknown/error，不能伪装成
  missing 后宣称已验证）；保持 clean 快速路径与既有排除规则。
- 验收要点：0x80/0x81 不同指纹（tracked + untracked 都覆盖）；相同字节稳定；A→B
  文本/删除/staged 变化仍识别；读取错误返回未知；指纹变化经真实 execution identity
  影响 journal 归属；报告写明 symlink/submodule/ignored 覆盖边界。
- 输出：`docs/E4-R29-report.md`（含二进制负例修复前后值 + 复用行为测试）。

### 2. E4-R30（G04）—— 恢复存储暂时故障后的有限唤醒 ✅ 已完成（工作树，未提交）

- 位置：`packages/core/src/runtime/session-actor.ts` 的 acquireLease /
  persistRecoveryIntent 失败分支；`docs/E4-R25-report.md` 验收矩阵。
- 问题：bound nonterminal turn 遇 RecoveryStore 暂时拒绝写入时，`action=0`（fail-closed
  正确），但**没有 scheduler callback**——存储恢复后该 actor 不会自动重新 drain，
  必须等外部消息 / 显式 drain，不符合上一轮"无需新用户消息、有限唤醒"的验收要求。
- 复现锚点（离线，可切换故障的 store + 可记录/触发的 scheduler）：一次 drain 后
  `scheduled: 0, calls: 0`。
- 修复方向（Runtime Freeze 例外：已复现的确定性正确性/活性缺陷，只做最小恢复调度修复）：
  暂时错误安排**有下限的退避/重检**，每 actor 同时至多一个有效重试 timer；回调执行前
  重新读 durable 状态；重检不消耗模型 action 的 attempt budget；开始 action 前仍要求
  lease/intent 已持久化；close/unload 取消 timer，旧 callback 不得复活已关闭 actor。
- 验收要点（R25 报告的"有限唤醒已验收"引用需修正，保留其 marker-loss 修复的真实历史：
  故障时 provider/action 调用数 0、prompt 不 consume、T1 不 shift；存储恢复并触发
  callback 后无需新消息即可完成；lease/intent/CAS/有效外部 lease 分别正负例；durable
  turn 读取未知时不危险重试；长期故障有界退避。
- 输出：`docs/E4-R30-report.md`，并修正 `docs/E4-R25-report.md` 的过度关闭声明
  （旧报告保持被测日期/SHA，加 superseded 指引，不改写旧证据）。
- **验收结果**：新增 `scheduleStoreRecheck()`（每 actor 至多 1 个 timer，延迟
  `min(1000×2ⁿ, 30000)`，回调重读 durable 状态、不消耗 attempt budget、close 后不复活）；
  `acquireLease` / `persistRecoveryIntent` 失败分支接入；`durableTurnIsTerminal` 改三态
  （读取失败 → `"unknown"`，不再当作「已确认非终态」）。`recovery-durable.test.ts`
  **19/19**（+7 例）；修复前同一过滤 **6 failed \| 1 passed**，复现锚点
  `scheduled:0, calls:0`。`packages/core/src/runtime` **34 files / 406 tests** PASS，
  `tsc -b` exit 0。R25 报告已加 superseded 指引（marker-loss 结论保留）。

### 3. E4-R31 —— 独立验收与计划收口 ✅ 已完成（2026-09-12）

- 输出：`docs/E4-R31-report.md`（G01…G04 关闭矩阵 + 全仓门禁实测 + 诚实 NOT_RUN）
  + 一页最终状态（`docs/E4-STATUS.md` 新增段）。`plan.md` 保持唯一索引。
- 建立 G01…G04 的准确关闭矩阵（问题 → 生产实现符号 → 修复 commit → 正常正例 →
  单因素负例 → 被测 SHA → 结果 → 限制）。
- 重新执行四类复现（G01 18/18、G02 14/14、G03 4/4、G04 7/7，全部 PASS）。
- 运行 `pnpm typecheck`（0）、`pnpm test`（1：唯一失败 = 4 例干净树门禁，脏工作树下预期）、
  `pnpm docs:verify`（ALL CHECKS PASS，0）及 race 23 / security 2133 / protocol 52 / chaos 12
  （均 0）；记录真实命令/退出码/日志，未手填测试数量。
- 检查 release bundle 复核（`release-command.test.ts` 22/22）、命名运行观察审计
  （`e4-r24-final-result-protocol.test.ts` 3/3）、Windows 平台门禁（本机 win32 全绿）未回退。
- 修正 R22 数字校验与 R25 唤醒的过度关闭（均加 superseded 指引，旧证据未改写）。
- **未授权 push/CI**：远端标 **NOT_RUN**（R29/R30 保持工作树；推送后须由新 SHA 的新 CI run 确认）。

## 环境依赖项（不因计划完成而消失）

- 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
  （付费 benchmark 未请求，不为此造假或付费；勿把 mock/stub 隔离当真实 OS 证明）。
- release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
- E4-R27 / E4-R28 尚未推送：推送后需新 CI run 确认（含 Windows docs gate 的 CRLF
  契约继续被验证）。

## 执行约定（每项未完成任务必须遵守）

1. 先读 AGENTS.md、`plan.md` 指向的当前计划、相关 tasks 文件；记录 HEAD 与工作树。
2. 不覆盖用户未提交改动；需要隔离时用 worktree，不 reset 用户工作树。
3. Runtime FROZEN：G04 允许最小恢复调度修复；G01…G03 不授权重写 Runtime。
4. 负例从已通过正例派生，一次只改目标条件；不能用"另一项缺失导致提前失败"来假装
   目标门禁生效。
5. 用真实生产入口（evaluator / promotion loader / release / CLI）；helper 测试不代替
   生产接线。
6. 默认离线；不调用真实付费 provider；不降低测试门槛、不手改 ACCEPT、不删除失败用例、
   不伪造证据。
7. PASS 需逐条验收证据；未运行写 NOT_RUN；部分完成写 PARTIAL；已有修复先验证再写
   NOT_NEEDED。
8. 一项任务完成后停止扩大范围；收口时再跑全仓测试与相关门禁。

## Historical / superseded

早期 P35…P38 批次的逐项历史说明、能力矩阵快照语义、以及"benchmark 命令成功 = 质量
通过"的提法均已由后续轮次取代，不再在此重复；如需追溯，参见 git 历史、`plan.md`
历史计划段与对应 `docs/E4-*-report.md`。本文件的权威范围是**未完成任务交接**，不当作
发布证据。