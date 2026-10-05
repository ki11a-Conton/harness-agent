# Harness Agent：当前执行计划入口 — 模型上下文与检索/导航效率

详细实施前规格：[plan(20261004-131935).md](plan(20261004-131935).md)。2026-10-04。
基线：`18f162bf7f12c4b8e8cebcebede4034dd1f3efb7`。本计划在生产代码实施前提交；上一轮入口原样保留为 [历史完成入口](plan(20261004-context-memory-entry-before-next).md)。

执行完成：2026-10-05。冻结验收源码 `de346b90dcbf97c9591ae2786e46e80fd0a4e05c`，18门全部PASS；全仓8,484 PASS/12既有skip，新增63与wire8均0skip，同run strict usage通过。中文完整检索中位耗时JSONL下降84.80%、SQLite下降84.27%；原warm慢10.54%的观察保留，追加15对未复现稳定回归。首次全仓失败及旧wire断言修正原件均归档。

完成记录：[验收报告](docs/evidence/agent-next-20261004.md)、[逐字节索引](docs/evidence/agent-next-20261004/artifact-index.json)。生产Core不改；本次只补相关wire集成测试的system与精确索引。完成文档与归档属性在测试源码之后单独提交，最终main原生Git/API核对后收尾。

## 已审查、实测的依据

- 生产 OpenAICompatibleProvider 仅序列化 request.messages，忽略合同中的 request.system。真实 HTTP 的5场景中，两个非空中文system场景均缺失；历史system/空/缺省控制通过。实际 CLI main 显式开启memory后，HTTP只有user消息，虽然记忆反馈已记录retrieved/injected/used各1。基线原始失败请求保留。
- 固定10,000条安全记忆（与上轮同fixture/probe哈希）：中文2,000命中，JSONL完整retrieve628.896ms、SQLite594.739ms。每对候选重新tokenize既有kept条目；2,000条互不相似项需要2,001,000次tokenization。ignored cache-only探索已保持8个生产结果完全等价，并明显降低中文检索耗时；正式指标仍须冻结实现成对复验。
- 实际 ToolOrchestrator/PermissionEngine/Sandbox导航fixture：repo_tree depth1返回空而readdir131次；depth0/maxEntries1也readdir131；grep maxResults1返回正确命中但仍readdir131。66个直接目录中包含空目录。权限/越界拒绝与忽略生成物、符号链接控制已通过。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- | --- |
| R1 模型真正收到上下文 | 修复系统指令、有效项目上下文和记忆在生产HTTP请求中丢失 | 在OpenAI wire序列化中将非空request.system原字节放到首个system message；undefined/空字符串不新增；保留全部历史消息及顺序、已有system、assistant/tool配对。仍在发送前执行现有wire协议检查；不修改Core和上下文准入 | 新回归先RED后GREEN；中文/多行/空/缺省/历史system/工具调用配对/无输入变异；真实provider HTTP、CLI opt-in记忆和Web默认system进入实际wire；允许AGENTS正文可见、注入拒绝正文不可见；同一次tool loop后续请求保持system且合法配对；重试/取消/诊断无泄露控制通过 | DONE |
| R2 减少记忆去重CPU | 减少重复字符串处理，保持策略结果完整等价 | 只在一次retrieve调用内保存kept候选token Set，每个候选只分析一次。保留原ASCII token规则、Jaccard阈值、排序、首个conflict、全部kept集合及最后TopK；不跨调用缓存，不改SQL/search/默认策略，不引入倒排或新依赖 | 确定性N条已评分候选tokenization≤N；旧算法作为独立oracle，固定/随机/非传递冲突/空token/相同分/各scope/session/lifecycle/safety/minScore/k结果items+scores+suppressed全部相同；实际Harness请求memoryRefs/body同等；同10kfixture基线/候选两backend中文完整retrieve中位耗时减少≥50%，若达不到不得标DONE；报告dense最差场景仍可能O(n²)、额外Set内存和SQLite扫描未优化 | DONE |
| R3 导航真实有界 | 达到结果上限后停止全树遍历，目录树能返回真实空目录 | 保留walkFiles公开Promise<void>和既有调用合同，用内部停止状态/递归返回传播全局停止；grep命中cap立即停止。repo_tree直接处理Dirent目录/文件，二者共同计数，在root-relative绝对depth边界停止下降，保留排序和忽略/symlink规则 | 同生产fixture：depth1返回66个目录（含empty），readdir1；depth0输出空、read0；cap1总entry1、read≤1；grep首个命中不变、read≤2；多层stop、symbol fallback、subpath/mixed entries、missing/unreadable/empty控制；真实ToolOrchestrator下权限deny/outside拒绝read0，ignore/generated/directorysymlink不访问 | DONE |
| R4 联合验收与完成 | 冻结源码、归档原件并同步main | 同一clean源码运行定向model/memory/tools/Harness、typecheck/build/security/docs、真实HTTP/完整Web浏览器和固定成对性能探针；一次具名全仓与strict usage-audit，独立复核；完成文档与源码分开标记，原生Git/curl发布 | 全部门通过；新增正式回归0skip，既有skip如实列；全仓退出码与源码/原始日志hash对应、usage绑定同run；baseline/RED/探索与实际FAIL不覆盖；portable bytes/sha256索引通过；本地/原生ls-remote/API main SHA一致 | DONE |

任务：[AGENT-EFFICIENCY-20261004.md](tasks/AGENT-EFFICIENCY-20261004.md)。原始审查：`.ci/agent-next-20261004/audit-config/`、`audit-memory/`、`audit-tools/`；最终证据复制到`docs/evidence/agent-next-20261004/raw/`并逐文件索引，不把可再生成fixture工作目录冒充完整归档。

## 范围与约束

R1：packages/model/src/openai.ts及相关回归/真实HTTP探针。R2：packages/memory/src/retrieval.ts及回归/性能脚本。R3：packages/tools/src/navigate.ts及相关回归；包装层/schema只在明确参数合同需要时小改。相关Harness/CLI/Web integration验收、研究脚本和文档可新增；Core、权限、Sandbox、验收门、记忆写入/生命周期/召回/排名策略不改。

R1/R3来自已实测确定性correctness缺陷，R2来自可复现基础设施CPU成本，符合AGENTS Runtime Freeze例外。本轮不启用默认memory/delegation、不添加Web模型/记忆设置、不推广champion、RAG或tokenization策略。新增真实空目录输出是目录工具正确性修复，不为保留已知错误而伪造目录。

性能门关注中文完整retrieve，固定fixture哈希、相同输入/时钟/结果与交错AB/BA采样；其他warm/structured/miss/密集冲突如实记录。时间受环境影响，确定性工作量门同时必过，不以单次噪声作收益断言。若有明显回归或不等价，停止完成标记并修复/记录。

线上模型API未配置，本轮使用本机OpenAI兼容确定性服务与scripted provider检验请求/工具/状态闭环；paid=0，realModelQuality/promotion NOT_RUN。HTTP上下文正确与工程耗时降低不能证明真实模型任务成功率提高。GitHub只走原生Git/curl，凭据不保存到代码或证据。
