# Harness Agent：上下文传输与检索/导航优化验收报告


2026-10-05 完成。R1–R4 已验收；冻结源码 `de346b9` 的全部18门通过，原生 main 源码发布已核对。后续提交仅含完成文档、证据及归档原始 CRLF 的字节属性，生产代码、测试与研究脚本保持冻结版本。

## 源码与原始失败

- 基线：`18f162bf7f12c4b8e8cebcebede4034dd1f3efb7`。
- 实施前计划：`fbe5098c43060fd066bd5fbdaa4a4d1612abdeb6`；[不可变规格](../../plan(20261004-131935).md)、[任务](../../tasks/AGENT-EFFICIENCY-20261004.md)。
- 首次冻结：`91967f4dd2442b3d1979dee1c2b165d376c8895c`，**FAIL**；全仓8,481 PASS/3 FAIL/12 skip、exit1。旧wire断言未计system与offset。其 [manifest](agent-next-20261004/raw/frozen-91967f4/manifest.json)、[full.log](agent-next-20261004/raw/frozen-91967f4/full.log) 与原专项/perf保留为历史观察，不替代新源码。
- 重冻源码：**`de346b90dcbf97c9591ae2786e46e80fd0a4e05c`**。只补Core测试roles/offsets、exact system body和durable history无system断言；生产Core不动。3生产模块与919同SHA-256，Runner新增wire门。

新 [冻结 manifest](agent-next-20261004/raw/frozen-de346b9/manifest.json) 绑定clean source、source/dist前后hash、argv/exit/log hash；原始文件已复制归档并按字节校验。

## R1：系统上下文确实进入 HTTP

基线HTTP5控制中两个非空system丢失；CLI记忆反馈retrieved/injected/used各1而wire只有user。现将非空system原字节前置，空/缺省不新增，历史及assistant/tool配对保持、发送前原协议检查保留。

原正式 RED：13 tests 中 8 FAIL/5 PASS/0 skip；失败原件保留。**de346b9 新回归联合 63 PASS/0 skip**（R1 13、R2 29、R3 21）；新增相关 **wire 集成门 8 PASS/0 skip**，覆盖Runtime→provider→strict stub；system仅在wire，配对合法。

新源码生产 [HTTP report](agent-next-20261004/raw/frozen-de346b9/r1-http/result.json)：**7 cases、10 次 loopback HTTP requests 全 PASS**。direct5；实际CLI main memory/tool-loop2请求；Web main普通/tool-loop2turns/3请求。准入AGENTS/记忆送达、拒绝正文缺席；后续请求保持system。durable events CLI29/Web36，Web默认memory-off。HTTP为本机确定性服务。

dirty HTTP首次FAIL来自TOOL_LOOP查询未命中RecallProbe seed和event decoder；失败oracle/请求/事件原件保留在`raw/r1-http-exploration-fbe5098/`，修正观察单列v2目录，不冒充clean验收。

## R2：去重少做重复 tokenize，结果等价

一次retrieve内缓存kept token Set；ASCII/Jaccard、排序/首conflict/suppressed、完整kept后TopK保持。reference为18f原字节；不改跨调用、SQL/search、排名/准入/生命周期。原 RED：96 候选 tokenize4,656 次，29 tests 中 1 FAIL/28 PASS。

新 [差分 report](agent-next-20261004/raw/frozen-de346b9/r2-differential/report.json)：**261 cases PASS**（5控制+256seed），items/scores/suppressed/顺序完全同等；含非传递/TopK外冲突、空token/同分稳定、各准入参数/缓存隔离。4 个确定性工作量 fixtures 每个2,000候选：

| 工作量 fixture | tokenize 基线→候选 | pair comparisons 基线→候选 |
| --- | ---: | ---: |
| disjoint / partial-common / worst-common（三组） | 2,001,000→2,000 | 1,999,000→1,999,000 |
| dense-conflicts | 3,999→2,000 | 1,999→1,999 |

全部完整结果相同，tokenize≤N；**pair 最坏仍 O(n²)**，额外局部 Set 内存如实保留，SQLite supplement 仍扫描过滤后的 live rows。

新 [串行 paired 性能 report](agent-next-20261004/raw/frozen-de346b9/r2-performance/report.json)：固定10,000条，fixture固定digest见report。A=冻结旧算法，B=built production；串行AB/BA、2warmup+5samples，无其他build/tests并行；计时完整retrieve，排除构造/序列化/hash。8组合等价：

| backend | query | 基线 median ms | 候选 median ms | ratio 候选/基线 |
| --- | --- | ---: | ---: | ---: |
| jsonl | warm-fts | 44.854 | 42.705 | 0.952080 |
| jsonl | chinese-substring | 538.266 | 81.831 | 0.152027 |
| jsonl | structured-do | 50.428 | 49.776 | 0.987079 |
| jsonl | actual-miss | 33.907 | 32.695 | 0.964247 |
| sqlite | warm-fts | 66.175 | 73.148 | 1.105369 |
| sqlite | chinese-substring | 616.971 | 97.043 | 0.157289 |
| sqlite | structured-do | 65.325 | 64.482 | 0.987096 |
| sqlite | actual-miss | 49.961 | 49.944 | 0.999649 |

中文完整 retrieve：JSONL **538.266→81.831ms，减少84.80%**；SQLite **616.971→97.043ms，减少84.27%**，均达预注册≥50%门限。SQLite warm本次median高10.54%，5samples如实保留，不宣称所有查询更快或稳定模型吞吐/质量；工作量与等价门同时通过。

追加 [warm 补测](agent-next-20261004/raw/warm-followup/run-de346b9-01/report.json) 在全仓结束后串行执行，方案在采样前固定为4预热+15对：完整retrieve中位数66.467→66.743ms（+0.415%），配对差中位−1.104ms，仅6/15候选更慢；相同search函数的A/A控制也出现−16.536～+14.102ms差值，排除search后的独立去重诊断5.869→4.980ms。完整结果、原正式报告与只读数据库字节均不变。[独立复核](agent-next-20261004/raw/review/runtime-review-final-de346b9.json) 未复现预注册定义的稳定warm回归，本次不阻塞完成；原5样本+10.54%继续保留，不能确定其具体调度/GC原因，也不宣称warm或所有查询普遍提速。

新 [实际 Harness report](agent-next-20261004/raw/frozen-de346b9/r2-harness/report.json)：JSONL/SQLite各18场景，**36 paired cases / 72 Harness scripted runs 全 PASS**；memoryRefs、实际准入的 advisory 正文及 outcome 同等（不比较含动态身份/目录的整体 request.system），scope/session/unsafe/structured/inactive/deleted/miss拒绝、owned session允许/default-off不注入。baseline仅临时bridge更换retriever/import；Core admission保持、HTTP另由R1验收。

cache/indexed/stress原件保留，indexed未合入；首批indexed/stress CPU并行，concurrency-note明确timing仅探索，后续sequential/919数据均不替代本次paired。

## R3：导航真的按深度/数量停止

walkFiles仍Promise<void>，false传全祖先；grep满cap即停。repo_tree真实Dirent含empty、dir/file共计cap、root-relative depth剪枝/path排序。祖先lstat且计cap、空子树[]，trusted root alias允许、后代symlink不跟随；编排/权限/Sandbox保留。

原RED19tests=12FAIL/7PASS/0skip、probe4FAIL/3PASS；原件保留，当前21新回归通过。新 [生产导航 probe](agent-next-20261004/raw/frozen-de346b9/navigation-production.log) 经实际工具编排与文件系统 **7 checks全PASS**：

| 场景 | 原基线 | de346b9 |
| --- | --- | --- |
| tree depth1 | readdir131，entry0 | readdir1，66目录含empty，descendant reads0 |
| tree depth0 | readdir131，entry0 | read0，entry0 |
| tree cap1 | readdir131，entry1 | readdir1，entry1 |
| grep cap1 | readdir131，首个命中 | readdir2，同首个命中 |
| ignore/generated/VCS/目录symlink | 已通过 | 保持无隐藏/外部条目 |
| outside Sandbox / permission deny | denied/read0 | 保持denied/read0 |

## Web、安全与联合验收

de346b9 [Chromium report](agent-next-20261004/raw/frozen-de346b9/joint-browser/browser-result.json)：**27 cases/77 assertions、0 failed、0 browser errors**，桌面1440×900/手机390×844。13生产链+1真实socket中断+13受控协议。实际Harness/Gateway/Web/权限/Sandbox/Verifier+scripted provider覆盖发送/历史/复制/主题/移动、审批/越界拒绝/取消/隔离/SSE重连/exit7；受控回放/污染/IME/XSS/幂等/空工具泡不代表模型能力。

同源码 **安全19files/2,135tests PASS、0skip**；typecheck/build/docs:verify通过。

| 门 | 最终结果 |
| --- | --- |
| 新源码全部18门 | PASS，前后clean与source/dist字节一致 |
| 具名完整全仓 | 459 files PASS/1 skipped；8,484 tests PASS/12 skipped；exit0 |
| 同run strict usage | PASS，7能力全部observed；run `agent-next-linux-de346b90dcbf-1791160665881839487` |
| 独立运行时复核 | [PASS原件](agent-next-20261004/raw/review/runtime-review-final-de346b9.json)，逐日志/源码/产物/补测验证 |
| 三个旧artifact roots与diff-check | PASS，原始argv/exit/hash见manifest |
| 新原始归档 | [索引](agent-next-20261004/artifact-index.json)536 files/33,432,643 bytes；逐文件SHA-256与bytes校验PASS |
| 原生main源码发布 | [PASS原件](agent-next-20261004/raw/publication/source-verified.json)，本地/Git ls-remote/API均为 `de346b90dcbf97c9591ae2786e46e80fd0a4e05c` |
| Windows | NOT_RUN；没有复用其它源码的CI结果 |
| paid/真实模型质量/promotion | 0 / NOT_RUN / NOT_RUN |

全仓 [full.log](agent-next-20261004/raw/frozen-de346b9/full.log) 与 [strict usage](agent-next-20261004/raw/frozen-de346b9/usage-audit.log) 为同次冻结验收。12项既有skip：[源码字节及原始摘要核对](agent-next-20261004/raw/review/skip-lineage-de346b9.json)：executor Windows进程7项、r96 Windows边界3项、历史setup替代证明分支1项、opt-in release E2E1项；四个文件与18f基线原字节一致。本轮新增63项及相关wire8项均0skip。

[归档后独立复核](agent-next-20261004/archive-review.json)核对portable原字节索引、完成文档与冻结实现。完成文档的Git提交在测试源码之后，最终main提交号由原生Git/curl发布后核对；没有在报告里自引用尚未生成的提交SHA。只为归档旧导航CRLF快照增加专用whitespace属性，未改变源代码规则或文件字节。

raw保留baseline、RED、首次完整全仓FAIL、失败HTTP观察、未采用prototype及CPU并行说明，原件不覆写。可重建的大型SQLite/10k fixture排除，生成器、固定参数/digest、实际结果/请求均保留；具体清单见索引与原库存。原始文件以-text防止Windows换行改写，Git staged blob也按同SHA校验。

本轮完成计划见 [plan.md](../../plan.md)。工程改善不从scripted taskSuccess推导外部模型质量；默认memory/delegation/champion策略保持原合同。
