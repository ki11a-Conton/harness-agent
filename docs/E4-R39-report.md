# E4-R39 Report — 状态同步、完成最终门禁并结束本轮（J04）

- reviewedSourceSha（本计划审查时所依据的提交）：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`（main）
- 比较基线：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- **testedSourceSha：`01c4ec74706a590294a8c748972bd85dc00bcd50`**（R36/R37/R38 的实现提交；
  被测工作树与它**逐字节一致**——`git diff --stat 01c4ec74` 为空，门禁运行期间
  `git status --short` 为空）
- **documentationCommitSha：本轮文档提交**（本报告 + `plan.md` / `HANDOVER.md` /
  `README.md` / `README.zh-CN.md` / `docs/E4-STATUS.md`）。该提交**只改文档**，不含代码、
  测试或构建配置改动，因此第 4 节的门禁结果对其代码内容（= `01c4ec74`）继续成立。
  本报告不引用自身 SHA（自引用无意义）。
- 状态：**PARTIAL** —— J04（状态一致性）已关闭；J01/J02/J03 逐项验收通过；
  **但计划第 7 节的「最终全量门禁实际通过」一项未达成**（见第 4、5 节）。
- 真实模型调用：**0**（`providerCalls = 0`，全部离线 fixture / fault injection）
- 平台：Windows（win32），16 逻辑核

---

## 1. 做了什么

1. 建立 J01…J04 关闭矩阵（问题 → 实际符号/配置 → 测试名 → 实施提交 → 被测版本 → 结果 → 限制）。
2. 修正 `plan.md` / `HANDOVER.md` / `README.md` / `README.zh-CN.md` / `docs/E4-STATUS.md`
   的过期状态：R32…R35 已推送、其 SHA 的 CI 全绿，不再写成「进行中 / 待推送」。
3. 在**静止的干净版本**上重跑门禁：`pnpm typecheck`、`pnpm test`、`pnpm docs:verify`，
   以及 Runtime 相关的 `test:race` / `test:security` / `test:protocol` / `test:chaos`。
4. 只读核实**本轮实现提交自身**的远端 CI（不使用基线 SHA 的绿灯证明新代码）。
5. 对全量门禁中出现的唯一失败做了有界定位（3 次全量 + 9 次隔离/组合对照 + 2 个证伪实验），
   并如实区分「事实 / 假设（含证伪）/ 未知」。

**范围外声明**：本轮**没有**修改任何生产代码或测试代码——R39 是状态与门禁收口任务。
`packages/**/src`、`apps/**/src`、`vitest.config.ts`、各 `tsconfig.json` 与 `01c4ec74`
逐字节一致。

---

## 2. J01…J04 关闭矩阵

| ID | 优先级 | 问题 | 实际符号/配置 → 测试名 | 实施提交 | 被测版本 | 结果 | 限制 |
|---|---|---|---|---|---|---|---|
| J01 | P1 | 首次恢复发现失败后 `_recoverableChecked` 已为 true：无 timer、不重扫，promoted prompt 滞留在无 owner 的 turn 上 | `packages/core/src/runtime/session-actor.ts`（`drainFollowupsInner` / `discoverRecoverableTurns`）→ `recovery-durable.test.ts` 的 `R36-a`…`R36-f` | `2341f6ee` | `01c4ec74` | **RESOLVED** —— 29/29；修复前 6/6 失败；回退源码复验判别性 | 只覆盖「暂时性」读取故障；**不**声称已消除外部动作重复或数据损坏 |
| J02 | P2 | 旧位置 `apps/cli/src/e4-r24-fixture-*.test.ts` 残留（gitignore ≠ vitest exclude）仍被根配置**收集** | `vitest.config.ts` 根 `exclude`（含 `...configDefaults.exclude`）→ `e4-r24-final-result-protocol.test.ts` 的 `E4-R37` | `07c40cfe` | `01c4ec74` | **RESOLVED** —— 5/5；显式指名残留仍 `No test files found`；全局收集集合有/无该规则**均为 5755 个测试点** | 按**生成文件名模式**排除（未来若有正式测试取同样文件名会被一并排除）；`tsc -b` 仍编译 `src` 下的历史残留（R37 报告 §6 已记录该决定，本轮**未**改动 tsconfig） |
| J03 | P2 | R33 的「正例」用占位 `planDigest`、只断言「无 cap issue」，且完全缺 promotion loader 证据 | 新增 `packages/evaluation/src/e4-r38-execution-plan-boundary.test.ts`（`R38-a/b/c`）+ 修正 `e4-r33-execution-plan-scale.test.ts` 的 R33-f | `01c4ec74` | `01c4ec74` | **RESOLVED（验收补强）** —— 3/3；R33 7/7；R27 18 / R28 14 / R33 7 / R38 3 = 42 passed | **无生产修复**（未发现生产缺陷）；超限负例只改 `repeat` 一个容量因子；**容量上限未被以「放宽」方式验证过**（见 §8） |
| J04 | P2 | R35 报告已写完成并推送，但 plan/HANDOVER 仍写进行中、README 仍写 pending push/new CI | `plan.md` / `HANDOVER.md` / `README.md` / `README.zh-CN.md` / `docs/E4-STATUS.md` | 本轮文档提交 | `01c4ec74` | **RESOLVED** —— 四份当前状态文本与真实提交/CI 一致；历史报告内的「当时状态」保留在历史段 | 历史报告的当时措辞不改写（有意保留） |

J03 与生产缺陷关闭**分开**表述：它是**本轮识别出的验收质量缺口**，不是新发现的生产漏洞。

---

## 3. J04 的具体修订

| 文件 | 修订 |
|---|---|
| `plan.md` | R39 状态由「✅」改为「⚠️ PARTIAL」并写明未通过项；保持唯一当前计划入口，指向 `plan(20260912-180524).md` |
| `HANDOVER.md` | 速览与「已完成任务」段：R32…R35 改为「已完成并已推送、四 job 全绿」；新增 R36…R39 四条；执行约定新增第 9 条（跑全量期间不得并发编辑被跟踪文件 + `env -u NODE_OPTIONS`）；Historical 段补 R32…R35 的 SHA/run；新增「未关闭的真实缺口」一条 |
| `README.md` / `README.zh-CN.md` | R32…R35 段标题由「pending push + new CI」改为「pushed to origin/main, CI-green at their SHAs」；新增 R36…R39 段（R39 标注 PARTIAL）；NOT_RUN 清单新增「全仓 `pnpm test` 未绿」 |
| `docs/E4-STATUS.md` | R32…R35 段标记为历史；新增「2026-09-12 计划 E4-R36…R39」当前有效结论段（关闭矩阵、门禁实测、干扰通道、远端 CI、NOT_RUN、最小补足动作） |

---

## 4. 门禁实测（`testedSourceSha = 01c4ec74`，干净工作树）

| 命令 | 实测结果 | 退出码 |
|---|---|---|
| `pnpm typecheck`（`tsc -b`） | 全包通过 | **0** |
| `pnpm test`（第 1 次，18:25:14，39.63s） | 318 文件 / `1 failed \| 5738 passed \| 1 skipped (5740)` | **1** |
| `pnpm test`（第 2 次，18:27:15，39.11s） | 同上（同一处失败） | **1** |
| `pnpm test`（第 3 次，18:33:34，40.89s） | 同上（同一处失败） | **1** |
| `pnpm docs:verify` | ALL CHECKS PASS（含 E4-00：`plan.md` 指向存在的 `plan(20260912-180524).md`；P38.4-10：HANDOVER 静态真值） | **0** |
| `pnpm test:race` | 11 文件 / **23 passed** | **0** |
| `pnpm test:security` | 18 文件 / **2133 passed** | **0** |
| `pnpm test:protocol` | 7 文件 / **52 passed** | **0** |
| `pnpm test:chaos` | 1 文件 / **12 passed** | **0** |

唯一失败（3 次运行 3 次相同）：

```text
FAIL  apps/cli/src/e4-09-production-e2e.test.ts > E4-09 adversarial E2E (real chain)
      > a forged decision field (digest recomputed) is caught by the evaluator replay
AssertionError: expected 'INVALID' to be 'ACCEPT'
 ❯ buildRealChain apps/cli/src/e4-09-production-e2e.test.ts:378:48
   const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId });
   expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");   ← 这里
 ❯ apps/cli/src/e4-09-production-e2e.test.ts:432:19
```

要点：失败**不在**被篡改的负例断言上，而在共享 helper `buildRealChain` 里——
它把**合法**候选取到的 evaluator 判定拿到了 `INVALID`。同一个 helper 被该文件的 4 个用例
共用，所以这属于「有效链被误判」，不是「负例没被抓住」。

### 4.1 首次失败与后续处理（计划第 7 节第 7 条）

| 次序 | 动作 | 结果 |
|---|---|---|
| 1 | 首次 `pnpm test`（干净树） | 1 failed（e4-09 / `buildRealChain`） |
| 2 | 第二次 `pnpm test`（不复跑前先做别的，只重跑一次以区分波动/确定性） | 同一失败 → 判为**在该环境下可重复**，不再无限重跑 |
| 3 | 隔离运行该文件 | `5 passed (5)`，两次 |
| 4 | 与最可疑干扰源两两并发 | `e4-09 + e4-r24-final-result-protocol.test.ts` → 10/10 通过；`e4-09 + release-command.test.ts` → 27/27 通过 |
| 5 | 整目录收窄 | `npx vitest run apps/cli/src` → 35 文件 / **419 passed**，两次 |
| 6 | 证伪实验一：50% CPU 负载（16 核上 8 个满载进程）下隔离运行 | 5/5 通过 → **负载假设证伪** |
| 7 | 证伪实验二：运行中人为制造瞬时未跟踪文件（2 次） | 5/5 通过 → **瞬时脏树假设未能复现** |
| 8 | 第三次 `pnpm test`（确认失败稳定） | 同一失败，3/3 |

> **同一版本上存在一次留存的绿运行**：`01c4ec74` 提交于 18:05:54，随后 18:06:16 的一次全量
> 运行留存日志为 `Test Files 318 passed (318)` / `Tests 5739 passed | 1 skipped (5740)` /
> `Duration 38.71s`（日志文件 `/tmp/full_test.log`，本机 18:06:55 落盘）。它与今天 18:25 /
> 18:27 / 18:33 的 3/3 失败**来自同一版本**，因此该失败**不是该版本的确定性属性**，
> 而是环境/时序相关。该日志本身不记录当时的工作树状态，故它只用于证明
> 「同版本曾绿」，**不**用于证明 R39 的全量门禁已通过。

### 4.2 旁证：全量并发下工作树会瞬时变「脏」

在全量运行期间以约 120 ms 周期轮询 `git status --porcelain`（并对其输出取 md5）：

```text
[18:33:33] change#1 porcelain_md5=d41d8cd98f   ← 空（md5("") = d41d8cd98f00b204e9800998ecf8427e）
[18:33:53] change#2 porcelain_md5=e74bb6b64f   ← 非空（瞬时；再次查询已恢复为空，未能捕获文件名）
[18:33:53] change#3 porcelain_md5=d41d8cd98f   ← 恢复为空
TOTAL_DISTINCT_PORCELAIN_STATES=3
```

**事实**：全量并发下工作树会短暂（≲100 ms）出现 `git status --porcelain` 可见的脏状态。
**代码事实**：benchmark 的宿主机状态哨兵用
`captureHostState(process.cwd(), { include: [], excludePrefixes: [] })`，
即 `treeDigest = null`，`hostMutated` 只比较 `HEAD` 与 `git status --porcelain`
（`packages/evaluation/src/benchmark-isolation.ts:221-249`）；同时 evaluator 的身份可比性
要求 `gitSha/dirty` 可比较（`packages/evaluation/src/champion-eval-v3.ts:170`，
`e2-baseline-audit.ts` 的 `SOURCE_DIRTY`）——因此**确实存在**一条「并发用例让树瞬时变脏 →
哨兵判 hostMutated → 该次 benchmark 记为 infrastructure error → 配对不完整 → 判 INVALID」的通道。
**假设**：这条通道就是本次 `buildRealChain` 判 `INVALID` 的原因。
**证伪尝试**：人为制造瞬时未跟踪文件**未能复现**（第 4.1 节第 7 步）。
**结论**：根因**未定**。不写成「已归因」，也不把它说成夹具残留问题。

### 4.3 其它观测（不构成失败，如实记录）

- `[degraded] store-integrity.syncDir: EPERM: operation not permitted, fsync` ——
  本地与 Windows CI 均出现；走 degraded 通道，是 Windows 平台 fsync 行为的既有观察，
  本轮**未**改动。
- `[degraded] scope-resolver.git: Command failed: git rev-parse --show-toplevel` ——
  本地部分套件中出现；未追根因。
- R37 的协议测试会把瞬时夹具写进 `apps/cli/src/`；而 `release-command.test.ts` 会在套件内
  嵌套执行一次真实的 `pnpm typecheck`（`GATE_COMMANDS.typecheck = "pnpm typecheck"`），
  两者重叠时会在 `apps/cli/dist/` 留下**孤儿编译产物**（实测存在
  `apps/cli/dist/e4-r24-fixture-*-legacy-assert-fail.test.js` 及其 `.d.ts`/`.map`，
  落盘时刻分别为 09:35、09:37、18:14:03、18:14:14、18:14:25、18:25:29、18:31:10、18:31:44）。
  这些文件在 `git status` 中不可见（`dist/` 被忽略），但说明「瞬时夹具 × 嵌套 `tsc -b`」的
  重叠**确实发生过**。它们与本次 `INVALID` 的因果关系**未验证**（绿运行的 18:06 时刻尚无
  18:14 那批产物，这是两者之间可见的环境差异之一，但样本量为 1，不作为归因）。
  本轮只记录该现象，**未**改动 `tsconfig`（R37 报告 §6 已说明不改的理由）。

---

## 5. 远端 CI（只读核实，不用旧绿灯证明新代码）

| SHA 角色 | SHA | run | 结果 |
|---|---|---|---|
| 本计划基线（**仅作基线事实**） | `a7950fa1` | `34685817447` | 四 job success |
| **本轮实现提交（testedSourceSha）** | `01c4ec74` | **`34687657690`** | **整体 conclusion = failure**（Windows 主门禁红） |
| 文档提交（本报告所在批次的前一提交） | `a0a99ce0` | `34689017816` | **cancelled** —— 被我自己随后的连续推送按 `concurrency.cancel-in-progress` 取消，**不可用作证据** |
| 文档提交（本报告所属提交） | `2db1a9cd` | `34689110496` | **success —— 四个 job 全绿**（含 Windows 主门禁） |

> **关键对照**：`01c4ec74` 与 `2db1a9cd` 的**代码与测试完全相同**（后者只改文档），
> 但 Windows 主门禁在前者**两次尝试都失败**、在后者**一次通过**。
> 因此那个 Windows 失败**也不是该代码版本的确定性属性**，而是**波动**——
> 与第 4 节本地 `e4-09` 的结论方向一致（同版本 18:06 曾绿 vs 18:25 起 3/3 红）。
> 本报告仍**不声称** `01c4ec74` 的 CI 是绿的：它的事实结论就是 failure。

`01c4ec74` 的 run `34687657690` 逐 job / step 状态：

| Job | 结果 | 关键 step |
|---|---|---|
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | **success** | 含 Typecheck / Unit and integration tests / Build / strict usage audit / benchmark smoke / gate evidence 全 success |
| `coverage gate (ubuntu)` | **success** | Coverage gate（阈值门禁）success |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | **failure** | step 6 `Typecheck` **success**；step 7 `Unit and integration tests` **failure**；其后 Build / usage audit / benchmark smoke / gate evidence 全部 skipped |
| `release attestation (P38-12)` | **skipped** | 上游 Windows 红 |

Windows job 的两次尝试，**失败点不同**（这是「同一 job 在不同负载下换着失败」的直接证据）：

- **attempt 1**（102.74s，318 文件 / `1 failed | 5738 passed | 1 skipped (5740)`）：
  `apps/cli/src/release-command.test.ts > P38.2-4/13 repo-owned gate runner (INV-P38.2-004) >
  runGate executes the canonical command and writes…`
  —— `expected false to be true`：断言是
  `expect(written.passed).toBe(written.cleanBefore === true && written.cleanAfter === true)`，
  即**树是干净的**，但该用例内嵌套执行的真实 `pnpm typecheck` 返回了非零退出码
  （`passed` 需要 `exitCode === 0` 且干净）。
- **attempt 2**（260.00s，318 文件 / `2 failed | 316 passed`、`3 failed | 5736 passed | 1 skipped (5740)`）：
  1. `packages/harness/src/delegation-worker.integration.test.ts > P3-6 end-to-end … >
     child writes to an isolated root; parent physically receives the patch` ——
     `Error: ENOENT: no such file or directory, open 'C:\Users\RUNNER~1\AppData\Local\Temp\
     ar-worker-e2e-z6x5M2\src\helper.ts'`，该用例耗时 **134.6 s**（正常量级为秒）；
  2. 3. `packages/memory/src/migration.test.ts` 两例 ——
     `Error: Hook timed out in 10000ms.`，位于 `beforeEach` 的
     `await mkdtemp(join(tmpdir(), "migration-"))`。

**口径说明**：以上只核实了 job / step 状态与失败 step 的控制台日志（`gh run view
--log-failed`，含 `--attempt 1`）。**未下载并逐字节复核任何 artifact**
（`test-report.log`、`capability-matrix-*`、`gate-evidence-*` 等均未取回），
因此**不**声称已独立重放 release 证据，也不声称 gate evidence 的内容正确。
本报告核实到 run `34689110496`（`2db1a9cd`）为止；若之后再有文档提交，其自身的
CI 结论不在本报告范围内，不在此追认。

**归因边界（计划第 7 节第 7 条）**：Windows 两次尝试失败点不同、本地全量失败点又是第三处
（`e4-09`），三处都不在隔离运行时复现 —— 这些**不足以**得出统一根因。既有历史间歇失败
（R34 记录的 cross-case 波动、R34 报告中 `promotionEligible` 的历史断言）**保持「未复现 /
根因未定」**；本轮不重写其归因，也不宣称所有波动都已解释。

---

## 6. 计划第 7 节验收清单逐条对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| R36 有「首次发现失败 → 自动重扫 → 原 turn 恰好一次」的完整证据，且不能拿已有 head 重试测试替代 | ✅ | `R36-a`…`R36-f`；修复前 6/6 失败；`docs/E4-R36-report.md` |
| R37 同时覆盖旧残留与新夹具；正式测试没有因排除范围过大而减少 | ✅ | 旧残留 + 新残留 + 正式父测试三者同时在库的正负对照；全局收集集合有/无规则均 **5755** 点；`E4-R37` 5/5 |
| R38 有真实成功基准和目标边界负例；缺项写 PARTIAL，不用总测试数掩盖 | ✅ | `R38-a`（真实 digest → `violations===[]` + `ACCEPT` + `loader.ok`）/ `R38-b`（只改 `repeat`）/ `R38-c`；`E4-R38` 3/3 |
| 最终全量、类型、文档与相关 Runtime 门禁实际通过，数量来自日志 | **❌ 未通过** | 类型 / 文档 / race / security / protocol / chaos 全绿；**`pnpm test` 退出码 1**（318 文件 / `1 failed \| 5738 passed \| 1 skipped`，3/3 同一失败） |
| plan/HANDOVER/中英文 README/最新报告状态一致，不再同时「已推送」与「待推送」 | ✅ | §3；`docs:verify` ALL CHECKS PASS |
| 历史间歇失败的事实、推测与未知分开写，不用不同断言路径的证据冒充归因 | ✅ | §4.2、§5 归因边界；两条假设已标注「证伪 / 未复现」 |
| 有最新提交的 CI 就记录准确 SHA/run；没有则明确远端 NOT_RUN，不借旧绿灯 | ✅（结论为红） | §5：`01c4ec74` / run `34687657690` = failure（Windows job），**不**借用 `a7950fa1` 的绿灯 |
| 给出已完成、PARTIAL/BLOCKED、NOT_RUN 的简明清单，完成本轮后停止新增任务 | ✅ | §7 |

---

## 7. 一页结论

**已完成（本地提交 + 已推送）**

- R36（J01）：恢复发现的完成态只在完整成功路径提交；扫描原子提交；失败 fail-closed 且保留
  有界自愈唤醒。`recovery-durable.test.ts` 29/29。
- R37（J02）：根 vitest 配置按生成文件名模式结构性排除旧位置残留（保留框架默认 exclude）。
  `e4-r24-final-result-protocol.test.ts` 5/5。
- R38（J03）：真实 digest 的有效正例在真实 evaluator 得到 `ACCEPT`、真实 promotion loader
  成功；超限负例由同一基准只改 `repeat` 派生。`e4-r38-execution-plan-boundary.test.ts` 3/3。
- J04：四份当前状态文档与实际提交/CI 一致；`docs:verify` ALL CHECKS PASS。
- 类型门禁、文档门禁、race 23 / security 2133 / protocol 52 / chaos 12 全绿。

**PARTIAL（本轮未通过项，均为真实缺口，不以任何口径掩盖）**

1. 冻结版本 `01c4ec74` 上的**全仓 `pnpm test` 未绿**：318 文件 /
   `1 failed | 5738 passed | 1 skipped (5740)`，3/3 同一失败
   （`e4-09-production-e2e.test.ts` 的 `buildRealChain` 把有效链判 `INVALID`）；
   该文件隔离 5/5 通过（4 次）、整目录 `apps/cli/src` 419 passed（2 次）、
   与两个最可疑干扰源两两并发通过；**根因未定**。
2. 本轮 SHA 的**远端 Windows CI job 失败**（run `34687657690`），两次尝试失败点不同；
   同 run 的 Ubuntu 主门禁与 coverage 成功，release attestation skipped。
   **但同一代码的文档提交 `2db1a9cd`（run `34689110496`）四 job 全绿** ⇒
   该 Windows 失败同样是**波动**而非版本确定性结论；`01c4ec74` 自身的事实结论仍是 failure。
   **不能声称 CI 全绿。**

**NOT_RUN（不勾选）**

- 真实模型 champion 质量（未请求付费 benchmark）。
- release 发布动作本身（各轮计划只到 attestation）。
- CI artifact 的逐字节内容复核（只核实 job/step 状态与失败日志）。

**本轮到此停止扩展**：不再生成架构重写、功能扩张或付费实验类任务。

---

## 8. 最小补足动作（下一轮的起点，先复现再判定）

1. **稳定复现**：在同一机器上重复拿到 `pnpm test` 的 `e4-09` 失败（当前 3/3），
   并让失败时的 evaluator 违规详情可见（例如在测试内把 `decisionArtifact` 的
   violations/原因打印出来，或用 `--reporter=verbose` + 临时环境变量），
   以确定 `INVALID` 的**具体违规码**而不是靠推断。
2. **定位瞬时脏树的来源**：把 4.2 的轮询脚本改成「发现非空立刻打印完整 `git status --porcelain`」，
   或对 `git status` 加 `-uall`，找出是哪个用例在写仓库内可见文件。
3. **判定归属**：若 1 的违规码确为「宿主机状态变了 / 源脏」导致的配对不完整，则问题是
   **生产侧**（宿主机哨兵把「并发运行的其他测试」误判为被测对象污染）还是**测试侧**隔离缺口，
   需要在复现后决定；两种方向都不做架构重写。
4. **Windows CI**：先看 attempt 1 的 `release-command.test.ts`（套件内嵌套 `pnpm typecheck`）
   与 attempt 2 的 `mkdtemp` / delegation-worker 超时是否同源（都指向高负载下的
   进程/文件系统争用）；在拿到稳定复现前，保持「未归因」。

## 9. 残余限制

- 容量上限**未被以「放宽」方式验证过**：R38 的判别性探针是通过替换拒绝消息文本取得的，
  把 `EXECUTION_PLAN_MAX_PLANNED_SAMPLES` 调大后 R38-b 仍 PASS（怀疑数字超出安全整数范围
  导致护栏不触发）。因此「上限数值本身」的判别性未证实（详见 `docs/E4-R38-report.md`）。
- 4.2 的轮询只在**一次**全量运行中执行，样本量为 1；观察到 1 次非空窗口，
  **未能捕获文件名**。
- §4.1 第 8 步之后的第三次全量运行与前两次失败点相同，但三次都在同一台机器、同一时段、
  同一 `node_modules` 状态下进行，不能据此推断其它环境的表现。
- 本报告不引用自身 SHA；`documentationCommitSha` 的确认以推送后的提交列表为准。
- **操作失误如实记录**：我把两个文档提交连续推送，触发 workflow 的
  `concurrency.cancel-in-progress`，导致 `a0a99ce0` 的 run `34689017816` 被**取消**（而非跑完）。
  该 run 的结论不可用作证据；下一个提交 `2db1a9cd` 的 run 才是有效的文档提交证据。
- 容量上限的判别性未证实（见本节第一条）与 `INVALID` 根因未定，
  共同意味着**本轮不能宣称「Runtime + 门禁全绿」**。
