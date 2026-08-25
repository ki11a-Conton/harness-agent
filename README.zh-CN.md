# Harness Agent（智能体运行时）

一个 TypeScript 智能体运行时：**会话单一所有者**（SessionActor）、**实时流式 SDK**、**纵深安全门禁**，以及**基准驱动的机制演化**。

基于 pnpm workspace 单体仓库：`packages/` 下 24 个 `@ar/*` 包，外加 `apps/cli` 与 `apps/web`。

> [English](./README.md) · 中文

---

## 核心亮点

- **SessionActor —— 每个会话只有一个所有者。** 通过统一的状态机（`idle → starting → running → closing`）保证 `activeTurn ∈ {0,1}`。跟进队列、steer、中断、取消与卸载共享同一条可线性化的准入路径；持久化跟进只有在 turn 创建成功后才标记消费。
- **LoadedSessionManager —— 代数（generation）围栏。** 旧的在途加载在 unload/close 之后永远无法"复活"，也无法删除新代次的单飞（single-flight）条目。
- **流式优先 SDK。** `runStreamed()` 先订阅再调用 `turn/run`，并在终端完成之前返回。所有终态路径（事件、abort、transport EOF、缓冲溢出、invoke 错误）**恰好结算一次**并释放全部运行期监听器；事件通道有界（4096 条），流失败是错误，绝不会伪装成正常 EOF。
- **纵深安全。** 规范路径包含性检查（EACCES/EPERM/ELOOP/EIO/深度一律 fail-closed）、带 shell 组合检测的沙箱执行、工具输出的 prompt 注入检测、敏感信息脱敏、审批/权限引擎，以及 `no-silent-catch` 静态扫描。
- **证据真值发布流水线。** `agent audit --strict` 要求文档真实性 **且** profile 需求 **且** 当前 HEAD 的执行证据（测试 + 基准，kind 严格匹配）。`agent release verify` 只从绑定发布 SHA 的真实门禁证据推导 READY；CI 证明 job 归约证据文件——绝无硬编码 PASS 表。
- **基准驱动演化。** `agent benchmark --candidate <id>` 让挑战者机制跑真实 harness；配对评估（逐 case 胜负/平）决定 promote 或 reject。第一轮评估拒绝了 4 个挑战者——champion 接线保持不变。

---

## 仓库结构

```
apps/cli        CLI：run、benchmark、audit、release verify、docs:verify、doctor、……
apps/web        Web 外壳（DSH harness web UI）
packages/       24 个 @ar/* 包
  contracts     共享类型、错误分类、恢复规划器
  core          AgentRuntime、SessionActor、上下文、验证、恢复
  security      规范路径、沙箱、进程门禁、注入/脱敏门禁
  sdk           流式优先客户端（RunEventHub、有界 PushChannel）
  gateway       内存 RPC + 协议传输一致性
  harness       组合根（createHarness）、内省、作用域解析
  model         OpenAI 兼容 provider（支持 deepseek 思考模式）
  evaluation    benchmark 运行器、配对评估、演化循环、champion 清单
  ...           agents、checkpoint、context、events、learning、mcp、memory、
                observability、orchestration、plugins、protocol、session、
                skills、store、store-integrity、tools
```

---

## 快速开始

环境要求：**Node ≥ 22**、**pnpm ≥ 9**（工作区固定 pnpm 11.21.0）。

```bash
pnpm install --frozen-lockfile   # 安装
pnpm typecheck                   # 全仓 tsc -b
pnpm test                        # 完整 vitest 套件
pnpm build                       # 构建所有包
```

### CLI 快速上手

```bash
node apps/cli/dist/main.js doctor        # 环境与存储接线报告
node apps/cli/dist/main.js run           # 运行一轮交互对话
node apps/cli/dist/main.js benchmark --suite adversarial --limit 1 --allow-stub   # 冒烟基准（无需 API key）
node apps/cli/dist/main.js audit --strict        # 能力审计（发布真值轴）
node apps/cli/dist/main.js release verify        # 从证据推导发布结论
node apps/cli/dist/main.js docs:verify           # 文档真实性检查
```

### 使用真实模型

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # 任意 OpenAI 兼容端点
export OPENAI_MODEL=gpt-4o-mini                     # 或 deepseek-v4-flash 等

node apps/cli/dist/main.js benchmark --suite adversarial --out .ci/bench
```

支持 `deepseek` 风格思考模型：`reasoning_content` 会从流中解析、持久化到助手消息，并在下一次请求中回传（API 要求）。

### Benchmark 挑战者

```bash
# champion 基线（全部候选关闭）
node apps/cli/dist/main.js benchmark --suite adversarial

# 每次只测一个挑战者机制
node apps/cli/dist/main.js benchmark --suite adversarial --candidate adaptive_recovery
node apps/cli/dist/main.js benchmark --suite adversarial --candidate memory_retrieval
node apps/cli/dist/main.js benchmark --suite adversarial --candidate tool_selector_deferred_schema
```

支持的候选：`adaptive_recovery`、`memory_retrieval`、`tool_selector_deferred_schema`、`adaptive_context_policy`、`context_pipeline_v5`、`memory_write_learning`、`independent_reviewer`、`delegation`、`adaptive_scheduler`。第一轮结果见 [`docs/evolution-decisions.md`](./docs/evolution-decisions.md)。

---

## 发布门禁

| 门禁 | 命令 | 校验内容 |
| --- | --- | --- |
| 类型检查 / 构建 | `pnpm typecheck` / `pnpm build` | `tsc -b` 零错误 |
| 测试 | `pnpm test` | 完整套件（248 文件，约 4800 测试） |
| 覆盖率 | `pnpm test:coverage` | 各包阈值 |
| 文档 | `pnpm docs:verify` | 文档真实性（含包数量完整性） |
| 协议 | `pnpm test:protocol` | 传输一致性 |
| 安全 | `pnpm test:security` | 沙箱 / 规范路径 / 进程门禁 / 回归矩阵 |
| 竞态 | `pnpm test:race` | 同会话竞态套件（无 sleep） |
| 混沌 | `pnpm test:chaos` | MCP 混沌 |
| 能力审计 | `pnpm capability:audit` | 严格审计（文档 + profile + 证据） |
| 发布验证 | `pnpm release:verify` | 仅当发布 SHA 上所有必需门禁通过时才 READY |

CI（GitHub Actions）运行 Linux + Windows 验证、覆盖率，以及一个 `release-attestation` 任务：归约各门禁证据文件并产出 `release-evidence-<sha>`（含 `releaseReady`）。

---

## 设计要点

- **单一规范化语义。** 所有文件系统包含性判断（沙箱、能力守卫、工作区管理器）都走 `canonicalizePath`——最深已存在祖先的 realpath + 词法尾部解析；非 ENOENT 错误以类型化的 `CanonicalizationFailed` fail-closed。
- **绝不静默失败。** `no-silent-catch` 扫描空/仅注释 catch 块；降级路径必须输出可观测信息。
- **确定性并发测试。** 竞态测试使用门控假件与 entered 信号，绝不用 `setTimeout` 去"赌"某条路径已开始；最大并发直接测量。
- **单一交接真值。** 交接状态由代码 + CI 承载；`docs/evolution-decisions.md` 记录基准驱动演化的裁决。

架构细节见 [`docs/architecture/`](./docs/architecture/)（session-actor、runtime-scopes、tool-snapshot、orchestration、durability、mcp-runtime、app-server、release-integrity）。

---

## 状态

P35 → P38 收尾已完成且 CI 全绿（`typecheck/test/coverage/docs/protocol/security/race/chaos/capability-audit/release-verify` 全部 PASS，attestation READY）。架构收尾工作已停止；后续改动需要基准或生产证据支持。

收尾计划见 `plan.md`，公开迁移说明见 `docs/migration.md`，演化循环见 `docs/evolution-decisions.md`。
