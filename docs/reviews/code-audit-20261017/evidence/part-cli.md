# apps/cli 审查结果

## 0. 结论摘要

- 范围 `git ls-files apps/cli` = **153 个文件**（138 个 `src/*.ts`，其中 98 个 `*.test.ts`；8 个 `test-infra`；3 个 `scripts/*.mjs`；`package.json` / `tsconfig.json` / 2 个 `.gitkeep`）。
- 共 **15 条**发现：A 类 9、B 类 1、C 类 0、D 类 5；级别 **P1×2、P2×9、P3×4**（ID 中 `CLI-009` 为编写期合并掉的空号：`main.ts` 退出码语义已并入 CLI-008）。
- 最值得先修：**CLI-001**（`release artifacts` 的 `capability_audit` 门禁在 Windows 上必失败）、**CLI-002**（`champion eval` 位置参数被 flag 值污染）、**CLI-003**（`execFileSync(..., shell:true)` 拼接命令）、**CLI-005**（参数解析两套风格 + 缺值静默）、**CLI-007**（`doctor` 硬编码工具个数 11）。
- 正面结论：`apps/cli/src` 内**没有** `process.exit(` 调用（全部走 `{ exitCode, lines }` 返回），**没有** `.only`，静默 `catch {}` 只有 1 处且位于测试字符串中；`observation-evidence.ts` / `release-verify.ts` 的摘要重算与"绝不做假 PASS"设计质量很高，未发现伪造证据路径。

## 1. 发现总表

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-001 | apps/cli/src/release-artifacts.ts:190 | `capability_audit` 门禁命令声明为 `["pnpm","capability:audit"]`，而执行器用 `execFile(shell:false)`；Windows 上 `pnpm` 只有 `pnpm.cmd` 垫片，必然 `ENOENT` → 第 9 步永远 `produced:false`，`collectReleaseArtifacts().ok` 在 Windows 恒为 false | D | P1 | 该门禁改用 `["node","apps/cli/dist/main.js",...]` 或 `process.execPath`；若必须调包管理器，在执行器里对 win32 解析 `.cmd` 垫片（`where pnpm` 后走 `cmd.exe /c`）并单测覆盖 |
| CLI-002 | apps/cli/src/commands.ts:402 | `champion eval` 用 `rest.slice(1).filter(a => !a.startsWith("--"))` 取位置参数，**不跳过 flag 的值**：`champion eval --mode real-model a.json b.json` 会得到 `baselinePath="real-model"`、`candidatePath="a.json"`（静默读错文件）；另 `--mode` 非法值被 `? "real-model" : "stub"` 静默降级为 stub | D | P1 | 改成与 `benchmark` 一致的显式循环（`i++` 跳过值），并把 `--mode` 的值域校验为 `stub\|real-model`，非法值 `exitCode:1` + usage |
| CLI-003 | apps/cli/src/release-command.ts:322 | `execFileSync(cmd.join(" "), { shell: true })`：把参数拼成字符串交给 shell，含空格/引号/`&` 的参数会被重新解释（路径含空格或注入面），且与 `packages/evaluation/src/gate-evidence-v2.ts:590` 刻意采用的 `execFile(argv, shell:false)` 策略直接矛盾 | D | P2 | 统一走 argv + `shell:false`；Windows 垫片问题按 CLI-001 的方案在**执行器层**解决，而不是把命令拼成字符串 |
| CLI-012 | apps/cli/src/prereg-fixture-checkout-grant.test.ts:333、-trust.test.ts:311 | Windows 无法创建符号链接（EPERM）时用 `ctx.skip()` 跳过整例，容错路径被当作正常路径，Windows 上这两个安全用例**从不真正执行**且报告为 skipped 而非失败 | B | P3 | 暂时不动：CI 需保留"能建链的宿主"上的真实覆盖，本地环境无法建链属于真实限制。改进方向：skip 时写入一条可见的降级标记（例如把 skip 原因计入 observation 证据），避免"绿着但没跑" |
| CLI-004 | apps/cli/src/audit.ts:1333、benchmark-command.ts:1122、e4-09-diagnostics.ts:170、observation-evidence.ts:429、prereg-arm-executor.ts:369(+428 的 `git(dir,…)` 助手)、prereg-production-runner.ts:146、release-command.ts:41 | `git rev-parse HEAD` 获取 HEAD 的生产代码实现**共 7 处**（另 `scripts/paired-to-v3.mjs:69` 第 8 处），超时/编码/失败语义各不相同（有的 5s timeout、有的无超时、有的返回 null、有的抛） | A | P2 | 收进一个 `git-head.ts`：`readHead(cwd, {timeoutMs}) => {sha\|null, error}`，7 处调用点替换；测试内的重复用于独立验证，保留 |
| CLI-005 | apps/cli/src/commands.ts:403-408、release-command.ts:227/376、release-verify.ts:203-…、prereg-command.ts:223、benchmark-command.ts:3433、audit.ts:1381 | 参数解析存在两套风格：`rest.indexOf("--x")` + `filter` 共 **12 处**、显式 `for (let i…)` 循环 **6 处**；两者都**不支持 `--flag=value`**；`--evidence-dir` / `--out` 等出现在参数末尾且缺值时静默取默认值（不报错） | A | P2 | 抽一个 `parseFlags(argv, spec)`（`{name, type:"string"\|"boolean", required?}`）：统一 `--flag value` 与 `--flag=value`、缺值即 usage+exit 1、未知 flag 报错。12 处 `indexOf` 风格优先迁移 |
| CLI-006 | apps/cli/src/benchmark-command.ts:1-4001、prereg-arm-executor.ts:1-2125、prereg-execution-identity.ts:1-1524、audit.ts:1-1362、e4-r55-child-harness.ts:1-1131 | 5 个文件超过 1000 行（最大 4001 行），且没有按职责拆分的边界：`benchmark-command.ts` 同时含 CLI 解析、套件目录、执行编排、评分、产物落盘、`--out` 渲染 | A | P2 | `benchmark-command.ts` 至少切成 `benchmark/argv.ts`、`benchmark/execute.ts`、`benchmark/score.ts`、`benchmark/artifacts.ts`（现有 `runBenchmarkCommand` 与 `executeBenchmark` 的边界就是天然切口）；其余 4 个按"身份/执行/诊断"拆 |
| CLI-007 | apps/cli/src/doctor.ts:40、141、145 | `const EXPECTED_BUILTIN_TOOLS = 11` 硬编码个数，而 `main.ts:45` 是 `BUILTIN_TOOLS = PRODUCTION_TOOL_NAMES`（来自 `@ar/tools`）。只要"换一个工具但总数不变"，`doctor` 依然报 OK；工具集增删还必须手工同步常量 | A | P2 | 改为引用 `PRODUCTION_TOOL_NAMES` 做**集合比较**（缺哪个、多哪个都报），计数只用于展示 |
| CLI-008 | apps/cli/src/main.ts:154-160 | `extractDataDirFlag` 解析失败时 `writeLines([msg], 1)` 写的是 **stdout**，而顶层 `main().catch` 写 **stderr**；脚本化调用（`agent --data-dir` 拼错）无法用 `2>` 捕获错误 | A | P2 | 错误统一写 stderr；建议 `CommandResult` 增加 `errLines`，`main` 统一分流 |
| CLI-010 | apps/cli/src 全域（108 处） | `as any` / `as never` / `@ts-expect-error` 共 108 处（其中 `commands.ts:352` `rollbackChampionState(current, { targetLevel: target as never, … })`、`e2-command` 附近的多处 `as never` 掩盖了真实的联合类型收窄） | D | P2 | 优先收敛 `as never`（它比 `as any` 更危险：等于告诉编译器"任何类型都行"）；对 `targetLevel` 这类先做 `readonly CHAMPION_LEVELS` 的 `includes` 收窄 |
| CLI-015 | apps/cli/src/prereg-arm-executor.ts:1399、1502、1895、1918-1966、2006-2026、2084 | 手写 `Promise.race([work, sleep(ms)])` + `child.kill()` + `clearTimeout` 组合共 5 组（工作进程超时、清理宽限、退出宽限、信号中继），每组的超时常量与清理顺序都不同，`2084` 的错误文案需要人工与 `opts.timeoutMs` 对齐 | A | P2 | 抽 `raceWithDeadline(work, {ms, onTimeout})` 与 `killAndWait(child, {graceMs})` 两个助手，5 处替换；超时常量集中为一张表 |
| CLI-011 | apps/cli/src/n1-worker-lifecycle.test.ts:199、e4-r55-failure-wiring.test.ts:929、r0-f8-formal-budget-cancel-gaps.test.ts:562、cli.test.ts:587 | 固定睡眠 4 处（最长 `await sleep(3000)`），另有 78 个测试文件各自 `mkdtemp` 手搓夹具，其中 `n2-release-cli-forward.test.ts` 建了临时目录却无 `rm` 清理（另 1 个同型）；`e4-r46-diagnostics-noclobber.test.ts:53/127` 用 `rm(...).catch(()=>{})` 吞掉清理失败 | D | P2 | 固定睡眠换成"轮询直到条件成立 + 上限"（`waitFor(fn,{timeoutMs})`）；`mkdtemp` 收进一个 `makeTmpDir(t)` 助手，统一在 `afterAll` 清理；`catch(()=>{})` 至少 `process.stderr.write` 一行 |
| CLI-013 | apps/cli/scripts/paired-to-v3.mjs:69-72 | 用 `execSync("git rev-parse HEAD")` / `execSync("git status --porcelain")` 字符串形式（走 shell），与仓库内其余处一律 argv + 无 shell 的做法不一致；`catch { /* not a git repo */ }` 静默把 `dirty` 置 true | A | P3 | 改 `execFileSync("git",["rev-parse","HEAD"])`；catch 里补一行 stderr 说明降级原因（`dirty=true` 是安全方向，保留） |
| CLI-014 | apps/cli/src/e4-09-diagnostics.ts:170、n2-forward-fixture.ts:76 | 诊断/夹具路径用 `execFileSync` 同步调 git 且无超时（`e4-09-diagnostics.ts:170` 只给 cwd/encoding），在慢盘或 git hooks 挂住时会阻塞整个进程 | A | P3 | 统一走 CLI-004 的 `readHead(cwd,{timeoutMs:5000})` |
| CLI-016 | apps/cli/src/chat-command.ts:54 | `history.filter(m => m.role === "user" \|\| m.role === "assistant" && m.content)`：`&&` 优先级高于 `\|\|`，当前语义（user 全收、assistant 仅非空）靠优先级碰巧正确 | A | P3 | 加括号显式化 |

### 说明 · CLI-001（Windows 上 `release artifacts` 第 9 步必失败）

证据（本机实测，pwsh 7.6.5 / Windows）：

```
PS> node -e "const {execFile}=require('node:child_process');execFile('pnpm',['--version'],{timeout:8000},(e,o)=>console.log('ERR:',e?e.code:'none'))"
ERR: ENOENT
```

链路三处代码：
- `apps/cli/src/release-artifacts.ts:188-196` 声明 `gate: "capability_audit"`, `command: ["pnpm", "capability:audit"]`, `cwd: deps.root`；
- `packages/evaluation/src/gate-evidence-v2.ts:583-590` 的 `defaultRunner` 直接 `execFile(file, args, { shell:false })`（默认不设 shell）；
- `release-artifacts.ts:198` 用 `gateEvidence.passed` 决定 `gate-evidence` artifact 的 `produced`，而 `:202` 的 `ok = artifacts.every(a => a.produced)`。

后果：`agent release artifacts` 在 Windows 上 **必然** `RELEASE ARTIFACTS INCOMPLETE`。失败会被 `classifyChildFailure` 归类为 `kind:"spawn"` 记录下来（不静默），但这让"发布产物可在本机收齐"这一验收在 Windows 上永远无法成立。仓库自己已经在 `packages/evaluation/src/campaign-triage.ts:1110-1116` 记录过同类教训（"`runArgv` spawns with shell:false; on Windows a … command shim instead of spawning the bare name"），说明这是**已知模式但未覆盖到这条门禁**。

### 说明 · CLI-002（`champion eval` 位置参数被 flag 值污染）

`apps/cli/src/commands.ts:402-413`：

```ts
const files = rest.slice(1).filter((a) => !a.startsWith("--"));
const modeIdx = rest.indexOf("--mode");
const mode: EvalMode = modeIdx >= 0 && rest[modeIdx + 1] === "real-model" ? "real-model" : "stub";
```

- `agent champion eval --mode real-model base.json cand.json` → `files = ["real-model","base.json","cand.json"]` → `baselinePath="real-model"`、`candidatePath="base.json"`，`files[2]` 被丢弃。用户不会收到任何参数错误，只会收到一个基于错误输入的比较结论（`runChampionEval` 内部若读不到文件才报错，此时报错信息指向一个不存在的文件 "real-model"）。
- `agent champion eval --strict base.json`（漏一个文件）→ `files=["base.json"]` → 走 usage 分支，行为正确。
- `--mode bogus` → 静默按 `stub` 跑。stub 与 real-model 的证据等级不同，静默降级会让"用真实模型做对比"的意图悄悄失效；`--candidate` 同理（`rest[candIdx+1]` 缺值时 `candidateId` 变成下一个位置参数）。
- 对照：`benchmark` 的解析（同文件 `parseBenchmarkArgs`）用显式 `i++`，是正确的写法——同一包内两套解析，只有一套正确。

### 说明 · CLI-003（`shell:true` + `cmd.join(" ")`）

`apps/cli/src/release-command.ts:320-326` 执行门禁（如 `pnpm test`）时把 argv 拼成单个字符串并 `shell: true`。风险有二：
1. 路径/参数含空格或 `&`、`|`、`^` 时被 shell 重新解释——本仓库工作目录是 `D:\Download games\harness agent`（**含空格**），这是现实存在的触发条件而非假想；
2. 与 `gate-evidence-v2.ts:590`（argv + `shell:false`）和 `campaign-triage.ts:1110` 的结论相矛盾：仓库一处修好了垫片问题，另一处仍靠 shell。

注意：这正是 CLI-001 的**另一面**——`shell:true` 恰好让 `pnpm` 能跑通，所以"改 CLI-003 不能顺手把 `shell:true` 删掉"，否则会把 `release gate` 也变成 ENOENT。两处必须一起改。

### 说明 · CLI-005（参数解析两套风格 + 缺值静默）

- 计数（`Select-String` 于 `apps/cli/src/*.ts`，排除 `*.test.ts`）：`rest.indexOf("--…")` 风格 **12** 处；`for (let i = 0; i < (rest|argv).length` 风格 **6** 处；`--flag=value` 支持 **0** 处。
- 缺值清单：`release-command.ts:227`（`rest[pathIdx+1]` 为 `undefined` → 回落到默认 evidence 目录）、`release-command.ts:376`、`commands.ts:407-408`（`--candidate` 缺值即取下一个位置参数）、`prereg-command.ts:223`、`audit.ts:1381`、`benchmark-command.ts:3433`。
- 后果：一个拼错的命令行（`--out` 写末尾）不会报错，而是静默落到默认目录——产物写到了用户没指定的位置，且后续校验基于该默认路径继续通过。

### 说明 · CLI-006（超大文件）

| 文件 | 行数 | 天然切口 |
| --- | --- | --- |
| `benchmark-command.ts` | 4001 | `runBenchmarkCommand`(L222) / `executeBenchmark`(L388) / `decideBench…`(L652) 已是三个职责边界 |
| `prereg-arm-executor.ts` | 2125 | "启动 worker"、"超时与清理"、"结果归纳"三段 |
| `prereg-execution-identity.ts` | 1524 | "身份构造"与"身份校验"可分离 |
| `audit.ts` | 1362 | 能力矩阵与能力探测可分离 |
| `e4-r55-child-harness.ts` | 1131 | 子进程宿主与协议编解码可分离 |

拆分只按现有函数边界移动，不改行为——与 AGENTS.md 的 Runtime Freeze 不冲突（`apps/cli` 是 CLI 层，且这是纯移动）。

### 说明 · CLI-011（测试脆弱性）

- 固定睡眠实测：`n1-worker-lifecycle.test.ts:199` `await sleep(3000)`、`:218/:246` `sleep(10)`、`:678` `setTimeout(resolve,120)`；`e4-r55-failure-wiring.test.ts:929` `setTimeout(r,100)`；`r0-f8-formal-budget-cancel-gaps.test.ts:562` `setTimeout(r,50)`；`cli.test.ts:587` `setTimeout(r,10)`。
- `mkdtemp` 使用文件 **78/98**；其中无任何 `rm`/`afterEach`/`afterAll` 的 2 个（`n2-release-cli-forward.test.ts` 为一例）。其余 76 个各自写了清理，但**没有共享助手**——同一段"建临时目录 + 清理"逻辑复制了 76 份。
- `apps/cli` 无自有 `vitest.config.ts`（走仓库根配置），98 个测试文件共 **32298 行**。

## 2. 分模块明细

### 2.1 入口与命令注册（`main.ts` / `index.ts` / `commands.ts` / `*-command.ts`）

命令分发集中在 `commands.ts` 的单个 `switch`，各子命令通过动态 `import()` 懒加载，退出码统一由 `{ exitCode, lines }` 表达——这个约定执行得很彻底（`apps/cli/src` 内 `process.exit(` 命中 **0** 次）。问题集中在**参数解析不统一**与**错误流向不一致**。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-002 | apps/cli/src/commands.ts:402 | `champion eval` 位置参数被 flag 值污染；`--mode` 非法值静默降级 | D | P1 | 见 §1 |
| CLI-005 | apps/cli/src/commands.ts:403-408 等 12 处 | 两套解析风格、无 `--flag=value`、缺值静默 | A | P2 | 见 §1 |
| CLI-008 | apps/cli/src/main.ts:154-160 | `--data-dir` 解析错误写 stdout | A | P2 | 见 §1 |

### 2.2 基准/评测驱动（`benchmark-command.ts` / `champion-eval.ts` / `prereg-*`）

事件流包装器与水门（watermark）设计完整：`promotion-decision.ts` 只在证据齐全时给 ACCEPT，`champion-eval.ts` 的 exit code 0/1/2/3 与 `ACCEPT/INCONCLUSIVE/REJECT/INVALID` 一一对应。**未发现**"失败被当成通过"的路径。问题在体量与超时编排。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-006 | apps/cli/src/benchmark-command.ts:1-4001 等 5 文件 | 超大文件 | A | P2 | 见 §1 |
| CLI-015 | apps/cli/src/prereg-arm-executor.ts:1399/1502/1918-1966/2006-2026 | 5 组手写 `Promise.race`+`kill`+`clearTimeout` 超时编排 | A | P2 | 抽 `raceWithDeadline` / `killAndWait` |
| CLI-004 | apps/cli/src/benchmark-command.ts:1122 等 | HEAD 探测重复实现 | A | P2 | 见 §1 |

### 2.3 发布与门禁（`release-command.ts` / `release-verify.ts` / `release-artifacts.ts`）

`release-verify.ts` 的摘要校验（`evidenceDigest` 重算、相对路径 + digest、拒绝手写 PASS）质量高。两个 P1/P2 都落在**子进程调用方式**上，且互为因果。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-001 | apps/cli/src/release-artifacts.ts:190 | Windows 上 `capability_audit` 门禁必 ENOENT | D | P1 | 见 §1 |
| CLI-003 | apps/cli/src/release-command.ts:322 | `shell:true` + 字符串拼接命令 | D | P2 | 见 §1 |

### 2.4 运行时与宿主（`provider.ts` / `chat-command.ts` / `terminal-*-host.ts` / `data-dir-lease.ts` / `doctor.ts`）

`data-dir-lease.ts`（95 行）用固定端口做单写者租约，注释里明确"不允许随机端口回退"、Windows 大小写折叠，逻辑自洽；`chat-command.ts` 的 resume/冻结配置检查完整。问题只有可读性与常量同源。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-007 | apps/cli/src/doctor.ts:40 | 工具集用硬编码计数 `11` 校验 | A | P2 | 见 §1 |
| CLI-016 | apps/cli/src/chat-command.ts:54 | `history.filter(m => m.role === "user" \|\| m.role === "assistant" && m.content)`：`&&` 优先级高于 `\|\|`，实际语义是"user 全收 + assistant 仅非空"，靠优先级碰巧正确 | A | P3 | 加括号显式化；或 `m.role === "user" \|\| (m.role === "assistant" && m.content)` |

### 2.5 审查/审计与诊断（`audit.ts` / `usage-audit.ts` / `production-audit.ts` / `e4-09-*` / `e4-r55-*`）

只读审计路径未见网络或写盘副作用；`e4-09-diagnostics.ts:170` 之外的 git 调用均带 cwd。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-014 | apps/cli/src/e4-09-diagnostics.ts:170 | `execFileSync` 调 git 无超时 | A | P3 | 见 §1 |
| CLI-006 | apps/cli/src/audit.ts:1-1362、e4-r55-child-harness.ts:1-1131 | 超大文件 | A | P2 | 见 §1 |

### 2.6 测试与夹具（98 个 `*.test.ts` + `test-infra/`）

夹具纪律总体很好：`test-infra/observation-fixtures/` 与 `diagnostic-fixtures/` 在 `.gitignore:38/45` 被显式忽略，`e4-r24-final-result-protocol.test.ts:176/321-322/386-391` 与 `e4-r46-diagnostics-noclobber.test.ts:127` 都做了显式 `rm`（我原本怀疑"生成后不清理"，核查后**不成立**，记录在此以免他人重复怀疑）。真正的问题是固定睡眠与 78 份复制的 `mkdtemp` 样板。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-011 | n1-worker-lifecycle.test.ts:199 等 | 固定睡眠 + 78 份 mkdtemp 样板 + 2 处无清理 | D | P2 | 见 §1 |
| CLI-012 | prereg-fixture-checkout-grant.test.ts:333、-trust.test.ts:311 | Windows 符号链接 EPERM 走 `ctx.skip` | B | P3 | 见 §1 |

### 2.7 脚本与工具（`scripts/*.mjs`）

`paired-to-v3.mjs` 头部明确标注"非生产迁移工具、`promotionEligible:false`、绝不猜测字段"，并在缺 `planDigest`/`candidate` 时硬失败——这是好的做法。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| CLI-013 | apps/cli/scripts/paired-to-v3.mjs:69-72 | `execSync` 字符串调 git | A | P3 | 见 §1 |

## 3. 覆盖清单

git ls-files apps/cli = **153** 个文件。逐文件结论如下（无问题 / 见 ID / 未逐行（原因））。

### 3.1 `apps/cli/src` — 生产代码（40 个）

| 文件 | 行数 | 结论 |
| --- | --- | --- |
| `src/audit.ts` | 1362 | 未逐行（1362 行）：结构扫描；见 CLI-004 / CLI-005 / CLI-006 |
| `src/benchmark-command.ts` | 4001 | 未逐行（4001 行）：精读 argv 解析 / executeBenchmark / 评分 / 产物落盘 / rev-parse 5 个区域，其余为结构索引；见 CLI-004 / CLI-006 |
| `src/champion-application.ts` | 473 | 结构扫描（473 行）；无问题 |
| `src/champion-eval.ts` | 405 | 精读（405 行）：argv/决策码/水门；无问题 |
| `src/champion-state-file.ts` | 146 | 结构扫描（146 行）；无问题 |
| `src/chat-command.ts` | 103 | 全文；见 CLI-016 |
| `src/coding-benchmark.ts` | 65 | 结构扫描（65 行）；无问题 |
| `src/commands.ts` | 829 | 全文；见 CLI-002 / CLI-005 / CLI-010 |
| `src/config-command.ts` | 89 | 结构扫描（89 行）；无问题 |
| `src/data-dir-lease.ts` | 95 | 全文；无问题（固定端口租约、Windows 大小写折叠、拒绝随机回退） |
| `src/docs-verify.ts` | 418 | 结构扫描（418 行）；无问题 |
| `src/doctor.ts` | 223 | 全文；见 CLI-007 |
| `src/e2-command.ts` | 99 | 结构扫描（99 行）；无问题 |
| `src/e4-09-diagnostics.ts` | 691 | 未逐行（691 行）：结构扫描；见 CLI-004 / CLI-014 |
| `src/e4-09-real-chain.ts` | 388 | 结构扫描（388 行）；无问题 |
| `src/e4-r55-child-harness.ts` | 1131 | 未逐行（1131 行）：结构扫描；见 CLI-006 |
| `src/experiment-command.ts` | 23 | 结构扫描（23 行）；无问题 |
| `src/explain-command.ts` | 100 | 结构扫描（100 行）；无问题 |
| `src/fake-mcp.ts` | 63 | 结构扫描（63 行）；无问题 |
| `src/index.ts` | 34 | 全文；无问题（包 API 出口，40 行 re-export） |
| `src/learn-command.ts` | 227 | 结构扫描（227 行）；无问题 |
| `src/main.ts` | 467 | 全文；见 CLI-008 |
| `src/mechanisms.ts` | 198 | 结构扫描（198 行）；无问题 |
| `src/n2-forward-fixture.ts` | 303 | 结构扫描；见 CLI-014 |
| `src/observation-evidence.ts` | 406 | 全文；见 CLI-004 |
| `src/prereg-arm-executor.ts` | 2125 | 未逐行（2125 行）：精读超时-清理矩阵与 worker 生命周期；见 CLI-004 / CLI-006 / CLI-015 |
| `src/prereg-command.ts` | 612 | 未逐行（612 行）：结构扫描；见 CLI-005 |
| `src/prereg-execution-identity.ts` | 1524 | 未逐行（1524 行）：结构扫描；见 CLI-006 |
| `src/prereg-production-runner.ts` | 440 | 未逐行（440 行）：结构扫描；见 CLI-004 |
| `src/production-audit.ts` | 260 | 结构扫描（260 行）；无问题 |
| `src/promotion-decision.ts` | 101 | 结构扫描（101 行）；无问题 |
| `src/provider.ts` | 698 | 全文；无问题（provider 解析与回退顺序清晰） |
| `src/r97-arm-abi.ts` | 32 | 结构扫描（32 行）；无问题 |
| `src/recover-command.ts` | 93 | 结构扫描（93 行）；无问题 |
| `src/release-artifacts.ts` | 198 | 全文；见 CLI-001 |
| `src/release-command.ts` | 399 | 全文；见 CLI-003 / CLI-004 |
| `src/release-verify.ts` | 522 | 全文；无问题（digest 重算 + 相对路径 + 拒绝手写 PASS） |
| `src/terminal-chat-host.ts` | 75 | 结构扫描（75 行）；无问题 |
| `src/terminal-run-host.ts` | 54 | 结构扫描（54 行）；无问题 |
| `src/usage-audit.ts` | 183 | 结构扫描（183 行）；无问题 |

### 3.2 `apps/cli/src` — 测试（98 个 *.test.ts，合计 32298 行）

聚合规则（METHOD §4.3 允许）：98 个文件**全部**用统一 5 类模式扫描 —— (a) .skip( / .only( / .todo(，(b) 固定 setTimeout(resolve|r, <数字>) 与 wait sleep(<数字>)，(c) mkdtemp 与 
m/fterEach/fterAll 的配对，(d) xecSync/xecFileSync，(e) 吞异常的 catch {}。命中者逐条给出 ID；未命中者结论为

**有发现（10 个）：**

| 文件 | 结论 |
| --- | --- |
| `src/benchmark-command.test.ts` | 未逐行（2832 行）：结构扫描 + 5 类模式扫描；无问题 |
| `src/cli.test.ts` | 见 CLI-011（固定 sleep 10） |
| `src/e4-r24-final-result-protocol.test.ts` | 精读：夹具生成/清理完整（rm 全覆盖）；无问题 |
| `src/e4-r46-diagnostics-noclobber.test.ts` | 见 CLI-011（清理失败被 .catch(()=>{}) 吞掉）；夹具本身有 .gitignore 保护，正确 |
| `src/e4-r55-failure-wiring.test.ts` | 见 CLI-011（固定 sleep 100） |
| `src/n1-worker-lifecycle.test.ts` | 见 CLI-011（固定 sleep 3000/120） |
| `src/n2-release-cli-forward.test.ts` | 见 CLI-011（mkdtemp 后无 rm 清理） |
| `src/prereg-fixture-checkout-grant.test.ts` | 见 CLI-012（Windows 无符号链接权限时整例 skip） |
| `src/prereg-fixture-checkout-trust.test.ts` | 见 CLI-012（同上） |
| `src/r0-f8-formal-budget-cancel-gaps.test.ts` | 见 CLI-011（固定 sleep 50） |

**模式扫描未见问题（88 个）：**

- `src/app-server-layering.test.ts`
- `src/audit.benchmark-profile.test.ts`
- `src/audit.default-profile.test.ts`
- `src/audit.evidence-probe.test.ts`
- `src/audit.persistent-profile.test.ts`
- `src/audit.profiles.test.ts`
- `src/audit.strict.test.ts`
- `src/benchmark-provider-policy.test.ts`
- `src/champion-application-p1.test.ts`
- `src/champion-application-r05.test.ts`
- `src/champion-application-r16.test.ts`
- `src/champion-application.integration.test.ts`
- `src/champion-eval.test.ts`
- `src/champion-state-file.test.ts`
- `src/coding-benchmark.test.ts`
- `src/coding-host.regressions.test.ts`
- `src/coding-prompt.integration.test.ts`
- `src/config-command.test.ts`
- `src/context-safe-tool-call-efficiency-v2.integration.test.ts`
- `src/context-safe-tool-call-efficiency.integration.test.ts`
- `src/data-dir-lease.test.ts`
- `src/default-harness.integration.test.ts`
- `src/diagnostic-first-repair.test.ts`
- `src/docs-verify.test.ts`
- `src/dual-platform-acceptance.test.ts`
- `src/e3-07-promotion-trust.test.ts`
- `src/e3-13-production-path.test.ts`
- `src/e3-repro-current-defects.test.ts`
- `src/e4-09-production-e2e.test.ts`
- `src/e4-r21-release-reverify.test.ts`
- `src/e4-r40-forensics.test.ts`
- `src/e4-r42-gate-isolation.test.ts`
- `src/e4-r45-diagnostics-order.test.ts`
- `src/e4-r47-bounded-copy.test.ts`
- `src/e4-r51-read-settle.test.ts`
- `src/e4-r52-raw-bytes.test.ts`
- `src/e4-r58-mutation-newlines.test.ts`
- `src/e4-r84-campaign-cli.test.ts`
- `src/e4-r85-triage-cli.test.ts`
- `src/experiment-command.test.ts`
- `src/explain-command.test.ts`
- `src/final-question.regressions.test.ts`
- `src/gen1-chat.test.ts`
- `src/gen1-skills-wiring.regressions.test.ts`
- `src/learn-command.test.ts`
- `src/mechanisms.test.ts`
- `src/n2-pricing-guard-armed.test.ts`
- `src/n2-script-scope.test.ts`
- `src/n2-unified-selection.test.ts`
- `src/n3-dispatch-journal.test.ts`
- `src/n5-offline-provider.test.ts`
- `src/n5-pair-setup.test.ts`
- `src/n6-n5-judge.regressions.test.ts`
- `src/n6-real-formal-ci.test.ts`
- `src/n7-execution-chain.regressions.test.ts`
- `src/observer-coverage.regressions.test.ts`
- `src/path-scoped-instructions.test.ts`
- `src/prereg-arm-executor.test.ts`
- `src/prereg-command.test.ts`
- `src/prereg-declared-posture-forward-path.test.ts`
- `src/prereg-declared-pricing.test.ts`
- `src/prereg-docs-smoke.test.ts`
- `src/prereg-egress-trust-boundary.test.ts`
- `src/prereg-formal-gaps.test.ts`
- `src/prereg-n0-gaps.test.ts`
- `src/prereg-next-gaps.test.ts`
- `src/prereg-production-wiring.test.ts`
- `src/prereg-trusted-build.test.ts`
- `src/production-audit.test.ts`
- `src/promotion-decision.test.ts`
- `src/provider-offline-profile.test.ts`
- `src/r0-f5-pricing-declaration-gaps.test.ts`
- `src/r0-f6-ci-readiness-classification.test.ts`
- `src/r5-formal-gate.test.ts`
- `src/r97-ci-diagnostics.test.ts`
- `src/recover-command.test.ts`
- `src/release-artifacts.test.ts`
- `src/release-command.test.ts`
- `src/release-verify.test.ts`
- `src/schema-advert-policy.test.ts`
- `src/source-audit-archive.regressions.test.ts`
- `src/source-audit-cleanup.regressions.test.ts`
- `src/source-audit-safety.regressions.test.ts`
- `src/source-audit-verification.regressions.test.ts`
- `src/task-scoped-skills.test.ts`
- `src/usage-audit.test.ts`
- `src/verified-completion-gate.integration.test.ts`
- `src/windows-reserved-lease.regressions.test.ts`

### 3.3 `apps/cli/test-infra`（8 个）

| 文件 | 结论 |
| --- | --- |
| `test-infra/diagnostic-fixtures/.gitkeep` | 占位；夹具为运行期生成且已被 .gitignore:45 忽略；无问题 |
| `test-infra/diagnostic-vitest.config.ts` | 结构（28 行）；无问题（由 e4-r46 以子进程 config 使用） |
| `test-infra/e4-r55-fixtures/failure-wiring.child.test.ts` | 结构扫描未见问题 |
| `test-infra/n0-gaps-vitest.config.ts` | 结构（35 行）；无问题 |
| `test-infra/observation-fixtures/.gitkeep` | 占位；夹具为运行期生成且已被 .gitignore:38 忽略；无问题 |
| `test-infra/observation-vitest-reporter.ts` | 全文；无问题（只在 E2E_OBSERVATION_RUN_ID 存在时提交，异常降级写 stderr） |
| `test-infra/observation-vitest.config.ts` | 结构（32 行）；无问题（由 e4-r24 测试以子进程 config 使用） |
| `test-infra/r0-gaps-vitest.config.ts` | 结构（41 行）；无问题 |
| `test-infra/r55-vitest.config.ts` | 结构（45 行）；无问题 |
| `test-infra/red-next-gaps-vitest.config.ts` | 结构（31 行）；无问题 |

### 3.4 `apps/cli` 根与 scripts/（7 个）

| 文件 | 结论 |
| --- | --- |
| `package.json` | 全文；无问题（bin→dist/main.js；exports 的 development 条件指向 src） |
| `scripts/emit-decision-artifact.mjs` | 结构（1.8KB，无子进程/无网络）；无问题 |
| `scripts/paired-to-v3.mjs` | 全文；见 CLI-013 |
| `scripts/validate-v3.mjs` | 结构（0.8KB，纯校验）；无问题 |
| `tsconfig.json` | 全文；无问题 |



## 4. 存疑/需人工确认

1. **CLI-001 的实际触发面**：我验证了"`execFile("pnpm", …)` 在本机 ENOENT"，但没能确认 Windows CI job 是否真的执行 `agent release artifacts`（`.github/workflows/ci.yml` 里 release 相关步骤我看的是片段）。若 CI 从不在 Windows 跑该命令，严重程度可从 P1 降为 P2（仍是跨平台破坏，因为用户会在 Windows 本地跑）。需要的证据：`ci.yml` 中 `release artifacts` 的 job 与 runner 标签。
2. **CLI-003 的改法依赖 CLI-001**：把 `shell:true` 去掉会让 `pnpm` 在 Windows 上 ENOENT（`release gate` 目前靠 shell 才能跑）。两者必须同一次改动里完成，否则会以修复一个 P2 的方式造出一个新 P1。这条我在 §1 已写，但仍需 Lead 确认是否纳入本轮批次。
3. **C 类（死代码）未做完**：我尝试对 `apps/cli/src` 的 40 个文件的导出符号做全仓引用计数（两种实现都因 O(符号数 × 语料) 在 120s 内未完成而终止）。已定点核查 9 个最可疑模块（`mechanisms` / `r97-arm-abi` / `experiment-command` / `config-command` / `promotion-decision` / `coding-benchmark` / `fake-mcp` / `terminal-run-host` / `terminal-chat-host`），**全部有引用**，故本 part 不报 C 类。彻底结论需要一次 `ts-prune`/`knip` 之类的全仓扫描（当前仓库无此类配置，见 METHOD §0）。
4. **`apps/cli/src/index.ts` 的对外消费面**：它是 `package.json` 的 `exports` 入口（development 条件指向 src）。我没有枚举仓库外消费者，无法判断其中多少导出是"包 API 必须"、多少是"顺手 re-export"。若 Lead 需要 C 类结论，这是下一个该查的点。
5. **`provider.ts`（698 行）我读了全文但只归类为"无问题"**：它的回退链（模型别名 → provider → 默认）依赖 `@ar/providers` 的行为，跨包语义我没有验证。若 Lead 要求"跨包一致性"层面的结论，需要 `providers` 包审查员交叉确认。
6. **性能类结论缺失**：我没有做任何基准测量（任务约束要求不跑耗时测试），因此本 part 没有性能类 P1/P2。`benchmark-command.ts` 的 O(n²) 风格嫌疑段我没有量化，未列入发现（避免"我觉得"）。
