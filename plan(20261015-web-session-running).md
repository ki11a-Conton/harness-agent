# Web 生成结束状态修复

| 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- |
| 证明根因 | 用精确发布客户端重放列表运行中加载 → completed 后 added(false) 的时序 | 原客户端驻留 running 保持 true，status(false) 后变 false；保留证据 |
| 补齐通知协议 | 宿主摘要更新同时发 api-session/status，前端原版消费，不碰 Runtime | 真实 composition + 原客户端回归在原实现失败，修正后通过；审批/重连回归保持通过 |
| 验收交付 | 干净源码运行类型、全量、相关安全和实际 Web/Windows 安装验收 | 记录精确 SHA、原始日志、CI 结果；原失败保留、不以重跑旧代码刷绿 |

合同：[WEB-SESSION-RUNNING-20261015](tasks/WEB-SESSION-RUNNING-20261015.md)。
