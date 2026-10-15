# 模型配置 PR 合并验收证据

本次固定源码 `e3233deb03fa4039c0565d32302edebde994b556`，包含 PR #9 全部提交、PR #10 以及 `797b17d2` 的 P2 修正与三项新回归。后续归档提交仅改文档/证据。

全量 9798 通过 / 15 跳过 / 0 失败；安全 2146 通过；类型检查、文档验证通过；真实 CLI/Web loopback HTTP 19 请求、8 项策略与 50 项编码断言通过。36 项修正专项在精确 PR #10 修正源码上通过。原始日志保留原字节，包括末尾空行。

本地额外执行的严格 capability audit 返回 1：实现与文档检查通过，但独立 pnpm test 没有生成该 HEAD 的 GateEvidenceV2，证据新鲜度失败。保留失败日志，未伪造或借用旧 SHA 的门禁记录。main 的 CI 按正式 release gate test 产生证据后执行审计，结果须另行查询，不由本归档假定。

此目录在 main 推送前冻结，GitHub 原始快照描述对应时间/源码，不能当作最终 main 的 CI。原 `7e199f2a` 的 Windows UI 两次失败仍保留在上一轮审查归档。未执行付费模型请求，未发布 release。

运行 `python docs/evidence/model-pr-merge-20261015/verify-evidence.py` 仅校验归档完整性与上述收据，不重跑测试。
