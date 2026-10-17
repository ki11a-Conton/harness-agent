# apps/web 发现总表（规范化）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-020 | deepseek/events.ts:53-77 | 每个 `$events` 流每 ~25ms 遍历所有会话 + 全量日志求 pending | D | P1 | 改为事件驱动（appendNew 后置脏标记）+ 维护 pending 索引 |
| WEB-021 | deepseek/session.ts:443-455 | `session/control` 每 25ms 对每个会话全量重投影（含 host tool 读文件） | D | P1 | `projectUnlocked` 改为按 sourceSequence 增量投影；缓存 baseline 并在无新事件时跳过 `meta()` 读盘 |
| WEB-039 | bindings.ts:41-50 | 最弱的一份 durable 写：固定 .tmp、跟随符号链接、无校验 | D | P2 | 直接用 `@ar/store-integrity` 的原子写（与 metadata.ts:112-130 同款） |
| WEB-034 | deepseek/{activity.ts:517,events.ts:285,catalog.ts:65,projections.ts:597} | JSON 值校验手写四遍，深度上限 20/30/无/无 | A | P2 | 合并到 `@ar/contracts` 的单一 `assertJsonValue(value,{maxDepth})` |
| WEB-032 | deepseek/activity.ts:181-249 | 每 tick 全量 read + 每 task 单独 mutate 同一文件 | A | P2 | 收集到期 task 一次性 mutate |
| WEB-033 | deepseek/catalog.ts:55-71 · files.ts:21-37 · coding-status.ts:5-6 · events.ts:53-77 | 入参校验 helper 四套并存，错误码不一致 | A | P2 | 合并为一个 `wire-validation.ts`，全包统一错误码 |
| WEB-017 | deepseek/composition.ts:204 | 第二次读取 boot-manifest，无 symlink/尺寸/schema 校验 | A | P2 | 复用 server 的 `loadBootGraph` 或抽公共 loader，统一校验 |
| WEB-018 | deepseek/composition.ts:35-271 | 单函数 236 行装配全部服务并猴补事件总线 | A | P2 | 拆为 `configureOwners` / `configureActivity` / `configureHttp` 三段，装配层只做顺序编排 |
| WEB-042 | deepseek/deliverables.ts:210-250 | 每 turn 两次全工作区遍历+全量 sha256 | D | P2 | 复用文件监视/变更缓存，只对 mtime 变化的子树重新 hash |
| WEB-043 | deepseek/deliverables.ts:239-243 | `summaries` 只增不减，常驻完整 hunks | D | P2 | 以 LRU（如最近 50 个 turn）淘汰，或落盘并在读取时回查事件 |
| WEB-037 | deepseek/files.ts:204-209 | 两套 ToolResult 解包，取消被报成 `gateway/internal` | A | P2 | 只保留 `toolValue`，`readTool` 改为委托 |
| WEB-047 | deepseek/host-tools.ts:101-110 | 无 session 参数即可对任意绝对路径列举/建目录 | D | P2 | 由用户手势签发一次性 capability（路径 + 有效期），而不是以“无 session”当凭据 |
| WEB-041 | deepseek/metadata.ts:84 | requests/answers 只增不删，超 32MB 后元数据永久不可读 | D | P2 | 按 session 保留最近 N 条回执，或超限时归档而非永久抛错 |
| WEB-013 | deepseek/owners.ts:558-562 | 只重映射 6 个顶层 id 字段，嵌套 payload 里的 native id 泄漏 | D | P2 | 递归重映射，或约定“payload 只允许顶层 id 字段”并加运行时校验 |
| WEB-015 | deepseek/owners.ts:681-688 | 每条 prompt 状态迁移全量扫 owner×session×inbox | A | P2 | 维护 promptId→owner 的内存索引，写入时更新 |
| WEB-023 | deepseek/projections.ts:133-432 | 单函数 300 行 + 20 个可变闭包状态 | A | P2 | 抽出 `AttemptState`/`EmitBuffer` 两个类 + 事件处理表；用现有 projections.test.ts 保行为 |
| WEB-024 | deepseek/projections.ts:272 | 每条 tool 消息线性 `find` → O(n²) | A | P2 | 预建 `callId → owner message` 索引 |
| WEB-008 | deepseek/routes.ts:35-50 | provider 包装对象上调用 `#private` 方法会抛 TypeError | D | P2 | 用 Proxy 转发调用（保持 this 为原实例），或要求 provider 提供显式 `identity` 访问器 |
| WEB-022 | deepseek/session.ts:471-485 | `session/follow` 每 25ms 全量重投影 + 逐条 JSON.stringify 比较 | D | P2 | 只对新增 sourceSequence 增量投影 |
| WEB-030 | deepseek/session.ts:266-267,432-459 | 端点表分散三处，新增端点需改 3 处 | A | P2 | 单表驱动（method → handler 映射表） |
| WEB-053 | deepseek/socket.test.ts:59 等 6 处 | 固定次数轮询等待副作用，慢机必挂 | D | P2 | 统一为基于 deadline 的 `awaitUntil` |
| WEB-012 | deepseek/transport.ts:101-107 | `stop()` 的 `Promise.all` 一个失败即整体失败且被永久缓存 | D | P2 | `allSettled` + 聚合错误；缓存成功结果、失败可重试 |
| WEB-044 | deepseek/workspace.ts:99-105,167 | `workspace/follow` 每 350ms 全量 listSessions + host tool 读元数据 | D | P2 | 用事件驱动（appendNew 后置脏位）替代轮询，至少把 revision 缓存住 |
| WEB-040 | metadata.ts:112-130 等 6 处 | 同一套原子写复制六份，硬化集合各不同 | A | P2 | 抽 `writePrivateJson(path, value, {maxBytes})` 到 `@ar/store-integrity` |
| WEB-001 | server.ts:284 · deepseek/host-tools.ts:18 | `??=` 缓存 rejected Promise → 永久 404 / 永久建会失败 | D | P2 | 在 catch 中清空缓存字段，或缓存已解析的值 |
| WEB-002 | server.ts:215-227 | `stop()` 前三个 await 无保护，reject 即跳过后面的清理 | D | P2 | 逐步 try/`Promise.allSettled`，最后聚合抛错 |
| WEB-006 | server.ts:34-49 | `STATIC_FILES` 硬编码 12 项，与 public 实际资源脱钩 | A | P2 | 启动时校验 public 清单，或用构建期生成的 manifest |
| WEB-007 | server.ts:601-615 | 全局单链串行化所有发送方的消息投递 | D | P2 | 按 `msg.from`（或 session）分桶串行，桶间并行 |
| WEB-052 | 15 个测试文件 | tempdir+cleanup 样板重复 15 处 | A | P3 | 抽 `tempDir(t, prefix)`（内部注册 afterEach 清理） |
| WEB-051 | 7 个测试文件 | `createRuntimeRpc` 四键字面量重复 ≥7 处 | A | P3 | 抽 `rpcFor(harness)` 到共享 `test-fixtures.ts` |
| WEB-049 | adapter.ts:23 | `nextMessageId` 死字段 | C | P3 | 删除 |
| WEB-035 | deepseek/catalog.ts:356 | 模型发现失败被吞成通用错误，无日志无原因 | A | P3 | `[degraded]` 日志 + 区分网络/状态码/解析失败 |
| WEB-036 | deepseek/catalog.ts:305-333 | 每次 `modelCatalog` 都发全 provider 网络请求 | D | P3 | 加短 TTL 缓存 |
| WEB-019 | deepseek/composition.ts:220-228 · workspace.ts:108-117 · deliverables.ts:275-276 | 祖先/后代闭包 while 扫描写三遍 | A | P3 | 抽一个 `descendants(sessions, root)` 单遍实现 |
| WEB-027 | deepseek/events.ts:196,203 | `deliveries` 只增不减，长连接内存无上限 | D | P3 | 结算并确认客户端已读后删除条目 |
| WEB-038 | deepseek/files.ts:79 · deliverables.ts:16 | 敏感文件名正则逐字重复两份 | A | P3 | 提到 `@ar/security` 或单文件常量 |
| WEB-048 | deepseek/host-tools.ts:24-53 | orchestrator 缓存只增不删 | D | P3 | 给 projectOrchestrators 设上限或按 owner 回收 |
| WEB-014 | deepseek/owners.ts:574-582 | `journalCoordinate` 重复 `ownerOf` 全扫描 | A | P3 | 复用第一次结果 |
| WEB-016 | deepseek/owners.ts:565-573 | `projectEvent` 静默丢弃未知 native id，无日志 | D | P3 | 丢弃时打 `[degraded]` 日志或断言 |
| WEB-025 | deepseek/projections.ts:326 | 每步重算 step 序号 O(steps²) | A | P3 | 维护 per-turn 计数器 |
| WEB-026 | deepseek/projections.ts:293,366,438,534 | 一致性失败抛裸 Error，无 code | D | P3 | 改 `RemoteFailure("session/history-invalid")` 并保留原因 |
| WEB-009 | deepseek/routes.ts:57-70 | 路由包装只保留 `generate`，其它可选成员丢失 | A | P3 | 显式枚举并转发所需成员 |
| WEB-054 | deepseek/session.test.ts:266 等 6 处 | 固定睡眠窗口断言“没发生” | D | P3 | 用可控时钟或显式同步点后再断言 |
| WEB-028 | deepseek/session.ts:315-330 | `toLocaleLowerCase` 变长映射使搜索偏移错位 | D | P3 | 用 `toLowerCase()` 或按 code point 建索引 |
| WEB-029 | deepseek/session.ts:122-123 | 列表页每会话重复读两遍同一 journal | A | P3 | 复用 projectUnlocked 的读取结果 |
| WEB-031 | deepseek/session.ts:125 | `Math.max(...)` 展开超大数组会 RangeError | D | P3 | 用 reduce |
| WEB-045 | deepseek/terminal.ts:37,67,110 | 终端 tombstone/外层 map 只增不减 | D | P3 | 会话关闭时整体回收；tombstone 加上限 |
| WEB-046 | deepseek/terminal.ts:42 | Windows 默认 shell 仍是 PowerShell 5.1 | A | P3 | 候选表加 `pwsh.exe` 并优先 |
| WEB-010 | deepseek/transport.ts:54-66 | `wireDecode` 递归无深度上限 | D | P3 | 加 depth 参数上限 |
| WEB-011 | deepseek/transport.ts:162 | 200 + 魔法键帧表达流式错误 | A | P3 | 导出共享常量并纳入协议测试 |
| WEB-050 | main.ts:85-90 | 失效 binding 直接终止宿主启动 | D | P3 | 无效绑定改为跳过并 `[degraded]` 日志，而不是拒绝启动 |
| WEB-003 | server.ts:653-659 | 静态资源缓存分支缺 nosniff | A | P3 | 抽统一的 `writeAssetHead()` |
| WEB-004 | server.ts:689-695 | `readJson` 的类型错误被 catch 覆盖成 "invalid JSON body" | A | P3 | 类型校验移出 try |
| WEB-005 | server.ts:566-575 | 唯一静默 catch；失败后重连会重放历史 assistant 消息 | D | P3 | 至少补 `[degraded]` 日志；无法判定时让调用方走“全量快照”而非“增量重放” |
