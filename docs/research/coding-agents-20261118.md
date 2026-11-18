# Coding agent 源码对照与 Harness 落地

以 Harness main `20297ccb4da5b5255850d78e5ad9ca28c83ff903` 为基线，沿代码定位、工具结果、长任务恢复和缓存四条链路复核 12 个实现。来源清单记录实际读取的文件、提交与 SHA-256。Claude Code 一栏来自社区快照，仅比较可见机制。 [源码清单](../evidence/upstream-study-20261118/sources.json)

| 项目 | 源码里的做法 | 对 Harness 的结论 |
| --- | --- | --- |
| OpenCode | `ReadTool.lines` 在字节上限处用可捕获的停止信号结束文件流，保留 EOF 处理。历史剪枝另留近期工具结果和受保护工具。 | **已采用流式提前停止思路**。Harness 在读到下一行的证据后也停止行数受限的读取，另保留需要精确统计和整文件版本的模式。 |
| Aider | `RepoMap.get_ranked_tags` 用语法标签建引用图，按提及的文件和标识符构造个性化权重，委托 PageRank。 | **已优化现有 repo_map 的个性化排名**。多个无出边文件共享同一分配向量，每轮先合计权重再分配。保留查询权重、边、范围及预算。 |
| pi | `read.ts` 以流式解码选取目标行，独立计算显示字节和全文件行数。提供可继续的截断说明。 | 保留已借鉴的完整行契约。新增模式区分实际扫描量与完整文件统计，适合 agent 先调查再做带版本的编辑。 |
| DeepSeek Harness | `buildWindow` 仅收集需要的行，仍扫描精确总行数。结果剪枝用带来源引用的替换节点覆盖模型视图。checkpoint policy 在模型和工具边界协调持久化。 | 保留精确分页和现有 checkpoint。下一轮可在真实子任务重启对照里测试证据重取和恢复，以决定是否需要更细的剪枝层。 |
| Codex | `compact_retained_tool_outputs` 通过来源元数据判定哪些独立工具输出跨窗口保留。`compact.rs` 处理这些结果和用户消息的边界。 | 当前已有可重取的 artifact 和结构化工作状态。适合先测“恢复时是否选回关键证据”，再考虑给特定证据增加保留优先级。 |
| Cline | `budget-projection/project.ts` 用 tool ID 构造消息闭包，保护未解决调用所在的尾部。`basic-compaction.ts` 优先保留用户输入及近期回合。 | 用同样的调用配对不变量做长任务压力评测。当前已有 checkpoint 和 call/result 校验，可直接继续复用。 |
| Gemini CLI | `read-file.ts` 给出显示范围和下一次读取参数。`chatCompressionService.ts` 区分近期调用、防止大历史增长，并给超限结果保留工件入口。 | 窗口结果把续读位置放在内容之前。后续可用“失败命令的关键诊断仍能重取”来比较压缩候选。 |
| Goose | `compact_messages` 用消息可见性区分模型投影和用户记录。自动压缩保留当前用户输入，并能把部分回合上下文带回。 | 适合作为手动与自动压缩对照，重点检查原会话可见内容、当前用户目标和工具配对。 |
| Hermes | `MemoryManager.prefetch_all` 从用户 query 去除技能脚手架。外部 recall 有超时，同 provider 的卡住调用未结束时跳过重复请求。 | 值得评估慢记忆后端对首个模型请求的影响。先记录超时、重叠请求和召回命中，再决定是否需要该类隔离。 |
| Continue | retrieval pipeline 的 embeddings 和 reranker 可选，两类索引检索都接收目录过滤。 | 扩展检索前可用现有 30-query 集合测 lexical/syntax 与混合策略的 recall@5、延迟及成本。当前范围检索已能覆盖重点目录。 |
| ZCode | 适配器优先采用实际 usage。对已包含缓存 token 的 input 不重复相加，缓存命中率缺 provider 数值时按同分母推导。 | Harness 已解析缓存计数。应按 provider 对照真实 wire usage 和同一固定前缀的冷暖两组，才能判断命中率与费用。 |
| Claude Code 社区快照 | `microcompactMessages` 区别冷缓存时清理旧结果与热缓存时尝试 cache edit，后者受模型和主线程能力控制。 | Cache edit 是 provider 特定能力。以可重放真请求和 capability 检查作为候选准入条件。 |

## 已落地的用法

`read_file({path:"src/handler.ts",offset:210,limit:30,scan:"window"})` 读取完整行。到达页边界后只需确认还有内容，就会结束描述符读取。使用 `nextOffset` 继续。若 `scanComplete=false`，`scannedBytes` 表示实际读取的字节，完整文件统计缺省。偏移按行计数，读取深处的范围仍要经过前缀。超长行给出原有字节上限提示。

准备改动时用 `versioned:true` 获取整文件 SHA-256，再传给 `edit_file.expectedSha256`。同时提交 `scan:"window"` 与 `versioned:true` 会得到可修正的参数错误。模型从实际工具 schema 和描述发现窗口模式，已经持久化的 coding-v2 系统提示词字节保持一致。

`repo_map` 调用方式保持一致。个性化分配的运算从每个无出边节点逐个更新整图，变为每轮一次求和、一次向量分配和沿实际引用边传播。排序分数允许浮点舍入差异。仍应把边当作待核对的引用候选。

## 实测与验收边界

- 同一真实文件、同一四行，生产 ToolOrchestrator 下的原生读操作由 **9,000,037 B 降为 65,536 B**。默认分页与版本化分页仍读取 9,000,037 B。验证了 CRLF、空行、多字节边界、巨型行、取消、关闭和拒绝权限。
- 两个实际 HTTP/SSE 回合分别用默认分页和窗口分页，均走读取、版本化读取、条件编辑及实际 Node 检查，达到 `verified_complete`。固定脚本模型给出同一操作序列。
- 在 500 个节点、475 个无出边节点的固定稀疏图中，12 次迭代的整图分配项从 2,850,000 降为 6,000，归一化前后分数最大差约 3.2e-17。5000 节点为扩展压力测试，当前 repo_map 默认语法索引上限为 500 文件。计时仅涵盖排名计算。 [配对脚本](../../scripts/research/upstream-window-20261118/rank-paired.mjs)
- 使用已有 30-query 检索验收比较实际范围、引用图与预算。真实模型的任务成功率和 API 缓存命中率仍待模型对照。
