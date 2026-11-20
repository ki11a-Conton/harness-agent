# 仓库检索的精确符号重排

基线为 `bb622e6d7d02853053a07d04abbb4a9c40d39cc1`。现有 30 条标注查询的相关代码图 Recall@5 为 30/30。需要单独测量相似符号竞争，因为多次子串命中的文件可能把明确指定的定义挤出前五。

- Continue 将重排作为后置阶段，可以用相同检索候选对比排序。Harness 在已经扫描的语法索引中重排，不扩大索引范围。[Continue](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/retrieval/retrieval.ts#L40)
- Aider 明确给查询提及的标识符加权，并继续使用个性化引用图。Harness 以完整符号的精确声明作为优先信号，组内沿用图分数。[Aider](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L476)
- Codex 的文件搜索在分数相同时按路径排序。Harness 沿用稳定的路径平局规则。[Codex](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/file-search/src/lib.rs#L327)
- Gemini CLI 用每文件匹配上限控制重复结果。候选重排每个文件只采用其最高的精确匹配等级。近似名出现次数影响同等级内的图排序。[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/2fd679bbfb4d2005031d9bef810afa6c1740bef6/packages/core/src/tools/grep.ts#L452)

## 执行

1. 从 30 条已有样本固定选 12 条，加上匹配同一前缀的干扰定义。先跑基线。原 30 条保留为对照，另记定义和调用文件是否同时进入前五，以及定义首位命中、输出字节和查询耗时。
2. 识别查询中显式写出的驼峰、下划线和反引号标识符。用大小写一致的完整词匹配 AST 标识符。先验证精确声明加权，再看调用文件是否需要独立优先级。以现有图排名区分同类文件，选中后优先展示精确声明所在代码行。
3. 用同一份工作区、相同 1600 token 上限和交错的基线/候选顺序比较。候选须维持原 30 条 Recall@5 与定义和调用文件共同召回，改善相似名组的定义 Recall@5，并通过工具范围、取消、输出上限和全量回归。

该实验复用 Tree-sitter、符号角色和引用图。报告只覆盖固定检索样本；真实模型修复质量需另测。

## 实测与落地

单独给精确声明加权后，相似名组的定义 Recall@5 为 12/12，定义和调用文件共同召回仍为 0/12。最终采用三级排序，依次考虑精确声明、精确引用和其余候选。引用仍是语法候选，绑定关系须查看源码确认。

| 数据集 | 定义 Recall@5 | 定义与调用文件同时在前五 | 暖查询 P95 |
| --- | --- | --- | --- |
| 原 30 条 | 30/30 → 30/30 | 15/30 → 30/30 | 49.6 → 36.7 ms |
| 12 条相似名压力查询 | 0/12 → 12/12 | 0/12 → 12/12 | 59.8 → 72.5 ms |

Node v24.22.1 上按交错次序跑 3 遍。耗时包含语法索引读取、排序和输出剪裁，反映本次环境观测。额外在本仓库的 `packages/core/src/runtime` 范围核对 8 个现有标识符。定义文件进入前五从 3/8 到 8/8，且候选八项均在首位返回明确定义行。

配对测量发现旧代码在估算字节后把 `complete` 改为 `false`，恰好贴边的结果会多出一字节。修复后以最终标志为准执行剪裁，压力组最大输出为 6397 B，预算为 6400 B。实际工具测试覆盖大小写匹配、显式路径范围和最终字节上限。 [回归测试](../packages/tools/src/scoped-repo-map.regressions.test.ts)

复测用 `node scripts/research/coding-retrieval-20261120/paired.mjs <基线编译后的 relevant-code-map.js>`。基线需已构建并保留相邻模块，当前工作树也需先构建。脚本记录每条查询、次序和预算结果。原始查询集 SHA-256 为 `13227b720af6ae51c877f5fae68b46975c3201572a868d342f78ec1fa6c80e73`。 [配对脚本](../scripts/research/coding-retrieval-20261120/paired.mjs)
