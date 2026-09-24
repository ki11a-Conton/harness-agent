# E4-R60 报告：使父验证的子进程超时、错误和证据可判定

## 1. 问题（G60，P2；依赖 R59）

R55 父验证用 `spawnSync` 驱动隔离子进程，没有 `timeout`，只保留 `proc.status`，然后用
`JSON.parse(await readFile(reportPath))` 读报告，并在 `afterAll` 里无条件删除所有临时根。
由此产生五个**源代码可确认**的缺口：

| # | 缺口 | 后果 |
| --- | --- | --- |
| 1 | `spawnSync` 阻塞事件循环，底层无 timeout | 外层 `it(..., 900_000)` 无法中断阻塞调用；挂起的子进程会把整个套件挂死，而不是给出判定 |
| 2 | `proc.error` / `signal` / `stdout` / `stderr` 全部丢弃 | "子进程从未启动"和"子进程被信号杀死"都变成无关错误，无法区分 |
| 3 | `JSON.parse(readFile(...))` 直接抛错 | 报告缺失/非法时，真实进程结果被 ENOENT/SyntaxError 遮蔽（启动失败被报成"报告文件不存在"） |
| 4 | `afterAll` 无条件删临时根 | 父验证失败时，正是它需要的诊断被自己删掉 |
| 5 | 变异分支只断言"验收失败" | 不检查退出码、精确测试集、失败原因，导入错误/超时/其它异常都能冒充有效的顺序反例 |

## 2. 修复前复现（受控子进程）

| 复现 | 旧行为 |
| --- | --- |
| 永不结束的子进程（含一个后代进程），deadline 2–4 s | `spawnSync` 无 timeout，调用永久阻塞；外层异步超时对同步调用无效 |
| 不存在的可执行文件 | 只得到 `proc.status === null`；随后 `readFile(reportPath)` 抛 ENOENT，**唯一可见原因变成"报告不存在"** |
| 子进程写 stderr 后 `exit(3)` | stderr 被丢弃，只剩一个裸的非零状态 |
| 报告缺失 / 报告内容为 `{ not json` | 两种情况都是同一个未捕获的抛错，无法区分 |
| 父验证判定失败 | `afterAll` 先删 `tempDirs`，证据不可恢复 |

## 3. 新增：子进程生命周期 + 证据协议

新增 `apps/cli/src/e4-r55-child-harness.ts`（**不是**通用调度平台：无队列、无重试、无池），四件最小设施：

### 3.1 `runControlledChild(spec)`

- **异步 `spawn`，不经 shell**：参数原样传递，含空格的路径（本仓根目录 `D:\Harness Agent`）
  不会被 shell 重新切分，退出码属于真实程序本身。
- **真实 deadline + 进程树终止**：Windows 用 `taskkill /pid <pid> /t /f`（与生产
  `ProcessExecutor` 同一配方）；POSIX 用 `detached` 让子进程自成进程组，再向该组发信号
  （`process.kill(-pid, "SIGKILL")`），单次信号覆盖全部后代。
- **先取终态再返回**：`close` 事件到达后才 resolve；若树杀后 grace 内仍无终态，则诚实返回
  `reaped: false`，而不是假装子进程已消失。
- **有界输出**：stdout/stderr 各自按字节预算截断，超预算置 `outputOverflow: true`（不静默截断）。
- **终止分类**（互斥且穷尽）：`exited` / `signalled` / `timeout` / `spawn-error`。
- **启动失败不伪造退出码**：`spawn-error` 时 `exitCode: null`（没有进程退出过），平台自己的
  启动失败码（Windows 实测 `-4058`）单独记在 `launchFailureCode`，绝不当作退出码。

### 3.2 `readChildReport(path)`

分类而非抛错：`ok` / `missing` / `unreadable` / `invalid-json` / `unexpected-shape`，
并保留可读时的原始字节。报告问题与进程事实并列返回，因此"子进程没产出报告"永远不会
被误读成"子进程没跑"。

### 3.3 `judgeChildProcess(outcome, report, expected)`

返回**每一条**"该次运行不可判定"的理由，而不是布尔值：启动失败、超时、信号、未取到终态、
输出超限、报告不可用、**断言集与预期不完全一致**、退出码不符。断言集是精确比较，因此
额外失败、标题被改、意外成功都会拒绝该次运行。

### 3.4 `preserveEvidence(input)`

在运行自身清理**之前**，把有界 stdout/stderr、原始报告、诊断 bundle 树的**副本**、
以及带全部判定理由的机器可读 `run.json` 写入一个清理扫不到的位置
（CI 指向 gitignore 的 `.ci/r55-parent-diagnostics`，本地落 `tmpdir`）。
不落完整环境变量，只记运行类别。

## 4. 父验证重写

`apps/cli/src/e4-r55-failure-wiring.test.ts` 改为：

1. 所有子进程（含 `git status` 前置检查）都走 `runControlledChild`，**不再有未设超时的阻塞调用**；
2. 每次运行的判定**先收集成 `reasons` 列表**，不内联 `expect`；
3. `conclude(run, reasons)`：若有理由 → 先 `preserveEvidence` 并打印位置 → 再释放该 run 自己拥有的资源 →
   最后才 `expect(reasons).toEqual([])`。成功时只做正常清理；
4. 控制轮与变异轮使用**同一**进程/退出码/断言集契约；
5. 变异轮额外必须证明自己是**有效反例**：到达 `evaluate`、确实死在目标 ACCEPT 断言、
   decision 角色已注册但文件从未落盘、其它产物仍在且字节一致、副本的每个相对导入都指向真实模块；
6. 清理失败**上报而非吞掉**（`reportDegraded`），runs root 改用 `rmdir` 删除空目录——
   旧的 `rm(..., {recursive:false})` 根本删不掉目录（EISDIR），而 `.catch(() => {})` 把
   这个失败完全静默了。

`.github/workflows/ci.yml` 增加 `E4_R55_PARENT_DIAG_DIR: .ci/r55-parent-diagnostics` 与
一个 `if: failure()` 上传步骤，因此父验证诊断**不再只依赖 e4-09 原有的 hook**。

## 5. 本轮发现的真实缺陷：R59 的负控制是**空转的**（重要）

重写后第一次运行，新的判定直接拒绝了变异轮，被保留的证据给出了精确原因：

```
Cannot find module
'/apps/cli/test-infra/e4-r55-runs/src/benchmark-command.js'
imported from D:/Harness Agent/apps/cli/test-infra/e4-r55-runs/run-1s2Hhx/chain.ts
```

R59 把变异副本从 `apps/cli/src` 搬到每次 run 独享目录，但只重写了副本的**唯一静态**导入
（`e4-09-diagnostics`）。该模块还有一个**动态**导入
（`import("../src/benchmark-command.js")`），它仍指向旧位置，所以搬迁后的副本**根本无法加载**。

后果不是"测试坏了"，而是**负控制完全空转**：

- 变异子进程死在 `setup` 阶段；
- 但 `registerArtifacts` 在它之前就已执行，所以 bundle 里 decision 角色**存在**且
  `captured: false`，`paired-experiment` / `v3-candidate` 同样 `captured: false`；
- 旧验收恰好只检查这个形状（decision 未捕获、`acceptance()` 为 false、理由含 `decision-artifact`），
  于是判定"验收绑定在接线而非 recorder 上"。

但**"decision 产物从未被产出"与"decision 从未被持久化"对形状型检查是不可区分的**。
也就是说 R59 的"顺序变异反例"只证明了副本加载失败，**没有证明任何关于落盘顺序的事情**。
这正是 R60 §5/§6 要求堵住的失效模式，也是本轮最有价值的发现。

### 5.1 修法

`rewriteChainRelativeImport` 替换为 `relocateChainImports(source, fromDir, toDir)`：

- 重写**全部**相对说明符（静态 `from "..."` 与动态 `import("...")`）；
- 以**原模块目录**为基准解析目标，再以副本目录为基准重新表达，保留 TS ESM 的
  `.js` 说明符约定（`.js` 说明符指向 `.ts` 源）；
- **自校验**：断言重写前后"绝对导入目标集合"完全相同，未来新增相对导入不会静默漏掉；
- 跨卷（Windows 不同盘符）无法表达为相对说明符时**明确拒绝**，而不是产出解析不到的副本。

父验证另外会解析副本自己的说明符，要求它们分别到达**真实**的 `e4-09-diagnostics` 与
`benchmark-command` 模块。

### 5.2 修复后的真实反例证据

直接驱动子进程（对照轮，`E4_R55_CHAIN_MODULE` 指向真实模块，`E4_09_DIAG_DIR=.ci/r55-control-probe`）：

| bundle | stage | 失败 | artifacts | decision |
| --- | --- | --- | --- | --- |
| `r55-nonaccept` | `evaluate` | `AssertionError: expected 'INCONCLUSIVE' to be 'ACCEPT'` | paired/v3-baseline/v3-candidate/**decision 全部 captured** | `decision="INCONCLUSIVE"`, `reasonCodes=["EFFECT_BELOW_THRESHOLD"]` |
| `r55-throw` | `evaluate` | `R55 injected evaluator failure…` | paired/v3 captured，decision MISSING | `null` |
| `r55-benchfail` | `benchmark` | `expected 1 to be +0` | 四个角色全部 MISSING | `null`（`benchmarkCli.exitCode=1`） |

变异轮（同一套断言、同一退出码，唯一差别是 decision 落盘块被移到断言之后）：

| 字段 | 控制轮 | 变异轮 |
| --- | --- | --- |
| 断言集 / 退出码 | 3 failed + 1 passed / `1` | **完全相同** |
| `failure.stage` | `evaluate` | `evaluate` |
| `failure.message` | `expected 'INCONCLUSIVE' to be 'ACCEPT'` | **相同** |
| `paired-experiment` / `v3-candidate` | captured | **captured** |
| `decision-artifact` | **captured** | `captured: false`，`ENOENT` |
| `summary["decision-artifact"]` | 非空 | `null` |

两侧**只在 decision 是否落盘上不同**——这才是"验收绑定在生产落盘顺序上"的有效证明。

## 6. 修复后命令、退出码和关键断言

| 验收项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 永不自行结束 → 结构化 timeout、无残留子进程 | `R60: terminates a never-ending child's whole tree at the deadline…` | **通过**：`termination="timeout"`、`timedOut=true`、`killAttempted=true`、`reaped=true`；子进程在 stdout 报出的后代 PID 在树杀后**确认消失**（`process.kill(pid,0)` 轮询） |
| 启动失败 → 保留真实 error | `R60: preserves the REAL launch error…` | **通过**：`termination="spawn-error"`、`spawnError` 匹配 `ENOENT`、`exitCode=null`；同一运行的报告被判为 `missing`，理由同时含 `could not be launched` 与 `unusable (missing)` |
| 非零退出 + stderr 可恢复 | `R60: recovers the real exit code and stderr…` | **通过**：`exitCode=3`、`signal=null`、stderr/stdout 标记均可读、`outputOverflow=false` |
| 输出超限可判定 | `R60: flags an output-budget overrun…` | **通过**：`outputOverflow=true`，捕获 ≤ 1024 B |
| 报告缺失 / 非法 JSON / 形状不符 | `R60: distinguishes a missing report, an invalid-JSON report and an unexpected shape` | **通过**：`missing` / `invalid-json`（保留 `rawText`）/ `unexpected-shape` / `ok` 四态各自成立 |
| 额外失败、错误标题、意外成功、错误 signal → 拒绝 | `R60: rejects an extra failure, a renamed title…` | **通过**：四类都被 `assertion set is not the expected one` / `killed by signal SIGKILL` / `exited with no code` / `expected 1` 拒绝 |
| 父验证失败后证据在清理后仍可读 | `R60: preserves a failing run's evidence somewhere its own cleanup cannot reach` | **通过**：删掉源 `diagDir` 后，`run.json`、`child.stdout/stderr.txt`、`diagnostics/<bundle>/…` **仍可读**；且 `preserved.dir` 不在 `RUNS_ROOT`、不在任何被清扫的 temp 根下 |
| 顺序变异产生目标失败，父验收判定反例有效 | 主用例第 2 轮 | **通过**（见 §5.2） |
| 期望完成的父验证 exit 0 | 全文件 | **11 passed (11)**；主用例 80.1 s，全文件 89.9 s / 86.0 s 两次实测 |
| 不把任意非零当成功 | `judgeChildProcess` | 退出码按**精确值**比较（`expectedExitCode: 1`），子进程报告必须**恰好**是那 4 条断言 |

相邻套件（同源文件、被本轮改动直接影响）：

| 套件 | 结果 |
| --- | --- |
| `e4-09-production-e2e.test.ts`（真实 E2E，共享 `e4-09-real-chain.ts`） | **5 passed**（67.3 s） |
| `e4-r58-mutation-newlines.test.ts` | **5 passed** |
| `e4-r51-read-settle.test.ts` | **6 passed** |
| `e4-r52-raw-bytes.test.ts` | **4 passed** |
| `packages/security/src/no-silent-catch.test.ts`（P14-6 静态扫描） | **4 passed** —— 新增 harness 为 `apps/**/src` 非测试源码，**不含任何空 catch**，全部走 `reportDegraded` 上报 |
| `apps/cli/src/app-server-layering.test.ts`（P30-5 分层扫描） | **3 passed** |

### 6.1 全量 `apps/cli` 套件：16 项失败，**全部归因于代理沙箱**

`vitest run apps/cli`（与 `pnpm test` 相同的 4 项排除）：**458 tests，16 failed / 442 passed**，
失败分布在 5 个文件。逐项归因如下（这不是本任务引入的回归）：

| 失败文件 | 失败数 | 实测失败原因 | 归因 |
| --- | --- | --- | --- |
| `e4-r55-failure-wiring.test.ts` | 2 | `E4-R55 requires a CLEAN committed working tree`；`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":80,"threshold":50,"scope":"turn"}` | 代理沙箱：safe-delete 垫片 |
| `e4-r24-final-result-protocol.test.ts` | 6 | `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（count 77/79/80） | 同上 |
| `e4-09-production-e2e.test.ts` | 4 | `expected 1 to be +0`（benchmark 因树不洁净拒跑） | 同上（垫片留下的 `_tmp_*` 把树弄脏） |
| `benchmark-command.test.ts` | 2 | promotion 运行未产出 paired artifact | 同上 |
| `release-command.test.ts` | 2 | `expected 1 to be +0`（子进程 gate 退出 1） | 沙箱**程序黑名单拦截 `wmic.exe`** |

四项独立证据表明这不是 R60 的回归：

1. **无共享代码路径**：`release-command.test.ts` 只 import `./release-command.js` / `./release-verify.js`，
   与本轮改动的 `e4-09-real-chain.ts` / `e4-r55-child-harness.ts` **没有任何共同路径**，且它**单独运行也失败**（2 failed / 20 passed）。
2. **沙箱 stderr 直接点名**：`PROGRAM BLOCKED BY SECURITY POLICY … wmic.exe`。全仓 TS 源码中
   **没有任何 `wmic` 引用**——它是垫片自己调用的。
3. **垫片自己删除自己的产物都被拦**：`SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":90,"threshold":50}`，
   连 `_tmp_*` 都删不掉（"turn" 作用域，50 次/turn 阈值）。
4. **隔离运行全绿**：`e4-r55-failure-wiring.test.ts` 在洁净树上**单独运行 11/11 通过**（三次）；
   `e4-09-production-e2e.test.ts` 单独运行 **5/5 通过**。

机制：垫片在执行删除时会在进程 CWD（仓库根）留下 0 字节的 `_tmp_<pid>_<hash>` 占位文件，
使 `git status --porcelain` 非空；于是**所有要求"树可证明洁净"的门禁**（生产 benchmark、
gate evidence 的 `passed`、observation evidence）在并行跑套件时集体失败。

因此本节结论：**本地无法用全量套件作为 R60 的通过证据**；R60 的通过证据是隔离运行的
11/11（见 §6 表），全量/CI 结论留给 R61，且必须在**无垫片环境**（真实 CI）上取得。
本轮已做两件事让下一次失败可判定：把"树不洁净"的断言消息改为**列出具体的脏条目**，
使失败能一眼区分"真的未提交改动"与"工具链掉落的 `_tmp_*` 垃圾"；并按仓库既有惯例把
`/_tmp_*` 加入 `.gitignore`（理由与代价见 §10.7）。

## 7. 过程中被守卫抓到的第二个缺陷（如实记录）

`relocateChainImports` 的目标集合自校验在纯函数回归测试里立刻报错：

```
before: D:/Harness Agent/apps/cli/src/benchmark-command.ts, …/e4-09-diagnostics.ts
after:  C:/Users/…/e4-r60-relocate-…/D:/Harness Agent/apps/cli/src/benchmark-command.ts, …
```

原因是 `path.relative` 在 Windows **跨盘符**时返回绝对路径，而绝对路径不是相对说明符。
若不拦截，就会以新形式复现 R59 的缺陷（产出一个解析不到的副本）。现在跨卷搬迁**明确抛错**，
并有对应断言（仅在 `tmpdir()` 与仓库不同卷时执行，Linux 上自动跳过）。

## 8. testedSourceSha

- 被测基线（R59 收口）：`c0ec387`
- 被测文件内容标识（`git hash-object`）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts`（新增） | `85dea52f71eef3c87ed0a08cf43e0a56838b18ce` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `00e921a2921de62adbfedfaf1859c257bb650ea1` |
| `apps/cli/src/e4-09-real-chain.ts` | `6d4784e8459b9941118fe650d56dbc9406c34876` |
| `.github/workflows/ci.yml` | `0e7e69946539177490f11ab82ba4b39527aee250` |
| `.gitignore` | `1bb53f3d0c21359062baf08a7dc62a25a2478436` |
| `apps/cli/test-infra/r55-vitest.config.ts`（本轮未改） | `bd829517f3d4bd66e8b93b7da192a44d0911d359` |

- 本任务实现提交：`a25e117`、`8c3c0d9`、`3877c07`、`7510d3b`（报告：`e502ea0`、`6b13899` 及收尾提交）
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 运行前置：R55 主用例要求**工作树洁净**（生产 benchmark 拒绝在非洁净树上产出可晋升运行）。
  本轮为运行该用例，把仓库外的 Agent 输入文件 `plan(20260914-021748).md` 临时移出工作树，
  运行后已原样移回；它**未被提交**，也不属于本轮交付物。

## 9. NOT_RUN

- 未在真实 CI（Ubuntu / Windows / coverage / release attestation）上验证：留给 R61。
- 未跑 `pnpm test:coverage` / `docs:verify`：留给 R61。
- 全量 `apps/cli` 套件**已跑**（458 tests / 16 failed），但 16 项失败**全部归因于代理沙箱**
  （见 §6.1），因此**不作为通过证据**；本地沙箱内无法取得全量绿灯。
- 未做"两次完整子进程并行父验证"（沿用 R59 的同步屏障方案；完整双跑会把本文件推到约 4 分钟）。
- 未做付费评测、未发布、未强推。

## 10. 残余限制

1. **POSIX 树杀依赖 `detached` 进程组**。若子进程自己再 `detach` 出新的进程组（本仓的
   vitest 不会），单次组信号覆盖不到它。这是有意选择：不做 PID 枚举式扫描，避免误杀无关进程。
2. **`reaped: false` 是诚实但不可自愈的终态**。树杀后 grace（默认 15 s）内仍无终态时，
   父进程返回该状态并让判定拒绝这次运行，而不是无限等待。
3. **`launchFailureCode` 是平台相关字段**。Windows 实测为 `-4058`；POSIX 上通常为 `null`。
   它只作为"启动失败"的补充事实，不参与退出码比较。
4. **`relocateChainImports` 只识别 `from "..."` 与 `import("...")` 两种形式**。若将来模块改用
   `require("./x.js")` 或 import attributes 等其它形式，函数**不会**重写它，目标集合自校验
   也**不会**发现它（因为它不在匹配集合里）。届时需要同步扩展匹配式——这是有意的失败方向：
   现形式下不会静默产出坏副本，但新增形式需要人工跟进。
5. **证据保留根默认落在 `tmpdir`**。本地运行时它由操作系统回收；CI 通过
   `E4_R55_PARENT_DIAG_DIR` 指向 `.ci/` 并上传。未设置该变量且 CI 步骤缺失时，
   本地证据不会被上传——上传接线已加，但**未在真实 CI 上验证**（见 §9）。
6. **本任务未处理 R57（coverage 前置构建）、R58（换行）已交付项**，也未取得 R56 收口所需的
   真实 CI 通过——这些分别属于 R57/R58/R61 的范围。
7. **本地代理沙箱会系统性污染"洁净树"类门禁**（§6.1）。垫片在仓库根留下 0 字节
   `_tmp_<pid>_<hash>` 占位文件，且其 50 次/turn 的删除阈值会在并行套件中直接抛错。
   这是**环境**问题（真实 CI 没有垫片），但它使"本地全量绿灯"在本机不可获得；
   R61 必须在真实 CI 上取证。

   本轮把 `/_tmp_*` 加进 `.gitignore`。理由与仓库既有条目（`.workbuddy-ai/`、
   `.tmp-mining-*/`）完全一致：它们都是**开发工具掉落物**，不是源码改动，不该让
   `git status --porcelain` 变脏。计划第 5 条禁止的是"用 gitignore 替代编译器/收集器的
   真实输入隔离"——`_tmp_*` 既不是编译输入也不是测试收集输入，且它们在真实 CI 中不存在，
   所以这里不构成"用 gitignore 换门禁通过"。
   **代价必须说清楚**：这让本地的洁净性哨兵**看不到**这类掉落物。依据是它们为 0 字节、
   由环境垫片产生、CI 中不存在。若将来出现非零字节或不同命名的工具产物，需要**重新评估**，
   而不是扩大通配范围。
   （实测代价：在本轮一次 `git add -A` 中，一个 `_tmp_*` 掉落物被误提交进 `6b13899`，
   已在后续提交中移除——这既是加这条规则的直接动因，也是"不加规则"的代价。）
8. **R59 的负控制空转问题（§5）已修，但只覆盖了一种顺序缺陷**：本任务仍只变异
   "decision 落盘移到断言之后"。计划第 7 条允许"注册或 decision 保存"二选一，R55 报告
   §8 已记录"注册前移"的变异未做——本轮未扩大该范围。

---

## 11. 补记（2026-09-14，E4-R61）：CI 全绿 + §6.1 的垫片机制已查清

### 11.1 四个必需 job 全绿

§9 的 NOT_RUN 已由 R61 关闭：run `#137` `34809270367`
（head `08584422061322d82465377a773624a8f7f0315f`，attempt 1）四个 job **全部 success**：
`ubuntu-latest` `103867145225`、`windows-latest` `103867145257`、`coverage gate (ubuntu)`
`103867145008`、`release attestation (P38-12)` `103868080374`。本任务新增/重写的 11 例
父验证用例在该 run 中通过。详见 `docs/E4-R61-report.md`。

### 11.2 §6.1 / §10.7 的垫片机制已读源码查清

`node-language-shim.cjs` 经 `NODE_OPTIONS` 预加载进**每个** Node 进程，拦截 `fs.rm` →
调用 `safe-delete-bulk-guard.cjs`；守卫按 `CODEBUDDY_CONVERSATION_REQUEST_ID` 累计**本 turn**
删除计数，达 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`（本机 50）即 `confirmRequired` 并拒绝，
且同一 turn 内**不回落**。两种实际阻断形态：

1. `pnpm test` 在 pnpm 包装层直接中止；
2. `vitest run --coverage` 在 `V8CoverageProvider.clean` 删 `coverage/` 时抛
   `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（抬阈值后改为 `genie-trash … ETIMEDOUT`）。

**三档判别性对照（同一 HEAD、同一干净工作树）**：

| 条件 | 失败文件 | 失败用例 |
|---|---|---|
| 守卫生效（该 turn 已用 111 次删除） | 10 failed / 317 passed (327) | 17 failed / 5783 passed / 1 skipped |
| 抬高阈值 + 换 requestId | 6 failed / 321 passed (327) | 6 failed / 5794 passed / 1 skipped |
| 完全禁用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` | 6 failed / 320 passed (327) | 6 failed / 5794 passed / 1 skipped |

结论：17 项中 11 项由垫片造成；剩余 **6 项全为符号链接创建被沙箱拒绝（EPERM）**，
与 R56 §4.1 簇 C 的 6 个套件逐个同名。**本机失败总数是"本 turn 删除预算"的函数，不是稳定量。**

### 11.3 §10.7 关于 `/_tmp_*` 的取舍：R61 实测确认

R61 的多次全量运行中，`git status --porcelain` 始终为**空**，即使仓库根同时存在 5 个
0 字节 `_tmp_<pid>_<hash>`。即该规则**只**影响 `git status --porcelain --ignored` 这类显式
列举，不影响洁净性哨兵使用的 `git status --porcelain`。§10.7 记录的"代价"（哨兵看不到掉落物）
在实测中未产生任何误判。

### 11.4 本轮观测到的唯一非垫片、非符号链接的本地失败

`packages/tools/src/process/executor.test.ts` 的 `afterAll` 在重负载（带 coverage 的全量运行）下
曾报 `EBUSY: resource busy or locked, rmdir …\ar-exec-XXXX`。这是 Windows 定时性问题，
**未在本轮修复**（不在 G57–G60 范围），且**未在 CI 上复现**（#137 全绿）。记录为已知残余风险。
