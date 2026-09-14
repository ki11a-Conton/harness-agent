# E4-R64 报告：处理 Windows 进程树终止命令的失败路径

## 1. 问题（H64，P2；依赖 R63）

`apps/cli/src/e4-r55-child-harness.ts` 的 `killTree` 在 Windows 上有两条未处理的路径：

1. **异步启动失败被吞。** `spawn("taskkill", …)` 的启动失败是通过 **`error` 事件**报告的，
   外层 `try/catch` **结构上无法覆盖**它。原实现只写一行 stderr 日志
   （`killer.on("error", (err) => reportDegraded("e4-r60 taskkill spawn", err))`），
   注释却写着"the direct kill below is the fallback either way" —— **那条回退根本不存在**。
2. **非零退出未检查。** `taskkill` 启动了但退出码非 0（例如权限不足、PID 已消失）时，
   原实现完全不看退出码，于是"树终止失败"与"树终止成功"对外无法区分。

第 3 个后果：终止命令的错误**只存在于 stderr**，`run.json` 里没有任何痕迹，归档使用者无法判断
进程树是否真的被终止。

## 2. 修复前复现（函数层故障注入，实测）

用注入的 seam 复现（不删除系统 `taskkill`、不改 PATH）：注入的 killer 在 `error` 事件上报告失败后，

```
pre-R64 结果：commandLaunched=false  commandError="spawn taskkill ENOENT"
              directFallbackAttempted=false   directChildSignalled=false   directKillCalls=0
```

即：**承诺的回退调用次数为 0**。非零退出同理（`close` 带 code 1 时没有任何回退）。

**证据层级声明**：这是**函数层故障注入**（`killTree` 直接调用 + 注入 spawner），
**不是**在本机真实执行 Windows `taskkill` 失败。真实路径由 §5 的 K 用例（真实子进程 + 真实
`taskkill`）覆盖。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | 修改：`killTree` 改为返回结构化 `TreeKillResult`；新增 `KillTreeDeps` / `KillerSpawner` 注入 seam；`ControlledChildOutcome` 新增 `treeKill`；`ControlledChildSpec` 新增可选 `killDeps`；grace 到期新增 `releaseUnreapedChild`；`run.json` 新增 `treeKill` 段 |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：`syntheticOutcome` 同步 `treeKill`；新增 R64 套件（11 例） |

### 3.1 终止结果字段（每条都是独立事实）

| 字段 | 含义 |
| --- | --- |
| `requested` | 是否**请求**过树终止（child 没有 pid 时为 false） |
| `mechanism` | `taskkill` / `process-group` / `none` |
| `command` | 树终止命令行（POSIX 进程组信号时为 null） |
| `commandLaunched` | 终止**命令**是否真的启动；null = 不适用/未知 |
| `commandExitCode` | 终止命令的退出码；null = 从未启动或尚未观察到 |
| `commandError` | 启动失败或非零退出的原因，**绝不静默** |
| `directFallbackAttempted` | 是否尝试过直接 kill 回退 |
| `directChildSignalled` | 是否**要求直接子进程**去死 |
| `settled` | 回退已执行过，第二次失败不会重复终止 |

**命名即约束**：字段叫 `directChildSignalled` 而不是 `treeKilled`——直接 kill 只证明
**直接子进程**可能被终止，**不能**当作整棵进程树已终止的证据（后代可以比父进程活得久）。
测试 H 断言对象上**不存在** `treeKilled` / `descendantsGone` 这类可被过度解读的字段。

### 3.2 其它要点

1. **回退恰好一次**：`fallback()` 由 `settled` 守卫，`error` 之后再收到非零 `close` 不会二次终止；
   `commandError` 保留**第一个**原因。
2. **不误杀无关 PID**：只用 `child.pid`（Windows）或 `-pid`（POSIX 进程组），不扫描、不按名字杀。
3. **复用既有机制**：仍然是 `taskkill /pid <pid> /t /f`（与生产 `ProcessExecutor` 同配方）
   与 POSIX 负 pid 信号，**没有**新建通用进程管理平台（计划 §4.6）。
4. **grace 到期不再无界挂住**（计划 §4.5）：`releaseUnreapedChild()` 在 grace 超时时
   `destroy()` 两条管道并 `unref()` 子进程句柄，同时**如实**返回 `reaped: false`。
   它**不**声称子进程已死。
5. **错误进入归档**（计划 §4.7）：`treeKill` 写入 `run.json`。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 类型检查通过 |
| `vitest run … -t "R64"` | **0** | **11 passed**（22 skipped） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整，干净树） | **0** | **33 passed (33)** |

逐条对应计划 §4「怎么验收」：

| 验收项 | 用例与断言 | 结果 |
| --- | --- | --- |
| taskkill **异步启动失败**：直接回退执行，错误保存 | A：`commandLaunched === false`、`commandError` 含 `ENOENT`、`directFallbackAttempted === true`、`directChildSignalled === true`、直接 kill 调用 **1** 次 | ✅ |
| taskkill **非零退出**：正确进入失败/回退路径 | B：`commandExitCode === 1`、`commandError` 含 `taskkill exited with 1`、回退执行、直接 kill **1** 次 | ✅ |
| taskkill **正常终止**：不额外触发错误回退 | C：`commandExitCode === 0`、`commandError === null`、`directFallbackAttempted === false`、直接 kill **0** 次 | ✅ |
| （补）**不重复终止** | D：先 `error` 再 `close(1)` → 直接 kill 仍为 **1** 次，`commandError` 保留 `boom` | ✅ |
| （补）**卡住的 taskkill** 如实标记未确认 | E：`commandLaunched === true`、`commandExitCode === null`、`commandError === null`、未回退、未 kill | ✅ |
| 无 pid 时不误动 | F：`requested === false`、`mechanism === "none"`、`command === null`、未 kill | ✅ |
| 同步 spawn 抛错立即回退并记录 | G：`commandLaunched === false`、`commandError` 含 `sync spawn failure`、回退执行 | ✅ |
| 直接 kill 不被当作整树终止的证据 | H：`directChildSignalled === true`，且对象上**无** `treeKilled` / `descendantsGone` | ✅ |
| **无法确认终止时父验证不输出"所有后代已消失"**，且父验证本身能退出 | I：注入"永不 settle 的 killer + 注入失败 + 直接 kill 无效"；断言**在 3 s 内返回**（实测 **508 ms**，子进程本身要活 4 s）、`termination === "timeout"`、`reaped === false`、`directFallbackAttempted === true`、`directChildSignalled === false`、`commandExitCode === null`、`commandError` 含注入原因 | ✅ |
| 终止命令错误**不只在 stderr** | J：`preserveEvidence` 后 `run.json.treeKill` **逐字段等于**注入的 `TreeKillResult` | ✅ |
| **Windows runner 上真实父子进程树超时测试仍通过** | K：真实 `node` 子进程（`setInterval` 永不停）+ 真实 `taskkill`：`termination === "timeout"`、`reaped === true`、`mechanism === "taskkill"`、`commandLaunched === true`、`directFallbackAttempted === false`、`commandExitCode ∈ {0, null}` | ✅ |
| POSIX 原测试不回归 | 既有 R60 超时用例（真实子进程 + 进程组信号）在本轮完整文件运行中全部通过 | ✅ |

关于 K 的 `commandExitCode ∈ {0, null}`：父进程可能在**子进程的终止事件**上先完成结算，
而 `taskkill` 自己的退出尚未被观察到。因此 null 表示"尚未观察到"，**不是**"失败"——
这是刻意保留的诚实取值，不是放宽断言（C 用确定性注入严格断言了 exit 0 的路径）。

## 5. 判别力（恢复旧实现后反例失败）

把 `error` 处理器改回"只记日志"、`close` 处理器改回"不检查退出码"：

```
× A: an ASYNC taskkill launch failure performs the promised direct fallback (pre-R64 it only logged)
× B: a NON-ZERO taskkill exit is a failure and enters the fallback path
× D: an error followed by a non-zero exit signals the direct child EXACTLY once
× H: the direct kill is named 'signalled' — never presented as proof the whole tree died
× I: a kill that never produces a terminal event resolves as UNCONFIRMED instead of hanging
     Tests  5 failed | 6 passed | 22 skipped (33)
```

C / E / F / G / J / K 在旧行为下仍通过是**预期**的（G 走的同步路径旧实现本来就处理了）。
随后已从备份恢复：`Tests 11 passed`，`tsc -b` 退出码 0。

## 6. testedSourceSha

- 基线提交（R64 开始时 HEAD）：`94ed80c`（R63 提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | `87b0eeea7ec4e10267af59dac153f3fc925f568f` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `a0deaa3e011fe93f2223ab0cc5c3e2ac0e2a8ace` |

- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。

## 7. NOT_RUN

- **未在真实 CI 的 Windows runner 上验证**：本机是 win32，K 用例已在本机真实执行
  `taskkill`，但 CI 的干净 runner 结论留给 R66。
- **未在本机真实执行"Windows `taskkill` 启动失败"**：该场景由注入 seam 覆盖（§2 已声明层级）。
- 未做付费模型调用、未发布 release、未强推。

## 8. 残余限制

1. **回退只保证"直接子进程被要求去死"**，不保证后代消失。真正的整树确认需要平台特定的
   查询（本任务不引入）；因此父验证在无法确认时**拒绝**给出"后代已消失"的结论（用例 I）。
2. **`commandExitCode` 可能是 null**：父进程按"子进程终止事件"结算，可能早于 `taskkill`
   自己的退出。这是**如实**的未确认状态，不是失败。
3. `killDeps` 是**测试 seam**，暴露在 `ControlledChildSpec` 上；生产调用方不传，使用真实平台行为。
4. **POSIX 路径未新增注入测试**：`process.kill(-pid, …)` 不可注入，且用假 pid 会真的向进程组
   发信号，风险不可接受。POSIX 由既有真实子进程用例覆盖（本轮完整文件运行全部通过）。
5. 本任务只处理终止失败路径，未处理 `copyTree` / `preserveEvidence` 的归档完整性——那是 R65 的范围。
