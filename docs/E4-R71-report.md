# E4-R71 报告：固定版本验收与终止本轮维护

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260914-132816).md` |
| reviewedSourceSha（计划 §0） | `2d6d9f8615191b601a83e7c5c9a66a4f4e2381fa` |
| 比较基线 | `fbe30fa263a6bc364fe44dc57e29e4372c1e7442` |
| **最终实现 SHA（本报告绑定）** | **`cb65b0209f815b215d70df035a0a03e3b368871a`** |
| 实现提交 | `b5ceec1` + `c714433`（R70）+ `cb65b02`（跨平台父目录探测断言） |
| 最终 CI | run `#147` / `34916638862`，attempt **2**，completed / success |
| 环境 | Windows (win32)、Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10` |

`cb65b02` 是 R70 代码后的**测试可移植性修正**：POSIX 在“文件作为父路径”时从
`lstat(child)` 直接返回 `ENOTDIR`，Windows 返回 `ENOENT` 后再由 `lstat(parent)` 发现父项不是目录。
两种结果都只能是 `unknown`，不能认证为“已清理”；测试现在按平台实际错误路径断言相同合同。

## 2. K70-A / K70-B 关闭矩阵

| ID | 修复前反例 | 修改 | 反向断言 | testedSourceSha | 结果 |
|---|---|---|---|---|---|
| **K70-A** | 共享 `RUNS_ROOT` 的全局 `readdir` + `expect([])`：foreign/active 目录会让本次运行失败；更严重的是原 `afterAll` 还调用 `rmdir(RUNS_ROOT)`，预置 `run-YtCeW3` 后实测 root 与 foreign 一起消失 | 在 `mkdtemp` 返回精确路径时登记 `ownedRunDirs`；`runChild` 返回 `runDir`；只用 `lstat` 验证本次拥有的路径；删除 `afterAll` 对共享根的 `rmdir`，foreign 只做非阻塞诊断 | 恢复“共享根必须为空” → B/C/D/H 失败；恢复全局 `rmdir` → foreign 集成夹具被删 | `apps/cli/src/e4-r55-failure-wiring.test.ts` `379362fc0952a878f3e6abe24c03aa23397aaf30` | ✅ 本地 R70 定向 **7 passed**；预置 foreign 的完整 R55 **63 passed / 2 skipped**，foreign 保留且标记文件 sha256 前后一致 |
| **K70-B** | `readdir(...).catch(() => [])` 把 EACCES/EIO 变成“空目录”，直接 PASS；ENOENT 在 Windows 还可能表示“父组件是文件”，不能无条件解释为目标不存在 | `probePathState` 返回 `absent/present/unknown`；除受父目录约束确认的 ENOENT 外，所有错误为 unknown；用 `lstat` 不跟随链接，悬空链接仍 present | 恢复吞错/把错误当 absent → F 失败；POSIX `ENOTDIR` 与 Windows `ENOENT + lstat(parent)` 都验证为 unknown | 同上 | ✅ F 覆盖 EACCES/EIO、父组件为文件、真实目录下 ENOENT；最终 CI Ubuntu/Windows 均通过 |

### 2.1 所有权与清理边界

- `ownedRunDirs` 在 `allocateOwnedRunDir()` 内、`mkdtemp` 成功后**立即**登记，因此后续初始化失败仍受本次清理验证覆盖。
- 不从 `run-*` 名字、时间戳或全局差集推断所有权。
- `verifyOwnedCleanup` 只验证本次精确路径；`listForeignEntries` 只输出诊断，**不阻塞本次清理，也不授权删除他人目录**。
- `afterAll` 不再删除共享根。R70 实测曾观察到大型套件中 `rmdir(RUNS_ROOT)` 在非空根上返回成功；最小 Node/vitest 探针则返回 `ENOTEMPTY`，机制未定因。因此修复不依赖该环境差异：共享根根本不再作为删除目标。
- 原链路失败与 cleanup 失败合并保留，互不覆盖。

## 3. 修复后本地门禁（安全守卫保持开启）

本轮最终本地门禁使用**定义入口本身**，没有设置 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，没有提高阈值：

```
CODEBUDDY_SAFE_DELETE_ENABLED=1
CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=50
```

运行前 `git status --porcelain` 为空；计划文件暂时移到 gitignored 的 `.workbuddy-ai/plan-hold/`，运行后恢复。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `pnpm typecheck` | **0** | `tsc -b` 通过 |
| `pnpm docs:verify` | **0** | `ALL CHECKS PASS` |
| `pnpm test` | **1** | 文件 **7 failed / 320 passed (327)**；用例 **6 failed / 5845 passed / 3 skipped (5855)**；445.96 s |
| `pnpm test:coverage` | **1** | 被本机删除守卫阻断：`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，`count=255`、`threshold=50`、目标 `D:\Harness Agent\coverage`；**没有取得覆盖率阈值结论** |

### 3.1 本地 `pnpm test` 失败边界

6 个失败用例是本机沙箱禁止创建符号链接的既有 6 个套件：

- `promotion-envelope-forgery.test.ts`
- `adversarial-regression.test.ts`
- `security-regression-matrix.test.ts`
- `canonical-path.test.ts`
- `exec-workspace-policy.test.ts`
- `exec-workspace-root-alias.test.ts`

第 7 个文件级失败是 `packages/tools/src/orchestrator.test.ts` 的
`P2-25: supply-chain commands are gated under their own permission resource`：
在重负载全量运行时，默认 500 ms 进程预算下 `echo hi` 收到 `timeout` 而非 `success`。
该失败与 R70 代码路径无关；本轮**未**修改 Runtime 或该无关测试，只把它记录为本地历史观察。
单独运行相关 delegation 集成测试时，当前本机 guard 保持开启，**1 passed**。

`pnpm test:coverage` 的失败是环境守卫在清理 coverage 目录时阻断，**不是 coverage threshold failure**。
本轮不复用此前关闭守卫的本地结果作为安全验收依据。

## 4. CI 验收与首次红灯诊断

### 4.1 R70 初次 CI：暴露了测试可移植性缺口

| run | head | 结果 | 观察 |
|---|---|---|---|
| `#145` `34914514513` attempt 1 | `e0c23e7` | failure | Ubuntu 主测试与 coverage 失败；Windows 主测试 success；coverage/release 上游失败导致 release attestation skipped |
| `#146` `34915407233` attempt 1 | `d63caf2`（文档提交） | failure | Ubuntu 主测试与 coverage 失败；Windows success；release attestation skipped |

通过认证读取 `#145` Ubuntu `test-report.log`，唯一失败是：

```
E4-R70 cleanup verification is ownership-based > F: an unreadable probe is UNKNOWN...
expected operation "lstat(parent)"
received operation "lstat"
```

这不是生产清理逻辑失败，而是 R70 新增测试把 Windows 分支的操作字符串硬编码到了 POSIX runner。
`cb65b02` 改为接受：

- POSIX：`lstat(child)` 直接 `ENOTDIR` → `unknown`；
- Windows：`lstat(child)` 为 `ENOENT`，随后 `lstat(parent)` 发现父项不是目录 → `unknown`。

两者都保持“不可确认即失败”的安全合同。

### 4.2 #147 attempt 1 的一次 Windows 间歇性失败

`#147` attempt 1 在 Ubuntu 与 coverage 已 success，Windows 的
`packages/harness/src/delegation-worker.integration.test.ts` 失败：

```
ENOENT: no such file or directory, open
C:\Users\RUNNER~1\AppData\Local\Temp\ar-worker-e2e-VMqHZV\src\helper.ts
```

它是一个与 R70 无关的 delegation 集成测试失败；本地单独运行该测试 **1 passed**。
在没有日志证据证明根因前，本轮不把它断言为代码缺陷，也不追加 Runtime 修复。
按 GitHub API 重跑失败 job 后，attempt 2 全绿（见 §5）。

## 5. 最终 CI（同一实现 SHA `cb65b02`，run #147 attempt 2）

run：`34916638862`，head `cb65b0209f815b215d70df035a0a03e3b368871a`，attempt **2**，
`completed / success`。

| job | ID | 结果 | 起止（UTC） |
|---|---|---|---|
| Ubuntu 主门禁 | `104217803962` | **success** | 01:16:59 → 01:18:50 |
| Windows 主门禁 | `104217803191` | **success** | 01:28:01 → 01:34:12 |
| coverage gate (ubuntu) | `104217804607` | **success** | 01:16:59 → 01:19:09 |
| release attestation | `104219078762` | **success** | 01:34:16 → 01:34:39 |

四个 job 均 success，无 skipped/cancelled/failure；这满足计划 §4.7 的同 SHA 验收。

### 5.1 具体分支执行证据

通过认证读取最终 attempt 2 上传的测试报告：

| runner | artifact 内容 | 观察 |
|---|---|---|
| Ubuntu | `test-report-ubuntu-latest`（artifact `10376906512`） | **327 test files / 5855 tests passed**；`R68_SYMLINK_CAPABILITY={"ok":true}`；`R68_LINK_DIRENT={"isSymbolicLink":true,"isFile":false}` |
| Windows | `test-report-windows-latest`（artifact `10376848352`） | **327 test files / 5854 passed / 1 skipped (5855)**；同样观察到 `R68_SYMLINK_CAPABILITY ok=true` 与 `R68_LINK_DIRENT isSymbolicLink=true,isFile=false` |

因此 R68 的平台真实链接分支在 Ubuntu 和 Windows 都真实执行，不是本机的显式 skip 或合成 Dirent 分支。
在 Ubuntu 的 5855 全通过中，R70 的条件链接路径也没有被 skip；Windows 的 1 个 skip 未从报告文本中定位到具体用例，
不把它强行归因给 R70。

### 5.2 artifacts 与内容验证边界

最终 run #147 共 16 个产物，存在：

- `coverage-summary`（6677 B）
- `gate-evidence-coverage`、`gate-evidence-ubuntu-latest`、`gate-evidence-windows-latest`
- `release-evidence-cb65b0209f815b215d70df035a0a03e3b368871a`
- Ubuntu/Windows test report、capability matrix、observation evidence、benchmark smoke

**已读取内容**：最终 attempt 2 的 Ubuntu/Windows `test-report.log`（上述测试汇总与 R68 marker）。

**未读取内容（NOT_RUN）**：coverage-summary、gate-evidence、release-evidence、capability matrix、observation evidence、benchmark smoke 的文件正文。
产物名称/大小只证明上传发生，不能单独证明内容有效。

注意：run 级产物列表还保留了 attempt 1 的
`e4-09-diagnostics-windows-latest-34916638862-attempt-1`；它对应第一次失败尝试，不能拿来否定 attempt 2 的 job success，
也不能单独证明某个故障分支在最终尝试中发生。

## 6. R69 历史报告补记

已在 `docs/E4-R69-report.md` §10 追加带日期补记，内容包括：

1. **人工删除后同版本变绿**（R69 §3.1 的历史事实）与**修复后 foreign 目录存在仍通过**（R70 新证据）是两种不同证据，前者不能替代后者；
2. 更正 R69 §3.1 对 `rmdir(RUNS_ROOT)` “遇 ENOTEMPTY 静默放过”的未经测量推断：R70 大型套件实测是“返回成功并删除共享根”，最小 Node/vitest 探针却返回 ENOTEMPTY，机制未定因；
3. foreign 目录不是本次实现泄漏，gitignore 也不授予删除他人内容的许可。

## 7. 验收结论

| 验收项 | 结果 |
|---|---|
| 本次拥有的资源泄漏会被发现 | ✅ D：精确路径 + owner + `NOT cleaned up` |
| foreign/active 资源不会引起误判或被删除 | ✅ B/C；完整 R55 预置 foreign 通过且 foreign 字节不变 |
| 探测错误不能被认证为成功 | ✅ F：EACCES/EIO → unknown → cleanup failure |
| 悬空链接不会被当作不存在 | ✅ 代码使用 no-follow `lstat`；真实链接能力由 CI 确认；本机该分支显式 skip |
| R67/R68 归档与混合复制回归有效 | ✅ CI Ubuntu/Windows 全套测试通过；R68 markers 已读取 |
| 四个必需 CI job 同一实现版本通过 | ✅ #147 / cb65b02 / attempt 2，四 job success |
| 没有人工清空真实共享根作为取得绿色前置 | ✅ R70 集成只用本任务自建 foreign 夹具；验收后清理该夹具；CI 未人工清空共享根 |
| 未关闭安全守卫、未提高阈值 | ✅ 最终本地门禁记录 `enabled=1, threshold=50`；coverage 阻断被如实记录 |
| 未新增 Runtime 重构、付费评测、release | ✅ |

**总状态：K70-A/K70-B 已关闭，R70 最终实现已在真实 Ubuntu 与 Windows 上通过，停止本轮基础设施维护。**

## 8. NOT_RUN 与残余限制

1. 原始 GitHub job 日志正文未直接读取；通过认证读取了最终 attempt 2 的测试报告 artifact 内容。
2. coverage/release 等 artifact 正文未读取；保留 NOT_RUN，不把名称/大小当内容有效。
3. 本地全量 `pnpm test` 受符号链接沙箱限制，另有一次重负载下 `orchestrator.test.ts` 的 500 ms timeout；不把它改成 Runtime 任务。
4. 本地 `pnpm test:coverage` 被安全删除守卫阻断，未取得本地 coverage threshold 结果；最终 CI coverage gate success 是权威结论。
5. 本报告之后是纯文档提交；按计划不追踪该文档提交自身触发的下一次 CI。
6. 未做付费模型调用、未发布 release、未强推、未修改远端权限。

## 9. 收尾

R70/R71 已完成：共享目录清理改为所有权验证，无法探测时失败，foreign/active 资源只诊断不删除；
最终实现 SHA `cb65b02` 的四个必需 CI job 全绿。停止这轮测试基础设施修复。
当前没有真实模型质量证据，不宣称 Agent 任务完成率或 champion 质量提升。
