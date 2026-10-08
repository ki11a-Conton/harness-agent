# 第一代会话、上下文与持续工作对比

范围：2026-10-08 工作区源码审查；第一代基线 `22d97d8`。这是工程能力与正确性审查，不是不同模型成功率的比较。源码指纹保存在 `docs/gen1-session-source-manifest.json`。

## 实际参考源码

| 项目及许可 | 阅读的源码 | 值得复用的具体设计 |
| --- | --- | --- |
| pi，MIT，Mario Zechner | `pi-main/packages/coding-agent/src/core/session-manager.ts`，`core/skills.ts`，`core/resource-loader.ts` | 独立会话 ID、持久会话继续、消息树分支、压缩感知的模型历史；技能先展示元数据，再按需读取正文；默认技能目录与同名冲突提示 |
| Codex，Apache-2.0 | `codex-main/codex-rs/core/src/session/rollout_reconstruction.rs`，`agents_md.rs`，`skills.rs` | 恢复模型历史时一起恢复设置与世界快照；严格区分用户轮次边界和上下文事件；沿项目根到 cwd 读取 AGENTS，并支持本地 override |
| Hermes，MIT，Nous Research | `hermes-agent-main/hermes_state.py`，`agent/memory_manager.py`，`agent/native_compaction.py` | 持久会话与父子谱系；模型历史与显示历史分别投影；恢复行数上限；记忆统一接入、预取/同步超时与关闭时限 |
| DeepSeek Harness，MIT，DeepSeek | `packages/core/session/src/index.ts`，`src/fork.ts`，`packages/compaction/compaction/src/tool-pairing.ts` | 明确的 fork 截断边界、继承前缀、未闭合轮次处理；从权威事件还原显示；历史数据与新工具执行分开 |

本轮会话实现复用 Harness 已有 Runtime、SessionStore、LoadedSessionManager、协议校验和事件投影；上游提供设计与验收反例。没有直接复制上述完整会话 Runtime。此前提示词与本轮其他纯工具算法的实际移植、许可证由各自来源说明记录。工作区 Claude Code 目录标注为泄漏材料且无可用许可证，本轮会话实现未采用。

## 本项目已有的能力

| 能力 | 真实生产入口 | 默认条件与限制 |
| --- | --- | --- |
| 会话持久化、消息历史、turn 状态 | `createHarness({dataDir})`；JSONLSessionStore，或 `dataStore: "sqlite"` 的 SqliteRuntimeStore | 无 dataDir 时为内存运行；JSONL 声明单写进程，不是多进程数据库 |
| 多轮、steer、followup、取消和中断 | `harness.sessions.load(id)` 的 SessionActor；内部 `session.send/run/steer/followup/interrupt` RPC | 每个 session 一个活动 turn；队列/恢复身份由已有 durable inbox 管理 |
| 检查点与断点恢复 | `AgentRuntime.resumeTurn()`；DurableCheckpointStore、DurableRecoveryStore | 记录已完成副作用、未确认工具及消耗的预算；不会自动重做未知命令；需要有效持久检查点 |
| AGENTS 与上下文预算 | `composeContext()`；EffectiveInstructionContextPipeline、可显式配置的 PathScopedContextPipeline | 默认 discovery 只识别 AGENTS.md；路径作用域策略是显式 challenger；不能声称支持所有参考项目的 override/CLAUDE 兼容目录 |
| 技能元数据/正文分层、来源检查 | FileSkillLoader、skillSelector、createSkillBodyBlockProvider、SkillSnapshot | 目录由 `AR_SKILL_ROOTS` 显式指定，用分号分隔；正文加载依赖 skills 功能及 dataDir；拒绝的正文不能借技能列表绕过 |
| 记忆、预取、反馈、学习候选 | MemoryRuntimeBridge、JsonlMemoryStore/SqliteMemoryStore、PostTurnReflector | memory 默认关闭；CLI 可用 `HARNESS_MEMORY=1`；数据按 repository/workspace 身份隔离；候选晋升仍需原流程 |
| 子智能体与隔离写工作区 | composeDelegators、Delegator/ParallelDelegator、DefaultChildWorkspaceManager | delegation 默认关闭；显式启用后受工具/权限/树预算限制；已有机制未在本轮重新实现 |

## 本轮修复与验收

| 缺陷与最小触发 | 修复 | 验收 |
| --- | --- | --- |
| 调用公开 `sessionService.create()`，再 load/startTurn：只有 P27 状态而无 effectiveAgent，模型请求前失败 | Harness 注入 Runtime 创建回调，使公开入口也持久保存有效的冻结策略 | 真实 Harness/Actor/model 请求完成，快照存在 effectiveAgent |
| `thread/resume({threadId})` 被映射为新建；`thread/start.resumeThreadId` 未生效 | 映射到内部 session.resume，并走同一个配置冻结加载门；不同 agent/cwd 不能覆盖 | 同 ID 恢复；未知/缺失 ID 不创建会话；冻结策略变化返回 CONFIG_DRIFT_REJECTED |
| `thread/fork` 忽略源 threadId；已有 service fork 没有冻结父策略且复制 live prompt/ask/turn ID | 显式源 ID、保留父 effectiveAgent/runtimePolicy/P27 冻结字段；副本消息使用新 ID，移除 live lineage | 新分支保留历史；父/子后续消息独立；真实写工具执行仍受父 denial，审批保留在父会话 |
| 初始 busy 检查后新父 turn 开始/完成，可能截到半个工具协议 | 取消息快照后再检查未结束 turn，并使用已有 assertWireProtocol 检查快照；校验发生在创建分支前 | 新 turn admission 的确定性交错拒绝 SESSION_BUSY；未闭合 assistant/tool 对拒绝且不创建分支 |
| 策略写入或 fork 复制 I/O 失败，残留 active 的未完成会话 | 先用既有 failed 状态保存不可运行记录，冻结/复制/显示证据写入完成才激活 | failpoint 下 startTurn 被拒绝；不经 legacy fallback 扩大权限；不完整分支不能继续派生 |
| copied MessageStore 有历史，但 branch 的 `thread/read` 和 itemCount 为零 | host hook 写入惰性历史显示的 session.forked 事件；用户/答案可见，历史工具结果明确标为未在分支执行 | 真 SDK 的 branch.read 有源用户消息；没有复制 live approval 或伪造 model/tool 执行事件 |
| `thread/list`、`thread/loaded/list` 错误返回 agent 列表，SDK 预期 threads DTO | 正确列出持久/已加载会话；返回 ThreadInfo，SDK 时间类型对齐协议 | 真 SDK/AppServer 的加载、卸载、关闭重开、存储会话找回均通过 |
| 同 key 并发重试创建两个会话，跨方法 key 错误共享返回值 | AppServer 对连接内 method+key 合并 in-flight 请求，再记录成功结果 | 并发重试只有一个创建；相同字符串 key 的 fork 与 start 各执行一次 |
| 实际 model.completed 没有答案 text/final；实际文本流不发 model.delta；turn.failed 使用嵌套 error 而 mapper 读取扁平字段 | 同轮 model scope 补实际答案/文本事件；mapper 映射真实用户消息、真实错误与可用 usage，不暴露 reasoning | 真实 SDK finalResponse 等于模型答案；partial text 后失败仍 failed、无 fake final；错误 code/message/retryable 保留；私有 thinking 不进入显示流 |

SDK 增加 `resumeThread(id)`、`forkThread(id, {idempotencyKey})`、`listStoredThreads()`；`listThreads()` 保留列举已加载会话的含义。fork 是已结束会话历史的分支；活动 turn 先完成或中断。它继承原 agent/cwd，不承担 pi 的跨项目迁移、任意叶节点回退或文件系统快照。

## 证据与命令

回归源码：`packages/harness/src/session-service-coding.regressions.test.ts`、`packages/gateway/src/gateway.test.ts` 的 GEN1 项、`packages/sdk/src/gen1-session-integration.test.ts`。

本阶段最终相关组：26 个测试文件、287 项通过、0 失败。原始 Vitest JSON 放在 `.ci/gen1-session/`：最早公开路径 RED、并发幂等 RED、初始化/fork 完整性 RED、真实 SDK 接线 RED、最终 GREEN 分开保留；它们属于对应中间工作树状态。发布的固定源码验收由主交付流程另行记录，不以本阶段局部结果替代。

```bash
pnpm exec vitest run packages/session packages/harness/src/session-service-coding.regressions.test.ts packages/harness/src/config-wiring.test.ts packages/harness/src/config-drift-matrix.test.ts packages/harness/src/coding-prompt-policy.test.ts packages/core/src/runtime/effective-config.test.ts packages/core/src/runtime/resume.test.ts packages/gateway packages/protocol packages/sdk
pnpm typecheck
```

## 仍未覆盖的差距

- pi 的完整消息树、任意节点分支、分支摘要和跨项目 fork；Codex 的 rollback/远程世界快照；DeepSeek 的任意事件边界 fork 尚未移植。第一代分支严格使用完成且协议有效的历史。
- 项目文档 discovery 的默认语义与 Codex 不完全一致；AGENTS.override.md、全量 CLAUDE.md 兼容目录和 pi 默认技能目录需要单独的有界策略方案。现在使用本项目已有 AGENTS 与显式 skill roots。
- Hermes 的全部外部记忆供应商、统一用户画像同步、超大历史分页和外部记忆回收不属于已交付默认功能。当前本地记忆仍遵守 repository/workspace 所属边界。
- 通用自定义 provider 的可变内部计数器可能参与 P27 指纹，导致复用同一 stateful ModelProvider 对象重建 Harness 后误判 drift；精确复现在 `.ci/gen1-session/stateful-provider-restart.json`，交主审查继续处理。常规恢复测试使用按相同配置重建的 provider，未为通过测试放松未知 provider 的身份冻结门。
- 没有真实付费模型对比时，上述工程与离线脚本模型验收不能证明编码成功率、长任务决策质量或参考 agent 的所有优势已经等价。
