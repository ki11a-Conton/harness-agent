# 开源编辑工具对照与大文件定位优化

基线为 Harness Agent `0e3d1ed1cd476c74e91ed81a6d77fa0ea524c702`。本轮沿编辑定位、匹配计数和原始字节保留三个环节核对源码。

| 来源 | 做法 | Harness 的采用方式 |
| --- | --- | --- |
| OpenCode V2 社区快照 | `countOccurrences` 逐次调用 `indexOf`，只保留计数和游标。编辑通过 `writeIfUnchanged` 提交。 | 保留总匹配数与现有条件写入。只为选中的匹配生成替换片段。[源码](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/opencode-dev/packages/core/src/tool/edit.ts#L55) |
| Codex | `seek_sequence` 从给定起点检查行序列，找到第一个符合的偏移即返回。 | 区间编辑逐步查找换行边界，找到区间结束或 EOF 后停止定位。锚点编辑仍需遍历以给出准确的匹配总数。[源码](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/apply-patch/src/seek_sequence.rs#L12) |
| pi | `applyReplacementsToOriginal` 按替换顺序推进偏移映射，从原始文本切片以保留未编辑字节。 | 用定位出的两端偏移拼接原文，保留 Harness 的 BOM、混合换行和通过 EOF 时的行为。[源码](https://github.com/badlogic/pi-mono/blob/1f6f319bb28992a40b99c147fffb23b65a23129d/packages/coding-agent/src/core/tools/edit-diff.ts#L15) |
| Aider | `perfect_replace` 发现第一个精确行块后直接拼接保留片段。 | 将精确定位和替换拼接保持在工具层。继续支持指定第 N 次及全部匹配。[源码](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L146) |

## 执行计划

1. 通过实际 ToolOrchestrator 在 64 MiB Node old-space 上限中运行两项编辑。第一项在约 12 MB 的短行文件中替换首行，第二项仅替换约 800 万次的末次锚点。验证基线和候选的退出状态、落盘 SHA-256 和回执。
2. 将行区间索引改为两个文本偏移的扫描，将锚点扫描改为匹配计数加按需拼接。继续复用现有文件锁、权限、沙箱、版本检查和 diff 回执。源码修改集中在 `@ar/tools`。
3. 对照空文件、尾部空逻辑行、越界续写、混合换行、BOM、重叠锚点、匹配总数和多行替换等行为。限定堆测试须在候选版本真实完成编辑，回执版本须与文件字节相同。运行类型、相关安全和全量测试。

现有研究还指出两项可独立验证的候选。先用跨窗口验收失败场景测关键诊断召回和工具调用配对，再决定是否借鉴 Codex 的工具结果保留策略。用同一仓库的查询样本对比当前词法检索和 Continue 式可选重排，记录 Recall@5 与延迟后再评估引入。 [上轮源码对照](../docs/research/coding-agents-20261118.md)

## 本轮结果

两项受限堆回归都调用真实 `ToolOrchestrator`，使用严格模式和文件版本。基线在 64 MiB old-space 上限下均因 V8 堆耗尽退出。候选两项均成功，落盘内容逐字节校验通过，回执 SHA-256 与实测一致。 [回归用例](../packages/tools/src/edit-memory-budget.regressions.test.ts)

另用 Node.js v24.22.1、256 MiB old-space 上限比较相同输入的编译后编辑函数。每项在独立进程运行 7 次。计时范围是编辑函数调用，峰值 RSS 是整个测量进程的 `process.resourceUsage().maxRSS`。

| 操作 | 基线中位耗时 | 候选中位耗时 | 基线峰值 RSS 中位数 | 候选峰值 RSS 中位数 |
| --- | ---: | ---: | ---: | ---: |
| 首行区间，后有 1200 万个换行 | 278.98 ms | 3.59 ms | 248.5 MiB | 33.8 MiB |
| 800 万个单字符匹配，仅改最后一次 | 429.72 ms | 93.17 ms | 242.1 MiB | 43.1 MiB |

以 `a`、`b`、LF、CR、emoji、BOM 组成的 1555 个长度为 0 到 4 的文本再做配对测试。251,910 个行区间组合与 513,150 个锚点组合的返回值逐项相同。全替换仍会生成与实际替换数量相关的拼接片段，CRLF 归一化仍使用原始偏移映射。此表的性能数字适用于所列 LF 和单行输入。
