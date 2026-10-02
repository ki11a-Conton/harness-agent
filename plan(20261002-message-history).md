# Harness Agent 长会话消息处理优化计划

日期：2026-10-02。目标是降低长会话裁剪的重复计算，并修复历史消息预算遗漏与估算器不一致。先建立反例和配对基准，再修改实现，最后按以下标准验收。

## 基线、依据与范围

- 本轮基于已完成的上下文优化快照 `249770e1737cc2f7143af66b143dbb7cad089020`，保留此前审查、工具安全、工作区知识和上下文压缩优化。上一轮计划归档为 `plan(20261002-context-compaction).md`。
- 已读取 AGENTS.md、HANDOVER.md、LOOP-001、CTX-002，以及 Message、TokenEstimator 和工具消息协议契约。遵守 Runtime Freeze：以工具参数/reasoning 预算漏算及注入估算器失配的确定复现作为正确性维护依据；性能修改以同环境配对基准验收。
- 审查发现：`trimMessageHistory` 每删除一条消息都会重新扫描并复制剩余历史；`estimateMessageTokens` 只计算 content，遗漏发送给模型的工具参数、调用标识与 reasoning；ContextPipeline 的注入估算器没有传入裁剪路径。
- 开发工作树：`/workspace/harness-agent-history-optimization`；基线工作树：`/workspace/harness-agent-history-baseline`。长链测试在干净、冻结的开发快照执行，验收后同步到 `/workspace/harness-agent`。
- 范围：context 的消息计量与导出、core 的历史裁剪 helper 和 context-controller 调用、相关回归测试、离线基准、证据及计划。不增加依赖，不重构 Runtime 架构，不改变工具权限、安全边界或完成验证规则。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| H1 完整的消息预算 | 消除正文为空但包含巨大工具参数/reasoning 时的预算低报 | 通过现有 TokenEstimator 计量正文、assistant reasoning、tool call 的 id/name/JSON 参数及工具结果关联 id；保留正文消息现有的每消息 8 token 结构开销；工具调用增加明确的结构开销。ContextPipeline 的统计与公开计量方法复用同一实现，provider 数据仅用于协议对照，不增加 provider 依赖 | 工具调用、多个调用、中文/emoji、JSON 转义、reasoning、关联 id、普通消息及注入估算器回归全部通过；role 对应字段才计入；较大的隐藏字段触发裁剪；普通正文消息结果兼容，输入保持原样 |
| H2 线性的历史裁剪 | 消除长会话裁剪的平方级重复扫描与数组复制，同时修复报告/裁剪估算器失配 | 每条消息成本只计算一次，累计后找出首个符合 headroom 的后缀，最后一次切片；context-controller 显式传入 pipeline 的计量方法；保留当前最少 4 条消息和只修复开头孤立工具结果的协议规则，完整 transcript 保留在 store | 2000/4000/8000 条正文历史，候选输出与基线一致；4000 和 8000 条场景扫描字节、计量次数与切片复制量下降至少 99%；输入翻倍时扫描量至多 2.1 倍；定向测试检查边界预算、tail 保底、工具调用块、孤立结果、内部损坏 fail-closed 及不可变性 |
| H3 真实调用路径的回归 | 确保智能体在含巨大工具参数/reasoning 或定制估算器的长会话里使用正确预算，仍保留最新任务与摘要 | 使用记录请求的 ScriptedModelProvider 驱动真实 AgentRuntime；播种合法旧工具块与近期任务，检查模型看到的消息、预算和协议，以及 store 中原始数据 | 原实现上取得失败反例；候选在真实 runtime 路径按注入估算器满足可满足的 headroom、保留最新用户输入与状态摘要、保留完整原始消息；现有 wire-protocol e2e、loop 集成、安全回归通过 |
| H4 可复核交付 | 执行计划并报告量化证据与限制 | 同脚本/配置/Node 环境运行基线与候选，保存样本及源码/脚本摘要；基线自比较必须失败；执行 typecheck、build、相关单元/集成、安全和干净快照完整 test；同步后逐文件核对并在目标目录构建 | 所有正确性与性能门槛通过；`corepack pnpm typecheck`、`build`、`test:security`、`test` 和 `git diff --check` 退出 0；plan.md 更新实际结果，证据可复现；此前交付文件保持一致 |

## 执行步骤

1. [x] 审查实现与现有任务，明确可复现问题和限定范围。
2. [x] 在修改生产代码前写下本计划，归档上轮计划并建立隔离工作树。
3. [x] 编写回归反例与离线基准，取得原实现 RED 和性能基线。
4. [x] 实现 H1/H2，完成定向回归与配对基准。
5. [x] 在干净冻结快照完成 H3/H4 的全量验收。
6. [x] 记录结果、限制和复现命令，同步最终代码至用户工作区。

## 验收结果（完成后填写）

H1–H4 全部完成，优化代码和本计划已同步至 `/workspace/harness-agent`；其余 18 个既有交付文件经字节核对保持一致。

- 同一组 38 项新增回归：基线 15 失败 / 23 通过，候选全部通过。
- Context / Core / Model / Contracts / Harness：1,345 项、105 个文件全部通过，包含真实 Runtime 和 HTTP wire-protocol e2e。
- 安全：2,135 项、19 个文件全部通过。
- 全量 `corepack pnpm test`：421 个文件通过 / 1 个文件跳过，7,811 项通过 / 12 项按仓库原配置跳过 / 0 项失败，退出 0，耗时 619.69 秒。使用干净冻结实现快照 `4d1741dd1f4024392d5c4af2ecd6977ba110411a`；验收后仅更新本计划。
- `corepack pnpm typecheck`、`corepack pnpm build`、`git diff --check` 通过。
- 用户工作区交付的 10 个文件与验收工作树一致，目标目录的类型检查和构建通过。实现保存在本地分支 `codex/optimize-message-history-20261002`。
- 配对基准：同脚本、Node 24.19.0 / Linux / x64、每场景 7 个样本。三种正文历史的输出身份与基线一致；13 项候选正确性检查、6 项 99% 降幅门槛和 2 项线性增长门槛全部通过。基线自比较退出 1，不能冒充优化成功。

| 场景/计量 | 基线 | 候选 | 结果 |
| --- | ---: | ---: | --- |
| 4,000 条历史，正文累计扫描 bytes | 4,097,018,880 | 2,048,000 | 减少 99.9500% |
| 8,000 条历史，正文计量次数 | 32,003,990 | 8,000 | 减少 99.9750% |
| 8,000 条历史，正文累计扫描 bytes | 16,386,042,880 | 4,096,000 | 减少 99.9750% |
| 8,000 条历史，slice 复制的消息引用数 | 31,995,994 | 4 | 减少 99.99999% |
| 32 KB 工具参数消息，预算估算/本方案应计预算 | 8 / 8,025 | 8,025 / 8,025 | 消除参数低报 |
| 中文/emoji reasoning 消息，预算估算/本方案应计预算 | 8 / 7,508 | 7,508 / 7,508 | 消除 reasoning 低报 |

候选的输入从 2,000→4,000→8,000 条翻倍时，扫描字节均为 2 倍。性能计时含插桩，仅作观测；门槛使用重复扫描和 slice 复制计数，不将其等同于总内存占用或模型 token 节省。原始样本、环境、源码和脚本 SHA-256 在 `docs/evidence/message-history-optimization.json`；日志在 `.ci/history-optimization/`。

## 复现方式

先在基线和候选各执行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm build`，再从候选使用同一个脚本：

```bash
node scripts/benchmark/message-history.mjs --repo-root /workspace/harness-agent-history-baseline --label baseline --out /tmp/history-baseline.json
node scripts/benchmark/message-history.mjs --repo-root /workspace/harness-agent-history-optimization --label candidate --out /tmp/history-candidate.json
node scripts/benchmark/message-history.mjs --compare --baseline /tmp/history-baseline.json --candidate /tmp/history-candidate.json
corepack pnpm exec vitest run packages/context packages/core packages/model packages/contracts packages/harness --exclude '**/*.perf.test.ts' --exclude '**/*.soak.test.ts'
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:security
corepack pnpm test
```

基线为上述 `249770e` 快照。运行原实现的 RED 时，将两份新增回归测试复制到基线，仅执行定向 Vitest；新公开计量方法在旧实现不存在，因此该 RED 不是基线类型构建验收。

## 约束与实际限制

token 数值仍是预算估算，不能冒充模型真实 tokenizer 或计费 usage。最少 4 条消息是现有保底行为；保底消息本身超过预算时，不通过删除当前任务掩盖超限。仅自动移除裁剪后开头的孤立工具结果，内部协议损坏仍由原有 send-boundary 验证拒绝。reasoning/参数的预算计量不改变它们的持久化或发送内容，不将正文写入基准证据。只报告本环境实际运行的验收，不借用既往 Windows CI，也不声称真实模型成功率提升。本容器的进程测试沿用现有 Linux subreaper 启动器处理 PID 1 不回收孤儿进程的问题。
