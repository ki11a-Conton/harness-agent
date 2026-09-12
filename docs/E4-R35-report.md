# E4-R35 Report — 提交后状态更新与最终验收收口（R32…R34 关闭矩阵）

- reviewedSourceSha（计划审查基线）：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- testedSourceSha（本次全仓门禁实际运行的版本）：`d2210647`
  > 该提交的**代码内容**即 R32 `d23f1708` / R33 `816e767f` / R34 `2ac57611` 三提交的累积
  > 结果；`86323c56`（plan 轮换）与 `d2210647`（状态文档）**只改文档**，不改代码。
  > 三级 SHA 严格区分：`reviewedSourceSha`（计划依据）≠ `testedSourceSha`（测试所用）
  > ≠ `documentationCommitSha`（文档提交，见 §7 与文末补记）。
- 已推送实现 SHA（origin/main tip）：`d212d977`
- 状态：**PASS**（R32…R34 逐项有可追溯证据；最终版本全仓门禁全绿；干净树 promotion E2E 通过）
- 真实模型调用：**0**（全部离线；scripted/arm-aware provider）
- 平台：Windows（win32）
- 本轮变更文件：见各报告；R35 自身仅改文档（plan.md / HANDOVER.md / README.md /
  README.zh-CN.md / docs/E4-R31-report.md / docs/E4-STATUS.md / 本报告）。

## 1. R32…R34 关闭矩阵

矩阵列：问题 ID → 生产符号 → 测试名 → 实施 ref → 实际被测版本 → 结果 → 限制。

| 问题 ID | 生产符号 | 测试名（关键） | 实施 ref | 被测版本 | 结果 | 限制 |
|---|---|---|---|---|---|---|
| **H01** intent 写失败后 releaseLease 读取再失败 → 跳过重检、timer=0、drain 拒绝 | `session-actor.ts`：`releaseLease`（尽力清理）、`recoverHead` 读取入口（fail-closed + 有限唤醒）、`scheduleStoreRecheck` 回调（局部错误处理） | `R32-a/b/c/d`（recovery-durable.test.ts） | `d23f1708` | `d23f1708` | **PASS** 23/23 | 只覆盖恢复重进路径；外部动作重复未声称 |
| **H02** 连续 intent 失败时成功 lease 每次清零退避 → 延迟不递增 | `session-actor.ts`：`_storeRecheckCount` 重置点移到"本轮 lease+intent 均落盘"之后 | `R32-e`（延迟序列递增且封顶） | `d23f1708` | `d23f1708` | **PASS** 23/23 | 有 1s 下限，非零延迟死循环 |
| **H03** 130000 case 低于公开上限却在数组 spread 抛 RangeError；`includes` 二次方；容量校验滞后 | `execution-plan.ts`：`parseExecutionPlan`（显式循环拷贝 / Set 成员 / 容量护栏提前并可提前返回） | `R33-b`（13 万 case 可解析）、`R33-c2`（超限先拒绝、无逐 case 展开）等 7 例 | `816e767f` | `816e767f` | **PASS** 7/7 | 只证明共享 parser，不声称远程 DoS |
| **H04** 故意失败夹具落在根 include，残留污染下一次全量 | `e4-r24-final-result-protocol.test.ts` + `test-infra/observation-vitest.config.ts` + `.gitignore` | R34 四例（green/assert-fail/hook-fail/隔离） | `2ac57611` | `2ac57611` | **PASS** 4/4 | 见 R34 报告 §5.3 的间歇观测 |

逐项报告：`docs/E4-R32-report.md`、`docs/E4-R33-report.md`、`docs/E4-R34-report.md`。

## 2. 关键验收证据（独立复核，非照抄实施者结论）

- **R32 自行恢复**：测试用可故障 store + 可记录/触发的 scheduler；断言"intent 失败 + release
  读取失败"后 `action=0`、队头不 shift、**恰好一个有效 timer**、无未处理拒绝；随后触发该
  callback → 重读 durable 状态、动作恰好一次、最终 RECOVERED；长期失败延迟递增并封顶
  （1s→2s→4s→…→≤30s），**不是**全等序列蒙混。
- **R33 范围内成功 / 范围外拒绝**：`e4-r33-execution-plan-scale.test.ts` 7/7，其中
  `R33-b` 证明 13 万 case（合法合同 `limit=null`）**可解析、无 RangeError**；`R33-c2` 在
  **修复前**以 `RangeError` 失败（判别性），修复后结构化拒绝且 issue 数为 1（证明"先拒绝、
  未展开"）。R28 14/14、R27 18/18 不回归；evaluation 全量 81 files / 1012 tests PASS。
- **R34 残留隔离**：判别性证据——把失败夹具放**旧位置** `apps/cli/src/`，根配置
  `vitest list` **会收集**它（`... > old-location probe`）；新位置
  `apps/cli/test-infra/observation-fixtures/` **不被根配置收集**、被专用配置选中。双份
  `apps/cli` 并行验证不再互相干扰。

## 3. 最终版本全仓门禁（真实命令 / 退出码 / 数量）

在 **干净工作树**（`d2210647`，无未提交改动）上集中运行：

| 门禁 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 类型检查 | `tsc -b` | 全包通过 | **0** |
| 文档一致性 | `pnpm docs:verify` | ALL CHECKS PASS（含 HANDOVER 静态真值、plan 入口 E4-00） | **0** |
| 全量测试 | `pnpm test` | **317 files passed；5729 passed \| 1 skipped (5730)** | **0** |
| 竞态 | `pnpm test:race` | 11 files / **23 passed** | **0** |
| 安全 | `pnpm test:security` | 18 files / **2133 passed** | **0** |
| 协议 | `pnpm test:protocol` | 7 files / **52 passed** | **0** |
| 混沌 | `pnpm test:chaos` | 1 file / **12 passed** | **0** |
| E3 缺陷复现 | `pnpm e3:repro-current-defects` | 1 file / **13 passed** | **0** |

- 全量数字来自日志 `/tmp/r35-full2.log`，无临时负例污染（先前 R31 记录的残留 `e4-r24-fixture-*`
  与 safe-delete shim 假失败在 R34 后已结构性消除）。
- **注意一次过程性假失败**：本轮首次全量（`/tmp/r35-full.log`）出现 1 例 e4-09 失败，
  原因是**运行期间并发了本轮文档编辑**，使工作树瞬时变脏 → 触发干净树门禁。提交文档后
  在真正静止的干净树上复跑 → 0 失败（上表）。这是测量过程问题，**非产品/测试缺陷**。

## 4. 干净树 promotion E2E

- 在干净工作树上单独运行 `apps/cli/src/e4-09-production-e2e.test.ts` → **5 passed (5)**。
- 这直接印证 R31/R34 的判断：此前 4 例 e4-09 `expected 1 to be +0` 是
  `benchmark-command.ts` 的干净树门禁（`promotionEligibleRun && !executionSource.clean`）
  在**脏工作树**下的确定性拒绝，提交后消失。**未把未执行的干净树测试推断为 PASS**。

## 5. 状态修订（保留历史，不改写旧证据）

- `plan.md`：重建为**唯一当前计划入口**，指向 `plan(20260912-021843).md`（E4-R32…R35）；
  旧 `plan(20260911-072937).md` 作为历史保留在 git 历史（工作树删除），docs:verify E4-00 PASS。
- `HANDOVER.md`：当前状态速览改写——R27…R31 **已完成并已推送**（不再写"未提交/未推送"）；
  本轮 R32/R33/R34 已完成（本地提交）、R35 进行中；exact SHA/run-id 仅置于
  `## Historical / superseded` 之后（避免静态区嵌入会失效的数字，P38.4-10 PASS）。
- `README.md` / `README.zh-CN.md`：`Status` 段同步——R27…R31 移入"已完成并推送"，
  新增本轮 R32…R35 段；删除过期的 "Unfinished: R29/R30/R31 not started" 描述。
- `docs/E4-R31-report.md`：顶部追加 **SUPERSEDED / current-state** 指引
  （R29/R30/R31 已推送、CI 不再是 NOT_RUN；R32…R34 是边界补充不推翻原关闭），
  旧证据与当时日期保留。

## 6. 旧 G01…G04 复现继续阻断

R32…R34 为**边界补充**，不改变 R27/R29 原缺陷的关闭结论。复跑仍全 PASS：

| 门 | 测试 | 结果 |
|---|---|---|
| G01（R27） | `e4-r27-promotion-eligibility.test.ts` | 18 passed |
| G02（R28） | `e4-r28-execution-plan-fields.test.ts` | 14 passed |
| G03（R29） | `benchmark-command.test.ts -t R29` | 4 passed（该文件 66/66） |
| G04（R30） | `recovery-durable.test.ts -t R30` | 7 passed（该文件 23/23） |

## 7. 远端 CI（exact SHA，只读核查）

- 已推送实现 SHA：`d212d977`（origin/main tip，`bcf3f42c..d212d977` fast-forward）。
- 该 SHA 触发的 CI：**run `34685604645`，四个 job 全部 success**（`gh run view` 只读核查）：

  | job | 结论 |
  |---|---|
  | install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest) | **success** |
  | install · typecheck · test · build · benchmark-smoke · audit (windows-latest) | **success** |
  | coverage gate (ubuntu) | **success** |
  | release attestation (P38-12) | **success** |

  这意味着 R32/R33/R34 的改动在 **Ubuntu 与 Windows 两平台**的 `typecheck/test/build/
  benchmark-smoke/audit` 与 coverage 门禁上均通过——包括 R34 的夹具隔离（父子收集范围、
  跨平台路径）与干净树 promotion E2E。
- 唯一告警为 GitHub Actions 的 Node.js 20 弃用提示（非失败）。
- 未下载并逐字节复核 CI artifact；仅核对 workflow/job/step 状态时按状态口径报告。
- `runtimeReleaseReady`（该 SHA 工程门禁）、promotion evidence integrity（证据协议）、
  champion quality（真实模型效果）三者严格区分：本机 `release:verify` /
  `audit --strict` / `usage-audit --strict` 因缺 CI 记录的 gate 证据/具名运行而
  **NOT_RUN（命令正确拒绝）**；champion quality 保持 **NOT_RUN**。

## 8. 已完成 / PARTIAL / NOT_RUN 清单

- **已完成（本地验证 + 推送）**：R32、R33、R34、R35；G01…G04 原缺陷关闭保持。
- **PARTIAL**：无。
- **NOT_RUN**：真实模型 champion 质量（未付费/未请求）；release 发布动作（各轮只到
  attestation）；CI artifact 的逐字节复核（仅查状态）。
- **下一步触发条件**：仅当出现**真实 benchmark 失败、生产问题或明确用户需求**时才新建任务；
  本轮到此停止扩展，不新增猜测性架构任务。

## 9. 残余限制

- 5.3（R34 报告）记录的 `prevents cross-case contamination` 间歇失败**未定位根因**
  （约 1/6，仅整包高并发；隔离/整文件不可复现；给出资源竞争假设并排除 R32/R33 因果）。
  若 CI 复现，按其只读重试路径补最小可复现。
- 本报告的全量数字是**本机 win32** 上的一次干净树运行；CI 的两平台结果是独立证据。
- 时间/机器敏感的门限未新增；未为不可复现的波动编造修复。

---

### CI 核查补记（push 后填写）

- origin/main tip = `d212d977`；其 CI **run `34685604645` 四 job success**（见 §7 表）。
- 本报告与 `docs/E4-STATUS.md` 的文档提交（`documentationCommitSha`）为**文档专用**后续提交，
  不改代码；其自身触发的 CI 为**另一条 run**，与实现 SHA 的 run 分开记录，互不代替。
- 未使用 `bcf3f42c`（上一轮收口）或任何旧 run 证明本轮新代码。
