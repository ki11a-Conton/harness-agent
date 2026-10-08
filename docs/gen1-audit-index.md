# 第一代已复现缺陷、修复与证据索引

审查基线：`22d97d860cfa1001df578b1193b3bc4c8ee1bce1`。本页汇总 2026-10-08 独立工作区中的实现审查和交叉复审，记录可复现的触发、修复及已有原始输出。它是本轮发现清单，不是“已证明不存在任何 bug”的声明。

下文的 GREEN 是对应子任务工作树上的定向验收，存在重叠测试，不能相加冒充全量结果。部分 receipt 的 `sourceSha` 仍是上述 HEAD，执行时含未提交修改；它们不证明基线通过，也不替代最终固定源码。本表保留当时的开发回归身份与失败，不把局部结果改写成基线或最终固定源码通过。后续固定源码 `c5bbe61fef101a8c9eb10edab673be8b2e0935e3` 已完成全量、原生Windows、独立同包安装及完整双平台CI；实际命令、退出码、原件及许可边界见[最终工程验收](gen1-final-acceptance.md)。公开发布仍是最后交付动作。

## 阅读入口与来源

| 领域 | 详细报告 | 源码/许可证归属 |
| --- | --- | --- |
| 模型、上下文、重试 | [模型对比](gen1-model-comparison.md) | [模型来源清单](gen1-model-source-manifest.json) |
| 文件、搜索、计算取消 | [工具对比](gen1-tools-comparison.md) | [工具来源清单](gen1-tools-source-manifest.json) |
| 会话、fork、SDK | [会话对比](gen1-session-comparison.md) | [会话来源清单](gen1-session-source-manifest.json) |
| CLI/Web 输入、恢复、SSE | [交互对比](gen1-interaction-comparison.md) | [交互来源清单](gen1-interaction-source-manifest.json) |
| 持久 store、审批、预算、migration | [独立正确性与安全复审](gen1-independent-audit.md) | 原生文件/进程反例及原实现修复，出处见报告 |
| Actor 后续输入、host 所有权、发布真实性 | [分发与发布审查](gen1-release-comparison.md) | 参考 pi/DeepSeek 发布设计；本项目实现，详见报告 |

参考仓库固定版本为 `HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` 和 `deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`。实际代码采用、设计借鉴、已存在能力及未移植差距在各报告分别说明；未采用无可用许可证的泄漏材料。本轮没有用离线工程验收晋升付费模型质量，也没有修改冻结 N7 结论。

## 模型与可见事件

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED → GREEN |
| --- | --- | --- | --- |
| M1 已修复 | unpinned provider 的 `ModelRef.modelId` 被忽略，所选模型与实际 HTTP body 不同 | call config > pinned constructor > ModelRef > env/default；真实序列化请求验证，不改变 pinned 身份 | E-MODEL |
| M2 已修复 | invalid token、TPM 限制、unsupported max_tokens 因宽泛 regex 被判成 context overflow | pi 精确模式子集；排除认证、rate-limit 和参数错误；只对确认 overflow 压缩一次 | E-MODEL |
| M3 已修复 | Runtime 忽略 `retryable:false` / `safeToRetry:false`，重发永久错误或已输出的失败流 | 安全标志阻止重放；400/401/403 各一请求；部分输出后错误不重试；已确认 overflow 可做一次改变上下文的恢复 | E-MODEL |
| M4 已修复 | 30 秒 retry backoff 没有接取消信号，Ctrl-C 必须等退避 | 使用既有可取消 Timer sleep，并在下一请求前检查 signal；不推进 ManualTimer 即终结且没有第二请求 | E-MODEL |
| M5 已修复 | 官方已知 reasoning 模型的显式 cap 发成 `max_tokens`，显式不兼容 temperature 直接发到服务端 | 精确官方 host/家族边界选择 `max_completion_tokens`；不支持的 temperature 本地可见拒绝；显式 override 严格验证。默认本来没有 temperature=0.2，缺省请求正文保持原语义 | E-REASONING |
| M6 已修复 | 实际 `model.completed` 没有 mapper 读取的答案 text/final，SDK `finalResponse` 为空；`text_delta` 没有可见事件 | 答案 payload 与持久 assistant 消息一致；实际文本 chunk 发 text delta；thinking 保持私有；partial text 后失败没有 fake final | E-SDK、E-SKILLS |
| M7 已修复 | mapper 读取扁平失败字段，Runtime 实际发送嵌套 error；可用 usage 的形状也不一致 | mapper 按真实 payload 投影错误和 usage，只映射实际文本；真实 SDK 保留错误 code/message/retryable，拒绝 reasoning 泄漏 | E-SDK |
| M8 已修复 | `agent skills` 固定接空数组，实际配置的技能永远显示 `(none)` | `Harness.listSkills()` 复用原 `discoverSkills`；RPC 接异步列表；CLI 接真实 Harness。metadata 列举不会绕过原正文准入 | E-SKILLS |
| M9 / G11 已修复，显式身份方案 | 复用已执行 provider 重建 Harness，index/calls 被误判配置漂移；共享数组在 resolve 后改变，使初始 fingerprint 与后续冻结值不一致 | 可选 getConfigIdentity 声明完整稳定配置；先深捕获再 hash/持久化，Runtime 仍使用原实例；未知 provider 保留原 own-field 比较。严格拒绝 getter/function/cycle/非 JSON 数据及程序型数组；实际配置变化仍拒绝 | E-PROVIDER-IDENTITY |

## 会话与持续任务

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED → GREEN |
| --- | --- | --- | --- |
| S1 已修复 | 公开 `sessionService.create()` 后 Actor 只有 P27 状态、没有 effectiveAgent，模型前失败 | Harness 注入真实 Runtime 创建入口，持久保存冻结 agent；公开路径实际发送模型请求 | E-SESSION |
| S2 已修复 | `thread/resume` 被当作新建，`thread/start.resumeThreadId` 不生效；可覆盖原 agent/cwd | 映射到同一个 session.resume/config gate；同 ID 继续；错策略/项目拒绝且不创建替代会话 | E-SESSION、E-INTERACTION |
| S3 已修复 | `thread/fork` 忽略 source；service fork 缺冻结策略并复制 live turn/prompt/ask 身份 | 显式源 ID；继承 effectiveAgent/runtimePolicy/P27；新消息 ID，去 live lineage；审批和 inbox 不复制，真实工具仍受父策略拒绝 | E-SESSION |
| S4 已修复 | 初次 busy 检查后父 turn admission，fork 可截半个 assistant/tool 协议 | 快照后再次 settled 检查及已有 wire protocol 校验；分支创建前拒绝不完整历史 | E-SESSION；补充 `/tmp/gen1-session-crossreview.{mjs,log}` |
| S5 已修复 | 冻结策略、fork 复制或显示证据 I/O 失败留下 active 的半成品 | 初始化/复制成功前保存为不可运行 failed；失败不进入 legacy fallback，不完整分支不能再派生 | E-SESSION |
| S6 已修复 | fork MessageStore 有历史，SDK branch.read/itemCount 却为空 | 写入惰性的 copied-history 显示事件；原历史工具结果明确未在分支执行，不伪造审批/执行事件 | E-SESSION、E-SDK |
| S7 已修复 | `thread/list`、`thread/loaded/list` 返回 agent 列表 | 分开列举持久与 loaded sessions，返回实际 ThreadInfo；SDK 提供 resume/fork/listStoredThreads | E-SESSION |
| S8 已修复 | 相同 key 的并发重试产生两个会话，不同 method 又错误共享结果 | 连接内 method+key 合并 in-flight，再记录成功结果；并发仅一次创建，fork/start 不混用结果 | E-SESSION |
| S9 已修复 | Actor 等待异步 `admit()` 时前 turn 已 settle/drain；晚到 follow-up 永久停留，直到下一条任务才唤醒 | admission 完成后通知 idle drain；flight drain 保留 wake；durable terminal ACK 清 reservation 后再 wake。实际 future outcome 先注册，FIFO 与 maxActive=1 验证 | E-ACTOR；真实 Chromium 失败现场 E-BROWSER-RED |
| S10 已修复 | inbox 写入先可见、admit Promise 后返回，hydration 抢先读同 prompt，重复入队或 deferred 尚未注册；close/写后报错也可能执行不应运行的输入 | 以 promptId 排除未确认 admission，成功发布 local entry 才解除；write-then-error 留待持久恢复，当前不执行；跨 await close 拒绝 caller | E-ACTOR |

fork 当前是同 agent/cwd 的已结束、协议有效历史分支，不是任意事件节点回退、跨项目移动或文件系统快照。不会把历史显示事件解释成新分支又执行了工具。

## 编码工具

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED → GREEN |
| --- | --- | --- | --- |
| T1 已修复 | 对实际文件 `grep_search({path,pattern})`，`readdir(file)` 被吞，成功返回空匹配 | 选定 regular file 直接搜索；路径/行号/CRLF/Unicode 保留 | E-TOOLS |
| T2 已修复 | >2000 字符长行的真实命中被跳过 | 完整受控文本搜索；保留原 column，围绕实际命中有界截断，避免拆 surrogate pair | E-TOOLS |
| T3 已修复 | >512KiB/不可读文件遗漏却看似全库零结果 | 默认旧数组明确 SCAN_INCOMPLETE；显式 summary 报 complete=false，并保留正向命中 | E-TOOLS |
| T4 已修复 | read offset/limit 被忽略，offset=0 也成功 | schema 在打开文件前校验；1-based 完整行分页、总行数和真实 nextOffset；versioned 页面 SHA 仍为完整 raw bytes | E-TOOLS |
| T5 已修复 | 首次 I/O 后取消，grep/walk/tree/symbol 仍继续扫描或成功 | I/O 前后传播 signal；取消不产生成功证据；描述符/Worker 最终释放 | E-TOOLS |
| T6 已修复 | `(a+)+$` 在主线程阻塞；50ms abort/100ms tool timeout 也无法触发 | 纯计算 Worker，一个查询共用总预算；原生 dist probe 及时 cancelled，finally 等待 terminate | E-REGEX |
| T7 已修复 | symbol fallback method regex 对 `"a(".repeat(200000)` 同样冻结主线程 | 固定 heuristic regex 也隔离计算；失败/取消不能伪装零匹配 | E-SYMBOL |
| T8 已修复 | TS import/export 分类 regex 对长头部/未闭合 export 冻结 timer | 线性 import head/from/binding、export head 分类；保留 alias/default/type/namespace 行为 | E-INDEX |
| T9 已修复 | 默认 full read 不限制 regular file 大小，可整文件分配巨大内存 | 打开后的 stat 超 16MiB 明确 READ_FILE_TOO_LARGE；分页保持有界保存内容，原普通输出兼容 | E-TOOLS（新增 native sparse-file admission 回归） |

分页为了完整 SHA/总行数仍扫描完整文件，内存有界不等于磁盘 I/O 恒定；超长首行返回明确 hint，不伪造续读 offset。文件锁和最后 SHA 重查不是跨任意外部进程的原子 CAS。搜索摘要需要检查扫描范围，symbol 仍是 heuristic。本代没有移植 PTY/write_stdin 或后台进程会话。

## CLI/Web 与宿主所有权

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED/现场 → GREEN |
| --- | --- | --- | --- |
| I1 已修复 | Ctrl-C 的旧 signal 污染下一 turn；idle close 后仍消费已排队任务并开始运行 | 每 turn 独立 signal；idle 硬关闭清队列、拒绝开始，EOF 与硬关闭区分；真实 POSIX 子进程连续任务测试 | E-INTERACTION；idle 现场 `/tmp/gen1-chat-interrupt-review.{mjs,log}` |
| I2 已修复 | 请求前已取消，CLI 直接返回却留下 running Turn | 经真实 session.run 的 RpcContext.signal 完成 cancelled；provider 调用为零 | E-INTERACTION |
| I3 已修复 | 后续取消读取前一 turn 回复/验证，冒用旧 verification passed | 只读当前 turn 消息/事件；本次未执行的检查显示 not run | E-INTERACTION |
| I4 已修复 | 缺值、空值、重复 `--data-dir` 静默失去持久化或吞 flag；help 被无效配置阻断 | provider 构造前严格解析，help 提前执行 | E-INTERACTION |
| I5 已修复 | 新浏览器或清空 localStorage 无法发现已有后端会话 | 合并真实 `/api/sessions`，保留本地草稿和选中项，遵守既有侧栏上限 | E-INTERACTION；E-BROWSER-RED 中该独立 case 已通过 |
| I6 已修复 | 同 session 两 tab 相互关闭 SSE，重连循环 | 按连接/sender 维护多个 sink；close 仅注销当前 sink；两个真实 SSE 均收到同一 turn 回复 | E-INTERACTION |
| I7 已修复 | SSE 初始化 await history cursor 时客户端关闭，之后仍注册死连接 | 第一次 await 前安装 close 跟踪；读完 cursor 再核对关闭态 | [交互报告](gen1-interaction-comparison.md) 的真实 HTTP 延迟/关闭回归；最终[固定源码24断言](evidence/gen1-final-20261008/local/interaction/result.json)和安装CI通过 |
| I8 产品入口已防护；SDK 有限制 | 两个真实 Harness/SQLite host 同 dataDir，各写一个审批，最终只剩 B；A 内存仍 pending | CLI/Web 加载 stores 前获得 canonical dataDir 的本机排他 lease；真实 contender 拒绝且不写，正常/崩溃后 OS 释放 | E-HOST |
| I9 已修复 | Web 部分启动失败后资源和 dataDir 所有权未释放 | 失败 startup cleanup 关闭资源并释放 lease；原占用目录可由下一 host 使用 | E-HOST |

持续 `agent chat`、单 stdin 队列、每次审批串行消费和退出 resume 指令也是本轮第一代能力补齐；不将原本只有一次性 run 的能力缺口包装成已经复现过的双 readline 事故。仍沿既有 ToolOrchestrator/PermissionEngine/SandboxManager/Verification 执行副作用。

dataDir lease 保护同机、同 network namespace 的 CLI/Web 产品入口，哈希碰撞/已有端口服务均 fail closed，不切随机端口逃避排他。SDK/embedder 必须自行保证同目录单 host 生命周期；SQLite 事务不保护另一个 JSON 审批/候选/恢复 snapshot。跨机器/NFS/不同 network namespace 不在该防护范围，使用独立目录。局部 lease 测试的 Windows case alias 在 Linux 是 SKIP；最终真实Windows另由[原生CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/37740745991)及[Windows宿主原件](evidence/gen1-final-20261008/ci-data/windows/host-lease/result.json)验收，不把Linux SKIP当Windows证据。

## 持久性、预算与迁移

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED → GREEN |
| --- | --- | --- | --- |
| P1 已修复 | SQLite 接收 ABI=999/缺省 event，未知已存事件照常 list/stream，tool transcript 与事件可不一致 | 新 append stamp 当前 ABI，声明未知事务前拒绝；读取拒绝无/未来 ABI；tool outcome 拒绝不提交 transcript | E-PERSISTENCE |
| P2 已修复 | ask 初次 read EISDIR 将 loaded 提前置 true，文件恢复后仍空缓存，可覆盖原 pending | 完整读成功再发布缓存；失败可重试；首次共享 loading Promise，避免并发覆盖 | E-PERSISTENCE |
| P3 已修复 | ask create/answer/withdraw 先改缓存，原生 rename EISDIR 后 disk 不变却 ghost/answered；answer 重试 ASK_NOT_PENDING | immutable next Map/record，persist 成功才替换 live cache；三个操作失败保留旧状态且可重试 | E-ASK；补充 `/tmp/gen1-askuser-persistence-review.{mjs,log}` |
| P4 已修复 | DurableApprovalStore 将非 ENOENT 读错、未来 version、坏数组/记录当空 store | 仅 ENOENT 新建；未知/坏结构/重复身份拒绝并保留原字节；合法无 version 历史仍可加载，真实 mutation 正规写 v1 | E-PERSISTENCE |
| P5 已修复 | 同授权不同根 bootstrap，A 原生 temp write 延迟时 B 也得到完整预算 | shared claim anchor lock 持有到 ledger 和 established marker 可见，私有 under-lock helper 避免自锁 | E-BUDGET |
| P6 已修复 | lock 实际为目录或持续 Windows contention，read catch/continue 绕过 deadline，声明 100ms 的 child 1s 仍不退出 | 每轮共用原 deadline，永久读错拒绝；ENOENT/transient 回统一期限；未持锁不写 | E-BUDGET-BOUNDS |
| P7 已修复 | 两个 stale reclaimers 按旧 owner read 删除新活锁，实际 critical sections 重叠 | 所有 contender 创建/检查/回收走 `.reclaim` guard，owner nonce 释放；不自动偷 guard | E-BUDGET-TAKEOVER |
| P8 已修复 | JSONL migration 将非 ENOENT 源读错当空源；dry-run 接受坏 wrapper/未来 ABI；非 duplicate SQLite 写错吞掉却计为成功 | 同一源验证用于 dry-run/实写；无版本旧 document 显式升级；声明未知拒绝；非 duplicate 目标失败传播，源字节不变 | E-MIGRATION |

空审批文件拒绝作为“全新无审计”加载，已存无版本 SQLite event 不能隐式猜成当前 ABI，使用明确迁移。预算是本机同协议参与者的恢复完整性；活 PID 不因年龄被抢，新 `.reclaim` guard 不做年龄抢占。短 guard 持有期间强杀可留下 debris，随后有界诊断拒绝，确认原 host/PID 已死后手动清理该 guard；不要删预算/claim/消费记录来重新获得额度。详见独立复审的 legacy unknown-owner 区别。

## 发布证据真实性

| 编号/状态 | 触发与影响 | 修复与验收 | 原始 RED → GREEN |
| --- | --- | --- | --- |
| R1 已修复 | coverage 命令失败但旧 summary 存在，collector 宣称 produced | 本次前删除旧 summary，失败优先拒绝，验证新四类数据结构 | E-RELEASE |
| R2 已修复 | adversarial 失败消息含 suite 名，布尔表达式误判成功 | 显式失败优先；suite 名不是成功证明 | E-RELEASE |
| R3 已修复 | stress 同样将含名字的失败判为 produced | 相同失败优先语义 | E-RELEASE |
| R4 已修复 | 仅拷贝 CI workflow 就声称双平台 ci-results 已 produced | workflow 仅归档定义，produced=false；实际 CI/固定源码 evidence 另验 | E-RELEASE |

新增 portable 构建/完整性/仓库外消费脚本解决独立分发能力缺口。最终包从clean源码c5的Git blobs和冻结依赖fresh-build得到，已完成Ubuntu、Windows自建和Ubuntu同archive在Windows消费三腿安装，以及实际CI字节再次本地独立消费。正式候选archive的SHA256为 `f7006e6c22655d35576bbb800870bda792cfb0df4834fc9405dd55f30e9a278b`；doctor0、无workspace links、两层篡改拒绝。原件见[最终验收](gen1-final-acceptance.md)，版本化manifest、Node与许可条件见[发布报告](gen1-release-comparison.md)。候选资产尚未公开发布。

## 原始证据索引

以下保留开发时的原件路径及结果；已交付原件见[90件原始开发归档](evidence/gen1-20261008/manifest.json)，其路径映射及哈希由manifest记录。其余原路径只说明当时观察位置，不把路径本身当作仓库已交付的文件。最终固定源码另见[验收档案](evidence/gen1-final-20261008/README.md)，不改写历史RED为PASS，也不改变开发归档的 `fixedSource: null`。

| 标签 | 已存在原件与观察 |
| --- | --- |
| E-MODEL | `/tmp/gen1-model-red.{json,log}`：15 FAIL/10 PASS；`/tmp/gen1-model-green-final.{json,log}`：23 文件、380 PASS/0 FAIL/0 SKIP（M1–M5 相关组） |
| E-REASONING | `/tmp/gen1-reasoning-red.{json,log}`：14 FAIL/5 PASS，基线原始 blob 的一次性 fixture；GREEN 包含在 E-MODEL，URL fallback 小修另有 `/tmp/gen1-reasoning-final-smallfix.{json,log}` 19 PASS |
| E-SKILLS | `/tmp/gen1-skills-stream-red-final.{json,log}`：2 FAIL/22 PASS；`/tmp/gen1-skills-stream-green.{json,log}`：5 文件、119 PASS/0 FAIL/0 SKIP；mapper 另有 `/tmp/gen1-model-projection-green.{json,log}` 9 PASS |
| E-SESSION | [`.ci/gen1-session/index.json`](evidence/gen1-20261008/regressions/session/index.json) 指向 public-session、gateway-resume-fork-list、idempotency、fork-integrity 的独立 RED；[`acceptance-green.json`](evidence/gen1-20261008/regressions/session/acceptance-green.json)：26 文件、287 PASS/0 FAIL/0 SKIP |
| E-SDK | [实际 SDK 答案 RED](evidence/gen1-20261008/regressions/session/actual-sdk-final-answer-red.json)、[实际文本 delta RED](evidence/gen1-20261008/regressions/session/actual-text-delta-red.json) → [`sdk-final-green.json`](evidence/gen1-20261008/regressions/session/sdk-final-green.json)：2 个真实 Harness/AppServer/SDK case PASS，包含 partial failure、错误身份、reasoning 不泄漏 |
| E-PROVIDER-IDENTITY | [原 stateful 现场](evidence/gen1-20261008/regressions/session/stateful-provider-restart.json)、[首批 3 FAIL/3 PASS](evidence/gen1-20261008/regressions/session/provider-config-identity-red.json)、[严格声明 4 FAIL/6 SKIP](evidence/gen1-20261008/regressions/session/provider-identity-validation-red.json)、[程序型数组 1 FAIL/10 SKIP](evidence/gen1-20261008/regressions/session/provider-array-subclass-red.json) 均保留；最终 [`provider-config-identity-eleven-green.json`](evidence/gen1-20261008/regressions/session/provider-config-identity-eleven-green.json) 11/11 PASS；[`provider-config-identity-freeze-green.json`](evidence/gen1-20261008/regressions/session/provider-config-identity-freeze-green.json) 21 文件、191 PASS/0 FAIL/0 SKIP；最终 typecheck 日志（开发时原路径：`.ci/gen1-session/provider-config-identity-freeze-typecheck-pass.log`） |
| E-ACTOR | `/tmp/gen1-followup-wakeup-red.json`：6 FAIL/1 PASS；`/tmp/gen1-followup-uncertain-red.json`：单选反例 1 FAIL/7 SKIP；`/tmp/gen1-followup-final-green.json`：6 文件、102 PASS/0 FAIL/0 SKIP，含新增 8 项确定性交错与已有恢复/竞争 |
| E-TOOLS | `/tmp/gen1-text-tools-red.log`：初始 6/6 FAIL；`/tmp/gen1-tools-final-v4.{json,log}`：12 文件、224 PASS/0 FAIL/0 SKIP；`/tmp/gen1-tools-typecheck-final.log` |
| E-REGEX | `/tmp/gen1-grep-red-probe-20261008.mjs`、`/tmp/gen1-grep-redos-red.json`、`/tmp/gen1-grep-redos-green.json`，真实子进程 dist/timeout/abort，不依靠 mock timer 掩盖主线程冻结 |
| E-SYMBOL | `/tmp/gen1-symbol-redos-probe.{mjs,json}`、`/tmp/gen1-symbol-redos-green.json`，来自独立复审的 native 阻塞现场 |
| E-INDEX | `/tmp/gen1-index-symbol-redos-probe.mjs`、`/tmp/gen1-index-symbol-redos-{red,green}.json`；`/tmp/gen1-index-export-redos-probe.mjs`、`/tmp/gen1-index-export-redos-{red,green}.json` |
| E-INTERACTION | `local-final/result.json`（开发时原路径：`.ci/gen1-interaction-local-final/result.json`）：Linux 实际 CLI/Web 子进程、loopback HTTP provider、native 工具/审批/验证/重启/取消/SSE，24 断言 PASS、0 付费调用；同行 assets 有真实请求/stdout/stderr/history。定向单元与 HTTP 反例源码/命令见交互报告 |
| E-BROWSER-RED | 真实 Chromium 首轮结果（开发时原路径：`.ci/gen1-web-browser/browser-result.json`） 保留 **FAILED**：deny、blocked cancel、socket outage case 未运行到预期，发现 Actor late-admission/lost-wake。修复后工作树补验（开发时原路径：`.ci/gen1-web-browser-postactor/browser-result.json`） 为 29/29 case PASS，0 浏览器错误；它仍含未提交源码，不替代最终 fixed-source 浏览器验收 |
| E-HOST | `/tmp/gen1-data-dir-host-probe.{mjs,json}`：两个真实 Harness 的 durablePending 只剩 B；`/tmp/gen1-data-dir-lease-green.json`：5 PASS/1 Windows-platform SKIP；`gen1-host-lease-first/result.json`（开发时原路径：`.ci/gen1-host-lease-first/result.json`）：Linux CLI 写前拒绝、崩溃释放、失败 Web startup 释放三 case PASS |
| E-PERSISTENCE | `/tmp/gen1-independent-red.{json,log}`：13 FAIL/1 PASS → `/tmp/gen1-independent-green.{json,log}`：14 PASS；最终 `/tmp/gen1-persistence-release-final-green.{json,log}`：7 文件、60 PASS/0 FAIL/0 SKIP |
| E-ASK | `/tmp/gen1-ask-mutations-red.{json,log}`：3 新 FAIL、2 已修加载 PASS；最终 E-PERSISTENCE 含三个原生持久化失败/重试回归 |
| E-BUDGET | `/tmp/gen1-budget-bootstrap-red.{json,log}`：1 FAIL；`/tmp/gen1-budget-bootstrap-probe.{mjs,json}` 保留双预算现场；最终 `/tmp/gen1-budget-all-final-green.{json,log}`：9 文件、110 PASS/0 FAIL/0 SKIP |
| E-BUDGET-BOUNDS | `/tmp/gen1-lock-bounds-red.{json,log}`：3 FAIL，真实 child 限时/永久读错；最终 E-BUDGET 覆盖 |
| E-BUDGET-TAKEOVER | `/tmp/gen1-ledger-takeover-probe.{mjs,json}`：修前 native 双 critical section 重叠；`/tmp/gen1-budget-guard-green.{json,log}`：3 文件、6 PASS（其中 2 takeover guard 回归），最终 E-BUDGET 再覆盖 |
| E-MIGRATION | `/tmp/gen1-migration-red.{json,log}`：5 FAIL；`/tmp/gen1-migration-green.{json,log}` 及最终 E-PERSISTENCE 包含 dry-run/真实目标写错反例 |
| E-RELEASE | `/tmp/gen1-release-audit-red/result.json`：4 个实际 produced=true 假阳性；`/tmp/gen1-release-artifacts-green.json`：6 PASS/0 FAIL/0 SKIP |
| 安全/静态局部组 | `/tmp/gen1-audit-security-full.{json,log}`：20 文件、2143 PASS/0 FAIL/0 SKIP；`/tmp/gen1-audit-no-silent-catch-final.{json,log}`：4 PASS。它们仍不是最终固定源码的全量 release attestation |

## 恢复身份合同与尚未证明的能力

**M9/G11 已通过显式可选稳定身份方案修复，未知 provider 仍保守比较。** [原真实复现](evidence/gen1-20261008/regressions/session/stateful-provider-restart.json) 的同实例重建误报及[中间失败记录](evidence/gen1-20261008/regressions/session/stateful-provider-intermediate.json) 保留为历史 RED，不能覆盖成新 PASS。最终 11 直接反例与 21 文件 191 项组验证原实例执行/重建、真实脚本或 unknown endpoint 改变仍拒绝、普通 provider 旧 hash 不变、冻结值与 hash 保持同一捕获数据。独立只读 native dist 复核再次确认：自定义继承 iterator 的数组拒绝声明且回退；unknown 字段保留；原 snapshot 不被外部数组 mutation 改写，真实配置变化产生不同 fingerprint。

这个方案不按 id/类名自动删除运行字段：自定义 provider 必须声明全部影响执行的配置与必要实现版本，返回 plain stable JSON；未声明或程序型脚本保留原 fail-closed fallback，仍可能因运行字段变化拒绝同实例恢复，可以按相同构造配置重建对象或明确实现身份合同。早期 Scripted 会话的旧字段格式不自动豁免/重置冻结基线，出现 drift 时建立新会话。原执行 provider 没有被 identity record 替换，也没有为测试放宽未知实现的身份门。

以下能力尚未集成：Anthropic Messages/原生 thinking、OpenAI Responses/订阅 OAuth、多模态、自动模型目录与 effort 控制、actual usage/tokenizer 校准预算、可选模型摘要；完整 TUI、任意消息树 fork/rollback、PTY/后台 stdin、完整 LSP、所有外部记忆供应商。它们是后续能力，不应伪装成本轮已修 bug 或已交付优势。

最终clean源码c5已产出全量9284 PASS / 0 FAIL / 14 pending、安全2143、协议52、实际CLI/Web24断言、Chromium29cases/82断言、原生Windows及同archive消费原件。完整CI run37740692345的10jobs全部SUCCESS，包含coverage、sameSHA双平台与P38-12 attestation；阶段性Linux结果、Windows静态代码/SKIP和脚本定义没有被用来替代这些证据。[最终验收](gen1-final-acceptance.md)单独绑定准确源码、命令和终态。付费真实模型编码质量、费用及与参考 agent 的成功率比较仍为 `NOT_PROVEN`，由独立模型实验验证。

## 固定源码首轮验收后的补修

`b9c5b05` 的完整 Linux 测试实际得到 9268 PASS / 3 FAIL / 14 pending，525 个文件；原始结果保留，不作为通过凭据。远端双平台 full/formal 也暴露同三失败。

| 问题 | 修复与复验 |
| --- | --- |
| 精确文本 overflow 规则漏掉正式 `CONTEXT_OVERFLOW` 错误码，两个 reactive tail 回归失败 | 先保留认证/限流/参数排除，再识别该正式 code；最小 RED 6 FAIL/52 PASS → 58 PASS，原模型组+active context 24文件416 PASS；不恢复宽泛 token 正则 |
| 旧 RPC fixture 把 idle followup 当永不执行的队列预填，和自动唤醒的新合同冲突 | 用确定 running gate 验证 queued=1，取消首轮后验证真实下一 turn 完成/pending=0及消息身份；新增idle自推进；相关15文件266 PASS，生产行为不回退 |
| 打包器依赖根 tsconfig references，漏掉间接 `@ar/store`/`@ar/orchestration`，独立包无法产出 | 按实际pnpm workspace inventory枚举、校验闭包并fresh-build全部包；RED8 PASS/2 FAIL → portable10 PASS；隔离固定提交预验1621文件、doctor0error、50编码断言/19请求及篡改拒绝均通过 |
| 新打包 fixture 假定磁盘CRLF等于Git blob，Windows autoCRLF会归一化 | fixture显式启用autoCRLF，期望绑定真实固定Git blob；原raw-byte打包规则不变，同反例10 PASS |

GitHub Actions 原件下载的储存域在本环境由代理拒绝；原生 Release 资产下载已实际验证可用。新增受限CI导出只向本任务现有的私有draft写入准确源码的证据，失败也保存原件，绝不创建/发布或覆盖Release。安装资产须三腿真实通过且Linux包在Windows消费的hash相同才可准备；完整CI与发布仍由主交付另验。每个阶段保存原始stdout/stderr/hash，不能用定义文件或失败日志冒充成功。

以上保留中间开发结果和原始失败；后续已由clean源码c5重新完成G7的必要工程验收，公开发布仍待最后动作。真实模型质量仍NOT_PROVEN。


## 干净交付验收新增问题与修复

| 编号 | 真实问题 | 解决与实际验收 |
| --- | --- | --- |
| M2 补充 | b9精确文本规则漏正式CONTEXT_OVERFLOW错误码，两个active-context回归失败 | 保留auth/rate/unsupported参数排除后识别正式code；RED6 FAIL→58 PASS，模型24文件416 PASS；最终全量9284 PASS包含原两个回归 |
| R5 | portable将根tsconfig references当workspace inventory，遗漏store/orchestration导致独立包无法产出 | 实际pnpm枚举、完整闭包检查及fresh构建26包；RED8 PASS/2 FAIL→14 portable PASS，CI双平台安装及同bytes消费通过 |
| R6 | 原生Windows短路径临时别名与realpath直接比较，合法根误报越界/解包拒绝 | 只在受信任创建/发现边界统一规范路径；原native5 PASS/5 FAIL→14 PASS，Linux别名负控也验证；extractArchive安全规则未放宽 |
| R7 | 历史manifest90件有20原始.log被Git忽略，原tree校验假定它们已交付；新worktree缺文件 | 原件哈希匹配后显式提交20个文件；独立仅Git blobs还原92件并校验90件PASS；归档最终使用原字节属性，原RED和schema不改 |

以下为验收fixture补修，不能伪称新的产品功能或另计模型效果：RPC原fixture预填idle队列不符合自动执行合同，改实际running gate并验证新turn/真实消息与pending0；CRLF fixture以Git blob为期望，保留产品raw-byte构建；SSE脚本原先等text就立即assert稍后terminal，改等待同turn/session/event ID，restart排除旧重放事件，保持原15秒期限及失败断言，受控6/6与真实双平台交互均通过。

49条初审记录、上述验收新增缺陷及fixture补修已实现；最终测试源码与证据见[最终验收](gen1-final-acceptance.md)。这里记录已发现并解决的问题，不声称不存在未知bug。真实模型质量仍NOT_PROVEN。
