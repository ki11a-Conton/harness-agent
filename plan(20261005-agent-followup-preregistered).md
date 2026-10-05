# Harness Agent：流式计量、符号搜索与指令读取修复

2026-10-05。基线 `f71b444eec6b4024039716a1a0a01bade22c90b0`。本计划在生产修改前提交，上一轮入口保存在 [历史计划](plan(20261005-agent-efficiency-entry-before-followup).md)。任务合同：[AGENT-FOLLOWUP-20261005.md](tasks/AGENT-FOLLOWUP-20261005.md)。

## 已复现的依据

- 真实 HTTP 请求带 `stream_options.include_usage: true`，服务依次返回文本、正常 stop、独立 usage(137/23)、DONE，现有 provider 返回成功却没有 usage。消费者提前结束后，原生响应流 cancel=0 且仍被锁定。消费者在 text_delta 后取消时，已缓冲的 stop 仍可能成为成功，或真实 fetch 的 AbortError 直接逸出而没有 cancelled 事件。
- 真实 ToolRegistry → ToolOrchestrator → PermissionEngine → Sandbox：Python-only 能命中符号，增加无关 TS 文件后相同 root/Python 子目录查询成为空结果；允许的绝对子目录路径为空而相对路径成功；只允许搜索 ts 子目录仍实际读取 private/secret.ts。deny/outside 控制均零读取。
- opt-in PathScopedInstructionDiscovery：cap=1 的非法 UTF-8 单字节被转换成 3 字节替代字符；真实 descriptor 关闭后 EIO 使整个 discover 拒绝；提前零读取将未完整捕获的文件当作空文档准入并缓存。默认 discovery 已有防护，可作为独立控制。本轮保持该策略 opt-in。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- | --- |
| R1 流式计量与取消 | 收齐标准 usage footer，结束后释放流，取消不能误判成功 | 仅修改 OpenAI provider：记住首次正常 finish_reason；同帧有 usage 即完成，否则读独立 usage/DONE/EOF。footer 只更新计量，不能追加正文、reasoning 或工具意图；先前 partial usage 不代替最终 snapshot。每次读与 yield 边界检查取消，区分 caller abort、deadline、读取错误，不重试流阶段；finally best-effort cancel/release reader | 新测试基线 RED、候选 GREEN；同帧/分帧/跨网络分块/早期与最终 usage snapshots，stop/tool_calls 各仅一次 completed；DONE/EOF 无正常 finish 仍失败，异常 reason 不执行工具；footer 注入不改输出/工具。真实 loopback HTTP 与实际 CLI/Web 工具闭环的 durable token accounting 正确；buffered abort、HTTP abort、footer abort/timeout、消费者 break、reader error/cleanup error 控制通过 | TODO |
| R2 搜索范围与混合语言召回 | 搜索真正限于获准路径，绝对/相对路径一致，TS 文件不屏蔽其他语言 | 在符号索引/导航 wrapper 层规范化 root-relative scope，只枚举、stat、读 scope 内文件；cache/flights 以 root+scope 隔离，保留 root-relative 输出。索引无命中时采用既有 regex fallback，仍标明 heuristic；若选定路径无 TS/JS，直接既有 fallback。保留已有 TS 命中优先、结果 cap、忽略/符号链接规则 | 基线 production RED、候选 GREEN；混合 TS/Python 的 root、子目录、文件查询；绝对/相对 alias 输出一致；cold/warm/切换/并发 scope 不读其他 scope 文件且不混缓存；cap/ignore/权限 deny/outside 等控制。真实生产工具流水线读取计数与输出验收，不能只 mock wrapper 返回 | TODO |
| R3 指令捕获硬边界 | opt-in 发现拒绝无效或不完整文档，单文档清理错误不破坏发现 | 仅对齐已有 default discovery 的读取防护：非阻塞/no-follow open，打开后真实 regular file 与 revision 校验，必须完整捕获 cap+4 内前缀，读取后 pathname/descriptor revision 再核对，fatal UTF-8 解码并保留 BOM；close 错误隔离。保持 marker、缓存、顺序、targets 来源与所有准入/注入扫描规则 | 新回归 RED→GREEN；非法 UTF-8、截断边界、BOM、短读累积/提前 EOF、revision/type/path 竞态、真实 close 后 EIO、读失败仍继续其他文档；cap+4 分配/实际读取边界；cache 不保存失败捕获；既有 symlink/越界/策略与真实 Harness opt-in 指令准入测试通过，default 路径不改 | TODO |
| R4 联合验收与发布 | 同一 clean 源码验收并留下可复核证据 | 实现/回归/探针先提交；冻结源码运行 typecheck/build、model/tools/context/Harness 定向集成、相关 security、实际 HTTP/CLI/Web、既有浏览器27场景、docs；一次具名全仓测试及同 run strict usage audit；独立代码复核，归档真实日志和哈希。最后完成文档并原生 Git/curl 推送 main | 所有门退出0；新增正式测试0skip；既有skip按原件说明；baseline/RED/失败日志不覆盖。冻结源码/测试命令/原始证据相互绑定；归档索引验证通过；本地和原生远端 main SHA 一致。不得以旧源码验收冒充本轮 | TODO |

## 范围与限制

本轮属于已复现 deterministic correctness / scope isolation 修复，符合 AGENTS.md Runtime Freeze 例外。生产修改限于 `packages/model/src/openai.ts`、`packages/tools/src/symbol-index.ts`、`packages/tools/src/tools/navigation-tools.ts`（必要时 `navigate.ts` 的文件路径 fallback）与 `packages/context/src/path-scoped-discovery.ts`；相关测试、研究脚本与文档可新增。Core、Orchestrator、Permission、Sandbox、Verification 不改，不引入依赖或新默认策略。

R2 的既有 TS 命中仍优先：本轮修复“无索引命中时其他语言完全丢失”，不声称一次混合返回所有语言的所有定义。regex fallback 仍非语义索引。R1 可能需要等待正常 finish 后的 footer；现有 request deadline/caller cancellation 继续约束等待，未收到正常完成证据不得授权工具执行。

本机无真实模型凭据。使用本地 OpenAI 兼容服务与 production Harness 验证协议、计量和工具行为；paid=0，真实模型任务质量、champion promotion、Windows 实机执行均 NOT_RUN。工程修复不等同于实测模型成功率提升。GitHub 只用原生 Git/curl，凭据不保存或输出。
