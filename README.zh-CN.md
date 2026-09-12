# Harness Agent（智能体运行时）

一个 TypeScript **智能体运行时**：**会话单一所有者**（SessionActor）、**实时流式 SDK**、**纵深安全门禁**，以及**基准驱动的机制演化**。

基于 pnpm workspace 单体仓库：`packages/` 下 **24 个 `@ar/*` 包**，外加 `apps/cli` 与 `apps/web`。

> [English](./README.md) · 中文

---

## 目录

- [这个仓库是什么](#这个仓库是什么)
- [核心亮点](#核心亮点)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [CLI 快速上手](#cli-快速上手)
- [使用真实模型](#使用真实模型)
- [Benchmark 挑战者](#benchmark-挑战者)
- [发布门禁](#发布门禁)
- [CI 流水线](#ci-流水线)
- [设计要点](#设计要点)
- [架构文档](#架构文档)
- [状态：已完成 / 进行中 / 未完成](#状态已完成--进行中--未完成)
- [验证真值与诚实政策](#验证真值与诚实政策)

---

## 这个仓库是什么

本仓库既是**运行时**（会话 actor + 编排 + 工具 + 安全），也是**评估平台**
（benchmark、配对评估、晋升信封、发布证明）。运行时架构已 **FROZEN**：P38.4 冻结之后的
改动必须属于以下某一类才被允许——可复现的正确性缺陷、安全漏洞、发布完整性缺陷、
被证明源自 Harness 基础设施而非模型/策略的 benchmark 失败、或可归因于运行时的测得性能
回归。

一切会影响实验实际行为的内容都被折叠进一份**规范的、内容寻址的执行计划**
（executionPlan：套件、用例集合 + 每用例输入指纹、限额、隔离姿态、晋升资格、
provider/model 身份、judge 版本、源码快照、预登记决策策略）。晋升级证据必须携带完整
计划、完整样本网格与完成标记。注意：**字段内部一致仍可能是语义上不可能的组合**
（例如 `insecure-local` 隔离却声明 `promotionEligible=true`），因此资格由
evaluator / writer / promotion loader 三处共享的**语义校验器**强制执行，字段一致本身
不等于合法。

## 核心亮点

- **SessionActor —— 每个会话只有一个所有者。** 通过统一的状态机
  （`idle → starting → running → closing`）保证 `activeTurn ∈ {0,1}`。跟进队列、
  steer、中断、取消与卸载共享同一条可线性化的准入路径；持久化跟进只有在 turn 创建
  成功后才标记消费。
- **LoadedSessionManager —— 代数（generation）围栏。** 旧的在途加载在
  unload/close 之后永远无法"复活"，也无法删除新代次的单飞（single-flight）条目。
- **流式优先 SDK。** `runStreamed()` 先订阅再调用 `turn/run`，并在终端完成之前返回。
  所有终态路径（事件、abort、transport EOF、缓冲溢出、invoke 错误）**恰好结算一次**
  并释放全部运行期监听器；事件通道有界（4096 条），流失败是错误，绝不会伪装成正常 EOF。
- **纵深安全。** 规范路径包含性检查（EACCES/EPERM/ELOOP/EIO/深度一律 fail-closed）、
  带 shell 组合检测的沙箱执行、工具输出的 prompt 注入检测、敏感信息脱敏、审批/权限引擎，
  以及 `no-silent-catch` 静态扫描。
- **证据真值发布流水线。** `agent audit --strict` 要求文档真实性 **且** profile 需求
  **且** 当前 HEAD 的执行证据（测试 + 基准，kind 严格匹配）。`agent release verify`
  只从绑定发布 SHA 的真实门禁证据推导 READY；CI 证明 job 归约证据文件——绝无硬编码
  PASS 表。
- **基准驱动演化。** `agent benchmark --candidate <id>` 让挑战者机制跑真实 harness；
  配对评估（逐 case 胜负/平）决定 promote 或 reject。第一轮演化循环拒绝了全部 4 个
  挑战者——champion 接线保持不变（见
  [`docs/evolution-decisions.md`](./docs/evolution-decisions.md)）。

## 仓库结构

```
apps/cli        CLI：run、benchmark、audit、release verify/gate、docs:verify、doctor、……
apps/web        Web 外壳（DSH harness web UI）
packages/       24 个 @ar/* 包
  agents        智能体层机制（自适应策略、委派）
  checkpoint    可恢复运行的确定性检查点
  context       上下文窗口 / 预算感知的上下文管理
  contracts     共享类型、错误分类、恢复规划器合约
  core          AgentRuntime、SessionActor、上下文、验证、恢复
  evaluation    benchmark 运行器、配对评估、执行计划协议、晋升信封、
                演化循环、champion 清单、门禁证据（V2）
  events        类型化运行时事件定义
  gateway       内存 RPC + 协议传输一致性
  harness       组合根（createHarness）、内省、作用域解析
  learning      机制学习/反馈循环
  mcp           Model Context Protocol 服务端/客户端 + 混沌测试
  memory        工作记忆工具
  model         OpenAI 兼容 provider（支持 deepseek 思考模式）
  observability 日志 / 追踪工具
  orchestration ToolOrchestrator：所有副作用都流经这里
  plugins       插件系统边界
  protocol      线协议定义
  sdk           流式优先客户端（RunEventHub、有界 PushChannel）
  security      规范路径、沙箱、进程门禁、注入/脱敏门禁、no-silent-catch 静态扫描
  session       会话准入 / 生命周期辅助
  skills        技能注册表 / 机制技能
  store         存储抽象（durable store、recovery store）
  store-integrity  存储完整性验证
  tools         生产工具集（沙箱执行器、进程约束）
```

架构契约：**Core 不得依赖 UI、provider、业务插件或外部集成；所有副作用必须经过
ToolOrchestrator，并受 PermissionEngine 与 SandboxManager 约束。**

## 快速开始

环境要求：**Node ≥ 22**、**pnpm ≥ 9**（工作区固定 pnpm 11.21.0）。

```bash
pnpm install --frozen-lockfile   # 安装（CI 使用 frozen lockfile）
pnpm typecheck                   # 全仓 tsc -b
pnpm test                        # 完整 vitest 套件（单元 + 集成）
pnpm build                       # 构建所有包
```

完整套件即默认的 `pnpm test`。专项门禁：

```bash
pnpm test:coverage               # 各包覆盖率阈值（CI 门禁）
pnpm test:protocol               # 传输一致性
pnpm test:security               # 沙箱 / 规范路径 / 进程门禁
pnpm test:race                   # 同会话竞态套件（无 sleep）
pnpm test:chaos                  # MCP 混沌
pnpm docs:verify                 # 机器可推导的文档真实性
pnpm capability:audit            # 严格能力审计
pnpm release:verify              # 从证据推导发布结论
pnpm release:gate <gate>         # 运行单个门禁并写 V2 证据
```

## CLI 快速上手

```bash
node apps/cli/dist/main.js doctor                      # 环境与存储接线报告
node apps/cli/dist/main.js run                         # 运行一轮交互对话
node apps/cli/dist/main.js benchmark --suite adversarial --limit 1 --allow-stub  # 冒烟（无需 API key）
node apps/cli/dist/main.js benchmark --suite adversarial --dry-run    # 计划摘要（0 次 provider 调用）
node apps/cli/dist/main.js audit --strict              # 能力审计（发布真值轴）
node apps/cli/dist/main.js usage-audit --run <id> --strict   # E4-R24 具名运行观察审计
node apps/cli/dist/main.js release verify              # 从真实证据推导发布结论
node apps/cli/dist/main.js release gate <gate>         # 单个门禁 + 持久化 V2 证据
node apps/cli/dist/main.js docs:verify                 # 文档真实性检查
```

## 使用真实模型

付费运行必须先 **dry-run** 拿到规范计划摘要，然后确认**完全一致**的计划（摘要 + 明确
支出上限）——`benchmark` 对计费 provider 两者缺一即拒绝（E4-01）。设置
`RUN_PAID_BENCHMARKS=1` 授权付费运行；仅有 API key **不是**授权。

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # 任意 OpenAI 兼容端点
export OPENAI_MODEL=gpt-4o-mini                     # 或 deepseek-v4-flash 等

# 1) dry-run —— 打印规范 e4-01 计划 + planDigest（0 次 provider 调用，离线）
node apps/cli/dist/main.js benchmark --suite adversarial --dry-run

# 2) 确认 EXACT 计划并在运行前设支出上限
node apps/cli/dist/main.js benchmark --suite adversarial \
  --max-model-calls 800 \
  --plan-digest <planDigest from the dry-run output> \
  --out .ci/bench
```

支持 `deepseek` 风格思考模型：`reasoning_content` 会从流中解析、持久化到助手消息，
并在下一次请求中回传（API 要求）。

晋升级运行还额外要求**强隔离后端**（OS 级约束；例如 Linux 的 bwrap）、**可证明干净
的源码树**以及具名挑战者。不安全本地执行可通过显式 `--allow-insecure-local-benchmark`
启用，且**永不晋升**。

## Benchmark 挑战者

```bash
# champion 基线（全部候选关闭）
node apps/cli/dist/main.js benchmark --suite adversarial

# 每次只测一个挑战者机制
node apps/cli/dist/main.js benchmark --suite adversarial --candidate adaptive_recovery
node apps/cli/dist/main.js benchmark --suite adversarial --candidate memory_retrieval
node apps/cli/dist/main.js benchmark --suite adversarial --candidate tool_selector_deferred_schema
```

支持的候选：`adaptive_recovery`、`memory_retrieval`、
`tool_selector_deferred_schema`、`adaptive_context_policy`、`context_pipeline_v5`、
`memory_write_learning`、`independent_reviewer`、`delegation`、`adaptive_scheduler`。
第一轮结果见 [`docs/evolution-decisions.md`](./docs/evolution-decisions.md)
（全部挑战者被拒；champion 保留）。

## 发布门禁

| 门禁 | 命令 | 校验内容 |
| --- | --- | --- |
| 类型检查 / 构建 | `pnpm typecheck` / `pnpm build` | `tsc -b` 零错误 |
| 测试 | `pnpm test` | 完整套件（文件/测试数随代码树变化——以 CI `verify` job 输出为准） |
| 覆盖率 | `pnpm test:coverage` | 各包阈值（阈值不达标 = job 红） |
| 文档 | `pnpm docs:verify` | 文档真实性（benchmark 计数、包数量、计划入口、演化台账、能力矩阵） |
| 协议 | `pnpm test:protocol` | 传输一致性 |
| 安全 | `pnpm test:security` | 沙箱 / 规范路径 / 进程门禁 / 回归矩阵 |
| 竞态 | `pnpm test:race` | 同会话竞态套件（无 sleep） |
| 混沌 | `pnpm test:chaos` | MCP 混沌 |
| 能力审计 | `pnpm capability:audit` | 严格审计（文档 + profile + 证据） |
| 使用审计 | `node apps/cli/dist/main.js usage-audit --run <id> --strict` | 独立具名运行观察审计（E4-R24） |
| 发布验证 | `pnpm release:verify` | 仅当发布 SHA 上所有必需门禁通过时才 READY |

每个门禁还产出**持久化 V2 证据**（`release gate <gate> --evidence-dir ...`）——真实
命令、真实退出码、前后 git 状态、摘要与有界失败摘要，全部内容寻址（R12）。

## CI 流水线

GitHub Actions（`.github/workflows/ci.yml`）：

- **verify** 矩阵，**ubuntu-latest 与 windows-latest**：install → typecheck →
  test（日志 tee 保存）→ build → 具名观察运行的严格 usage 审计 → benchmark 冒烟
  （stub provider，无付费模型）→ 每 OS 9 个门禁的证据生成（P38.2-4/10，统一 V2）。
- **coverage**（ubuntu）：`pnpm test:coverage`（阈值不达标即红）+ coverage 门禁证据。
- **release-attestation**（依赖 verify + coverage）：按平台下载门禁证据、校验 SHA/argv、
  用 `pnpm release:verify` 推导结论并写 `release-attestation.json`
  （`runtimeReleaseReady` + `championPromotion.status`）。结论不是 READY 时 job 失败——
  无硬编码 PASS 表（P38-12，INV-P38.3-007）。

## 设计要点

- **单一规范化语义。** 所有文件系统包含性判断（沙箱、能力守卫、工作区管理器）都走
  `canonicalizePath`——最深已存在祖先的 realpath + 词法尾部解析；非 ENOENT 错误以
  类型化的 `CanonicalizationFailed` fail-closed。
- **绝不静默失败。** `no-silent-catch` 扫描空/仅注释 catch 块；降级路径必须输出可观测信息。
- **确定性并发测试。** 竞态测试使用门控假件与 entered 信号，绝不用 `setTimeout` 去"赌"
  某条路径已开始；最大并发直接测量。
- **单一交接真值。** 交接状态由代码 + CI 承载；`docs/evolution-decisions.md` 记录
  基准驱动演化的裁决。
- **单一计划入口。** `plan.md` 是唯一当前计划入口；`docs:verify` 强制它引用真实存在的
  计划文件（E4-00）。
- **诚实的 NOT_RUN。** 未运行的门禁记录为 NOT_RUN——`runtimeReleaseReady` 绝不用旧 run
  伪造；付费真实模型 champion 质量（`championPromotion`）在真正付费测量前保持 NOT_RUN。

架构细节见 [`docs/architecture/`](./docs/architecture/)（session-actor、
runtime-scopes、tool-snapshot、orchestration、durability、mcp-runtime、
app-server、release-integrity）。

## 状态：已完成 / 进行中 / 未完成

### 已完成（已推送 origin/main，其 SHA 的 CI 全绿）

- **P35 → P38 收尾** —— `typecheck/test/coverage/docs/protocol/security/race/chaos/
  capability-audit/release-verify` 全部 PASS，attestation READY
  （见 `docs/E4-00…E4-11`、`docs/E4-R01…R11`）。
- **E4-R12 … E4-R20**（2026-09-10 计划）—— 报告链
  `docs/E4-R12-report.md` … `docs/E4-R20-report.md`；CI run 34548502173（bcf34b7）
  四 job 全绿，`runtimeReleaseReady=true`。
- **E4-R21 … E4-R26**（2026-09-11 计划）—— `docs/E4-R21-report.md` …
  `docs/E4-R26-report.md`；origin/main CI run #112（2b2d3db）四 job 全绿，
  strict usage-audit 两平台 success，release attestation READY=true。
- **E4-R27 … E4-R31**（2026-09-11 计划）—— `docs/E4-R27-report.md` …
  `docs/E4-R31-report.md`；**已推送 origin/main 并在其 SHA 的 CI 全绿**（四 job：
  Ubuntu 主门禁、Windows 主门禁、Ubuntu coverage、release attestation）。该批次关闭了
  G01（晋升隔离资格）、G02（执行计划字段/规模约束）、G03（原始字节源码指纹）、
  G04（恢复存储有限唤醒）与独立收口。

### E4-R32 … E4-R35（2026-09-12 计划）—— 已推送 origin/main，其 SHA 的 CI 全绿

- **E4-R32**（H01/H02 恢复存储组合故障 + intent 退避）——
  [`docs/E4-R32-report.md`](./docs/E4-R32-report.md)：lease 清理改为尽力而为，不再中断
  有界重检；恢复读取入口 fail-closed 且保留有限唤醒；退避计数仅在本轮严格持久化
  （lease + intent）成功后重置，使持续的 intent 写故障真正递增退避。
  `recovery-durable.test.ts` 23/23。
- **E4-R33**（H03 execution-plan 规模校验先于危险操作）——
  [`docs/E4-R33-report.md`](./docs/E4-R33-report.md)：`parseExecutionPlan` 不再用实参展开
  （此前 ~13 万 case、仍在文档上限内的计划会抛 `RangeError`），改用 `Set` 做成员查询
  （消除二次方），并在任何逐 case 遍历之前校验网格规模/容量合同。
  `e4-r33-execution-plan-scale.test.ts` 7/7。
- **E4-R34**（H04 隔离故意失败的测试夹具）——
  [`docs/E4-R34-report.md`](./docs/E4-R34-report.md)：final-result 协议夹具移出根 vitest
  `include`，改放 `apps/cli/test-infra/observation-fixtures/`，并以专用子进程配置保留生产
  reporter；残留夹具不再被下一次全量运行收集。`e4-r24-final-result-protocol.test.ts` 4/4。
- **E4-R35**（提交后状态更新 + 最终验收收口）——
  [`docs/E4-R35-report.md`](./docs/E4-R35-report.md)：关闭矩阵、干净树全仓门禁与远端 CI
  只读核实，汇总见 `docs/E4-STATUS.md`。

### E4-R36 … E4-R39（2026-09-12 计划）—— 已实现、已推送，正在收口状态

- **E4-R36**（J01 首次恢复发现必须可重扫）——
  [`docs/E4-R36-report.md`](./docs/E4-R36-report.md)：`_recoverableChecked` 的语义改为
  「一次恢复发现已**完整成功**」，而非「曾经开始扫描」。首次扫描的暂时读取故障过去会
  逃逸出 drain **并**永久标记发现完成（无 timer、不重扫、promoted prompt 滞留在无 owner 的
  turn 上）；现在扫描**原子提交**（部分扫描不入队任何东西），失败则 fail-closed 并保留
  有界自愈唤醒。`recovery-durable.test.ts` 29/29（新增 6 例在修复前全部失败）。
- **E4-R37**（J02 升级后的工作区不得收集旧代夹具）——
  [`docs/E4-R37-report.md`](./docs/E4-R37-report.md)：`.gitignore` 不是 Vitest 的 exclude。
  根配置现在按生成文件名模式结构性排除 `apps/cli/src/e4-r24-fixture-*.test.ts`
  （用 `configDefaults.exclude` 保留框架默认值），残留的故意失败夹具再也不可能进入正式
  运行——无需用户手工清理。`e4-r24-final-result-protocol.test.ts` 5/5。
- **E4-R38**（J03 有效正例 + promotion-loader 边界）——
  [`docs/E4-R38-report.md`](./docs/E4-R38-report.md)：**验收补强，无生产改动**。完整交叉绑定的
  基准对（真实 `computeExecutionPlanDigest`、真实身份/策略/网格/证据绑定）达到真实 `ACCEPT`
  与真实 `loader.ok=true`；超限负例由同一基准只改 `repeat` 派生，被 evaluator（恰好一条校准过的
  容量违规）与 promotion loader 双双拒绝。`e4-r38-execution-plan-boundary.test.ts` 3/3。
- **E4-R39**（状态同步 + 最终门禁）—— ⚠️ **PARTIAL** ——
  [`docs/E4-R39-report.md`](./docs/E4-R39-report.md)：J01…J04 关闭矩阵、在冻结的干净版本
  （`01c4ec74`）上实测的门禁、以及本轮**自身 SHA** 的远端 CI 只读核实。已绿：
  `pnpm typecheck`（0）、`pnpm docs:verify`（ALL CHECKS PASS）、`test:race` 23、
  `test:security` 2133、`test:protocol` 52、`test:chaos` 12。**未绿：全仓 `pnpm test`** ——
  318 文件 / `1 failed | 5738 passed | 1 skipped (5740)`，3 次运行都是同一处失败
  （`e4-09-production-e2e.test.ts` → `buildRealChain` 把有效链判为 `INVALID`），而该文件
  隔离运行 5/5 通过（4 次）、`apps/cli/src` 整目录 2/2 通过。根因**未定**；两个假设
  （CPU 负载、瞬时脏树）经实验**被证伪**。`01c4ec74` 的 Windows CI job（run
  `34687657690`）两次尝试也都失败，且失败用例集每次不同；**只改文档、代码完全相同的**
  `2db1a9cd`（run `34689110496`）四 job 全绿 ⇒ 该 Windows 失败是**波动**而非版本确定性结论，
  但 `01c4ec74` 自身的事实结论仍是 failure。

### 未完成 / NOT_RUN（详情见 [HANDOVER.md](./HANDOVER.md)）

- **冻结版本上的全仓 `pnpm test` 未绿** —— 上述 `e4-09` 有效链判 `INVALID`，以及本轮 SHA 的
  Windows CI 主门禁失败。两者都按真实缺口记录，证据在案，**不**以「夹具残留」解释掉。
- **真实模型 champion 质量**：`championPromotion.status=NOT_RUN` —— 未请求付费真实模型
  benchmark；不伪称就绪。
- **release 发布动作**：各轮计划只到 attestation，不做自动发布。

未完成任务的权威、机器可查清单在 [`HANDOVER.md`](./HANDOVER.md)；`plan.md` 指向当前
计划文件。

## 验证真值与诚实政策

- **PASS 需要逐条验收证据**；未运行写 NOT_RUN；部分完成写 PARTIAL；已有修复只有在
  验证后才写 NOT_NEEDED。
- **绝不伪造就绪。** `runtimeReleaseReady` 来自真实 exact-SHA CI attestation；
  `championPromotion` 在真正运行付费真实模型 benchmark 前保持 NOT_RUN。
- **不降低阈值、不删除失败用例、不手改 ACCEPT** 以强行凑证据。
- 每份报告记录被测 SHA、复现前后、实现符号、测试命令/退出码与残余限制。

当前计划见 `plan.md`，公开迁移说明见 `docs/migration.md`，演化循环见
`docs/evolution-decisions.md`。