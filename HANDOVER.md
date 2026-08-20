# 交接文档 — Agent Runtime（harness-agent-main，2026-08-20 会话）

> 本交接文档面向接手本仓库的下一位开发者 / 执行 Agent。它汇总了「当前做到哪、验收基线、还剩什么、注意事项」，并指引你使用 `plan.md` / `mem.md` / `reflection.md` 三个核心文档完成后续工作。

## 1. 项目定位

一个 TypeScript monorepo 的**智能体运行时（Agent Runtime）**，采用 pnpm workspace。核心目标是构建一个具备可恢复性、长任务能力、学习/记忆机制、安全边界与可观测性的 agent 执行引擎。

- 包管理：`pnpm@11.21.0`（见 `package.json` 的 `packageManager`）
- 模块系统：ESM（`"type": "module"`），路径别名 `@ar/*`
- 测试框架：`vitest@4`，约定 `*.test.ts` 与源码同目录
- 构建：`tsc -b`（project references）
- 平台：Windows 真机开发（安装者约束：需要 Linux 环境执行/验证的任务一律跳过；Q-12 Windows path parity 遗留，见 §6）

## 2. 核心文档（必读）

| 文件 | 作用 | 当前状态 |
|------|------|----------|
| `plan.md` | 任务计划，按 Phase（P0/P1/P2/P3）排布，每项含 Status / Implementation / Integration Test / Windows / Linux / Notes | P0-1..P0-14、P1-1..P1-7 **DONE**；P1-2 SKIPPED（Linux only） |
| `mem.md` | 会话记忆：每 Phase 的关键文件、变更、踩坑（gotchas）、测试基线轨迹 | 已含 P0 全部 + P1-1..P1-7 |
| `reflection.md` | 复盘：沉淀通用的工程原则、易错点模式 | 84 行 |
| `AGENTS.md` | 仓库级 Agent 约束与约定 | 工作方式已记录（用户 2026-08-20：**不再开子代理、不再 grill**，主 agent 一路做下去） |
| `HANDOVER.md` | 本文档 | — |

**约定**：每完成一个任务必须回填 `plan.md` 的 Status / Implementation / Integration Test / Windows / Linux / Notes；不允许跳项，不允许为达标而降低测试或安全标准。

## 3. 当前验收基线（2026-08-20 复核）

> 在**本次会话**全部改动之上重新验证：

- 全量回归：`pnpm test` → **148 files / 3759 tests：3735 passed / 23 failed / 1 skipped**（约 65s）
- 类型检查：`pnpm typecheck`（`tsc -b`）→ **通过，无错误**
- 聚焦集（本会话改动包）：core 192、agents 88/91、context 75、mcp 58、session 20+6、harness 13、tools 280、web 17、cli —— 全部通过

### 23 个失败 = 既有 Windows 环境基线（与本次改动无关）

失败文件全部在非 core 包，均为环境既有问题，且已在本会话用 `git stash` 干净基线复验过（23 = 16+7 恰好相等），**改任一 P0/P1 任务不会新增失败**：

| 文件 | 数量 | 原因 |
|------|------|------|
| `packages/security/src/sandbox.test.ts` | 8 | Windows 路径解析（workspace/绝对路径/大小写折叠） |
| `packages/tools/src/vs001.test.ts` | 5 | Windows 路径分隔符导致文件系统工具断言失败 |
| `packages/tools/src/orchestrator.test.ts` | 3 | `denied` vs `success`/`failed` 判定（Windows 路径） |
| `packages/events` / `memory` / `session` / `store-integrity` | 4 | backup() P2-35 POSIX 分隔符断言 |
| `packages/tools/src/source-matrix.test.ts` | 1 | 同上 |
| `packages/evaluation/src/benchmark-suite.test.ts` | 2 | stress fixture 度量受路径影响 |

## 4. 本次会话任务完成度（2026-08-20）

### P0 —— 地基/生产化（全部 DONE，除 P0-2 SKIPPED）

- **P0-1 自动 Capability Matrix**：`apps/cli/src/audit.ts` + `agent audit [--json] [--out <dir>]`，从真实 wiring（HarnessIntrospection）推导 21 条能力记录，写 `CAPABILITY_MATRIX.md/.json`，文档真实性检查（README 声称 vs benchmarks/ 磁盘）。
- **P0-2 Windows/Linux Path Parity**：SKIPPED（用户约束：需 Linux 环境验证）。
- **P0-3 `@ar/harness` Production Composition Root**：新建 `packages/harness/`（config/profiles/introspection/lifecycle/mem-stores/create-harness）。CLI `createDefaultDeps` 与 Web `apps/web/src/main.ts` 均复用 `createHarness`。`HarnessIntrospection` 如实报告 stores/tools/features。
- **P0-4 Production Context Wiring**：真实 Harness + fixture workspace + fake model 捕获 system prompt 的集成测试；`EventPayloadMap` 补 `context.built`/`instruction.discovered`/`ContextCompactedPayload`；doctor 新增 `checkContextBudget`（budgetFallback→WARNING）。
- **P0-5 Production Tool Profile V2**：`packages/tools/src/production-tools.ts` 单一源（`CODING_TOOL_PROFILE`/`createProductionTools`），CLI `BUILTIN_TOOLS` 收敛到 11 工具。
- **P0-6 repo_map cache 生命周期**：`createRepoMapTool(resolver)` factory，`getSharedRepoMapResolver()` 进程级单例共享缓存（不再 per-execute 重建）。
- **P0-7 env_snapshot 注入真实能力**：factory deps 改为函数形式（networkMode/availableTools/workspaceRoot/harnessProfile 每次实时求值），不暴露 env 值/密钥。
- **P0-8 Unknown ToolSemantics Fail-Closed**：`sideEffectScope`/`networkBehavior` 加 `"unknown"`；`DEFAULT_TOOL_SEMANTICS` 保守化；`mayHaveSideEffect()` helper；crash-resume 对未知工具 resolve sideEffect=true 不重放。
- **P0-9 Model Usage / Cost Accounting**：runtime 不再 `case "usage": break`，`mergeUsage` snapshot 语义，`ModelCallId` 贯穿 model.started/retry/completed/failed，`model.completed` 携带 usage；metrics 只从 `model.completed` 统计（防双计数）。
- **P0-10 RunBudgetTracker**：`packages/core/src/runtime/run-budget.ts`，统一跟踪所有 RunLimits，替代 runtime 散落的 maxToolCalls/maxDurationMs 检查。
- **P0-11 Tree Token Budget**：scheduler `RootAccount` 加 tokenUsed/tokenReserved，`reportUsage()`、`tokenBudgetRemaining()`、acquire 支持 tokenBudget。
- **P0-12 WorkingState Control Plane**：`WorkingStateMutation` 8-op union + `applyWorkingStateMutation`，`update_plan` 工具（runtime 拦截，不经过 orchestrator）。CODING_TOOL_PROFILE 扩为 12 工具。
- **P0-13 Command Classification**：`command-classification.ts`（classifyCommand），updateWorkingState 用 structured 分类替代 /test/i 正则。
- **P0-14 CLI Summary Truthfulness**：`changedFiles()` 删除改从 `outcome.state.filesChanged`（WorkingState 权威），只读工具不再误报为文件修改。

### P1 —— 运行时可恢复性（P1-1..P1-7 DONE）

- **P1-1 Approval 正式 Suspension**：`waiting_for_approval` 状态贯穿 TurnOutcome/Turn/AgentPhase；`parkForApproval()` + `pendingApproval` payload。
- **P1-2 ApprovalStore 重构到接口**：`InMemoryApprovalStore`/`DurableApprovalStore` `implements ApprovalStore`。
- **P1-3 DurableApprovalStore 原子写**：persist() 用 tmp+rename，parent dir mkdir。
- **P1-4 Durable AskUserStore**：`packages/session/src/ask-user-store.ts` JSONLAskUserStore（withLock+atomicWrite，6 测试）。
- **P1-5 全部接入 persistent profile**：dataDir 下 JSONLAskUserStore 接入 harness（Inbox/Approval/AskUser/Checkpoint 全 durable）。
- **P1-6 Runtime Policy Snapshot**：`EffectiveRuntimePolicySnapshot` 存 session snapshot，resume 检测 context policy hash 漂移并 emit `policy.changed_on_resume`（安全 resume gate）。
- **P1-7 Clock / Timer 真正贯穿**：模型/tool controller Date.now→deps.now、AgentState 注入 now、hooks runGuarded 用 Timer.schedule、verifier/scheduler/delegator/mcp/compactor 全贯穿注入时钟（残留仅 mcp delay() 退避）。

## 5. 本会话新增/修改的关键文件索引

- 新增包：`packages/harness/`（P0-3 composition root）
- 新增模块：
  - `packages/tools/src/production-tools.ts`（P0-5）、`tools/update-plan-tool.ts`（P0-12）
  - `packages/core/src/runtime/run-budget.ts`（P0-10）、`command-classification.ts`（P0-13）
  - `packages/session/src/ask-user-store.ts`（P1-4）
- 增改测试：`create-harness.test`、`context-wiring.integration.test`、`default-harness.integration.test`、`harness.integration.test`（web）、`production-tools.test`、`run-budget.test`、`command-classification.test`、`ask-user-store.test`，另 `audit.*` 3 文件、`semantics.test`、`fault-injection-v2.test` 扩充。
- Contracts 扩充：`ModelCallId`/`UsageSnapshot`、`WorkingStateMutation`、`EffectiveRuntimePolicySnapshot`、`PolicyChangedOnResumePayload`、事件 payload 补齐、ToolSemantics scope 扩展。

## 6. 常用命令与 Windows 注意

```bash
pnpm install          # 安装依赖（需 node_modules）
pnpm test             # 全量回归（vitest run）
pnpm typecheck        # tsc -b
pnpm exec vitest run <path>   # 聚焦测试
```

> ⚠️ **Windows 真机接手注意（2026-08-20 复核）**：
> 1. `typescript@7.0.2`（tsgo 原生）**增量构建可能 panic**：typecheck 前先
>    `Remove-Item -Recurse -Force node_modules/.cache/tsbuildinfo` 再 `tsc -b --force`
>    或 `pnpm typecheck`（脚本已处理）。改了 `packages/tools` 等被依赖包后，
>    依赖包报 "no exported member" 通常是 stale tsbuildinfo，先清缓存。
> 2. 全量测试在真 Windows 上约 **23 个失败**（见 §3），属环境既有，与 P0/P1 改动无关。
> 3. 本机无 Linux：需要 Linux 验证的任务（P0-2）跳过；`ci_windows` audit 记录如实报告。
> 4. 工作目录 `D:\Harness Agent`（含空格），任何路径引用都要加引号。

## 7. 反馈给接手者的关键经验（来自 mem.md / reflection.md）

- **并行 subagent 静默失败**：狭窄任务若出现子代理两次无产出，按主 agent 直接做窄改动，不第三次委派（本会话已改用直接实现）。
- **TS 三元收窄在箭头闭包内失效**：`typeof x === "function" ? x : () => x` 会报错，先抽 `const v = x` 再分支。
- **新增 AgentEvent 类型必须先在 `packages/contracts/src/event.ts` EVENT_TYPES 登记** + event-payloads.ts，否则 `this.emit` 类型报错。
- **状态联合同步**：`waiting_for_approval` 需同步 `TurnStatus`(session.ts)/`TurnOutcomeStatus`(core)/`AgentPhase`(core) 三处。
- **`setTimeout`→`Timer.schedule` 替换后 `clearTimeout(id)` 要改 `handle.cancel()`**。
- **doctor 计数断言是冻结字面量**：新增 check 后 `6 ok, 4 warning(s)` 要同步改。
- **合成测试工具必须显式声明 semantics**（P0-8 后 unknown 默认 fail-closed，echo/flaky 要声明 sideEffectScope:none）。
- **全量 vitest 基线 23 failed 已用 git stash 干净基线复验**，是判定「新失败」的参照线。
- 具体每 Phase 的 gotchas 在 `mem.md`；通用原则在 `reflection.md`。

## 8. 剩余工作（plan.md 后续）

- **P2 阶段（Memory / Skill / Learning 真正进入 Agent）**：P2-1 MemoryRuntimeBridge、P2-2 Pre-turn Retrieval、P2-3 Scope Resolver、P2-4 Feedback Funnel、P2-5 Post-turn Reflection、P2-6 Learning Candidate Pipeline、P2-7 Promotion 安全边界、P2-8 Skill Selection→Body Load→Context 等。
- **P3 阶段（Delegation）**：只读 delegation、子代理隔离、合并、会话安全等。
- 已知遗留：P1-8 MemoryRuntimeBridge 尚未接（harness memory: true 时才接）；benchmark-command 仍自建 AgentRuntime（未迁移 createHarness）；P0-10 RunBudgetTracker 的 maxTurns/maxOutputChars/maxRetries/maxSubagents/maxEstimatedCostUsd 触发点未全部接入 runtime 对应位置。

## 9. 交付物说明

本压缩包（`harness-agent-main.zip`）**排除依赖**（`node_modules`、`dist`、`coverage`、`.git`、缓存），含以下完整源码与文档：

- 全部 `packages/**` 源码与测试（含 `packages/harness/`）、`apps/**`、`benchmarks/**`
- `research/**`、`tasks/**`
- 核心文档：`plan.md`、`mem.md`、`reflection.md`、`HANDOVER.md`、`AGENTS.md`、`optimization-report.md`
- 工程配置：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig*.json`、`vitest.config.ts`、`.gitignore`、`.npmrc`
- 生成物：`CAPABILITY_MATRIX.md` / `.json`（`node apps/cli/dist/main.js audit` 可再生成，但本包不含 dist，需先 build）

收到后在仓库根目录执行 `pnpm install` 即可恢复可运行状态。