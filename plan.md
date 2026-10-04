# Harness Agent：当前执行计划入口 — 自动验收与经验学习可信性优化

制定快照：[plan(20261004-000000).md](plan(20261004-000000).md)，含做什么、怎么做、怎么验收。上一轮计划原样归档：[plan(20261004-previous-engineering-round).md](plan(20261004-previous-engineering-round).md)。

基线：`968544064f43cfc0a876c4e65fcb967cd466c9a2`；日期2026-10-04。

| 工作包 | 状态 | 验收目标 |
| --- | --- | --- |
| T1 自动验收完整性 | PLANNED | 退出7/9/11必须失败；根canonical入口不被挤掉；recipe/argv与恶意路径控制 |
| T2 记忆可见性与存储合同 | PLANNED | 两后端禁止正文0/10；6可选字段与迁移历史保留；legacy/schema/安全负例 |
| T3 反思turn归因与journal | PLANNED | 旧失败不重标新turn；200/200journal；真实输出与错误语义 |
| T4 验收、证据与main | PLANNED | clean完整检查、同SHA双平台CI、原生Git发布和三方SHA一致 |

本轮只有确定性工程修复，不做模型质量或promotion声明；paid=0，realModelQuality/promotion NOT_RUN。上一轮真实模型pilot仍缺配置，阻塞状态保留。新增审计中未纳入项明确列在制定快照和原始证据，不声称全部修复。

证据：[agent-trust-20261004.md](docs/evidence/agent-trust-20261004.md)。
