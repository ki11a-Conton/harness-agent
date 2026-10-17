# 运行时底座包（core / harness / tools / contracts / security / store / store-integrity / events / session / checkpoint）审查结果

结论基于 `D:\Download games\harness agent` @ `44f3f51f`。只读审查，未修改任何被跟踪文件。
证据全部来自 `git ls-files`、grep 命中、文件通读与 `rg` 计数；推测与事实在文中分别标注。

## 0. 结论摘要

- 覆盖 418 个跟踪文件（197 个非测试文件 + 221 个测试/夹具文件），其中 7 个关键生产文件全文通读（`runtime.ts` 2062 行、`orchestrator.ts` 752、`executor.ts` 686、`sqlite-runtime-store.ts` 675、`store-integrity/index.ts` 266、`sandbox.ts` 242、`compose-stores.ts` 116），其余按导出面 + 定点 grep 检查（见 §3 每文件标注）。
- 共 29 条发现：**P1×3、P2×25、P3×1**；按类 **D×19、A×7、C×3**。
- 架构契约**基本成立**：`packages/core` 不 import 任何 UI/provider/业务插件包，生产代码无 `node:child_process`；ToolOrchestrator 的 PermissionEngine/SandboxManager 是必经步骤且 fail-closed（无 approval resolver 也拒）。**但有 3 条绕行/漏检路径**（PKG-001/002/003）与 1 条契约违例（PKG-007）。
- 首修建议：PKG-001（漂移门禁首个 load 前无基线）、PKG-002（持久化栅栏被哨兵值短路）、PKG-003（工具语义哈希是函数形参个数的伪指纹）、PKG-007（唯一生产路径用 `append` + `sequence:0` 违 P26-1）、PKG-008（会话快照读-改-写无 CAS）。

## 1. 发现总表

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| PKG-001 | `packages/harness/src/create-harness.ts:741` / `:842` | 配置漂移基线只在 `sessions.load` 成功后冻结；`createSession` 不冻结 → 会话创建后、首次 load 前改配置，基线被冻结为"新配置"，漂移永不触发 | D | P1 | `createSession` 成功后立即 `freezeConfigFingerprint(id)`（或建会话时把 fingerprint 写进 state snapshot），并补"创建→改配置→首次 load"用例 |
| PKG-002 | `packages/store/src/sqlite-runtime-store.ts:460-468` + `packages/core/src/runtime/runtime.ts:983` | `flushThrough` 在 `sequence === Number.MAX_SAFE_INTEGER` 时**跳过存在性校验**，而 runtime 唯一调用点恰好传 `Number.MAX_SAFE_INTEGER` → 生产路径上的持久化栅栏不做任何校验 | D | P1 | 让 runtime 传真实已提交序号（`lastEvent.sequence`），或删掉哨兵分支并让 store 用"MAX(sequence)"语义校验 |
| PKG-003 | `packages/core/src/runtime/runtime.ts:895` / `:2023-2034` | `toolSemanticsHash` 取 `String(this.toolSemanticsOf.length)`，即**函数形参个数**（恒为 `"1"`）而非哈希；且 `resolveAgent` 只比较 `contextPolicyHash`，`retryPolicyHash`/`sandboxPolicyHash` 存了从不比较，漂移只发一条 `policy.changed_on_resume` 事件、不阻断 resume | D | P1 | 对 tool semantics 表做真实 `stableHashOf`；把 retry/sandbox 哈希纳入漂移判定并按 severity 决定 reject/事件 |
| PKG-004 | `packages/harness/src/config-layers.ts:60-66` | 漂移指纹是 32 位 djb2（`(h>>>0).toString(16).padStart(8,"0")`），用作安全门禁（`CONFIG_DRIFT_REJECTED`）的唯一判定依据 → 可构造碰撞值使放宽后的配置与冻结值同指纹 | D | P2 | 改用 `node:crypto` sha256（截 16 hex 即可），或对关键子键（sandboxPolicy/limits/model）单独再做一次强哈希 |
| PKG-005 | `packages/harness/src/config-layers.ts:49-57` + `packages/harness/src/config-drift.ts:91-100` | `stableSerialize` 把函数序列化为 `[fn:<name>]`（匿名统一 `[fn:anon]`），`normalizeForComparison` 把所有函数统一成 `[[function]]` → 替换 provider/回调的**实现**（同名不同实现）检测不到，漂移漏报 | D | P2 | 对可序列化字段做深比较，函数字段单独标注为"实现不可比较"，出现该字段变化时降级为 `unknown` 方向（当前 `unknown` 已会 reject，但前提是 name 变了） |
| PKG-006 | `packages/harness/src/config-drift.ts:173-182` | P27-5 脱敏只按键名匹配 `SENSITIVE_KEY_PATTERN`；值里内嵌的密钥（URL userinfo、数组元素、连接串）原样写入 `policy.changed_on_resume` 事件 payload | D | P2 | 对字符串值再做一次模式扫描（`bearer`/`sk-`/`://user:pass@`），命中即整体替换为 `***` |
| PKG-007 | `packages/harness/src/compose/compose-stores.ts:92-101` | `appendHarnessEvent` 用 `events.append({…, sequence: 0, schemaVersion: 1})`：硬编码哨兵 sequence 与 ABI 字面量，违背 P26-1（调用方不得提供 sequence，须走 `appendNew`）；是生产代码里**唯一**的裸 `append` 违例 | D | P2 | 改为 `events.appendNew({…省略 sequence/schemaVersion})`；ABI 版本用 `EVENT_ABI_VERSION` 常量 |
| PKG-008 | `packages/harness/src/create-harness.ts:768-775` + `packages/store/src/sqlite-runtime-store.ts:324-330` | `saveStateSnapshot` 是盲 UPSERT（`ON CONFLICT DO UPDATE SET doc = excluded.doc`，无版本/CAS），而 `freezeConfigFingerprint` 与 `setSessionModel` 都是"读-改-写" → 并发可丢更新（可丢掉 `effectiveAgent` 快照或漂移基线） | D | P2 | store 增加 `compareAndSwapSnapshot(expectedRev)`；或把 fingerprint 拆成独立列/独立表，避免与整份 doc 抢写 |
| PKG-009 | `packages/store/src/sqlite-runtime-store.ts:339-373` | `append` 查重 `WHERE session_id=? AND json_extract(doc,'$.id')=?`：事件 id 只存在 `doc` JSON 里（表结构 `PRIMARY KEY(session_id, sequence)`，见 `:103-108`，无 id 列/索引）→ 每次 append 线性扫描该会话全部事件，会话生命周期内总代价 O(n²) | D | P2 | 增加 `event_id TEXT` 列 + `UNIQUE(session_id, event_id)`，查重交给索引；或至少 `CREATE INDEX` 降为 B-tree 查找 |
| PKG-010 | `packages/store/src/sqlite-runtime-store.ts:295-322`、`:656-664` | `listMessages`/`listMessagesByTurn` 用 `ORDER BY created_at`，`checkpointLoadLatest` 用 `ORDER BY created_at DESC LIMIT 1`，均无 tiebreaker → 同毫秒写入的多条记录顺序/最新性不确定（恢复时可能取到非最新 checkpoint） | D | P2 | 追加 `, rowid`（或 `id`）作为稳定 tiebreaker |
| PKG-011 | `packages/store/src/sqlite-runtime-store.ts:194-199` | `schema_migrations` 只在表空时插入 `RUNTIME_SCHEMA_VERSION`，**从不校验已存版本是否高于当前版本** → 旧二进制打开新库静默继续（可写入旧 ABI 记录） | D | P2 | 打开时 `SELECT max(version)`，> 当前版本直接 fail-closed 抛 `schema too new` |
| PKG-012 | `packages/store-integrity/src/index.ts:117-127`、`:159-206` | `withLock` 的 `locks` Map 永不清空（每 key 常驻一条 Promise 链）；`backupTree` 先 `stat` 再 `readFile`，备份期间源文件被改写会拷到不一致内容 | D | P2 | `withLock` 在链尾为空时删除键；`backupTree` 改为"读一次 + 校验 size/mtime 未变，否则重试" |
| PKG-013 | `packages/tools/src/process/executor.ts:471-499` | 注释声称"kill a child **and its descendants**"，但 POSIX 分支只 `child.kill("SIGKILL")`（:498，无进程组/detached），只有 win32 走 `taskkill /t /f` → 非 Windows 上超时/取消后孙进程存活（资源泄漏） | D | P2 | POSIX 用 `detached: true` + `process.kill(-pid)` 杀进程组，或 spawn 时设置独立 process group |
| PKG-014 | `packages/tools/src/process/executor.ts:597-600` | `EXEC_DEBUG` 环境变量命中时直接 `process.stdout.write` → 在 stdio JSON-RPC 传输（gateway/desktop）下会污染协议流 | D | P2 | 改走注入的 logger，或写到 `process.stderr` |
| PKG-015 | `packages/tools/src/orchestrator.ts:586-589` | `runBounded` 仅在 `context.sandboxPolicy.process.timeoutMs` 有值时设超时，`undefined` 时**直接 `tool.execute()` 无任何上限** → 自定义/网络类工具可永久挂起（process 工具自身默认 60s 兜底，见 `executor.ts:506`） | D | P2 | 在 orchestrator 层设全局兜底超时（如 `DEFAULT_TOOL_TIMEOUT_MS`），policy 值只用于收紧 |
| PKG-016 | `packages/core/src/runtime/runtime.ts:558` | `pausedTurns: Map<TurnId, …>` 只在非 `waiting_for_user` 结局（:965）或 `releasePausedTurn`（:1018-1021）删除；被 park 且永不恢复/永不取消的 turn 永久驻留 → 无上限增长 | D | P2 | 给 entry 加 `createdAt`，超时或会话 close 时清理；或用有界 LRU |
| PKG-017 | `packages/core/src/runtime/runtime.ts:1925-1930` | `wallClockExceeded` 用 `now() - turn.startedAt`（含用户等待时间），而 `RunBudgetTracker` 用 active time → 恢复的 paused turn 可能被 wall-clock 提前判超时 | D | P2 | 统一到 active-time 语义，或对 paused 区间做扣减 |
| PKG-018 | `packages/harness/src/config-layers.ts:108-142` | `environmentLayer` 把任意 `AGENT_*` 环境变量按 `__` 分段写入配置树（含 `AGENT_SANDBOX_POLICY__FILESYSTEM__MODE=full`），且该层在 session 冻结之前生效 → 纯环境变量即可放宽沙箱，不经过任何审批 | D | P2 | 环境层只允许白名单键（当前 `LIFECYCLE_RULES` 已有 lifecycle，可再加 allowlist 限制 `sandboxPolicy`/`permissions` 不可从 env 覆盖） |
| PKG-019 | `packages/security/src/sandbox.ts:203-216` | `allowedRoots()` 每次调用都重新 `canonicalizePath`（realpath IO）workspaceRoot + extraRoots + allowedPaths，而 `withinAllowedRoots` 每个文件决策都调用 → 每次判定 N 次同步 realpath 系统调用 | D | P2 | 按 `(workspaceRoot, policy)` 记忆化并在策略变更时失效 |
| PKG-020 | `packages/core/src/runtime/runtime.ts:586-819`、`:1025-1350`、`:1494-1721` | 三个超长函数：构造函数 234 行（装配 5 个 controller）、`runTurnCore` 约 325 行（主循环）、`handleToolResults` 约 228 行（两阶段结果处理） | A | P2 | 构造装配抽 `buildControllers()`；`runTurnCore` 按 phase（budget/context/model/tools/results）再切；`handleToolResults` 的 Phase1/Phase2 拆成两个方法 |
| PKG-021 | 见说明 | 6 组重复工具函数，跨包各写一份 | A | P2 | 收敛到 `@ar/contracts`（序列化/错误）与 `@ar/store-integrity`（哈希）单一实现 |
| PKG-022 | `packages/harness/src/config-layers.ts:175-189` vs `:20-28` | 注释与 `ConfigLayerSource` 声明 `defaults → profile → system → user → project → environment → session → runtime` 八层，`buildConfigLayers` 只实现 defaults/profile/environment/session/runtime 五层；`system`/`user`/`project` 三个层源零实现 | A | P2 | 要么实现三层，要么从 union 与文档里删掉（当前文档承诺的优先级顺序不成立） |
| PKG-023 | `packages/tools/src/orchestrator.ts:171-180`、`:514-541` | `execute()` 从可变 registry 解析工具定义（legacy 路径，定义可在执行中被替换）；`evaluateSandbox` 每次工具调用 `new SandboxManager(...)`（重复构造 + 重复 realpath） | A | P2 | 收口到 `executeBound`；SandboxManager 按 `(root, cwd, policy, extraRoots)` 缓存复用 |
| PKG-024 | `packages/store/src/sqlite-runtime-store.ts:270-300`、`:214-227` | `updateSession`/`updateTurn` 不检查 `changes`（对不存在 id 静默 no-op）；`closed` 标志从不被任何方法检查，close 后调用抛原生 sqlite 错误而非领域错误 | A | P2 | 检查 `run().changes === 0` 抛 `SESSION_NOT_FOUND`；每个公共方法先断言未关闭 |
| PKG-025 | `packages/security/src/sandbox.ts:99-146` | `checkExec` 的"网络意图"判定是 `detectNetworkIntent` 文本启发式（curl/wget/nc 等词），注释自认是静态意图分类器而非 OS 级沙箱 → 易绕过（别名、`node -e fetch`、编译后的二进制） | A | P2 | 文档层面明确它只做"意图提示"，真正的网络隔离交给 `checkNetwork` + 后端沙箱；或在 exec 放行时强制提示 |
| PKG-026 | `packages/core/src/runtime/runtime.ts:2-3` | `mkdir`/`writeFile`/`dirname`/`join` 四个 import 在文件正文零使用（grep 该文件仅命中第 2-3 行） | C | P2 | 删除这 4 个 import |
| PKG-027 | `packages/core/src/state/projections.ts` | 全仓唯一引用者是同目录 `projections.test.ts`；且**不在** `packages/core/src/index.ts` 导出面 → 生产不可达 | C | P2 | 确认是否有接线计划；无则删除或移入测试夹具 |
| PKG-028 | `packages/core/src/runtime/r87-zero-call-replay-ab.ts` | 1878 行，只被 `r87/r88/r93` 三个测试引用（另有 evaluation 注释提及）；并 import 了 core 的 **devDependency** `@ar/model` | C | P2 | 移出 `src`（放 `bench/` 或 `test/fixtures/`），避免 core 生产目录携带仅测试可用代码 |
| PKG-029 | `packages/tools/src/orchestrator.ts:629-640` | `applyOutputLimit` 只对 `typeof result.output === "string"` 生效；结构化 output（对象/数组）完全不受 `maxOutputBytes` 约束 | A | P3 | 对非字符串 output 做 `JSON.stringify` 后按字节限制，或直接拒绝超限结构 |

### 说明 · PKG-001

事实：`freezeConfigFingerprint` 的生产调用点经 grep 全仓只有 `create-harness.ts:842`（另有 `config-wiring.test.ts:123`、`:134` 两处测试）。`:842` 位于 `sessions.load` 实现内，且是"`baseSessions.load(id)` 成功后"才调用。

代码路径：
```
createSession(...)                      // create-harness.ts:741 → runtime.createSession，只写 effectiveAgent/runtimePolicy 快照（runtime.ts:882）
    ↓ 进程退出 / 用户改配置（如 profile 里放宽 sandboxPolicy）
sessions.load(id)                       // create-harness.ts:814
    ↓ checkSessionConfigDrift(id)       // :780-806
    ↓ snap?.[CONFIG_FP_KEY] 不是 string → 直接 { severity: "none" }
    ↓ baseSessions.load(id) 成功
    ↓ freezeConfigFingerprint(id)       // :842 把"改过的配置"冻结为新基线
```
后果：`CONFIG_DRIFT_REJECTED` 对"会话首次 load 之前发生的配置变更"完全不生效；而这条路径正是"创建会话 → 编辑 profile/env → 下次启动 resume"的常规用法。多次 load 之后的漂移才被拦住。
测试盲区：`config-drift-matrix.test.ts`/`config-wiring.test.ts` 都是手工 `freezeConfigFingerprint()` 后再 check，没有覆盖创建路径。

### 说明 · PKG-002

事实：`flushThrough` 实现（`sqlite-runtime-store.ts:460-468`）先 `PRAGMA wal_checkpoint(PASSIVE)`，再 `if (sequence === Number.MAX_SAFE_INTEGER) return;` 跳过 `SELECT 1 FROM events WHERE …` 校验。全仓调用点 grep 结果：`runtime.ts:983` 传 `Number.MAX_SAFE_INTEGER`；测试 `sqlite-runtime-store.test.ts:441/443` 传真实序号并断言 `flushThrough(sid, 999)` 抛 `not committed` —— 说明校验逻辑本身有效，只是生产路径永远走不到。
风险：`durabilityFence` 名义上是"turn 结束后确保事件已持久化"的栅栏，实际在生产中等价于一次 PASSIVE checkpoint（不保证 WAL 已落盘），崩溃恢复的最新事件可能丢失且无任何告警。

### 说明 · PKG-003

事实：`runtime.ts:895` 写 `toolSemanticsHash: this.toolSemanticsOf !== undefined ? String(this.toolSemanticsOf.length) : undefined`。`toolSemanticsOf` 是注入的**函数**，其 `.length` 是形参个数，恒为 `1`。
事实：`resolveAgent`（:2001-2054）的漂移分支条件是 `runtimePolicy?.version === 1 && this.context !== undefined`，且只比较 `contextPolicyHash`（:2024）。`:893` 写入的 `retryPolicyHash` 与同处写入的 sandbox 相关字段在漂移判定中**从未被读取**（grep `retryPolicyHash` 全仓仅 2 处：写入点与类型定义）。
后果：换掉 tool semantics 表（改变工具的安全语义）不会改变指纹，resume 时静默沿用新语义；`sandboxPolicy` 变更同样不参与判定。

### 说明 · PKG-007

事实：`compose-stores.ts:92-101` 明确写 `sequence: 0`（注释："the store's allocator is authoritative (P16-5)"）与 `schemaVersion: 1`（字面量，而非 `EVENT_ABI_VERSION`）。全仓生产代码用 `appendNew` 的有 `runtime.ts:840`、`gateway.ts:368`、`delegator.ts:773/790`、`reflection-runner.ts:169`；裸 `append` 仅此一处 + `migrate.ts:212`（迁移，保留原序号，合理）。
当前不产生错误（SQLite/JSONL store 都会覆写 sequence 与 ABI 版本），但这是一条"靠下游兜底"的契约违例：任何新 store 实现若信任调用方 sequence，就会写出 `sequence: 0` 的破坏稠密性记录。

### 说明 · PKG-021 重复实现清单

| 函数 | 重复位置 |
|---|---|
| `stableStringify` | `packages/contracts/src/serialization.ts:44`、`packages/learning/src/change.ts:77`、`packages/evaluation/src/manifest.ts:243` |
| `errorMessage` | `packages/learning/src/promoter.ts:33`、`packages/learning/src/sandbox.ts:148`、`packages/observability/src/harness-evolution.ts:110` |
| `isPlainObject` | `packages/core/src/runtime/r87-zero-call-replay-ab.ts:1343`、`packages/evaluation/src/paired-execution-identity.ts:75`、`packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts:672` |
| `truncate` | `packages/agents/src/delegator.ts:852`、`packages/core/src/verification/runtime-verifier.ts:147` |
| `truncateAtLineBoundary` | `packages/context/src/compaction.ts:321`、`packages/skills/src/skill-loader.ts:410` |
| 哈希（sha256-16 / FNV / djb2 / sha256） | `packages/core/src/runtime/runtime.ts:129`（sha256 截 16）、`packages/harness/src/scope-resolver.ts:78`、`packages/harness/src/config-layers.ts:60`（djb2 32 位）、`packages/harness/src/workspace-manager.ts:322`、`packages/harness/src/compose/compose-mcp.ts:133`（另一个局部 `hashOf`） |

`hashOf` 在 harness 内部就有 3 个不同实现（`config-layers.ts:60` djb2、`compose-mcp.ts:133`、`workspace-manager.ts:322`），同名不同算法，读代码时极易误判"指纹同源"。

## 2. 分模块明细

### 2.1 `packages/core`（28 src / 71 test）

运行时主干。`runtime.ts`、`session-actor.ts`（2054 行）为两个最大文件；副作用经 `orchestrator.executeBound` 下发（`verification-controller` 在 `runtime.ts:739` 走 bound 路径，并在 `:717` 前置 `isToolAllowedByPolicy` 检查）。

| ID | 位置 | 要点 |
|---|---|---|
| PKG-003 | `runtime/session-actor.ts` 以外的漂移判定 | 见上 |
| PKG-016/017 | `runtime/runtime.ts:558`、`:1925-1930` | 无上限 Map、时钟语义不一致 |
| PKG-020 | `runtime/runtime.ts` 三处 | 超长函数 |
| PKG-026 | `runtime/runtime.ts:2-3` | 未使用 import |
| PKG-027 | `state/projections.ts` | 仅测试引用且不在导出面 |
| PKG-028 | `runtime/r87-zero-call-replay-ab.ts` | 仅测试引用 + 依赖 devDependency |

正面证据（已核实，非问题）：`emit`（`runtime.ts:831-850`）统一走 `events.appendNew`，符合 P26-1；`runTurn` 的 `runningTurns` 单 turn 守卫在 `finally` 清理；`submitUserAnswer` 的 `userAnswerSubmissions` 串行化在 `finally` `release()`；`resumeTurn` 缺 checkpoint 时抛 `RESUME_FAILED`（fail-closed）；`semanticsOf`（:1934-1936）未知名工具落保守默认。

唯一直接文件系统写入点：`runtime/context-controller.ts:614-618`（工具输出 artifact，`flag: "wx"` + `mode: 0o600`）。见 §4-1 关于边界的存疑。

### 2.2 `packages/harness`（36 src / 61 test）

组合根 + 配置管线。8 层配置声明只实现 5 层（PKG-022），漂移门禁有两处缺口（PKG-001/003）。`create-harness.ts` 962 行的职责偏重（会话装配、漂移门禁、fork 继承、mcp/provider 接线都在一个文件）。

| ID | 位置 | 要点 |
|---|---|---|
| PKG-001/004/005/006/018/022 | `config-layers.ts` / `config-drift.ts` / `config-resolver.ts` / `create-harness.ts` | 见上 |
| PKG-007 | `compose/compose-stores.ts:92-101` | 唯一裸 `append` |
| PKG-008 | `create-harness.ts:768-775` | 快照读-改-写 |

正面证据：`sessions.load` 在 `reject`/`restart_required` 时先发 `policy.changed_on_resume` 再抛 `CONFIG_DRIFT_REJECTED`（先取证后拒绝，顺序正确）；`lifecycleOf` 未匹配键默认 `session_frozen`（fail-closed）；`captureConfigValue` 递归 `Object.freeze`。

### 2.3 `packages/tools`（37 src / 41 test）

编排器 + 进程执行器。12 步管线的 PermissionEngine/SandboxManager 均为必经步骤，未发现旁路。

| ID | 位置 | 要点 |
|---|---|---|
| PKG-013/014 | `process/executor.ts:471-499`、`:597-600` | 跨平台进程树终止不一致；调试输出污染 stdio |
| PKG-015/023/029 | `orchestrator.ts:586-589`、`:171-180`、`:629-640` | 无超时分支、legacy 入口、输出限制只覆盖 string |

正面证据：`executeResolved`（:188-397）顺序为 validate → classify → permission → approval → sandbox → 意图持久化（失败 fail-closed）→ 预算 → 执行；无 approval resolver 时 `APPROVAL_DENIED` 拒绝（:462-512）；`runBounded` 正确桥接外层 abort 到内层 controller 并在 `finally` 移除监听、`clearTimeout`；`exec.catch` 防 unhandled rejection；`runArgv` 走 `shell: false` 且 `.cmd` 只在无元字符时经 cmd.exe（`planArgvLaunch`）；全仓生产代码 `shell: true` 零命中（27 处命中全在测试与注释）。

### 2.4 `packages/security`（17 src / 20 test）

| ID | 位置 | 要点 |
|---|---|---|
| PKG-019 | `sandbox.ts:203-216` | 每次决策重算 realpath |
| PKG-025 | `sandbox.ts:99-146` | 网络意图靠文本启发式 |

正面证据：`resolvePath`（:174-193）拒绝控制字符、盘符/UNC 伪装，`canonicalizePath` 抛错时返回 null（fail-closed）；`read-only` 模式写直接拒；`process-gate.ts` 的 `surfaceDenied`（:541-549）对空 deny 列表返回 `{denied:false}`（策略语义，非缺陷）；`approval.ts` 的等待结算有独立测试（`approval-wait-settlement.test.ts`）。

### 2.5 `packages/store` + `packages/store-integrity` + `packages/events` + `packages/session` + `packages/checkpoint`

| ID | 位置 | 要点 |
|---|---|---|
| PKG-002/009/010/011/024 | `store/sqlite-runtime-store.ts` | 栅栏短路、O(n) 查重、排序无 tiebreaker、迁移版本不校验、写空不报错 |
| PKG-012 | `store-integrity/index.ts` | 锁表不淘汰、备份非原子 |

正面证据：`append` 在 `BEGIN IMMEDIATE` 事务内分配序号（`sequence=(seq??-1)+1`）并覆写 `EVENT_ABI_VERSION`，UNIQUE 冲突翻译为 `duplicate event id/sequence`（序列稠密性由 store 独占，符合 P26-1）；`appendNew` = `append({…sequence:-1})`；`commitToolOutcome` 在单事务内写 tool message + outcome + 可选 checkpoint（P26-6）；`durabilityLevel` 返回 `"process"` 且注释诚实说明不扛掉电；inbox 血缘 `PROMOTION_CONFLICT`/`CONSUME_NOT_PROMOTED` fail-closed；`atomicWriteFile` 用 `open(tmp,"wx")` + `fsync` + `atomicReplace`（从不先 unlink 目标）；JSONL 解析 strict 模式逐行抛 `corrupt JSONL line N`。

Windows 降级（`syncDir` 直接 return + 一行 `[degraded]` 日志、`atomicReplace` 仅对 EPERM/EACCES/EBUSY 重试 16 次约 5.13s）是**已文档化**的设计，不计缺陷。

### 2.6 `packages/contracts`（44 src / 15 test + `testing.ts`）

纯类型与常量包，无运行时副作用。`EVENT_ABI_VERSION = 1`（`event.ts:101`）、`CHECKPOINT_SCHEMA_VERSION = 1`（`checkpoint.ts:23`）、`EventStore` 契约含 `appendNew`/`nextSequence`/`flushThrough`（`event.ts:134-137`、`:253`）。未发现越界依赖（core→contracts 44 文件、harness→contracts 32、tools→contracts 36、security→contracts 16）。

## 3. 覆盖清单

统计口径：`git ls-files packages/<pkg>`。结论标记：`全文` = 逐行通读；`定点` = 导出面 + 关键路径 grep 定点核查；`聚合` = 按目录规则聚合（规则见 3.8）。

### 3.1 packages/core（100：28 src + 1 fixture + 71 test + 2 配置）

| 文件 | 结论 |
|---|---|
| `src/index.ts` | 定点，无问题（12 行导出面，`projections` 不在其中 → PKG-027） |
| `src/errors.ts` | 定点，无问题 |
| `src/lifecycle/hooks.ts` | 定点，无问题 |
| `src/recovery/recovery.ts` | 定点，无问题 |
| `src/runtime/runtime.ts` | **全文**，见 PKG-003/016/017/020/026 |
| `src/runtime/session-actor.ts` | 未逐行（2054 行），定点：导出面 + 事件写入路径，无新增发现 |
| `src/runtime/context-controller.ts` | 定点（含 `:614-618` artifact 写入），见 §4-1 |
| `src/runtime/model-call-controller.ts` | 定点，无问题 |
| `src/runtime/tool-call-controller.ts` | 定点，无问题 |
| `src/runtime/verification-controller.ts` | 定点（`:717` 前置策略检查 + `:739` `executeBound`），无问题 |
| `src/runtime/recovery-controller.ts` | 定点（`:328` `nextSequence-1` 用法 + `:340` 硬编码 `schemaVersion: 1`），见 §4-3 |
| `src/runtime/recovery-state-machine.ts` | 定点，无问题 |
| `src/runtime/run-budget.ts` | 定点（active-time 语义，PKG-017 对照方），无问题 |
| `src/runtime/read-only-prefetch.ts` | 定点，无问题 |
| `src/runtime/tool-catalog.ts` | 定点，无问题 |
| `src/runtime/turn-helpers.ts` | 定点，无问题 |
| `src/runtime/step-execution-snapshot.ts` | 定点，无问题 |
| `src/runtime/step-snapshot-factory.ts` | 定点，无问题 |
| `src/runtime/artifact-store.ts` | 定点，无问题 |
| `src/runtime/ask-gate.ts` | 定点，无问题 |
| `src/runtime/command-classification.ts` | 定点，无问题 |
| `src/runtime/tool-output-security.ts` | 定点，无问题 |
| `src/runtime/local-environment-manager.ts` | 全文（短），`homedir` 只读 + `process.env.SHELL/COMSPEC` 读取，无问题 |
| `src/runtime/r87-zero-call-replay-ab.ts` | 定点，见 PKG-028 |
| `src/state/agent-state.ts` | 定点，无问题 |
| `src/state/projections.ts` | **全文**（短），见 PKG-027 |
| `src/tools/tool-selector.ts` | 定点，无问题 |
| `src/verification/runtime-verifier.ts` | 定点（`:147` 局部 `truncate` → PKG-021），无问题 |
| `src/test/fakes.ts`、`src/test/fake-orchestrator.ts` | 聚合：测试夹具，被 40+ 测试引用，非死代码 |
| `src/**/*.test.ts`（71） | 聚合（规则见 3.8）：抽查 `config-drift` 相关与 `runtime.test.ts` 的契约断言；未逐行 |

### 3.2 packages/harness（97：36 src + 59 test + 2 配置）

| 文件 | 结论 |
|---|---|
| `src/create-harness.ts` | 定点（740-929 全文 + 全文件 grep），见 PKG-001/008 |
| `src/config-layers.ts` | 定点（`:45-72` 全文 + 全文件 grep），见 PKG-004/005/018/022 |
| `src/config-resolver.ts` | 定点，无问题 |
| `src/config-drift.ts` | 定点，见 PKG-005/006 |
| `src/config.ts` | 定点，无问题 |
| `src/config-explainer.ts` | 定点，无问题 |
| `src/compose/compose-stores.ts` | **全文**（116 行），见 PKG-007 |
| `src/compose/compose-context.ts` | 定点，无问题 |
| `src/compose/compose-delegation.ts` | 定点，无问题 |
| `src/compose/compose-mcp.ts` | 定点（`:133` 局部 `hashOf` → PKG-021），无问题 |
| `src/compose/compose-observability.ts` | 定点，无问题 |
| `src/compose/compose-tools.ts` | 定点，无问题 |
| `src/compose/compose-verification.ts` | 定点，无问题 |
| `src/candidate-store.ts`、`child-merge.ts`、`coding-prompt-policy.ts`、`command-discovery-service.ts`、`delegation-tools.ts`、`durable-recovery-store.ts`、`effective-instruction-context.ts`、`index.ts`、`introspection.ts`、`lifecycle.ts`、`mem-stores.ts`、`memory-runtime-bridge.ts`、`memory-search-tools.ts`、`path-scoped-instructions.ts`、`profiles.ts`、`reflection-runner.ts`、`scope-resolver.ts`、`skill-context.ts`、`tool-event-security.ts`、`tool-names.ts`、`verification-planner.ts`、`worker-agent.ts`、`workspace-manager.ts` | 定点（导出面 + 副作用/IO grep）：`scope-resolver.ts:78` 与 `workspace-manager.ts:322` 各有一份哈希（PKG-021）；`workspace-manager.ts` 的 patch 应用有 contentHash/parentBaselineHash 双校验（fail-closed，正面）；其余无问题 |
| `src/**/*.test.ts`（59） | 聚合（3.8）：抽查 `config-drift-matrix` / `config-wiring` 后确认测试盲区（PKG-001 说明） |

### 3.3 packages/tools（80：37 src + 1 许可文件 + 41 test/夹具 + 1 配置）

| 文件 | 结论 |
|---|---|
| `src/orchestrator.ts` | **全文**（752 行，分 3 段），见 PKG-015/023/029 |
| `src/process/executor.ts` | **全文**（686 行，分 3 段），见 PKG-013/014 |
| `src/process/sandbox-executor.ts` | 定点（870 行，未逐行）：`execFile("bwrap", ["--version"])` 探测 + `windowsHide`，无 shell 插值 |
| `src/process/utf8-output.ts` | 全文（短），无问题 |
| `src/production-tools.ts`、`registry.ts`、`tool-lookup.ts`、`tool-prompt-guidance.ts`、`semantics`（经 `orchestrator` 引用） | 定点，无问题 |
| `src/tools/exec.ts`、`read-file.ts`、`write-file.ts`、`edit-file.ts`、`search-files.ts`、`navigation-tools.ts`、`repo-map-tool.ts`、`update-plan-tool.ts`、`discover-commands-tool.ts`、`env-snapshot-tool.ts` | 定点：均以 `ToolDefinition` 形态交给 orchestrator，未自行执行子进程或绕过沙箱 |
| `src/workspace.ts`、`write-safety.ts`、`file-coordination.ts`、`transaction.ts`、`edit.ts`、`navigate.ts`、`read-window.ts`、`command-classifier.ts`、`command-discovery.ts`、`env-snapshot.ts`、`regex-scanner.ts`、`relevant-code-map.ts`、`repo-map.ts`、`symbol-index.ts`、`syntax-index.ts` | 定点：`env-snapshot.ts:16` 用 `execFileSync` 采集环境（宿主驱动、非模型发起）；其余无问题 |
| `src/verification/plan-builder.ts`、`src/verification/task-verifier.ts` | 定点，无问题 |
| `licenses/deepseek-harness-MIT.txt`、`test-fixtures/coding-retrieval-gold.json` | 非代码，无问题 |
| `src/**/*.test.ts`（40） | 聚合（3.8）：抽查 `r96-windows-execution-boundary`（断言无 `shell: true`）、`windows-cancellation` |

### 3.4 packages/contracts（61：44 src + 14 test + `testing.ts` + 2 配置）

44 个 `src/*.ts` 均为类型/常量/纯函数：`agent`/`approval`/`artifact`/`ask-user`/`capability`/`checkpoint`/`context`/`durability`/`environment-manager`/`errors`/`event-payloads`/`event`/`experiment`/`hooks`/`ids`/`inbox`/`index`/`limits`/`mcp`/`memory`/`message-protocol`/`message`/`model`/`non-fatal`/`path-containment`/`permission-expiry`/`permission`/`plugin`/`recovery`/`repair`/`retry`/`sandbox`/`schema-advert`/`serialization`/`session`/`skill`/`stall`/`step-context`/`taxonomy`/`termination`/`timer`/`tool`/`verification`/`working-state` → **聚合：全部定点，无问题**（`serialization.ts:44` 的 `stableStringify` 是 PKG-021 的推荐收敛点）。
`src/testing.ts` 被 `git ls-files` 匹配为测试文件但实为共享测试工具：定点，无问题。
`src/*.test.ts`（14）聚合（3.8）。

### 3.5 packages/security（38：17 src + 20 test + 1 配置）

| 文件 | 结论 |
|---|---|
| `src/sandbox.ts` | **全文**（242 行），见 PKG-019/025 |
| `src/process-gate.ts` | 定点（515 行，未逐行）：`parseCommandInvocation`/`scanShellOperators`/`commandAllowlisted`/`surfaceDenied`/`analyzeProcessCommand` 导出面已核 |
| `src/permission.ts`、`permission-grant.ts`、`approval.ts`、`approval-capability.ts`、`capability-guard.ts`、`denial.ts`、`boundary-guard.ts`、`canonical-path.ts`、`glob.ts`、`index.ts`、`injection-gate.ts`、`network-gate.ts`、`secret-gate.ts`、`supply-chain.ts` | 定点，无问题 |
| `src/*.test.ts`（20） | 聚合（3.8）：含 `parser-fuzz`、`path-parity`、`no-silent-catch` 等安全基线测试 |

### 3.6 packages/store / store-integrity / events / session / checkpoint

| 文件 | 结论 |
|---|---|
| `store/src/sqlite-runtime-store.ts` | **全文**（675 行），见 PKG-002/009/010/011/024 |
| `store/src/migrate.ts` | 定点（`:212` 保留原 sequence 的 `append` 用量，合理），无问题 |
| `store/src/index.ts` | 定点，无问题 |
| `store-integrity/src/index.ts` | **全文**（266 行），见 PKG-012 |
| `store-integrity/src/retention.ts` | 定点，无问题 |
| `events/src/event-store.ts` | 定点：`flushThrough` 实现（`:253`）与 JSONL 追加路径已核，见 PKG-002 |
| `events/src/sink.ts`、`index.ts` | 定点，无问题 |
| `session/src/service.ts` | 定点（`:160-168` fork 继承快照 `{...childState, ...inherited}`），无问题 |
| `session/src/session-store.ts` | 定点（`:332-342` 快照读写），无问题 |
| `session/src/ask-user-store.ts`、`inbox.ts`、`replay.ts`、`index.ts` | 定点，无问题 |
| `checkpoint/src/checkpoint-store.ts`、`index.ts` | 定点，无问题 |

### 3.7 全局补充核查（跨全部 10 包）

| 核查项 | 结果 |
|---|---|
| 未引用文件（零 importer） | 0（脚本 `_rt_scan.ps1` 解析全仓 1176 个 ts 的 import） |
| 仅被测试引用的源文件 | 3 个：`core/src/state/projections.ts`（PKG-027）、`core/src/test/fake-orchestrator.ts`（夹具，正常）、`core/src/runtime/r87-zero-call-replay-ab.ts`（PKG-028） |
| 未使用 import | `core/src/runtime/runtime.ts:2-3` 4 个（PKG-026） |
| 未使用依赖 | 未发现：core=`@ar/contracts`/`@ar/context`/`zod`、tools=`@ar/contracts`/`@ar/security`、security/session/store/events/checkpoint 均有用到（`@ar/model` 在 core 是 devDependency 且只被 r87 使用 → 与 PKG-028 同一问题） |
| `shell: true` 生产命中 | 0（27 处全在测试/注释） |
| `node:child_process` 在 core | 0（全部子进程在 `tools`/`mcp`/`harness`） |
| 硬编码 `schemaVersion: 1` 生产命中 | `compose-stores.ts:100`、`recovery-controller.ts:340`（见 §4-3） |
| `process.env` 直读（core） | 仅 `local-environment-manager.ts:24`（`SHELL`/`COMSPEC`，只读） |

### 3.8 聚合规则

3.8 说明的聚合仅适用于测试文件：`*.test.ts`、`*.regressions.test.ts`、`*.perf.test.ts`、`*.soak.test.ts`、`test-fixtures/*`。聚合执行的事项为：(a) 确认它们不在生产 import 图上（脚本扫描）；(b) 抽查与本次发现直接相关的 4 个测试文件（`config-wiring`、`config-drift-matrix`、`r96-windows-execution-boundary`、`sqlite-runtime-store`）；(c) 未逐行阅读其余测试断言。**聚合组不做死代码/性能判定**，仅确认"不是被引用端之外的问题源"。

## 4. 存疑/需人工确认

1. **Core 直接写文件是否违反 "All side effects go through ToolOrchestrator"**：`packages/core/src/runtime/context-controller.ts:614-618` 用 `mkdir`+`writeFile(flag:"wx")` 落盘工具输出 artifact。判定倾向：这是**宿主驱动的持久化**（budget/context 管理），不是模型发起的副作用，因此不构成绕行；但它确实让 core 直接依赖 `node:fs`，与"Core must not depend on … external integrations"的边界存在解释空间。需架构 owner 确认是否允许，若不允许应下沉为注入的 `ArtifactSink`。
2. **Windows 目录 fsync 降级**：`store-integrity/src/index.ts:23-45` 在 win32 直接 return。若发布完整性要求"跨平台一致崩溃恢复"，这是缺陷；若只要求"文件原子替换"（已满足），则是既定降级。需确认目标级别。
3. **`recovery-controller.ts:340` 硬编码 `schemaVersion: 1`**：未直接判定为违例（该处构造的是 checkpoint 记录且当前版本常量同为 1），但同样绕开了 `CHECKPOINT_SCHEMA_VERSION`，建议与 PKG-007 一并收敛；若 ABI 升级会静默写入旧版本号。
4. **`nextSequence(id) - 1` 在 `recovery-controller.ts:328`**：与 P26-1（序号 store 独占）可能存在张力，但该处是"读取上次序号用于判定"而非写入，需人工确认用法意图。
5. **`pausedTurns` 与 `wallClockExceeded` 的时钟语义**（PKG-016/017）：是否有意用 wall-clock 惩罚长时间 park 的 turn，需产品口径确认。
6. **`environmentLayer` 的 `AGENT_*` 通配**（PKG-018）：是否被文档承认为"运维应急开关"；若承认，至少应在 `sandboxPolicy`/`permissions` 上禁用。
7. **`projections.ts` 与 `r87-zero-call-replay-ab.ts`（PKG-027/028）**：是否有接线/搬迁计划，否则按 C 类处理。
8. **`r97-closed-loop.test.ts` 通过读源码断言"不含 `shell: true`"**：这类元测试有效但脆弱（重命名常量即失效），未计入发现。
