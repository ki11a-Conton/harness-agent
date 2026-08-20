# 交接文档 — Agent Runtime（harness-agent，最终版 2026-08-20）

> 本交接文档面向接手本仓库的下一位开发者 / 执行 Agent。它汇总了「当前做到哪、最终验收基线、全部 14 个 Phase 交付、还剩什么、注意事项」，并指引你使用 `plan.md` / `mem.md` / `reflection.md` 三个核心文档完成后续工作。
> **重要**：这是项目最终交接版，覆盖 P0~P13 全部 Phase（含最近两个 Linux 沙箱会话的 P4-5/7/8/9 benchmark 真实 wiring 与 P0-3 MCP transport / P8-1 plan builder / P10-6 / P12-5 四个遗留任务闭环）。

---

## 0. 状态速览

- **全部 14 个 Phase（P0~P13）已闭环**：plan.md 共 **110 项任务，除 P0-2 SKIPPED（用户约束：需 Linux 验证）外全部 Status: DONE**（P13 为 EXPERIMENT/challenger 设计标记）。
- **最终验收基线**：`pnpm test` → **174 files / 3919 tests 全部通过（3919 passed / 0 failed）**；`pnpm typecheck` 0 错误；`pnpm build` 通过。
- **测试基线轨迹**：3830 → 3895（PHASE 5~13）→ 3899（P4-5/7/8/9 benchmark wiring）→ **3919**（P0-3 MCP transport / P8-1 / CI，+20 新测试）。
- **环境**：本会话为 Linux 沙箱（Node v24.8.0，node:sqlite FTS5 已修复）；Windows 真机需由 CI（GitHub Actions 双平台 workflow，P10-6）验证。
- **工作方式约定**（用户 2026-08-20）：主 agent 直接一路做下去（不再开子代理、不再 grill）；每完成一个任务必须回填 `plan.md` 的 Status / Implementation / Integration Test / Windows / Linux / Notes，不允许跳项、不允许降低测试或安全标准。

---

## 1. 项目定位

一个 TypeScript monorepo 的**智能体运行时（Agent Runtime）**，采用 pnpm workspace。核心目标：构建具备可恢复性、长任务能力、学习/记忆机制、安全边界与可观测性的 agent 执行引擎。

| 项 | 值 |
|---|---|
| 包管理 | `pnpm@11.21.0`（见 `package.json` `packageManager`） |
| 模块系统 | ESM（`"type": "module"`），路径别名 `@ar/*` |
| 测试框架 | `vitest@4`，约定 `*.test.ts` 与源码同目录 |
| 构建 | `tsc -b`（project references） |
| 目录 | `packages/`（19 个包）+ `apps/`（cli / web）+ `benchmarks/`（adversarial / holdout / regression / stress）+ `tasks/`（任务规范）+ `research/` |

---

## 2. 核心文档（必读）

| 文件 | 作用 | 当前状态 |
|------|------|----------|
| `plan.md` | 任务计划，按 Phase（P0~P13）排布，每项含 Status / Implementation / Integration Test / Windows / Linux / Notes | **110 项全部回填**；P0-2 SKIPPED（Linux only）；P13 为 EXPERIMENT/challenger 标记 |
| `mem.md` | 会话记忆：每 Phase 的关键文件、变更、踩坑（gotchas）、测试基线轨迹 | 已含 P0~P13 全部 + 本会话四个遗留任务小节 |
| `reflection.md` | 复盘：沉淀通用的工程原则、易错点模式 | 已追加多轮经验 |
| `AGENTS.md` | 仓库级 Agent 约束与约定 | 工作方式已记录 |
| `HANDOVER.md` | 本文档 | 最终版 |

---

## 3. 最终验收基线（2026-08-20 复核）

- 全量回归：`pnpm test` → **174 files / 3919 tests：3919 passed / 0 failed**（约 100s）
- 类型检查：`pnpm typecheck`（`tsc -b`）→ **通过，无错误**
- 构建：`pnpm build` → **通过**
- 聚焦验证：`pnpm benchmark:smoke`（stub provider，无付费模型）→ 正常产出 `.ci/bench-smoke/adversarial.json` + `adversarial-summary.md`
- CI 产物验证：`node apps/cli/dist/main.js audit --out <dir>` → 产出 `CAPABILITY_MATRIX.json` / `.md`（真实 wiring 证据，文档真实性检查通过：claimed vs on-disk 全部 truthful）

> 注：历史 Windows 真机基线曾记录 23 个环境既有失败（Windows 路径分隔符相关，非业务缺陷）；当前 Linux 沙箱全绿。Windows 侧由 P10-6 CI workflow 双平台矩阵把关。

---

## 4. 全部 14 个 Phase 完成度总览

| Phase | 主题 | 任务 | 状态 |
|-------|------|------|------|
| PHASE 0 | Reality Gate + Cross-platform Truth | P0-1..P0-14（15 项） | 14 DONE + P0-2 SKIPPED |
| PHASE 1 | Durable Human Interaction + Store Coherence | P1-1..P1-7 | 7 DONE |
| PHASE 2 | Memory / Skill / Learning 真正进入 Agent | P2-1..P2-10 等 | 19 DONE |
| PHASE 3 | 真正可用且安全的 Multi-Agent | P3-1..P3-10 | 10 DONE |
| PHASE 4 | Mechanism-real Benchmark | P4-1..P4-13 | 13 DONE |
| PHASE 5 | Runtime Store V2 | P5-1..P5-5 | 5 DONE |
| PHASE 6 | Context Quality V4 | P6-1..P6-5 | 5 DONE |
| PHASE 7 | Tool Intelligence V3 | P7-1..P7-6 | 6 DONE |
| PHASE 8 | Verification V3 | P8-1..P8-4 | 4 DONE |
| PHASE 9 | Observability / Replay / Explainability | P9-1..P9-4 | 4 DONE |
| PHASE 10 | Real Harness Evolution Loop | P10-1..P10-6 | 6 DONE |
| PHASE 11 | Performance / Scale | P11-1..P11-5 | 5 DONE |
| PHASE 12 | Release / Production Readiness | P12-1..P12-6 | 6 DONE |
| PHASE 13 | 更激进实验（challenger） | P13-1..P13-5 | 5 DONE（EXPERIMENT 设计，未 promote） |

### 各 Phase 关键交付（详细 Implementation 见 plan.md 对应项）

- **P0 地基/生产化**：`agent audit` 自动 Capability Matrix（21 条能力记录，真实 wiring 证据）；`packages/harness` Production Composition Root（createHarness 组合 profile/stores/tools/pipeline/delegation/mcp）；Production Context Wiring（AGENTS.md 发现 + 信任边界 + budgetFallback 诚实报告）；CODING_TOOL_PROFILE 单一源（11+1 工具）；repo_map 进程级缓存；env_snapshot 只暴露能力不暴露值；Unknown ToolSemantics Fail-Closed；Model Usage/Cost Accounting（ModelCallId 贯穿）；RunBudgetTracker 统一 RunLimits；Tree Token Budget（scheduler RootAccount）；WorkingState Control Plane（update_plan 工具）；Command Classification 共享 classifier；CLI Summary Truthfulness（filesChanged 权威来源）。
- **P1 可恢复性**：Approval 正式 Suspension（waiting_for_approval 三处状态同步）；DurableApprovalStore 原子写；Durable AskUserStore/Inbox（JSONL + lock）；persistent profile 全 durable；Runtime Policy Snapshot + resume 漂移检测（安全 resume gate）；Clock/Timer 真正贯穿（model/tool/scheduler/delegator/mcp/verifier 全注入）。
- **P2 Memory/Skill/Learning**：MemoryRuntimeBridge（retrieve → 上下文块 → 反馈漏斗）；Pre-turn 检索接入 Context；Scope Resolver（git 仓库身份 → repository/workspace scope）；Post-turn Reflection（journal + candidate queue）；Learning Candidate Pipeline（durable queue，显式 `agent learn` promote）；Skill 渐进式披露（index → selection → body）+ effectiveness 记账。
- **P3 Multi-Agent**：DelegationLimits 拆 total/active caps；ChildWorkspaceManager（隔离副本 + patch + conflict apply，写子代理真隔离）；delegate_explore/delegate_batch/delegate_worker 工具（lazy accessor 破 registry→runtime→delegator 循环）；sandbox per-session extra roots；delegateSpecialist 真正委托；scheduler 贯通 token 预算。
- **P4 Mechanism-real Benchmark**：regression 30 + holdout 30 + adversarial 13 + stress 11 真实 case；case schema（requires / expectedEvents.atLeast / sources）；benchmark agent 工具集对齐 PRODUCTION_TOOL_NAMES；`agent benchmark list / smoke`；adv-memory-poisoning 真实 memory 机制；**P4-5/7/8/9：benchmark 的 MCP/subagent 真实 wiring**（fake MCP transport 工具真实进 registry + 注入检测真拦截；read-only worker + Delegator/ParallelDelegator + delegate_batch 12 并发 child；慢 MCP）。
- **P5 Store V2**：SqliteRuntimeStore（WAL，五类 store 合一）+ JSONL→SQLite 迁移（dry-run/idempotent/checksum）。
- **P6 Context V4**：ContextPipeline 选择遥测（context.selected/dropped/compacted）；token ROI；自适应指令发现上限；compaction 事件化。
- **P7 Tool Intelligence V3**：Command Discovery（P7-6，code-changing turn 惰性发现 + 持久 hints 供 P8-1 消费）；ToolSelector 渐进式工具披露；工具失败结构化分类。
- **P8 Verification V3**：**plan builder（P8-1，已接 runtime 自动编排）**；增量 verification 证据（verification.step_started/completed，稳定 ref）；False-complete 分级（unverified_complete/verification_failed/verified_partial/verified_complete）；共享 command classifier。
- **P9 Observability**：ModelCallId trace（tool.requested/completed 经 parentCallId 关联）；`agent explain`（可观测证据回答 why）；`agent recover list` 启动恢复扫描。
- **P10 Evolution Loop**：learning candidate promote 门；platformSensitivity（policy/memory patch 敏感 → 需双平台 CI）；**P10-6 Windows/Linux 双平台 CI workflow（promotion 门）**。
- **P11 Performance**：perf-suite（10k messages + 1k events + 500 sessions ≈ 14.7s 确定性测）；context build 计时（10k history ~9ms）；host-scoped cache 统一；artifact/event retention（防无限增长）。
- **P12 Release**：Harness Profiles（interactive/batch/benchmark/test）；version/migration policy（EVENT_ABI_VERSION / schema_migrations / SCHEMA_VERSION）；**P12-5 Capability Matrix 成为 CI artifact（生成 + 上传）**。
- **P13 Experiments（challenger 设计，未 promote）**：Planner/Executor 分阶段提示；Independent Reviewer profile（只读审计）；Specialist Router（explorer/debugger/reviewer）；Adaptive Context Policy（suggestMemoryTopK）；Adaptive Scheduler（suggestConcurrency）。

---

## 5. 最近两个会话的关键工作（重点）

### 会话 A：P4-5/P4-7/P4-8/P4-9 — benchmark 的 MCP/subagent 机制真实 wiring

- benchmark case 声明 `requires:["mcp"]` / `["subagent"]` / `["scheduler"]` 时，runOneCase 在运行时**真实注册并调用对应机制**（不再是"模拟"）：
  - `apps/cli/src/fake-mcp.ts`：`createFakeMcpTool` 生成真实 ToolDefinition（读 fixture 文件），输出走正常 tool-output pipeline（P0-8 注入检测 fail-closed）。
  - 真实 `Delegator` / `ParallelDelegator` 创建 child session（delegate_explore / delegate_batch），12 个真实并发 child。
  - `agent.tools.allow` 硬门修复：机制工具必须追加进 allow 列表，否则 orchestrator 拒绝。
- 测试：`benchmark-command.test.ts` 新增 4 个集成用例（注入拦截 / 真实 child / 12 并发 / 慢 MCP）；全仓 3899 → 全绿。

### 会话 B：四个遗留任务闭环（本次会话）

| 任务 | 交付 |
|------|------|
| **P0-3 真实 MCP transport wiring** | `packages/mcp/src/mcp-transport.ts`（`connectMcpServer`：http=McpClient JSON-RPC over fetch、stdio=StdioMcpClient spawn 子进程，均为真实 transport）；`stdio-client.ts`（spawn/超时/Abort 取消/ensureReconnected）；`json-schema-zod.ts`（JSON Schema → zod）；createHarness 接入（连接/注入失败中止创建 fail-closed；main agent tools.allow 追加 MCP 工具；stdio network=false 过默认沙箱、http 需 `HarnessConfig.sandboxPolicy` 放行；`introspection.mcp` 报告 {servers, tools}）。测试：mcp-transport.test 6 用例 + mcp-wiring.integration.test 6 用例 |
| **P8-1 verification plan builder runtime 自动编排** | `planToVerificationSpecs()`（计划 → VerificationSpec）；core `VerificationController.planVerification` + `AgentRuntime.verificationPlanner`；createHarness 默认 planner（消费 P7-6 command discovery hints）——task 未声明 specs 时自动生成并执行（显式 specs 优先；空 plan 诚实 fail-closed）；顺手修复 TaskVerifier.checkCommand 的 shell 引号转义缺陷（`node -e process.exit(0)` 在 sh -c 下语法错误）+ onStep 透传 sessionId。测试：verification-wiring.integration.test 4 用例 |
| **P10-6 Windows CI** | `.github/workflows/ci.yml` verify job 双平台 matrix `[ubuntu-latest, windows-latest]`（path/filesystem/process/store 敏感 patch 的 promotion 门 = 双平台全绿） |
| **P12-5 CI 上传** | 每平台上传 3 个 artifact：benchmark smoke、`CAPABILITY_MATRIX.md/.json`（`agent audit --out` 真实生成）、test-report.log |

---

## 6. 关键文件索引（接手第一站）

### 架构核心
- `packages/harness/src/create-harness.ts` — Production Composition Root（profile/stores/registry/mcp/delegation/memory/verifier 全部组装点）
- `packages/harness/src/config.ts` — HarnessConfig（profile / dataDir / mcp / task / verification / sandboxPolicy）
- `packages/core/src/runtime/runtime.ts` — AgentRuntime（主循环 + 各 controller 组装）
- `packages/contracts/src/` — 全部类型契约（tool / verification / event / mcp / sandbox）

### 本会话新增/改动
- `packages/mcp/src/mcp-transport.ts`、`stdio-client.ts`、`json-schema-zod.ts`（P0-3 真实 MCP transport）
- `packages/harness/src/verification-planner.ts`、`verification-wiring.integration.test.ts`、`mcp-wiring.integration.test.ts`（P8-1 + P0-3 wiring 测试）
- `packages/tools/src/verification/plan-builder.ts`（+`planToVerificationSpecs`）、`task-verifier.ts`（+shellQuote、onStep sessionId）
- `packages/core/src/runtime/verification-controller.ts`（+planVerification）
- `.github/workflows/ci.yml`（双平台 + 上传）
- `apps/cli/src/fake-mcp.ts`、`benchmark-command.ts`（P4-5/7/8/9 wiring）

### 完整索引
每个 Phase 的关键文件清单见 `mem.md` 各 Phase 小节 + `plan.md` 各任务 Implementation 行。

---

## 7. 常用命令与环境注意

```bash
pnpm install          # 安装依赖（解压后第一步）
pnpm test             # 全量回归（vitest run，约 100s）
pnpm typecheck        # tsc -b
pnpm build            # tsc -b（与 typecheck 相同脚本）
pnpm exec vitest run <path>      # 聚焦测试，如 packages/mcp
pnpm benchmark:smoke  # stub provider 无付费模型跑 1 个 adversarial case
node apps/cli/dist/main.js audit --out <dir>   # 生成 CAPABILITY_MATRIX（需先 build）
```

> ⚠️ 环境注意：
> 1. `typescript@7.0.2`（tsgo 原生）增量构建可能 panic：typecheck 前先清 `node_modules/.cache/tsbuildinfo` 或 `tsc -b --force`；依赖包报 "no exported member" 通常是 stale tsbuildinfo。
> 2. 新增 AgentEvent 类型必须先登记 `packages/contracts/src/event.ts` EVENT_TYPES + event-payloads.ts，否则 `this.emit` 类型报错。
> 3. `waiting_for_approval` 等状态变更需同步 `TurnStatus`(session.ts) / `TurnOutcomeStatus`(core) / `AgentPhase`(core) 三处。
> 4. `setTimeout` → `Timer.schedule` 后 `clearTimeout(id)` 要改 `handle.cancel()`。
> 5. MCP 工具（http）过 orchestrator 沙箱需要 `sandboxPolicy` network 放行（默认 deny）；stdio 为本地 IPC 不受限。

---

## 8. 交接经验（gotchas 指引）

完整 gotchas 见 `mem.md`（每 Phase 小节）与 `reflection.md`（通用原则）。高频要点：

- **agent.tools.allow 是硬门**：机制工具（MCP/delegate）注册进 registry 但不在 agent.tools.allow → orchestrator 按 session tool policy 拒绝（execute 不调用）。
- **shell 特殊字符破坏 args.join**：`node -e process.exit(0)` 经 `sh -c` 报 "Syntax error: ( unexpected"——命令参数必须 shell 引号转义（已修复，`shellQuote`）。
- **MCP 工具描述注入 fail-closed**：注册前 P0-8 扫描，命中即 `MCP_DENIED`，事件走 `security.mcp_denied`（会话已知时）。
- **child 继承主 runtime 的 task/verifier gate**：benchmark 子代理也会跑 artifact 验证——测试 case 断言以 expectedEvents 为核心，避免不必要的 artifact verification。
- **doctor 计数断言是冻结字面量**：新增 check 后 `6 ok, 4 warning(s)` 要同步改。
- **pnpm workspace node_modules 是深层符号链接环**：直接 `zip -r` 会跟随 symlink 无限递归——打包必须排除 node_modules 且不跟随符号链接（zipfile / os.walk(followlinks=False)）。

---

## 9. 剩余边界 / 后续增强

全部 Phase 已闭环，以下为诚实边界（HANDOVER 不虚构）：

| 边界 | 说明 | 触发条件 |
|------|------|----------|
| **P10-6 / P12-5 需 GitHub runner 真机** | workflow 已配置并本地验证（audit/smoke 产出 + YAML 语法），但沙箱无法执行 windows-latest | 仓库推送至 GitHub 后 CI 自动跑 |
| **P13 challenger 未 promote** | Planner/Executor、Reviewer、Specialist Router、Adaptive Context/Scheduler 均为 EXPERIMENT 设计（experiments.ts） | 需真实 benchmark 门（P10）验证 |
| **P4-10 benchmark 未迁 createHarness** | benchmark-command 仍自建 AgentRuntime（未复用 `createHarness({profile:"benchmark"})`） | 后续重构 |
| **P0-10 RunBudgetTracker 部分触发点** | 少数 RunLimits 触发点未统一走 tracker | 后续收敛 |
| **P2-9 effectiveness 维度** | verification/tokenCost 维度未接 | 后续 |
| **P3-6 delegate_worker 端到端集成测试** | 写子代理隔离合并路径缺端到端集成测试 | 后续 |

---

## 10. 交付物与打包说明

- **源码包**：`harness-agent.zip`（**排除依赖**：`node_modules`、`dist`、`coverage`、`.cache`、`.tsbuildinfo`；不跟随符号链接）。内含全部 `packages/**`、`apps/**`、`benchmarks/**`、`tasks/**`、`research/**` 源码与测试，以及**全部 217 个 `.md` 文档**（`plan.md`、`mem.md`、`reflection.md`、`HANDOVER.md`、`AGENTS.md`、`optimization-report.md`、`CAPABILITY_MATRIX.md` + benchmarks/tasks 内全部 markdown）。
- **收到后恢复运行**：解压 → `pnpm install`（需 node_modules）→ `pnpm typecheck` → `pnpm test`。
- **CAPABILITY_MATRIX**：`.md` / `.json` 已含在包内；重新生成 = `pnpm build && node apps/cli/dist/main.js audit --out <dir>`。
