# Coding agent 源码对照与 Harness 优化依据

日期：2026-10-02。研究的是用户提供的源码合集及当前 Harness 实现，交付为源码分析、可复核反例和下一轮实现计划。

## 快照与方法

- 合集：`https://github.com/ki11a-Conton/HARNESS-SRC-FORK`，本地 `/workspace/HARNESS-SRC-FORK`，固定提交 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，24,937 个 tracked files。
- 当前项目：`/workspace/harness-agent`，实现基线 `acf8dcc394de6c6efefed52602e49014b372f372`。最近的上下文、工作区知识、完整消息计量和线性裁剪优化均保留。
- 对五个 agent 家族分别追踪入口、loop、工具/权限、context、knowledge/session/verification 与相关测试，再对照当前生产组合。覆盖关键实现与相关测试，未声称逐行审查全部 24,937 个文件。
- 合集各目录没有独立 upstream Git 身份；manifest 包版本和合集子树 SHA 可验证，但不能当作各上游的官方 release commit。`reports/` 只作索引，结论重新核对实际源码。
- 当前项目的 AGENTS、HANDOVER 与任务约束优先。确定性正确性/安全缺陷可以局部维护；模型策略必须先 failure cluster → challenger → paired eval。复用 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。
- 通过原生终端 Git 克隆，没有使用 GitHub 连接器；没有安装或执行上游项目，没有复制上游实现。

## 源码范围与来源身份

| 家族 | 文件/版本依据 | 可见关键机制 | 详细审查 |
| --- | --- | --- | --- |
| Codex | 6,175 files；Rust workspace 0.0.0 / CLI 0.0.0-dev，Apache-2.0 | session/turn sampling；按序收集并行结果；审批与 sandbox attempt；结构化结果统一转模型视图；UTF-8 安全截断 | [Codex](source-agent-review-20261002/codex.md) |
| OpenCode | 6,503 files；源码包 **1.18.16**，MIT；合集旧报告声称的 1.18.18 不适用于此源码 | V1/V2 两条运行链；scoped instruction；文件 conditional write 与 canonical lock；bounded output store | [OpenCode](source-agent-review-20261002/opencode.md) |
| Pi | 1,359 files；coding-agent / agent-core **0.84.1**，MIT | 截断响应不执行工具；原始视图批量编辑；EOL/BOM 保留；steering、扩展 hooks 与工具块对齐 | [Pi](source-agent-review-20261002/pi.md) |
| Hermes | 8,655 files；pyproject **0.20.0**，MIT | 当前用户锚点保留；只读外部 memory prefetch 限时；进展 guardrails；memory/skill/delegation 生命周期 | [Hermes](source-agent-review-20261002/hermes.md) |
| Claude Code fork 档案 | 1,903 files；仅 README/src，无 LICENSE、package.json 或测试，精确版本不明 | 可读 query/tool/context 链；技能变化失效缓存；按 API 消息组分配工具结果预算。仅静态概念证据，不视为完整开源实现 | [Claude 档案](source-agent-review-20261002/claude.md) |
| 合集中的 Harness | 281 files / 18 packages；当前项目为 2,750 tracked files / 24 packages | 279 个共同文件中 177 个忽略 CRLF 后仍不同；缺少当前 controllers、createHarness 和 paired/candidate 入口，不能代替当前基线 | [当前能力对照](source-agent-review-20261002/harness-current.md) |

每份详细审查包含实际函数、文件行号、测试路径、已有能力与可移植边界。来源文件 SHA-256、各目录 Git tree、当前被测源码和探针 SHA-256 在 [证据 manifest](../evidence/source-agent-review-20261002.json)。Claude 档案存在缺失内部依赖，仅读取可见调用链；计划采用本项目独立实现，不移植该档案代码。

## 不能重复列为新增功能的当前能力

当前 Harness 已有独立完成验证及有界失败修复、结果指纹驱动的停滞检测、读工具并发与单批次写冲突控制、durable session/inbox/crash recovery、artifact/hash/retention、权限和沙箱、memory/skill 安全门、子 agent workspace 隔离、CandidateRegistry/ArmFactory/paired/V3/promotion 证据链。

典型源码依据：`model-call-controller.ts:301–355` 已反馈验收失败并继续修复；`tool-call-controller.ts:239–288` 已控制单批并发；`state/agent-state.ts:204–226` 已根据结果变化判断进展；`context-controller.ts:474–577` 已具备字符串输出 artifact；`evaluation/candidate-registry.ts:13–58` 与 `paired-executor.ts` 已支撑真实候选评估。此次 10 个当前功能测试文件、119 项测试通过，证明这些能力应保留。

## 确认的问题与优先级

| 编号 | 上游机制 / 当前根因 | 本地观察 | 建议 |
| --- | --- | --- | --- |
| R1 / P0 | Pi `agent-loop.ts:208–214` 拒绝 length 工具批次；当前 `model/openai.ts:528–532` 把 length/content_filter 映射 stop，`:587–589` 自然 EOF 推断调用 | length/content_filter → completed；完整 JSON 但无终止证据 → 真实 Runtime 向 FakeOrchestrator 派发 1 次 | provider 保留终止证据，异常结束走现有 error 边界，未执行调用逐个结算 |
| R2 / P0 | Hermes `context_compressor.py:5341–5403` 保留当前 user；当前 steering 只入消息/消费 inbox，没进 protected facts | 6 次模型请求中，第 3–6 次无 `DO_NOT_TOUCH_CONFIG`；transcript 仍有 steer，4 个摘要均未保护它 | 在正常/reactive 裁剪、摘要、恢复中保留当前 turn 的有效用户约束 |
| R3a / P0 | Codex `tools/context.rs:116–145` 统一结构化输出模型视图；当前 `context-controller.ts:482` 在对象或无预算时提前返回 | 对象约 10 KB，redactor/detector 均 0 次，测试 secret/attack 原样可见；string 控制组安全 hooks 生效 | 将安全处理绑定实际模型文本，独立于输出形状和预算开关 |
| R3b / P0 | Codex UTF-8 helpers / OpenCode output store；当前 executor 与 orchestrator 用字符 slice 应用 byte cap | 8-byte 配置返回 24-byte 中文；合法 emoji 跨 chunk 变为 `���` | byte-aware bounded collector + incremental decode，分别验收捕获、预览与 marker 预算 |
| R4 / P1 | OpenCode conditional write + canonical lock；Pi EOL/BOM 保留；当前 edit-file 裸 read→write，range 以 LF 拼回 | 跨 session 两编辑都 success 却丢一项；CRLF 行替换形成混合换行；旧行号可改错目标 | 进程内协作写锁、显式读取版本前置条件、保留未触及原始字节 |
| R5 / P1 | 档案中的技能变化失效缓存概念；当前技能 provider 名称缓存遮蔽 loader 已有 refresh | SKILL.md 更新仍注入旧正文；删除后仍注入旧正文；底层 loader 单独调用可读新内容 | 统一索引/正文 revision，在下一 step 生效，保留当前 step 冻结与安全扫描 |
| R6 / P1 | Hermes `memory_manager.py:547–595` 有界只读 prefetch；当前 runtime 在 budget/abort gate 前直接 await memoryBlocks | maxDurationMs=5 或 abort 后，50ms 仍 pending；回调释放才 failed/cancelled | request-local cancellation/deadline、迟到结果隔离与受控在途检索 |

R1 证明的是实际 Runtime 的派发路径，未声称真实文件写入或权限绕过。R3 使用虚构 sentinel，没有使用真实凭证。R4 证明进程内协作并发丢更新，文件锁与写前 hash 不能被宣称为任意外部进程的原子 CAS。R6 仅针对只读准备阶段，不能提前合成有副作用工具的完成/取消。

## 策略候选与取舍

| 候选 | 源码依据 / 当前差距 | 取舍与评测 |
| --- | --- | --- |
| S1 诊断优先修复 | 当前 TaskVerifier 已接收 stdout/stderr，但 reason 只保留 exit 1；已有反馈循环，没有具体失败位置 | 先在已有 Agent 指引中要求 targeted exec 取得真实诊断，再修复和独立验收；单变量 paired，禁止原始 stderr 直接升级成 system 指令 |
| S2 按目标路径加载项目规则 | OpenCode instruction/read 按目标查找；当前 discovery 遍历全子树，可能同时载入兄弟规则，遇中间缺文档会漏更高根规则 | 先定义 monorepo 范围/预算契约；通过 composition adapter 做 opt-in challenger。当前测试锁定部分旧行为，不能偷偷改变默认或重写 Core |
| S3 多位置编辑与整批输出预算 | Pi 原始视图 edits[]；可见档案 API 消息组预算 | 暂缓。先获取对应失败聚类，再分别评测，不能捆成一个无法归因的候选。已有单输出 artifact 和持久模型视图无需另造重放日志 |

不直接复制上游 fuzzy/NFKC/首匹配写入，不能为了少审批放宽授权，不用更简单的三连重复检测替换当前结果感知 guard，不引入 Bun/Effect/Rust/Python 运行时依赖，不把上游 loop 停止等同于 Harness 验收成功。

## 已执行的验证与界限

1. 在无生产源码变化的基线重新执行 `corepack pnpm build`，退出 0。
2. 独立调查执行当前相关回归：10 files / 119 tests passed，4.61s，exit 0；命令见 [当前能力审查 §6](source-agent-review-20261002/harness-current.md)。
3. 主入口核对当前源码指纹后，重新运行六组离线探针，结果已写入证据 manifest 的 `reproductions`。探针入口：[scripts/research/README.md](../../scripts/research/README.md)。

```bash
corepack pnpm build
node scripts/research/source-agent-review.mjs --out .ci/source-research/reproduced.json
```

**探针退出 0 表示现状已被观察，不表示缺陷修复。** provider 使用内存 SSE，Runtime 调用 FakeOrchestrator；进程/编辑/技能反例使用当前实现及可清理的临时资源。没有真实模型、上游测试、付费评测、champion promotion 或 Windows 实机验收；本次不是新生产优化的通过证据。后续必须先把观察转成 RED 回归，再按 [plan.md](../../plan.md) 做局部实现与 GREEN 验收。
