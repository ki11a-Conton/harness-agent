# Pi 源码研究与 Harness 对照

研究日期：2026-10-02。上游只读目录 `/workspace/HARNESS-SRC-FORK/pi-main`，收集仓库快照 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`；这不是 Pi 官方发布 commit 的证明。目标快照 `acf8dcc394de6c6efefed52602e49014b372f372`。未联网、未安装依赖、未调用 GitHub 连接器，未修改生产代码。

`packages/agent/package.json:3`、`packages/coding-agent/package.json:3` 均标记 **0.84.1**；根 monorepo 的 `package.json` 另标 0.0.3，不能把它混作 coding agent 版本。两个包均声明 MIT，仓库 URL 为 `https://github.com/earendil-works/pi.git`。`LICENSE:1-13` 为 MIT、Copyright (c) 2025 Mario Zechner；若复制实质代码，必须保留版权与许可。建议重新实现机制并在研究记录引用来源。

已读目标 `AGENTS.md`，以及 `tasks/P0/TOOL-001.md`、`CORE-001.md`、`tasks/P3/CTX-001.md`、`CTX-002.md`、`CTX-003.md`、`tasks/P4/LOOP-001.md`、`VERIFY-001.md`、`RECOVERY-001.md`、`tasks/P2/SESSION-001.md`。下述两项主候选均有确定性复现；不是用模型质量问题要求解冻 Runtime。

## 实际调用链与读到的源码

Pi CLI 入口：`packages/coding-agent/src/main.ts:569 main` → `main.ts:819 createAgentSessionFromServices` / `main.ts:843 createAgentSessionRuntime` → `core/agent-session-services.ts:202 createAgentSessionFromServices` → `core/sdk.ts:294 new Agent`、`:376 new AgentSession` → `core/agent-session.ts:1116 prompt`、`:1272 _runAgentPrompt` → `packages/agent/src/agent.ts` 的运行入口与 `createLoopConfig:445` → `packages/agent/src/agent-loop.ts:155 runLoop`。

Loop/tool：`runLoop` 在 `:167` 先取 steering，`:192` 调 `streamAssistantResponse`，`:207-214` 判断工具批次与 length，随后执行 `executeToolCalls` 的串行/并行分支。`AgentSession._installAgentToolHooks:479` 接入 extension `beforeToolCall/afterToolCall` → `extensions/runner.ts:932 emitToolCall`（阻断短路）、`:877 emitToolResult`（顺序变换结果）。编辑落到 `packages/agent/src/harness/tools/edit.ts:77 createEditTool`，经 `file-mutation-queue.ts:30 withFileMutationQueue` 以环境与 canonical path 串行，读文件、准备所有替换、写文件。

Context/session：`agent-loop.ts:303` 附近 `streamAssistantResponse` 先 `transformContext`，再 `convertToLlm`，仅在 LLM 边界转换消息。CLI `core/agent-session.ts:1962 _checkCompaction` → compaction preparation/summary → session manager 存储；新 harness 路径 `packages/agent/src/harness/compaction/compaction.ts:616 prepareCompaction` → `:707 compact`，保存 `retainedTail`、文件操作清单与 usage；`packages/agent/src/harness/session/session.ts:102 Session` 提供 `appendMessage:178`。切点避免从 toolResult 开始，见 compaction.ts 的 `findValidCutPoints`、`findCutPoint`；长 turn 的前缀单独摘要，见 `:689 TURN_PREFIX_SUMMARIZATION_PROMPT` 与 `:731-765`。

Knowledge/verification：`core/agent-session.ts:1023 _rebuildSystemPrompt` 汇入当前 active tools 对应的 prompt guidelines、skills、AGENTS files → `core/system-prompt.ts:28 buildSystemPrompt`；`:108-112` 去重并加入工具指南。这里只看到了工具与上下文层引导，没有发现与本项目 `Verification` 同等的独立完成证据门禁，因此不能用 Pi 的 loop 停止条件替换现有 Harness 验证。

对应上游测试实际读到：

- `packages/agent/test/agent-loop.test.ts:371-441`：length 截断的有效 JSON 参数仍不执行，产生错误 tool result 并允许重新发出完整调用；`:716-766`：先完成当前工具批次再注入 steering。
- `packages/agent/test/harness/tools.test.ts:329-374`：所有 edit 匹配原始内容、重叠或重复锚点拒绝；`:376-405`：取消后仍持锁直至进行中的写操作 settle；`:407-431`：canonical/symlink 同目标串行；`:449-462`：BOM/CRLF。
- `packages/coding-agent/test/tools.test.ts:1121-1213`：LF anchor 匹配 CRLF、保留 CRLF/LF/BOM、混合换行的重复匹配拒绝；`:1069-1120`：fuzzy 修改保留未触及行、生成可应用 patch。
- `packages/agent/test/harness/compaction.test.ts`、`packages/coding-agent/test/compaction.test.ts`、`compaction-serialization.test.ts`、`compaction-extensions.test.ts`：compaction/序列化与 extension 表面。
- `packages/coding-agent/test/extensions-runner.test.ts`、`packages/coding-agent/test/suite/agent-session-queue.test.ts`：extension 与 steering/follow-up 边界。

没有运行上游测试或真实模型；下面的复现调用现有 Harness 构建产物和本地测试替身。

## 候选 1：保留不完整模型响应的结束语义，禁止 EOF 推断后派发写调用

分类：**确定性 provider/Runtime 接缝缺陷，高优先级**。首选在 provider 层用已有 `finishReason: "error"` 边界修复，无需先扩大 Runtime 全局状态机或 FinishReason 枚举。

上游机制：`packages/agent/src/agent-loop.ts:208-214` 对 `stopReason === "length"` 拒绝执行整批调用；`:371` 附近 `failToolCallsFromTruncatedMessage` 为每个请求产生明确错误结果；测试 `agent-loop.test.ts:371-441` 刻意输入 `{value:"hel"}` 这种仍通过 schema 的不完整参数。重要的是响应结束状态，不能仅依赖 JSON 与 schema 成功。

目标实际缺口：

- `packages/contracts/src/model.ts:74` 的 `FinishReason` 只有 stop/tool_calls/error/cancelled。
- `packages/model/src/openai.ts:528-532` 把除 tool_calls 外的所有 finish_reason（包括 length/content_filter）映射成 stop，丢失原始语义。
- `openai.ts:440-443` 无 response body 也返回正常 stop。
- `openai.ts:464-485` 的 `finishEvents(undefined)` 在已有 calls 时推断 tool_calls；`:489-491` 的 `[DONE]` 和 `:587-589` 的自然 EOF 都走这里。后者完全没有收到正常终止证据。
- `packages/core/src/runtime/model-call-controller.ts:301-358` 对 stop 走验证/完成；`:365-375` 已有 error 的拒绝执行与工具协议结算分支；`:401` 仅返回 proceed 后才派发工具。

### 已完成最小离线复现

在当前构建产物调用真实 `OpenAICompatibleProvider`，完全替换 `globalThis.fetch` 为本地 `Response(SSE)`。没有真实 HTTP、模型或文件写操作。随后真实 `ModelCallController.handleModelCompletion` 使用内存 store/结束函数替身；自然 EOF 额外通过完整 `AgentRuntime` 与项目自带 `MemorySessionStore`、`MemoryEventStore`、`FakeOrchestrator` 跑到派发点。

可复核脚本：[pi-repro.mjs](../../../scripts/research/source-review-pi.mjs)，运行结果：[pi-repro.json](../../evidence/source-agent-review-20261002.json)。在仓库根目录执行 `node .ci/source-research/pi-repro.mjs > .ci/source-research/pi-repro.json`；脚本引用现有 `packages/*/dist`，比较其他源码版本前先构建。脚本可复制到 `scripts/research/pi-repro.mjs`，二级相对 import 仍然有效。结果记录 0 真实 HTTP 请求、0 真实工具文件写入；保存 JSON 证据文件属于研究产物，并非 agent 工具执行。正常 stop/tool_calls 对照有独立断言，缺陷行为仅打印观测，避免修复后仍要求错误行为。

| 输入 | 现有 provider 结果 | 现有 core/Runtime 结果 |
|---|---|---|
| 文本 `partial answer` + finish_reason length | stop | finish，status completed，terminationReason model_stopped |
| 同样文本 + content_filter | stop | 同样标 completed/model_stopped |
| 完整 write_file JSON，随即自然 EOF，无 finish_reason、无 `[DONE]` | tool_calls | core proceed；完整 Runtime 实际对 FakeOrchestrator 派发一次，然后第二条正常 stop 使 turn completed |
| 完整 write_file JSON + `[DONE]`，无 finish_reason | tool_calls | core proceed，1 个可执行调用 |
| 正常 stop 对照 | stop | 正常 finish |
| 正常 tool_calls 对照 | tool_calls | 正常 proceed；完整 Runtime 派发一次 |

关键 EOF fixture（最后由 Response 正常关闭模拟网络代理提前关闭，非抛异常）：

```js
const chunk = { choices: [{ delta: { tool_calls: [{
  index: 0, id: "call_1", function: {
    name: "write_file",
    arguments: '{"path":"a.txt","content":"partial"}'
  }
}] } }] };
globalThis.fetch = async () => new Response(
  `data: ${JSON.stringify(chunk)}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } }
);
```

这证明异常流结束可以到达实际 `executeBound→FakeOrchestrator.execute` 派发路径，**不等于声称真实文件已改写，也不说明权限/沙箱被绕过**。即便目标路径已获授权，未完成模型响应也不应因参数碰巧闭合而自动提交副作用。

### 做什么 / 怎么做

1. 在 provider 分辨 normal stop/tool_calls、length、content_filter、缺失 body、自然 EOF、显式 `[DONE]` 无 reason；原始 reason 写入结构化错误 evidence/metadata。
2. 最小实现可对不完整响应返回 `ModelFinalResult {finishReason:"error", text, toolCalls, error: errorInfo("MODEL_ERROR", ..., {retryable:false, safeToRetry:false, provider:{kind:"protocol"}, evidence:...})}`；保留局部文本/调用供审计，让当前 core 错误分支结算所有未执行工具调用。避免只发一个 error 后把已经形成的调用意图丢失。
3. length 可以先安全终止，后续若要让模型继续或减小输出，应作为有次数/预算约束的 agent challenger；不可自动重试相同部分输出，不能偷偷重试已经执行的工具。content_filter 必须与正常完成区分。
4. 明确 `[DONE]` 无 finish_reason 的兼容：现有 `packages/model/src/openai.test.ts:174` 将这种文本响应视为 stop。不要把自然 EOF 与显式 DONE 混为同一信号；首选严格安全默认，对潜在写调用一律不派发。若保留兼容 profile，需明确 opt-in 的协议规则、原始终止证据与非完整完成等级，不能静默冒充已完成。

### 怎么验收 / 负例

- provider fake SSE 覆盖 length/content_filter/未知 reason/无 body/自然 EOF，均不映射正常 stop；局部文本保存且不是 turn.completed 或 verified_complete。
- 自然 EOF 后带合法写参数、读参数、一个完整调用加一个截断调用，FakeOrchestrator 派发次数均为 **0**；正常 tool_calls 对照恰为 **1**，明确防止“一刀切禁掉正常工具”回归。
- length 下即使参数完整且 schema 通过也派发 0；不存在部分批次先执行再报错。
- 每个 assistant tool id 恰有一个 `[not executed]` tool result；下一轮/新 turn/resume 经现有严格 wire validator 检查无 orphan/duplicate。
- 显式 DONE 无 reason 的 profile 测试与自然 EOF分开；不能静默触发副作用；测试现有兼容规则变更并在文档记录。
- 正常 stop/tool_calls、caller cancel、timeout、HTTP/provider retry 与用量归因均保持现有约束；重放时不能再次执行拒绝的调用。
- 定向 provider/unit、Runtime integration/wire、相关 security；最终 typecheck 与项目要求的验证，证据保存实际用例与快照，不调用真实模型。

## 候选 2：安全编辑保留换行与 BOM，先采用严格的规范化匹配

分类：**确定性文件编辑完整性缺陷**；只需工具层纯函数和 edit_file 改进，可并入综合安全编辑工作包，不重写调度或 Runtime。

上游机制：`packages/agent/src/harness/tools/edit.ts:104-111` 拆出 BOM、LF 视图匹配、恢复原换行。`edit-diff.ts:15-20 normalizeToLF/restoreLineEndings`、`:128-169 applyReplacementsPreservingUnchangedLines` 用原始行块保留未触及区域。上游测试 `coding-agent/test/tools.test.ts:1133-1211` 与 `agent/test/harness/tools.test.ts:449-462` 证明换行/ BOM 路径。

目标实际缺口与已复現：

- `packages/tools/src/edit.ts:107` 按 `\n` 分割、`:127` 以 `\n` 拼接；`applyLineRange("a\r\nb\r\nc\r\n", 2, 2, "B")` 真实结果 `"a\r\nB\nc\r\n"`，成功却把单行更改变为混合换行。
- `applyReplace("a\r\nb\r\nc\r\n", "a\nb", "A\nB")` 返回 anchor not found；模型拿 LF 锚点不能编辑 CRLF 文件。
- `packages/tools/src/tools/edit-file.ts:103-125` 读全文、执行纯函数、直接 writeFile，无格式感知。BOM 位于第一行时，range 替换可把 BOM随第一行移除，需字节级测试确认并修复。

### 做什么 / 怎么做

1. 对 CRLF/LF建立匹配视图，同时保留原始 offsets 或原始行块；替换仅重写触及区域，保持未触及字节、尾部换行与 BOM。
2. 新增替换文本的 EOL 规则：默认沿用被替换区域/文件的一致 EOL；混合换行输入不要全文件统一。BOM 不作为普通行文本交给 range 操作，保持原样。
3. 本项目 `applyReplace` 默认 first occurrence 在 `edit.ts:54-56,93` 明确是兼容语义，不能把 Pi 的默认唯一匹配直接当修缺陷覆盖。保留 occurrence/replaceAll；安全模式可显式要求 unique，需单独策略评估。
4. 不复制 Pi `normalizeForFuzzyMatch:30-49` 的 NFKC、智能引号/Unicode dash、空格归一化为默认写行为：源码字符串里的字符差异可能是业务语义。若以后支持 fuzzy，只能 opt-in、限定唯一候选、给出预览和实际匹配证据。

### 怎么验收 / 负例

- CRLF range替换和LF多行anchor均成功，修改后的bytes与明确期望完全相同；未触及行sha/字节保持。
- 覆盖 LF、CRLF、mixed EOL、无末尾换行、UTF-8 BOM、中文/emoji、首行/末行/删除多行，确保格式/编码未漂移。
- NFKC/智能引号/Unicode dash只有模糊接近时默认拒绝而非修改；重复规范化 anchor不能悄悄选择新增歧义位置；occurrence/replaceAll既有语义保持。
- 权限拒绝、越界路径、沙箱拒绝仍在 ToolOrchestrator；工具失败、取消前的非提交状态仍为0写；已经提交的取消不声称回滚。
- 定向 tools unit和Orchestrator integration，加相关security；有Windows执行资源时再跑真实Windows验证，Linux不能冒充Windows证据。

## 仅保留为策略 challenger：单文件多处编辑匹配原始视图

Pi `edit-diff.ts:301-362 applyEditsToNormalizedContent` 把所有 edits 对原始文件定位、验证唯一且不重叠，按倒序 offsets应用，全部准备成功后只写一次。`core/tools/edit.ts:53-62` 的工具指南鼓励把同文件的离散修改合成一个调用。目标 `edit-file.ts` 只有单次 oldText/newText 或range；现有 `WorkspaceChangeTransaction` 是快照协调/回滚原语，不能误认为目前 edit_file 已有 edits[]批次，也不能把它误称为外部并发CAS。

这不是已证明缺陷，也未测出模型成功率/时间收益。仅可先做 agent/tool strategy challenger（可注册一个独立安全工具，不改core）：同一模型与固定任务对比单次编辑策略、批次原始视图策略，记录成功率、错误修改率、tokens、调用数、时延。所有 edits 都必须原文件定位，任一缺失/重叠/歧义失败时0写；两处修改的基准应证明读取/写入次数下降且正确性不退步，再考虑启用。不要在本轮计划中把它写成默认已确定收益。

Pi 同文件 canonical队列只保证其进程/环境内顺序；没有 expectedHash/CAS，不能据此宣称解决外部编辑器/跨进程并发。目标需要这类保护时先构造具体竞争复现，再独立立项。

## 现有能力保留，避免重复优化

- Steering/follow-up：Pi `agent-loop.ts:167,259,263`、`agent.ts:475-482` 是边界轮询队列；目标 `session-actor.ts:15-24,1345-1360` 已有显式类型、持久化队列、单turn及跨重启的exactly-once。`runtime.ts:968-978` 在下一采样边界注入，不重写。
- 中断：目标 `tool-call-controller.ts:217-236,287-315` 已结算所有未启动调用，保留已提交副作用；`:executeToolCall` 明确 unknown effect 与安全重试，强于简单loop停止。保留其安全边界，不用上游取消替换。
- Hooks/extensions：目标 `lifecycle/hooks.ts` 已有有序变换、超时、关口fail closed与source审计；tool controller阻止hook改工具身份与权限提升。Pi extension能力适合对照API，不适合复制其可变context/工具result以绕过冻结step和验证。
- Context/session：目标上一轮已把工具参数/reasoning计入预算，并做线性history trim、受保护锚点和原文回查；这里不重复提出“加上下文压缩”“加持久化会话”。Pi 的文件读写清单与split-turn summary是将来的策略比较对象，须先找实际failure cluster，不据它重构当前compactor。
- Verification：保留当前独立RuntimeVerifier/任务验证与完成等级；不能将Pi的agent_end解释为验证成功。

## 研究边界

源码静态分析覆盖loop、edit/queue、compaction、extension hooks、CLI/session构建与相应测试；并未声称审查Pi整个仓库每行代码。离线repro仅运行本项目已构建实现和测试替身，无实盘副作用。主计划优先接纳两项已复现工作包，其余策略仅在paired eval有证据后推进。
