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

## 2026-10-29：安装版 UI 验收发现的观察器重入

03c69cbf 审查分支的一代安装验收通过，但官方 UI 安装验收在 Windows、Linux 均失败：回合结束后 Stop generating 不消失，后续 rename/read/ask 连带超时。原始工作流 40729966216 与两个失败 job 122963877319、122963877423 已保留；native/CI 的若干测试阶段到达各自 20/30/45/60 分钟时限后 cancelled，不计为通过。未取消、重跑或延长任何门禁。main 仍为 06aeaf1f。

已经用同一份 03c69cbf 原生 dist、本地零付费模型和真正 production composition/HTTP 复现：终态行及唯一终态事件已提交，但 actor outcome 不返回。持有 terminal session lock 的发布等待同步 deliverables observer；observer 经过受控 host-tools 查询 getSessionAgent，再次请求相同终态恢复锁，形成自等待。纯 Harness 可完成；仅在因果对照中省略策略读取的终态恢复（仍执行原 frozen policy resolver）则 composition 可完成。初始 append 前故障后的冷补投同样能复现，不能用“正在运行时跳过”掩盖。

### 做什么、怎么做

新增明确的 getSessionAgentPolicy 策略视图，复用原有 session 归属、冻结策略、模型选择和策略漂移检查，只不推进 terminal reconciliation。内部受控 host-tools 及 owner facade 使用该视图；公开 metadata/start/resume/cancel、actor load/hydrate 保留实际补投和 fence。同步观察器仍被等待；权限、沙箱、ToolOrchestrator、真实文件快照和变更 diff 不变。不引入全局跳过标志或 detached callback。

### 怎么验收

- 保存原 dist 的纯 Harness / 实际 composition / 策略因果对照与真实 HTTP 正常完成、冷补投死锁反例。
- 新 core 回归覆盖 observer 同步策略查询、未知/坏/外来 snapshot 拒绝、受限父子权限、modelSelection 崩溃补投及 drift；确认策略视图不补 terminal，原 metadata 仍补投/fence。
- 新 Web 回归使用实际 HTTP、受控真实文件写入、正常完成及 append 前/后失败恢复；验证唯一终态、actor outcome 返回、文件 diff、rename 与下一轮 prompt。隔离自锁子进程，测试失败不能拖死测试框架。
- 用真实 Chromium 操作原来的 UI 场景与原有时限，验收桌面/手机/窄长视口；随后在新的干净实现提交上跑 typecheck、全量测试与实际 CLI/Web coding 验收，最后核对精确 SHA 的四项 CI。
- 03c69cbf 本地全量在环境中断后只留启动日志，没有完成收据，不宣称通过；新源代码需要重新执行全量。

### 重入修复阶段结果

- 新策略 API 的 9 项基线全红，修后与原终态/配置/安全相关共 67 项通过。
- 新生产 HTTP 三场景在原 dist 上 3/3 失败；修后三场景 3/3 通过，分别约 0.5 秒，包含真实审批写入、完整同步快照/diff、唯一终态、冷补投、重命名与下一轮任务。最初子进程 import bootstrap 和测试错误读取 payload.tool 的失败日志另留；修正为实际 schema payload.name 后才统计行为通过。
- 原来的 Chromium 30 场景、3 视口全部通过，原有 15 秒/8 秒交互时限未改，实际宿主正常关闭，付费调用 0。这是当前构建工作区字节验收，不能冒充干净发布安装包；安装版仍需新 SHA CI。
- typecheck、静态 fixture 语法、CRLF 兼容 whitespace 检查通过；core 与 Web 交叉只读复核通过。
- 原始日志：/tmp/harness-terminal-observer-policy-{red,green}-20261029.log、/tmp/harness-ui-terminal-observer-{red,green,bootstrap-error,fixture-assertion-error}-20261029.log、/tmp/harness-ui-observer-browser-20261029/receipt.json。后续继续新干净提交全量及远端验收。
