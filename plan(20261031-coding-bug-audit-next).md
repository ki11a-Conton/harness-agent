# 下一轮 Coding Bug 审查与修复

## 范围

用户要求继续下一轮 bug 审查和修复。已原生 git 拉取 main，基线 `1fb4215985bd9d843a83593e39ecabd0915df87b`，工作分支 `fix/bug-audit-next-20261031`。遵守 AGENTS.md Runtime freeze，只维护有确定反例的缺陷，不扩大预算、不改变默认策略、不绕过 ToolOrchestrator、PermissionEngine、SandboxManager 或 Verification。不调用付费模型、不使用 GitHub 连接器、不发布 release。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| N1：手动与 reactive 压缩保留事实 | 修复两者重叠且无摘要预算时，旧 handoff 被泛化 fallback 覆盖 | 保留旧已压缩事实；人工请求仍必须持久化真实 checkpoint，若必要事实放不下就明确报限，不能用完成事件掩盖丢失 | 24/28/48 条 progress 的真实 Runtime 红绿；重启后事实、用户修正、工具配对仍在；无可用安全视图不发布人工完成、不增预算 |
| N2：摘要期间刷新历史视图 | 修复 steer 刷新完整转录后恢复已覆盖旧历史 | 按新的 active users 重新应用有效 checkpoint 视图，再计费、构造覆盖边界；保留摘要开始前 covered-input 身份 | 有/无 steer 对照、成功短摘要及失败 fallback；旧覆盖数据不复活，新用户修正恰好一次，工具协议及转录保留 |
| N3：受管理命令容量身份 | 修复重复恢复一条旧 job 会吃满全局容量 | 按稳定逻辑身份去重恢复/运行镜像的容量计算；保留原未知屏障及 16/128 限额 | 同一一条 unknown 重开16次后，独立工作区仍可真实执行命令；不同真实 job 不合并；真实16条占用时第17条仍拒绝，旧工作区写入/验证屏障仍有效 |
| N4：SDK 长任务便捷 API | 修复 `run()` 从不消费公开事件队列导致 4096 事件溢出 | 共享运行生命周期与 reducer，为非流式 API 避免创建无人消费的公开队列；`runStreamed()` 的有界队列和 overflow 契约不变 | 真实 Harness/AppServer/mapper/SDK，4300 deltas+真实读取后 server/client 都完成；100事件对照；同步 replay、异步分帧、公开无人消费 overflow、取消/错误回归 |
| N5：崩溃恢复的工具结果 | 修复真实被拒绝的写入在重放中变成成功修改 | 从有序、权威终态事件恢复实际状态，区分最终失败/拒绝/取消与成功重试；不从不可信输出字符串猜结果，兼容旧事件 | 真实 write safety denial、故障窗口及未改变磁盘的证据；恢复不能声称 filesChanged/成功提交；failed/cancelled、成功重试、旧事件、验证和预算回归 |
| N6：SDK 中断错误 | 修复取消通知拒绝导致 unhandled rejection，显式 interrupt 忽略协议错误 | 对后台中断失败进行可观察处理；显式调用按 SDK 错误契约返回失败，不伪称服务端已停止 | controlled transport 拒绝不崩 Node、结果准确；协议 forbidden 必须拒绝；正常取消/结束竞争与 transport cleanup 回归 |

## 执行与证据

- N1 已真实 RED：同小 handoff，非人工路径保留事实，而人工与首次 overflow 同时发生时 0 摘要请求、模型继续却丢失历史错误，另建泛 extractive checkpoint；24/28/48 均复现。
- N2 已真实 RED：摘要期间注入 steer 后刷新完整 durable 转录，没有重新 checkpointView，短成功摘要也会把已覆盖记录送回 coding 请求。
- N3 已真实 RED：同一生产 journal 始终只有1条 unknown；重开1次时独立 Node 命令实际写文件成功，重开16次却被容量拒绝。
- N4 已真实 RED：服务端正常完成、4300个分帧文本及真实读取，SDK `run()` 报 STREAM_BUFFER_OVERFLOW；100事件对照完成。事件计数不冒充文件 I/O 次数。
- N5 已真实 RED：10400B 文件的1B破坏性 overwrite 实际被 WRITE_SAFETY_DENIED 拒绝，磁盘字节未改；在真实 tool.effect_committed 故障窗口，重放却记录 success 和 modified source.ts。
- N6 已真实 RED：本地 abort 的 interrupt Promise 拒绝产生 unhandledRejection；显式 interrupt 收到协议 forbidden 却 resolve。
- 初次原始证据保存在 `/dev/shm/harness-bug-audit-next-20261031/`；该临时目录于2026-11-05环境重建时丢失，不能再作为现存验收证据。重新复现、CI失败记录及完整验收见下文，旧CI不重标通过。

## 完成标准

所有选定缺陷先 RED 后 GREEN，旧断言及预算不降低。独立审查后运行根类型检查、相关安全/集成及真实 CLI/Web 工程闭环，干净精确提交在完整 checkout 原 `pnpm test` 验收；稀疏目录不冒充完整源码。普通推送并核对精确 SHA 的 CI，原失败不重标通过。真实模型 coding 质量不由 scripted 工程验收代替。最终报告列清结果、源码资格和未覆盖边界。

## 实现进展（2026-11-01，完整提交验收前）

- N1/N2 已最小修复，新增15项回归、原18项回归、131项相关安全/集成和11项 framing 检查通过。既有安全短 checkpoint 的正常 no-op 可沿用原 `completed/compressed=0` 语义；必要事实放不下时才明确失败且不伪造人工压缩成功。
- N3 已修复逻辑身份与容量存储去重；同一条记录重开129次不占额外槽位，16/128限额及未知屏障保留；35项 managed 和95项相邻安全检查通过。
- N4/N6 已修复 run 的无消费者队列和中断错误处理，SDK整包44项及独立16项 probe 通过，4096公共流上限保留。
- N5 已按最终有序工具状态恢复，只将成功副作用标为 committed；失败、取消、超时的潜在部分副作用仍需 reconciliation。正式回归16项与既有恢复44项通过；真实写入拒绝/冲突/取消三个故障窗口均保留磁盘字节且不误报完成，旧消息与事件格式保持兼容。
- 根 `tsc -b --force`、联合安全/集成42文件共2312项通过。新增6个测试文件已加入真实 Windows workflow，原路径与门槛均保留。
- 本节只记录实现和定向验证。完整 clean SHA 全量、真实 CLI/Web、48 arms 与精确 CI 在后续验收记录，未完成前不宣称交付。

## 恢复环境后的 CI 追查（2026-11-05）

- 环境重建清空了原 `/tmp`、`/dev/shm` 仓库与证据；原本地全量结果未知，不能引用历史日志哈希冒充现存验收。源码从已推送的 `fde148a2` 恢复到独立完整 clone，没有修改原 `/workspace/harness-agent` 的未提交工作。恢复记录与新证据位于 `/dev/shm/harness-bug-audit-next-20261105/`。
- 已原生 curl 复核 `fde148a2` 首次 CI：真实 Windows 96文件/981通过/0失败/12跳过、安装包和UI安装验收通过，总CI失败。多个失败job均指向同一既有 `context-safe-tool-call-efficiency.integration.test.ts` 小预算场景：编程请求仅2次，尚未到第3次就提前报上下文限制。未重跑/取消旧CI。

| 后续问题 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| N7：普通自动压缩误用手动/overflow 批次保护 | 修正 N1 最小补丁对普通连续读取的回归 | 仅手动和 upstream overflow 恢复额外保护最新完整工具批次；普通自动压缩保留 prior handoff、用户与协议配对，同时允许按原语义折叠大读取结果 | 保留原1200-token预算及全部原断言，补强最终 completed 断言；原场景 clean `fde148a2` RED→新源码 GREEN；原N1/N2和18项reactive回归仍通过；加入Windows专测，全量和新SHA的CI重新验收 |

- 新环境首轮依赖安装因 node-gyp 默认缓存所在根分区 ENOSPC 失败，保留日志；后续将工具链、缓存、临时目录放入 `/dev/shm`，锁定 pnpm 11.21.0，不改仓库锁文件、不降低测试门槛。

## 实现提交验收（2026-11-05）

- 最终实现 `96d3986dd742bf5df91d3ceae4d9251bed15ca54`，完整checkout含13536个tracked文件，没有缺失或skip-worktree项。原根命令 `pnpm test` exit0：691文件通过/2跳过、10661项通过/16跳过；before/after同SHA且clean，耗时714.26秒。日志182345B，SHA256 `d4df5a530450fdaa6b8555b93d6b2d6c5040aa1da704c28f71d7060333110964`。根forcebuild通过。
- 原生产基线逐字节匹配1fb42159，只加入六个候选回归文件：51项有36失败/15通过；clean实现同51项全通过。N7既有集成场景clean fde148a2 RED（1失败/5通过），保留原1200预算及38处expect，补强completed后通过。相关167项、安全2155项通过，均有新原始日志。
- 真实write_file经ToolOrchestrator执行，在Runtime故障窗口重建：denied/failed/cancelled三种基线错误记success，修复后状态准确、原10400B文件未变、没有committed误报；failed/cancelled保留待核验屏障。
- clean同SHA CLI/Web：50基础+8policy断言、19个本地HTTP请求通过。48个managed实际arms满足原判据：baselinePass=16、candidatePass=24、candidateOverlap=16、duplicateStarts=0、failures=[]；这些是通过数/重叠数，不是baseline/candidate arms数量，亦不证明同负载性能或模型质量。
- 同实现四项workflow全部首attempt通过；真实Windows97文件/987通过/0失败/12跳过，原46项required均恰好一次通过。CI-reported原始报告/用例哈希保存；未下载原始artifact的哈希没有冒充本地重算。
- [genuine Windows acceptance](https://github.com/ki11a-Conton/harness-agent/actions/runs/42064555681)：首 attempt 成功。
- [official DeepSeek UI installed acceptance](https://github.com/ki11a-Conton/harness-agent/actions/runs/42064555782)：首 attempt 成功。
- [first-generation installed acceptance](https://github.com/ki11a-Conton/harness-agent/actions/runs/42064555983)：首 attempt 成功。
- [ci](https://github.com/ki11a-Conton/harness-agent/actions/runs/42064555664)：首 attempt 成功。
- 新证据在 `/dev/shm/harness-bug-audit-next-20261105/`，包含环境丢失说明、新基线RED、初始fde148a2失败CI及设置失败。持久化交付报告和ZIP放入 `/workspace`，最终主线SHA及其CI结果由该报告补记；此文档归档仅改Markdown，不重跑本地全量冒充新源码。
- 七个原始缺陷及初次修复的一项回归已关闭；保持工具权限、沙箱、Verification、16/128容量和4096流缓冲限制，不改变默认策略。没有付费模型调用，没有发布release；真实模型coding任务成功率与Codex能力对等仍为NOT_PROVEN。
