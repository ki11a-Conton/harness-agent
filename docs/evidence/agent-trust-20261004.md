# 自动验收与经验学习可信性优化（2026-10-04）

本轮先制定[plan.md](../../plan.md)和不可变的[实施前快照](../../plan(20261004-000000).md)，再复现生产反例、修复、独立审查。基线 `968544064f43cfc0a876c4e65fcb967cd466c9a2`；冻结受测提交 `d01df59f31b156f7c8622ae6c926ce99bc751400`。三组冻结实测、本地完整验收与同SHA双平台CI全部通过。

| 目标 | 基线实测 | 冻结提交实测 | 如何实现 |
| --- | --- | --- | --- |
| 自动验收正确阻止失败任务 | 必测命令退出7/9/11仍verified_complete | 三例均verification_failed；12/12收据通过 | 完整保留发现recipe；不拼changedPaths、不猜包cwd；根canonical入口在60条上限中优先保留；旧无版本缓存重新发现 |
| 记忆按归属和生命周期可见 | 两后端禁止正文10/10进入模型请求 | 禁止正文0/10，8个允许控制正常；32/32检查通过 | 可信sessionId匹配，复用现有isRetrievable；检索与写入检查实际When/Do/Avoid文本 |
| SQLite保留经验来源与历史 | 六个候选字段丢失，迁移丢evidence/usefulness/state | 完整entry迁移、更新和重开保留，v5兼容控制通过 | v6六字段白名单metadata，统一序列化；损坏metadata/state保守标stale，不能覆盖核心列或复活退役项 |
| 反思只归因当前turn | tagged旧MCP候选在新clean turn重标pending | 新clean turn不再产生旧失败候选 | outer turnId权威；legacy仅归入明确started/terminal边界；Reflector与污染检测共享视图 |
| journal和候选队列如实持久化 | 200个输出仅10条journal；写候选失败仍有内存ghost | 200/200journal、200/200候选；23/23检查通过；ghost为0 | 同路径进程内锁和durable append；日志成功后计输出及入队；候选Map在atomic持久化成功后发布，读取失败可恢复 |

旧反思的legacy基线也会重标新turn，但仍保持quarantined；此事实与显式turnId的quarantined→pending区别保留，未合并成同一安全结果。

定向TDD采用同字节回归：T1主13项基线7 FAIL/6 PASS、缓存3项2 FAIL/1 PASS，最终目标组89 PASS/3 SKIP；T2可见性28项基线23 FAIL/5 PASS、SQLite29项26 FAIL/3 PASS，目标组209 PASS；T3 turn18项基线10 FAIL/8 PASS、目标组45 PASS；追加队列11项基线9 FAIL/2 PASS、候选连同旧3项14 PASS。T3第一阶段45项是队列追加修复前的结果，最终组合修订由干净全仓验收覆盖。

冻结实测均使用真实built Harness或实际生产存储、文件系统、子进程。三组仅各跑一次，源码树前后clean；验证和记忆使用固定离线provider，反思直接使用实际event/candidate stores，不模拟生产持久化。Journal多实例保证限于同进程同规范化路径，候选并发测试共享candidateStore；不声称修复独立store缓存协调或跨进程写入。

原始完整性：[artifact-index.json](agent-trust-20261004/artifact-index.json)。原始请求、事件、回归日志、代码指纹、阶段清单及原始索引按bytes/SHA256归档，fixture/session树按各原始索引范围排除。`.gitattributes`仅对本证据目录保留原始bytes，原始log/diff不重排格式；生产源码和手写文档仍接受正常diff检查。

本地第一次长测试在会话切换后中断，原始RUNNING manifest和partial log保留，未当作通过或源码失败。前四项已通过且受测SHA/工作树不变，恢复仅执行full和余下三项，采用新的观测run id，严格usage-audit不复用中断观测。恢复launcher从/workspace查询到pnpm12.9.1，实际所有验收命令cwd均为冻结项目、由packageManager选择11.21.0；[实际命令运行时收据](agent-trust-20261004/raw/publication-and-runtime/runtime-identity.json)区分这两者，原始manifest不改写。

真实模型质量、付费实验及promotion均NOT_RUN，paid=0。上一轮真实模型pilot仍缺配置，原计划原样归档且阻塞状态保留。Core架构、权限/沙箱/验收门及promotion策略没有改动。本轮工程通过不等于真实模型质量提升。

未纳入的已测事项：默认AGENTS单行预算与未注入源指纹、记忆并发feedback计数、中文FTS、bridge.close接收者问题。原证据保留为后续事项，本轮不声明修复。命令定向运行需明确runner参数合同；当前保留根入口，可能增加大型项目的单轮验收耗时。

本地完整验收：[原始manifest](agent-trust-20261004/raw/frozen-acceptance-resumed/manifest.json)，8项检查均exit0，每项检查前后HEAD固定且工作树clean。

| 检查 | 结果 |
| --- | --- |
| typecheck / build | PASS，来自同SHA中断前的原始完成收据 |
| security | 2135 PASS，19文件 |
| docs:verify | PASS |
| full | 8295 PASS / 12 SKIP；451文件PASS / 1文件SKIP；exit0，监督进程回收70个孤儿后代 |
| strict usage-audit | PASS，使用恢复阶段新的具名观测run；7项关键能力均observed |
| artifact-integrity | PASS，受测提交内321原件全部校验 |
| diff-check | PASS |

本轮新增102项回归全部进入正常全仓测试，没有新增跳过项。

同源码SHA的[CI 37167480007](https://github.com/ki11a-Conton/harness-agent/actions/runs/37167480007) completed/success，10/10 job通过：Ubuntu/Windows verify、coverage、两平台closed loop、两平台real formal offline、cold-start、release attestation、dual-platform acceptance。原始[run](agent-trust-20261004/raw/ci/run.json)、[jobs与steps](agent-trust-20261004/raw/ci/jobs.json)和[核对结果](agent-trust-20261004/raw/ci/verdict.json)保留完整bytes；没有下载或声称持有runner artifacts。CI的离线验收不计入真实模型质量或promotion。

文档收尾提交与受测源码SHA区分，packages/apps/scripts/.github及依赖manifest无漂移。此文档与原始证据提交通过原生Git发布main；提交后的main实际SHA由GitHub API、原生ls-remote及本地main三方核对，避免把文档提交当作重新受测的源码SHA。发布核对收据保存在本地ignored `.ci/agent-round2-20261004/publication-verification.json`，其本提交SHA不写回自身以避免循环。代码与测试的验收结果仅归属于上述冻结源码提交。

[独立最终验收](agent-trust-20261004/raw/independent-review-final/final-acceptance-review.json)只读核对冻结源码、全部命令日志哈希、恢复观测归属、三组实测与10门CI，结果为ACCEPTANCE_PASS_PUBLICATION_PENDING；没有重跑测试或改写原始收据。审查时main尚未发布，发布之后由上述三方核对收据证明。最终索引包含440份原始文件，全部可按相对路径与bytes/SHA256验证。
