# E4 状态矩阵 — 当前 HEAD 的诚实判定

> 本文件是 E4-00 交付的“当前状态页”。它描述**被评审的代码树**，不是承诺未来 HEAD 不变。
>
> - 评审基线 sourceSha（本状态页描述的代码树）：`ad37841dbcbfa1d3553e699ab482c1246a549f48`
> - 上一基线：`f73a337d71027afd48a8ac5ac0de1a7f4ae8497c`
> - 审查日期：2026-09-07
> - providerCalls（E4-00 本轮）：**0**（全部离线）
> - 严格 `sourceSha == git rev-parse HEAD` 的**门禁证据生成器**是 E4-10 的交付物（GateEvidenceV2）；
>   本状态页记录评审基线 SHA 以保证可追溯，测试断言其为 git 历史中的合法完整 SHA（祖先于 HEAD），
>   而非逐 commit 自指的相等（那会在提交本页后立即失效，正是 docs:verify 对 HANDOVER 规范段禁止易变 SHA 的原因）。

## 1. 门禁命令真实状态（评审基线 ad37841）

| 命令 | 状态 | 说明 |
|---|---|---|
| `pnpm typecheck` | PASS | tsc -b 全绿（E4-00 part1 后复验） |
| `pnpm build` | PASS | |
| `pnpm test` | PASS | 287 文件 / 5346 用例（评审基线） |
| `pnpm test:coverage` | PASS | statements 89.70% / branches 80.24% / functions 92.52% / lines 91.58% |
| `pnpm test:protocol` / `:security` / `:race` / `:chaos` | PASS | 专项全绿 |
| `pnpm docs:verify` | PASS（仅证旧 ledger 自洽） | 不证明 E3 当前交付闭环 |
| `pnpm capability:audit` | FAIL | 11 wired / 10 implemented-only，evidence freshness 失败 |
| `pnpm release:verify` | FAIL | 当前 HEAD 全部 release gate 为 NOT_RUN |
| `pnpm benchmark:smoke` | 不可信 | 进程退出 0，但 case 实际 FAIL |

## 2. 各 E3 任务重新判定

| E3 任务 | 判定 | E4 收口动作 |
|---|---|---|
| E3-01 preflight/paid-guard/dry-run | PARTIAL | E4-01 强制化 planDigest、0 上限语义、fail-closed 隔离 |
| E3-02 paired executor | 基本完成 | E4-02 补 canonical V3 sink，不重写 |
| E3-03 合约冻结 | 基本完成 | 保留测试 |
| E3-04 Artifact V3 | PARTIAL | E4-03 收紧 schema 与跨 artifact 绑定 |
| E3-05 activation/security | 未接入生产 | E4-04 接入真实事件采集 |
| E3-06 evaluator | PARTIAL | E4-05 修 pair key 多重集合、plan policy、重复计数 |
| E3-07 promotion | 高风险未完成 | E4-06 重建完整信任链 |
| E3-08 champion application | 仅 mapper/单测 | E4-07 接入真实 createHarness |
| E3-09 生产集成测试 | 未达定义 | E4-09 改真实流水线，不手工造结果 |
| E3-10 recovery durability | actor 完成、生产持久化缺失 | E4-08 注入 durable store |
| E3-11 gate truth source | 未完成 | E4-10 建当前 HEAD 证据生成器 |
| E3-12 文档 | PARTIAL | E4-00 当前 handoff 与 ledger 联动 |
| E3-13 adversarial E2E | 未达定义 | E4-09 真实 CLI/构造链覆盖 |
| E3-14 实跑与序列化 | 序列化已提交（ad37841）；实跑证据未纳入当前门禁 | 禁止凭 commit message 宣称完成 |
| E3-15 收口 | 未完成 | 在 E4-10 执行 |

## 3. 当前高风险阻断项（12）

1. 格式完整但内容伪造的 ACCEPT + 任意文本 candidate artifact 可过 production promotion loader。
2. V3 evaluator 只比 caseId 集合，不比 (caseId, repetition)；基线 rep=1、候选 rep=1/2 仍可 ACCEPT。
3. champion promote 直接写 applied=true，无 applicationPending 阶段。
4. champion profile resolver 未接入 CLI/Web 真实 createHarness。
5. “生产路径集成测试”手工造通过结果，未消费真实 paired executor 产物。
6. paired benchmark 先写 e3-02 中间格式再靠脚本手工转 V3，转换会猜/丢证据。
7. ActivationEvidenceV2 / SecurityOutcomeV2 未进真实 benchmark 记录链。
8. recovery actor 默认内存 store，真实重启不保留 attempts/backoff/lease。
9. 付费运行 planDigest 可省略；隔离探测异常降级继续；不安全结果无不可促销标记。
10. 根 plan.md/handoff/capability audit/release evidence 仍描述旧基线或当前 HEAD 为 NOT_RUN。
11. benchmark:smoke 退出 0 但 case 实际 FAIL。
12. 测试在仓库根遗留 `.e3-09-self-test`，违反无副作用门禁。

## 4. E4-00 进度

- ✅ 阻断项 #12：capability self-test 污染已修复（`selfTestInTempDir`，commit 259fba7），+3 回归测试。
- ✅ 阻断项 #10（部分）：根 `plan.md` 改为当前 E4 唯一入口，旧 E3 计划标记 HISTORICAL。
- ⏳ 待办：no-dirty-worktree 检查脚本/测试；docs:verify 增加“当前 plan 入口唯一且可发现”检查；
  e3-review-baseline.json 历史说明强化；E4-00-report.md。

## 5. E4 收口状态（E4-01 … E4-10，全部离线，providerCalls=0）

> 本节记录 §3 十二项阻断的收口，不改动 §1–§3 对评审基线 ad37841 的历史判定。
> 每项均有对应提交与报告（docs/E4-0N-report.md）。

| # | 阻断项 | 收口 | 任务 |
|---|---|---|---|
| 1 | 伪造 ACCEPT + 任意文本 candidate 可过 loader | strict-load 真实 V3 + evaluator 重放 + 交叉绑定 + 路径守卫；15 例伪造矩阵 | E4-06 |
| 2 | evaluator 只比 caseId 不比 (caseId, repetition) | canonical PairKey + 精确多重集合配对 | E4-05 |
| 3 | promote 直接写 applied=true | promote 只写 applicationPending（applied=false） | E4-07 |
| 4 | champion profile 未接真实 createHarness | CLI/Web 共用 createHarnessWithChampion，校验真实解析配置 + AppliedProof | E4-07 |
| 5 | 生产路径测试手工造通过结果 | 真实端到端链（每产物来自上一生产阶段）+ 对抗 E2E | E4-09 |
| 6 | paired benchmark 靠脚本手工转 V3 | 执行器进程内直产 canonical V3 + strict reload | E4-02 |
| 7 | Activation/SecurityEvidenceV2 未进真实链 | 接入真实事件采集（fact-site） | E4-04 |
| 8 | recovery 默认内存 store，重启不保留 | DurableRecoveryStore（原子文件 + CAS + 跨进程锁 + 隔离损坏）注入 createHarness | E4-08 |
| 9 | planDigest 可省略 / 隔离降级 / 不安全结果无标记 | preflight 强制 planDigest + fail-closed 隔离 + promotionEligible=false | E4-01 |
| 10 | 根 plan/handoff/audit/release 描述旧基线或 NOT_RUN | HEAD 绑定 gate evidence 生成器 + usage audit（7/7 observed）+ docs gate-command 检查 | E4-10 |
| 11 | benchmark:smoke 退出 0 但 case FAIL | 诚实 boot-smoke 语义：无 case/ERRORED/用量断裂即非 0 | E4-10 |
| 12 | 测试遗留 .e3-09-self-test 污染 | E4-00 已修（selfTestInTempDir） | E4-00 |

- 状态：E4-00 … E4-10 全部完成；E4-11（付费复跑）未授权，保持 NOT AUTHORIZED。
- 验证：`tsc -b` 全绿；全量测试套件通过；`usage-audit` 7/7 observed；`docs:verify` 退出 0；`benchmark:smoke` 退出 0。

## 修订计划执行状态（2026-09-09 计划）

- R01-R09 + R11 已完成；本状态页新段记录修订计划的真实收口。
- testedSourceSha（本轮离线验证依据）：`1347f8d`（R11 收口；各 R commit 见 docs/E4-R10-report.md）。
- 修订计划评审基线（reviewedSourceSha）：`016473870c15f123edbbd6c624550b09ee69fe75`；旧 ad37841 段保持 HISTORICAL。
- 未完成（不勾选）：Windows CI 需推送后在最终提交复跑；release attestation 未产生；
  CI workflow 侧 V2 发证待接入；真实模型 champion 质量 INCONCLUSIVE（无伪造 ACCEPT）。
- runtimeReleaseReady 为离线工程门禁；championPromotion 质量结论单列，未宣称已证实。

## 修订计划执行状态（2026-09-11 计划 E4-R27…R31）— 一页最终状态

- 计划入口：`plan.md` → `plan(20260911-072937).md`。收口交付物：`docs/E4-R31-report.md`。
- 被测 SHA：HEAD `964ecc94`（R27 `f2f1b0b` / R28 `fb33ba9` 之后）；**R29/R30 为未提交工作树**。
  reviewedSourceSha `493866f0`；平台 Windows（win32）；providerCalls **0**（全部离线）。
- 计划状态：R27 ✅ / R28 ✅（本地提交，待推送）· R29 ✅ / R30 ✅（工作树，待提交）· R31 ✅（本页）。

| 门 | 缺陷 | 修复 ref | 复现结果（本机实测） |
|---|---|---|---|
| G01 | insecure-local/none 计划与 manifest 一致却被判可晋升 | `f2f1b0b` | 18/18 PASS |
| G02 | 四预算字段定义却未调用 → 无校验 | `fb33ba9` | 14/14 PASS |
| G03 | `probeSourceSnapshot` UTF-8 解码碰撞 0x80↔0x81 | 工作树（基于 `964ecc94`） | 4/4 PASS（该文件 66/66） |
| G04 | 恢复存储暂时故障后无 scheduler 回调 / 读未知被当非终态 | 工作树（基于 `964ecc94`） | 7/7 PASS（该文件 19/19） |

**全仓门禁（真实命令 / 退出码）**

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm typecheck` | 全绿 | 0 |
| `pnpm test` | 316 文件：315 passed / 1 failed；5718 用例：5713 passed / 4 failed / 1 skipped | 1 |
| `pnpm docs:verify` | ALL CHECKS PASS | 0 |
| `pnpm test:race` / `:security` / `:protocol` / `:chaos` | 23 / 2133 / 52 / 12 passed | 0 |
| `pnpm e3:repro-current-defects` | 13 passed | 0 |
| `pnpm benchmark:smoke` | `smoke: OK` | 0 |

- 全量测试**唯一失败** = `apps/cli/src/e4-09-production-e2e.test.ts` 4 例，根因**干净树门禁**
  （`benchmark-command.ts:665`，`promotionEligibleRun && !clean`）。脏工作树（R29/R30 未提交）
  下**预期失败、非回归**：生产函数直测脏树 `clean=false`、干净树 `clean=true`；
  `benchmark-command.test.ts` N04 clean 正例 66/66 通过。
- 本机 `release:verify` / `audit --strict` / `usage-audit --strict` 因缺少 **CI 记录的 gate 证据 /
  命名运行**而 NOT_RUN（命令正确拒绝，非缺陷）。
- 过度关闭修正：R22「数字边界」→ R28（G02）；R25「有限唤醒已验收」→ R30（G04）；旧证据未改写。
- 未完成/待环境项（不勾选）：**远端 CI = NOT_RUN**（未授权 push；R27/R28 已提交待推送，
  R29/R30 工作树待提交，推送后须由**新 SHA 的新 CI run** 确认）；release 发布动作未执行；
  真实模型 champion 质量 `NOT_RUN`（不付费/不造假）。
- `runtimeReleaseReady`（本 SHA 工程门禁）· `promotion evidence integrity`（证据协议）·
  `champion quality`（真实效果）三者严格区分：前者本机通过，中者 G01/G02 关闭，后者 NOT_RUN。

---

## 修订计划执行状态（2026-09-12 计划 E4-R32…R35）— 一页最终状态

> 以上各段为**历史快照**（其日期/证据保留不改写）。
> **本段在被 E4-R39 收口时标记为历史**：它描述的是 R32…R35 轮次收口时的状态（当时为当前有效结论），
> 该轮已完成并**已推送** origin/main，其 SHA 的 CI 四 job 全绿。
> **当前有效结论见文末「2026-09-12 计划 E4-R36…R39」段。**

- 计划入口：`plan.md` → `plan(20260912-021843).md`。收口交付物：`docs/E4-R35-report.md`。
- 被测 SHA：`testedSourceSha = d2210647`（**干净工作树**；代码内容 = R32 `d23f1708` /
  R33 `816e767f` / R34 `2ac57611`）。reviewedSourceSha `bcf3f42c`；平台 Windows（win32）；
  providerCalls **0**（全部离线）。
- 计划状态：R32 ✅ · R33 ✅ · R34 ✅ · R35 ✅（本页）。

| ID | 缺陷 | 生产符号 | 实施 ref | 复现结果（本机实测） |
|---|---|---|---|---|
| H01 | intent 写失败后 release 读取再失败 → 跳过重检（timer=0、drain 拒绝） | `session-actor.ts`（releaseLease/recoverHead/scheduleStoreRecheck） | `d23f1708` | PASS（recovery-durable 23/23） |
| H02 | 连续 intent 失败时退避被过早清零、延迟不递增 | `session-actor.ts`（`_storeRecheckCount` 重置点） | `d23f1708` | PASS（同上，延迟递增且封顶） |
| H03 | 13 万 case 低于公开上限却因数组 spread 抛 RangeError；成员查询二次方 | `execution-plan.ts`（parseExecutionPlan） | `816e767f` | PASS（R33 7/7；修复前 RangeError） |
| H04 | 故意失败夹具落入根 include，残留污染下一次全量 | `e4-r24-final-result-protocol.test.ts` + test-infra 配置 | `2ac57611` | PASS（R34 4/4；旧位置会被收集的判别性证据） |

**全仓门禁（干净树 `d2210647`，真实命令 / 退出码）**

| 命令 | 结果 | 退出码 |
|---|---|---|
| `tsc -b` | 全包通过 | 0 |
| `pnpm test` | **317 文件全通过；5729 passed \| 1 skipped (5730)** | **0** |
| `pnpm docs:verify` | ALL CHECKS PASS（含 HANDOVER 静态真值 P38.4-10、plan 入口 E4-00） | 0 |
| `pnpm test:race` / `:security` / `:protocol` / `:chaos` | 23 / 2133 / 52 / 12 passed | 0 |
| `pnpm e3:repro-current-defects` | 13 passed | 0 |
| `e4-09-production-e2e.test.ts`（干净树单跑） | **5/5 passed** | 0 |

- 旧 G01…G04 复现继续阻断：R27 18/18 · R28 14/14 · R29（该文件 66/66）· R30 7/7。
- 远端 CI：实现 SHA `d212d977` 的 run **34685604645 四 job 全绿**
  （Ubuntu 主门禁 / Windows 主门禁 / coverage gate / release attestation）。
- 过度关闭修正保留：R22「数字边界」→ R28；R25「有限唤醒已验收」→ R30；旧证据未改写。
- 未完成/待环境项（不勾选）：**真实模型 champion 质量 = NOT_RUN**（不付费/不造假）；
  **release 发布动作未执行**（各轮只到 attestation）；CI artifact 未逐字节复核（仅查状态）。
- `runtimeReleaseReady`（工程门禁）· `promotion evidence integrity`（证据协议）·
  `champion quality`（真实效果）三者严格区分：前者由 exact-SHA CI 承载，中者 G01/H01–H04
  关闭，后者 NOT_RUN。
- **下一步触发条件**：仅当出现真实 benchmark 失败、生产问题或明确用户需求时新建任务；
  本轮到此停止扩展。

---

## 修订计划执行状态（2026-09-12 计划 E4-R36…R39）— 当前有效结论

> 以上各段为**历史快照**（其日期/证据保留不改写）。**本段是当前有效的收口结论。**
> 计划入口：`plan.md` → `plan(20260912-180524).md`；收口交付物：`docs/E4-R39-report.md`。

- reviewedSourceSha（本计划审查基线）：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`（main）。
- 比较基线：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`。
- testedSourceSha：`01c4ec74706a590294a8c748972bd85dc00bcd50`（R36/R37/R38 实现提交；
  被测工作树与它**逐字节一致**，门禁运行期间 `git status --short` 为空）。
- documentationCommitSha：**本文件与 `docs/E4-R39-report.md` 所在的后续文档提交**（只含文档，
  不改代码/测试/配置，故上述门禁结果继续适用于该提交的代码 = `01c4ec74`）。
- 平台：Windows（win32）；`providerCalls = 0`（全部离线 fixture / fault injection）。
- 计划状态：R36 ✅ · R37 ✅ · R38 ✅ · **R39 ⚠️ PARTIAL**（状态同步与 CI 核实完成；
  但冻结版本上的全仓 `pnpm test` 未取得绿，见下）。

### J01…J04 关闭矩阵

| ID | 优先级 | 问题 | 实际符号/配置 → 测试名 | 实施 ref | 结果 | 限制 |
|---|---|---|---|---|---|---|
| J01 | P1 | 首次恢复发现失败后 `_recoverableChecked` 已为 true：无 timer、不重扫，promoted prompt 滞留 | `session-actor.ts`（`drainFollowupsInner` / `discoverRecoverableTurns`）→ `R36-a…f`（`recovery-durable.test.ts`） | `2341f6ee` | **RESOLVED**（29/29；修复前 6/6 失败） | 只覆盖「暂时性」读取故障；不声称消除外部动作重复 |
| J02 | P2 | 旧位置 `apps/cli/src/e4-r24-fixture-*.test.ts` 残留仍被根配置收集 | `vitest.config.ts`（根 `exclude`）→ `E4-R37`（`e4-r24-final-result-protocol.test.ts`） | `07c40cfe` | **RESOLVED**（5/5；全局收集集合有/无规则均 5755 点） | 按生成文件名模式排除；`tsc -b` 仍编译 `src` 下的历史残留（R37 报告 §6 已记录该决定） |
| J03 | P2 | R33 正例用占位 digest、只断言「无 cap issue」，且缺 loader 证据 | `e4-r38-execution-plan-boundary.test.ts` + R33-f → `R38-a/b/c` | `01c4ec74` | **RESOLVED（验收补强）**：3/3；R33 7/7；R27/R28/R33/R38 = 42 passed | **无生产修复**（未发现生产缺陷）；超限负例只改 `repeat` 这一容量因子；容量上限**未被以「放宽」方式验证过** |
| J04 | P2 | R35 已完成并推送，但 plan/HANDOVER/README 仍写进行中/待推送 | `plan.md` / `HANDOVER.md` / `README.md` / `README.zh-CN.md` / 本文件 | 本轮文档提交 | **RESOLVED** | 历史报告当时状态保留在历史段 |

### 门禁实测（`testedSourceSha = 01c4ec74`，干净工作树，本会话重新实测）

| 命令 | 实测结果 | 退出码 |
|---|---|---|
| `pnpm typecheck`（`tsc -b`） | 全包通过 | 0 |
| `pnpm test` | **318 文件 / `1 failed \| 5738 passed \| 1 skipped (5740)`** | **1** |
| `pnpm docs:verify` | ALL CHECKS PASS（含 E4-00 计划入口指向 `plan(20260912-180524).md`、HANDOVER 静态真值） | 0 |
| `pnpm test:race` | 11 文件 / 23 passed | 0 |
| `pnpm test:security` | 18 文件 / 2133 passed | 0 |
| `pnpm test:protocol` | 7 文件 / 52 passed | 0 |
| `pnpm test:chaos` | 1 文件 / 12 passed | 0 |

- **唯一失败（3 次运行 3 次相同）**：`apps/cli/src/e4-09-production-e2e.test.ts >
  E4-09 adversarial E2E (real chain) > a forged decision field (digest recomputed) …`
  —— 失败发生在共享 helper `buildRealChain`（第 378 行），
  `expected 'INVALID' to be 'ACCEPT'`（**有效**候选链被判 `INVALID`），不是被篡改的负例断言。
- **判别性对照（该文件本身是好的）**：`npx vitest run apps/cli/src/e4-09-production-e2e.test.ts`
  隔离运行 **5/5 passed**（4 次，其中 1 次在 16 核上跑 8 个 CPU 满载进程）；
  `npx vitest run apps/cli/src` 整目录 **35 文件 / 419 passed**（2 次）；
  与 `e4-r24-final-result-protocol.test.ts`、与 `release-command.test.ts` 两两并发均通过。
- 跑完全量后 `git status --short` 为空（瞬时非空会在下条说明）：干净树门禁真实生效，无残留污染。
- 旧 G01…G04/复现继续阻断：R27 18/18 · R28 14/14 · R33 7/7；R30/R32 恢复套件 29/29。

### 全量并发下的干扰通道（实测事实 + 未证实的假设）

- **事实**：全量运行期间以 ~120ms 周期轮询 `git status --porcelain`，观测到**工作树瞬时变为
  非空再回到空**（3 个不同状态，非空窗口 ≲100ms）；同期任一时刻的树是干净的。
- **代码事实**：benchmark 的宿主机状态哨兵用
  `captureHostState(process.cwd(), { include: [], excludePrefixes: [] })`，即 `treeDigest = null`，
  `hostMutated` 只比较 `HEAD` 与 `git status --porcelain`（`benchmark-isolation.ts:221-249`）；
  而 evaluator 的身份可比性要求 `gitSha/dirty` 可比较（`champion-eval-v3.ts:170`）。
- **未证实的假设**：上述瞬时脏树是 `buildRealChain` 判 `INVALID` 的原因。
  **已做的证伪尝试**：在 e4-09 运行时人为制造瞬时未跟踪文件（2 次）**未能复现**；
  50% CPU 负载（2 次）**未能复现**。故根因保持**未定**，不写成已归因。
- **未查明**：是哪个用例产生了该瞬时脏状态；`INVALID` 的真实触发条件。

### 远端 CI（只读核实，不用旧绿灯证明新代码）

- 本计划基线 `a7950fa1` 的 run `34685817447` 四 job success（**仅作基线事实**，不用于证明 R36…R38）。
- **本轮实现提交 `01c4ec74` 自身的 run `34687657690`：整体 conclusion = failure。**
  - Ubuntu 主门禁 job：全 step success（含 `Unit and integration tests`、`Build`、
    strict usage audit、benchmark smoke、gate evidence）。coverage gate（ubuntu）：success。
  - **Windows 主门禁 job：`Unit and integration tests` step 失败**；失败点两次尝试不同：
    - attempt 1（102.74s）：`apps/cli/src/release-command.test.ts > P38.2-4/13 … > runGate
      executes the canonical command …` —— `expect(written.passed).toBe(cleanBefore && cleanAfter)`
      收到 `false`（**树是干净的**，但该测试内嵌套执行的真实 `pnpm typecheck` 返回非零）。
    - attempt 2（260.00s）：3 例失败 —— `packages/harness/src/delegation-worker.integration.test.ts`
      的 `child writes to an isolated root…`（`ENOENT … \src\helper.ts`，耗时 **134.6s**）、
      `packages/memory/src/migration.test.ts` 两例 `Hook timed out in 10000ms`（`beforeEach` 的
      `mkdtemp`）。attempt 2 汇总：`2 failed | 316 passed (318)` 文件、
      `3 failed | 5736 passed | 1 skipped (5740)` 用例。
  - release attestation job：**skipped**（上游 Windows 红）。
- 未下载 artifacts 逐字节复核：只核实 job/step 状态，故**不声称**已独立重放 release 证据。

### 未完成 / NOT_RUN（不勾选）

- **冻结版本上的全仓 `pnpm test` 未绿**（R39 未通过项）：`e4-09` 有效链在全量并发下判
  `INVALID`，根因未定；不得用隔离通过或其它门禁的绿来替代该项。
- **本轮 SHA 的 Windows CI 主门禁失败**（run `34687657690`，两次尝试），根因未定。
- **真实模型 champion 质量 = NOT_RUN**：未请求付费 benchmark，不造假、不付费。
- **release 发布动作未执行**：各轮计划只到 attestation，不自动发布。
- **CI artifact 未下载逐字节复核**：只核实 job/step 状态。
- **历史间歇失败（R34 的 cross-case contamination 波动）根因未知且本轮未复现**，
  保持「未复现 / 根因未定」口径；不因清理旧夹具而宣称所有波动均已归因。

- **下一步触发条件 / 最小补足动作**（详见 `docs/E4-R39-report.md` 第 8 节）：
  先复现（在同一机器上稳定拿到 `e4-09` 全量失败，并定位使树瞬时变脏的用例），
  再判定是生产侧（宿主机哨兵对并发测试过于敏感）还是测试侧的隔离缺口；不做架构重写。
