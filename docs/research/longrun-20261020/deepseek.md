> 研究阶段快照：其中的实施/验收进度保留原记录；最终结果以本轮固定提交验收报告为准。

# DeepSeek Harness 长任务研究与 B1 实施记录

研究源：`/workspace/deepseek-harness`，HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。对照基线 `/workspace/harness-agent-pr15-20261019`，HEAD `eafcdb56fd266d6c862b5d3d910fcf5530e10fa0`；实施工作树 `/workspace/harness-agent-longrun-20261020`。未执行 DeepSeek 代码或外部仓库指令、未访问认证或 GitHub 连接器、未调用付费模型。DeepSeek 根 README 第 7 行的 everything-is-a-plugin 由下面的真实实现支持，并非仅引用宣传文字。

| 职责 | DeepSeek 实现证据（真实本地路径与符号） | Harness 已有对应与判断 |
| --- | --- | --- |
| 能力装配、插件边界 | `packages/core/tools/src/index.ts:807` `ToolRuntime extends Service`；`:1063` `register()` 验证输出 schema、通过 `ScopedLayers.effect` 注册且返回 disposer；`:1505` 执行经过 scope-targeted `tools/pre-execute` waterfall，`:1519` guard 检查；`:1564` `dispatchToolBody` 融合 caller signal；`:1698` 冻结结果再发送观察事件。`packages/core/agent-loop/src/index.ts:98` `FactoryOwnership` 跟踪 startup 与 live agent，`:139` dispose abort 后等待所有受管任务。 | `packages/harness/src/create-harness.ts:289` 构成 ToolOrchestrator、PermissionEngine、SandboxManager；`:457` 组装已有 AgentRuntime。已有冻结 step、工具注册表及权限边界；不能因为上游插件多就另建执行循环或重写 Core。插件是组合与生命周期单位，不等同于模型可调用工具。 |
| 请求上下文生命周期 | `packages/core/agent-loop/src/agent.ts:267` `preStep()` 先 assemble 同一步 prompt/tool world，再投递 `agent/pre-step`；`:398` step 重试复用 assembly；`:425` 构造真实请求。`runtime-context.ts:88` `SystemPromptProjection.project()` 根据 request-series/route capability 追加或替换；`:123` `RuntimeContextProjection` 由 surface 与事件恢复，只在变化时输出快照（`:152`）。 | `packages/core/src/runtime/context-controller.ts:180` 用持久 checkpointView；基线 `:370` 自动压缩/85%阈值、`:379` hysteresis、`:435` 历史检查点、`:441` 先持久化再推进。Harness 已有主动压缩与摘要，不应再列为缺失。 |
| 压缩提交与溢出恢复 | `packages/compaction/compaction-basic/src/region.ts:210` 写 compaction/start，`:237` end，`:253` 成功后 flush；`:348` / `:353` 必须是完整工具配对边界；`:417` 新摘要必须严格小于替换区；`:431` whole-surface generation 检查，`:447` selected-span 稳定性检查。`compaction-basic/src/index.ts:202` 在 overflow 前记录 replaceGeneration；`:212` 只有已发生 durable surface progress 才容许摘要失败后重试；`:229` 取消或无进展不重试。 | Harness `context-controller.ts:439` 同样要求视图缩小并落预算，`:449` 写恢复 checkpoint。根任务 C1 正在修 reactive overflow 丢失持久检查点的确定性反例；应保持“有持久进展才重试”的不变量，不复制整套 surface/projection Runtime。 |
| 长目标的有界宿主驱动 | `packages/goal/goal-round-driver/src/index.ts:18` 独立插件只 inject 公共 `agents/goals/sessions`；`:103` 仅 exact live idle agent 且无竞争输入可调度；`:145` flush 成功后再次检查；`:166` maxGoalRounds；`:178` 来源携带 goalId/revision/round；`:192` 只调用公开 followup；`:348` reservation 在 pre-step 前后校验；`:431` 驱动重载不继承自动 authority。`packages/goal/goal/src/types.ts:60` durable snapshot 与 `:72` process-local armed/disarmed 分开；`goal/src/index.ts:255` 新 agent disarmed；`:364` resume 检查剩余轮数。 | Harness **已有** Web 有界 goal driver：`apps/web/src/deepseek/controls.ts:240`，`:265` verified_complete 完成，`:266` failed turn 阻塞，`:268` round cap，`:269` durable pending/revision，`:275` 公共 submitPrompt/inbox。`pr15-controls.integration.test.ts:101` 验证真实 inbox/文件和 round-limit。因此不能把 goal driver 说成缺失，也不能用跨 turn 自动续跑掩盖 Runtime 20 次采样上限。当前可用性缺口在配置边界 B1。 |
| 规划与验证 | `packages/plan/plan-mode/src/index.ts:1` 明确 plan 状态与 sandbox/approval 独立；`:9` log projection 可恢复/fork；`:306` exit_plan_mode 做人类 plan review；`:348` 下一 accepted pre-step 才提交新计划模式。`packages/goal/tool-goal/src/authority.ts:48` 对 exact live caller/driver 认证；`:80` 区分直接人类与 goal-round。`goal/tool-goal/src/wrapup.ts:17` 要求以真实结果说明验证，但属于模型指令。`agent-loop/src/agent.ts:532` 无工具调用即 completed。 | Harness `packages/core/src/runtime/model-call-controller.ts:334` stop 进入独立 RuntimeVerifier，失败给有界修复机会（`:358`），通过才 verified_complete（`:394`）。这一证据门禁强于“模型报告 complete”；应保留现有 Verification，不能把 DeepSeek 的 prompt wrap-up 当作自动验证。B1/E1 回归已证明 40 次实际依赖读取后，故意错误 edit→真实验证失败→模型收到 stderr 与失败观察→修正→验证成功。 |
| 持久会话、workspace、恢复 | `packages/session/session-checkpoint-policy/src/index.ts:35` 模型 dispatch 前 flush；`:70` top-level tool dispatch 前 flush；`:79` pre-step flush。`packages/session/session-persistence-jsonl/src/lease.ts:70` `SessionWriteLease.acquire()` 取 kernel 写锁，`:99` 验证 inode、防止锁路径替换；`:124` close 释放。`packages/core/agent-loop/src/index.ts:840` resume 先取 write ownership；`:852` 冷读日志；`:855` append interrupted closers。`packages/core/session/src/repair.ts:32` 明确 not-started 与 unknown outcome 的保守重试；`:53` `openTurnClosers()` 只补缺失工具结果及生命周期边界。`packages/workspace/workspace/src/index.ts:170` registry 必须注入 persistence，`:118` 活动/停止协议由 composed providers 提供。 | Harness 已有 JSONL/SQLite、checkpoint/tool ledger、预算恢复与 reconcile；`packages/core/src/runtime/runtime.ts:1956` resume 不是盲重放旧 transcript；`turn-helpers.ts:205` 未知副作用分类；`apps/web/src/deepseek/owners.ts:328` workspace owner 从冻结 base.config 建宿主。不能将“上游使用 kernel lease”直接推导为 Harness 无恢复能力。 |

## 已独立复现并实施的 B1

基线源码中 Runtime deps 已有 `maxIterationsPerTurn`（`packages/core/src/runtime/runtime.ts:213`），构造时默认 20（`:673`），循环硬顶在 `:1214`，到顶明确 failed/RESOURCE_LIMIT（`:1475`）。但 `packages/harness/src/config.ts:53` 的公共 HarnessConfig 与 `create-harness.ts:457` 的组合未暴露/传递；AgentLimits、RunLimits 只有工具/时间等限额。CLI `DefaultDepsOptions` 与 Web `main` 也无实际用户入口；SDK 是 client-only，其 wire 只选择服务端已冻结 agent，不能凭客户端临时扩大服务器预算。

用 `/tmp/harness-longrun-source-loader.mjs` 的 Node 24 transform-types 路由直接执行基线 **src**（非旧 dist），20 个不同 read_file 后还有一个 final 采样：公共 host 始终在第 20 次请求失败。复用相同生产 orchestrator/store/context，直接给既有 RuntimeDeps 传 21，则第 21 请求正常完成。此结果证明公共配置能力缺口；旧类型根本不支持该字段，不能夸称是已支持 API 的违约。证据、两个结果 JSON 与原探针完整保留到 `/workspace/harness-longrun-acceptance-20261020/budget-baseline`。

本轮窄实施：`HarnessConfig.maxIterationsPerTurn?: number`，启动前验证有限正 safe integer，直传既有 RuntimeDeps；省略仍用 20，且不将新默认字段注入历史 config fingerprint。显式值进入现有 config 层，声明 session_frozen、变更受原漂移门禁；没有改 Core 循环、没有新增 runner。CLI 支持 `createDefaultDeps({ maxIterationsPerTurn })`，CLI/Web 实际入口共享 `HARNESS_MAX_ITERATIONS_PER_TURN` 解析；Web sibling workspace 自然继承 base.config。SDK 无新增可绕过 frozen-policy 的 wire 参数，真实 AppServer 测试证明使用服务器冻结预算。

真正用户入口：

```sh
HARNESS_MAX_ITERATIONS_PER_TURN=45 node apps/cli/dist/main.js chat /path/to/project
HARNESS_MAX_ITERATIONS_PER_TURN=45 node apps/web/dist/main.js
```

Windows PowerShell 用 `$env:HARNESS_MAX_ITERATIONS_PER_TURN = '45'` 后启动同一命令。变量只改变一次 turn 的有限模型/工具循环次数，不代表增加其它预算。默认 maxToolCalls 仍为 50；大量工具操作的 programmatic host 应显式配置工具/时间/费用预算，例如 `createHarness({ ...base, maxIterationsPerTurn: 80, limits: { maxToolCalls: 100, maxDurationMs: 600000 } })`。本轮 40 步生产验收显式设 maxToolCalls=60，43/45 次模型请求都没有自动开新 turn。

验收：新增 Harness 17 个回归（默认20、40依赖步骤、实际失败验证修正、非法值、解析、持久漂移、工具/费用/时长/取消）；CLI 3 个真实 RPC 入口回归；SDK 1 个真实 AppServer 回归；Web 1 个独立真实进程→loopback HTTP→23模型请求→22实际文件结果回归。脚本模型只证明基础设施，不证明真实模型长任务质量。

第二优先事项是根任务 C1：用已保存反例修复 reactive overflow 丢 checkpoint，并用取消、重复溢出、合法工具配对证明有界进展。DeepSeek 的 progress-gated retry 为不变量参考，不构成替换 Harness Runtime 的理由。新的 goal/planning prompt 策略若要引入，应先 failure cluster→challenger→paired eval；本轮不默认推广。

## 许可

`/workspace/deepseek-harness/LICENSE:1` 为 MIT，版权 `Copyright (c) 2026 DeepSeek`，`:11` 要求复制或 substantial portions 包含版权与许可。研究只借鉴边界、不复制其实现/品牌/资产；B1 是独立的现有 Harness 参数接入，不新增第三方代码或运行依赖。Harness 已有 `packages/tools/licenses/deepseek-harness-MIT.txt` 并不免除未来新增复制片段的归属义务。vendor/ 与独立包若将来引入，仍应分别核对其许可，不用根 MIT 概括所有第三方材料。
