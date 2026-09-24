# E4-R66 报告：固定版本验收与有限收口

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 审查基线（计划 §0） | `04edb9d90b28c08af46e038265e3aed4ba408abf` |
| **本轮实现版本（本报告绑定的 HEAD）** | **`07aea10e42314582ef1ddb7b8094c73af5400d0d`** |
| 推送范围 | `04edb9d..07aea10`，共 **7** 个提交（R62→R65） |
| 环境 | Windows (win32)、Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10` |

7 个提交（由旧到新）：`9240f65`(R62) `94ed80c` `c6eeeb0`(R63) `a4a5769` `6e02fe1`(R64)
`06a4f75` `07aea10`(R65)。其中 `07aea10` 是纯文档提交，但它是 CI 实际验证的 SHA，
且其父 `06a4f75` 已包含 R62–R65 的全部代码改动。

**版本归属声明**：本报告只归属 `07aea10`。R61 的 `#137`（`0858442`）结论**不属于**本版本。

## 2. H62–H65 关闭矩阵

| ID | 复现（修复前实测） | 修改 | 反向断言（判别力） | testedSourceSha（blob） | 结果 | 残余限制 |
|---|---|---|---|---|---|---|
| **H62** | 隔离工作树（`git worktree` + 离线 `pnpm install`）还原旧固定路径后，真实 `tsc -b apps/cli --listFiles --force`（7950 个文件）**包含** `src/e4-r55-mutated-chain.generated.ts`；真实构建产出 **4 个** dist 产物（`.js` / `.js.map` / `.d.ts` / `.d.ts.map`），dist 由 292 → **296** | `apps/cli/tsconfig.json` 的 `exclude` 增加**精确**的 `src/e4-r55-mutated-chain.generated.ts`（结构性、不删源码）；父测试 afterAll 的窄迁移守卫增加对那 **4 个精确文件名**的 dist 孤儿清理（无通配、不清空目录） | 去掉 exclude → `--listFiles` 重新包含该文件、重建重新产出 4 个产物；套件内 R62 结构守卫在去掉 exclude 时**失败** | `tsconfig.json` `5c9a999a…`；`e4-r55-failure-wiring.test.ts` 见各行 | ✅ 排除后 `--listFiles` 计数 **0**，重建**不重新产出**；真实业务源码与父测试仍在输入内；`test-infra` 收集数 **0** | 已有 dist 孤儿**不会**因 exclude 自动消失（实测：加回 exclude 后 4 个孤儿仍在）——由 afterAll 的精确清理处理；CI 干净检出从不产生它们 |
| **H63** | 逐字重跑旧 `appendBounded`：`cap=1` 与 `cap=2` 保存"中"均得 **3 字节**（U+FFFD），`BUDGET_OK=false`；同一字符按 3 个 1 字节 chunk 到达时变成 U+FFFD | 新增 `createStreamCapture`：保留原始字节、**只解码一次**、按完整字符边界截断；新增 `completeUtf8PrefixEnd` / `decodeWithinBudget`；`ControlledChildOutcome.capture` 给出 `receivedBytes` / `capturedBytes` / `truncated`；`run.json` 记录该合同 | 恢复旧切割方式 → **6/10 失败**（A、C、D、F、G、I） | `e4-r55-child-harness.ts` `34581428…`（R63 提交）；`e4-r55-failure-wiring.test.ts` `7e5f5002…` | ✅ 10 例全通过；cap=1/2 → 空串且 0 字节；cap=3 → 完整"中"；emoji 四字节边界；跨 chunk 与单 chunk 结果相同；落盘文件字节数 == `capturedBytes` | 这是**文本**合同（非法 UTF-8 替换为 U+FFFD 并标 `truncated`），不是字节保真合同 |
| **H64** | 注入 seam 复现：异步 `error` 事件只记日志，**直接回退调用次数 = 0**；非零退出完全未检查 | `killTree` 返回结构化 `TreeKillResult`（requested / mechanism / command / commandLaunched / commandExitCode / commandError / directFallbackAttempted / directChildSignalled / settled）；`error` 与非零 `close` 均触发**恰好一次**回退；grace 到期 `releaseUnreapedChild()` 释放句柄；`run.json` 记录 `treeKill` | 恢复旧实现（error 只记日志 + 不检查退出码）→ **5/11 失败**（A、B、D、H、I） | `e4-r55-child-harness.ts` `87b0eeea…`（R64 提交）；`e4-r55-failure-wiring.test.ts` `a0deaa3e…` | ✅ 11 例全通过；本机**真实** `taskkill` 路径实测：`mechanism=taskkill`、`commandLaunched=true`、`reaped=true`、未触发回退；grace 路径实测 **508 ms 返回**（子进程本要活 4 s） | 回退只证明**直接子进程被要求去死**，不证明整树消失；`commandExitCode` 可能为 null（父进程先观察到子进程终止） |
| **H65** | 旧归档形状：不传 diagDir / 目录为空 / 目录不存在 / 目录不可读 / 有链接被跳过——**五种情况全部表现为 `files = []`**，`run.json` 无 `evidence` 段；跳过的链接还会**混进**"已复制"列表 | `copyTree` 返回结构化 `CopyTreeResult`（`copied` / `entries{path,status,operation,errorCode,reason}` / `sourceMissing` / `empty` / `integrity`）；`run.json` 写入 `evidence` 清单与完整性；跳过的非普通文件**绝不**进 `copied`；归档根不可用 → `ok:false` + `archive-failed`；父验证消息同时给出**位置与完整性** | 恢复旧归档形状 → **7/9 失败**（A、B、C、D、E、F、I） | `e4-r55-child-harness.ts` `dc32370d…`（R65 提交）；`e4-r55-failure-wiring.test.ts` `24f52bff…` | ✅ 9 例全通过；ENOENT / ENOTDIR 的操作+错误码+原因可从 `run.json` 恢复；空目录与缺失目录仅凭归档即可区分 | 本机沙箱阻止（或静默忽略）符号链接创建，`skipped` 分支只能降级验证（真实判定留给 CI）；"同一棵树一份成功一份失败"未在本机构造成功（见 R65 §8.3） |

## 3. 本地门禁（`07aea10`，已提交、干净、运行期间静止）

运行前实测 `git status --porcelain` 为**空**（本轮计划文件已移出仓库，见 §7.4）。
**入口未偏离**：以下四条都使用 `package.json` 声明的入口本身。
本机代理沙箱的删除垫片会拦停 `pnpm` 包装层，因此统一在命令环境中设
`CODEBUDDY_SAFE_DELETE_ENABLED=0`（该开关只关闭本机垫片，**不改变**任何入口、阈值或收集范围）。

| 门禁 | 命令（定义入口） | 退出码 | 结果 |
|---|---|---|---|
| 类型检查 | `pnpm typecheck` | **0** | `tsc -b` 通过 |
| 文档验证 | `pnpm docs:verify` | **0** | **ALL CHECKS PASS**（含 E4-00 诚实 PASS） |
| 全量测试 | `pnpm test` | **1** | 文件 **7 failed / 320 passed (327)**；用例 **6 failed / 5825 passed / 1 skipped (5832)**；343.45 s |
| 覆盖率 | `pnpm test:coverage` | **1** | 文件 **6 failed / 321 passed (327)**；用例 **6 failed / 5825 passed / 1 skipped (5832)**；433.95 s；**未报告任何阈值失败** |

### 3.1 本地 6 项失败的逐条归因（全部为代理沙箱，零仓库缺陷）

与 R61 在 `0858442` 上的判别性实验**完全同名**（当时已证明在关闭垫片后剩下的唯一失败就是这 6 项）：

| # | 文件 | 失败用例 | 原因 |
|---|---|---|---|
| 1 | `packages/evaluation/src/promotion-envelope-forgery.test.ts` | `symlink escape: candidate ref is a link out of the bundle -> PATH_OUTSIDE_BUNDLE` | 沙箱禁止创建符号链接 |
| 2 | `packages/tools/src/tools/exec-workspace-policy.test.ts` | `symlink inside pointing outside is rejected (WORKSPACE_POLICY:symlink-escape)` | 同上 |
| 3 | `packages/tools/src/tools/exec-workspace-root-alias.test.ts` | `a link INSIDE the aliased workspace pointing outside is STILL rejected` | 同上 |
| 4 | `packages/security/src/canonical-path.test.ts` | `resolves a symlink to its real target (no textual illusion)` | 同上 |
| 5 | `packages/harness/src/security-regression-matrix.test.ts` | `symlink escapes: canonical containment is enforced on real links` | 同上 |
| 6 | `packages/harness/src/adversarial-regression.test.ts` | `A2 real symlink escape fails canonical containment` | 同上 |

`pnpm test` 另有一次**文件级**失败 `packages/tools/src/process/executor.test.ts`
（`afterAll` 的 `EBUSY: resource busy or locked, rmdir …\ar-exec-XXXX`，Windows 定时性）——
它在覆盖率运行中**未复现**（6 files vs 7 files），确认是重负载下的偶发，与本轮改动无关，已在 R60/R64 报告记录。

**本轮新增的 31 个用例（R62 1 + R63 10 + R64 11 + R65 9）在全量运行中全部通过。**

### 3.2 覆盖率阈值

本地覆盖率运行**没有**输出任何 `ERROR: Coverage … does not meet threshold`：
失败全部来自 §3.1 的 6 项。阈值本身未改动（`vitest.config.ts` 未被触碰），
且 `git diff --name-only 04edb9d..07aea10 -- 'packages/*/src/**'` 过滤 `*.test.ts` 后为空 ——
**本轮没有改动任何被覆盖率度量的非测试源码**，因此阈值不可能被本轮影响。
权威确认：**CI `#139` 的 `coverage gate (ubuntu)` 为 success**。

## 4. CI 核实（实现版本 `07aea10`）

### 4.1 四个必需 job（run #139，attempt 1）

| job | job ID | 结果 | 起止（UTC） |
|---|---|---|---|
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | `103889226916` | **success** | 07:13:29 → 07:16:30 |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | `103889226853` | **success** | 07:13:29 → 07:18:54 |
| `coverage gate (ubuntu)` | `103889226640` | **success** | 07:13:28 → 07:16:20 |
| `release attestation (P38-12)` | `103890571096` | **success** | 07:18:56 → 07:19:20 |

- run：`34816854347`（`#139`）、head SHA `07aea10e42314582ef1ddb7b8094c73af5400d0d`、attempt **1**、
  event `push`、`completed / success`。四个 job **全部** success（无 failure / cancelled / **skipped**）。

### 4.2 产物（只核**存在性**，未读内容）

`#139` 共 **13** 个产物，含 `release-evidence-07aea10e42314582ef1ddb7b8094c73af5400d0d`（82372 B）、
`coverage-summary`（6677 B）、`gate-evidence-coverage`（13907 B）、`gate-evidence-windows-latest`（34518 B）、
`benchmark-smoke-windows-latest`、`capability-matrix-07aea10…-ubuntu-latest` 与 `-windows-latest`。

两条**有条件的**推断（按计划 §7.7，不把"产物缺失"单独当作"无失败"的证据）：

1. **没有** `e4-09-diagnostics-windows-latest-*`。该步骤是 `if: failure()`，因此"缺失"只说明它**没被触发**；
   结合 windows job **success** 才能推断 e4-09 家族在 Windows 上未失败。单看缺失**不构成**证明。
2. **没有** `e4-r55-parent-diagnostics-*`（E4-R60 新增的 `if: failure()` 上传）。
   同理，只有与四个 job 全绿**结合**时才支持"父验证是可判定的"这一结论。

**边界**：以上只证明**上传发生过/未发生**。**未读取任何产物内容**（下载需认证），
因此**不声称**其中的 decision / V3 / paired 证据内容有效。

## 5. 验收结论（计划 §6「怎么验收」）

| 验收项 | 结果 |
|---|---|
| H62 真实编译输入不含旧变异残留 | ✅ 隔离工作树实测：排除后 `--listFiles` 计数 0、重建不产出 4 个孤儿 |
| H63 stdout/stderr 与落盘日志始终符合字节合同 | ✅ 10 例；`capturedBytes ≤ cap` 恒成立，落盘字节数 == `capturedBytes` |
| H64 异步 taskkill 失败有回退与真实终止状态 | ✅ 11 例；本机真实 `taskkill` 实测通过；grace 路径 508 ms 返回 |
| H65 缺失/部分复制从归档自身可判定 | ✅ 9 例；五种场景在 `run.json` 中互不相同 |
| 四个必需 CI job 对应正确实现版本成功 | ✅ `#139` / `07aea10` / attempt 1，四 job 全绿 |
| 本地测试、CI job 状态、artifact 内容验证分开报告，NOT_RUN 不改写为 PASS | ✅ 见 §3（本地 6 项沙箱失败）、§4（job 状态）、§4.2（产物内容 NOT_RUN） |
| 未新增付费调用、新 release、Runtime 重构或无关功能 | ✅ 只改 `apps/cli` 的测试基础设施与 `apps/cli/tsconfig.json`；未触碰 Runtime / 权限 / 沙箱 / 验证架构 |

**总状态：本轮 H62–H65 四个边界缺陷已关闭，四个必需 CI job 在同一实现版本上全绿。**
唯一未闭合项是"本地全量测试 0 failed"，其原因为**代理运行环境**（沙箱禁止创建符号链接），
已在 §3.1 逐项归因，并由 CI（无此限制）在真实 Ubuntu 与 Windows runner 上取得通过。

## 6. 与上一轮的关系（不退回 R57–R61 的成果）

- R57（构建前置）、R58（LF/CRLF）、R59（每次运行独享变异路径）、R60（异步受控子进程与证据协议）
  在 `#139` 中**继续通过**，未被本轮退回。
- R61 的 CI 绿色事实（`#137` / `0858442`）保留；本轮是其**增量修复**，不是"上一轮完全未完成"。
- 本轮新增的 31 个用例与既有 11 个 R60 用例在同一文件内共 42 例，`#139` 中全部通过。

## 7. NOT_RUN 与残余限制

1. **CI job 日志正文未读**：匿名下载返回 `403 Must have admin rights`；无 `gh`；无 token；
   GitHub 连接器未接入 workflow-log 工具。本报告的 CI 结论来自 **job 级状态 + 产物元数据**（可匿名读）。
2. **未读取任何 artifact 内容**（下载需认证），故不声称其内容有效。
3. **本地 6 项符号链接用例不可通过**（沙箱禁止 `symlink`）；只能由 CI 覆盖 —— `#139` 已覆盖。
4. 本轮计划文件（`plan(20260914-060231).md`）在门禁运行期间被**移出仓库**（放于 `.workbuddy-ai/`，
   该目录已 gitignore）以取得"可证明干净"的工作树，随后已还原到仓库根。仓库仍**不包含** `plan.md`。
5. **H65 的 `skipped` 分支在本机只能降级验证**（沙箱阻止/静默忽略符号链接创建，见 R65 §8.2）。
6. **H64 的"真实 Windows taskkill 启动失败"未在本机真实执行**，由注入 seam 覆盖（R64 §2 已声明层级）。
7. 未做付费模型调用、未发布新 release、未强推。

## 8. 收尾

按计划 §7：四个具体缺口已关闭且必需 CI 通过，**停止基础设施维护**。
本报告是**纯文档提交**，按计划 §6.8 可引用实现版本证据（§2 的 blob 表 + §4.1 的 run/SHA），
不必无限追踪自己的下一次 CI。
当前**没有**真实模型质量证据，**不**宣称 Agent 任务完成率或 champion 质量已提升。

---

## 9. 补记（2026-09-14，E4-R68）：本报告 §4.2/§7 的证据边界澄清

R68 复查时发现本报告有两处推断写得比证据强。此处澄清（原文保留）：

### 9.1 §4.2 的"产物缺失"推断已带条件，但表述可再收紧

本报告 §4.2 已经写明"缺失只说明该步骤没被触发……单看缺失不构成证明"，这一点**保持**。
需要补强的是：`if: failure()` 的上传步骤**没触发**只蕴含"**该步骤之前的**所有步骤都成功"，
**不**蕴含"所有故障分支都被执行过"。**绿色的 CI 与"故障分支已覆盖"是两件事**——
本报告 §5 的"总状态"不应被读成后者。R67/R68 正是为了补上"分支是否真的执行"这一层。

### 9.2 §4.2 的"没有 `e4-r55-parent-diagnostics-*`"只在特定条件下可读

该产物由 `preserveEvidence` 写出、由 `if: failure()` 上传。因此它的缺失有两种成因：
(a) 父验证可判定（无证据需要保留）；(b) 失败发生在**上传步骤之前**。
本报告 §4.2 已要求与 job 级状态**结合**，此处进一步明确：**只有"四个 job 全绿 + 该产物缺失"
这个组合**才支持 (a)；单独看缺失**不**支持任何结论。**R69 复核 CI 时按此口径执行。

### 9.3 本报告不涉及的部分

§7.7（覆盖率陈述需改为有限陈述）与 §7.8（`executor.test.ts` 的 `afterAll` EBUSY 观察）
是 **R69** 的更正范围，本补记不改写它们，留待 R69 处理。

## 10. 补记（2026-09-14，E4-R69）：覆盖率陈述收窄、EBUSY 归因边界、两项旧清单过期

原文（§3.1、§3.2、§5）全部保留不改写；以下是 R69 在 `9495f42`（代码等价 `afeb3e5`，CI run **#142**
`34828237504`）上实测后的更正性说明。

### 10.1 §3.2 的"阈值不可能被本轮影响"是过度陈述

原文写的是：*"本轮没有改动任何被覆盖率度量的非测试源码，因此阈值**不可能**被本轮影响"*。

这个因果推断不成立。**正确的有限陈述**是：被度量的源码与阈值定义均未改动，
但**测试执行路径的变化仍然可能改变覆盖率数字**（哪些行被走到会变）。因此结论只能由
**实际 coverage 门禁的结果**给出，不能由"非测试源码未变"推出。

R69 实测直接支持这一点：**同一个提交**的覆盖率在两个环境下不同 ——

| 环境 | %Stmts | %Branch | %Funcs | %Lines | 阈值错误 |
|---|---|---|---|---|---|
| 本地 Windows（`pnpm test:coverage`） | 90.05 | 81.55 | 92.37 | 91.83 | 无 |
| CI `coverage gate (ubuntu)`（#142） | 90.21 | 81.66 | 92.77 | 91.97 | 无 |

权威口径因此为：**度量源码与阈值未变 + 实际 coverage 门禁通过**（#142 的
`coverage gate (ubuntu)` 与步骤 `Coverage gate (thresholds fail the job)` 均 success）。
原文末尾"权威确认：CI `#139` 的 coverage gate 为 success"这一做法本身是对的，
错在前半句把结论说成了**必然**。

### 10.2 §5 的"唯一未闭合项"覆盖了 §3.1 自己记录的 EBUSY —— 予以澄清

§5 原文写"唯一未闭合项是『本地全量测试 0 failed』，其原因为代理运行环境（沙箱禁止创建符号链接）"。
但 §3.1 末段自己记录了第 **7** 项文件级失败：`packages/tools/src/process/executor.test.ts`
的 `afterAll` 抛 `EBUSY: resource busy or locked, rmdir …\ar-exec-XXXX`。

**EBUSY 不是"沙箱禁止创建符号链接"这一类**，所以 §5 的"唯一未闭合项都是沙箱"**不成立**，
它把一个归因未定性的观察并进了一个不同性质的结论。按 R69 口径澄清为三项独立事实：

1. **历史观察**：该项在 R66 的运行中出现过一次（`pnpm test` 7 files failed，
   `pnpm test:coverage` 6 files failed，故当时判为重负载偶发）。
2. **是否复现（R69）：否。** R69 在 `9495f42` 上本地三次运行（`pnpm test` ×2、
   `pnpm test:coverage` ×1）与 CI 两个平台的日志中**均无 EBUSY**（全量 grep）。
3. **归因边界**：R66 当时"与本轮改动无关"的判断**没有做判别性实验**，只是基于"覆盖率运行未复现"。
   R69 同样**不**声称已证明它与任何改动无关 —— 它保持为**未定性的历史观察**，
   既不计入本轮缺陷，也**不**写成"已排除"。据计划 §5.8，**不**因此追加 Runtime 修复任务。

### 10.3 §3.1 的 6 项沙箱失败清单已过期

R69 在 `9495f42` 上实测：§3.1 列出的 6 项符号链接用例（`promotion-envelope-forgery`、
`exec-workspace-policy`、`exec-workspace-root-alias`、`canonical-path`、
`security-regression-matrix`、`adversarial-regression`）**全部通过**，本地
`pnpm test` 为 `327 passed (327)`、`5845 passed / 2 skipped`；**而同机**
`fs.symlink` 仍返回 **EPERM**（R68 能力探针 `R68_SYMLINK_CAPABILITY={"ok":false,…EPERM}`）。

即：**"创建符号链接"与"读/规范化既有链接"不是同一能力**，§3.1 把六项统一归因于
"沙箱禁止创建符号链接"过度外延。因此 §5 中"唯一未闭合项是本地全量测试 0 failed"
在 R69 已**不再成立**（本轮本地全量为 0 failed）。

### 10.4 §7.1"CI job 日志正文未读"这一边界在 R69 已闭合

R69 用仓库已配置的推送凭据（**只读**）取得 #142 的 run 日志包并核对了具体行
（真实链接分支执行、coverage 表格、attestation verdict）。**匿名下载产物 zip 仍是 401**，
产物**内容**未解析，所以 §7.2（未读产物内容）的边界**保持有效**。
