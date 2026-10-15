# Harness 的 coding 提示词与配套机制：源码对比

研究日期：2026-10-15（Asia/Shanghai）。Harness 基线：`2a141309f01acae3707060faf1fab8aa247ed31d`。本轮完成源码研究、离线生产路径观察与实施规格；**没有改变默认策略或产品代码，没有进行付费模型实验。**

## 结论

应优先改善“找到相关代码 → 正确调用工具 → 小范围修改 → 跑真实检查 → 根据失败修复 → 留下可续接状态”的闭环。长提示词、向量库和更多插件都不能单独保证这个闭环。

当前 Harness 已经有工具编排、版本化编辑、权限、上下文预算、多阶段压缩、WorkingState、会话恢复和受信任边界约束的记忆检索。`coding-v1` 还已借鉴 pi、Codex、Hermes，不能把这些能力重新算作本轮新增。主要问题是：默认入口仍是简短 legacy 策略；缓存命中明细未穿透 provider；跨语言符号导航较弱；已有压缩、记忆能力尚需更贴近实际长任务的策略与评测。

建议顺序：**先补观测和失败分类，同时建立编码任务基线；再对照评测提示词与上下文策略；随后加强检索、长期记忆；最后按真实使用问题扩展 IDE 集成。** 默认策略的升级必须由模型实验决定。

## 固定来源和研究范围

| 对象 | 读取版本 | 来源性质及使用方式 |
| --- | --- | --- |
| Harness | `2a141309f01acae3707060faf1fab8aa247ed31d` | 当前 main 的固定基线；原工作区未提交文件未修改 |
| Codex、Hermes、pi、Claude Code 快照 | 聚合仓库 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` | 这是 HARNESS-SRC-FORK 的版本，不能冒充四个项目各自的官方 upstream SHA |
| DeepSeek Harness | `5badb15009ae1756c3afe0ae0cef1faafc290ccc` | 官方源码；选取的包声明 MIT |
| ZCode | `aac4755666d09fdcd70272fcf063c077a639015f` | `zai-org/ZCode`，源码包版本 3.15.1，Apache-2.0；此前聚合仓库未找到 ZCode |
| Aider | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | 额外比较 repo map 和编辑修复，Apache-2.0 |

用户给的 `HARNESS-SRC-FORK/tree/main/harness-agent-src` 是 Harness 的历史源码目录，不是 ZCode。这里不将其错认成另一种 agent。

共固定 **71 个选取文件**，涵盖提示词、组装、压缩、记忆、检索和 provider 接线；[源码索引](evidence/coding-agent-research-20261015/sources.md)和 [SHA-256 清单](evidence/coding-agent-research-20261015/sources.json)可离线复核。这是相关路径研究，并非对七个项目所有代码的完整安全审计；未运行其全部测试。

Codex 为 Apache-2.0；所选 Hermes/pi 为 MIT。Claude Code 快照的 README 明确称其为泄露源码，未找到可授权复制的 LICENSE（[CC01]）；因此仅独立归纳分段、检查点等机制，不把它当作可直接复制的开源实现。本轮没有将任何项目的大段提示词或实现复制入产品；将来复用许可明确的代码，应记录原路径、版本、修改和 notices。

## 各项目如何把提示词用于真正编码

| 项目 | 读到的提示词与机制 | 适合 Harness 的部分 | 移植边界 |
| --- | --- | --- | --- |
| pi | [PI02] 是按实际工具贡献片段和 guidelines 组装的小型 prompt；[PI03] 把 read 指引放在工具旁；[PI04] 用结构化摘要和 recent tail 保持续接 | 工具 schema 与操作指引共同维护、按能力裁剪、去重；压缩记录文件和当前步骤 | Harness 已有能力裁剪，不能再次记为新增；不复制 pi 的工具名、编辑格式或完整上下文栈 |
| Codex | [CX02] 强调先搜索、保护现有改动、计划按任务规模、真实检查；[CX03]/[CX04] 维护可恢复 checkpoint；[CX05] 有 Responses 的 cache key；[CX06] 分层读取历史经验 | 清晰的完成条件、当前用户目标和约束、精确文件/命令/错误、分层按需记忆 | 所读 prompt 是一个模型版本的文件，不能宣称是所有 Codex 模型的统一默认；Responses 参数不直接塞进 Chat Completions |
| Hermes | [HM02] 分稳定/上下文/易变层；[HM03]/[HM04] 有 coding context、实际执行、失败恢复；[HM07] 跟踪未解决问题；[HM08]/[HM09] 区分长期经验、会话历史和工作流 | 稳定策略前缀、任务进度与长期经验分开、旧记忆用前复核、压缩后保留未完成请求 | 它不只是 MEMORY.md；不能用一个无限增长文本文件替换 Harness 已有作用域、撤销和信任机制 |
| Claude Code 快照 | [CC02] 编码工作流；[CC03] prompt sections 在 clear/compact 前缓存；[CC04] 结构化交接；[CC05] 有条件的旧工具结果清理 | 独立设计稳定分段和事实检查点、显式标注截断与可回读来源 | 不复制未明确授权的代码/大段 prompt；其 provider 的 cache edits 也不是通用协议 |
| DeepSeek Harness | [DS01]/[DS02] 注册有名称、顺序、作用域的 prompt section；[DS03] 用结构化 checkpoint、保留原请求前缀；[DS04] 不在未闭合工具调用/结果中间切断；[DS05]/[DS06] 对超长结果保留首尾和可见裁剪标志 | 通过现有 AgentPromptPolicy/ContextPipeline 接口组织可替换策略，确定顺序；对工具结果和摘要保留来源 | “Everything is a plugin”不要求 Harness 重写成 Cordis；已有 tool pairing、offload、压缩不另建第二套 |
| ZCode | [Z04] 区分 CLI identity、stable body、dynamic system、meta user；[Z07] 只在兼容适配层合并 leading system，保持原字节顺序；[Z08] 的 cacheControl 转为 Anthropic provider options；[Z09] 传递 usage cache details | 稳定前缀与动态信息分开、schema 不在 system 中镜像、provider 专属序列化、实际请求和 usage 测试 | “DeepSeek 命中率高”尚无本轮真实测量支持；不能把 Anthropic 标记当成 DeepSeek 通用缓存开关 |
| Aider（补充） | [A02] Tree-sitter tags、引用图加权 PageRank 和 token 预算；[A03] 格式约束；[A05] 将实际 lint/test 错误送回修复循环 | 任务相关 repo map、搜索召回与排序、明确的编辑失败反馈 | 不复制它要求用户手动添加文件的交互限制、自动提交行为或不适用于本工具的 SEARCH/REPLACE 协议 |

这些项目反复出现的共同原则是：提示词只描述当下真正拥有的能力；环境事实由工具确认；任务状态有明确载体；工具失败是下一步决策的输入；最终成功由文件和检查结果证明。

## 对用户七类能力的逐项判断

### 1. 代码理解和长上下文

已有 `repo_tree/search_files/grep_search/symbol_search/repo_map`；已有预算、artifact offload、WorkingState、rehydration（[H08]–[H12]）。不能称为“只有单文件补全”。

明确不足：[H15] 自称轻量 TS/JS 正则索引，references 是索引行匹配，其他语言退回 grep；它不是多语言 AST 或 IDE 语义导航。`repo_map` 的存在不等于任务相关的依赖图检索已经成熟。

建议先做查询相关的路径/符号检索与引用图，提供文件范围、定义/引用种类、索引版本和实际位置；混合 grep 保底。按 JS/TS、Python、Rust/Go 任务分层评测，再决定嵌入模型。**代码 embedding 是候选后端，不是能编码的必要前提。** 只有在词法/符号检索明确漏掉语义相关代码、且真实任务收益超过索引/隐私/费用成本时再接入；不能把通用向量库改名为 code RAG 就宣称提升。

### 2. 可靠工具行动

12 个生产原生工具已有统一表（[H04]），本地实际 ModelRequest 还包含 Runtime 注入的 `ask_user`，共 13 项；`ask_user` 是核心交互阶段，不是第 13 个普通 ToolDefinition。只读、版本化编辑、执行与验证已有工程约束。

建议强化策略层“失败类型 → 下一步”：参数错误按 schema 修正；stale SHA/锚点冲突重新读取；临时网络错误在 provider 预算内退避；测试失败定位原因；拒绝/权限错误停止该动作；重复相同失败达到预算后报告具体阻塞。不要把同一条调用换路径重试以绕过拒绝。工具指引应靠近工具定义，防止 schema 与 prompt 漂移。

### 3. 规划、迭代与自我修正

`coding-v1` 已要求 inspect→implement→verify→repair，并已有 `update_plan` 和 WorkingState（[H01]/[H11]）。下一候选应加强“因果假设、验收命令、失败事实和待验证项”，避免无限空转；简单修改不强制长计划。

应重点验收跨文件修复、第一次检查失败后的二次修复、用户中途纠正和工具输出截断；不能仅按回答是否包含“测试通过”评分。

### 4. 工程质量

现有 v1 已覆盖保护用户改动、最小变更、按项目命令验证、不造输出。继续增添同义规则只会加长 prompt。

需要补充的是任务实证：依赖变动是否必要、调用方/错误分支是否覆盖、已有失败是否准确区分、最终 diff 是否含无关改动、修复是否通过独立验收。测试/类型/lint/格式检查按仓库声明发现；不默认每个项目都支持同一组命令，也不为一次无关文字修改重复全仓测试。

### 5. 上下文、记忆和继续任务

[H08]/[H09] 的默认压缩是多阶段状态机：大结果 offload、去临时内容、微压缩、WorkingState 摘要；语义 `summarize` hook 存在，但默认组装没有接模型 summarizer。已有 rehydration，不能写成“没有压缩/不能恢复”。

[H13]/[H14] 已有按作用域检索、评分、冲突处理及半可信注入，且实际请求回归覆盖 JSONL/SQLite 和中文查询。各 profile 默认 memory=false，需要配置启用；本地 test-profile 观察与此一致。现有原生工具中没有模型可按需调用的 memory/session_search 接口，和“完全没有记忆系统”是两回事。

建议复用既有 hook 做有预算的摘要 challenger，保留最新目标、用户纠正、已验证/未验证事实、路径与版本、精确失败命令和退出码、待办、artifact 引用；摘要不能把工具文本提升成指令。长期记忆只写稳定约定、偏好和可复用经验，当前待办留在 WorkingState/会话；按需检索应首先复用已有 store、scope 和信任标签，工具未接入时不在 prompt 中承诺它存在。

可直接借鉴的记忆细节有两组：Hermes 的 [HM09] 在会话开始冻结一个很小的 MEMORY/USER 快照（所读实现默认字符预算 2200/1375），会话内更新通过工具结果体现，下次会话再刷新；[HM03] 明确把临时进度留在会话，把稳定事实放记忆，把可复用过程放 skill。Codex 的 [CX06] 则采用摘要→索引→1–2 份相关历史的逐层读取，建议约 4–6 次轻量查询后回到主任务。可取的是分层和有限预算，不能照搬字符配额或把最新用户纠正延迟到下次会话。

### 6. 评测和反馈

Harness 已有真实 runner、冻结实验和评测门，不另造一套只看文字的评估。离线桩验证工程契约，真实模型 paired eval 才判断策略质量。对照至少区分 legacy、现有 coding-v1、新候选，不能把旧 v1 的收益重复算到 v2。

记录真实仓库任务是否完成、首次编辑和最终编辑成功率、无效工具调用、同错误重复、独立测试、恢复后的任务保持、无关改动、人工介入、tokens/时延/费用；缓存报告必须另有已观测覆盖率，不把缺字段当 0。

### 7. 体验与集成

已有 Web、进度、审批和变更能力；前一轮 Web 修复证据属于前一轮，不能当成本轮 IDE 验收。后续应优先把当前失败步骤、真实命令/退出码、diff、是否验证、取消/继续展示正确，再按需求接 IDE；UI 显示“完成”必须对应 Runtime 事实。自动回滚也要保护用户已有和并发改动，不能直接 reset 整个工作区。

## 本轮本地验证：确认了什么

[探针](../scripts/research/coding-agent-research-20261015/probe.mjs)加载固定、干净基线重新构建的生产模块，先检查版本和关键源文件字节一致；provider 请求通过真正的 loopback HTTP/SSE，不替换 fetch。结果见 [probe.json](evidence/coding-agent-research-20261015/probe.json)。

| 检查 | 实际观察 | 判定 |
| --- | --- | --- |
| OpenAI `prompt_tokens_details.cached_tokens=128` | 总输入 200、输出 20 保留；cache read 未返回 | 确认观测缺口 |
| DeepSeek hit=128、miss=72 | 总输入 200、输出 20 保留；命中明细未返回 | 确认观测缺口 |
| 接口明确 cached_tokens=0 | 0 也被丢弃，无法区别未提供明细 | 确认观测缺口 |
| 接口没有缓存明细 | 缓存值缺失 | 正常控制组；不能记为 0 |
| 默认策略真实 SDK 请求 | legacy 正文 517 字符；显式 coding-v1 正文 4403 字符；各有 12 工具加 ask_user | 接线确认，非模型质量判定 |
| 默认 test profile | 没有 memory store、没有 memory/session_search 原生工具 | 接线确认；其他 profile 默认值另据 [H05] |
| 工具顺序/重复 | v1 正文不因 toolNames 顺序、重复而变化 | 既有稳定性控制通过 |

缓存解析根因：[H17] 的 UsageSnapshot 有可选 cache 字段，但 provider 的 Usage 和 [H18] 流解析只保留 prompt/completion 总数。这不证明 DeepSeek 服务端没缓存，也不证明现有费用一定算错。修复需区分 provider 方言、字段缺失与 0、输入总量与缓存子集，避免 double count；不得为了显示命中率虚构服务器数据。

初版研究探针误把普通工具表当成完整模型工具表，因实际注入 `ask_user` 而失败；已按真实核心交互契约修正探针，未更改生产实现或放宽普通工具校验。

基线 `pnpm typecheck` 通过。六个相关既有测试文件 **89 PASS、0 FAIL、0 SKIP**，覆盖提示词、策略、memory 生产接线、压缩、rehydration headroom、SSE footer。此次没有重跑上轮全量 9707 项，也不把上轮成绩标成此次结果。来源复核 71 文件、五仓库通过。详细复跑与原件见[验收索引](evidence/coding-agent-research-20261015/README.md)。

## 实施顺序和候选设计

详细的“做什么、怎么做、怎么验收”见 [实施规格](../plan(20261015-104912).md)。当前状态：R0 研究验收完成；C1–C7 尚未实施。

1. **C1/P0：缓存 usage 穿透和观测。** 先修可复现缺口，测试接口原件→provider→Runtime→Web/CLI/评测记录。不改变默认 prompt 或供应商协议。
2. **C2/P0：编码任务基线与失败聚类。** 在现有 runner 预注册固定真实任务和独立验收，建立 legacy/v1 的可比较基线。
3. **C3/P0：coding-v2 候选。** 在 v1 上只补真实短板：任务相关定位、失败分类/恢复预算、当前用户目标、证据化完成。工具按实际能力贡献指引；[候选核心草稿](coding-v2-proposal.md)是设计材料，未安装、未评测。
4. **C4/P1：长任务摘要与按需记忆。** 通过现有 ContextPipeline/Compactor 和 memory 接口分步实验；先证明信息保真与恢复，再评测 token/任务收益。
5. **C5/P1：跨语言代码检索。** 以 Aider 的 tags/引用图/预算设计为参考，先增强候选召回和排序，再按需要引入语言服务或代码 embedding。
6. **C6/P1：缓存友好的确定性组装。** 在 C1 有观测后测实际 wire payload 的稳定前缀；把日期、git snapshot、任务状态放到合适的动态区域。不能为命中率漏掉最新约束，也不把 Anthropic 标记发送给 DeepSeek Chat。
7. **C7/P2：工作流可见与 IDE。** 在策略/工具闭环稳定后，根据真实失败改善 diff、验证状态、取消/继续和编辑器导航。

每项独立版本化并做消融；策略、检索、记忆、压缩不能一口气混成一个不可归因的候选。维持 Runtime freeze、权限链、现有恢复指纹和冻结实验源码绑定。未验证相对收益之前保留现有默认值；“能调用工具”“离线测试通过”“达到 Codex 水平”是三个不同结论。

[H01]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/agents/src/coding-prompt.ts

[H04]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/tool-names.ts

[H05]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/profiles.ts

[H08]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/context/src/compaction.ts

[H09]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/context/src/pipeline.ts

[H11]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/contracts/src/working-state.ts

[H12]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/core/src/runtime/context-controller.ts

[H13]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/memory/src/retrieval.ts

[H14]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/memory-search-production.regressions.test.ts

[H15]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/tools/src/symbol-index.ts

[H17]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/contracts/src/model.ts

[H18]: https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/model/src/openai.ts

[CX02]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/gpt-5.2-codex_prompt.md

[CX03]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/prompts/templates/compact/prompt.md

[CX04]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/src/compact.rs

[CX05]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/src/client.rs

[CX06]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/ext/memories/templates/memories/read_path.md

[HM02]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/system_prompt.py

[HM03]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/prompt_builder.py

[HM04]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/coding_context.py

[HM07]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/context_compressor.py

[HM08]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/memory_manager.py

[HM09]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/tools/memory_tool.py

[PI02]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/system-prompt.ts

[PI03]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/tools/read.ts

[PI04]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/compaction/compaction.ts

[CC01]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/README.md

[CC02]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/constants/prompts.ts

[CC03]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/constants/systemPromptSections.ts

[CC04]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/services/compact/prompt.ts

[CC05]: https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/services/compact/microCompact.ts

[DS01]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/system-prompt/src/index.ts

[DS02]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/persona/src/index.ts

[DS03]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/summarizer.ts

[DS04]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction/src/tool-pairing.ts

[DS05]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/config.ts

[DS06]: https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/index.ts

[Z04]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/context/builder.ts

[Z07]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/system-message-compat.ts

[Z08]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/transform.ts

[Z09]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/runner-normalization.ts

[A02]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py

[A03]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_prompts.py

[A05]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py
