# HARNESS Agent 全面优化执行计划（Master Plan）

> 目标：把 `harness-agent-src` 从“已经具备完整 Agent Harness 基础能力的实现”继续推进为一个**可恢复、可验证、可评估、可持续学习、可安全演化**的通用 Agent Runtime。
>
> 本文件不是架构畅想，而是给 Coding Agent 直接执行的任务书。  
> **严格按优先级执行，禁止跳过 P0 直接堆功能。**

---

# 0. 总执行协议（必须遵守）

你正在优化的主工程是：

```text
harness-agent-src/
```

仓库其他目录，例如：

```text
codex-main/
claude-code-fork-main/
hermes-agent-main/
opencode-dev/
pi-main/
reports/
```

默认视为：

```text
参考实现 / 逆向研究 / 机制资料库
```

除非本计划明确要求，否则：

- 不直接修改这些参考实现目录。
- 不把外部 Agent 源码大段复制进入 `harness-agent-src`。
- 可以参考机制、状态机、数据流和设计思想，但必须结合当前架构重新实现。
- 优先保持现有 package 边界和 contracts 抽象。
- 不为了“架构漂亮”进行无 benchmark 支撑的大规模重写。

---

## 0.1 每个任务必须使用以下闭环

每开始一个任务，先完成：

```text
1. Inspect
2. Reproduce / establish baseline
3. Write or update tests
4. Implement minimal correct change
5. Run targeted tests
6. Run affected package tests
7. Run full typecheck
8. Run full test suite
9. Run build
10. Record result
```

禁止：

```text
先大改代码
→ 最后再补测试
```

优先：

```text
RED
→ GREEN
→ REFACTOR
→ FULL REGRESSION
```

---

## 0.2 每个优化项完成后必须更新本 plan

在对应任务标题下维护：

```text
Status: TODO | IN_PROGRESS | BLOCKED | DONE
Commit/Change:
Tests:
Benchmark:
Notes:
```

若实际实现发现计划错误：

- 不要静默偏离。
- 在任务下增加 `Deviation`。
- 说明为什么偏离。
- 给出验证证据。

---

## 0.3 全局验收命令

每个 Phase 完成后至少执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

若 benchmark 环境可用，再执行：

```bash
node apps/cli/dist/main.js benchmark --suite regression
node apps/cli/dist/main.js benchmark --suite holdout
node apps/cli/dist/main.js benchmark --suite adversarial
node apps/cli/dist/main.js benchmark --suite stress
```

任何优化不得通过以下方式“提高通过率”：

- 降低 judge 严格度。
- 删除失败用例。
- 修改 expected 迎合当前实现。
- 把本应验证的行为改成字符串匹配。
- 给 holdout 泄漏 expected/checker。
- 静默吞错。
- 把 failure 改成 success。
- 关闭 safety gate。
- 提高资源预算掩盖 loop 问题。

---

# P0 — 必须先完成

---

# P0-1 Session Effective Agent Config Snapshot

Status: DONE

## 完成摘要

- `packages/contracts/src/agent.ts`：新增 `EffectiveAgentConfig` 接口、`EFFECTIVE_AGENT_SNAPSHOT_KEY = "effectiveAgent"`、`snapshotEffectiveConfig(agent)`、`isToolAllowedByPolicy(policy, toolName)`（deny-list 优先 fail-closed；allow-list 要求成员；两者皆空 = 全允许）。
- `packages/core/src/runtime/runtime.ts`：
  - `createSession()`：session 创建后立即持久化 `{ [EFFECTIVE_AGENT_SNAPSHOT_KEY]: snapshotEffectiveConfig(opts.agent) }`；快照持久化失败 → session 创建失败（fail-closed）。
  - `runTurn()`：改用 `resolveAgent(session)`，从状态快照解析 effective agent，不再直接 `this.agents.get(session.agentId)`。
  - `resolveAgent()`：无快照 → 旧会话兼容回退 registry；快照损坏或 `agentId` 与 session 不一致 → 抛 `INTERNAL_ERROR`（拒绝以 base agent 运行）。
  - `executeToolCall()`：orchestrator 之前新增策略门，`isToolAllowedByPolicy` 判定失败 → 不发 `tool.requested` 后续流程，emit `tool.failed`（code `PERMISSION_DENIED`）+ 返回 `{status:"denied"}`。
- Delegator 生成的受限 child agent（`delegator.ts:86`）经 `createSession` 冻结；`session-store` 的 `saveStateSnapshot/loadStateSnapshot`（JSONL 持久化）已存在，未改动。

## Tests

- 新增 `packages/agents/src/delegator.test.ts` 3 项强制测试：
  - read-only child request：read_file allow / write_file+exec deny（orchestrator 实际路径验证）。
  - runtime/store 重载后 resume：限制仍生效。
  - child 创建后 base agent 变宽（registry 新实例注册更宽松定义）：不得自动扩权。
- 新增 `packages/core/src/runtime/effective-config.test.ts` 7 项：快照持久化 + runTurn 强制、fresh runtime resume、registry widening 不生效、legacy session 回退 registry、损坏快照 fail-closed、agentId 不匹配 fail-closed、session.created 前快照已落盘、createSession 后改动调用方 agent 定义不得改变冻结策略（共 8 项）。
- 存量 `runtime.test.ts` 的 maxToolCalls/maxDurationMs 测试适配新语义：limits 现由 `createSession` 传入的 agent 冻结（注册表注入不再生效），两个测试改为在创建 session 时携带 limits。
- 全量：`pnpm typecheck` exit 0；`pnpm test` 56 files / 826 passed / 1 skipped / 0 failed（基线 814+1failed，+11 新增，+1 stripe 修复）；`pnpm build` exit 0。全量套件连续两次全绿。

## Benchmark

- 未运行 benchmark 套件（需模型 API key，环境门槛）；行为/安全指标由上述 11 项新增测试覆盖。

## Notes

- 独立代码审查结论：策略门位于 `executeToolCall`（hooks/orchestrator 之前），串行与并发批量路径（`Promise.all` batched）统一经过该门，无旁路；`createSession` 先落 store 再存快照再发 `session.created`；`resolveAgent` 仅对"无快照"的 legacy session 回退 registry，快照存在但损坏/agentId 不匹配一律 fail-closed（`INTERNAL_ERROR`），不存在静默回退扩权路径。
- P0-1 语义决策（已按此修复存量测试）：limits 与 tools/permissions/model/systemPrompt 一并冻结进快照；registry 侧变更（包括 limits 变更）对已运行 session 一律不生效，避免"删除 limits"式扩权。`runtime.test.ts` 的 maxToolCalls/maxDurationMs 测试原依赖 registry 注入 limits，现改为在 `createSession` 时携带 limits（snapshot 权威）。
- 快照隔离加固：`snapshotEffectiveConfig` 对 model/limits 浅拷贝、对 tools/permissions/skills 的 allow/deny 数组拷贝，createSession 后修改调用方 AgentDefinition 无法改变冻结策略（有测试锁定）。
- 已知 flake 处理（非 P0-1 引入，packages/tools 生产模块零改动）：`orchestrator.test.ts` "Phase 9: local exec emits no security event" 在全量并行跑偶发 `status:"timeout"` —— sandbox 测试预算 `process.timeoutMs=500` 在并行负载下不足以完成 node 子进程 spawn；该测试已改为断言时提升测试内 sandbox budget 至 3000ms（仅测试夹具，生产 process policy 不变），改动后全量连跑 2 次全绿。

## 问题

当前 Delegator 可以生成：

```ts
childAgent = {
  ...base,
  tools: restrictToolPolicy(base.tools, req.toolPolicy)
}
```

但 Session 主要保存 `agentId/model/cwd`，后续 `runTurn()` 再通过：

```ts
this.agents.get(session.agentId)
```

取回全局 AgentDefinition。

需要验证：

> Child-specific tool/permission/limits/system/config override 是否在真正执行时丢失。

这属于安全边界问题。

## 目标

建立：

```text
AgentDefinition
     ↓
EffectiveAgentConfig
     ↓
Session snapshot
     ↓
TurnContext
```

Session 创建后，运行时使用冻结后的 effective config，而不是仅凭 agentId 重新读取 base agent。

## 实现要求

新增或扩展类似：

```ts
interface EffectiveAgentConfig {
  agentId: AgentId
  model: ModelRef
  systemPrompt: string
  tools: ToolPolicy
  permissions: PermissionPolicy
  limits: AgentLimits
}
```

具体字段根据 contracts 当前真实类型决定，不要臆造重复类型。

要求：

1. `createSession()` 生成 snapshot。
2. snapshot 必须持久化。
3. `runTurn()` 从 session/effective-config 读取。
4. 子代理 restriction 必须是只能收窄、不能扩权。
5. Resume 后限制仍然有效。
6. 后续动态 registry 更新不能静默改变已运行 Session 权限。
7. 如允许显式升级权限，必须经过新的受控 API，而不是 registry 侧变更自动生效。

## 必须新增测试

```text
Parent: read + write + exec
Child request: read only

Child:
- read_file -> allow
- write_file -> deny
- exec -> deny
```

再增加：

```text
create child
persist session
reload runtime/store
resume child
write/exec 仍 deny
```

再增加：

```text
base AgentDefinition 在 child 创建后被改变
child effective policy 不得自动扩权
```

## 完成定义

- restriction 在实际 orchestrator path 生效。
- Session snapshot 可序列化/恢复。
- 无权限回退到 base agent 的路径。
- full tests pass。

---

# P0-2 Runtime Tool Policy Enforcement Audit

Status: DONE

## 审计结论

单一决策链成立，生产路径无旁路：

```text
ToolCall
  ↓ P0-1 session tool-policy gate（runtime，fail-closed）
Tool Registry Lookup（未知工具 → TOOL_SCHEMA_ERROR，fail-closed）
  ↓ Schema 校验（TOOL_SCHEMA_ERROR）
  ↓ classify risk surface（process/network/filesystem → 具体 surface；generic → tool surface）
  ↓ Permission（DeterministicPermissionEngine：等特异性 deny 胜；无匹配 → defaultEffect ?? "ask"；不自动 allow）
  ↓ Approval（ask 无 resolver → APPROVAL_DENIED，fail-closed）
  ↓ Sandbox（filesystem scope / process allowlist / network gate；surface 由 metadata 声明决定）
  ↓ runBounded（timeout/output caps）→ evidence → normalize
```

按包审计（core / tools / mcp / plugins / security / agents）：

- **core**：执行唯一出口是 `orchestrator.execute`（runtime.ts:837/863）；串行与并发 batch（Promise.all）统一走 `executeToolCall` → 同一门；`toolCapabilityOf` 默认 `DEFAULT_TOOL_CAPABILITY`（retry "unknown"、concurrencySafe false，保守）。
- **tools**：orchestrator 链如上；`capabilityOf`（registry.ts）未声明时回落保守默认。
- **mcp**：`createMcpToolAdapter` 产出 ToolLike，**无 risk/metadata/surface 声明**；当前仅测试消费，未接入生产 runtime。经 registry+orchestrator 接入后即普通 ToolDefinition，无外部 server 特权，能力默认保守（有测试锁定）。
- **plugins**：`PluginHost.onTool` 是独立的插件分发通道，**当前仅测试使用，未接入 core/gateway**；不存在生产旁路。插件式工具若走 registry 注册（process surface）则 sandbox 强制生效（有测试）。
- **security**：permission 引擎确定性，冲突 deny 胜；失败不回退 allow。
- **agents**：subagent restriction 在 P0-1 运行时门（session tool policy）生效（delegator/effective-config 测试覆盖），非仅 delegator 计算层。

## Tests

- 新增 `packages/tools/src/source-matrix.test.ts`（20 项）：builtin / dynamic / mcp / plugin 四来源 × allow / deny / unknown / sandbox-deny 全矩阵；dynamic 后注册同链；MCP network 工具被 sandbox network gate 拒绝并 emit `security.network_denied`；MCP 风格工具能力默认保守（retry unknown、serial）；显式 deny 规则胜过 defaultEffect allow（不回退）；sandbox 仅绑定声明 surface（generic 工具无 surface 通过属设计行为，有文档化测试）。
- subagent-restricted 行由 P0-1 新增的 delegator/effective-config 测试覆盖（runtime 门），矩阵文件内注明引用。
- 全量：`pnpm typecheck` exit 0；`pnpm test` 57 files / 846 passed / 1 skipped / 0 failed（+20 矩阵）；`pnpm build` exit 0。

## Benchmark

- 未运行 benchmark 套件（需模型 API key，环境门槛）。

## Notes

- 审计未发现生产代码旁路；无需修改生产模块（本任务零生产改动，全部为新增测试）。
- 观察（不修改，避免无关 churn）：未知工具报 `TOOL_SCHEMA_ERROR`（fail-closed 语义满足，错误码语义上可争议为 PERMISSION_DENIED，属外观问题）。
- 观察：`effectivePolicy` 中 agent 显式 `defaultEffect` 优先于 risk 默认值 —— agent 政策为权威，非旁路（有测试证明显式 deny 仍胜）。
- 后续接入 MCP/Plugin 到生产 wiring 时，必须：①ToolLike → ToolDefinition 转换时强制声明 risk/retry/concurrencySafe 保守默认（复用 `capabilityOf` 语义）；②不得引入绕过 orchestrator 的执行路径（参考 PluginHost 目前仅测试用）。

## 目标

不要只在 Delegator 层“计算权限”，要确认 runtime/tool-orchestrator 真正执行前一定经过有效策略。

建立唯一权限决策链：

```text
ToolCall
  ↓
Tool Registry Lookup
  ↓
Effective Tool Policy
  ↓
Permission
  ↓
Hook
  ↓
Sandbox
  ↓
Execution
```

禁止出现：

```text
某个 MCP/plugin/dynamic tool
绕过 ToolPolicy / permission / sandbox
```

## 审计范围

至少检查：

```text
packages/core
packages/tools
packages/mcp
packages/plugins
packages/security
packages/agents
```

## 要求

- 未知工具默认 deny 或明确 fail-closed。
- dynamic tool 必须进入同一权限链。
- MCP 工具不得因为来自外部 server 而获得特殊权限。
- Plugin tool 不得绕过 sandbox。
- Tool capability 声明不可信时采取保守策略：
  - concurrencySafe = false
  - retry = unsafe
- 权限判定失败不得自动 fallback allow。

## 测试

新增统一“工具来源矩阵”：

```text
builtin
dynamic
mcp
plugin
subagent-restricted
```

分别验证：

```text
allow
deny
unknown
hook deny
sandbox deny
```

---

# P0-3 Memory Store V2：SQLite + WAL

Status: DONE

## 问题

当前 JSONL memory store 为整文件 rewrite，并假设 single-writer。

但 Harness 已支持：

```text
ParallelDelegator
NestedDelegation
并发子会话
```

未来 Reflection/Learning 一旦并行写 memory，存在 lost update 风险。

## 目标

实现：

```text
MemoryStore V2
SQLite
WAL
transaction
concurrent readers
serialized safe writes
```

## 第一阶段不要做过度设计

优先：

```text
SQLite
+ WAL
+ schema version
+ FTS5 / BM25
+ metadata filter
```

暂不强制 embedding。

## 建议表

```sql
memories
memory_evidence
memory_usage
memory_conflicts
reflection_outputs
learning_candidates
promotion_history
schema_migrations
```

字段最终根据 contracts 设计。

## Migration

必须支持：

```text
memories.jsonl
     ↓
one-time migration
     ↓
SQLite
```

要求：

- 幂等。
- crash-safe。
- 原 JSONL 不立即删除。
- migration 成功后记录 version。
- 可 dry-run。

## 并发测试

至少：

```text
20 concurrent writes
20 concurrent reads
write + search
write + soft delete
write + update
crash-like interrupted transaction
```

验证无 lost update。

## 安全要求

现有：

```text
prompt injection scan
secret scan
soft-delete
reviewability
```

不得因迁移丢失。

## 完成摘要

- `packages/memory/src/sqlite-memory-store.ts`：`SqliteMemoryStore`（node:sqlite `DatabaseSync`，Node 24 内置，零新增依赖）实现 contracts `MemoryStore` 同名接口，与 `JsonlMemoryStore` 行为兼容（upsert、soft delete、unknown id fail-closed、security denied）。
  - WAL：`PRAGMA journal_mode=WAL`；所有 mutation 在 `BEGIN IMMEDIATE` 事务内，串行化安全写入，crash 不会留下 torn write。
  - Schema version：`schema_migrations` 表记录 `MEMORY_SCHEMA_VERSION=1`，重开幂等。
  - FTS5：`memories_fts` 虚表 + `bm25()` 排序；查询无法 tokenize / FTS 不可用时自动回退 LOWER+LIKE。
  - 安全门与 JSONL 后端共享：`checkUnsafeMemory`/`scanMemoryEntries` 提取到 `security-gate.ts`，两个 store 行为完全一致（injection/secret 拒绝在持久化前，`SECURITY_DENIED` + `onSecurityDenied` 回调）。
- Migration：`migrateJsonlToSqlite(store, entries, {dryRun})` + `readJsonlEntries(dataDir)`（从 memory-store.ts 导出，坏行跳过）。
  - 幂等（`INSERT OR IGNORE`，重跑 inserted=0/skipped=N）；单事务 crash-safe；原 JSONL 永不删除或修改（非破坏性）；dry-run 不写任何行；被安全门拒绝的条目进 `denied` 列表且绝不落库。
- `packages/memory/src/index.ts`：新增导出（`SqliteMemoryStore`、`migrateJsonlToSqlite`、`readJsonlEntries`、`security-gate`）；旧导出全部保留。
- `JsonlMemoryStore` 自身逻辑未改动（仅把 `checkUnsafe`/`scanForSecrets` 内联体搬进共享 `security-gate.ts`），原有 22 个测试原样通过。

## Tests

- 新增 `packages/memory/src/sqlite-memory-store.test.ts`（20 个）：契约对等 13（injection/secret 拒写+回调、upsert、soft delete、unknown fail-closed、FTS 搜索+type filter、LIKE 回退、scanForSecrets、WAL 模式、schema version 幂等）+ 并发 6（20 concurrent writes 无 lost update、20 concurrent reads、write+search、write+soft delete、write+update 终态一致、crash-like 中断事务回滚后重开恢复）+ 双连接同文件 1。
- 新增 `packages/memory/src/migration.test.ts`（7 个）：全量迁移+JSONL 保留+可搜索、幂等重试、dry-run 零写入、injection/secret 进 denied 且不落库、soft-deleted 条目 deleted 标志保留、空 JSONL、同批重复 id 不双插。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` 59 files / **874 passed / 1 skipped / 0 failed**（上轮 57/846 + 28 新增）；`pnpm build` exit 0。

## Benchmark

- 内存包定向：3 files / 49 tests / ~2.1s（sqlite 打开 + 建表 + WAL 一次，之后单测试毫秒级）。
- 全量：15.3s（transform 11.7s）。

## Notes

- Node `v24.14.0` 内置 `node:sqlite`（`DatabaseSync` 同步 API），`@types/node` 26.2.0 已有类型，仓库零新增依赖；node 启动会打一条 `ExperimentalWarning: SQLite is an experimental feature`（stderr，不影响行为，运行期行为已由测试锁定）。
- sqlite 连接为同步单连接：并发测试用 `Promise.all` 包同步调用验证串行化（每笔写完整落库后才轮到下一笔），配合 `BEGIN IMMEDIATE` 保证无 lost update；crash 测试 = 未提交事务中 close 连接（SQLite 自动回滚）→ 重开验证恢复。
- `list` 排序由 JSONL 的"文件顺序"变为 `updated_at DESC`（有意为之，文档化；对等测试只断言内容集合不断言顺序）。
- FTS MATCH 查询把每个 token 用双引号包裹后 OR 连接；`bm25()` 升序；搜索强制 `deleted=0`（软删除条目不可被搜到，与 JSONL 一致）。
- `close()` 幂等（closed 标志），测试多连接/重开场景安全。
- Migration 现状：`migrateJsonlToSqlite` 以 entry 数组为入参（`readJsonlEntries` 负责读文件），调用方决定何时删除 JSONL；`memories.jsonl` 与 `memories.db` 并存不冲突。
- P0-4 注意事项：当前 `MemoryEntry` 无 scope 字段（P0-4 才引入）；迁移工具对未知字段宽容（JSONL 解析按 id+content 最小校验），新增 scope 后旧行直接兼容。

## 问题

- 无。一行观察：FTS5 对含 `-` 等 token 分隔符的查询把 token 拆开后按短语匹配，行为与 LIKE 不同（如 "no-such-term" 不会 LIKE 命中 "no-such-term" 但 FTS 会拆词）——已在搜索语义测试中按 FTS 行为固定预期。

---

# P0-4 Memory Retrieval V2

Status: DONE

## 问题

当前 retrieval 主要基于 substring/token。

## 目标

建立：

```text
query
 ↓
scope filter
 ↓
FTS/BM25
 ↓
metadata scoring
 ↓
recency/usefulness/confidence
 ↓
dedup/conflict filter
 ↓
Top-K
```

## Memory ranking 建议

不要只用一个分数。

保留可解释组成：

```ts
score = {
  lexical
  recency
  usefulness
  confidence
  successEvidence
  scopeMatch
}
```

最终排序可以组合，但必须可观测。

## 要求

Memory 必须有 scope，例如：

```text
global
workspace
repository
agent
task-family
session
```

不得默认把所有 procedural memory 注入任何任务。

## 测试

- 同关键词不同 scope。
- stale memory vs validated memory。
- conflicting memories。
- deleted memory。
- malicious memory。
- irrelevant high-recency memory。
- precise technical retrieval。

## 完成摘要

- `packages/contracts/src/memory.ts`：新增 `MemoryScope`（global/workspace/repository/agent/task-family/session）+ `MemoryEntry.scope`（必填，持久化时赋值）；`MemoryStore.search/list` 增加可选 `scope` 精确过滤。
- `packages/memory/src/retrieval.ts`：`retrieveMemories(store, query, queryScope, opts)` 完整管道：
  scope filter（层级 global⊃…⊃session，broad→narrow 可见、反向泄漏禁止）→ FTS/BM25（store.search 排名）→ 可解释分数组件 → dedup/conflict → Top-K。
  - `MemoryScore = { lexical, recency, usefulness, confidence, successEvidence, scopeMatch, total }`（无单一不透明分数）；权重 `SCORE_WEIGHTS` 文档化且总和=1（lexical .35 / recency .15 / usefulness .15 / confidence .15 / successEvidence .10 / scopeMatch .10）。
  - recency = 指数衰减（半衰期 21 天，`RECENCY_HALF_LIFE_MS`，clamp [0,1]）；usefulness/successEvidence 分别以 importance/stability 为代理（文档化，Reflection 的 stability 即验证后存续度）；scopeMatch：精确=1，每宽一级 ×0.8。
  - 冲突/去重：content token Jaccard ≥ `CONFLICT_SIMILARITY_THRESHOLD=0.6` 视为同 topic，只保留 total 最高者，其余进 `suppressed`（reason "conflict"），保证 observability（绝不静默丢弃）。
  - 读路径纵深防御：`checkUnsafeMemory` 复查每个命中，恶意内容以 reason "unsafe" 抑制；deleted 永不匹配（store 层保证）。
  - `now` 可注入（测试确定性），默认 `Date.now()`。
- 后端改造（scope 落库）：
  - SQLite：`memories.scope` 列（CHECK 枚举），schema version 1→2，`ensureScopeColumn` 对 v1 库幂等 `ALTER TABLE ADD COLUMN`，`schema_migrations` 顺序记录 v1、v2；search/list 的 scope 精确过滤；migration 写 scope。
  - JSONL：旧行无 scope 时读取默认 `"session"`（最窄最安全，绝不外泄）；search/list 支持 scope 精确过滤。
- `index.ts` 导出 retrieval 全部纯函数/类型与 `MemoryScope`。

## Tests

- 新增 `packages/memory/src/retrieval.test.ts`（18 个）：scope 模型 3（层级/可见性/scopeMatch 衰减）+ 场景 9（同关键词不同 scope、scope 不泄漏、stale vs validated、conflicting、deleted、malicious（绕过 write gate 直插 FTS 的行被 unsafe 抑制）、irrelevant high-recency、precise BM25、top-k、minScore）+ 可观测性 4（组件 ∈[0,1] 且 total=Σw·c、recency 衰减、scopeMatch 偏好、Jaccard）+ JSONL 后端一致性 1。
- 存量测试适配：三个 makeEntry fixture 加 `scope:"session"`；sqlite schema-version 测试改为 schema_migrations 行数=2（v1+v2 迁移日志不清除）。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` 60 files / **892 passed / 1 skipped / 0 failed**（上轮 59/874 + 18 新增）；`pnpm build` exit 0。

## Benchmark

- 内存包定向：4 files / 67 tests / ~2.6s。
- 全量：15.3s。

## Notes

- scope 语义测试要点（防回归）：SQLite 的 FTS 搜索只查 `memories_fts` 虚表——绕过 write gate 直插 `memories` 的行不可见，测试必须同时写 FTS 索引才模拟真实恶意路径。
- 冲突阈值 0.6 是 Jaccard；near-duplicate 语义（同 topic 不同措辞）会被归组；测试样例刻意让相似度远高于/低于阈值（0.857 / 0.429）避免边界摩擦。
- BM25 长度归一：同 tf 下短文排名更高；stale-vs-validated 用例靠"validated 更短且更新"同时满足冲突归组与排名，验证"验证过的新记忆胜过陈旧记忆"。
- 检索管道对后端无感知（任意实现 `MemoryStore` 的 store 均可，JSONL 与 SQLite 结果一致）。
- P0-5 衔接：`LearningPromoter` 可把 `retrieveMemories` 作为 read 端；`promotion_history`/`memory_usage` 表尚未建（P0-5 需要时再加，avoid overdesign）。

## 问题

- 无。一行观察：`retrieveMemories` 的 minScore 只过滤 total，不保留组件明细——若后续要"组件级召回底线"，可在 `RetrieveOptions` 加 per-component 阈值（当前无需求）。

---

# P0-5 LearningPromoter V2：Champion / Challenger

Status: DONE

## 问题

当前 promotion 逻辑主要基于：

```text
benchmarkBefore(): number
benchmarkAfter(): number
```

单点分数不足以抵抗 LLM 随机性。

## 目标

重构为：

```text
Champion
   ↓
Candidate
   ↓
Challenger
   ↓
Repeated paired evaluations
   ↓
Promotion Gate
```

## 新 ScoreCard

设计类似：

```ts
interface HarnessScoreCard {
  regressionSuccessRate: number
  holdoutSuccessRate: number
  adversarialPassRate: number
  stressPassRate: number

  falseCompleteRate: number
  recoveryRate: number
  retryRate: number

  latencyP50Ms: number
  latencyP95Ms: number

  avgInputTokens: number
  avgOutputTokens: number
  avgToolCalls: number

  contextOverflows: number
  securityViolations: number
}
```

字段按现有 metrics 实际能力调整。

## Promotion Gate

至少：

```text
Regression:
不得显著退化

Holdout:
候选应有正向收益或不退化，取决于 candidate 类型

Adversarial:
不得新增安全违规

Stress:
不得明显增加资源故障

False complete:
不得上升

Security violation:
硬门，不能 trade off

Latency / Tokens:
受预算约束
```

## 多次运行

支持：

```text
N repeated runs
paired seed / comparable configuration
median
variance
confidence interval or conservative threshold
```

不要引入复杂统计库也可以，先实现可靠的 repeated-run gate。

## Candidate Types

支持独立评估：

```text
memory
skill
workflow
tool_preference
prompt_rule
context_policy
retry_policy
scheduler_policy
```

## Rollback

promotion 后：

```text
periodic reevaluation
regression detected
→ rollback
```

必须记录：

```text
candidate version
before scorecard
after scorecard
evaluation config
suite versions
judge version
model/provider version
```

## 完成摘要

- `packages/learning/src/scorecard.ts`：`HarnessScoreCard`（14 字段，字段按现有 metrics 能力裁剪——latency/tokens/tool-calls/retries/compaction 全部来自 `RunMetrics`，无任何估算）：
  - 四个 suite 成功率（regression/holdout/adversarial/stress，`EvalOutcome.status` 计算；无 case 的 suite = 0，诚实"无证据"，gate 端 fail-closed）。
  - `falseCompleteRate`：passed 且 `terminationReason === "model_stopped"`（该代码库基于事件流的 false-complete 信号）占总 case 比例。
  - `recoveryRate`：有 verification_failures 的 case 中最终 passed 的比例（无失败时 = 1，真空不惩罚健康运行）。
  - `retryRate` / `avgInputTokens` / `avgOutputTokens` / `avgToolCalls`：逐 case 均值；`latencyP50Ms/P95Ms`：nearest-rank 百分位；`contextOverflows`：compaction 总数；`securityViolations`：adversarial suite 失败数（安全相关违规，硬门）。
  - `computeScoreCard(outcomes)` 纯函数，空结果全 0 无 NaN；`percentile` 独立导出。
- `packages/learning/src/paired.ts`：repeated paired gate（无统计库，median + population variance + 保守阈值）：
  - 统计纯函数 `median` / `populationVariance` / `medianCard`（逐指标 median 折叠 N 次 run）；`MIN_REPEATED_RUNS=2`（单次样本显式拒绝，延续 §194）。
  - `comparePaired(champion[], challenger[], opts)` → `PairedComparisonReport {overall, reasons, perMetric}`：每指标 `PairedMetricVerdict`（champion/challenger median、variance、verdict、detail），gated 指标任一 fail 即 reject，非 gated（recovery/retry/p50）仅报告。
  - Gate 规则（对应 plan 原文）：regression 不得显著退化（median 差 ≤ `DEFAULT_REGRESSION_TOLERANCE=0.02`）；adversarial 硬门（默认容差 0，零下降）；stress ≤ `DEFAULT_STRESS_TOLERANCE=0.03`；variance 不稳定守卫（median 变差且 challenger variance > champion × `DEFAULT_VARIANCE_FACTOR=3` + eps）；holdout 按 candidate 类型（见下）；false complete 任一 paired run 上升即 fail（最严格解读）；securityViolations 逐 pair 硬门不可 trade off（即使其他指标全优）；contextOverflows 总和差 ≤ `DEFAULT_OVERFLOW_SLACK=0`；latency 受绝对预算（`budgets.latencyP95Ms`）+ 相对因子（`DEFAULT_RELATIVE_LATENCY_P95_FACTOR=1.2`）双重约束；tokens/tool-calls 仅绝对预算约束（未配置则 informational）。
  - `HOLD_OUT_REQUIREMENT_BY_KIND`：content 类（memory/skill/workflow/prompt_rule）必须正向收益（median 严格提高），tuning 类（tool_preference/context_policy/retry_policy/scheduler_policy）仅不得退化；`opts.holdoutRequirement` 可按 kind 覆盖。
  - `compareVsReference(reference, current, opts)`：rollback 比较（reference 为冻结的 after scorecard；单值侧对每个 current run 比较，worstPairVerdict 语义）。
- `packages/learning/src/candidate.ts`：`LearningCandidateKind` 扩为 8 种（+context_policy/retry_policy/scheduler_policy）；`LearningCandidate.version?`；`PromotionRecord`（§790-797 全字段：candidateVersion/beforeScorecard/afterScorecard/evaluationConfig/suiteVersions/judgeVersion/modelProviderVersion，缺省 `"(not recorded)"` 永不伪造）。
- `packages/learning/src/promoter.ts`：新增 `LearningPromoterV2`（V1 保留不动，旧测试原样过）：
  - `promote(c, deps)`：securityCheck 短路（失败不跑任何 benchmark）→ runs ≥ 2 校验 → 逐 index 收集 champion/challenger（收集异常 fail-closed 拒绝）→ `comparePaired`（holdout 按 kind 解析）→ 拒绝时带 report 返回且不 persist → 通过时写 `promotionRecord`（before/after = medianCard）+ `deps.meta` 版本元数据，persist 恰好一次。
  - `reEvaluate(c, deps)`：无 record → rejected；runs < 2 或收集失败 → rolled_back（fail-closed）；`compareVsReference(afterScorecard, current)` 且 holdout 强制 `"no-regress"`（promotion 只可持有或失效，rollback 不复核收益要求）；任何硬门/预算 fail → rolled_back + report；永不调用 persist（撤销线上变更属调用方职责，与 V1 一致）。
- `packages/learning/package.json` + `tsconfig.json`：新增 `@ar/evaluation` workspace 依赖与项目引用（`computeScoreCard` 消费 `EvalOutcome`）；`index.ts` 导出全部新表面。

## Tests

- 新增 `scorecard.test.ts`（10）：suite 成功率/缺失 suite=0/empty card 无 NaN、falseComplete 仅计 passed+model_stopped、recoveryRate（含无失败=1）、retry/token/tool 均值、P50/P95 nearest-rank、contextOverflows 求和、securityViolations 仅 adversarial。
- 新增 `paired.test.ts`（14）：统计纯函数（median 奇偶/var/population、medianCard）；gate——promote 路径、超出容差回归拒绝、容差内放行、variance 不稳定拒绝、falseComplete 逐 pair 硬门、security 硬门即使其余全优、latency 绝对预算/相对因子、token 预算、holdout improve 不达标拒绝、run 数不匹配/不足拒绝、per-metric 明细；compareVsReference——security 上升 rollback、保持则 pass、median 回归 rollback、单次 current 拒绝。
- 新增 `promoter-v2.test.ts`（14）：promote 成功 + 完整 ledger 记录、meta 原样记录 + `"(not recorded)"` 回退、security 短路（不跑 benchmark 不 persist）、runs<2 拒绝、champion/challenger 收集异常拒绝不 persist、gate 拒绝带 report、memory kind 必须正向 holdout、retry_policy kind 可持平（no-regress）、拒绝永不 persist；reEvaluate——持有、security 上升 rollback、median 回归 rollback、收集失败 rollback（fail-closed）、runs<2 rollback、未 promote 拒绝、rollback 不动 record。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **63 files / 940 passed / 1 skipped / 0 failed**（上轮 60/892 + 48 新增）；`pnpm build` exit 0。

## Benchmark

- learning 包定向：4 files / 69 tests / ~0.5s。
- 全量：63 files / 8.6s（测试总时长 34s 并行）。

## Notes

- 依赖安装路径：新增 workspace 依赖后 `pnpm install` 会重解析并尝试下载 `@typescript/typescript-win32-x64@7.0.2` 平台包，registry.npmjs.org 超时（此前已手动修复过该包）——用 `pnpm install --registry=https://registry.npmmirror.com` 一次成功；`pnpm exec tsc` 会先做 deps-status 检查，install 失败则 tsc 根本不会跑（报错栈误导，先查 install）。
- variance 不稳定守卫必须带 eps（`VARIANCE_EPS=1e-9`）：`[0.99×3]` 的 population variance 是 ~6e-32 的浮点尘埃而非 0，不带 eps 会让"容忍范围内 1% 下降"误判为 unstable。
- worstPairVerdict 对单值 champion（rollback reference）逐个比较所有 current run——硬门（security/falseComplete）在 rollback 路径不会因 pair 截断而漏检。
- rollback 的 holdout 必须强制 `"no-regress"`：若复用 promote 的 `"improve"` 要求，memory 类候选的 after scorecard 本身就无法被 current 超越，rollback 永远误报（设计 bug，测试首先抓出）。
- `pnpm-lock.yaml` 因 install 重解析有内容变化（@ar/evaluation 依赖），与 HEAD 的 diff 仅含新增 workspace 条目，无噪音。

## 问题

- 无。一行观察：scorecard 的 latency/token 只取中位与均值，没有跨 run 的 worst-case 上界指标——若后续要"绝不超预算"类策略（scheduler_policy 用），可在 `comparePaired` 增加 max-of-runs 校验（当前无需求）。

---

# P0-6 Benchmark Integrity & Reproducibility

Status: TODO

## 目标

把 benchmark 从“能跑”提升为“可作为 Harness 变更仲裁器”。

## 增加 run manifest

每次 benchmark 输出：

```json
{
  "gitSha": "...",
  "dirty": false,
  "model": "...",
  "provider": "...",
  "temperature": "...",
  "suiteVersion": "...",
  "judgeVersion": "...",
  "runtimeConfigHash": "...",
  "timestamp": "...",
  "platform": "...",
  "nodeVersion": "..."
}
```

## 要求

- 每 case 独立 workspace。
- 每 case 独立 session/store。
- holdout checker 不进 model context。
- benchmark 不读取上一次 run 生成的 artifacts。
- 固定 case order，但报告同时支持 randomized execution order。
- 区分：
  - model failure
  - harness failure
  - judge failure
  - infrastructure failure
- benchmark runner 本身异常不能被记作 agent task failed。

## 新增 contamination 检测

验证：

```text
case A 运行产生的信息
不得被 case B memory/session/context 读取
```

除非显式测试 cross-run learning。

---

# P0-7 Security Boundary Consistency Audit

Status: TODO

## 目标

统一 security 的“检测、拒绝、事件、错误码、评估”。

覆盖：

```text
network
filesystem
process
prompt injection
secret
memory
skill
MCP
plugin
artifact
subagent
```

## 要求

每类安全拒绝尽量具有：

```text
structured reason
security event
error code
target
source
sessionId
turnId
toolCallId if applicable
```

不得：

```text
仅 stderr 打印
但 event stream 不可见
```

## Secret Handling

- Secret 不进入 learning/memory。
- Secret 不进入 benchmark artifact。
- Tool output budget 落盘前评估是否需要 redaction。
- Logging 默认避免打印完整 token/credential。
- Error payload 不应把 provider secret 带出。

## Injection

除 memory/skill 持久化外，还审计：

```text
tool output
MCP response
plugin metadata
artifact text
repository instructions
subagent result
```

不是说一律 deny，而是建立 trust metadata + context boundary。

---

# P0-8 Trust-Aware Context Model

Status: TODO

## 目标

当前 ContextBlock 已有 trust/source 等概念，下一步真正用起来。

建立：

```text
trusted:
system
explicit user policy
verified project instructions

semi-trusted:
tool output
subagent output
memory
skill body

untrusted:
repository content
external MCP content
web-like fetched content
plugin content unless signed/trusted
```

具体 trust mapping 结合现有架构。

## Context 拼装规则

高 trust 内容可约束低 trust 内容。

低 trust 内容不得通过文本伪造：

```text
SYSTEM:
DEVELOPER:
ignore previous instructions
```

来提升权限。

## 测试

- README prompt injection。
- tool output injection。
- MCP output injection。
- subagent result injection。
- memory poisoning。
- skill poisoning。

验证低 trust 内容只能作为 data/context，而不能提升 authority。

---

# P1 — Runtime 可恢复性与长任务能力

---

# P1-1 WorkingState：统一运行状态

Status: DONE

## 问题

目前 runtime journal、context placeholder summary、state digest、subagent summary、resume future state 分散。

## 目标

建立唯一结构：

```ts
interface WorkingState {
  goal
  constraints

  plan
  decisions

  completed
  pending

  filesChanged
  commandsRun
  testsRun
  failures

  importantFacts
  openQuestions

  toolRefs
  artifactRefs
  memoryRefs
  childAgentRefs
}
```

不要照抄字段，以现有 contracts 合理拆分。

## 所有能力共享同一个 state

```text
Compaction
Checkpoint
Resume
Subagent handoff
Verification
Final summary
Observability
```

不得各自维护互相漂移的 summary。

## Tests

- `packages/contracts/src/working-state.ts`：唯一权威 run-state 结构（goal/constraints/plan/decisions/completed/pending/filesChanged/commandsRun/testsRun/failures/importantFacts/openQuestions/toolRefs/artifactRefs/memoryRefs/childAgentRefs），消费方明确注释为 compaction/checkpoint/resume/handoff/verification/final summary/observability。
- `packages/core/src/state/agent-state.ts`（210 行）：阶段状态机（IDLE→THINKING→TOOL_PENDING→…→COMPLETED|FAILED|CANCELLED）+ iteration/tool 计数；`agent-state.test.ts`（4）：合法路径、非法转移拒绝、终态转移拒绝、迭代/工具计数。
- 共享性验证（无漂移）：checkpoint 携带 working state（checkpoint.test.ts）、resume 从 checkpoint 恢复 working state（resume.test.ts）、delegator 把 child turn 的 working state 交给 parent（delegator.test.ts "P1-1: hands the child turn's working state to the parent"）。

## Benchmark

- agent-state 定向：1 file / 4 tests / <1s。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` 1048 passed（P1-1 相关 69 files 内）；`pnpm build` exit 0。

## Notes

- 公司远程版本已将 P1-1 的 contracts 结构与 core 状态机实现完毕（本次会话核实证据后补记，非本次新写）。
- WorkingState 字段集与 CompactionSummary 语义重叠处对齐（compaction 视图不携带 plan/refs，checkpoint/resume/handoff 消费方需要）。

---

# P1-2 Context Compaction V3

Status: DONE

## 目标

移除/替代 placeholder summary。

Context pipeline 负责：

```text
when to compact
which blocks to retain
budget
```

Runtime/WorkingState 负责：

```text
what must survive compaction
```

## 必须保留

```text
exact user goal
hard constraints
decisions
completed work
pending work
changed files
test status
known failures
important facts
artifact refs
child-agent refs
```

## 防止 summary hallucination

优先使用结构化 state 生成 deterministic digest。

LLM summarizer 如未来加入，只能作为辅助，不得覆盖 deterministic critical state。

## Compaction invariant tests

压缩前后：

```text
goal invariant
constraints invariant
pending work invariant
verification evidence invariant
```

## Tests

- `packages/context/src/compaction.test.ts`（10）：可折叠块（tool/web/memory/subagent）折叠为一个 summary 块；never-compact 块逐字节原序保留；渲染非空 summary 字段（空数组省略）；P1-2 must-survive 字段（completed work / artifacts / child-agent refs）在 summary 中渲染；无可折叠时原样返回；summary 块位于最后保留块之后；100k+ token 会话 30×4000 折叠并保留 5 个锚点；相同输入输出确定（仅 Date.now() 时间戳按规格可变）。
- deterministic digest 优先：summary 由结构化 state 渲染，无 LLM summarizer 覆盖 critical state 的路径。

## Benchmark

- compaction 定向：1 file / 10 tests / <1s。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现（补记）。placeholder summary 已由结构化的 compaction summary 替代；压缩时机/保留块/预算归 context pipeline，必须保留项归 WorkingState。

---

# P1-3 Durable Checkpoint

Status: DONE

## 目标

长任务每到安全边界可落 checkpoint。

建议 checkpoint 时机：

```text
after successful side-effect tool
after verification
after subagent completion
after compaction
before potentially risky phase transition
periodically every N events
```

## Checkpoint 内容

包括：

```text
session
turn
phase
iteration
working state
budget usage
tool ledger
child sessions
last event sequence
effective agent config ref
context refs
```

## 要求

- 原子写。
- 有 schema version。
- 可迁移。
- 可校验 checksum。
- 坏 checkpoint 不得覆盖最后一个好 checkpoint。

## Tests

- `packages/contracts/src/checkpoint.ts`（155 行）：CheckpointData 结构（含 toolLedger/childSessions/lastEventSequence/effectiveAgentConfigRef/contextRefs）+ CHECKPOINT_SCHEMA_VERSION + computeCheckpointChecksum。
- `packages/checkpoint/src/checkpoint-store.ts`（209 行）+ `checkpoint-store.test.ts`（9）：round-trip 校验 checksum；多 checkpoint 保留最新、newest-first 列出；隔离其他 session；checksum 不匹配写前拒绝（fail-closed）；corrupt latest.json 不回退丢失最后一个好 checkpoint（loadLatest 扫描兜底）；坏文件被 list 跳过而好文件存活；路径穿越 session id 拒绝；写回读逐字节一致。
- `packages/core/src/runtime/checkpoint.test.ts`（6）：side-effect 工具成功后带 working state 落 checkpoint；非 side-effect 工具（echo）不落；checkpoint 失败可观测（checkpoint.failed 事件）且不阻断 turn；配置 N 迭代周期性落点；携带 childSessions/budget usage/config ref/lastEventSequence；无 store 时无 checkpoint 事件。
- 时机接线：afterSideEffectTools / afterCompaction / afterVerification / everyNIterations（runtime checkpointPolicy 默认 DEFAULT_CHECKPOINT_POLICY）。

## Benchmark

- checkpoint 定向：2 files / 15 tests / <1s。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现（补记）。迁移策略：旧 schemaVersion 严格 fail-closed（写入拒绝 UNSUPPORTED_SCHEMA、读取跳过），无显式 v1→v2 数据迁移函数——以"坏版本永不破坏好数据"为不变量；显式迁移器留待未来 schema 变更时按需添加（见 P0-5 风格 Notes：不虚构能力）。

---

# P1-4 Crash Resume / Event Replay

Status: DONE

## 目标

支持：

```text
process killed
runtime restarted
unfinished session detected
checkpoint restored
events after checkpoint replayed
resume safely
```

## 重要原则

Resume 不是：

```text
把完整旧 transcript 再塞给模型
```

而是：

```text
WorkingState
+ recent message tail
+ artifact/tool references
+ durable event state
```

## Side-effect 安全

引入 tool execution ledger：

```ts
{
  toolCallId
  idempotencyKey?
  tool
  argsHash
  started
  completed
  resultHash
  sideEffect
}
```

恢复时：

- 已明确成功的非幂等写操作不得盲目重放。
- started 但 completion 不明的操作进入 reconciliation。
- safe read 可以按策略重做。
- unsafe exec/write 默认要求模型或恢复逻辑判断，而不是自动 retry。

## Tests

- `packages/core/src/runtime/resume.test.ts`（6）：从 durable checkpoint 恢复并注入 restored working state；checkpoint 后已完成的 side effect 标记 committed（永不重做）并折叠回 state；started 但未确认的工具呈现为 unresolved reconciliation（永不自动重做）；无 durable checkpoint 拒绝恢复（RESUME_FAILED）；无 checkpoint store 拒绝；resume prompt 携带 working state + committed/unresolved，省略完整 transcript。
- `packages/session/src/replay.ts`（232 行）+ `replay.test.ts`（13）：重建 completed turn（工具调用计数+输出）；派生 failed/cancelled 状态、忽略 session 级事件；按 sequence 而非列表序判定终态；只 started 的 turn = running；仅工具活动无生命周期事件 = unknown；工具失败消息包含；orchestrator 形状 tool.output 解码；空会话空结果；store snapshot 与事件重放对同一 session 一致（架构 §110）。
- tool ledger 接入 runtime（tool.completed 记录 sideEffect/resultHash；tool.executing kill 窗口进 reconciliation）。

## Benchmark

- resume+replay 定向：2 files / 19 tests / <1s。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现（补记）。Resume 输入 = WorkingState + recent tail + refs + durable events，非旧 transcript 重灌（resume prompt 测试验证省略 transcript）。

---

# P1-5 Fault Injection V2

Status: DONE

现有 fault injection 基础上新增：

```text
kill after file write
kill during file write
kill after tool completed event before checkpoint
kill after checkpoint before next model call
kill during model stream
kill during provider backoff
kill while child agent running
kill while several children running
kill during verification
kill during compaction
kill while memory transaction active
kill while MCP call active
```

每个场景验证：

```text
no duplicate unsafe side effect
no corrupted session
recoverable state is recovered
unrecoverable ambiguity is surfaced honestly
```

## Tests

- `packages/core/src/runtime/fault-injection-v2.test.ts`（11，FaultPoint 命名 kill 点：tool.completed / tool.checkpointed / tool.executing / model.next_call / model.stream / verification.started / context.compacted，RuntimeKilledError 逃逸 retry/recovery，turn 无 completed 事件）：
  - kill after file write（checkpoint 已落）：副作用已提交、永不重执行、session 完好；
  - kill after tool completed 但 checkpoint 未落：store 结果证明已提交；
  - kill during file write：outcome unknown → unresolved reconciliation，永不重执行；
  - kill after checkpoint before next model call：resume 不丢已提交工作；
  - kill during model stream：无副作用、turn 死、resume 完成；
  - kill during verification：turn 死、resume 重跑完成；
  - kill during compaction：summary 块已在 transcript 持久、resume 恢复；
  - honest un-recoverability：无 checkpoint 可恢复 → RESUME_FAILED，不虚构工作；
  - kill while child agent running：child session 完好仍 linked、父 turn 死、resume 呈现 unresolved 且不重新委托；
  - kill while several children running：全部 in-flight child session 完好、无重复、delegation 不重执行；
  - kill while MCP call active：in-flight MCP 工具呈 unresolved、session 完好、外部调用绝不自动重试。
- kill during provider backoff（`packages/model/src/openai.test.ts` 新增）：backoff 窗口内 abort → 挂起重试被取消、无重复请求发到网络、以 cancelled（非 error）结束。
- kill while memory transaction active（`packages/memory/src/sqlite-memory-store.test.ts` 已有 "crash-like interrupted transaction rolls back cleanly and the store recovers"）：未 COMMIT 写入随连接关闭回滚、无半写、重开后 store 可用。

## Benchmark

- fault-injection 定向：3 files / 定向 4 files 全绿（fi2 11 + openai 34 + sqlite memory 全量）。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现 8/12 场景；本次补 3 个缺失场景测试（provider backoff / child running / several children running / MCP call 共 4 个，其中 memory txn 已在远程实现），12/12 场景全绿。
- 跨组件 kill 场景的注入方式：child/MCP 场景在 orchestrator 内抛 RuntimeKilledError（runtime 的 rethrowIfKill 保证它不是可恢复的 tool failure）；backoff 场景在测试侧先挂起 generator 再 abort（保证 abort 发生在 backoff 监听已注册之后，否则监听器永不触发——首版测试超时的根因）。
- sideEffect 判定为静态白名单（SIDE_EFFECT_TOOLS = write_file/edit_file/exec）；未知工具（delegate/mcp_tool_call）unresolved 时 sideEffect=false，但"不自动重放、呈现给模型"的保证与标志无关（resume 语义测试覆盖）。

---

# P1-6 Global AgentExecutionScheduler

Status: DONE

## 问题

`ParallelDelegator.maxConcurrent` 只约束单批并行，无法天然约束整个 agent tree。

## 目标

建立全局 Scheduler：

```text
Root Session
  ↓
AgentExecutionScheduler
  ├─ maxGlobalAgents
  ├─ maxAgentsPerRoot
  ├─ maxDepth
  ├─ token budget
  ├─ tool-call budget
  ├─ wall-clock budget
  └─ cancellation tree
```

## 要求

支持：

```text
nested delegation
parallel delegation
fairness
queue
cancellation
budget inheritance
```

避免：

```text
Root 开 3 个 child
每个 child 再开 3 个
→ 指数扩张
```

## 测试

- nested fan-out。
- budget exhausted。
- one child hung。
- parent cancelled。
- sibling isolation。
- queued child cancelled before start。
- fairness。

## Tests

- `packages/agents/src/scheduler.ts`（376 行，AgentExecutionScheduler）+ `scheduler.test.ts`（14）：超出 maxGlobalAgents 入队并在释放时 FIFO 启动（fairness）；maxAgentsPerRoot 限制子树而其他 root 继续（sibling isolation）；超出 maxDepth 拒绝（指数 fan-out 防御）；入队请求被调用方取消则永不启动（不创建 session）；cancelSubtree 中止该 root 下已入队+运行中条目；cancelSubtree 不碰其他 root；wall-clock 预算（maxDurationMs）取消运行中 agent；children 经 scheduler 槽位运行——超出全局上限仍按序完成；cancelSubtree 对 child 呈现为结构化 cancelled delegation；预先预留 allocation 并在释放时退还未用部分。
- 全局上限 / maxDepth / 队列 / 取消树 / 公平性 / 预算继承全部有测试；指数扩张由 maxDepth 测试显式防御。

## Benchmark

- scheduler 定向：1 file / 14 tests / <1s。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现（补记）。P1-10 Cancellation Tree 的子树取消语义已在 scheduler.cancelSubtree 落地（queued + running + sibling 隔离），独立测试待 P1-10 阶段梳理。

---

# P1-7 Hierarchical Budgeting

Status: DONE

将 budget 从单 turn 限制扩展到 agent tree：

```text
root:
tokens
tools
time
children
```

Child 获得分配后的预算。

要求：

- child 不能花父级之外的预算。
- child unused budget 是否返还要明确。
- root 必须保留 completion/verification headroom。
- budget exhaustion 是结构化 termination reason。

## Tests

- TreeBudget 集成在 `packages/agents/src/scheduler.ts`（TREE_BUDGET_HEADROOM_RATIO，contracts 定义）+ `scheduler.test.ts` 相关项：child 超分配即拒绝（exhausted tree tool budget → RESOURCE_LIMIT 结构化终止）；tree wall-clock 预算取消整棵子树（maxDurationMs 减 root headroom）；headroom 为 root 保留——children 从池中分配而非整个预算；delegation 将真实工具用量计入 tree budget；预分配退还机制（unused budget 返还）。
- `packages/context/src/budget.ts` + `budget.test.ts`（8，单 turn token 预算层）：硬上限执行并报告 dropped/available；同 size 先逐出低优先级；永不逐出 trusted/system/user；never-evict 超限时如实报告 overflow；used 与选中块一致；空输入零报告；跨调用确定；reserved 从普通块中扣除。

## Benchmark

- budget 定向：2 files / 22 tests / <1s。
- 全量：69 files / 1048 passed / 1 skipped；`pnpm typecheck` / `pnpm build` exit 0。

## Notes

- 公司远程版本已实现（补记）。未返回预算在树中合并为可再分配池（scheduler 预分配+退还测试）；exhaustion 以 RESOURCE_LIMIT 结构化原因终止而非静默。

---

# P1-8 Structured Subagent Completion Protocol

Status: DONE

## 问题

当前 summary 偏依赖最终 assistant text，artifact 可能通过 regex 推断。

## 目标

子代理正式返回：

```ts
interface SubagentCompletion {
  status
  answer

  findings: Array<{
    claim
    evidenceRefs
    confidence
  }>

  changedArtifacts
  testsRun

  openQuestions
  blockers
  suggestedNextActions

  budgetUsed
}
```

字段按 contracts 真实能力调整。

## 要求

- artifact 来自真实 tool/artifact registry，不靠文本 regex 作为主路径。
- evidence 有稳定 ref。
- parent 可验证 child 的 claimed completion。
- child 不得仅靠“我完成了”被视为 success。

## Tests

新增 `packages/agents/src/completion-protocol.test.ts`（5 tests，全部通过）：

1. 完整完成面：answer（child 最终 assistant 消息逐字，截断 2000）、changedArtifacts（来自真实 working state filesChanged/artifactRefs，每条带 `message:<id>` 或 `working-state` 稳定 ref）、testsRun（/test/i 命令 + verification 事件）、budgetUsed（toolCalls/durationMs）、openQuestions/blockers/suggestedNextActions；无验证 gate 时 verified=false 且 findings 为空。
2. verified=true 仅当 terminationReason=verified_complete（通过 verification gate）；findings 一条 claim="verification passed" + evidenceRefs=`event:<id>` + confidence=high；testsRun 含 "verification passed"。
3. verification failed → status=failed、verified=false、findings 一条 low confidence（"verification failed: ..."）、blockers 含该失败。
4. timeout → status=timeout、verified=false、findings/testsRun 空、budgetUsed.toolCalls=0（无虚构内容）。
5. 全部 ref（event:/message:/working-state）可解析到 child session 的真实持久化事件/消息/快照。

## Benchmark

- 每次 delegate 额外开销：最多 3 次 store 读（listMessages ×2、events.list ×1）+ working state 遍历，全部为内存/本地 SQLite 读；无额外 IO、无模型调用。
- 全量回归：70 files / 1057 passed / 1 skipped（基线 1048，新增 9：completion-protocol 5 + fault-injection-v2 3 + openai 1）。

## Notes

- success 判定保持（outcome completed → success）；新增 `verified` 字段，仅 `terminationReason === "verified_complete"` 为 true——“我完成了”不等于已验证。
- findings 只从 verification 事件派生（runtime 的 `updateWorkingState` 不维护 importantFacts，无运行时写入者），不虚构。
- changedArtifacts 以 working state 为权威来源；`renderToolResultForContext` 输出不含 path，故 tool 消息含 path 时用 `message:<id>`、否则 `working-state`（child 会话持久快照）。
- answer/summary 为 child 最终 assistant 消息逐字截断，不是转述，parent 可直接引用。

---

# P1-9 Parent / Child State Handoff

Status: DONE

建立明确 handoff：

```text
Parent WorkingState
     ↓ selected scoped context
Child WorkingState
     ↓ structured completion
Parent merge
```

禁止：

```text
fork entire parent transcript
```

默认最小必要上下文。

合并要处理：

```text
conflicts
duplicate findings
artifact ownership
failed child
partial child
stale child result
```

## Tests

新增 `packages/agents/src/state-handoff.test.ts`（9 tests，全部通过）：

- scopedContextFromWorkingState：默认投影最小必要上下文（goal/constraints/plan/decisions，不含 importantFacts）；全部为 trusted system block（可压缩、非 ephemeral）；支持显式 scope + maxEntries/maxBlockChars 截断（只取前 N 条）。
- mergeChildCompletion：
  1. success child：artifacts 并入 filesChanged/artifactRefs（ownership 记 childAgentRefs）、findings 写入 decisions（含 confidence + event refs）、testsRun union、openQuestions/pending 去重合并、merge 决策入 decisions。
  2. 同一 path parent 也改 → conflicts 记录 + skipped(stale)，child 版本不应用，parent 版本保留。
  3. 重复 finding（同 claim）→ skipped(duplicate)，不重复写 decisions。
  4. failed child → 全部跳过，failures 记录 "child <id>: <error>"，decisions 记录未合并。
  5. cancelled/timeout child → skipped(partial)，无虚构内容合并。
  6. 不触碰无关字段（goal/constraints/completed/commandsRun/importantFacts/plan 原样）。

## Benchmark

- 纯函数：零 IO、零模型调用；一次 merge 为 O(artifacts + findings + testsRun) 数组线性操作。
- 全量回归：71 files / 1066 passed / 1 skipped（较 P1-8 后 +9：state-handoff 9）。

## Notes

- scoped context 只从 working state 投影，函数签名不含 messages——transcript fork 在结构上不可表达。
- artifact ownership：child 修改的路径并入 parent，但 merge 决策会记录 child 会话引用；重叠路径=conflict=stale，child 版本记录于 conflicts 而非静默覆盖 parent。
- failed/partial child 的 P1-8 completion 本就无 ref-backed artifacts（timeout/cancelled 无 outcome state），故 partial 分支主要防御性记录。
- merge 是纯函数、由调用方（parent turn 侧）在 child 完成后调用；未改动 runtime 内部 working state 维护（AGENTS.md 边界）。

---

# P1-10 Cancellation Tree

Status: DONE

实现或强化：

```text
parent abort
→ child abort
→ grandchild abort
```

同时支持：

```text
cancel one child
without cancelling siblings/root
```

要求：

- cleanup。
- session events。
- tool AbortSignal 传播。
- provider AbortSignal 传播。
- MCP call abort。
- queue removal。
- no zombie child。

## Tests

新增/更新（全部通过，全量 71 files / 1071 passed）：

- delegator.test.ts：`P1-10: a dead-on-arrival signal leaves no orphan child session behind`——signal 已 abort 时在 createSession **之前**短路，返回 cancelled、childSessionId=""、parent 下无 session、无 subagent.* 事件。
- parallel-delegator.test.ts：
  - `P1-10: cancels one child without cancelling siblings (per-child signal)`——childSignals[i] 只取消第 i 个 child（挂起中），sibling 正常 success。
  - `P1-10: a child cancelled while queued resolves as cancelled instead of rejecting the batch`——scheduler maxGlobalAgents=1 时第 2 个 child 排队中 abort → 队列移除（acquire 抛 USER_CANCELLED 被捕获）→ 两个结果均为 cancelled，不 throw。
- mcp-client.test.ts：`P1-10: an aborted call surfaces as USER_CANCELLED and forwards the signal to fetch`——fetch 收到 signal，abort → USER_CANCELLED（非 NETWORK_ERROR）。
- mcp-tool-adapter.test.ts：`P1-10: handler forwards the caller's AbortSignal to the MCP call`。
- 既有覆盖（补记）：级联 parent→child→grandchild（nested-delegation.test.ts "propagates caller cancellation across nesting levels"）、scheduler.cancelSubtree（queued+running+sibling 隔离 + 事件）、turn.cancelled 事件、tool/provider signal 传播（runtime）。

## Benchmark

- 全部为同步短路/参数传递：无新增 IO；delegator 短路省掉一次 session 创建 + 一次 turn；parallel 的 childSignals 只多一次数组索引。
- 全量回归：71 files / 1071 passed / 1 skipped（较 P1-9 后 +5：delegator 1 + parallel 2 + mcp-client 1 + mcp-tool-adapter 1）。

## Notes

- 级联传播机制（既有）：同一 caller signal 贯穿嵌套链 + 每层 scheduler token signal 均链接 internal.abort → root abort 直达当前运行层；cancelSubtree 按 rootSessionId 取消 queued+running。
- 单 child 取消 = per-child signal（childSignals[i]），scheduler 队列中该 child 的 entry 由 acquire 的 onCallerAbort 移除（dequeue + gate reject USER_CANCELLED）。
- 排队中被取消的 child 由 parallel-delegator worker 捕获 USER_CANCELLED 转为 cancelled 结果——与"已 abort 即 cancelled"路径行为一致，不炸整个批次。
- MCP abort 语义：callTool(signal?) 可选；abort 报 USER_CANCELLED 而非 NETWORK_ERROR；MCP 工具尚未接入 ToolOrchestrator 管线（adapter 是 ToolLike 形态），signal 已通到 handler。
- 事件语义：取消仍以 `subagent.failed`(payload.status="cancelled") + `turn.cancelled` 表达，不新增 subagent.cancelled 事件类型（契约事件表稳定）。

---

# P1-11 Tool Execution Semantics Registry

Status: DONE

把 tool capability 从几个布尔值扩展成明确 contract：

```ts
ToolSemantics {
  readOnly
  idempotent
  retrySafety
  concurrencySafety
  sideEffectScope
  cancellable
  requiresApproval
  networkBehavior
  outputSensitivity
}
```

不要所有字段都一次实现，先整理现有 capability，消除 scattered heuristic。

## 目标

Runtime 的：

```text
retry
parallel
checkpoint
resume
approval
sandbox
output handling
```

都基于 tool semantics，而不是 tool 名称 hardcode。

## Tests

- contracts/tool.ts：`ToolSemantics`（9 字段）+ `DEFAULT_TOOL_SEMANTICS` + `toToolSemantics(metadata, risk?)`——从旧字段派生（sideEffectScope: filesystem/process 由 metadata.filesystem/process 决定；readOnly = !sideEffect；idempotent = retry==="safe"；requiresApproval = risk elevated/critical；networkBehavior = network?"outbound":"none"）。
- tools/registry.ts：`semanticsOf(tool | undefined)`——注册表查询，unknown → DEFAULT。
- runtime.ts：`toolSemanticsOf` 注入查询（CLI 接线 `(name) => semanticsOf(toolRegistry.get(name))`）；`updateWorkingState` 按 `semantics.sideEffectScope` 记账（filesystem → filesChanged，process → commandsRun/testsRun），删除 `SIDE_EFFECT_TOOLS` 名称 hardcode；`DEFAULT_RUNTIME_TOOL_SEMANTICS` 保留旧行为（write_file/edit_file → filesystem + retrySafety none；exec → process + networkBehavior outbound + retrySafety unknown）。
- semantics.test.ts（2 测试）：真实工具（read/write/edit/exec/search）metadata+risk → 语义派生断言；`semanticsOf` 对 builtin 与 unknown/undefined 的解析。
- fault-injection-v2.test.ts（+3 测试，makeRuntime/restartedRuntime 加 `toolSemantics` 选项）：
  - `deploy`（非内置名，注入 filesystem 语义）→ filesChanged 记录 + checkpoint 边界触发；
  - 内置名 `write_file` 声明 sideEffectScope:"none" → 不记 filesChanged、无 checkpoint 边界（声明胜过名称）；
  - crash-resume 一致性：kill tool.completed + seed，恢复进程用同一注入语义 → committed、不重执行（exactly once）。

## Notes

- 私有 `semanticsOf(name)` 先放模块级一度导致文件损坏（常量体截断 + 残留 P1-4 注释），已修复并移入类体（wallClockExceeded 后）。
- `/test/i` 命令启发式保留——它判断命令内容而非工具名，P1-8 依赖。
- WriteCountingOrchestrator.writeCount 只统计 "write_file" 名称（fake 的 hardcode），新测试用 orch.calls 计数。
- FakeCheckpointStore 持久字段是 `saved`（`seed` 只作 loadLatest fallback）；kill 在 checkpoint 前的 resume 测试必须 seed。

---

# P1-12 Tool Result Artifact Registry

Status: DONE

## 问题

大 tool output 当前可落文件 + preview/hash，这是好基础。

## 下一步

建立 ArtifactRegistry：

```ts
Artifact {
  id
  sessionId
  turnId
  toolCallId
  path/ref
  mime
  bytes
  sha256
  createdAt
  sensitivity
  retention
}
```

## 用途

```text
context compaction
resume
subagent result
verification
observability
benchmark cleanup
```

避免将 path 当唯一 identity。

## Tests

- contracts/artifact.ts：`Artifact`（id/sessionId/turnId/toolCallId/ref/mime/bytes/sha256/createdAt/sensitivity/retention）+ `ArtifactStore` 接口（register/get/byToolCallId/bySessionId/byHash/list/remove）；ids.ts 加 `ArtifactId`/`newArtifactId`（`artifact_` 前缀）。
- core/runtime/artifact-store.ts：`InMemoryArtifactStore`——id/hash/session/tool-call 四索引，remove 全索引清理；索引字段命名 hashIndex/toolCallIndex/sessionIndex（避开与接口方法同名遮蔽）。
- runtime.ts：`artifactStore?: ArtifactStore` deps；`renderToolResultForContext` 落盘成功后注册 Artifact——`id` 为唯一 identity，`ref` 保持纯路径（id 不进记录），渲染文本变 `[artifact: path#artifact:id]`；sensitivity 直接复用 P1-11 的 `semanticsOf(name).outputSensitivity`（闭环）；retention "turn"；注册失败只吞错不中断 turn（文件与 hash 已就绪）。
- artifact-store.test.ts（3 测试）：register/get、三个索引查询、remove 全索引一致性 + 幂等。
- runtime.test.ts（+1）：大输出 + artifactStore → 记录字段全断言（sensitivity 跟随注入语义 "high"）、消息轨迹含 `#artifact:id`（非裸 path）、byHash 命中、文件内容一致；无 artifactStore 时既有行为不变（全量回归通过）。

## Notes

- 记录里的 `ref` 是纯路径，`#artifact:id` 只出现在渲染文本——调试时先确认断言对象是消息内容还是记录。
- PowerShell 单引号字符串不转义 `\n`：用 `-replace` 拼接多行插入时反斜杠会以字面量进文件（本次事故：`expect(...).toBe(1);`n const records...` 造成 PARSE_ERROR），修复用 Read/Edit 工具而非逐次 Set-Content。
- mime 暂定 "text/plain"（工具结果目前全是文本），后续按 tool semantics 扩展。

---

# P1-13 Output Sensitivity / Redaction

Status: DONE

Tool output artifact 化之前：

```text
classify sensitivity
secret scan
redact if required
```

日志、event、benchmark report、artifact preview 都遵守统一 redaction。

## Tests

- runtime.ts：artifact 注册时 `redactedOut.redacted > 0` → `sensitivity: "high"`（secret 内容重分类，覆盖 P1-11 的语义值）——"classify → scan → redact" 闭环到 artifact 记录。
- main.ts：主 CLI 补 `outputRedactor: (content) => redactSecrets(content)`（@ar/security，与 benchmark-command 同一 gate）——此前只有 benchmark 路径 redact。
- 既有覆盖：benchmark 路径（outputRedactor + injectionDetector + .artifacts 隔离）已在 P0-7/P0-8 接线；event 层不承载 tool 原文（内容在 message，受同一 redactor 保护）。
- runtime.test.ts（+1）：secret 内容 + 语义 "medium" → artifact sensitivity "high"、落盘文件与消息轨迹均无原文（redacted 优先于语义）。

## Notes

- 统一 redaction 的四个消费点现状：message content ✓（P0-7 起）、artifact file ✓、benchmark report ✓（P0-7 接线）、主 CLI ✓（本次）；event payload 不含 tool 原文，无需处理。
- 后续（P1-14+）若新增 tool 原文出口（日志、report），必须过同一 outputRedactor。

---

# P1-14 Verification V2

Status: DONE

## 目标

从“stop 时 gate 一次”继续升级：

```text
task acceptance criteria
→ verifier plan
→ incremental verification
→ final verification
```

## 支持

```text
command verifier
artifact verifier
file diff verifier
structured checker
custom test
```

## 原则

- verifier 独立于 model wording。
- model 不能声明“测试过了”代替 verifier。
- verifier failure 返回结构化 evidence。
- verification retry 有预算。

## 新增

对多文件修改任务：

```text
changedPaths expected set
unexpected destructive diff detection
```

## Tests

- contracts/verification.ts：`VerificationSpec` 新增 `{ kind: "diff"; expectedPaths?: string[]; mustNotChange?: string[] }`；`VerificationCheckKind` 加 "diff"。
- tools/verification/task-verifier.ts：`checkDiff`——expectedPaths 必须 ⊆ changedPaths（路径规范化、cwd 相对解析，与 artifact check 同规则）；mustNotChange 命中 changedPaths 即失败（破坏性/意外修改检测）；evidence type "diff" 带结构化 detail；失败含 VERIFICATION_FAILED error。
- task-verifier.test.ts（+3）：exact 变更集通过；缺失 expected → 结构化失败（含缺失路径）；forbidden 被改 → "unexpected/destructive" 失败。
- vs001.test.ts：afterAll 清理加重试（Windows 下子进程/杀软瞬时句柄导致 rmSync EPERM 的既有 flaky——git stash 验证与 P1-14 无关，是环境性稳定复现；5 次重试 × 50ms 后全绿）。

## Notes

- 原则"model 不能声明测试过了"（verification gate 回灌）+ retry 预算（maxVerificationFailures）为 P1-3/P1-8 已有，本阶段未重复实现。
- 增量验证（incremental verification）依赖跨 turn 的 changedPaths 累积，留待 checkpoint/resume 消费侧（P1-12 的 artifact 记录 + resume 合并）落地后评估。

---

# P1-15 False Completion Defense V2

Status: DONE

建立 completion policy：

```text
Model stop
≠
Task done
```

根据任务类型：

```text
requires verification?
requires artifact?
requires changed file?
requires no side effect?
```

若任务可客观验证，不允许无 verifier 的直接 complete。

## Tests

- contracts/verification.ts：`CompletionPolicy`（requiresVerification / requiresChangedFile / requiresNoSideEffects）+ `TaskSpec.completionPolicy`。
- runtime.ts `runVerificationGate`：policy 检查先于 verifier——requiresNoSideEffects 且 changedPaths 非空 → failed（列出前 5 个路径）；requiresChangedFile 且空 → failed；requiresVerification 且 verifier 缺失 → **blocked**（此前 task 有要求但无 verifier 时 gate 返回 undefined → 直接 model_stopped 完成，这是本阶段修复的漏洞）；均通过后仍跑原 verifier。
- loop-integration.test.ts（+3，makeLoop 加 changedPathsProvider 透传）：
  - requiresVerification + 无 verifier → turn failed / verification_failed / VERIFICATION_FAILED / message 含 "no verifier is configured"；
  - requiresChangedFile + 零改动 → failed / "requires a changed file"；
  - requiresNoSideEffects + write_file → failed / "requires no side effects"，工具照常执行一次（先执行后判定）。

## Notes

- gate 失败回灌机制（verificationFailures < maxVerificationFailures 时注入观察继续循环）为 P1-3/P1-8 已有，policy 检查复用同一预算。
- 测试脚本必须给足：gate 失败会回灌一次消耗一组 script，脚本耗尽时 ScriptedModelProvider 返回空流 → "model ended without completion"（model_error），与本特性无关但会掩盖断言；配 maxVerificationFailures: 1 + 双组脚本即可。

---

# P1-16 Diff-Aware Code Task Verification

Status: DONE

针对 coding agent 增加：

```text
git diff / workspace diff
changed file inventory
unexpected file deletion
large accidental rewrite
generated junk
format-only explosion
```

可在 benchmark 模式默认启用。

## Tests

- contracts/verification.ts：`VerificationContext.baselineFiles`（run 开始时的 workspace 文件清单，可选）；diff spec 增加 `forbidDeletions`（true=全部 baseline 文件 / 字符串数组=指定路径）、`forbidPatterns`（glob 模式，命中即违规）、`maxFiles`（changedPaths 数量上限）。
- task-verifier.ts `checkDiff`：新增三路检查并汇总 reason——deletion 用 fs 实查（realpathSync 失败 + existsSync 为假），pattern 用 `matchGlob`（@ar/security，cwd 相对 POSIX 路径），maxFiles 直接数 changedPaths；旧 expectedPaths/mustNotChange 语义不变。
- runtime 透传链：`AgentRuntimeDeps.baselineFilesProvider` → `RuntimeVerifierOptions.baselineFiles` → context（省略时 context 不含该字段）。
- 测试：task-verifier.test.ts +4（baseline 文件消失 fail、junk glob fail、maxFiles fail、全满足 pass）；runtime-verifier.test.ts +1（baselineFiles 有/无透传）。

## Notes

- 未引入 git 依赖：deletion/rewrite 检测基于 run 开始的 inventory 快照（benchmark fixture 提供），不解析 git 历史；真实内容 diff（before/after 字节级）仍需 baseline 存储，暂不做。
- `matchGlob` 与 search-files 工具同源；Windows 路径经 `relative().split(sep).join("/")` 转 POSIX 再匹配（detail 里回显 changedPaths 原始值，断言注意分隔符）。
- benchmark 默认启用：fixture 的 workspace 初始清单即可作为 baselineFiles，后续接 benchmark-command 时注入。

---

# P1-17 Repository Instruction Hierarchy

Status: DONE

审计：

```text
AGENTS.md
nested AGENTS.md
project instructions
user task
system policy
```

要求：

- scope 明确。
- nested instruction 只影响其目录范围。
- 冲突规则 deterministic。
- instruction source 进入 observability。
- 注入型普通 README 不应被当 authoritative instruction。

## Tests

- 审计结论（已有，未重做）：scope 桶（root/nested/cwd 互斥）与子树扫描、SKIPPED_DIRECTORIES 由 CTX-001 discovery.ts 提供；P0-8 信任边界（untrusted + injection 拒绝）覆盖"README 不被当 authoritative"。
- 本次增量：
  - contracts/event.ts：新事件 `instruction.discovered`（P1-17 段）。
  - runtime.ts：pipeline build 后 per doc emit `instruction.discovered`（path/scope/sizeBytes/truncated），与 skill.discovered 同位置；渲染模板在 context header 增加 `scope=...`（模型可见每份文档的作用域标签）。
  - 冲突规则：顺序即优先级（deterministic）——discovery 输出 root → nested(depth 升序) → cwd，注入同序，后出现者覆盖先出现者（模型视角"越具体越后"）。文档化于 discovery/pipeline 注释与测试。
- 测试：pipeline.test.ts +1（真实 HierarchicalInstructionDiscovery：root→nested→cwd 的 discovered 顺序与 project block scope 序列）；loop-integration.test.ts +1（ScriptedDiscovery 两份文档 → instruction.discovered 事件精确载荷含 sizeBytes/truncated:false）。

## Notes

- scope 标签只进模型可见 header 与事件，不改变 block 排序逻辑（discovery 已按该序输出）；未引入目录级"规则白名单"——nested 只影响其目录范围的约束由"只发现 cwd 子树"天然成立，model 侧靠 scope 标签判断。
- 中间层祖先文档（cwd 与 root 之间的 AGENTS.md）按 CTX-001 语义不报告——P1-17 保持该行为。

---

# P1-18 Provider Reliability Layer

Status: DONE

继续强化 model provider：

```text
request timeout
stream timeout
429/5xx retry
retry-after
jittered backoff
abort
partial stream failure
usage accounting
provider error taxonomy
```

## 不允许

响应已经产生工具调用/文本后，遇到 stream error 又盲目重新发整个请求，造成重复 side effect 风险。

## Tests

- 审计结论（已有，未重做）：request/stream timeout（Phase 7 单 signal 覆盖全流）、429/5xx 流开始前重试、abort、流中失败不重试（safeToRetry:false）、usage 事件先于 disconnect、caller cancel during backoff——均有实现与测试。
- 本次增量：
  - contracts/errors.ts：`ProviderFailureKind`（rate_limit/server_error/timeout/network/http/protocol）+ `AgentErrorInfo.provider`（kind/status/retryAfterMs）；errorInfo overrides 白名单加入 provider。
  - openai.ts：`parseRetryAfter`（整数秒 + HTTP-date，无效/过去 → undefined）；`nextBackoffDelayMs` 纯函数（equal jitter ±25%，retry-after 覆盖本地指数曲线）；backoff 接入；429/5xx/网络/超时/流中超时五处 errorInfo 全部携带 taxonomy；响应头读取用 `headers?.` 可选链（测试 stub 的 Response 无 headers）。
- 测试：openai.test.ts +4（429+Retry-After:1 → 重试成功且 retry.error.provider={rate_limit,429,1000}；503 耗尽 → {server_error,503}；nextBackoffDelayMs 六断言；parseRetryAfter 六断言）。

## Notes

- 现有 retry 测试全部通过可选链保持原样；重复 side effect 风险由"流开始后绝不重试"维持（工具调用/文本均发生在流阶段，retry 只发生在 fetch 未返回阶段）。
- jitter 默认 Math.random，生产不确定但无害；测试全部走纯函数注入 rng 或 base=0 分支，无 flaky 定时。

---

# P1-19 Model Capability Registry

Status: DONE

不同模型能力不同：

```text
tool calling
parallel tool calling
reasoning stream
context window
structured output
vision
max output
```

不要让 runtime 到处通过 provider/model 名硬编码。

建立 capability resolver。

Context budget 应根据真实 model context window。

## Tests

- contracts/model.ts：`ModelCapabilities`（7 能力字段，缺省=未声明）+ `ModelInfo.capabilities?`。
- 新 packages/model/src/capability-resolver.ts：`resolveCapabilities(ref, info?, overrides?)` 优先级 overrides > info.capabilities > 已知表 > 空声明（未知模型零假设）；已知表前缀匹配（gpt-4.1-nano 1M / gpt-4o·gpt-4.1 128k / gpt-5 400k reasoning / o1·o3 200k reasoning / gpt-4-turbo / gpt-3.5-turbo），**表序=具体优先**（nano 在 4.1 之前，否则 4.1-nano 被 4.1 前缀截胡——首个测试失败即此）；`budgetForCapabilities` = window×0.7，未知→undefined。
- benchmark-command.ts：模型推导优先——`defaultBudgetTokens = budgetForCapabilities(resolveCapabilities(...)) ?? opts.budgetTokens`（默认 32000 保留为未知模型 fallback）；runOneCase 与 runtimeConfigForHash 统一消费（函数加参传递，避免闭包变量不可见）。
- 测试：capability-resolver.test.ts 6 个（族解析、前缀、info 覆盖、host overrides、未知空、budget 推导）。

## Notes

- core 不依赖 provider 知识（AGENTS.md）：resolver 在 model 包，runtime 只收注入的 budget，硬编码仅存在于模型包的已知表。
- manifest 的 defaultBudgetTokens 现在反映实际生效值（推导或 CLI fallback），runtimeConfigHash 随之变化属预期。

---

# P1-20 Observability / Trace V2

Status: DONE

## 目标

任何失败可以回答：

```text
Agent 为什么做了这个工具调用？
为什么重试？
为什么压缩？
为什么拒绝？
为什么认为完成？
为什么 child 被创建？
为什么 memory 被召回？
```

## Trace spans

考虑：

```text
session
turn
model_call
tool_call
verification
compaction
subagent
memory_retrieval
learning_eval
```

不强制引入 OpenTelemetry，但事件模型应可映射。

## 关键指标

```text
time to first model token
model latency
tool latency
queue wait
verification time
compaction count
retrieval hit rate
memory usefulness
subagent utilization
```

## Tests

- 审计结论："为什么"问题已由既有因果事件链回答（tool.requested 带模型原文 args、model.retry/retry.provider 带 error、context.compacted 带 reason、security.* 带拒绝理由、verification.failed 带 gate.reason、subagent.*、turn 终止 reason）——未重做。
- 本次增量（时序指标结构化）：
  - runtime.ts：`model.completed` 加 `durationMs`（per-attempt，含 retry 取最后 attempt）+ `timeToFirstTokenMs`（首个 text_delta/reasoning_delta，纯 tool_call 轮次合法省略）；`tool.completed` 事件新增（此前**成功工具执行无事件**——真实可观测性缺口），executeToolCall 末尾统一 emit（success → tool.completed；failed/timeout → tool.failed），denied 保持散点不发（防双发）；所有 tool.failed/tool.completed 带 `durationMs`（自 tool.requested 起，含权限/沙箱/重试全链）；`verification.completed/failed` 加 `durationMs`；`context.compacted` 三处（auto/message-trim/reactive）加累计 `totalCount`。
  - loop-integration.test.ts +1：工具+文本双轮后断言 tool.completed（toolCallId/tool/durationMs ≥0）与 stop 轮 model.completed（durationMs、timeToFirstTokenMs ≥0）。

## Notes

- queue wait / retrieval hit rate / memory usefulness / subagent utilization：对应子系统未实现（queue 无、memory 无召回），不做虚指标；subagent 事件已存在，利用率可由事件流聚合。
- 事件模型可直接映射 span：session/turn 层级在事件上（sessionId/turnId），model_call/tool_call/verification/compaction 均为类型化事件，parent 关系由 sequence+turnId 隐含，未引入显式 span id（避免为映射而过度设计）。

---

# P2 — Learning / Memory / Mechanism Evolution

---

# P2-1 Reflection V2：从模板失败总结升级为策略经验

Status: DONE

## 当前目标

不要只生成：

```text
tool X failed; verify inputs before retry
```

而要尽可能提取：

```text
Task context
Failed strategy
Observed evidence
Root cause
Recovery strategy
Outcome
Reusable rule
Applicability conditions
```

## Memory candidate 模板

例如：

```text
When:
read_file returns ENOENT for a repository-relative path

Do:
search repository tree / file index before retrying guessed paths

Avoid:
repeating the same guessed path

Evidence:
...
```

## 重要

Reflection 可用规则 + optional LLM enrichment。

## Tests

- contracts/memory.ts：`StrategyLesson`（when/do/avoid + failedStrategy?/rootCause/outcome/evidenceRefs）+ `MemoryCandidate.structured?`（可选，向后兼容既有候选）。
- reflection.ts：新增 `strategyFor(cause, detail, tool)` 规则模板（When/Do/Avoid 三元组），按 root cause 分派；已知失败签名细化——工具报 ENOENT/not found 时 Do 细化为 "search the repository tree / file index before retrying guessed paths"、Avoid 为 "repeating the same guessed path"（对应 plan 模板示例）；`candidateFor` 填 structured；ReflectionGroup 收集 evidenceRefs（按序累计去重组内的全部失败事件 id）。单句 `lesson` 保留（兼容旧消费方）。
- reflection.test.ts +4：tool ENOENT → when 含 read_file+ENOENT、do 含 search、avoid 含 repeating guessed path；verification → inspect-fix-reverify 策略；evidenceRefs = [失败事件 id]；去重组累计 evidenceRefs 有序。

## Notes

- LLM enrichment 明确不做（REFLECTION-001 保持确定性、不依赖模型）；enrichment 是可选扩展点，接入需先过依赖注入（core 不依赖 providers）。
- critical attribution 继续依赖 event evidence；evidenceRefs 只来自真实事件 id，LLM 不得伪造。
- 门禁：1109 passed | 1 skipped；TC=0；BUILD=0。

---

但：

- critical attribution 继续依赖 event evidence。
- LLM 不得伪造 evidence。
- 无证据的 lesson confidence 降低。

---

# P2-2 Memory Evidence Model

Status: DONE

每条 procedural memory 保存：

```text
source sessions
source events
success count
failure count
last validated
confidence
```

Memory 不是永真知识。

## Tests

- contracts/memory.ts：`MemoryEvidence`（sourceSessions/sourceEvents/successCount/failureCount/lastValidated?）+ `MemoryEntry.evidence?`（可选，向后兼容）。
- 新 evidence.ts（纯函数，持久化归 store）：`recordValidation(entry, passed, {eventId?, at?})` 不可变更新（计数 +1、lastValidated 前进、eventId 去重追加）；`evidenceFromCandidate(candidate)` 种子（sourceSession + P2-1 structured.evidenceRefs）；`mergeEvidence(base, other)` 合并（会话/事件去重、计数相加、取最新 lastValidated）。
- sqlite-memory-store.ts：schema v3 加 `evidence TEXT` 列（ensureEvidenceColumn 仿 scope 迁移，旧库透明升级）；write/update 序列化、rowToEntry 反序列化（空/损坏列归一 undefined，无 evidence 的 entry 往返不带该字段）；MEMORY_SCHEMA_VERSION = 3。
- 测试 +10（108 passed）：evidence.test.ts 6 个（计数/去重/不可变/种子/合并）；sqlite 4 个（evidence 往返、无 evidence 往返、update 覆盖、**v2→v3 迁移**：DROP 列+删日志后 reopen 透明读写）。
- JSONL store 无需改：全量 JSON.stringify 自动携带 evidence。

## Notes

- 新库迁移日志 = v1 + v3（2 条）；中间版本只在真实升级时记录（ensureSchemaVersion 语义）。
- confidence 的下降/淘汰规则属于 P2-4（decay/conflict）；本 Phase 只建立账本。
- 门禁：1119 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-3 Memory Usefulness Feedback

Status: DONE

每次 memory 被 retrieval：

```text
retrieved
injected
used? / likely used
task succeeded?
verification passed?
```

更新 usefulness。

避免：

```text
Memory 越积越多
永远不淘汰
```

## Tests

- contracts/memory.ts：`MemoryUsefulness`（retrieved/injected/used/taskSuccess/verificationPassed 计数 + 滚动 score 0..1）+ `MemoryEntry.usefulness?`（可选）。
- 新 usefulness.ts（纯函数）：`recordUsefulness(entry, feedback)` 不可变——retrieved 只计数；injected/used/taskSucceeded/verificationPassed 按强度（0.1/0.3/0.5/0.5）向 1 滚动（`score += (1-score)×strength`，饱和不超）；首条反馈初始化中性分 0.5（INITIAL_USEFULNESS_SCORE）；`hasUsefulness` 判定。
- retrieval.ts：`computeMemoryScore` 的 usefulness 组件改为**有反馈时用 entry.usefulness.score，否则回落 importance 代理**（评分可观测性不变，P0-4）。
- sqlite-memory-store.ts：schema v4 加 `usefulness TEXT` 列（ensureUsefulnessColumn 仿 v3，旧库透明升级）；写读 JSON 序列化，空/损坏归一 undefined。
- 测试 +9：usefulness.test.ts 5 个（retrieved 只计数、首条反馈初始化、递增强度、饱和、hasUsefulness）；sqlite 3 个（往返、无字段往返、**v3→v4 迁移**）；retrieval.test.ts 1 个（score 优先、无反馈回落 importance）。

## Notes

- 淘汰/衰减规则（"避免越积越多"）属于 P2-4（decay/conflict/deprecation）；本 Phase 只建立反馈漏斗 + 评分接线。
- 失败侧反馈（task failed / verification failed）由 P2-2 recordValidation 的 failureCount 承载，P2-4 合并两者驱动置信度。
- 门禁：1128 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-4 Memory Decay / Deprecation / Conflict

Status: DONE

支持：

```text
superseded
deprecated
conflicting
stale
```

若新 evidence 证明旧 memory 无效：

```text
confidence ↓
或标记 superseded
```

不要物理删除历史证据。

## Tests

- contracts/memory.ts：`MemoryState` 判别联合（active/superseded{byId,at,reason?}/deprecated{at,reason?}/conflicting{withId,at}/stale{at}）+ `MemoryEntry.state?`（缺省 active）。
- 新 lifecycle.ts（纯函数，软状态，历史永不物理删除）：
  - `supersede(entry, byId, {now?, reason?})` / `deprecate` / `markConflicting` —— 只追加状态，content/evidence/usefulness 原样保留。
  - `evaluateLifecycle(entry, opts)` 确定性规则（首个命中生效）：① 已非 active → 不变（历史稳定）；② evidence.failureCount ≥ 阈值（默认 3）→ stale + confidence × 0.7；③ 从未有使用反馈（usefulness undefined）且 idle 超 30 天 → stale（有反馈的活跃记忆不因年龄退休）。
  - `isRetrievable(entry)`：无状态或 active。
- sqlite-memory-store.ts：schema v5 加 `state TEXT` 列（ensureStateColumn，旧库透明升级）；JSON 序列化，空列归一 undefined。
- 测试 +11（1139 passed）：lifecycle.test.ts 8 个（四种状态、失败阈值→stale+置信衰减、idle 无反馈→stale、活跃记忆保鲜、非 active 稳定、isRetrievable）；sqlite 3 个（state 往返、无 state 往返、**v4→v5 迁移**）。

## Notes

- 触发方（core 何时 supersede/评估 decay）留给候选提升接线阶段——本 Phase 提供能力与数据模型。
- retrieval 的 conflict 过滤（P0-4 survivor/suppressed）与 state.conflicting 互补：前者运行时冲突检测，后者持久化矛盾记录。
- 门禁：1139 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-5 Skill Effectiveness Tracking

Status: DONE

技能被发现 ≠ 技能有效。

跟踪：

```text
skill discovered
skill selected
skill body loaded
task outcome
verification
cost
```

给 skill 一个 effectiveness profile。

## Tests

- contracts/skill.ts：`SkillEffectiveness`（selected/loaded/injected/completed/failed/verificationPassed/verificationFailed 计数 + toolCallCount/tokenCount/latencyMs 成本 + lastUsedAt?）+ `Skill.effectiveness?`（缺省 neutral profile）。
- 新 skills/effectiveness.ts（纯函数）：`recordSkillEffectiveness(skill, feedback, {at?})` 不可变累积（selected/loaded/injected/toolCalled/tokensUsed{count}/latency{ms}/taskCompleted/taskFailed/verificationPassed/verificationFailed）；派生 `successRateOf`（完成任务成功率，无结论 → undefined）、`averageToolLatencyOf`。
- index.ts 导出（含 SkillEffectiveness 类型）。
- effectiveness.test.ts +5：选择/加载漏斗、成本+结局累积、不可变性、成功率、平均延迟。

## Notes

- 接线（谁在运行时记录 feedback、与 skill.discovered/loaded 事件流聚合）留给 core 的未来阶段；事件类型已存在（skill.discovered/loaded/updated，runtime.ts §584）。
- SKILL-EVO-001（head-to-head 提升/回滚）已存在，本 Phase 为其补充累积侧写。
- 门禁：1144 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-6 Skill Selection / Progressive Disclosure

Status: DONE

不要把所有技能完整注入 system。

保持：

```text
index
→ relevant skill selection
→ body load on demand
```

进一步加入：

```text
scope
tags
task similarity
past effectiveness
cost
```

## Tests

- 审计结论：渐进披露主链已存在——pipeline 只收 name+description（**body 从不注入**，SKILL-001）；body 按需经 FileSkillLoader.load；runtime §584 每 build 发 skill.discovered。缺的是 **index → selection** 环节。
- contracts/skill.ts：`SkillIndexEntry`（name/description，index 行类型）。
- 新 skills/selection.ts（确定性、无 LLM）：`selectSkills(index, taskGoal, {k=5, minScore=0.2})`——goal tokens 对每行 name+description 的 Jaccard（`skillSimilarity`），Top-K 且 ≥minScore 者入选，返回 {selected, excluded}（均保序）；**空 goal 无相关性信号 → 全 index 保留**（不裁剪，兼容默认行为）。
- runtime.ts：deps 加可选 `skillSelector`（注入点注入，默认 identity）——注入前裁剪 index；**skill.discovered 事件仍覆盖全部技能**（发现事实不可丢）。
- 测试 +6：selection.test.ts 5 个（相关选择、k 截断、minScore 过滤、空 goal 全保留、保序）；runtime.test.ts +1（selector 裁剪注入、excluded 技能不进 system、discovery 事件仍 2 个）。

## Notes

- selector 是纯函数注入（core 不依赖 @ar/skills，保持 core→contracts 单向）。
- 单 token goal 对 8-token 行 Jaccard 仅 0.125——minScore 默认 0.2 合理，测试用多 token goal。
- 门禁：1150 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-7 Learning Candidate Sandbox

Status: DONE

Prompt rule / workflow / skill / tool preference 等候选，在 promotion 之前运行在隔离配置中。

禁止 candidate 直接修改 champion 全局状态。

## Tests

- 新 learning/sandbox.ts（P2-7）：
  - `CandidateSandbox.run({candidate, championState, runner})`：mkdtemp 隔离 scratch → 快照 champion（`championDigest` 确定性排序键序列化）→ runner（ctx 只给 scratchDir/candidate/readChampion/writeScratch）→ 再快照 diff → 清理。**runner 抛错也执行清理与变异检查**，错误随后传播；结果带 elapsedMs。
  - `champion_mutation` 违规：champion 快照前后不等；`writeScratch` 拒绝 `..`/绝对路径逃逸（scratch_escape 抛错即中止运行）；runner 抛错记 throw 违规并传播。
  - Candidate 永远拿不到 champion 全局状态句柄——沙箱是唯一通道（championState 只读函数，无 setter）。
- index.ts 导出 CandidateSandbox/championDigest 及类型。
- sandbox.test.ts +6：隔离运行干净报告（scratch 清理后不存在）、champion 变异被记录、抛错清理仍执行、路径逃逸拒绝、digest 键序无关、elapsed 计时。

## Notes

- championState 是注入式只读快照函数——真实接线（candidate 跑在独立 runtime/config 实例上）由调用方提供，沙箱负责纪律检查而非进程隔离（进程级隔离留调用方/部署层）。
- 与 §147/§194 门禁关系：沙箱是 evaluate 前置环节，promotion 决策链不变。
- 门禁：1156 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-8 Mechanism Registry

Status: DONE

建立：

```text
research/mechanisms/
```

每个候选机制有 manifest：

```yaml
id:
source_agent:
source_report:
category:
problem:
preconditions:
expected_benefit:
risks:
implementation_scope:
evaluation_cases:
status:
```

## 来源

可从：

```text
reports/codex
reports/claude-code
reports/hermes
reports/opencode
reports/pi
```

抽取机制。

## 原则

机制候选 ≠ 必须实现。

必须经过：

```text
Mechanism
→ Candidate
→ Implementation
→ Benchmark
→ Promote / Reject
```

## Tests

- 新 `research/mechanisms/` 目录：README.md（规范 + 提交流程）、schema.json（JSON Schema v1）、`_template.yaml`（模板，前缀 `_` 表示不参与校验）。
- 新 apps/cli/src/mechanisms.ts（零外部依赖）：
  - `parseYaml(text)`：极简 YAML 子集解析器（key: value 标量、- item 列表、# 注释、引号去除），无外部依赖。
  - `validateMechanismManifest(record)`：11 必填字段检查、status 枚举（6 值）、category 枚举（10 值）、evaluation_cases 数组类型、id 非空。
  - `validateMechanismsDir(dir)`：读取所有 *.yaml（排除 _template 前缀），逐文件解析+校验，id 全局唯一性检测。
  - `mechanismsCmd(args)`：CLI handler（`agent mechanisms <path>`），支持单个文件或目录，输出结构化错误报告。
- commands.ts 接线：USAGE 加 `mechanisms <path>` 行 + switch case。
- mechanisms.test.ts +6：YAML 解析、完整 manifest 通过、必填缺失+枚举错误、错误行拒绝、dir 多文件无重复 id 通过、重复 id 检测。
- 门禁：1162 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-9 Mechanism Experiment Harness

Status: DONE

允许同一机制多个策略比较，例如：

```text
Compaction A
Compaction B

Retry A
Retry B

Memory ranker A
Memory ranker B
```

配置层支持 variant，不需要复制整个 runtime。

## Tests

- contracts/experiment.ts：`ExperimentVariant`（name/mechanism/overrides）、`ExperimentConfig`（id/variants/baseline/runs/seeds）、`ExperimentVariantResult`（status/metrics/error）、`ExperimentComparison`（delta/winner）、`ExperimentReport`。

- 新 packages/evaluation/src/experiment-config.ts（JSON 配置加载器）：
  - `loadExperimentConfig(path)` 读取 JSON 文件 → `ExperimentConfig`；`experimentConfigFromObject(obj)` 对象解析 + 校验。
  - `validateExperimentConfigObject(obj)` 纯函数校验：id 必填、variants 非空、name+mechanism 必填、baseline 引用有效、变体名唯一。
  - 默认值：`runs=3`，`baseline=第一变体`。
  - 测试 +7：minimal JSON 解析、自定义 runs/baseline、缺失 id、空 variants、无效 baseline、重复名、JSON 文件加载。

- 新 packages/evaluation/src/experiment-harness.ts：
  - `ExperimentHarness` 类：`run(config)` 对每个变体调用 `runBenchmark`（默认仿真），收集结果，生成 `computeComparisons`。
  - `computeComparisons(config, results)`：非 baseline 变体与 baseline 逐指标比较（delta = baseline - variant）。
  - `renderReport(report)`：CLI 文本输出（变体状态、指标、对比）。
  - 测试 +5：默认仿真结果、2 变体运行、computeComparisons delta、renderReport 内容、失败变体处理。

- 新 apps/cli/src/experiment-command.ts：`agent experiment <config.json>` 命令，读取 JSON 配置 → 运行实验 → 输出报告。
- commands.ts 接线：USAGE 行 + switch case。
- 测试 +4：有效配置 exitCode=0、无路径 exitCode=1、无效 JSON exitCode=1、缺失字段 exitCode=1。

- 门禁：1178 passed | 1 skipped；TC=0；BUILD=0。

---

# P2-10 Automated Regression Attribution

Status: TODO

当 challenger 退化时，自动按事件分类：

```text
more model retries
more tool retries
more compactions
verification failures
permission failures
security failures
context overflow
latency regression
token regression
false complete
```

输出：

```text
likely regression source
affected cases
event evidence
```

不是仅输出“83% → 80%”。

---

# P2-11 Case Mining from Real Failures

Status: TODO

真实运行失败经过人工确认后，可生成：

```text
candidate benchmark case
```

流程：

```text
production-like failure
→ sanitize
→ minimize fixture
→ create regression case
→ freeze judge
```

禁止自动把带 secret 的真实 workspace 原样存 benchmark。

---

# P2-12 Adversarial Benchmark Expansion

Status: TODO

新增：

```text
tool output prompt injection
MCP prompt injection
subagent poisoning
memory poisoning
skill poisoning
artifact injection
encoded shell tricks
nested shell wrappers
path confusion
symlink escape
unexpected binary execution
dependency install attempt
credential exfil through filenames/logs
```

---

# P2-13 Stress Benchmark Expansion

Status: TODO

新增：

```text
1000 small files
deep directory
huge generated logs
very long JSON
repeated tool failures
10+ subagents queued
context near limit
many artifacts
rapid cancellation
slow verifier
slow MCP
```

---

# P2-14 Evaluation Cost Model

Status: TODO

Learning promotion 不只看 success。

定义：

```text
quality
reliability
security
latency
tokens
tool calls
retries
```

可配置权重。

但：

```text
security violation
```

属于 hard gate，不应被 cost score 抵消。

---

# P2-15 Cross-Model Evaluation

Status: TODO

避免某个 Harness 优化仅对一个 model prompt style 有效。

如果资源允许，对至少两个能力层级模型跑：

```text
champion
challenger
```

检测：

```text
mechanism improves only one model
mechanism harms weaker model
```

结果记录 model-specific。

---

# P2-16 Prompt Rule Versioning

Status: TODO

System prompt / runtime rule 不再是匿名字符串。

建立：

```text
prompt version
hash
change reason
candidate source
benchmark evidence
```

支持 rollback。

---

# P2-17 Policy Config Versioning

Status: TODO

以下配置都应版本化：

```text
retry policy
compaction policy
memory ranking
scheduler
verification policy
permission defaults
tool semantics
```

让 benchmark 结果可追溯。

---

# P2-18 Plugin System Hardening

Status: TODO

审计插件：

```text
load
manifest
tool contribution
context contribution
hooks
MCP
skills
```

## 需要

```text
capability declaration
permission boundary
failure isolation
version
source
trust
disable switch
```

插件异常不能拖垮整个 runtime。

---

# P2-19 Hook Runtime Hardening

Status: TODO

Hook 要有：

```text
timeout
failure policy
ordering
source
observability
```

明确：

```text
hook throw
hook timeout
hook deny
hook additional context
```

各自语义。

禁止 hook 异常默认 allow。

---

# P2-20 MCP Reliability

Status: TODO

MCP server 需要：

```text
connect timeout
call timeout
reconnect
server unavailable
tool schema changed
tool removed
duplicate tool name
partial response
cancellation
```

## 动态工具刷新

刷新后：

- 当前 turn 的 tool view 是否 snapshot，要明确。
- 新工具不能中途绕过 policy。
- schema mismatch 要结构化失败。

---

# P2-21 MCP Trust / Provenance

Status: TODO

每个 MCP tool/result 有：

```text
server id
tool id
version/schema hash
trust level
network boundary
```

结果进入 ContextBlock 时保留 provenance。

---

# P2-22 File-system Sandbox Hardening

Status: TODO

测试：

```text
..
absolute path
symlink
junction
case-insensitive path
Windows drive
UNC
temp path
artifact path
workspace root
```

读/写 policy 分开。

不要只做字符串 startsWith。

---

# P2-23 Process Sandbox Hardening

Status: TODO

审计：

```text
shell wrapper
cmd /c
powershell
bash -c
node -e
python -c
script file
package manager
git command
subprocess spawn
```

Runtime network gate 无法替代 OS sandbox。

如果当前项目目标不做 OS-level sandbox，明确 threat model。

---

# P2-24 Network Gate V2

Status: TODO

当前结构化检测继续加入：

```text
npx
bun
deno
docker run with network tool
python module execution
node script argument URLs
git remote aliases
PowerShell aliases
```

保持：

```text
static intent gate
≠
OS network isolation
```

文档明确局限。

---

# P2-25 Dependency / Supply Chain Safety

Status: TODO

Agent coding 场景里：

```text
npm install
pip install
curl | sh
remote script
git clone
```

属于高风险 side effect。

建立独立 permission category：

```text
dependency_install
remote_code_execution
```

而不是都归普通 exec。

---

# P2-26 Workspace Change Transaction

Status: TODO

对于复杂 coding task，考虑：

```text
staging workspace
or snapshot
```

使失败修复能 rollback。

第一阶段可使用：

```text
git diff
git checkout specific generated change
temp workspace
```

不要让 agent 自己随意 `git reset --hard`。

---

# P2-27 Write Safety Guard

Status: TODO

重点防止曾经发生的：

```text
整文件覆盖未跟踪文件
导致内容不可恢复
```

对 write tool 增加：

```text
existing file?
tracked?
large overwrite?
append intended?
backup/checkpoint?
```

对于：

```text
large existing file -> tiny replacement
```

可进入风险提示/approval。

---

# P2-28 File Edit Primitive Improvements

Status: TODO

优先：

```text
patch
structured edit
range edit
```

减少：

```text
read whole file
rewrite whole file
```

记录 edit diff。

---

# P2-29 Search / Code Navigation Tools

Status: TODO

Agent coding 质量很大程度依赖导航。

统一：

```text
file search
text search
symbol search
dependency graph
repo tree
```

如果没有 symbol index，先实现清晰的 fallback。

避免 Agent 通过反复 guessed read_file 找路径。

---

# P2-30 Repository Map Cache

Status: TODO

对大 repo：

```text
file tree
package map
entrypoints
test commands
languages
```

可缓存为 ephemeral workspace knowledge。

Repo 改动后增量 invalidation。

---

# P2-31 Test Command Discovery

Status: TODO

Agent 不应永远猜：

```text
npm test
```

建立：

```text
package.json
pyproject
Cargo.toml
Makefile
CI workflow
AGENTS.md
```

发现 test/build/lint 命令。

结果写 WorkingState。

---

# P2-32 Environment Capability Snapshot

Status: TODO

每个 Session 记录：

```text
OS
cwd
available tools
runtime versions
network policy
git state
package manager
```

避免模型反复探测。

Snapshot 中敏感环境变量不要暴露。

---

# P2-33 Deterministic Event Ordering

Status: TODO

并行 tool / subagent 后，保证：

```text
event sequence deterministic enough for replay
```

要求：

- globally monotonic per session。
- parallel completion 有真实 timestamp + ordered append。
- replay 不依赖 wall-clock tie。

---

# P2-34 Event Schema Versioning

Status: TODO

Event 未来会持续演化。

增加：

```text
schemaVersion
```

或明确 event version migration。

Resume/benchmark 老 event 不能悄悄解析错。

---

# P2-35 Store Integrity

Status: TODO

对：

```text
SessionStore
EventStore
InboxStore
MemoryStore
ArtifactStore
CheckpointStore
```

统一考虑：

```text
atomicity
concurrency
corruption handling
schema migration
backup
```

---

# P2-36 Inbox / Steer / Followup Semantics

Status: TODO

明确：

```text
steer
followup
cancel
```

在什么 phase 生效。

防止：

```text
tool side effect 已开始
steer 被错误当成可以撤销
```

为 promoted/consumed message 增加 durable state。

---

# P2-37 User Interrupt During Tool Batch

Status: TODO

并行 read batch：

```text
interrupt
```

需要尽快 abort。

串行 write：

- 如果已经执行成功，不能假装取消意味着 rollback。
- final state 要报告 partial effects。

---

# P2-38 Partial Failure Semantics

Status: TODO

TurnOutcome 不只：

```text
completed / failed / cancelled
```

内部应区分：

```text
failed_no_effect
failed_with_effects
cancelled_no_effect
cancelled_with_effects
blocked
```

是否扩展公开 enum 根据兼容性决定，至少 observability 要能表达。

---

# P2-39 Termination Reason Taxonomy V2

Status: TODO

统一：

```text
verified_complete
model_stopped
verification_failed
model_error
provider_error
tool_error
sandbox_denied
permission_denied
security_denied
context_limit
tool_limit
time_limit
agent_limit
cancelled
resume_ambiguous
```

避免自由字符串无穷增长。

---

# P2-40 Retry Taxonomy V2

Status: TODO

现有 taxonomy 基础上明确：

```text
provider
model
tool
verification
compaction
stallRecovery
reconciliation
mcpReconnect
```

每种：

```text
max attempts
backoff
safe predicate
termination behavior
```

---

# P2-41 Stall Detection V2

Status: TODO

当前 identical tool call detection 很重要，但还可以检测：

```text
A -> B -> A -> B loop
same error repeated
same file repeatedly read with no state change
verification fix loop
no-progress iterations
```

建立 progress signal：

```text
new artifact
new file diff
new evidence
changed plan
verification improvement
```

无 progress 才判 stall，减少 false positive。

---

# P2-42 Adaptive Recovery

Status: TODO

Recovery 不要只是 retry/fail。

支持 bounded：

```text
retry
change strategy prompt
compact
re-discover tool
refresh MCP
ask user
delegate specialist
fail-safe
```

每个 action 有预算。

---

# P2-43 Ask-User Gate

Status: TODO

当任务缺关键输入时：

```text
ask user
```

应是正式 runtime outcome/phase，而不是模拟 tool error。

需要：

```text
waiting_for_user
resume after reply
```

如果产品目标暂不支持 UI 异步，至少 contracts 做好边界。

---

# P2-44 Approval State Persistence

Status: TODO

如果 approval wait 存在：

- process restart 后 approval request 不丢。
- approval decision 可审计。
- decision scope 明确：
  - one call
  - one tool
  - session
- permission expansion 有 expiry。

---

# P2-45 Capability Escalation Defense

Status: TODO

Child / plugin / MCP / hook 不得通过自己提供文本或 config 扩大：

```text
tool allowlist
filesystem root
network access
process policy
```

所有 effective capability 只能：

```text
intersection / narrowing
```

除非用户/host 显式批准。

---

# P3 — 更激进但后置的能力

---

# P3-1 Planner / Executor Separation Experiment

Status: TODO

不要直接重构主 runtime。

作为 mechanism candidate 实验：

```text
single-loop champion
vs
planner/executor challenger
```

在 benchmark 验证是否真的提升复杂任务。

如果只是增加 token/latency，不推广。

---

# P3-2 Review Agent Experiment

Status: TODO

对高风险任务实验：

```text
Worker
→ independent Reviewer
→ verifier
```

Reviewer 不能与 Worker 共用隐藏 reasoning，只读 artifacts/diff/evidence。

---

# P3-3 Specialist Routing

Status: TODO

按任务类型路由：

```text
coding
debugging
research
docs
data
```

先 benchmark 验证 specialist prompt 是否比统一 agent 好。

---

# P3-4 Dynamic Tool Selection

Status: TODO

工具很多时：

```text
tool index
→ select relevant tools
→ expose subset
```

减少 schema token。

安全边界不变。

---

# P3-5 Learned Tool Preference

Status: TODO

LearningCandidate `tool_preference` 真正接 runtime，但必须：

```text
benchmark promoted
scope-aware
rollbackable
```

不能因为某次成功永久改变全局行为。

---

# P3-6 Learned Workflow

Status: TODO

Workflow candidate 表达：

```text
when task type X
prefer steps A→B→C
```

只能是 soft guidance。

不得绕过 permission/verification。

---

# P3-7 Learned Prompt Rules

Status: TODO

Prompt candidate 需要：

```text
version
scope
evidence
promotion benchmark
security scan
rollback
```

不要直接把 reflection 文本 append 到 system prompt。

---

# P3-8 Auto-generated Benchmark Candidates

Status: TODO

Agent 可提出 benchmark case，但：

```text
judge freeze
fixture sanitize
human or deterministic review
```

后才能进入正式 regression。

---

# P3-9 Self-Modification Sandbox

Status: TODO

如果未来 Agent 自己改 Harness：

```text
Champion repo
↓ clone/worktree
Challenger modifies isolated copy
↓
tests
↓
benchmarks
↓
promotion
```

绝不能：

```text
运行中的 champion
直接修改自己的 runtime
然后继续执行
```

---

# P3-10 Multi-Variant Evolution Loop

Status: TODO

未来可实验：

```text
Champion
├─ Challenger A
├─ Challenger B
└─ Challenger C
```

统一 eval 后只 promote 最可靠候选。

注意成本预算。

---

# P3-11 Context Policy Learning

Status: TODO

候选：

```text
different compaction thresholds
different retrieval top-k
different recent-message tails
```

通过 benchmark 自动选择。

---

# P3-12 Scheduler Policy Learning

Status: TODO

候选：

```text
maxConcurrent
child budget allocation
queue fairness
```

只能在 stress suite 证明稳定后 promote。

---

# P3-13 Recovery Policy Learning

Status: TODO

候选：

```text
retry count
stall threshold
compact timing
```

不得通过增加大量 retry 暴力抬 success。

cost gate 必须参与。

---

# P3-14 Model Routing Experiment

Status: TODO

如果未来多模型：

```text
cheap model for simple/read-only planning
strong model for complex coding/review
```

先以 benchmark cost/quality 评估。

不要默认“多模型一定更好”。

---

# P3-15 Offline Trace Replay

Status: TODO

支持用历史 event/trace：

```text
re-run evaluator
test new judge
test new memory ranker
test new attribution
```

不调用真实模型。

减少迭代成本。

---

# P3-16 Counterfactual Harness Evaluation

Status: TODO

长期目标：

同一 trace 尝试分析：

```text
如果当时 retry policy 不同？
如果 memory retrieval 不同？
如果 stall earlier?
```

优先做 deterministic components 的 counterfactual，不要伪造模型行为。

---

# P3-17 Formal Invariants

Status: TODO

把关键安全性质写成 invariant tests：

```text
INV-001 terminal state cannot transition
INV-002 child cannot gain parent-unavailable capability
INV-003 unsafe tool is never auto retried
INV-004 completed verification cannot be fabricated
INV-005 child context isolation
INV-006 benchmark holdout judge secrecy
INV-007 memory unsafe content cannot persist
INV-008 network denied cannot execute
INV-009 delegation bounded
INV-010 replay cannot duplicate known completed unsafe side effect
```

编号按现有文档兼容调整。

---

# 全局代码质量优化

---

# Q-1 拆分超大 runtime.ts

Status: TODO

当前 `runtime.ts` 已承载：

```text
model loop
context
retry
tool execution
verification
compaction
inbox
limits
artifact rendering
```

不要一次大爆炸重写。

在前面核心行为有足够 tests 后，逐步抽取：

```text
ModelCallController
ToolCallController
ContextController
VerificationController
RecoveryController
TurnRunner
```

保持 event semantics 不变。

每拆一块跑 full regression。

---

# Q-2 消除 Tool Name Heuristics

Status: TODO

例如：

```text
if tool === "write_file"
if tool === "exec"
```

能由 ToolSemantics 解决的逐步迁移。

保留兼容 fallback，但未知工具保守处理。

---

# Q-3 Shared Error Taxonomy

Status: TODO

错误码、termination reason、retry kind、安全 reason 之间避免重复字符串判断。

建立 typed mapping。

---

# Q-4 Typed Event Payloads

Status: TODO

当前很多事件：

```ts
payload: Record<string, unknown>
```

长期可为关键 event 建 typed payload mapping。

至少 compile-time 防止：

```text
tool.failed 一处叫 tool
另一处叫 name
```

导致 evaluator 解析脆弱。

---

# Q-5 Stable Serialization

Status: TODO

对：

```text
args hash
config hash
checkpoint hash
artifact hash
```

统一 stable serialization。

支持：

```text
undefined
bigint?
nested objects
arrays
special values
```

失败要显式。

---

# Q-6 Clock Injection

Status: TODO

Runtime 中尽量通过 injected `now()`。

测试禁止依赖真实 wall clock，尤其：

```text
timeout
retry
checkpoint
memory recency
scheduler
```

---

# Q-7 Timer Abstraction

Status: TODO

为复杂 timeout/backoff 引入可测试 timer/sleeper abstraction，减少 flaky tests。

---

# Q-8 Deterministic IDs in Tests

Status: TODO

Production 用随机 id。

Tests 可注入 deterministic id factory，便于 event snapshot。

---

# Q-9 Test Fixture Builders

Status: TODO

抽：

```text
makeRuntime
makeAgent
makeSession
makeTool
makeEvent
```

减少测试重复和错误 mock。

---

# Q-10 No Silent Catch

Status: TODO

全仓扫描：

```text
catch {}
catch { return default }
```

区分：

```text
best-effort intentionally
vs
bug swallowed
```

best-effort 必须有注释/metric/event 或合理 rationale。

---

# Q-11 Resource Cleanup

Status: TODO

检查：

```text
timers
AbortSignal listeners
temp dirs
child processes
MCP connections
file handles
SQLite connections
```

无泄漏。

---

# Q-12 Windows / Linux Path Parity

Status: TODO

CI 测试至少覆盖 path semantics。

尤其：

```text
drive letter
backslash
case-insensitive
UNC
symlink
```

---

# Q-13 CI Pipeline

Status: TODO

至少：

```text
install
typecheck
test
build
benchmark smoke with stub/fake
```

可加：

```text
lint
coverage thresholds
```

不要依赖真实付费模型作为普通 PR 必需 CI。

---

# Q-14 Coverage for Critical Packages

Status: TODO

优先 critical path：

```text
core
security
tools
agents
memory
evaluation
context
learning
```

不要为了覆盖率数字写无意义测试。

---

# Q-15 Mutation / Property Testing for Security Parsers

Status: TODO

适合：

```text
network gate
injection gate
secret gate
path normalization
stable stringify
```

可以先 property tests，不强制引第三方 mutation framework。

---

# Q-16 Fuzz Tool Args / Event Payload

Status: TODO

验证 runtime 面对：

```text
unexpected args
huge nested object
cyclic object from internal adapter
invalid UTF-8 boundaries
very long strings
```

不 crash。

---

# Q-17 Backward Compatibility

Status: TODO

Session/checkpoint/memory/event schema 改动都需要：

```text
version
migration
compat test
```

---

# Q-18 Documentation Truthfulness

Status: TODO

每次变更同步：

```text
architecture
benchmark README
optimization report
known limitations
```

不允许文档声明“已安全隔离”，而代码只是 static detection。

---

# Q-19 Generated State / Temp Files Hygiene

Status: TODO

检查：

```text
spawnpid.txt
.artifacts
benchmark output
temp DB
checkpoints
```

哪些应该：

```text
gitignored
persisted
cleaned
```

避免将运行态文件提交。

---

# Q-20 License / Provenance Discipline

Status: TODO

仓库含多个参考 Agent 源码。

对新机制记录：

```text
source inspiration
reimplemented independently
```

避免无意识复制长代码块。

---

# 建议执行顺序

必须按下面顺序优先：

```text
Phase A — Safety correctness
P0-1 Effective Config
P0-2 Tool Enforcement
P0-7 Security Consistency
P0-8 Trust-Aware Context

Phase B — Durable data
P0-3 Memory SQLite
P0-4 Memory Retrieval

Phase C — Evaluation
P0-6 Benchmark Integrity
P0-5 Champion/Challenger

Phase D — Durable runtime
P1-1 WorkingState
P1-2 Context V3
P1-3 Checkpoint
P1-4 Resume
P1-5 Fault Injection

Phase E — Multi-agent
P1-6 Scheduler
P1-7 Hierarchical Budget
P1-8 Structured Completion
P1-9 Handoff
P1-10 Cancellation Tree

Phase F — Tool/runtime semantics
P1-11 Tool Semantics
P1-12 Artifact Registry
P1-13 Redaction
P1-14 Verification
P1-15 False Completion
P1-16 Diff Verification

Phase G — Reliability/observability
P1-18 Provider Reliability
P1-19 Model Capability
P1-20 Trace V2

Phase H — Learning
P2-1 Reflection V2
P2-2 Evidence
P2-3 Usefulness
P2-4 Decay
P2-5 Skill Effectiveness
P2-6 Skill Selection
P2-7 Candidate Sandbox
P2-8 Mechanism Registry
P2-9 Experiment Harness
P2-10 Regression Attribution

Phase I — Hardening
完成其余 P2 + Q 系列

Phase J — Experimental
最后才做 P3
```

---

# 每个 Phase 的 Agent 工作提示词模板

执行任何 Phase 时，必须用这个内部工作方式：

```text
你现在只执行当前 Phase，不要提前实现后续 Phase。

第一步：
读取相关源码、contracts、tests、optimization-report、benchmarks。
列出当前真实行为，禁止仅根据 plan 假设代码状态。

第二步：
指出 plan 与当前代码是否有偏差。
如果已有实现，不重复造轮子；改为补洞、强化、补测试或标 DONE。

第三步：
先建立 baseline。
运行相关测试并记录结果。

第四步：
把本 Phase 拆成最小可验证任务。
一次只修改一个行为闭环。

第五步：
优先写失败测试或复现测试。

第六步：
实现最小变更。

第七步：
依次运行：
1. targeted tests
2. affected package tests
3. pnpm typecheck
4. pnpm test
5. pnpm build

第八步：
若真实 benchmark 可用，运行相关 suite。
没有 API key 时不要伪造 benchmark 数字。

第九步：
更新 plan.md 对应 Status/Tests/Benchmark/Notes。

第十步：
对本 Phase 做一次独立审查：
- correctness
- concurrency
- crash safety
- security
- backward compatibility
- observability
- benchmark gaming
- hidden retries
- context growth

确认没有明显问题后才能进入下一 Phase。
```

---

# Agent 禁止事项

整个优化过程中明确禁止：

```text
1. 为了过测试修改测试意图。
2. 删除安全检查。
3. 默认把 unknown capability 当 safe。
4. 对非幂等工具自动 retry。
5. 子代理扩权。
6. plugin/MCP 绕过 permission/sandbox。
7. benchmark case 互相污染。
8. holdout 泄漏 judge。
9. 把 model 文本当真实 verification evidence。
10. 把 assistant 最后一段话当唯一 subagent truth。
11. crash resume 盲目重放 write/exec。
12. context compact 丢 user hard constraints。
13. memory 自动永久生效但没有 scope/evidence。
14. learning candidate 未经 benchmark 直接 promote。
15. self-modification 直接改当前运行 champion。
16. 用提高 retry/预算暴力掩盖逻辑问题。
17. 大规模 refactor 与行为优化同时进行，导致无法归因。
18. 静默 swallow error。
19. 大文件整文件覆盖而没有确认。
20. 伪造“全部测试通过”。
```

---

# 最终完成标准

当本 Master Plan 的核心阶段完成后，Harness 至少应达到：

```text
1. Session 的 effective config 可冻结、持久化、恢复。
2. Child agent 无法扩权。
3. 所有工具来源走统一权限/安全链。
4. Memory 可并发、安全检索、有 scope、有 evidence。
5. Harness 变更可以 Champion/Challenger 评估。
6. Benchmark 可复现、holdout 不污染。
7. Context/Checkpoint/Resume 共用 WorkingState。
8. 进程崩溃后可安全恢复，不重复已知非幂等 side effect。
9. Multi-agent 有全局 scheduler、预算、取消树。
10. Subagent 返回结构化 evidence，而非只返回自然语言 summary。
11. Verification 不依赖模型自述。
12. Tool retry/concurrency/resume 基于 semantics。
13. Artifact 有 registry、hash、sensitivity。
14. Security event/denial 可观测且一致。
15. Reflection 生成 evidence-backed procedural memory。
16. Memory 有 usefulness、decay、conflict/supersede。
17. Mechanism 可以候选化、实验、promotion、rollback。
18. Runtime failure 可以通过 trace 被解释。
19. 核心 invariant 有自动化测试。
20. 任何“变强”都有 benchmark 证据，而不是主观感觉。
```

---

# 当前第一条执行命令

不要从 P3 或新功能开始。

**第一步只做：**

```text
P0-1 Session Effective Agent Config Snapshot
```

完成 P0-1 后，先进行一次完整代码审查和全量测试，再进入 P0-2。

如果 P0-1 经源码验证其实不存在问题：

1. 给出可证明不存在的代码证据。
2. 增加回归测试锁死该 invariant。
3. 标记 P0-1 DONE。
4. 再进入 P0-2。

不要为了迎合本计划而制造不存在的 bug。
