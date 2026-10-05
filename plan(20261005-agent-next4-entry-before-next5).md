# Harness Agent：当前执行计划入口 — 记忆查询解析复用

2026-10-05（Asia/Shanghai）。基线 `7dce382bf4e8a670d5995c4be879769f991cca44`。生产修改前提交计划；[上一轮入口](plan(20261005-agent-next3-entry-before-next4).md)保留原字节；不可变规格 [plan(20261005-220536).md](plan(20261005-220536).md)；任务合同 [AGENT-NEXT4-20261005.md](tasks/AGENT-NEXT4-20261005.md)。

## 审查与实测依据

当前JSONL与SQLite literal supplemental匹配每个候选都重新lowercase/拆分同一query。干净基线1500行、2577字符/128词的miss查询，两backend均有1500次query lowercase与1500次lexical tokenize。查询解析是请求不变量，工作随候选数重复增长；工作基准要求每次search至多1次解析，当前实测失败，来源明确在Runtime search-text循环而非模型策略。符合AGENTS.md Runtime Freeze中基础设施benchmark failure的维护例外；不改Runtime架构或Agent策略。计时仅报告，不设不可靠speedup断言。最初计数夹具在observer中调用query.toLowerCase造成4501的错误lower计数，已保留并修正；有效基线计数1500/1500。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- | --- |
| Q1 查询解析复用 | 一次search仅解析一次query | search-text增加call-local prepared matcher；原matchesMemoryQuery作为兼容wrapper。JSONL/SQLite进入搜索时构造matcher复用于候选；不保留跨请求缓存，SQLite FTS query/ranking不改 | 正式RED→GREEN；1500候选有效query lower/tokenize各≤1，候选content tokenization语义不改；SQLite FTS自己的query tokenize单独计量，不混成lexical重复 | DONE |
| Q2 搜索合同不变 | 完整命中、顺序、过滤、安全和跨调用更新保持 | 原literal substring OR全部query token whole-word条件按相同顺序执行；保持JSONL不trim query、SQLite既有trim query差异；空白无匹配、strategy只When/Do/Avoid，metadata不能造命中 | 用独立冻结旧算法覆盖Unicode/标点/空白/大小写/多词/token重复/legacy字段；两backend完整对象与旧search顺序对照，FTS可用/失败控制、删除/type/scope及fresh-query更新；既有search/retrieval/security回归通过 | DONE |
| Q3 冻结工程验收 | 同一clean源码完整验证 | 提交实现、新测试、复跑probe/runner后冻结；typecheck/build、新增及相关集成、生产query probe、CLI/Web/browser/security、一次全仓与同run strict usage | 新增无skip/todo；全仓≥8713既有PASS+新增、≥470文件+新增，12既有skip来源不变；same-run7能力observed；实际生产probe工作预算通过、完整结果对照，source/dist hash前后一致 | DONE |
| Q4 证据与发布 | 可审查结果与main一致 | 保留baseline/RED/失败与最终原件；SHA256索引及staged Git blob核对，完成docs单独commit；仅原生Git/curl非force发布 | plan DONE、报告tested source与docs区分；旧证据完整性、docs/diff检查PASS，本地clean且Git/API远端SHA一致 | DONE |

## 边界与限制

允许生产路径仅 packages/memory/src/search-text.ts、memory-store.ts、sqlite-memory-store.ts。不改Core、Orchestrator、Permission、Sandbox、contracts、SQL schema/索引/FTS排序、记忆评分/admission、安全门、既有测试或依赖。不解决SQLite supplemental全表扫描/行hydration，JSONL读盘和content分词仍随行数增长，不宣称整个search复杂度O(1)。新增回归/研究脚本/计划/任务/原证据属性允许。无跨请求缓存，不能陈旧复用不同query或修改后的条目。

本轮不新增子智能体；由主代理自行复核。真实模型质量、策略promotion和Windows原生运行NOT_RUN，paid calls=0。网络环境使用已读cloud-environment-runtime技能核对，当前unrestricted/enforced，无模型secret；GitHub禁止连接器，仅用户已授权token的原生Git/curl，不写凭据进仓库。

## 完成记录

受测源码 `e40895c21ae6770e729ac6745a7c59fe291f382c`，15个冻结门全PASS。新45项无skip，全仓8758 PASS/12旧skip，同run strict usage7项observed。1500条记忆的query解析从1500次降到1，完整旧结果/顺序及实际Harness、CLI/Web/browser27场景通过。

[验收报告](docs/evidence/agent-next4-20261005.md)含原始计数修正、实测与限制；[完成入口快照](plan(20261005-agent-next4-completed).md)保留本入口。受测源码原生发布已核对；完成docs单独commit，生产/测试/脚本保持受测版本，完成文档检查、staged bytes及最终main SHA在收尾发布中执行。原始规格不改。
