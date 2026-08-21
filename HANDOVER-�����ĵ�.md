# 交接文档 — Harness Agent v4 Production Closure & Champion Promotion（plan.md 执行）

> 生成时间：本会话（Windows 开发机）
> 用途：将当前进度、环境事实、已完成任务、下一步与执行约束完整移交给后续执行者。
> 唯一进度 Truth Source：`plan.md`（本目录下，P14-1/2/3 已 backfill 为 `Status: DONE`，P14-4 为下一个任务）。

---

## 1. 项目与任务背景

- 目标：按 `plan.md`（Harness Agent v4 "Production Closure & Champion Promotion"）从 P14 起逐任务执行到 P22（Champion Promotion / Simplification-Release）。
- 基线：P0–P13 已全部关闭（baseline 全绿），从 P14 Security Closure 开始。
- 执行规则（plan.md §2.1）：主 agent 直接执行，**不使用 subagent 执行本计划**；一次一个 Task ID；每完成一个任务**立即**在 plan.md backfill 8 字段（Status / Implementation / Regression Test / Integration Test / Windows / Linux / Evidence / Notes）；不得跳过/合并任务；不得提前宣告 Phase 完成。
- 禁令（plan.md §2.3）：不得删改测试换取 CI 绿；不得 fail-open；不得 `catch {}` / `.catch(() => {})` 吞异常；不得用 raw `startsWith()` 做安全启发式；不得对副作用工具盲自动重试；下级不得扩权；benchmark/mock 不得冒充 production wiring。
- 架构约束（AGENTS.md）：core 不得依赖 UI / providers / business plugins；所有副作用经 ToolOrchestrator + PermissionEngine + SandboxManager；任务完成 = 验收标准通过并附证据；不修改无关模块。
- 全局门禁：每 Phase `pnpm typecheck`、`pnpm test`、`pnpm build`；最终 `pnpm test:coverage`、`pnpm benchmark:smoke`、`node apps/cli/dist/main.js audit --out .ci/capability`。

## 2. 环境事实（关键，勿踩坑）

| 项 | 值 |
| --- | --- |
| 工作目录 | `D:\Harness Agent\harness-agent-src` |
| Git 仓库根 | `D:\Harness Agent`（父目录）。**harness-agent-src 内没有 `.git`，其文件不被 git 跟踪**——`git stash` / `git show HEAD:...` 不影响工作源码，不要用 git 判断代码状态 |
| 测试运行器 | vitest（`pnpm vitest run <path>` 聚焦；`pnpm test` 全量） |
| DSH 会话 | approval prompts **disabled**：不得设置 `sandbox_permissions`（无提升通道）；文件策略为 danger-full-access |
| Windows | 开发机为 Windows；`executor.test.ts` afterAll 的 EPERM 是既有瞬时 flake（重跑即过，与改动无关） |
| Linux CI | **CI-PENDING**（基线 Linux 3919 passed / 0 failed 待 CI 验证；每次 backfill 的 Linux 字段照写 CI-PENDING） |

## 3. 当前进度总览

| Phase | 状态 |
| --- | --- |
| P0–P13 | 基线已关闭（Windows 全量绿） |
| P14-1 Filesystem capability canonicalization | **DONE**（plan.md 已 backfill） |
| P14-2 Exec allowlist semantic matching | **DONE**（plan.md 已 backfill） |
| P14-3 Writable delegation must require isolation | **DONE**（plan.md 已 backfill） |
| P14-4 Capability monotonicity at every extension boundary | **TODO（下一个任务）** |
| P14-5 … P14-7、P14 Phase gates、P15–P22 | 待执行（任务清单见 plan.md） |

测试计数轨迹：P14-1 完成时 3993 passed → P14-2 完成时 4025 passed / 1 skipped → P14-3 完成时 **4030 passed / 1 skipped / 0 failed**（typecheck 与 build 均 pass）。

## 4. 已完成任务摘要

### P14-1 Filesystem capability canonicalization
- 单一路径包含原语（新增 `packages/contracts/src/path-containment.ts`，41 测试）：`normaliseSeparators`（保留 UNC `//` 前缀）、`lexicalNormalize`、`isPathWithin`（boundary-aware containment）。
- 规范路径（新增 `packages/security/src/canonical-path.ts`，10 测试）：`canonicalizePath(target, {cwd})` = 全路径 realpath 或「最深存在祖先 realpath + 尾部词法规范化」（`canonicalAncestorAndTail`）；`isPathCanonicallyWithin`。空路径/控制字符路径抛错。
- 接入：`capability.ts composeCapabilities`（filesystem 分支用 `isPathWithin`）；`capability-guard.ts composeChildCapability(grant, declared, {cwd})` 对双方 fs 路径 canonicalize 后 compose；`sandbox.ts` 的 `resolvePath`→canonicalizePath、`allowedRoots()`（**跳过空 allowedPaths 条目**，fail-closed）、`withinRoot`→isPathWithin、导出 `containsPath`。
- 空路径策略：canonicalizePath 抛错；allowedRoots 跳过空条目（不扩权）。
- 已知 OS 限制：Windows junction + `..` 的 realpath 语义（realpathSync 文本折叠 `..`，不跟随 junction），已记录于 plan.md P14-1 Notes。

### P14-2 Exec allowlist semantic matching
- `packages/security/src/process-gate.ts`：`CommandPlatform`（posix/windows）、`hostCommandPlatform()`、`CommandInvocation`（program/argv/shellOperators/surface/involvesShell/involvesNetwork…）、`scanShellOperators`（每平台独立 operator/quoting 规则：POSIX `;` `&&` `||` `|` `$(` 反引号换行；cmd `&` + `^` 转义 + 双引号字面量；PowerShell 双引号内也识别 `;` `|` `&`）、`parseCommandInvocation`（组合命令 → surface 升级为 `shell-wrapper`）、`commandAllowlisted`（先 glob，再 token 级：组合目标仅 token 全等；普通目标 argv 前缀扩展；兄弟 token 拒绝）。
- `sandbox.ts checkExec` 改用 `parseCommandInvocation` + `commandAllowlisted`，raw `startsWith` 移除；`SandboxManager` 增加可选 `CommandPlatform` 参数。
- 关键结果：`git diff; rm -rf /`、`git diff &&/||/|/$()/backtick/换行`、`git diffx`、`cmd /c dir & del x`、`powershell -EncodedCommand` 全部拒绝；组合命令在 `deniedSurfaces: ["shell-wrapper"]` 下即使 `**/*` allowlist 也被拒。
- **No approval cache 存在**；`parseCommandInvocation` 输出（program + argv + hasShellOperators + surface）是未来 approval cache 的规范语义键（plan acceptance 项）。

### P14-3 Writable delegation must require isolation
- `packages/agents/src/delegator.ts` fail-closed：`writable:true` 且无 `ChildWorkspaceManager` → 在 child session / scheduler slot 创建前抛 typed `SECURITY_DENIED` AgentError，并在 parent session 发射 `security.permission_denied` 事件（payload 含 `code: "SECURITY_DENIED"`）。
- 新增 `DelegatorDeps.testOnlyUnsafeSharedWorkspace?: boolean`：显式 test-only 逃生门（共享父根写回退），**绝不进入 production config**。
- workspace create 失败清理：child session 标记 `cancelled`（best-effort）、`scheduler.unbindSession(child.id)`、`token.release()`——无孤儿会话、无 scheduler token/root 泄漏。新增导出 `writableIsolationError()` 单一语义来源。
- `packages/agents/src/parallel-delegator.ts` preflight 应用同一 isolation 门：batch 中任一 writable 请求缺 manager → 整个 batch 在任何 child 创建前拒绝（无 partial start）。
- 生产 wiring 已确认：`packages/harness/src/create-harness.ts` 对 Delegator 与 ParallelDelegator 恒注入 `new DefaultChildWorkspaceManager()`；`delegate_worker` 工具仅在 `workspaceManager !== undefined` 时注册。
- 能力单调收窄：工具/进程维度 = `restrictToolPolicy`（allow 交集 + deny 并集）+ P0-1 runtime 冻结 snapshot；filesystem 维度 = isolated-copy（child cwd = 隔离根，非 parent root）+ P3-6 sandbox 只放行隔离根 + P3-5 冲突检测合并。
- 新增测试：delegator.test.ts +4（无 manager 拒绝且零副作用/事件；escape hatch 回退；create 失败清理 + scheduler 未中毒；writableIsolationError 语义）；parallel-delegator.test.ts +1（batch preflight 拒绝）。workspace-manager.test.ts 既有 6 测试含 P3-5 冲突 fail-safe。

## 5. 下一步：P14-4（下一个任务，完整 spec 见 plan.md）

**Capability monotonicity at every extension boundary**：审计并统一 6 个边界——child agent / MCP tool-server / plugin / hook / skill declared tools / external integration。所有边界必须满足 `EffectiveCapability = ConferredCapability ∩ DeclaredCapability`（下级可省略继承或收窄，不得增加 tool/filesystem/network/process 权限）。要求：escalation → typed denial + security event；不允许"插件应该自律"式的文字声明；MCP 仍是 integration layer 不得获得 runtime core 特权；hook 可 deny / add bounded context / transform safe fields，但不得绕过 PermissionEngine 或扩大 SandboxPolicy。Acceptance：**table-driven tests，每个 boundary × 每个 capability dimension 至少 1 个 widening rejection + 1 个 narrowing success**。

接手时的审计速览（已初步勘察，供起点参考，仍需逐边界核实）：
- **child agent**：P14-3 已收口（toolPolicy ∩ + isolated workspace + P0-1 冻结快照）。
- **hook**：`packages/core/src/lifecycle/hooks.ts`（HookRegistry）已实现 gate-hook fail-closed（before_tool 抛错/超时 → deny，见 P2-19 测试）；hook context 不暴露 permission/sandbox surface（`hooks.test.ts` "hook context exposes no permission or sandbox surfaces"）。需核对「hook 不得扩大 SandboxPolicy / 绕过 PermissionEngine」是否有正式回归测试。
- **MCP**：`packages/mcp/` + `packages/contracts/src/mcp.ts`；create-harness.ts 将 MCP server 工具注册进 registry 并授予主 agent（P0-3，描述经 P0-8 injection 扫描 fail-closed）。需审计：MCP 工具声明的能力 vs 授予能力是否 intersect、是否经 ToolOrchestrator 同一 permission/sandbox 门。
- **plugin**：`packages/plugins/` + `packages/contracts/src/plugin.ts`。需审计插件边界能力计算。
- **skill**：`packages/skills/` + `packages/contracts/src/skill.ts`。需审计 skill declared tools 的注册与门控。
- **external integration**：gateway / 其他集成点，需定位。

## 6. 修改文件清单（P14-1/2/3 全部涉及）

新增：
- `packages/contracts/src/path-containment.ts` + `path-containment.test.ts`（41 tests）
- `packages/security/src/canonical-path.ts` + `canonical-path.test.ts`（10 tests）

修改：
- `packages/contracts/src/capability.ts`、`contracts.test.ts`、`index.ts`
- `packages/security/src/capability-guard.ts` + `capability-guard.test.ts`、`sandbox.ts` + `sandbox.test.ts`、`process-gate.ts` + `process-gate.test.ts`、`index.ts`
- `packages/agents/src/delegator.ts` + `delegator.test.ts`、`parallel-delegator.ts` + `parallel-delegator.test.ts`
- `packages/harness/src/workspace-manager.ts`
- `packages/evaluation/src/formal-invariants.ts`
- `plan.md`（P14-1/2/3 backfill）
- 本交接文档

## 7. 给后续执行者的注意事项

1. **先读 plan.md 对应 Task 的完整 spec**，再动手；一次一个 Task，完成后立即 backfill 8 字段。
2. 每个 Task 先写失败回归测试，再实现；跑 `pnpm vitest run` 聚焦受影响包，最后全量 `pnpm test` + `pnpm typecheck` + `pnpm build`。
3. 不要用 `git status`/`git stash` 判断源码状态（见 §2）；改动直接落在工作树。
4. Security 语义统一使用 P14-1/2/3 建立的基元：`isPathWithin` / `canonicalizePath` / `parseCommandInvocation` / `commandAllowlisted` / `writableIsolationError`——不要新建第二套。
5. Sandbox 是静态 intent 分类器（非 OS sandbox），threat model 文档在 `process-gate.ts`。
6. 交接压缩包：见本目录同级（父目录）的 zip 归档（除 node_modules 外全部内容，含 dist/coverage 可再生成物）。
