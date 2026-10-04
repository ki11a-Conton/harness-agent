# 默认指令与中英记忆检索：源码审查和基线

实施前方案：[plan(20261004-065049).md](../../plan(20261004-065049).md)。基线 `17aa6c7471faf8bdec020b45bfe7b9bb45470131`。UI 阶段已完成，见 [UI 验收](web-dsh-20261004.md)。

真实生产 discovery 50,000B cap 的 16MiB 单行返回16,777,248B，多行50,026B，两者应用层 readFile 都返回整文件字节；不是磁盘IO量声明。symlink 反例读到外部正文。实际 Harness 双turn在正文因 injection/budget 被拒绝时仍改变指纹；允许正文控制可见且指纹变化。

存储基线30项21通过/9失败，12个实际 Harness scripted 请求6通过/6失败；有FTS正命中时仍漏另一条中文子串。When/Do/Avoid 两后端都未检索。原始请求、审查建议和探针完整保留；fixture 数据库与16MiB输入文件可由探针重新生成，未纳入报告包。

本证据包首先冻结审查基线，随后追加实施阶段原件；候选冻结验收和最终联合全仓结果仍待追加。scripted provider、paid=0；真实模型质量和promotion NOT_RUN。

原始证据：[artifact-index.json](agent-context-memory-20261004/artifact-index.json)，脚本 `node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/agent-context-memory-20261004/artifact-index.json` 按原始bytes/sha256验证。

实施阶段：A1/A2 首批固定55测试RED44失败/11通过/0skip；另3个read/cleanup反例先2失败/1通过，修复后定向7文件105项全部通过。A3固定53测试RED35失败/18通过/0skip，修复后相关17文件262项全部通过。编译通过；首轮旧UTF-8测试因历史首行可超预算而失败，其原件保留，旧断言按新预注册硬预算合同更新，新增RED固定测试未改。

独立审查实际FileHandle.close关闭后注入EIO重现全局发现失败；最小best-effort cleanup修复后同探针正常返回cwd与nested控制。首次无效prototype-hook探针（calls0）作为无效观测原样保留，不能充当反例。严格UTF-8/短读/提前EOF新回归纳入默认测试。

10k基线在独立干净17aa工作树运行最终固定性能脚本，原始fixtureSHA与probeSHA保留。分别JSONL/SQLite实际10,000行，2次warmup/5次search计时；基线已知结构化、SQLite中文子串遗漏被明确expectBaselineDefects判定。已有retrieval候选主题去重成本可达约585ms；不将TopK5返回上限解释为扫描上限。候选补集预计增加线性扫描成本，待冻结实际值，不宣称吞吐提升。
