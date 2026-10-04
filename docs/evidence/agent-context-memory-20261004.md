# 默认指令与中英记忆检索：源码审查和基线

实施前方案：[plan(20261004-065049).md](../../plan(20261004-065049).md)。基线 `17aa6c7471faf8bdec020b45bfe7b9bb45470131`。UI 阶段已完成，见 [UI 验收](web-dsh-20261004.md)。

真实生产 discovery 50,000B cap 的 16MiB 单行返回16,777,248B，多行50,026B，两者应用层 readFile 都返回整文件字节；不是磁盘IO量声明。symlink 反例读到外部正文。实际 Harness 双turn在正文因 injection/budget 被拒绝时仍改变指纹；允许正文控制可见且指纹变化。

存储基线30项21通过/9失败，12个实际 Harness scripted 请求6通过/6失败；有FTS正命中时仍漏另一条中文子串。When/Do/Avoid 两后端都未检索。原始请求、审查建议和探针完整保留；fixture 数据库与16MiB输入文件可由探针重新生成，未纳入报告包。

此提交只冻结审查基线；实施、候选验收和最终联合全仓结果待后续追加。scripted provider、paid=0；真实模型质量和promotion NOT_RUN。

原始证据：[artifact-index.json](agent-context-memory-20261004/artifact-index.json)，脚本 `node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/agent-context-memory-20261004/artifact-index.json` 按原始bytes/sha256验证。
