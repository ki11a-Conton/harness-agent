# apps/web/src 审查结果

## 0. 结论摘要

- 范围：`git ls-files apps/web/src` **59 个文件**（任务描述称“约 250 个”，实际为 59；`apps/web` 全量 862 个文件中 801 个是 `public/` 构建产物，不在本 part 范围）。
- 发现 **54 条**：A（可优化）25 · C（死代码）1 · D（潜在风险）28 · B（暂不宜动）0；按级 P1 **2** · P2 **26** · P3 **26**，无 P0。
- 最值得先修 3 条：**WEB-020**（`events.ts` pending 每 25ms 遍历所有会话全量日志）、**WEB-021**（`session/control` 每 25ms 对每个会话全量重投影）、**WEB-015**（每条 prompt 状态迁移全量扫 owner×session×inbox）——三者是同一类“轮询式全量重算”，共用一个事件驱动改造即可。
- 安全面（正向）：Host/Origin+Sec-Fetch-Site 校验、静态资源白名单与逐段 lstat 拒符号链接、boot manifest 拒链接+尺寸上限、工具入参键白名单、`redactSecrets` 脱敏、路径 realpath+inode 复核、审批/提问/准入全部 fail-closed —— 未发现 P0/P1 级安全问题。
- 结构债：入参校验 helper 4 套（WEB-033）、JSON 值校验 4 份（WEB-034）、durable JSON 写入 7 份（WEB-039/040）、祖先闭包扫描 3 份（WEB-019）、`??=` 缓存 rejected Promise 2 处（WEB-001）。
- 测试：无 `.skip`/`.only`/`as any`；问题为夹具重复（WEB-051/052）与固定时长等待（WEB-053/054）。本轮未执行测试，见 §4。

## 1. 发现总表

按级别降序。路径相对于 `apps/web/src/`；完整描述与改法见 §2 对应行。

| ID | 文件:行 | 问题描述（速览） | 类 | 级 |
| --- | --- | --- | --- | --- |
| WEB-020 | deepseek/events.ts:53-77 | 每个 `$events` 流每 ~25ms 遍历所有会话 + 全量日志求 pending | D | P1 |
| WEB-021 | deepseek/session.ts:443-455 | `session/control` 每 25ms 对每个会话全量重投影（含 host tool 读文件） | D | P1 |
| WEB-001 | server.ts:284 · deepseek/host-tools.ts:18 | `??=` 缓存 rejected Promise → 永久 404 / 永久建会失败 | D | P2 |
| WEB-002 | server.ts:215-227 | `stop()` 前三个 await 无保护，reject 即跳过后面的清理 | D | P2 |
| WEB-006 | server.ts:34-49 | `STATIC_FILES` 硬编码 12 项，与 public 实际资源脱钩 | A | P2 |
| WEB-007 | server.ts:601-615 | 全局单链串行化所有发送方的消息投递 | D | P2 |
| WEB-008 | deepseek/routes.ts:35-50 | provider 包装对象上调用 `#private` 方法会抛 TypeError | D | P2 |
| WEB-012 | deepseek/transport.ts:101-107 | `stop()` 的 `Promise.all` 一个失败即整体失败且被永久缓存 | D | P2 |
| WEB-013 | deepseek/owners.ts:558-562 | 只重映射 6 个顶层 id 字段，嵌套 payload 里的 native id 泄漏 | D | P2 |
| WEB-015 | deepseek/owners.ts:681-688 | 每条 prompt 状态迁移全量扫 owner×session×inbox | A | P2 |
| WEB-017 | deepseek/composition.ts:204 | 第二次读取 boot-manifest，无 symlink/尺寸/schema 校验 | A | P2 |
| WEB-018 | deepseek/composition.ts:35-271 | 单函数 236 行装配全部服务并猴补事件总线 | A | P2 |
| WEB-022 | deepseek/session.ts:471-485 | `session/follow` 每 25ms 全量重投影 + 逐条 JSON.stringify 比较 | D | P2 |
| WEB-023 | deepseek/projections.ts:133-432 | 单函数 300 行 + 20 个可变闭包状态 | A | P2 |
| WEB-024 | deepseek/projections.ts:272 | 每条 tool 消息线性 `find` → O(n²) | A | P2 |
| WEB-030 | deepseek/session.ts:266-267,432-459 | 端点表分散三处，新增端点需改 3 处 | A | P2 |
| WEB-032 | deepseek/activity.ts:181-249 | 每 tick 全量 read + 每 task 单独 mutate 同一文件 | A | P2 |
| WEB-033 | deepseek/catalog.ts:55-71 · files.ts:21-37 · coding-status.ts:5-6 · events.ts:53-77 | 入参校验 helper 四套并存，错误码不一致 | A | P2 |
| WEB-034 | deepseek/{activity.ts:517,events.ts:285,catalog.ts:65,projections.ts:597} | JSON 值校验手写四遍，深度上限 20/30/无/无 | A | P2 |
| WEB-037 | deepseek/files.ts:204-209 | 两套 ToolResult 解包，取消被报成 `gateway/internal` | A | P2 |
| WEB-039 | bindings.ts:41-50 | 最弱的一份 durable 写：固定 .tmp、跟随符号链接、无校验 | D | P2 |
| WEB-040 | metadata.ts:112-130 等 6 处 | 同一套原子写复制六份，硬化集合各不同 | A | P2 |
| WEB-041 | deepseek/metadata.ts:84 | requests/answers 只增不删，超 32MB 后元数据永久不可读 | D | P2 |
| WEB-042 | deepseek/deliverables.ts:210-250 | 每 turn 两次全工作区遍历+全量 sha256 | D | P2 |
| WEB-043 | deepseek/deliverables.ts:239-243 | `summaries` 只增不减，常驻完整 hunks | D | P2 |
| WEB-044 | deepseek/workspace.ts:99-105,167 | `workspace/follow` 每 350ms 全量 listSessions + host tool 读元数据 | D | P2 |
| WEB-047 | deepseek/host-tools.ts:101-110 | 无 session 参数即可对任意绝对路径列举/建目录 | D | P2 |
| WEB-053 | deepseek/socket.test.ts:59 等 6 处 | 固定次数轮询等待副作用，慢机必挂 | D | P2 |
| WEB-003 | server.ts:653-659 | 静态资源缓存分支缺 nosniff | A | P3 |
| WEB-004 | server.ts:689-695 | `readJson` 的类型错误被 catch 覆盖成 "invalid JSON body" | A | P3 |
| WEB-005 | server.ts:566-575 | 唯一静默 catch；失败后重连会重放历史 assistant 消息 | D | P3 |
| WEB-009 | deepseek/routes.ts:57-70 | 路由包装只保留 `generate`，其它可选成员丢失 | A | P3 |
| WEB-010 | deepseek/transport.ts:54-66 | `wireDecode` 递归无深度上限 | D | P3 |
| WEB-011 | deepseek/transport.ts:162 | 200 + 魔法键帧表达流式错误 | A | P3 |
| WEB-014 | deepseek/owners.ts:574-582 | `journalCoordinate` 重复 `ownerOf` 全扫描 | A | P3 |
| WEB-016 | deepseek/owners.ts:565-573 | `projectEvent` 静默丢弃未知 native id，无日志 | D | P3 |
| WEB-019 | deepseek/composition.ts:220-228 · workspace.ts:108-117 · deliverables.ts:275-276 | 祖先/后代闭包 while 扫描写三遍 | A | P3 |
| WEB-025 | deepseek/projections.ts:326 | 每步重算 step 序号 O(steps²) | A | P3 |
| WEB-026 | deepseek/projections.ts:293,366,438,534 | 一致性失败抛裸 Error，无 code | D | P3 |
| WEB-027 | deepseek/events.ts:196,203 | `deliveries` 只增不减，长连接内存无上限 | D | P3 |
| WEB-028 | deepseek/session.ts:315-330 | `toLocaleLowerCase` 变长映射使搜索偏移错位 | D | P3 |
| WEB-029 | deepseek/session.ts:122-123 | 列表页每会话重复读两遍同一 journal | A | P3 |
| WEB-031 | deepseek/session.ts:125 | `Math.max(...)` 展开超大数组会 RangeError | D | P3 |
| WEB-035 | deepseek/catalog.ts:356 | 模型发现失败被吞成通用错误，无日志无原因 | A | P3 |
| WEB-036 | deepseek/catalog.ts:305-333 | 每次 `modelCatalog` 都发全 provider 网络请求 | D | P3 |
| WEB-038 | deepseek/files.ts:79 · deliverables.ts:16 | 敏感文件名正则逐字重复两份 | A | P3 |
| WEB-045 | deepseek/terminal.ts:37,67,110 | 终端 tombstone/外层 map 只增不减 | D | P3 |
| WEB-046 | deepseek/terminal.ts:42 | Windows 默认 shell 仍是 PowerShell 5.1 | A | P3 |
| WEB-048 | deepseek/host-tools.ts:24-53 | orchestrator 缓存只增不删 | D | P3 |
| WEB-049 | adapter.ts:23 | `nextMessageId` 死字段 | C | P3 |
| WEB-050 | main.ts:85-90 | 失效 binding 直接终止宿主启动 | D | P3 |
| WEB-051 | 7 个测试文件 | `createRuntimeRpc` 四键字面量重复 ≥7 处 | A | P3 |
| WEB-052 | 15 个测试文件 | tempdir+cleanup 样板重复 15 处 | A | P3 |
| WEB-054 | deepseek/session.test.ts:266 等 6 处 | 固定睡眠窗口断言“没发生” | D | P3 |

## 2. 分模块明细

### 2.1 HTTP 宿主与传输（`server.ts`、`deepseek/routes.ts`、`deepseek/transport.ts`）

Web 宿主：手写 HTTP 服务 + SSE/WS 插件通道 + `/api/deepseek/transport` 的 RPC 载波。整体鉴权（Host/Origin 校验、路径白名单、符号链接拒绝）做得比同类项目扎实，问题集中在错误处理一致性与关停顺序。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-001 | apps/web/src/server.ts:284 · apps/web/src/deepseek/host-tools.ts:18 | `x ??= load()` 缓存的是 Promise；一旦该 Promise 被拒绝，后续所有调用拿到同一个 rejected promise：插件清单永久 404，主机会话创建永久失败，直到进程重启 | D | P2 | 在 catch 中清空缓存字段，或缓存已解析的值 |
| WEB-002 | apps/web/src/server.ts:215-227 | `stop()` 前三个 await（socketBindings.close / socketServer.close / deepseek.stop）无任何保护，任一 reject 就直接跳出，后面的 SSE 连接清理与 `server.close()` 全部跳过 | D | P2 | 逐步 try/`Promise.allSettled`，最后聚合抛错 |
| WEB-003 | apps/web/src/server.ts:653-659 | 静态资源“命中缓存”分支只写 Content-Type/Cache-Control，缺 `X-Content-Type-Options: nosniff`；首次读盘分支（L672-675）同样缺，而 L149/L373 有 | A | P3 | 抽统一的 `writeAssetHead()` |
| WEB-004 | apps/web/src/server.ts:689-695 | `readJson` 在 try 内抛 `HttpError(400,"expected a JSON object")`，被自己的 catch 吞掉统一改成 `"invalid JSON body"`，错误信息与真实原因不符 | A | P3 | 类型校验移出 try |
| WEB-005 | apps/web/src/server.ts:566-575 | `initialAssistantCount` 的 catch 静默返回 0（全文件唯一不带 `[degraded]` 日志的 catch）；一旦计数失败，重连时会把历史 assistant 消息当作新消息重放给浏览器 | D | P3 | 至少补 `[degraded]` 日志；无法判定时让调用方走“全量快照”而非“增量重放” |
| WEB-006 | apps/web/src/server.ts:34-49 | `STATIC_FILES` 硬编码 12 项白名单，与 `apps/web/public/deepseek/**` 实际资源脱钩：public 下新增文件不会自动可服务，改名则会静默 404 | A | P2 | 启动时校验 public 清单，或用构建期生成的 manifest |
| WEB-007 | apps/web/src/server.ts:601-615 | `deliver` 用全实例唯一的 `pendingDeliveries` 尾链串行化**所有**发送方的消息投递，一个慢的 `adapter.deliver` 会阻塞其他标签页/发送方 | D | P2 | 按 `msg.from`（或 session）分桶串行，桶间并行 |
| WEB-008 | apps/web/src/deepseek/routes.ts:35-50 | `identityNeutralProvider` 用 `Reflect.ownKeys` 复制实例自有属性并 rebind 方法；若某 provider 的方法读取 `#private` 字段，在包装对象上调用即抛 TypeError | D | P2 | 用 Proxy 转发调用（保持 this 为原实例），或要求 provider 提供显式 `identity` 访问器 |
| WEB-009 | apps/web/src/deepseek/routes.ts:57-70 | `routeAwareProvider` 只把 `generate` 包进 clamped 客户端，provider 的其它可选成员在路由包装后丢失 | A | P3 | 显式枚举并转发所需成员 |
| WEB-010 | apps/web/src/deepseek/transport.ts:54-66 | `wireDecode` 递归无深度上限；1MB 上限内构造极深数组会栈溢出（被 catch 成 400，但错误码/原因不准） | D | P3 | 加 depth 参数上限 |
| WEB-011 | apps/web/src/deepseek/transport.ts:162 | 流式路径的错误用 HTTP 200 + `{"__deepseek_transport_error__": …}` 帧表达，魔法字符串是隐式协议，客户端漏判即静默失败 | A | P3 | 导出共享常量并纳入协议测试 |
| WEB-012 | apps/web/src/deepseek/transport.ts:101-107 | `stop()` 把结果 Promise 缓存起来，但内部 `Promise.all` 遇到一个 rejection 即整体失败，可能只关了一半服务，且后续 stop 调用永远得到同一个 rejected promise | D | P2 | `allSettled` + 聚合错误；缓存成功结果、失败可重试 |

### 2.2 owner / 别名 / 投影边界（`deepseek/owners.ts`、`deepseek/composition.ts`）

这一层是本次改动的核心：一个对外 session id（外部/别名）映射到多代 native id + 事件偏移。前缀稠密性不变式（`assertDraft`、启动时 `retired.eventCount` 校验）与别名写入的 O_NOFOLLOW/原子替换做得比较严谨，问题在外层索引与重映射完整性。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-013 | apps/web/src/deepseek/owners.ts:558-562 | `eventPayload` 只重映射 `["sessionId","parentId","parentSessionId","childSessionId","sourceSessionId","targetSessionId"]` 六个顶层 key；payload 内嵌对象（如 `payload.pending`、`payload.selection`、审批 details）里的 native id 不会翻译成外部 id，前端拿到内部 id | D | P2 | 递归重映射，或约定“payload 只允许顶层 id 字段”并加运行时校验 |
| WEB-014 | apps/web/src/deepseek/owners.ts:574-582 | `journalCoordinate` 对同一个 id 连续两次 `await ownerOf(id)`，重复一次全 owner 扫描 | A | P3 | 复用第一次结果 |
| WEB-015 | apps/web/src/deepseek/owners.ts:681-688 | `promptOwner` 在 `markPromoted`/`bindPromotion`/`markConsumed` 热路径上遍历 所有 owner × 所有 session × inbox，每条 prompt 的每次状态迁移都是全量扫描 | A | P2 | 维护 promptId→owner 的内存索引，写入时更新 |
| WEB-016 | apps/web/src/deepseek/owners.ts:565-573 | `projectEvent` 遇到既不等于当前 native、也不在 retired 列表里的 id 时静默返回 `undefined`，事件被丢弃且无日志 | D | P3 | 丢弃时打 `[degraded]` 日志或断言 |
| WEB-017 | apps/web/src/deepseek/composition.ts:204 | 装配层自己又读了一遍 `public/deepseek/boot-manifest.json`（`readFile(fileURLToPath(...))`），与 `server.ts:287 loadBootGraph` 重复，且没有 symlink/尺寸/schema 校验 | A | P2 | 复用 server 的 `loadBootGraph` 或抽公共 loader，统一校验 |
| WEB-018 | apps/web/src/deepseek/composition.ts:35-271 | `createDeepseekComposition` 单函数约 236 行，顺序装配 catalog/owners/workspace/files/terminal/sessions/deliverables/activity/HTTP，还就地改 `harness.events.appendNew` | A | P2 | 拆为 `configureOwners` / `configureActivity` / `configureHttp` 三段，装配层只做顺序编排 |
| WEB-019 | apps/web/src/deepseek/composition.ts:220-228 · apps/web/src/deepseek/workspace.ts:108-117 · apps/web/src/deepseek/deliverables.ts:275-276 | 同一段“while(changed) 反复全量扫 sessions 求祖先/后代闭包”写了三遍，最坏 O(n²)，分别在 session activity、workspace 活动检查、会话导出路径上执行 | A | P3 | 抽一个 `descendants(sessions, root)` 单遍实现 |

### 2.3 RPC、事件流与投影（`deepseek/session.ts`、`events.ts`、`projections.ts`、`activity.ts`、`catalog.ts`）

端点面的实现质量参差：入参校验（`keys`/`object`/`string`）非常严格且统一，fail-closed 路径（审批、提问、准入）都有双重校验；但**读路径是 25ms 轮询全量重投影**，这是本包最需要优先处理的问题。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-020 | apps/web/src/deepseek/events.ts:53-77 | `pending()` 在每个 `$events` 流上大约每 25ms 执行一次（L193 循环内），每次遍历所有 session 并 `events.list()` 全量日志，再对每个 ask id 二次读取；会话数与日志长度线性甚至平方增长 | D | P1 | 改为事件驱动（appendNew 后置脏标记）+ 维护 pending 索引 |
| WEB-021 | apps/web/src/deepseek/session.ts:443-455 | `session/control` 每个 25ms tick 对**每个** session 调 `projectSnapshot`，而 `projectUnlocked` 内含 `meta()`（走 host tool 读文件）+ 全量 events/messages 投影 | D | P1 | 同样的事件驱动增量；至少把 baseline 缓存并在无新事件时跳过 |
| WEB-022 | apps/web/src/deepseek/session.ts:471-485 | `session/follow` 每 25ms 全量重投影并对每条记录 `JSON.stringify` 比较以检测前缀冲突，O(记录数) 每次 tick | D | P2 | 只对新增 sourceSequence 增量投影 |
| WEB-023 | apps/web/src/deepseek/projections.ts:133-432 | `projectSessionHistory` 单函数约 300 行、20+ 个可变闭包状态（active/currentTurn/step/records/...），全文件 605 行；改一处易破坏前缀稳定不变式 | A | P2 | 抽出 `AttemptState`/`EmitBuffer` 两个类 + 事件处理表；用现有 projections.test.ts 保行为 |
| WEB-024 | apps/web/src/deepseek/projections.ts:272 | `publishMessage` 里对每条 tool 消息 `messages.find(...)` 线性扫描，长会话下 O(消息数²) | A | P2 | 预建 `callId → owner message` 索引 |
| WEB-025 | apps/web/src/deepseek/projections.ts:326 | `model.started` 每次用 `[...stepNumbers.keys()].filter(startsWith)` 重算 step 序号，O(steps²) | A | P3 | 维护 per-turn 计数器 |
| WEB-026 | apps/web/src/deepseek/projections.ts:293,366,438,534 | 投影一致性校验失败抛裸 `Error`（无 code），读路径上一颗坏事件就让整个会话不可读且只能落到 gateway/internal | D | P3 | 改 `RemoteFailure("session/history-invalid")` 并保留原因 |
| WEB-027 | apps/web/src/deepseek/events.ts:196,203 | `deliveries` 只增不减：审批/提问消失时只删 `seen`，`generation.deliveries` 里的条目要等连接关闭才清空，长连接内存无上限 | D | P3 | 结算并确认客户端已读后删除条目 |
| WEB-028 | apps/web/src/deepseek/session.ts:315-330 | `session/search` 用 `toLocaleLowerCase()` 同时做匹配和偏移计算；locale 变长映射（如 `İ`→`i̇`）会让偏移错位，snippet 截取串位 | D | P3 | 用 `toLowerCase()` 或按 code point 建索引 |
| WEB-029 | apps/web/src/deepseek/session.ts:122-123 | `summaryUnlocked` 在 `projectUnlocked`（已读 events/messages）之后又 `listTurns` + `events.list` 一遍同一 journal，列表页 N 个会话即 N 次重复全量读 | A | P3 | 复用 projectUnlocked 的读取结果 |
| WEB-030 | apps/web/src/deepseek/session.ts:266-267,432-459 | 端点表分散三处：unary `endpoints` 数组、`stream()` 分支、`events.endpoints`；新增端点要改 3 个地方，漏改表现为 gateway/not-found | A | P2 | 单表驱动（method → handler 映射表） |
| WEB-031 | apps/web/src/deepseek/session.ts:125 | `Math.max(current.updatedAt, ...turns.map(...))` 展开数组，turns 极多时（>~6 万）触发 RangeError | D | P3 | 用 reduce |
| WEB-032 | apps/web/src/deepseek/activity.ts:181-249 | `drive()` 每 tick 全量 `read()` 文档，再对每个到期 task 单独 `mutate()`（同一文件重复读写并串行 IO） | A | P2 | 收集到期 task 一次性 mutate |
| WEB-033 | apps/web/src/deepseek/catalog.ts:55-71 · apps/web/src/deepseek/files.ts:21-37 · apps/web/src/deepseek/coding-status.ts:5-6 · apps/web/src/deepseek/events.ts:53-77 | 入参/结构校验 helper 有四套并行实现：`bad/object/keys/text/json`（catalog）、`record/exact/text/integer`（files，被 workspace/terminal/deliverables 复用）、`record/text`（coding-status）、`fail/object/keys/string`（events）；命名、错误码（`gateway/bad-request` vs `RemoteFailure`）与长度上限各不相同 | A | P2 | 合并为一个 `wire-validation.ts`，全包统一错误码 |
| WEB-034 | apps/web/src/deepseek/{activity.ts:517,events.ts:285,catalog.ts:65,projections.ts:597} | “JSON 值校验”被手写四遍（`validateJson`/`assertJson`/`json`/`assertJsonValue`），深度上限 20/30/无/无 各不同 | A | P2 | 合并到 `@ar/contracts` 的单一 `assertJsonValue(value,{maxDepth})` |
| WEB-035 | apps/web/src/deepseek/catalog.ts:356 | 模型发现 `fetch` 的所有失败被 catch 成通用 `MODEL_ERROR`，无日志无原因，排障只能靠猜 | A | P3 | `[degraded]` 日志 + 区分网络/状态码/解析失败 |
| WEB-036 | apps/web/src/deepseek/catalog.ts:305-333 | `modelCatalog` 每次调用都对所有 provider 发起 `listModels()` 网络请求（session/modelCatalog、session/selectModel 都会触发） | D | P3 | 加短 TTL 缓存 |


### 2.4 测试（27 个 `*.test.ts`）

正面证据：全量 grep 无 `.skip(`/`.only(`/`todo(`/`toMatchSnapshot`，也无 `as any` 逃逸；安全类回归测试（owners.security / activity-store.security / composition-security.regressions）都在真实临时目录上构造 lstat/硬链接/竞态攻击面，质量高于平均。问题集中在**夹具复制粘贴**与**固定时长轮询**。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-051 | `source-audit-restoration.regressions.test.ts:19` · `harness.integration.test.ts:50` · `server.test.ts:179` · `deepseek/activity.test.ts:45` · `deepseek/backend.final.integration.test.ts:19` · `deepseek/session-availability.test.ts:16` · `deepseek/session.test.ts:22` | `createRuntimeRpc(harness.runtime, { sessionService, sessions, events, approvalStore })` 四键字面量在 ≥7 个测试文件里逐字重复；新增/改名一个 RPC 服务要改 7 处，漏改表现为测试静默丢功能 | A | P3 | 抽 `rpcFor(harness)` 到共享 `test-fixtures.ts` |
| WEB-052 | `deepseek/activity.test.ts:35` · `deepseek/activity-store.security.test.ts:25,35,42` · `deepseek/catalog.test.ts:18` · `deepseek/owners.test.ts:22` · `deepseek/owners.security.test.ts:30` · `deepseek/composition.integration.test.ts:48` · `deepseek/session.test.ts:17` · `deepseek/session-model-snapshot.test.ts:17` 等 15 处 | `realpath(await mkdtemp(join(tmpdir(),"前缀-")))` + `cleanup.push(() => rm(...,{recursive:true}))` 样板重复 15 次，只有前缀不同 | A | P3 | 抽 `tempDir(t, prefix)`（内部注册 afterEach 清理） |
| WEB-053 | `deepseek/socket.test.ts:59,101,131` · `deepseek/owners.test.ts:416` · `deepseek/workspace.integration.test.ts:189` · `deepseek/session.test.ts:43` | 等待副作用用固定次数轮询（`for(i<50) sleep(2)`≈最多 100ms；`owners.test.ts:416` 300×5ms=1.5s），慢机上直接失败；同仓库已有 deadline 式 `awaitUntil` 写法（session.test.ts:43、activity.test.ts:77），未统一 | D | P2 | 统一为基于 deadline 的 `awaitUntil` |
| WEB-054 | `deepseek/session.test.ts:266,335,555` · `deepseek/activity.test.ts:471` · `deepseek/owners.test.ts:462,484` | “断言没有发生”用固定睡眠窗口（`sleep(20)`/`sleep(100)` 后 `expect(...).toBe(false)`）：只证明窗口内未发生，实现延后即假通过，慢机上还可能假失败 | D | P3 | 用可控时钟或显式同步点后再断言 |

### 2.5 工作区文件、主机工具与持久化（`deepseek/files.ts`、`deliverables.ts`、`workspace.ts`、`terminal.ts`、`host-tools.ts`、`metadata.ts`、`activity-store.ts`、根目录 `bindings.ts`/`adapter.ts`/`main.ts`）

副作用全部经 ToolOrchestrator + PermissionEngine + SandboxManager，路径围栏用 realpath + inode 复核（files.ts:141、deliverables.ts:101），这是本包最可靠的部分。问题集中在**七份手写持久化实现各自演化**与**轮询式全量重算**。

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| WEB-037 | apps/web/src/deepseek/files.ts:204-209（对照 44-46） | 同一“解包 ToolResult”逻辑写了两遍且映射不一致：`toolValue` 把 `cancelled` 映射为 `gateway/cancelled`，`readTool` 落到 `gateway/internal`；用户主动取消的预览/列举会报内部错误 | A | P2 | 只保留 `toolValue`，`readTool` 改为委托 |
| WEB-038 | apps/web/src/deepseek/files.ts:79 · apps/web/src/deepseek/deliverables.ts:16 | 敏感文件名正则逐字重复两次（`.env`/`id_rsa`/`credentials`/`*.pem|key|p12|pfx`），任一处改动即产生绕过窗口 | A | P3 | 提到 `@ar/security` 或单文件常量 |
| WEB-039 | apps/web/src/bindings.ts:41-50 | 七份手写 durable JSON 写入里最弱的一份：临时文件名固定 `${path}.tmp`、`openSync(...,"w")` 跟随已存在符号链接（0o600 只对新文件生效）、无 lstat/realpath/nlink 校验、无目录 fsync、先落盘后提交内存。其余六份见 WEB-040 | D | P2 | 直接用 `@ar/store-integrity` 的原子写（与 metadata.ts:112-130 同款） |
| WEB-040 | `metadata.ts:112-130` · `activity-store.ts:82-97` · `workspace.ts:48-59` · `owners.ts:196-209` · `catalog.ts:519-534` · `deliverables.ts:150-157` | 同一套“临时文件 + fsync + atomicReplace + 目录 fsync + unlink 兜底”复制六份，各自的 symlink/O_NOFOLLOW/大小上限校验集合还不一致（bindings.ts 一份都没有） | A | P2 | 抽 `writePrivateJson(path, value, {maxBytes})` 到 `@ar/store-integrity` |
| WEB-041 | apps/web/src/deepseek/metadata.ts:84 | `requests`/`answers` 两张表只增不删（全仓 grep 无删除点），文档上限 32MB；一旦越过上限，`load()` 每次抛 `"Session metadata is not a bounded regular file"`，标题与准入回执从此全部读写失败，且无自愈路径 | D | P2 | 按 session 保留最近 N 条回执，或超限时归档而非永久抛错 |
| WEB-042 | apps/web/src/deepseek/deliverables.ts:210-250 | 每个 `turn.started` 与 `turn.completed` 各做一次**全工作区遍历**（≤2000 文件 / ≤32MB 全量读取 + 逐个 sha256），长仓库下一轮对话要付两次全树 IO | D | P2 | 复用文件监视/变更缓存，只对 mtime 变化的子树重新 hash |
| WEB-043 | apps/web/src/deepseek/deliverables.ts:239-243 | `summaries` 只增不减（`dispose` 才清），每个有变更的 turn 常驻完整 hunks；长会话内存随 turn 数线性增长 | D | P2 | 以 LRU（如最近 50 个 turn）淘汰，或落盘并在读取时回查事件 |
| WEB-044 | apps/web/src/deepseek/workspace.ts:99-105,167 | `workspace/follow` 每 350ms 调 `reconcile()`：`listSessions()` 全量 + `metadata.read()` 走一次 host tool（ToolOrchestrator + 整文件读取 + zod 全量解析），会话/工作区多时每秒数次全量扫描 | D | P2 | 用事件驱动（appendNew 后置脏位）替代轮询，至少把 revision 缓存住 |
| WEB-045 | apps/web/src/deepseek/terminal.ts:37,67,110 | `closed` tombstone 表按 session 累积已关闭终端 id 且从不清除，`terminals` 外层 map 也只增不减 | D | P3 | 会话关闭时整体回收；tombstone 加上限 |
| WEB-046 | apps/web/src/deepseek/terminal.ts:42 | Windows 下默认 shell 候选表首选 `System32\WindowsPowerShell\v1.0\powershell.exe`（5.1），不使用 `pwsh.exe`；若产品要求 7.x，用户默认拿到的仍是 legacy 解释器 | A | P3 | 候选表加 `pwsh.exe` 并优先 |
| WEB-047 | apps/web/src/deepseek/host-tools.ts:101-110 | 主机会话（`sessionId === undefined`）分支给 `web_workspace_read`/`web_workspace_mkdir` 授予**任意绝对路径**的目录列举与建目录权限（`allowedPaths:[resolve(args.path)]`），授权判据只有“调用方没传 sessionId” | D | P2 | 由用户手势签发一次性 capability（路径 + 有效期），而不是以“无 session”当凭据 |
| WEB-048 | apps/web/src/deepseek/host-tools.ts:24-53 | `hostOrchestrators`(WeakMap) 与 `projectOrchestrators`(Map，键为 `root\0agentId`) 只增不删，工作区切换越多缓存越大 | D | P3 | 给 projectOrchestrators 设上限或按 owner 回收 |
| WEB-049 | apps/web/src/adapter.ts:23 | `private nextMessageId = 1` 声明后从未使用（全仓 grep 仅此一处声明） | C | P3 | 删除 |
| WEB-050 | apps/web/src/main.ts:85-90 | 启动时校验 bindings 文件里的每个 sessionId 都存在，任一缺失直接 `throw` 终止整个 Web 宿主；当前仓库无会话删除路径（`packages` 下无 deleteSession/removeSession），一旦引入删除或手工清理，旧标签页即可让宿主永久起不来 | D | P3 | 无效绑定改为跳过并 `[degraded]` 日志，而不是拒绝启动 |


## 3. 覆盖清单

清单来源：`git ls-files apps/web/src` = **59** 个文件（`apps/web` 全量 862，其中 `apps/web/public` 801 个为构建产物、`package.json`/`tsconfig.json` 各 1，均不在本 part 范围）。逐文件结论如下，行数按 read 工具口径。

### 3.1 `apps/web/src`（根，10 个）

- `adapter.ts`（65）— WEB-049
- `bindings.ts`（80）— WEB-039
- `index.ts`（6）— 无问题（纯 re-export 门面）
- `main.ts`（165）— WEB-050
- `server.ts`（703）— WEB-001 ~ WEB-007
- `server.test.ts`（635）— WEB-051、WEB-052
- `harness.integration.test.ts`（329）— WEB-051
- `coding-evolution-cache.integration.test.ts`（47）— 无问题
- `source-audit-restoration.regressions.test.ts`（32）— WEB-051
- `gen1-session-sidebar.test.ts`（30）— 未逐行；替代手段：grep 口径（`.skip`/`.only`/`as any`/计时依赖/夹具构造）无命中

### 3.2 `apps/web/src/deepseek`（源，21 个）

- `session.ts`（539）— WEB-021、WEB-022、WEB-028、WEB-029、WEB-030、WEB-031
- `events.ts`（311）— WEB-020、WEB-027、WEB-033
- `projections.ts`（597）— WEB-023、WEB-024、WEB-025、WEB-026、WEB-034
- `owners.ts`（795）— WEB-013 ~ WEB-016、WEB-040
- `composition.ts`（271）— WEB-017、WEB-018、WEB-019
- `activity.ts`（513）— WEB-032、WEB-034
- `catalog.ts`（527）— WEB-033 ~ WEB-036、WEB-040
- `transport.ts`（178）— WEB-010、WEB-011、WEB-012
- `routes.ts`（80）— WEB-008、WEB-009
- `files.ts`（256）— WEB-033、WEB-037、WEB-038
- `deliverables.ts`（326）— WEB-038、WEB-040、WEB-042、WEB-043、WEB-019
- `workspace.ts`（173）— WEB-040、WEB-044、WEB-019
- `terminal.ts`（175）— WEB-045、WEB-046
- `host-tools.ts`（127）— WEB-001、WEB-047、WEB-048
- `metadata.ts`（125）— WEB-040、WEB-041
- `activity-store.ts`（98）— WEB-040
- `socket.ts`（139）— 无问题（帧校验、256 背压、30s 心跳、关停序列均严）
- `coding-status.ts`（62）— WEB-033
- `activity-projections.ts`（56）— WEB-033（第 5 份 `record` helper）
- `change-compare.ts`（39）— 无问题（上游逐字适配，provenance 注释齐全）
- `browser-usage.ts`（22）— 无问题（纯函数，注释说明 inputTokens/totalTokens 语义）

### 3.3 `apps/web/src/deepseek`（测试，22 个）

- `session.test.ts`（534）— WEB-051 ~ WEB-054
- `owners.test.ts`（466）— WEB-052、WEB-053、WEB-054
- `activity.test.ts`（452）— WEB-051、WEB-052、WEB-054
- `projections.test.ts`（332）— 无问题（grep 口径无命中；覆盖投影前缀稳定性）
- `catalog.test.ts`（293）— WEB-052、WEB-054
- `composition.integration.test.ts`（271）— WEB-052
- `workspace.integration.test.ts`（263）— WEB-053、WEB-054
- `socket.test.ts`（136）— WEB-053
- `transport.test.ts`（127）— 无问题（grep 口径无命中）
- `composition-security.regressions.test.ts`（120）— 无问题（真实临时目录构造沙箱逃逸用例）
- `platform-http.test.ts`（119）— 无问题（用真实 EventSource 校验 boot graph）
- `session-running-status.regressions.test.ts`（94）— WEB-052
- `socket.web-server.test.ts`（71）— 未逐行；grep 口径无命中
- `session-model-snapshot.test.ts`（69）— WEB-052
- `session.production.test.ts`（61）— 无问题
- `session-availability.test.ts`（48）— WEB-051
- `owners.security.test.ts`（46）— WEB-052
- `activity-store.security.test.ts`（41）— WEB-052
- `backend.final.integration.test.ts`（36）— WEB-051
- `coding-status.integration.test.ts`（35）— 无问题
- `browser-usage.regressions.test.ts`（31）— 无问题（`toBeDefined` 后紧跟具体数值断言）
- `change-compare.regressions.test.ts`（11）— 未逐行（11 行，grep 口径无命中）

### 3.4 `apps/web/src/deepseek/schedule-pure`（6 个）

- `domain.ts`（1795）— 未逐行；替代手段：`PROVENANCE.md` 源 SHA-256 + 上游 MIT 副本（METHOD §5 属被引用端，不建议在本仓重构）
- `types.ts`（395）— 同上
- `update.ts`（173）— 同上
- `session-shim.ts`（7）— 无问题（结构垫片，含安全整数校验）
- `PROVENANCE.md`（27）— 无问题
- `LICENSE`（17）— 无问题

合计 10 + 21 + 22 + 6 = **59**，与 `git ls-files` 一致。逐行通读 53 个；未逐行 6 个（3 个 vendored 上游大文件 + 3 个 ≤71 行测试，均在本表注明替代手段与原因）。

## 4. 存疑/需人工确认

1. **WEB-020 / WEB-021 的 P1 判定缺少实测数字**。事实是代码结构（每 25ms 全量遍历；`session/control` 对每个会话调 `projectSnapshot`），推测是“会话数 × 日志长度”放大。若产品实际负载只有 1–2 个活跃会话，可降为 P2；建议 Lead 用 20+ 会话、2000+ 事件的 fixture 做一次 profiler 再定级。
2. **WEB-008（provider 包装丢 `#private`）的触发面未验证**：当前仓库唯一的 provider 实现是 `openai-completions`（`composition.ts:69` 只接受该 api），其方法是否用 `#private` 字段需读 `packages/providers` 确认。若都用品类字段则风险降为理论级。
3. **WEB-047（host 会话特权）依赖产品语义**：`workspace/pickDirectory` 等交互在 UI 上确实是用户手势，但“调用方不传 sessionId”≠“用户已同意”。需产品侧确认该分支只由 picker 流程调用；否则应换成显式 capability。
4. **本轮未执行测试与类型检查**（只读审查 + 上下文预算）：`pnpm vitest run apps/web/src`、`pnpm typecheck` 的建议留给 Lead 执行。测试相关发现（WEB-051 ~ WEB-054）来自 grep 全量扫描 + 部分文件通读，非逐行审阅全部 27 个测试文件。
5. **`selectModel` 的 `setSessionModel` 分支（`owners.ts:474-480`，draft prefix 不可得时）** 会改 runtime 的 session model 但不更新冻结指纹，`checkSessionConfigDrift` 是否会把这次合法切换报成 drift，需 harness 侧确认语义（未在本次范围读到 drift 实现）。
6. **schedule-pure 三个上游大文件**（1795/395/173 行）未逐行：按 provenance 属 vendored 代码，缺陷应回上游修；若 Lead 要求覆盖，可另派一轮。
7. **`apps/web/public`（801 个构建产物）未纳入**：本次只审 `src`；`STATIC_FILES` 白名单与 public 实际产物的对应关系（WEB-006）只做了清单级比对，未逐个校验内容哈希。
