# Harness Agent：当前执行计划入口 — 自动验收与经验学习可信性优化

制定快照：[plan(20261004-000000).md](plan(20261004-000000).md)，含做什么、怎么做、怎么验收。上一轮计划原样归档：[plan(20261004-previous-engineering-round).md](plan(20261004-previous-engineering-round).md)。

基线：`968544064f43cfc0a876c4e65fcb967cd466c9a2`；日期2026-10-04。

| 做什么 | 状态 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| T1 自动验收完整性 | DONE | 保留完整recipe；不拼changedPaths或猜cwd；根canonical优先；旧缓存定向失效 | 退出7/9/11必须失败；12份实际Harness收据全部通过，含argv/空格/marker/cache控制 |
| T2 记忆可见性与存储合同 | DONE | 可信session归属与既有lifecycle门；SQLite v6白名单metadata；扫描实际结构正文 | 两后端禁止正文0/10、8允许控制；六字段和迁移历史保留；32份实测检查全通过 |
| T3 反思turn归因与持久化 | DONE | 统一目标turn视图；加锁durable append；候选Map持久化成功后发布，读取失败可重试 | 旧失败不重标新turn；200/200journal；候选写失败实际list/get为0、恢复可重试；23份实测全通过 |
| T4 验收、证据与main | DONE | 干净工作树冻结代码；全仓和具名usage-audit；保存原始hash证据；原生Git发布 | 本地8检查全通过、8295 PASS/12 SKIP；同SHA双平台CI10门通过；发布后API/ref/本地main一致 |

本轮只有确定性工程修复，不做模型质量或promotion声明；paid=0，realModelQuality/promotion NOT_RUN。上一轮真实模型pilot仍缺配置，阻塞状态保留。新增审计中未纳入项明确列在制定快照和原始证据，不声称全部修复。

证据：[agent-trust-20261004.md](docs/evidence/agent-trust-20261004.md)。

执行补充（2026-10-04）：T1 基线复现还确认启动时会重载旧版无版本命令缓存，继续选择被子包挤掉的错误入口。将旧缓存定向失效并重新发现命令，保留新版缓存的正常暖启动；验收增加旧缓存升级与新版缓存控制，不扩展为通用文件变更检测策略。制定快照保持原样。

T3 执行补充：独立实际文件系统负例确认候选写入失败后本实例内存队列仍有未持久化记录。扩展为最小候选存储事务修复：add/update/remove在文件持久化成功后才发布新Map；失败保持原队列。相同真实文件故障回归已证明无ghost、既有记录不丢、恢复可重试；反思故障收据增加实际queue/get检查。首次读取异常后的load标志也已用实际文件故障复现并修复，恢复仍读入旧历史。新增11项回归基线9 FAIL/2 PASS，候选11 PASS；强化实测23/23 PASS。仍待T4干净SHA全仓及双平台CI，不扩展到多进程或独立候选store缓存协调。

最终验收：源码 `d01df59f31b156f7c8622ae6c926ce99bc751400`；本地8项检查通过，全仓8295 PASS/12 SKIP，安全2135 PASS；同SHA [CI 37167480007](https://github.com/ki11a-Conton/harness-agent/actions/runs/37167480007) 10/10通过。文档收尾提交仅含plan/task/本轮证据，原生main发布后的三方SHA核对收据位于本地 `.ci/agent-round2-20261004/publication-verification.json`；本轮DONE不改变归档计划的真实模型pilot BLOCKED。
