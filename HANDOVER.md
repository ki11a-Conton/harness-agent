# 交接文档 — Agent Runtime（harness-agent-main）

> 本交接文档面向接手本仓库的下一位开发者 / 执行 Agent。它汇总了「当前做到哪、验收基线、还剩什么、注意事项」，并指引你使用 `plan.md` / `mem.md` / `reflection.md` 三个核心文档完成后续工作。

## 1. 项目定位

一个 TypeScript monorepo 的**智能体运行时（Agent Runtime）**，采用 pnpm workspace。核心目标是构建一个具备可恢复性、长任务能力、学习/记忆机制、安全边界与可观测性的 agent 执行引擎。

- 包管理：`pnpm@11.21.0`（见 `package.json` 的 `packageManager`）
- 模块系统：ESM（`"type": "module"`），路径别名 `@ar/*`
- 测试框架：`vitest@4`，all test files 约定 `*.test.ts` 与源码同目录
- 构建：`tsc -b`（project references）

## 2. 核心文档（必读）

| 文件 | 作用 | 当前状态 |
|------|------|----------|
| `plan.md` | 任务计划，按 Phase（P0/P1/P2/P3）+ Q 系列硬指标项排布，每项含 Status / Tests / Benchmark / Notes | 5328 行，**几乎全部 DONE**，仅 Q-1 仍为 IN_PROGRESS |
| `mem.md` | 会话记忆：每 Phase 的关键文件、变更、踩坑（gotchas）、测试基线轨迹 | 298 行 |
| `reflection.md` | 复盘：沉淀通用的工程原则、易错点模式、修复经验 | 78 行 |
| `AGENTS.md` | 仓库级 Agent 约束与约定 | 接手前先读 |
| `HANDOVER.md` | 本文档 | — |

**约定**：每完成一个任务必须回填 `plan.md` 的 Status / Tests / Benchmark / Notes；不允许跳项，不允许为达标而降低测试或安全标准。

## 3. 当前验收基线（2026-08-19 复核）

我在此次接手时重新执行验证，以下为**当前真实基线**：

- 全量回归：`pnpm test` → **137 files / 3672 tests 全部通过**（耗时约 80s）
- 类型检查：`pnpm typecheck`（即 `tsc -b`）→ **通过，无错误**
- 构建：`pnpm build` 可用（`tsc -b`）
- 仓库当前**不处于 git 版本控制之下**（`git status` 为空），如需 git 历史请自行 `git init` 后核对

## 4. 任务完成度总览

### P0 —— 必须先完成（安全/地基）
P0-1 ~ P0-8 全部 **DONE**：Session/Agent 快照、工具策略审计、SQLite+WAL 记忆存储、检索 V2、LearningPromoter V2、基准完整性与复现、安全边界审计、信任感知上下文模型。

### P1 —— 运行时可恢复性与长任务能力
P1-1 ~ P1-20 全部 **DONE**：WorkingState 统一运行状态、Context 压缩 V3、持久化 Checkpoint、崩溃恢复/事件回放、故障注入 V2、调度器、层级预算、子代理完成协议、父子状态交接、取消树、工具语义注册表、制品注册表、输出敏感度/脱敏、验证 V2、假完成防御、Diff 感知代码验证、指令层级、Provider 可靠性、模型能力注册表、可观测性/Trace V2。

### P2 —— 学习/记忆/机制演化 + 安全 + 工具链
P2-1 ~ P2-30 全部 **DONE**：反思 V2、记忆证据模型、有用性反馈、衰减/废弃/冲突、技能有效性、技能选择、候选沙箱、机制注册表、实验 harness、回归归因、失败案例挖掘、对抗/压力基准扩展、评估成本模型、跨模型评估、提示词/策略版本化、插件硬化、Hook 硬化、MCP 可靠性/信任、文件系统/进程沙箱、网络门 V2、供应链安全、变更事务、写入保护、文件/搜索/地图缓存等。

### Q —— 硬质量指标项
- Q-2 ~ Q-20 全部 **DONE**（Q-3、Q-9、Q-12 等部分项在审计后回填；Q-13~Q-20 于 2026-08-19 完成）。
- **Q-1 拆分超大 `runtime.ts`：IN_PROGRESS（进行中）—— 见第 5 节。**

## 5. Q-1 详细进度（接手点）

目标：把 `packages/core/src/runtime/runtime.ts`（初值约 110KB / 数千行）逐步拆分，**不要一次性大爆炸重写**，每拆一块跑全量回归，保持 event semantics 与公共 API 不变。

当前 `runtime.ts` 已承载：model loop / context / retry / tool execution / verification / compaction / inbox / limits / artifact rendering。

### 已完成（每一步均通过 137 files / 3672 tests 全绿 + tsc 通过）

1. **helper substrate（DONE）**：9 个纯静态助手从 `runtime.ts` 抽到
   `packages/core/src/runtime/turn-helpers.ts`：`renderToolResult`、`buildResumePrompt`、
   `updateWorkingState`、`workingStateToCompactionSummary`、`isContextOverflowError`、
   `toContextBlock`、`trimMessageHistory`、`isEffectiveAgentConfig`、
   `DEFAULT_RUNTIME_TOOL_SEMANTICS`（及原私有方法 `buildStateDigest`）。`runtime.ts`
   改为 import，公共 API 通过 `export { renderToolResult, buildResumePrompt }` 保稳。
2. **TurnContext 只读上下文对象（DONE）**：`turn-helpers.ts` 定义 `TurnContext`
   （`sessionId/turnId/signal/session/agent`），8 个私有方法签名从散列参数改为
   `(ctx: TurnContext, ...)`；`executeToolCall` 内部同名变量改 `hookCtx`。
3. **`decideModelRetry` 纯函数（DONE）**：model 重试决策（success/compact-and-retry/retry/fail）
   抽为纯函数 + `ModelRetryAction` 类型；`suppressLimitEvent` 语义精确保持。
4. **`callModelWithRetry` 方法（DONE）**：流式接收+重试决策+reactive compaction（~130 行）
   抽为方法，返回 `ModelCallResult`（completed/cancelled/failed）。
5. **`handleModelCompletion` 方法（DONE）**：post-completion（wall clock、append 消息、
   model.completed、verification gate+重试、finishReason 分发、ask-user gate，~110 行）
   抽为方法，返回 `CompletionResult`（continue_loop/finish/proceed）。
6. **`handleToolResults` 方法（DONE）**：post-execution（rendering、append、working state、
   ledger、side-effect checkpoint、stall detection、maxToolCalls、post-batch abort，~150 行）
   抽为方法，返回 `ToolResultsAction`。`runTurn` 主循环缩至 ~343 行。
7. **`injectSteeringPrompts` + `buildContext` 抽取（DONE）**：steer 注入 + context pipeline
   （discovery、system prompt、auto-compact、trim、overflow 检查，~183 行）。`runTurn`
   进一步缩至 **~159 行编排骨架**。

> 进度细节与每一步的 Notes 已写入 `plan.md`（Q-1 段，第 4519 行起）。

### 下一步（接手者从这里继续）

Q-1 剩余（plan.md 中标注 **Next**）：
- 抽取初始化逻辑 `prepareTurn`（runTurn 的 init 段）。
- 将 `executeToolCalls` / `executeToolCall` / `runReadBatch` 移入独立模块
  （可考虑新建 `tool-call-controller.ts`）。
- 后续可选分解为 plan 中列举的：`ModelCallController`、`ToolCallController`、
  `ContextController`、`VerificationController`、`RecoveryController`、`TurnRunner`。
- **每拆一块必须跑 `pnpm typecheck` + `pnpm test`，确认 137 files / 3672 tests 全绿**。

`packages/core/src/runtime/` 目录现状：

```
runtime/  artifact-store.ts/.test.ts  checkpoint.test.ts  effective-config.test.ts
          fault-injection.ts(.test)  fault-injection-v2.test.ts  loop-integration.test.ts
          resume.test.ts  runtime.test.ts  runtime.ts  turn-helpers.ts
```

## 6. 常用命令

```bash
pnpm install          # 安装依赖（需 node_modules）
pnpm test             # 全量回归（vitest run）
pnpm typecheck        # tsc -b
pnpm build            # 同 typecheck
pnpm test:watch       # 增量
pnpm test:coverage    # 覆盖率报告
pnpm benchmark:smoke  # 对抗基准冒烟（--allow-stub）
```

## 7. 反馈给接手者的关键经验（来自 reflection.md / mem.md）

- **`??` 与其它运算符混用时务必加括号**：`a ?? b + c` 会先算 `b + c`；`a?.x ?? b` 也踩过。
- **向后兼容优先**：新增字段一律 optional；空 JSON `"{}"` 在读取时归 `undefined`，避免 `toEqual` 挂掉。
- **SQLite 迁移用增量列 + `INSERT OR IGNORE`**，每版独立迁移测试，物理不删除历史。
- **浮点饱和**：`x + (1-x)*s` 到不了精确 1.0，断言语用 `toBeCloseTo` / `toBeGreaterThan`。
- **单一 token 的 Jaccard 太弱**：短查询要降低 minScore 或用多 token goal。
- **不要物理删除历史证据 / 不要用工具名猜语义**（Q-2 已全面迁移到 ToolSemantics，名称键仅作兼容回退）。
- 具体每 Phase 的 gotchas 已在 `mem.md`；通用原则在 `reflection.md`。

## 8. 交付物说明

本压缩包（`harness-agent-main.tar.gz`）**排除依赖**（`node_modules`、`dist`、`coverage`），
含以下完整源码与文档：

- 全部 `packages/**` 源码与测试、`apps/**`、`benchmarks/**`（对抗/压力基准）
- `research/**`（机制研究配置）
- `tasks/**`（各 Phase 任务规格）
- 三份核心文档：`plan.md`、`mem.md`、`reflection.md`
- 工程配置：`package.json`、`pnpm-*.yaml`、`tsconfig*.json`、`vitest.config.ts`、`.gitignore`、`.npmrc`

收到后在仓库根目录执行 `pnpm install` 即可恢复可运行状态。