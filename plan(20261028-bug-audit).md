# 2026-10-28 Bug 复审与修复

基线：远端 main `06aeaf1f8a555f40a1339f29d0c98b2cb7df090d`。本轮是新审查，不重跑已完成的上一轮验收，不据历史绿灯声称没有其他 bug。

## 做什么

1. 修复模型设置卡隐藏已保存密钥后，“获取可用模型”不使用有效凭据的失败。
2. 修复回合终态落盘与完成事件落盘之间的故障窗口，以及重复收尾把首次结果的 reason/grade/error 改成后一次参数的问题。
3. 修复语法索引把单次短读当成完整文件，可能漏符号、忽略后半段 .gitignore，仍报告 complete 的问题。
4. 修复 Provider 将合法 SSE 同事件多条 data 行分别解析，静默丢失内容后仍报告正常 stop 的问题。命令取消另做审查；未实际复现的 Windows 后代进程疑点单列，不推测性修改。

## 怎么做

- 模型目录：仅当 provider 和正规化后的已保存 endpoint 一致时，在宿主内部按现有 environment > launch > storage 优先级解析凭据；一次性显式密钥仍优先。保持 ToolOrchestrator、网络审批、禁重定向、私有 ticket 与密钥不出站到错误 endpoint 的合同。
- 回合收尾：参考已有 modelSelection 持久 outbox，在同一 Turn 行固定第一次终态和完整事件身份/载荷；发布失败后从已保存意图补投。去重 append 后才报错的情形，重复/并发收尾不改首次结果，不重复执行模型或工具。没有 outbox 的旧终态不能凭空制造历史验证证据；保留暂停/恢复合同，同时把运行前撤销、真实用户提问暂停后的取消接入同一持久终态通道。提交成功与冷启动补投都保持既有 durability fence，失败不作成功确认；暖路径用有界失效缓存避免重复磁盘扫描。先保留反例，再实施兼容修改。
- 语法检索：循环实际描述符短读至 EOF 或实际字节上限，保留版本/真实路径检查；每次读取检查取消并在所有路径关闭句柄。源码 hash 与 .gitignore 都必须覆盖实际完整字节，不把部分源码标成 complete。
- Provider SSE：按事件而不是单条物理行解帧，合并多 data 行；支持 LF/CRLF/CR 与跨网络分片，保持 EOF 兼容、正常结束/usage、部分工具参数不得重放、取消与 reader 清理合同。保留原有异常 JSON 处理策略，不连带扩大到 Provider 重试策略。
- 不做 Runtime 重构；上述 Runtime 维护仅因可复现正确性缺陷，符合 AGENTS.md 冻结例外。禁止付费模型调用、不发布 release、不用 GitHub 连接器，不放宽原有 CI 断言或预算。

## 怎么验收

- 保存旧代码上的失败日志与最小回归；修后同一回归通过。
- 模型目录：真实本地鉴权 HTTP 请求，launch/env/storage 来源与显式替换；更改 host/port/protocol/path 或未知 provider 不得复用旧密钥；事件/响应/持久记录无密钥。
- 收尾：事件 append 前失败、append 后失败、重新创建 controller / 真实持久存储重开、重复/并发 finish，完成事件恰好一次且首次状态/错误/等级一致；公开恢复入口不执行额外模型/工具；旧终态兼容。覆盖 actor/race/故障注入及相关安全测试。
- 语法检索：真实临时文件与真实 FileHandle，控制每次 native read 长度；尾部符号可找到且 SHA 正确、.gitignore 尾规则生效、实际增长超限不返回完整性、取消/异常关闭句柄；相关语法索引与工具安全测试通过。
- Provider：真实本地 HTTP 服务重现多 data 行内容丢失，测试工具参数、多字节分片、CR 和 CRLF、usage 尾帧、EOF、取消及 reader 释放；现有 model 相关回归不退化。
- 运行 typecheck、相关单元/集成/安全测试和全量回归；记录失败而不隐藏。独立复核 diff 后提交、正常快进推送 main，核对精确新 SHA 的 CI；未完成或未证实之项单独写明。

## 审查结果与证据

执行中。原始日志保留在本机 /tmp，收尾补充路径、测试结果与剩余限制。

### 实施阶段结果（全量与远端门禁前）

- 模型目录：旧代码 4 失败/2 通过，同一新增回归修后 6 通过；新旧相关共 40 通过。真实 loopback HTTP 401/200 与重定向陷阱，未调用模型。
- 语法索引：旧代码 3 失败/2 通过，修后 5 通过；检索及全部 security 相关 2231 通过。真实 FileHandle 短读与增长边界，未把受控短读说成常见机器必然发生。
- SSE：新增 9 项在基线全红；修后整个 model 包 246 项通过。独立 5 向量、224 个网络分片切点通过；无第三方代码复制、无新依赖。
- 终态：初始 6 失败/1 通过，另保留运行前撤销、真实提问暂停取消、fence 读取失败、重复取消/队列唤醒的独立红例；最终 core 新 20、JSONL/SQLite 真正重开新 8，加原恢复/取消/崩溃/安全共 53 通过。
- 原相关 303 项中 crash-matrix 第 9 项曾失败：初版拒绝已终态 resume 破坏旧合同。保留原断言，改为只读重建并返回首次结果，最终该 8 项崩溃矩阵全通过。异常路径还复现了 async finally 暂缓接管 terminal promise 导致 unhandled rejection，已用 return await 保证错误由调用链接收。
- 终态冷恢复一次批量读，暖路径不增加 listTurns/events.list/fence；缓存各最多 1024 项。同 store 的另一 controller 提交失败会使暖缓存失效。跨进程仍由原 owner/数据目录 lease 保证，不宣称实现跨进程 CAS。
- 最终 typecheck 通过；两轮独立只读复核通过。全量测试、实际 CLI/Web 烟测、干净 SHA CI 尚待下阶段完成，当前不宣称这些已通过。

原始日志留在 `/tmp/harness-{model-discovery-credentials,sse-framing,terminal-outbox,...}-*-20261028.log` 和 `/tmp/harness-bug-audit-*-20261028.log`；收尾报告会列精确文件及校验值。

### 未证实与兼容限制

- Windows 根进程先正常退出、后代继续运行的清理候选，尚无本轮真实 Windows 反例；本轮不推测性修改 executor。
- 错误响应体先完整读取后截断、畸形 SSE JSON 沿用 keepalive 忽略策略，仍需独立资源/协议反例与兼容设计；本轮没有宣称解决。
- 没有新 outbox 的旧终态缺少首次原因/验证证据时不补造历史信息；人为伪造 waiting 状态且没有可恢复 pause/checkpoint，不生成虚假的 no-effect 取消。
- 不涉及付费模型质量实验，也不发布 release。
