# Coding 长任务边界审查与修复（2026-10-30）

## 做什么

基于最新 main `2cfd8591def937fe9530baf25a5a952098a17d35`，继续审查会导致 coding 任务中断、错误完成或重复/丢失操作的边界。只修改有确定性反例的缺陷，保持 Runtime freeze、ToolOrchestrator、PermissionEngine、SandboxManager、Verification 和原验收预算。

1. 检查异步工具预算预留、事件发布后是否仍严格执行任务截止时间。
2. 修复已通过真实 Provider 复现的错误响应体无界读取、畸形 SSE 静默丢失、非法字段类型穿透模型事件契约。
3. 复核手动压缩期间再次请求的持久化语义；确认反例后修复，保证重启不丢请求。
4. 复核受管理命令终态持久化与完成/验证门禁的先后关系；确认反例后修复，保持 unknown fail-closed。

## 怎么做

- 三路独立审查 Provider、上下文生命周期、命令生命周期；主审检查工具实际分派边界。
- 每个缺陷先保留旧实现的失败测试或实际调用反例，再做最小修复；禁止以仅修改测试取得通过。
- SSE 只对被消费的协议结构做明确验证，保留合法注释、心跳、footer、分片及取消行为；错误诊断有界，不重放已有内容/工具。
- 压缩和命令修复以请求身份/真实持久化完成为依据，不用可碰撞的墙钟顺序推断成功。
- 临时测试与证据放在隔离 `/dev/shm/harness-long-task-boundaries-20261030`；不删除上轮归档或借用工作树，不调用付费模型。

## 怎么验收

- 工具截止时间：预算预留或 `tool.started` 发布期间越过截止，真实写文件工具不得写入；已预留预算恰好结算 `not_executed`，仍有效的任务正常执行，原权限/沙箱拒绝行为不变。
- Provider：超长或持续错误体读取有界并释放 reader；畸形 JSON/消费字段类型不得静默正常结束或产生非法 ModelEvent；原 SSE、多行 data、usage、取消和重试回归通过。
- 手动压缩：阻塞第一轮摘要，期间提交第二次请求；第一轮完成后后一次请求仍持久待处理，重开状态仍存在，实际后续摘要消费它；单次/重复完成不产生幽灵请求。
- 受管理命令：终态 journal 写入挂起/拒绝时不得返回可验证成功或放开冲突写入；持久化成功后才报告终态，原取消、unknown、owner 和恢复门禁通过。
- 完成相关单元、集成、安全测试及 `pnpm typecheck`，独立复核；新干净提交执行完整源码测试和精确 SHA 的双平台 CI。原失败、跳过及不能验证的范围如实记录。
- 验收成功后按既有授权普通快进推送 main；不发布 release、不强推、不取消/重跑 CI、不改原预算或放宽断言。

## 执行记录

- 已同步远端，确认 main 与本地基线均为 `2cfd8591`，源码树干净。
- Provider 外部实际调用复现 3 个边界缺陷；源码新增测试旧实现 12 失败/2 通过，最终 model 包 19 文件 264 项通过。64KiB 错误体前缀、截断尾 token 后脱敏及 reader 清理均验证；原真实 HTTP 取消 16 项的断言与预算不变，仅观察点由 text 改为原 reader.read。
- 工具截止旧实现新增 6 项为 3 失败/3 通过，真实文件在截止后仍写入。修复异步预算/事件等待两处窗口，同时避免截止拒绝重复发布失败事件；最终 7 项及原 orchestrator/budget/review 共 4 文件 87 项通过。第一次修复仍有重复失败事件的 2 失败/84 通过记录保留，未删 exact-once 断言。
- 手动压缩使用真实 production composition、阻塞摘要、连续同毫秒请求、真实 close/reopen 复现；以可选持久 UUID 和 build 消费快照替代完成时间比较。旧源码新增 1 失败/1 通过，修复后相关 6 文件 89 项通过；最后仅收窄元数据保留后 2 文件 31 项再次通过，新增第 3 项覆盖消费之后、started 之前到达的新请求。legacy 记录兼容，自动压缩及重复完成不清除新请求。
- 受管理命令真实进程复现 terminal journal 未确认时 poll 已成功、真实写入已放行、Verification 已通过，随后写入拒绝才变 unknown。新增 5 项旧实现全失败；终态确认位覆盖 poll/jobs/容量/工作区锁/验证/替代，写入失败保持 unknown，另补 admission 耗尽截止时漏写 timed_out 的路径。修复相关 5 文件 40 项通过；最终 fixture 等真实 gate、沿用框架预算后 5 项再通过。
- 四组实现均经独立只读复核，无阻塞；根目录 `pnpm typecheck` 通过。主审工具/安全/恢复/生产集成 89 文件为 3097 通过、12 跳过；native Windows 收据解析器 Node 16 项通过。5 个本轮边界测试文件加入既有 Windows 执行命令，所有原文件、46 必需项和预算保持。
- 原始红绿与中间失败位于 `/dev/shm/harness-long-task-boundaries-20261030`；真实外部反例另保留 provider/context/managed 独立目录。所有当前结果是离线工程正确性，真实模型 coding 质量未评测；Windows 根退出后子孙继续运行只有代码线索，未改动或宣称修复。
- 干净实现 `27bc9bc3078f0473981bb5ee285ed88403664dc0` 的完整源码原 `pnpm test` 已实际退出 0：679 文件通过、2 文件跳过；10537 项通过、16 跳过、0 失败。Node 24.19.0，前后源码树干净，日志 185336 字节，SHA256 `71f19e5b7d17ce95838db7aa427e7e656e6f06f4661e5c8be1af07fdcd258df9`。借用完整 clone 已恢复原 `feat/full-audit-20261026` / `66a9238c` 并强制构建通过。
- 同一干净实现实际 CLI/Web coding-v2 通过 50 项工程及 8 项提示安装断言、19 个真实 loopback HTTP 请求，付费调用 0，真实模型质量 NOT_PROVEN。
- 分支 `27bc9bc3` 首次 [真实 Windows 41023301920](https://github.com/ki11a-Conton/harness-agent/actions/runs/41023301920) 实际 82 文件、836 通过/0 失败/2 跳过，原 46 必需项各一次通过，source=workflow=27bc、tree clean。rawReport SHA256 `db909b82b0daab81d503b678cb140fd4599d773dd6a8017ec97b3e40a55c411d`、caseRecords `f49777629027b711298ed2f8aa214f9e6dacc8848a0d70814a0a3a5324164f11`。[Gen1 41023301954](https://github.com/ki11a-Conton/harness-agent/actions/runs/41023301954) 三条执行腿通过、原 draft 导出跳过；[安装 UI 41023301930](https://github.com/ki11a-Conton/harness-agent/actions/runs/41023301930) 三个 job 全通过。
- 原 [综合 CI 41023301918](https://github.com/ki11a-Conton/harness-agent/actions/runs/41023301918) 的 Windows job `123955451631` 失败，不能因其余门禁通过计为绿灯。API 原 annotation 为 PR15 降权测试等待审批 `0 != 1`，继而 owner closed；原日志下载 HTTP403 的 receipt 保留。原 SHA 原 CI 自然运行，不取消或重跑。

### Windows 审批验收同步跟进（仅验收设施）

源代码与实际 dist 两层外部受控 1250ms context 准备延迟证明：原默认 1000ms poll 把 owner/turn/context 准备误算作审批延迟，失败后未等待 running，导致 teardown owner closed。实际后续审批仍出现，真实降权取消、迟到 allow 拒绝及文件不存在均正确。该实验仅证明机制，不冒充原 Windows 故障重放。

只修原 PR15 测试：提前准备 turn；观察原 resolver 调用真实 `approvalStore.create` 的同步边界，然后才开始原默认 1000ms poll；不先等待 pending、不合成审批或绕开原链，新增 request.id 一致检查。原 exact 1/0、降权、late allow 拒绝及文件 ENOENT 全部保持；finally 以实际 actor signal 取消并等待 running，再恢复 spy，保留正常错误。框架原 300000ms 总预算不变。

同一外部延迟 setup：旧源码用例 1 失败/27 定向跳过并含 1 unhandled owner closed，新同步用例 1 通过/27 定向跳过且无 unhandled；PR15、压缩、审批 4 文件 49 项通过，根 typecheck 通过，独立复核无阻塞。原 PR15 文件也加入 native Windows 命令，保留原全部文件、必需断言与预算。使用另一主题分支避免取消原 SHA CI；后续精确新 SHA 的双平台 CI 仍待完成。产品代码相对 `27bc9bc3` 完全不变，不重复冒称本地全量是在后续验收提交上运行。

### 修正提交的实际 CI

干净 `3d1609d4d158f8b415b70e783f36da80ce4ce739` 首 attempt 四项全部成功：[综合 CI 41025945153](https://github.com/ki11a-Conton/harness-agent/actions/runs/41025945153) 10 个 job 全 success；[真实 Windows 41025945188](https://github.com/ki11a-Conton/harness-agent/actions/runs/41025945188) 83 文件、864 通过/0 失败/2 跳过，原 46 必需项各一次 passed；[安装 UI 41025945298](https://github.com/ki11a-Conton/harness-agent/actions/runs/41025945298) archive、Windows、Ubuntu 全通过；[Gen1 41025945199](https://github.com/ki11a-Conton/harness-agent/actions/runs/41025945199) 三条执行腿通过、原条件 draft 导出跳过。Windows source=workflow=3d1609d4、tree clean、Node 22.23.4；rawReport 收据摘要 `b5b02ae3437df9a9789371383aecafad2363bc3ce250e91abba30c01df1cc659`，caseRecords `822bdc8b715834e3ab49b1a8cd28a01af8a3f98905847fb6bca778910e5a533f`。

case records 超出 9 个 annotation 包预算，完整内容仍由 CI artifact 保留；本次云端仅取得 artifact 索引与收据，不能把其中 hash 冒称已下载完整文件复算。四项工作流、jobs、原失败及来源版本的原始 API 收据均保存。

仅提交验收文档后普通快进 main，再监听 main 自身精确 SHA 的自动 CI；不重复本地全量、不转借主题分支结果为 main 结果、不发布 release、不改原失败记录。
