# 实测驱动的技能上下文与评测身份优化（2026-10-03）

当前状态：实施中。新计划 [plan.md](../../plan.md)，制定快照 [plan(20261003-000000).md](../../plan(20261003-000000).md)。基线 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`；真实模型配置仍缺失，真实模型质量和 promotion 均 NOT_RUN，付费调用 0。

## 已完成的基线实测

真实 createHarness、文件系统、ToolOrchestrator、JSONL 和原独立 TaskVerifier；scripted provider 只控制调用，不能证明真实模型质量。

| 工程观察 | 基线 | 固定英文 selector 对照 |
| --- | --- | --- |
| 100技能 AB/BA 平均 system bytes | 241065.5 | 3330.5（减少98.62%） |
| 100技能平均完整 request bytes | 253068.5 | 11373.5（减少95.51%） |
| 8k / 21技能相关正文 | 0/9 请求 | 9/9 请求 |
| 8k每turn系统字节（3请求） | 56277 | 15720（减少72.07%） |
| 8k 原独立内容验证 | 3/3 | 3/3 |

上述对照使用旧 selector/固定 host goal，尚不是本轮新候选成绩。21技能基线 ledger 将63次加载提前算注入，实际模型只收到12次正文；相关正文0/3而 injected=3/tokens=3030/completed=1。100技能16k实际34次正文却记200次注入。英文/中文显式命名在长描述下被旧Jaccard筛掉。

原始反例、逐请求统计、完整工具事件、负例、原脚本和原索引保存在 [基线索引](agent-measurement-20261003/baseline-artifact-index.json)。收集范围是两组原目录全部顶层报告、JSON、日志、原脚本；生成fixture/session子目录未复制，原索引指向原外部目录，外层索引核验本交付实际保留文件。原始字节没有重写。

验证保留证据：

```bash
node scripts/research/agent-measurement-20261003/verify-artifacts.mjs docs/evidence/agent-measurement-20261003/baseline-artifact-index.json
```

## 实施与验收

M1 已实施并完成局部验收：原基线同一11项新回归9 FAIL/2 PASS；候选技能相关39 PASS、Core/Harness边界118 PASS。实际8k、6turn、18请求的默认ledger注入63→12，与实际12正文一致；未保留目标loaded=3，injected/tokens/outcome均0，原独立内容Verification6/6通过。指标是最终成功构建的context step admission，不是物理HTTP/内部重试次数。单进程共享ledger串行更新，session/turn集合隔离，反馈await；不承诺跨进程CAS。M1 target来源是dirty实现指纹，不冒充最终commit受测SHA；原始记录见raw/m1-tests及raw/m1-candidate。

M3 已实现：三个传输参数由共享解析器冻结，写入planDigest/effectiveModelParams/execution identity，benchmark wrapper给实际client同一值；正常provider默认行为保持。基线原12项10FAIL/2PASS，新增无效override负例后候选13项和原provider40项共53PASS。真实本地HTTP基本探针六项PASS：retries0为1请求、retries2为3请求、环境/原对象/其它client参数不能改已确认政策；四种参数配置给出四个keyless digest、providerCalls=0。12项基线与13项最终fixture演进单独记录。最终clean源码/构建尚待M5验收；generate cap仍非美元硬上限。

M2 新策略默认关闭，旧 selector API 保持兼容。新纯函数23项、原selector5项和真实Harness10项共38PASS；同一10项真实Harness fixture在原基线为9FAIL/1PASS，安全控制用例通过。策略从当前session/turn的authoritative用户消息取得目标，支持中文/英文显式名称、短名、host必需名称、稳定top-k及unknown完整索引回落，策略配置复制后冻结。独立审查发现并修复unknown+required组合错误，保留负例。

实际新候选与同源码默认臂的100技能AB/BA平均system为241365.5→3333.5 bytes（减少98.619%），完整request减少95.510%；10个真实Harness运行、20个请求、10个真实read_file，两个arm工具schema同为12工具/7400 bytes，原任务及正文保持。该成绩与上表原c31/旧selector成绩分开。新候选21技能/8k探针相关正文9/9、无关正文0，原Verification6/6，admission账本与实际正文一致；默认每turn56277 bytes、新候选15720。CLI新8项与原候选/evaluation边界共86PASS、typecheck通过；同一新CLI fixture在原基线8FAIL，无collection错误，其中包含新registry/activation能力缺失，不称为8个既有缺陷。真实delegate_batch并发3session/6请求的选择证据绑定各自实际输入和request；paired按BA→AB运行4arms共16个实际scripted调用，含原Verification失败后的重试，原gate未改。CLI的目标请求依赖固定正文，默认臂2失败、候选2通过是控制provider的工程反例，不能外推真实模型成功率。最终clean源码、全仓验收和原生Git发布待M5。

M4已固定3组输入共43文件，输入digest `7742d338bcdcbd65864f36b320e1cc4013d8e1204f1c53656216c1d777ca91a2`。host checker实际20项收据为3个正确修复通过、17个破损/篡改/提前退出反例按预期失败；真实keyless CLI dry-run三组通过、providerCalls=0。每组仅1案例×2对，属于准备好的探索pilot，达不到正式promotion案例门槛。真实模型pilot因无provider/key/费用配置保持BLOCKED，付费调用0、真实模型质量与promotion均NOT_RUN。

原始收据逐字节保留：raw目录禁止checkout换行转换；只有生成的.log禁用空白格式检查，生产源码及作者文档仍执行正常diff check。完整交付索引见 [artifact-index.json](agent-measurement-20261003/artifact-index.json)。
