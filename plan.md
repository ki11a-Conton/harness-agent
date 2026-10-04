# Harness Agent：当前执行计划入口 — 自动验收与经验学习可信性优化

制定快照：[plan(20261004-000000).md](plan(20261004-000000).md)，含做什么、怎么做、怎么验收。上一轮计划原样归档：[plan(20261004-previous-engineering-round).md](plan(20261004-previous-engineering-round).md)。

基线：`968544064f43cfc0a876c4e65fcb967cd466c9a2`；日期2026-10-04。

| 工作包 | 状态 | 验收目标 |
| --- | --- | --- |
| T1 自动验收完整性 | TARGET_PASS | 退出7/9/11必须失败；根canonical入口不被挤掉；recipe/argv与恶意路径控制 |
| T2 记忆可见性与存储合同 | TARGET_PASS | 两后端禁止正文0/10；6可选字段与迁移历史保留；legacy/schema/安全负例 |
| T3 反思turn归因与journal | TARGET_PASS | 旧失败不重标新turn；200/200journal；候选写失败实际队列保持原状 |
| T4 验收、证据与main | IN_PROGRESS | clean完整检查、同SHA双平台CI、原生Git发布和三方SHA一致 |

本轮只有确定性工程修复，不做模型质量或promotion声明；paid=0，realModelQuality/promotion NOT_RUN。上一轮真实模型pilot仍缺配置，阻塞状态保留。新增审计中未纳入项明确列在制定快照和原始证据，不声称全部修复。

证据：[agent-trust-20261004.md](docs/evidence/agent-trust-20261004.md)。

执行补充（2026-10-04）：T1 基线复现还确认启动时会重载旧版无版本命令缓存，继续选择被子包挤掉的错误入口。将旧缓存定向失效并重新发现命令，保留新版缓存的正常暖启动；验收增加旧缓存升级与新版缓存控制，不扩展为通用文件变更检测策略。制定快照保持原样。

T3 执行补充：独立实际文件系统负例确认候选写入失败后本实例内存队列仍有未持久化记录。扩展为最小候选存储事务修复：add/update/remove在文件持久化成功后才发布新Map；失败保持原队列。相同真实文件故障回归已证明无ghost、既有记录不丢、恢复可重试；反思故障收据增加实际queue/get检查。首次读取异常后的load标志也已用实际文件故障复现并修复，恢复仍读入旧历史。新增11项回归基线9 FAIL/2 PASS，候选11 PASS；强化实测23/23 PASS。仍待T4干净SHA全仓及双平台CI，不扩展到多进程或独立候选store缓存协调。
