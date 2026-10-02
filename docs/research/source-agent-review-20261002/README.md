# 独立源码审查记录

本目录保存五个 agent 家族和当前 Harness 的交叉审查记录。相对源码路径/行号均针对收集仓库 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` 或当前实现基线 `acf8dcc394de6c6efefed52602e49014b372f372`；各篇明确其路径根和证据等级。

其中 `.ci/source-research/` 是调查时的临时输出位置。可长期复核的探针已整理到 [scripts/research](../../../scripts/research/README.md)，原始观察整合到 [证据 manifest](../../evidence/source-agent-review-20261002.json) 的 `reproductions`。早期控制组的 fixture 文本长度可与最终探针不同；汇总数字采用最终重跑记录。

完整取舍及下一步实现以 [汇总报告](../source-agent-review-20261002.md) 和 [plan.md](../../../plan.md) 为准。这里的上游测试引用表示代码阅读，不表示实际执行过上游测试；确定缺陷、兼容合同与策略假设分别标注。
