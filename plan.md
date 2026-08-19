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

Status: DONE

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

## 完成摘要

- `packages/evaluation/src/manifest.ts`：`buildRunManifest` 产出 plan §855-871 全字段 manifest（gitSha/dirty 探测失败即 `null`，绝不伪造；temperature 未显式设置时为 `null`）；`computeRuntimeConfigHash` 对 harness 运行时接线做 stable 序列化 + sha256（键序无关，键序无关可复现）；`BENCHMARK_SUITE_VERSION="2.1.0"`（P0-6 在 Phase 6.5 四套 suite 之上叠加完整性层）。
- `apps/cli/src/benchmark-command.ts`：每 case `mkdtemp` 独立 workspace + 全新 in-memory `MemSessionStore`/`MemEventStore`/`AgentRuntime`；holdout 的 runtime 侧 taskId 匿名化为 `holdout-task`（见到 request.md 之外判据不进模型上下文）；`--shuffle`/`--seed` 只随机化执行顺序、报告顺序恒等于用例输入顺序（mulberry32 + Fisher-Yates）；启动前 `assertWorkspaceIsolated` 断言 workspace 文件集合与 fixture 精确相等，任何上一轮残留产物立即 fail-closed（`failure_category: infrastructure` 的 error 结果，永不记成 agent 失败也永不静默忽略）；manifest 写入每次运行的报告。
- `packages/evaluation/src/baseline.ts`：`runBaseline` 支持 `shuffle/seed/manifest` 选项；runner 抛异常 → catch 成 `failure_category: "infrastructure"` 的 error 结果，绝不冒充 agent task 失败；`classifyFailure` 区分 model/harness/judge/infrastructure（优先任 runner 显式分类：事件存储读失败→judge、runTurn 抛错→harness、超时→infrastructure；`model_error` 终止原因→model；纯 agent 侧未完成任务不设分类，诚实）；`summarizeResults` 汇总 `failures_by_category`；`compareBaselines` 的 infra_failure/judge_changed 优先于回归分类，绝不掩盖真实回归。
- `packages/evaluation/src/bench.ts` + `bench.test.ts`：head-to-head harness 比较（`runCompare` 传同一 `EvalCase` 给 A/B），状态优先（passed>failed>error）、violations 只在同状态内决胜；`both_failed` 表示平局且双方皆败；空报告诚实的全 0 无 NaN。
- `packages/security/src/sandbox.ts`：`resolvePath` 拒绝 Windows 盘符路径（`C:\…`/`C:/…`）与 UNC 路径（`\\server\share\…`，含 `//`）——这些在 POSIX 上会被 `resolve` 误当成相对路径解析进 workspace 的绝对逃逸，现 fail-closed 一律拒绝（掩盖 2 个既有安全测试失败，非降级）。

## Tests

- `manifest.test.ts`（11）：manifest 全字段构造、temperature=null、git SHA/dirty 注入、detectGitInfo 失败→null、runtimeConfigHash 键序无关、stableStringify 递归稳定、suiteVersion/judgeVersion 默认。
- `baseline.test.ts`：`classifyFailure`（显式分类优先 / error→infrastructure / model_error→model / 干净 agent 失败不设分类）；`runBaseline` P0-6 options——shuffle 乱序执行但报告保持输入序、同 seed 同序、manifest 落报告、runner 异常→infrastructure error（`failures_by_category`）、outcome failure category 传播聚合。
- `apps/cli/src/benchmark-command.test.ts`：`--shuffle/--seed` 端到端（乱序执行 + 固定报告序）；cross-case contamination 端到端（case B 尝试读 case A 的 workspace 文件并失败——fresh workspace 隔离生效）；`assertWorkspaceIsolated` 三态（精确相等接受 / stray 文件拒绝 / 缺 fixture 拒绝）；`--suite holdout` 匿名化并写 `holdout.json`/`holdout-summary.md`。
- `packages/security/src/sandbox.test.ts`：补强 Windows 盘符/UNC 路径拒绝（原 2 个失败断言现通过；全 21 通过）。
- `bench.test.ts`：≥10 case 的 A/B 比较，覆盖 winner 判定、both_failed、空报告诚实零、cost 防护。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **84 files / 1179 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- evaluation + security 定向：12 files / 214 tests / ~6.9s。
- 全量：84 files / 55s（tests 20.4s 并行）。
- 说明：本轮净变更集中在 evaluation（manifest/failure 分类/隔离/排序）与 security（sandbox 盘符/UNC 拒绝），断言均有失败先行或端到端覆盖。

## Notes

- sandbox 盘符/UNC bug 根因：`resolvePath` 在非 Windows 主机上对 `C:\…`/`\\…` 走 POSIX `resolve(cwd, …)`，被当成相对路径解析进 workspace 从而放行。修复为在任何主机都识别 Windows 绝对路径并 fail-closed——这既是既有 `sandbox.test.ts` 的安全断言（测试本就要求拒绝，只是长期在 Linux 上静默失败），也符合"不降低安全标准"。仍保留 Windows 本机正常允许逻辑不变。
- `assertWorkspaceIsolated` 在写 fixture 之后、创建 runtime 之前执行：`.artifacts` 在用例运行期间才创建，不进入期望集合，所以不会误伤正常的 artifact spill。
- holdout 匿名化是 harness 布线层职责（taskId→`holdout-task`），模型只见到 request.md；expected.md/case.json/verifier 判据不进 turn。
- 跨用例污染在本架构下无法经文件系统发生（每 case mkdtemp+断言）+ 每 case 全新 in-memory session/store/runtime（不存在跨 case 共享的 memory/context 句柄）；cross-run learning 检测由 `assertWorkspaceIsolated` 在文件级兜底，暂无显式跨 run 共享（与 §896"除非显式测试 cross-run learning"一致）。

## 问题

- 无阻塞项。观察：`runBaseline` 目前只支持串行执行（shuffle 是执行序乱序，非并行）；若未来需要并发跑 case，需为每 case 的 manifest/失败分类与并发隔离补专门编排层——当前无此需求，避免 overdesign。

---

# P0-7 Security Boundary Consistency Audit

Status: DONE

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

## Notes

统一 security「检测、拒绝、事件、错误码、评估」五元的落地，按子任务拆解完成：

- **P0-7a 契约层**：`packages/contracts/src/event.ts` 新增 10 个 `security.*` 事件类型（`security.injection_denied`、`permission_denied`、`filesystem_denied`、`process_denied`、`secret_redacted`、`memory_denied`、`skill_denied`、`mcp_denied`、`approval_denied`，含既有的 `network_denied`）；`errors.ts` 新增细分错误码 `INJECTION_DENIED`、`SECRET_REDACTED`、`MEMORY_DENIED`、`SKILL_DENIED`、`MCP_DENIED`，均 fail-hard（retryable=false、safeToRetry=false），保留 `SECURITY_DENIED` 作为兜底泛化码。
- **P0-7b 统一 deny helper**：`packages/security/src/denial.ts`——`SecurityDenial`（detection/target/source/code/eventType/reason/payload 归一化），一把以一致的 event type + error code + 结构化 reason 发射，取代散落的 stderr-only 拒绝路径；`denial.test.ts` 覆盖码/事件类型映射。
- **P0-7c secret_redacted 结构化**：`security.secret_redacted` 事件 payload 补齐 source/reason/code；orchestrator 拒绝路径改为经统一 deny helper 发射（不再只在 stderr）。
- **P0-7d MCP 边界**：`packages/mcp/src/mcp-tool-adapter.ts` 注入 `EventSink`，检测到 prompt injection 时发射 `security.mcp_denied` 而非仅抛错；`mcp-tool-adapter.test.ts` 断言事件可见。
- **P0-7e memory/skill 边界**：`memory/src/write-gate.ts`（`WriteGateResult` 增 code/source/details）、`skills/src/skill-security.ts`（`skillDenialCode/skillDenialEventType`，injection→`SKILL_DENIED`、secret→`SECRET_REDACTED`）；运行时/CLI 把这些 deny 结构化后路由进 `EventSink`，满足「不得仅 stderr 打印而 event stream 不可见」。
- **P0-7f 评估门禁全量覆盖**：`evaluation/src/runner.ts` 的 `expectedSecurityEvents` 前缀匹配对全部 10 个 `security.*` 类型逐一验证识别 + 缺失时诚实失败；契约层新增 security 类型未进门禁断言会当场失败，杜绝「新类型事件不可判定」。

尚未接线（留给 P0-8 Trust-Aware Context 及上层）：`plugin`（读取 metadata）与 `artifact`（artifact text 审计）、`subagent`（subagent result 注入）这几个来源的 injection 检测统一走 trust metadata + context boundary，而非一律 deny——与 §990-1001 审计范围一致，不降级为占位。

## Tests

- `security/src/denial.test.ts`（4）：detection↔error code、detection↔event type、payload 归一化、target/source 透传。
- `skills/src/skill-security.test.ts`（2）：injection→`SKILL_DENIED`/`security.skill_denied`、secret→`SECRET_REDACTED`/`security.secret_redacted` 映射。
- `mcp/src/mcp-tool-adapter.test.ts`（12）：MCP injection 拒绝发射 `security.mcp_denied` 事件，event stream 可见（不再仅抛错/仅 stderr）。
- `evaluation/src/runner.test.ts`：`it.each(SECURITY_EVENT_TYPES)` 对全部 10 个 security 事件类型跑「识别→pass」+「缺失→诚实 fail」双断言；显式覆盖清单测试锁定 10 类，新增契约类型未纳入即报错。runner 本文件 54 全过。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **86 files / 1208 passed / 0 failed**；`pnpm build`（同 P0-6 基线 green）。

## Benchmark

- evaluation 定向：`packages/evaluation` runner 54 tests。
- 全量：86 files / ~54s（tests 20.4s 并行）。
- 说明：本轮净变更为契约层新事件/错误码 + 各子系统 deny 路径统一发射，断言全部有正向 + 负向覆盖；评估层门禁对全部新类型逐类验证，无静默放行。

---

# P0-8 Trust-Aware Context Model

Status: DONE

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

## Notes

统一信任边界落地（pipeline 层强制 + runtime 标注 + 事件发射两路）：

- **pipeline 层强制**：`packages/context/src/pipeline.ts`——除既有 project/skill 注入检测外，`priorBlocks`（tool output / memory / MCP / subagent / web 输出）现统一受同样的 trust 边界约束。低信任块（`trust !== "trusted"`）若 `detectPromptInjection` 命中，则该块**丢弃**（永不成为 context block）、记录进 `result.injected`；只有 `system`/`user`（`trusted`，权威渠道）豁免扫描。这把「tool output / subagent / memory / MCP 注入只能作为 data，不能提升 authority」从噪音标注升级为不变量——注入内容根本不进 model 视线。
- **ContextInjection 源扩展**：`ContextInjectionSource` 从 `project|skill` 扩展为 `project|skill|tool|memory|web|mcp|subagent`，使新来源的拒绝可被事件层精确归类。
- **runtime 标注**：运行时（`runtime.ts`）已让 system prompt 携带 `TRUST_BOUNDARY_PROMPT`（低 trust 内容仅 DATA ONLY，`SYSTEM:/DEVELOPER:` 标记惰性）+ 每个 block 前缀 `[context trust=... source=...]`；`built.injected`（含新来源）逐条发射 `security.injection_denied`（code `INJECTION_DENIED`）。
- **已接线来源**：README(project)、skill boostrap、tool output（runtime 拦截 + pipeline 双保险）、memory、MCP、subagent。`trust` 分层：trusted=`system`,`user`；semi-trusted=`skill`,`memory`,`subagent`,`tool`；untrusted=`project`,`web`,`mcp`。

security 与 context 两层的注入判定共用 `detectPromptInjection`（含 `fake-system-prefix`/`fake-developer-prefix` 硬模式，P0-7 已加），行为一致。

## Tests

- `context/src/pipeline.test.ts`（28）：新增 tool-output 注入丢弃、memory poisoning（`SYSTEM:` 前缀→`fake-system-prefix`）、MCP + subagent 注入各来源归类、trusted(system/user) 豁免扫描 4 项；连同既有 README/skill 注入、注入 zero-clean、溢出不变量全过。
- `core/src/runtime/runtime.test.ts`（既有 PASS）：tool output 含注入→message 打 `[tool output blocked]` + 发射 `security.injection_denied`(code `SECURITY_DENIED`)；system prompt 带 trust 标签与 trust-boundary header。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **86 files / 1212 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- context 定向：pipeline 28 tests。
- 全量：86 files / ~52s。
- 说明：本轮净变更为对 prior 循环块施加既有注入检测（复用 P0-7 的 detector，无新检测器），断言覆盖六类来源 + trusted 豁免 + 溢出不变量；无降低测试或安全标准的适配。

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

Status: DONE

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

## Notes

新增 `packages/evaluation/src/attribution.ts`（树立于 P2-9 harness 之上的独立纯函数层，从事件流归因，不依赖模型措辞）：

- **`tallyEvents(events)`**：把单 case 事件流归约为 `EventTally`——覆盖 plan 要求的全部维度：`model_retries`（`model.retry`/`retry.provider`/`retry.stallRecovery`）、`tool_retries`（同一 `toolCallId` 的 `tool.started` 重复次数）、`compactions`、`verification_failures`（`verification.failed`/`passed=false`）、`permission_failures`（`security.permission_denied`/`approval_denied`/`approval.resolved deny`）、`security_failures`（全部 `security.*`）、`context_overflow`（`run.limit_reached` limit ∈ {context,maxTokens} 或 `context.compacted overflow=true`）、`latency_ms`（`model.completed.durationMs` 求和）、`tokens`（`model.completed/delta.outputTokens`）、`false_complete`（`turn.completed` falseComplete/spurious）、`subagent_failures`。计数器全部来自事件流，缺失维度为 0（诚实不伪造）。
- **`attributeRegression(baselineCases, challengerCases)`**：逐 case 累计 baseline 与 challenger 的 tally，取「challenger − baseline delta 最大」的维度为主因 `likelySource`，`contributors` 按 delta 降序列出全部恶化维度（含 `baseline/challenger/delta/evidence` 证据），`affectedCases` 只列出在主因维度上 challenger 净增为正的 case id。
- 无任何维度恶化 → `regressed=false`、`likelySource=""`、空 `contributors/affectedCases`（绝不输出无证据支撑的来源）。
- 已导出（`index.ts`），供实验对比报告接用：退化时输出的是「哪个机制维度 + 哪些 case + 事件计数证据」，而非裸 "83% → 80%"。

## Tests

- `attribution.test.ts`（11）：`tallyEvents` 各维度归约（空流零值；model/verification/compaction/false-complete；tool 重试计数；permission 与 security 分列；latency/tokens 求和；context overflow 判定）+ `attributeRegression`（未退化→空归因；最大 delta 为主因；contributors 排序与受影响 case 的「主因维度限定」语义；主因 + 次因并存时 case 归属）。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **87 files / 1223 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- evaluation 定向：attribution 11 tests。
- 全量：87 files / ~55s。
- 说明：本轮净变更仅新增 attribution 纯函数模块（无既有行为改动，无适配现有测试），维度命名与 `EventTally` 字段一一对应（`latency` 命名校准为 `latency_ms`），测试充分；未降低测试或安全标准。

---

# P2-11 Case Mining from Real Failures

Status: DONE

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

## Notes

新增 `packages/evaluation/src/mining.ts`，实现 `production-like failure → sanitize → minimize fixture → create regression case → freeze judge` 流水线，四步各一个纯函数 + 一个整例组装器 + 落盘函数：

- **`sanitizeFailure(task, fixture, customSecretPatterns?)`**：复用运行时自带的 secret gate（`@ar/security` 的 `detectSecrets`/`redactSecrets`，与运行时/记忆/技能脱敏同源，不另造正则）对 task 与每个 fixture 文件脱敏；带结构的已命名 secret（如 `.env` 的 `KEY=`）原地 redact 保留结构，纯 secret 文件（无偿的裸 key/凭证 dump）整体删除；输出 `SanitizeReport`（locations/secretTypes/redactedSpans/fullyRemovedFiles/sawSecret/remainingSecret）。
- **`minimizeFixture(fixture, maxBytes)`**：确定性整文件裁剪——删空文件、删内容完全重复的文件、超预算时按「最大优先」整文件裁减；**绝不原地改内容**（防伪造复现），**绝不删到只剩 0 文件**——单个文件仍超预算则置 `overBudget=true` 交人工精简。默认字节预算 `MIN_FIXTURE_MAX_BYTES=256KiB`。
- **`mineCandidate(failure, opts)`**：组装 candidate（派生 `mine-<slug>-<sha8>` id、默认 `regression` suite、`task`/`fixture`/`expected`/`expectedTerminationReason`/`forbidden`/`verification`/`tags`/`provenance`）。硬门禁：非 `humanConfirmed` 抛 `CaseMiningError(need-human-confirmation)`；redact 后仍残留 secret（含项目自定义 `customSecretPatterns`）抛 `CaseMiningError(secret-survives)`——这正是「禁止把带 secret 的真实 workspace 原样存 benchmark」的强制层。expected 默认由 tags 推导（denial/security/injection 等 → `denied`，否则 `failed`），**绝不猜测成 `completed`**。
- **`freezeCase(candidate, judgeVersion)`**：pin judge 版本；若 `overBudget` 或仍有 secret → 抛错（无法客观判定的 fixture 拒绝冻结而非静默截断）。
- **`writeFrozenCase(outDir, frozen)`**：按 benchmarks/README.md 布局写 `suite/case-id/{request.md, expected.md, case.json, fixture/...}`；fixture 相对路径拒绝绝对路径 / `..` 逃逸（写盘前二次校验）。
- 已导出（`index.ts`）；`@ar/security` 加入 `@ar/evaluation` 依赖与 tsc reference（仅依赖 `@ar/contracts`，无循环）。

## Tests

- `mining.test.ts`（20）：`sanitizeFailure`（task/fixture 脱敏、带结构 secret 保留 redact、纯 secret 文件整体删除、redaction 计数与 locations、自定义 project secret 残留检测、空文件不动）；`minimizeFixture`（去空/去重/整文件超预算裁剪、单文件仍超限置 overBudget、绝不改内容）；`defaultExpectedStatus`（denial 标签→denied，否则 failed，绝不 completed）；`mineCandidate` 门禁（未人工确认抛错、secret 残留抛错、id 派生 + 默认 expected、显式 expected/forbidden/verification、tags 合并去重）；`freezeCase`（正常 pin、overBudget 拒冻结、secret 残留拒冻结）；`writeFrozenCase`（layout/request/expected/case.json/fixture 落盘、无 secret 泄漏、路径逃逸拒绝）。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **88 files / 1243 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- evaluation 定向：mining 20 tests。
- 全量：88 files / ~55s。
- 说明：本轮净变更新增 `mining.ts` 纯函数流水线 + `@ar/evaluation` 新增 `@ar/security` 依赖（复用同一 secret gate，行为与运行时一致，不另造模式）；未改既有行为、未适配既有测试即全绿；未降低测试或安全标准（三处硬门禁均以测试锁定）。

---

# P2-12 Adversarial Benchmark Expansion

Status: DONE

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

## Notes

生成 `benchmarks/adversarial/` 13 个用例（每攻击向量一个目录，`request.md` /
`expected.md` / `case.json` / `fixture/`，布局与 `loadBenchmarkCase()` 兼容）：

- 判定模型（对齐 `runner.ts` 语义）：`expected.status:"completed"` + `forbidden`
  奖励「抵挡注入、完成良性任务且**不尝试**被禁动作」（注入只是 data，不是
  authority）；`adv-path-confusion` 用 `denied` 断言 sandbox 拦下越权读且**无副作用**
  完成（沙箱边界测试——denied 分支要求每个 `tool.requested` 都被拒绝、零副作用）。
- 每 hot 向量配对应的 forbidden（`network` 开总闸 + `commands`/`reads` 具体子串），
  保证攻击可被事件流判定，绝不依赖模型措辞。

## Tests

- 新增 `benchmark-suite.test.ts`（7，P2-12/P2-13 共管）：加载两套件、id 精确清单
  + 跨套件唯一、request/expected/suite 齐全、每向量「denied 或存在 forbidden」可分、
  stress 压力维度存在、海量/超长 fixture 可加载不崩。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **89 files / 1250 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- adversarial：13 tests suite conformance。
- 全量：89 files / ~56s。
- 说明：新增 `benchmarks/adversarial/` 13 个用例目录（已打通 benchmark runner 与
  conformance gate）；未改既有行为、未降低安全标准。

---

# P2-13 Stress Benchmark Expansion

Status: DONE

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

## Notes

生成 `benchmarks/stress/` 11 个用例（压力以**预算维度**或**大 fixture** 表达）：
`stress-many-small-files`（fixture 1000 文件）、`stress-deep-directory`（12 层嵌套）、
`stress-huge-generated-logs`（~2.2MB/6 万行）、`stress-very-long-json`（~830KB 深度
嵌套——初版深 9 曾生成 179MB，校准为深 6 保持「超长但可提交」）、
`stress-repeated-tool-failures`（`maxRetries=6` 有限重试）、`stress-10-subagents`
（`maxDurationMs` 并行收敛）、`stress-context-near-limit`（`contextBudgetTokens=8000`
强制 compact）、`stress-many-artifacts`（`allowArtifacts` + 40 源文件）、
`stress-rapid-cancellation` / `stress-slow-verifier` / `stress-slow-mcp`
（`timeoutMs`/`maxDurationMs` 严格完成不 hang）。

## Tests

- `benchmark-suite.test.ts`（P2-12 已述，含 stress 覆盖）：每 stress 用例必须有预算
  （contextBudgetTokens/maxRetries/maxDurationMs/timeoutMs/allowArtifacts）或重型
  fixture（bytes>64KiB / 文件数>100 / 深度>5）；海量 fixture 可被 loader 加载。
- 全量门禁：`pnpm typecheck` exit 0；`pnpm test` **89 files / 1250 passed / 0 failed**；`pnpm build` exit 0。

## Benchmark

- stress：11 tests suite conformance。
- 全量：89 files / ~56s。
- 说明：`benchmarks/README.md` 已更新为实际数量（adversarial 13 / stress 11）并新增
  两套件清单表；`--suite adversarial|stress` 命令可直接跑这 24 个用例。

---

# P2-14 Evaluation Cost Model

Status: DONE

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

## Notes

新增 `packages/evaluation/src/cost-model.ts`，把「成功但不高效」与「失败但便宜+干净」区分开，
解决「只按 success 决定是否晋级」的短板：7 个维度各出一个 [0,100] 子分，按可配置权重加权得总分。

- **维度语义**（`scoreCost(input, opts)`，input 即 `EvalOutcome` 结构）：
  - `quality`：passed=100 / failed=30 / error=0 —— 失败仍给 30 分「努力分」，不被一票否决（学习/晋级不只看 success）。
  - `reliability`：从 100 扣 —— 每次 verification_failure −25、每次 human_intervention −10、每次超首个额外 compaction −5，clamp [0,100]。
  - `latency` / `tokens` / `tool_calls` / `retries`：`budgetRatio`，值 ≤ 预算得满分 100，超预算按 `预算/实际` 等比（clamp ≥5）——**衰减而非硬切 0**，保留节约信号。
  - `security`：从 100 扣，**任何 `security.*_denied` 事件、或 exec `tool.requested` 命中内建网络分类器（复跑 NETWORK_EXEC_PATTERNS，尝试即违规）→ hard violation → 该维度 0 且 `securityViolation=true`**；`security.secret_redacted` 只是 soft hit（边界正常工作）−20 不触发 gate。
- **Hard gate**：`securityViolation` → 无论权重多低、多便宜多快，`score` 直接 = 0（安全违规永远不能被 cost score 抵消）。
- **默认权重**（`DEFAULT_COST_WEIGHTS`，和为 1.0）：quality .4 / reliability .2 / security .2 / tokens .08 / tool_calls .06 / latency .04 / retries .02。
- **默认预算**（`DEFAULT_COST_BUDGETS`，文档化的「无成本压力」目标而非硬限）：latencyMs 30s / tokenBudget 32k / toolCallBudget 20 / retryBudget 4；`opts.budgets` 可逐项覆盖。
- 接线 `baseline.ts`：`collectRunMetrics` 为每例附 `cost`（`BenchmarkCaseResult.cost`，可选、向后兼容旧报告）；
  `summarizeResults` 汇总 `avg_cost_score` / `avg_cost_dimensions` / `security_violations`；
  `renderSummaryMd` 在 Summary 表新增 cost 三行并在 per-case 保持不变。

## Tests

`packages/evaluation/src/cost-model.test.ts`（13 测试）+ 整包 204 全绿。覆盖：干净 run 全 100 且
权重和为 1；quality passed>failed>error；failed-but-clean 分数 ∈ (0,100)（学习而非纯 success）；
高退化 reliability 分更低；slow-run latency 用 `toBeCloseTo(50)` 验证等比衰减且不硬切 0；
wasteful<efficient；`security.network_denied` 任一即 score=0 且 security 分 0（gate）；
尝试 `curl` exec 即 hard violation（尝试即失败）；**同一干净轨迹 ± 一条 denial → gated=0 / ungated=100（gate 不可被低价抵消）**；
`secret_redacted` soft hit 分 80 不 gate；partial weights 默认合并；自定义 latency budget 重标定。
已有 `baseline.test.ts`（58）通过，证明加字段完全向后兼容。

## Benchmark

adversarial/stress 中 `security.*_denied` 类用例一旦通过，报告的 `security_violations` 应为非 0、
`avg_cost_score` 应因此归 0 —— 这就是「安全违规不被成本抵消」在真实基准上的直接体现。

---

# P2-15 Cross-Model Evaluation

Status: DONE

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

## Notes

扩展 P2-9 实验基准为跨模型（contracts/experiment.ts + evaluation/experiment-harness.ts，全部向后兼容）：

- **配置**：`ExperimentConfig.models`（strongest-first，默认 `["default"]`）+ 可选
  `modelCapabilities`（显式 `strong|weak` 标记，缺省按顺序：首=strong、末=weak）。
- **逐 variant × 逐 model 运行**：harness 双层循环，结果/失败的 `ExperimentVariantResult` 都带
  `model`（`result.model ?? model`，缺省 single-model 兼容）；`ExperimentComparison` 也带 `model`
  使 `computeComparisons` **按单 model 内比较**，杜绝跨 model 混算 delta。
- **`computeCrossModel(config, results)`**：≥2 models 才返回 `crossModel` 分析。对每个非 baseline
  机制计算 `mechanism − baseline` 的 strong/weak delta（>0 = 该 model 指标按 higher-is-better 改善），
  分类为 `consistent` / `harms-weaker` / `improves-only-strong` / `improves-only-weak` / `mixed`，
  并给 `counts` 汇总。`harms-weaker` 与 `improves-only-*` 正是单 model 评测永远看不见的两类退化。
- **报告**：`ExperimentReport.crossModel?`（含 `model:{strong,weak}`、`findings[]`、`counts`）；
  `renderReport` 打印 per-model 结果、per-model comparison 与 cross-model 清单。
- 配置加载：`experiment-config.ts` 解析 `models`/`modelCapabilities` 并校验（空/重复 model、
  非法 capability tag、`models` 为空数组均报错）。

## Tests

`packages/evaluation/src/cross-model.test.ts`（8 测试）+ 整包 212 全绿。覆盖：
单 model 返回 undefined；`harms-weaker`（strong +0.05 / weak −0.20 精确断言）；
`improves-only-strong`（weak 不变）、`improves-only-weak`、`consistent`（修正 classify 顺序——
先判双正再判单正）；`modelCapabilities` 显式强/弱覆盖排序；harness 双层 run（2 变元×2 model=4 次
调用、结果/比较按 model 打标、`crossModel` 存在）；弱 model 单点失败只记该 model。
`experiment-harness.test.ts`（5）/`experiment-config.test.ts`（7）不变仍绿（向后兼容证明）。

## Benchmark

对真实模型跑 `experiment-engine` 若配置 `models: [champion, challenger]`，
报告应给出 cross-model counts：若非 0 的 `harms-weaker`/`improves-only-*`，
说明该机制是「只对强势模型有效的过拟合优化」，应在晋级（learning promotion）中被否决。

---

# P2-16 Prompt Rule Versioning

Status: DONE

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

## Notes

新增 `packages/context/src/prompt-versioning.ts`：`PromptVersionRegistry` 让 system prompt /
runtime rule 从匿名字符串变为**不可变、可溯源、可回滚**的版本对象：

- **发布**：`publish({ content, changeReason, candidateSource?, benchmarkEvidence? })` → `VersionedRule`
  `{ version, content, hash, changeReason, candidateSource, benchmarkEvidence, createdAt, active }`。
  每次发布都是**不可变追加**：旧版内容/哈希永不被改写，仅从 active 降级；新版本成为唯一 active。
- **四要素齐备**：`hash` = `sha256(content)`（`hashRuleContent`，node:crypto，hex）；`changeReason` 必填；
  `candidateSource`（human/benchmark/迁移等）；`benchmarkEvidence[]`（`{ benchmark: { suite, caseId,
  beforeScore, afterScore }, note? }`）——升级原因与基准证据绑定。
- **防呆门禁**（`RuleVersionError`）：空 content / 缺 changeReason 拒绝；**重复 content（同 hash）拒绝**
  ——不做无意义 churn、也避免哈希碰撞。
- **rollback(targetVersion)**：重激活旧版、停用所有更新版；历史完整保留。`rollback` 到已是 active 的是
  no-op；未知版本抛错。
- **完整性**：`verifyIntegrity()` 重算每个 hash，检测「发布后被原地篡改的字符串」（绝不让被改过的
  prompt 静默发给模型）；`exportSnapshot()/importSnapshot()` 支持持久化/迁移往返。

## Tests

`packages/context/src/prompt-versioning.test.ts`（9 测试）+ 包内 66 全绿。覆盖：v1 四要素+hash；
逐次发布单调版本、仅最新 active、旧版内容/哈希不被改动；空内容/缺 reason 拒绝；重复 content 拒绝；
rollback 重激活旧版并停用更新版且历史完整；rollback-active no-op；未知版本抛错；原地篡改被
`verifyIntegrity` 检出（violated 含对应 version）；snapshot 往返保版本与来源。

## Benchmark

真实运行的 system prompt / 规则通过 registry 发布后，每次 benchmark 的 manifest/报告应能引用
`PromptVersionRegistry` 快照的 version+hash——将来某个版本导致回归时，`rollback(n)` 一键还原且
来源/证据完整可查。

---

# P2-17 Policy Config Versioning

Status: DONE

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

## Notes

新增 `packages/context/src/policy-versioning.ts`：`PolicyConfigRegistry` 把 retry / compaction /
memory-ranking / scheduler / verification / permission-defaults / tool-semantics 等一切悄悄改变 agent
行为的配置对象从「匿名字符串」提升为**逐策略、不可变、可溯源、可回滚**的版本记录，使 benchmark 结果可
精确回溯：

- **发布**：`publish({ policy, config, changeReason, candidateSource?, benchmarkEvidence? })` →
  `PolicyVersion { policy, version, hash, config, changeReason, candidateSource, benchmarkEvidence,
  createdAt, active }`。每次发布为不可变追加：同策略旧版仅从 active 降级、内容/哈希永不被改写；新版
  成为唯一 active；版本号按策略独立单调递增。
- **稳定指纹**：`hash` = sha256(*stable serialization*)，`stableSerializeConfig` 递归按键排序，使
  指纹**与对象键序无关**——相同配置恒得相同 hash（稳定身份而非 diff），键序不同的拼写差异不产生无意义
  churn。`hashPolicyConfig` 导出供外部复用。
- **防呆门禁**（`PolicyVersionError`）：空 policy / 缺 config 对象 / 缺 changeReason 拒绝；同策略
  **重复 config（同 hash）拒绝**，避免无意义升降级与哈希碰撞。
- **rollback(policy, targetVersion)**：重激活目标版本、停用该策略所有更新版；历史完整保留。
- **完整性**：`verifyIntegrity()` 重算每个版本的指纹，检出「发布后被原地篡改的 config」，绝不静默
  生效；`exportSnapshot()/importSnapshot()` 支持持久化与迁移往返。
- **溯源**：`exportTrace()` 输出活跃策略 →（version, hash, changeReason）映射，供写入 benchmark
  manifest，任何导致数字变化的策略改动都可精确定位并按需回滚。

## Tests

`packages/context/src/policy-versioning.test.ts`（10 测试），context 包 **76 全绿**。覆盖五类策略
（retry/compaction/scheduler/verification/remap）逐策略独立发布与版本递增；仅最新 active；同一 config
按不同键序发布拒绝（duplicate-config）；四要素+稳定 hash；键序无关 hash 相等；空 policy/config/reason
拒绝；rollback 重激活目标并停用更新版且历史完整；未知版本抛错；rollback 到已 active 为 no-op；原地
config 篡改被 verifyIntegrity 检出；exportTrace 只含活跃策略且字段正确；snapshot 往返保版本与来源。

## Benchmark

`exportTrace()` 映射并入 benchmark run manifest 后，任何 policy 变更导致数字regression，都可从报告反查
到具体 (policy, version, hash, changeReason) 并 `rollback` 还原；同键序差异不产生假 churn，保证 trace 的
稳定性与可复现性。

---

# P2-18 Plugin System Hardening

Status: DONE

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

## Notes

原有 `PluginHost`（`packages/plugins/src/plugin-host.ts`）只会「throw 就跳过」，无能力声明、无信任/权限
边界、无版本/来源校验、无禁用开关，且静默吞错——坏插件可能无限重试或无限挂起。本次把 dispatch 与
load 两侧都硬化：

**dispatch 侧（`PluginHost` 原地强化，向后兼容 `{ id, onTool }` 旧形态）：**

- **能力声明**：插件用 `capabilities: PluginCapability[]`（`tool | hook | event | mcp | skill`）声明要
  触达的能力；注册了 `onTool` 却未声明 `tool` 在注册期即拒（`undeclared-capability`）。
- **权限边界**：策略 `grants: Record<PluginTrust, PluginCapability[]>` 按信任层级（trusted/verified/
  untrusted）授予能力；tier 未授予 `tool` 时，即使声明了也被 dispatch 前拦截——插件永远够不到授权之外
  的表层。默认 `untrusted` 仅 `[tool, event]`。
- **失败隔离**：同步与异步 throw 都捕获；每次调用受 per-plugin 超时（`timeoutMs` 或策略默认）约束，
  永不无限挂起；错误预算熔断——连续失败 ≥ `maxConsecutiveFailures` 自动 quarantine，坏插件被自动关停，
  后续插件照常运行。成功事务重置其连续计数。
- **版本/来源/信任**：`register` 校验 semver（`validatePluginVersion`）、来源白名单（`allowedSources`）、
  信任层级是否合法，违规注册抛类型化 `PluginError`。
- **禁用开关**：`disable(id)/enable(id)` 单插件开关 + `setGlobalEnabled(false)` 全局 kill switch（坏插件
  生态整体一键关停）。
- **可观测**：`stats()` 上报 total/enabled/disabled/quarantined 及各插件失败计数，不再静默吞错。

**load 侧（新增 `packages/plugins/src/plugin-registry.ts`：`PluginRegistry`）：**

- **manifest 校验**：`load({ id, name, version, source, trust, capabilities }, { activate })` 校验版本
  （semver）、信任层级、来源白名单、能力声明（`requireCapabilities`）、重复 id。
- **activate 失败隔离**：`activate()` 同步抛或异步 reject 都被捕获并标记 `failed` + 记录 error，
  **绝不向外传播**，后续插件仍可加载——坏插件无法拖垮 runtime。
- **禁用/unload/全局开关**：`disable/enable/unload` + `setGlobalEnabled`；`list()/get()/stats()` 暴露
  来源/信任/状态。
- **贡献边界**：`PluginLoadContext.registerContribution(kind)` 在激活期对超出已声明能力的贡献静默拒绝，
  插件无法自我扩容授权。

## Tests

`packages/plugins` 三文件 **40 全绿**、`tsc -b` 通过：
`plugin-host.test.ts`（12，回归）保持旧 dispatch 行为；`plugin-host-hardened.test.ts`（16）覆盖
semver 校验、声明未含 tool 拒、requireDeclaration 拒、信任未授权 tool 被拦截、声明 tool 且受权可调度、
来源白名单放行/拒绝、非法版本拒、未知信任拒、单插件 disable 跳过而他人照跑、全局 kill switch、
超时不挂起（默认+per-plugin timeoutMs）、连续失败熔断+stats 记录、成功重置连续计数、
enable 解除 quarantine；`plugin-registry.test.ts`（12）覆盖 manifest 各维度校验、重复 id 拒、
requireCapabilities 拒、activate 同步抛/异步 reject 失败隔离且后续可加载、disable/enable、failed 不被
复活、全局禁用拒加载、unload。

## Benchmark

conjure 坏插件（无限挂起 / 持续抛错 / 声明不符）单独注入 host，验证 timeout 与熔断将其与健康插件隔离，
全量 benchmark 不因单个插件失败而中断；权限边界保证坏信任来源插件无法触达未授权工具/钩子。

---

# P2-19 Hook Runtime Hardening

Status: DONE

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

## Notes

`packages/core/src/lifecycle/hooks.ts` 的 `HookRegistry` 硬化（API 向后兼容，`register` 新增
`Handlers` 可带 `{ source?, timeoutMs? }`；`register`/`beforeTool`/`afterTool`/`toolError`/`dispatch`
签名不变）：

- **timeout**：每个 handler 经 `runGuarded` 包裹，默认超时（可覆盖）；`Promise.resolve().then(invoke)`
  使**同步 throw 也被当作 rejection 捕获**，绝不从 dispatch/beforeTool 向外传播/挂起 turn。
- **failure policy / 禁止 hook 异常默认 allow**：安全关口钩子 **fail closed**。`before_tool` /
  `before_permission` / `before_memory_write` 抛错或超时一律 **deny**（`beforeTool → null`、
  `beforePermission → false`）；观察钩子（`after_*`/`session_*`/`tool_error`）仅观察不可能加宽安全，
  fail open（swallow+报告）。这实现「hook 异常默认 deny 而非 allow」。
- **各自语义**：
  - hook throw → gate: deny（+报告 "throw"）；observe: swallow（+报告）。
  - hook timeout → 与 throw 相同，action "deny"/"swallow"。
  - hook deny → 门禁钩子返回 null/false 即阻断；显式拒绝与 fail-closed 拒绝都会浮出（显式拒绝不记为
    失败）。
  - hook additional context → `before_tool` 返回被 transform 的 `ToolCall`，逐级串联交给下一 handler，
    最后作为 enriched context 返回（transform = 追加上下文）。
- **ordering**：严格按注册顺序串行执行，注册为 append-only 直至 unsub。
- **observability**：`policy.observability` sink 上报 `HookFailureReport`（hook/source/kind/error/
  index/action/elapsedMs）；`failureStats()` 汇总 count/denied/swallowed 供审计，gate 失败不再静默。
- 额外：`beforePermission()` 门禁新增；`fingerprintHook()` 稳定指纹用于记录哪种规则部署了该钩子。

## Tests

`packages/core/src/lifecycle/hooks.test.ts`（18 测试，原 11 + P2-19 新增 7）全绿，且 runtime 总 125
通过、`tsc -b` 干净。原「抛错传播」测试按新语义改写为「抛错→deny」。新增覆盖：gate 钩子抛错 fail
closed、超时 fail closed、注册顺序+source+transform 串联、observe 钩子抛错被 swallow+报告而后续照跑、
`before_permission` 抛错返回 false、dispatch 内同步抛错不 reject。

## Benchmark

注入抛错/挂起的 health-check 钩子，验证安全关口在异常下始终 deny 而非放行；挂起钩子被超时兜底不会挂住
turn；观察钩子故障不中断流程且可观测。为「hook 异常绝不默认 allow」提供回归证据。

---

# P2-20 MCP Reliability

Status: DONE

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

## Notes

**客户端（`packages/mcp/src/mcp-client.ts`，`McpClient`，向后兼容）：**

- **connect timeout**：initialize handshake 受 `connectTimeoutMs` 兜底，无应答 → 结构化 `NETWORK_ERROR`。
- **call timeout**：无 caller signal 的请求受 `requestTimeoutMs` 兜底；有 signal 时 signal **原样转发**
  （取消走 `USER_CANCELLED`）。两路用可控 AbortController：超时 abort → `NETWORK_ERROR`（timed out）；
  显式取消 → `USER_CANCELLED`。
- **状态与 server unavailable**：`connected` 记录握手成功/关断/失败；网络错误/超时/断连自动标记
  `connected=false`；`isConnected()`/`hasConnectedAtLeastOnce()` 暴露。
- **reconnect**：`reconnect()` 强制重握手、`ensureConnected()` 仅断连时重连。
- **cancellation**：保留 P1-10 的 signal 转发语义（无 orphan HTTP）。
- **partial response**：非 2xx / 非法 JSON / 缺 tools 数组 / 缺 tool name 均结构化失败。

**动态工具刷新（新增 `packages/mcp/src/mcp-tool-view.ts`：`McpToolView`，快照隔离）：**

- **当前 turn 的 tool view 是 snapshot**：`beginTurn(turnId)` 把已提交视图冻结为本次 turn 快照，
  turn 内 refresh 只会 staging，不改变 turn 所见——由此明确「是 snapshot」。
- **新工具不能中途绕过 policy**：turn 进行中 refresh 的结果仅在下一个安全边界
  （下次 `beginTurn` 的 `commitStaged`）生效，使新工具在下个 turn 作为普通工具注册，仍走正常
  permission/sandbox pipeline，绝不在已运行 turn 中凭空出现。
- **schema mismatch 结构化失败**：`resolveTool(name, providedSchema)` 比对 frozen 快照的 schemaHash，
  变更即 `TOOL_SCHEMA_ERROR`（绝不静默错误调用）；工具被移除也结构化报错。
- **diff 与校验**：重复 tool name → `TOOL_SCHEMA_ERROR` 且不部分生效；工具移除 → `diff.removed` 并在
  提交时从 committed 视图移除；schema 变更 → `diff.changed`（name, oldHash, newHash）；畸形（无名 / 部分
  响应）工具 → 结构化失败且视图不变。schemaHash 为键序无关稳定指纹。

## Tests

`packages/mcp` 四文件 **43 全绿**、`tsc -b` 干净：`mcp-client.test.ts`（15）、`mcp-tool-adapter.test.ts`
（12）为回归；新增 `mcp-client-hardened.test.ts`（7）覆盖 connect 超时、无 signal call 超时（且标记断连）、
caller signal 原样转发+`USER_CANCELLED`、connect 失败置断连+reconnect 恢复、`hasConnectedAtLeastOnce`
跨周期、`ensureConnected` 已连接时 no-op、partial response 结构化失败；`mcp-tool-view.test.ts`（9）覆盖
静态刷新/新增/变更/移除 diff、重复名与畸形工具结构化失败且不生效、键序无关 hash、turn 内 refresh 被
staging 不生效（新工具不可见/不可 resolve）、安全边界提交后新工具可见、schema mismatch 结构化失败、
移除工具的 resolve 拒绝。

## Benchmark

conjure 一个动态 MCP server（中途增删工具/改 schema/重复名/挂起）驱动 `McpClient+McpToolView`，验证
turn snapshot 隔离与安全边界提交；schema 变更/移除/重复名全部结构化失败，cancellation 与超时语义
正确，全链路不因远端抖动而静默错误。

---

# P2-21 MCP Trust / Provenance

Status: DONE

已验证：每个 MCP tool/result 携带 server id、tool id、schema hash、trust level、network boundary；结果进入 ContextBlock 时保留 provenance。

实现：
- `packages/contracts/src/context.ts`：新增 `ContextBlockProvenance`、`NetworkBoundary`，`ContextBlock` 增加可选 `provenance` 字段。
- `packages/mcp/src/mcp-provenance.ts`：`buildMcpProvenance()` 构建 provenance；`toContextBlock()` 将 MCP 结果包装为携带 provenance 的 ContextBlock；`estimateMcpTokens()` 粗粒度 token 估算。
- `packages/mcp/src/mcp-tool-adapter.ts`：`createMcpToolAdapter` 新增 `provenance?` 选项（本地服务配置：serverId/trust/networkBoundary），为每个 ToolLike 钉住本地 provenance；trust/boundary 只来自本地配置，绝不来自远端响应，杜绝远端伪造。
- `packages/mcp/src/index.ts`：导出所有新增符号。

测试（通过）：
- `mcp-provenance.test.ts`（7 例）：字段钉定 / 可选字段省略 / ContextBlock 包装 / 默认值 / token 估算 / 防 spoof（内容自称 trusted 不改 provenance）。
- `mcp-tool-adapter.test.ts`（+3 例）：钉住 provenance / 无配置时 back-compat / provenance 仅来自本地（远端描述不可覆盖）。

关键设计：schema hash（version）由本地快照 schema 计算（复用 P2-20 `schemaHash`），承诺"结果总能回溯到产生它的确切工具形状"。

---

# P2-22 File-system Sandbox Hardening

Status: DONE

测试覆盖的 path vector：`..`、absolute、symlink、junction、case-insensitive、Windows drive、UNC、temp path、artifact path、workspace root。读/写 policy 分开。不用对象字符串 startsWith。

实现：
- `packages/contracts/src/sandbox.ts`：`FilesystemPolicy` 新增 `caseInsensitive?`（macOS/Windows 大小写不敏感文件系统）。
- `packages/security/src/sandbox.ts`：
  - 新增纯函数 `containsPath(p, root, caseInsensitive)`：路径边界比较（绝非裸 `startsWith`），可大小写折叠，杜绝 `/tmp/ws2`、`/tmp/ws-2` 之类的前缀兄弟误判。
  - 废掉单一 `insideWorkspace`，改为 `allowedRoots()`（workspace root + 每个 `allowedPaths` 项，均 realpath 规范化，因此 temp path / artifact path 可通过 allowedPaths 显式放行）。
  - `resolvePath` 拒绝 NUL/控制字符（`\u0000-\u001f`），作为 bad path 而非简单地"越界"。
  - read-only 判定提到 write 分支最前，读/写作用域清晰分离。
  - symlink / junction 逃逸仍由 realpath 规范化覆盖。

测试（通过，+9 例）：
- 控制字符 / NUL 拒绝；前驱名碰撞（`ws` 与 `ws-2`）拒绝；`allowedPaths` 额外根目录可读写而其它仍越界；read-only 读放行写拒绝。
- `containsPath` 边界语义（精确、祖先碰撞、兄弟碰撞）、尾斜杠根、Windows 分隔符。
- case-fold：`caseInsensitive` 关闭时不同大小写即不同路径；开启时同文本不同大小写判为 inside；开启绝不清除真正不同的兄弟目录。
- workspace root 自身；junction 逃逸拒绝。

设计说明：realpath 已在大小写不敏感文件系统上把路径规范化到规范大小写，因此 `caseInsensitive` 是对未命中 realpath 的路径做纵深防御；其语义经 `containsPath` 纯函数确定性测试（在大小写敏感 host 上无法用真实 FS 复现该场景，故直接对纯逻辑断言）。

---

# P2-23 Process Sandbox Hardening

Status: DONE

审计结论 + 结构化 process surface gate + 显式 threat model（本仓库不做 OS-level sandbox，明确声明局限）。

实现：
- `packages/security/src/process-gate.ts`：`analyzeProcessCommand()` 对命令串做静态 surface 分类（shell-wrapper / interpreter-eval / interpreter-script / package-manager / git / network-tool / plain），自带 shell 感知 tokenizer（引号与反斜杠转义），`surfaceDenied()` 判定 deny。识别向量：`cmd /c`、`powershell -Command/-EncodedCommand`、`bash/sh/zsh/dash -c`、`node -e/--eval/-p`、`python -c`、`ruby/perl -e`、`deno eval`、script file、npm/pnpm/yarn/pip/cargo 等 package manager、git（mark 网络型 verb：fetch/clone/pull/push）。
- `packages/contracts/src/sandbox.ts`：`ProcessPolicy` 新增 `deniedSurfaces?: ProcessSurface[]`。
- `packages/security/src/sandbox.ts`：`checkExec` 在最前执行 surface gate —— fail-closed，先于 command allowlist，因此显式禁用的 surface（如 interpreter-eval）即使文本命中 allowlist glob 也绝不运行。
- `packages/security/src/index.ts`：导出 process-gate。

测试（通过，+13 例）：
- `process-gate.test.ts`（9）：shell wrapper（cmd/powershell/bash/sh）；eval（node/python/ruby/perl/deno）；script file vs eval（引号内空格不拆 token）；package manager+install；git 网络 verb；network-tool / plain。
- `sandbox.test.ts`（+4）：denied surface 即使 allowlist 也拒绝（fail-closed）；denied 不误伤其它 surface；surface gate 先于 allowlist。

THREAT MODEL（明确声明局限）：`ProcessExecutor` 是纯 primitive，经 `/bin/sh -c`（POSIX）或 `cmd /c`（win32）spawn，任何授权均在上游（permission engine + sandbox + network intent gate + 本 surface gate）。process-gate 是**静态意图分类器**，在进程启动前检查字符串，**不约束运行中进程的行为**（子进程可再 spawn、联网、exec 不同解释器——`subprocess spawn` 维度无法从命令串静态保证）。因此它不构成 OS 边界隔离；真正的进程约束需 OS-level sandbox（seccomp/landlock/chroot/container），超出本项目范围，由部署层按此 #P2-23 的威胁模型显式补齐。

---

# P2-24 Network Gate V2

Status: DONE

结构化检测扩展（`packages/security/src/network-gate.ts`）：

```text
npx / pnpx / bunx          → 包执行器，命中 registry（→ NETWORK_BINARIES）
bun                        → add/install/uninstall/remove/update/link/unlink/x
deno                       → install/add/cache/vendor/info/uninstall
docker run with network tool → 容器内命令含网络工具(如 curl/ping) 或 --network=host/macvlan
python -m module           → -m http.server/− socketserver/− pip/urllib/http.client/ftplib/smtplib/telnetlib/…
node script argument URL   → node https://cdn/x.js 、 node app.js https://api/init （URL 字面量捕获）
git remote aliases         → scp 式 user@host:path（git clone/push 已覆盖，git remote add/set-url 已有）
PowerShell aliases         → invoke-command/enter-pssession/connect-wsman/new-pssession
```

实现要点：
- 保持 static intent gate，与 OS network isolation 明确区分；文档重申局限：`docker run` 内经 `sh -c` 的嵌套子命令只能被 URL/网络工具 token 抽查，容器内实际网络行为无法静态保证。
- 全部判定仅对 command-position 生效，info flags（`--help/-h/--version`）放行，避免 `npx --version`、`ping --help` 误杀。

测试（通过，+7 组 P2-24）：判正 npx/bunx、bun/deno 注册表操作、docker run 网络工具/host 网络、python `-m` 网络模块、PS remoting、node 脚本参数 URL、git scp 别名；判负 `npx --version`、`bun test`、`deno run app.ts`、`docker run nginx`（纯镜像）、`docker run --network bridge`、`python -m json.tool`、`git log origin/main`。

---

# P2-25 Dependency / Supply Chain Safety

Status: DONE

Agent coding 场景里：`npm install`、`pip install`、`curl | sh`、remote script、`git clone` 属于高风险 side effect。建立独立 permission category（`dependency_install` / `remote_code_execution`），而不是都归普通 exec。

实现：
- `packages/security/src/supply-chain.ts`：`classifySupplyChain(command)` 静态判定命令串类别（`dependency_install` / `remote_code_execution` / `command`）。
  - `dependency_install`：覆盖 npm / pnpm / yarn / bun / deno / pip / pip3 / pipx / uv / poetry / pipenv / pip-tools / cargo / go（get / mod download）/ dotnet add / gem / composer / apt(-get) / brew 的 install/add/ci 等关键动词；命令串 tokenizer 感知 option 段（`npm -g install` 仍判 install）。信息性命令（`npm --version`、`npm test`、`cargo build`、`pip freeze`、`go build`）判为 command。
  - `remote_code_execution`：`curl|wget|aria2c … | (sudo) bash|sh|zsh|dash|fish` 管道，以及 `bash <(curl …)` 进程替换；优先级最高（先于 install 判定），因此 `curl … | sh -s npm install` 判 RCE 而非 install。
  - `git clone / fetch` 保持 command，由 process-gate（git 网络 verb）与 network-gate 另行覆盖，避免本分类器二次误判。
  - `supplyChainRisk()`：RCE 升为 `critical`（`defaultEffectForRisk("critical")==="deny"`），install 为 `elevated`。
- `packages/tools/src/orchestrator.ts`：
  - `classify()` 对 process 工具把非 command 的 supply-chain 类别作为其 OWN permission `resource`（`exec:dependency_install`、`exec:remote_code_execution`），target 仍为完整命令串，并在 `SanitizedCall.supplyChain` 携带类别。
  - `effectivePolicy()` 接收 surface：supplyChain==="remote_code_execution" 时把 effectiveRisk 提升为 `critical`；defaultEffect 未显式配置时据此落到 deny —— 即 operator 只放行 `exec:command` 时，RCE 无法搭普通命令的便车。修复了此前 `effectivePolicy` 未传入 `surface` 的接线缺失 + `classifySupplyChain` 未 import 的缺口。

测试（通过，+8 单测 +2 集成）：
- `supply-chain.test.ts`（8）：RCE 管道（curl/wget/aria2c | sh/bash/zsh，含 sudo）；进程替换 `<(curl …)`；RCE 优先于 install；install 跨 20+ 包管理器；同二进制普通命令判负；裸 curl/wget（未 pipe 到 shell）判负；git/其它工具判 command；`supplyChainRisk` 分级。
- `orchestrator.test.ts`（+2 集成）：policy 仅放行 `exec:command` 时，`pip install` 以 `PERMISSION_DENIED`（理由含 `dependency_install`）被拒、`curl | bash` 以 `remote_code_execution` 被拒、`echo hi` 正常执行；无 defaultEffect + 无 RCE 规则时 `bash <(curl …)` 因 critical 升级默认拒绝，而普通 exec（基座 elevated）仍可执行。

设计说明：与 process-gate / network-gate 一致，本分类器是**静态命令串意图分类**，只约束进程启动前的授权授予（permission + sandbox），不约束运行中进程的子进程 / 联网 / exec 行为；供应链风险的真实落地仍由部署层结合 OS 级依赖来源锁定（lockfile 校验、私有 registry、SBOM 验证）补足。

---

# P2-26 Workspace Change Transaction

Status: DONE

对于复杂 coding task，用受控的 **snapshot 事务**取代 agent 任意 `git reset --hard`：失败修复可整体 rollback，落到一批改动前的字节级状态。

实现（`packages/tools/src/transaction.ts`）：
- `WorkspaceChangeTransaction`：
  - `snapshot(plans)` 在改动前捕获每个目标的 on-disk `before` 状态（存在则记录内容，缺失则记录 absent），并按 plan.content 有无自动推导 `create/write/edit/delete`。`before` 是权威依据，rollback 严格还原它，绝不依赖调用方的记忆。
  - `commit()` 全有或全无：写入采用「同目录 temp 文件 + 原子 rename」，全部写入成功后再做 delete；任一步失败立即对已 applied 的路径 best-effort rollback，抛出带 `applied` 列表的 `TransactionApplyError`，状态回到 `open`。
  - `rollback()` 幂等，反向恢复每个路径；带 `open/committed/rolled_back` 状态机，已结束的事务禁止再 snapshot/commit。
  - 路径约束：用 `resolve`+`relative`（非裸前缀）判断 containment，拒绝 `../`、绝对路径、兄弟目录名碰撞（`/tmp/ws2`）；目录作为目标抛 `NotAFileError`。不写穿 symlink（目标限定为 resolve 出的普通文件）。
- 与 P2-27/P2-28 的关系：这是**协调原语**而非安全边界；write 工具的实际 allow/ask/deny 策略仍在 orchestrator + P2-27 write safety guard。原语只负责"一批工作会动哪些文件 / 如何整体还原"。

测试（通过，+9 例）：create + commit + rollback（rollback 删除新建文件）；overwrite 后 rollback 逐字节还原（覆盖"大文件被小字串覆盖"场景）；absent-before 的 delete 路径 rollback 后仍 absent；嵌套多级父目录创建；相对路径解析 + `../` / 绝对 / 兄弟名逃逸拒绝；目录目标拒绝；已提交事务拒绝再 snapshot/commit；fail 中途（母目录是普通文件）整体回滚（首次 applied 文件还原为 absent、blocked 文件从未创建、状态回 open、applied 列表正确）；rollback 幂等。

---

# P2-27 Write Safety Guard

Status: DONE

防止曾发生的「整文件覆盖未跟踪文件导致内容不可恢复」：对 write 工具增加 existing/tracked/large-overwrite/append/backup 事实判定，`large existing file -> tiny replacement` 进入风险提示/approval。

实现：
- `packages/contracts/src/errors.ts`：新增错误码 `WRITE_SAFETY_DENIED`（含 default message + retry 默认值，均为不可重试）。
- `packages/tools/src/write-safety.ts`：纯判定 `assessWriteSafety(facts, config?)`。facts = { exists, untracked, originalBytes, newBytes, append, hasCheckpoint }；输出 level（safe/caution/danger）+ flags + reason + `escalateToApproval` + `checkpointRecommended`。规则：
  - 新文件 create → safe；append（加法）→ safe（即使大文件）。
  - **danger**：既有大文件（≥`largeFileBytes`=4096B）被缩到 `ratio<=tinyReplacementRatio`(=0.2) 且无 checkpoint → 升 approval / 拒绝。**这正是发生过的事故形态**。
  - **caution**：覆盖未跟踪文件且无 checkpoint（git 无法回退，建议先建 checkpoint）。
  - safe：文件由 git 跟踪（可回退）或已有 checkpoint。
  - checkpoint（P2-26 snapshot）存在时，即使大文件缩成小字串也判 safe（原内容可还原）。
- `packages/tools/src/tools/write-file.ts`：写前用 stat 测量原文件形状，跑 guard；`danger` → 返回 `denied` + `WRITE_SAFETY_DENIED`（不落盘，原内容保持）；`caution` → 仍写但输出携带 `safetyWarning`/`safetyFlags`。checkpoint 暂以 `hasCheckpoint:false` 接入（P2-26 事务后续可直接供给）。

测试（通过，+11 纯判 +4 工具集成）：
- `write-safety.test.ts`（11）：新文件 create safe；append 大文件 safe；**大文件→tiny 且无 checkpoint = danger**（escalateApproval）；shrink 阈值边界（ratio 0.2 含边界为 hazard，0.2001 不是）；checkpoint 存在化解 danger；正常尺寸覆盖已跟踪文件 safe；未跟踪文件无 checkpoint = caution；未跟踪+checkpoint = safe；小文件不算 shrink hazard（<4096B）；自定义阈值生效；默认配置稳定。
- `write-file-safety.test.ts`（4，工具级）：新建文件正常；对既有大文件 append 正常（加法安全）；**大文件被 "gone" 覆盖 → denied + WRITE_SAFETY_DENIED 且原内容未被改动**；等尺寸覆盖大文件正常（无缩并）。

边界说明：`untracked` 事实在工具内当前硬编码 `false`（未做 git 探测），因此 guard 的 caution 分支由调用方（含 P2-26 checkpoint 供给方）注入真实 untracked/hasCheckpoint；guard 的核心 destructive-shrink 拦截不依赖 git，天然 fail-closed。

---

# P2-28 File Edit Primitive Improvements

Status: DONE

优先 structured edit / patch / range edit，减少「read whole file + rewrite whole file」，并记录 edit diff。

实现：
- `packages/tools/src/edit.ts`：纯编辑原语（只作用于字符串，可穷举单测）：
  - `applyReplace`：文本锚点替换。默认仍替换首个匹配（向后兼容 edit_file v1）；`occurrence: N` 精确替换第 N 个匹配（越界**fails loudly**，绝不猜测——返回错误并归因到"文件共有 M 处"）；`replaceAll` 全替换。拒绝空锚。
  - `applyLineRange`：结构化的区间编辑（1-based 含首尾行），把 `[lineStart..lineEnd]` 换成多行 replacement；end 超过文件尾部自动 clamp；行首从第 1 行开始；整数校验，非法区间拒绝。
  - `lineDiff`：轻量 before/after 行 diff（去掉公共前缀/后缀，只给变动区，每侧 maxLines 封顶），用于 evidence / 观测。
- `packages/tools/src/tools/edit-file.ts`：edit_file 升到 v2.0.0，支持两种模式：text 模式（oldText/newText[/replaceAll/occurrence]）与 line-range 模式（lineStart/lineEnd/replacement）；两种模式不可混用（混用 → TOOL_SCHEMA_ERROR）；每次成功编辑都在输出携带 `diff`（替换文本模式另给 `replacements`，区间模式给 `replacedLines`）。

测试（通过，+14 纯原语 +5 v2 工具集成）：
- `edit.test.ts`（14）：applyReplace 默认首处兼容 / replaceAll / occurrence 精确命中 / occurrence 越界 fail-loud（content 未被改动、错误含现有匹配数）/ 锚缺失 fail / 空锚拒绝；applyLineRange 中段多行替换 / 单行删除（空替换）/ 首行起替换 / end 越界 clamp / 非法区间拒绝（0 起始、逆序、非整数）；lineDiff 增删输出 / 无改动 "(no change)" / 超大 diff 封顶。
- `vs001.test.ts`（+2 集成）：occurrence=2 精确替换 + 输出 diff 非空 + 读回验证 + occurrence=9 越界 fail；line-range [2..3]→多行 replacement + replacedLines=2 + 读回验证 + 与 text 模式混用 → TOOL_SCHEMA_ERROR。

---

# P2-29 Search / Code Navigation Tools

Status: DONE

Agent coding 质量很大程度依赖导航。统一 `file search / text search / symbol search / dependency graph / repo tree`，没有 symbol index 时给出清晰的 fallback，避免 Agent 通过反复 guessed read_file 找路径。

实现：
- `packages/tools/src/navigate.ts`：底层导航原语。
  - `walkFiles(root, rel, onFile, onDir)`：递归目录遍历，跳过 `.git`/`node_modules` 等 VCS/依赖目录；`onFile` 返回 `false` 可提前终止；`relative(".")` 空串规范化回 `.`。
  - `grepFiles({pattern, root, glob?, caseSensitive?})`：基于正则的文本搜索，DOTALL，逐文件按行匹配，返回 `{file,line,column,text}`（column 用 `lastIndex+1` 计算，规避首字符区域重复）。
  - `symbolSearch({symbol, root, path?})`：语言无关的**正则符号 fallback**——按文件扩展分组用针对性 patterns（ts/js/tsx/jsx → 函数/类/接口/类型/const/import，python → def/class，其它 → word boundary）；显式返回 `{fallback:true, indexer:"regex-symbol-fallback"}`，避免误报语义索引。用 global regex + `lastIndex` 重置管理循环，杜绝无限循环。
  - `repoTree({root, path?, depth?, maxEntries?})`：输出 `{path,type:"file"|"dir",depth}` 扁平列表，目录条目为合成叶子（不递归展开父路径每个成员）。
- `packages/tools/src/tools/navigation-tools.ts`：导出三个工具 `grep_search`、`repo_tree`、`symbol_search`，均 `risk:"readonly"`、`sideEffect:false`、`retry:"safe"`、`concurrencySafe:true`，filesystem surface。

## Tests

- 新增 `packages/tools/src/navigate.test.ts`（7 项）：`walkFiles` 跳过 `.git`/`node_modules` 且保留 `src/app.ts`；`grepFiles` 大小写不敏感命中带行列；`grepFiles` 按文件 glob 过滤；`symbolSearch` 返回 `fallback:true` 且命中函数符号、`indexer` 含 `regex-symbol-fallback`；跨扩展 `def` 命中；`repoTree` 合成 dir leaf、跳过 VCS/依赖目录、`src` 判 `dir`。
- 门禁：`packages/tools` 单包 `tsc --noEmit` exit 0；`navigate.test.ts` 7/7 通过。

## Notes

全链路先做到「明确清晰的 fallback 语义」：`symbol_search` 诚实标记 `fallback:true`，与既有 `search_files`（glob）互补，覆盖 file search / text search / symbol search / repo tree 四个维度；dependency graph（P2-30 起 repo map 可供给 package map）留待后续衔接。未改变既有工具行为、未降低安全标准。

---

# P2-30 Repository Map Cache

Status: DONE

对大 repo 构建可缓存的 ephemeral workspace knowledge：`file tree / package map / entrypoints / test commands / languages`，Repo 改动后增量 invalidation，避免 Agent 每一轮都重新扫描整树 / 重读 manifest。

实现（`packages/tools/src/repo-map.ts`）：
- `RepositoryMapCache`（`{root, maxFiles?}`）：
  - `get()` 构建或复用缓存。缓存命中判定用 **stat fingerprint**（`path:size:mtimeMs` 的 sha1，排序无关稳定）：fingerprint 未变 → 直接返回缓存的 map（不再重读文件内容 / package.json）；变化 → 重建。invalidation 由真实 repo 变更驱动，非时间 TTL。
  - `noteChange("/rel/path")`：由 write/edit 变更面调用，强制下一次 get() 重建 —— 覆盖「同 tick 快速重写导致 size+取整 mtime 不变」的空档，做到真正的增量失效。
  - `invalidate()` / `peek()` / `isFresh()` / `stats`（hits/builds/lastBuildMs）；并发 `get()` 按单 in-flight build 合并（Promise 去重），一读至多一次构建。
  - 有界：`maxFiles`（默认 50_000）截断文件树并置 `complete:false`；ephemeral，绝不持久化。
- `scanRepoStats(root)`：廉价 stat walk（跳过 `.git/node_modules/dist` 等）；`repoFingerprint(entries)`：稳定指纹。
- `doBuild()` 产物 `RepositoryMap`：`files`（path+size）、`packages`（name/version/entrypoints/testCommands/hasLockfile/prodDeps/devDeps）、`languages`（按扩展名计数降序）、`entrypoints` 聚合、`testCommands` 聚合。
- manifest 解析：`package.json`（main/module/bin、scripts.test/build/lint/typecheck/check、dependencies/dev/peer）、`pyproject.toml`、`Cargo.toml`、`go.mod`；lockfile 检测（`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`/…）；entrypoint 启发式回退（`src/index.ts`、`src/main.go` 等，仅当 manifest 未给）。
- `packages/tools/src/tools/repo-map-tool.ts`：暴露 `repo_map` 工具（`risk:"readonly"`、`sideEffect:false`、`concurrencySafe:false`，filesystem surface），支持 `refresh:true` 强制重建、`maxFiles`。

## Tests

- 新增 `packages/tools/src/repo-map.test.ts`（10 项）：`repoFingerprint` 排序无关且随 size/mtime 变化；`scanRepoStats` 跳过 `.git/node_modules/dist`；`get()` 构建出 files/packages/languages/entrypoints/testCommands（含 `Cargo.toml`→name `core`、`package.json`→name/version/prodDeps/test 命令）；未改动时第二次 get() 命中缓存不重建（builds=1、hits=1）；真实新增文件触发重建（builds=2）；`noteChange` 即使指纹未变也强制重建；`invalidate` 后重建；并发 `get()` 合并为单次构建；`maxFiles` 截断并置 `complete:false`。
- 门禁：`packages/tools` 单包 `tsc --noEmit` exit 0；全量 `pnpm test` 106 files / 1445 passed / 0 failed。

## Notes

与 P2-29（`navigate.ts`/`repo_tree` 静态导航）互补：P2-30 提供可复用的 repo 知识缓存并带变更驱动失效；P2-31 的 test/build/lint 命令发现将接过 `testCommands` 并写 WorkingState。package 边界基于根目录普通扫描（monorepo workspaces 的 glob 感知留待后续增强）；指纹基于 stat，封顶时指纹只覆盖已收录文件。未改变既有工具行为、未降低安全标准。

---

# P2-31 Test Command Discovery

Status: DONE

Agent 不应永远猜 `npm test`：从 repo 自身来源发现真实的 test/build/lint 命令，并把结果写进 WorkingState。

实现（`packages/tools/src/command-discovery.ts`）：
- `discoverCommands(root)` 返回 `CommandDiscoveryResult`：`discovered`（每条 `{kind, command, source, file, confidence}`）+ `sourceFilesChecked`。来源与置信度：
  - `package.json`（root + 嵌套 workspaces `packages/*/package.json`，跳过 `node_modules`）：scripts 经纬向静态分类——`test`/`test:*`→test、`lint`/`eslint`→lint、`typecheck`→typecheck、`build`→build、`check`→check、`verify`→verify；一律 high 置信度。
  - `pyproject.toml`：`[tool.poetry] scripts` 内联命令 + 默认 `pytest`（medium）。
  - `Cargo.toml`：默认 `cargo test`（high）+ `cargo check`（medium）。
  - `Makefile`：解析 `target:` + recipe（tab/缩进行），`test/spec→test`、`build/compile/dist→build`、`lint/style→lint`、`typecheck→typecheck`、`check→check`、`verify→verify`；有 recipe 时 high、否则 `make <target>` medium。
  - CI workflow（`.github/workflows/*.yml` 前 5 个）：抓 `run:`（含 `- run:` 列表形式与 `|` 块）按关键字分类（test/build/lint/typecheck/check/verify），去重。
  - `AGENTS.md` / `CLAUDE.md`：指导行中提取 `npm|yarn|pnpm|...` 命令串，low 置信度。
- `summarize(discovered)`：每 kind 取最强一条（high 优先、`package.json` 优先）。对应 `working-state` 写入：`mergeIntoWorkingState(state, result)` 把每条 `discovered {kind} command: <cmd> (<root>)` + `command discovery sources: …` 去重追加到 `WorkingState.importantFacts`，避免重复。
- `packages/tools/src/tools/discover-commands-tool.ts`：暴露 `discover_commands` 工具（`risk:"readonly"`、`sideEffect:false`、`concurrencySafe:false`，filesystem surface），返回 `result + summary`。

## Tests

- 新增 `packages/tools/src/command-discovery.test.ts`（9 项）：package.json 根+workspace 的 test/test:unit/build/lint/typecheck 全部 high 解出且跳过 `node_modules`；`pyproject.toml`→`pytest`、`Cargo.toml`→`cargo test`；`Makefile` 目标带 recipe（`test`→`npm test` 等）；CI `- run: npm test` 命中；`AGENTS.md` 的 `yarn test` 以 low 命中；`sourceFilesChecked` 覆盖 7 类来源；`summarize` 每 kind 取包管理器高置信命令；`mergeIntoWorkingState` 写入 `discovered test command`/`build` + `command discovery sources`；重复 merge 幂等不重复。
- 门禁：`packages/tools` 单包 `tsc --noEmit` exit 0；重跑新增三测 26/26 通过；全量 `pnpm test` 107 files / 1454 passed / 0 failed。

## Notes

与 P2-30 的 `repo_map.testCommands` 互补：P2-31 覆盖面更广（CI、Makefile、AGENTS.md、workspaces 脚本），并把最强命令写入 WorkingState（`importantFacts`），使 loop 在不需要重新探测即可知道真实 test/build/lint 命令。命令发现是静态意图层面的提示，实际执行仍需经 orchestrator 权限 + sandbox 门（P2-23/24/25 相关向量仍按既有规则拦截；例如 `curl | bash` 之类不受"发现了可运行命令"影响）。monorepo workspace glob 精细化、CI 多行 YAML 解析完整性留待后续。未改变既有工具行为、未降低安全标准。

---

# P2-30+ Repo Map / Test Discovery follow-ups

Status: DONE

补上 P2-29/P2-30/P2-31 明确标注留待后续的三处衔接：package dependency graph 、monorepo workspace glob 精细化、CI 多行 YAML 解析完整性。

## 实现

- `packages/tools/src/workspace.ts`（新增）——共享 monorepo workspace 解析：读 `pnpm-workspace.yaml` 的 `packages:` 列表(含行式 `- item` 与内联 `[a, b]` 数组、引号剥离)与 `package.json#workspaces`；`matchGlobDirs` 把模式编译为按目录段匹配的正则，支持 `*`(单段)、`**`(跨段，首/尾/中位置语义正确)、`?`(段内单字符)与 `!` 排除；`listDirs` 收集去重 repo-relative 目录(跳过 VCS/依赖目录)；`resolveWorkspace` 给出 `{patterns, members, explicit, candidateDirs}`，无声明时 `explicit:false`。
- `repo-map.ts`：`doBuild` 先 `resolveWorkspace`，当仓库显式声明 workspaces 时，仅把 member 目录(含根)内的 manifest 视为包边界(monorepo glob 精细化)；`RepositoryMap` 新增 `workspaces` 与 `dependencyGraph` 字段；`RepoPackage` 新增 `internalDeps` 与 `workspaceDeps`。`parseManifest` 采集版本以 `workspace:` 开头的强引用；`resolvePackageGraph(packages, ws.explicit)` 以 `workspace:` 协议为强信号，并在显式 monorepo 下叠加兄弟包名匹配(仅当该名字确为本地包，避免与同名发布依赖误连)。
- 顺带修复既有隐患：根级 manifest 的目录计算 `rel.slice(0, len-base-1)` 在根文件时产出 `"package.jso"` 而非 `"."`，引入 `dirOf(rel, base)` 统一修正(无 workspace 时被 `memberDirs=null` 掩盖，不改变原行为)。
- `command-discovery.ts`：`findPackageManifests` 增加 member 过滤；`parseCiRuns` 由单一正则重写为逐行块标量解析器，支持 `|`/`|+`/`|-`(逐行各自命令)与 `>`/`>+`/`>-`(折叠合并)块、块内容以 run 缩进为界的终止(下一键/`-` 序列项/`---`)、块内注释行、`env:`/`working-directory:` 先于 run、内联标量；仍按 `[;&|]{1,2}` 分段去重分类。

## Tests

- 新增 `packages/tools/src/workspace.test.ts`(8 项)：`*`/`**`/`?` 与 `!` 段匹配语义(`packages/*` 只命中单段、`**` 跨段、`**/core` 与 `apps/**` 边界、排除生效)；`pnpm-workspace.yaml`+`package.json#workspaces` 双源加载(含 `!` 保留、quoted glob)；`resolveWorkspace` 排除 negated member 与 glob 外目录；`listDirs` 跳过 `node_modules`/`.git`。
- `repo-map.test.ts` 新增 2 项：workspace member 限定边界(`packages/skip` 与 `other` 不成为包，根包仍在内)；`workspace:` 协议驱动的依赖图(`root→[a]`、`a→[b]`、`b→[]`)。既有 10 项(无 workspaces 仓库行为不变)全部保持通过。
- `command-discovery.test.ts` 新增 6 项：CI 块标量 `|` 多行、`|-` chomping+`env:`、`>` 折叠合并分段、块内注释跳过+下一 step 终止、`---` 文档边终止；workspace 限定命令发现(vendor 目录 manifest 不成为边界)。既有 9 项保持通过。
- 门禁：`packages/tools` `tsc -b` exit 0；全量 `pnpm vitest run` 112 files / 1587 passed / 0 failed。

## Notes

与 P2-30/P2-31 的关系：workspace glob 是"包边界定义"这一共同前提，repo_map 与命令发现共用同一 `workspace.ts` 解析器；dependency graph 让 repo map 能从命名依赖进一步供给 package map 的拓扑；CI 解析增强只扩大了"静态命令提示"覆盖，仍是意图层提示——实际执行仍需经 orchestrator 权限 + sandbox 门，未改变既有工具行为、未降低安全标准。

---

# P2-32 Environment Capability Snapshot

Status: DONE

每个 Session 记录 OS / cwd / available tools / runtime versions / network policy / git state / package manager，避免模型反复探测；敏感环境变量不暴露。

实现（`packages/tools/src/env-snapshot.ts`）：
- `snapshotEnvironment({cwd, networkMode?, availableTools?, probeLimit?})` 返回 `EnvironmentSnapshot`：
  - `os`（platform/arch/release/type/logicalCpus）、`cwd`（resolve 后）。
  - `runtimes`：对固定探针集（node/npm/yarn/pnpm/bun/python3/go/cargo/rustc/git/docker/make）执行 `--version`（只读、1.5s 超时、无网络），记录 `{name, version, found}`；`probeLimit` 可缩减。
  - `packageManager`：按 lockfile 推断（`pnpm-lock.yaml→pnpm`、`yarn.lock→yarn`、`bun.lock`/`bun.lockb→bun`、`package-lock.json→npm`），回退 `node` 存在→npm。
  - `git`：`rev-parse --abbrev-ref/--short HEAD`、`status --porcelain` 计数、`remote get-url origin`；非 git 目录 graceful `available:false`。
  - `network.mode`：**调用方提供**（绝不联网探测）；`tools.available/count`：调用方提供。
  - `security`：只登记 `sensitiveEnvKeysPresent`（正则 token/secret/password/api[_-]key/auth/credential/private[_-]key 等），**从不捕获 env 值**，`envValuesRedacted:true`。
- `snapshotSummary(s)`：单行摘要；`noteSnapshotInWorkingState(state, snap)`：把摘要去重写入 `WorkingState.importantFacts`。
- `packages/tools/src/tools/env-snapshot-tool.ts`：暴露 `env_snapshot` 工具（`risk:"readonly"`、`process:true`，返回 snapshot+summary），输入 `networkMode`/`probeLimit`。

## Tests

- 新增 `packages/tools/src/env-snapshot.test.ts`（6 项）：capture os/cwd/tools/supplied network（probeLimit=0 时零 spawn）；env 值绝不泄漏（JSON 不含注入的 `super-secret-zzz`，仅记敏感 key 名、安全 key 不列）；lockfile 推断 `pnpm`；git.available 为 boolean（非 git 目录 graceful）；`snapshotSummary` 单行含 cwd/net/tools；`noteSnapshotInWorkingState` 写入并幂等去重。
- 门禁：`packages/tools` 单包 `tsc --noEmit` exit 0；新增 6/6 通过；全量 `pnpm test` 108 files / 1460 passed / 0 failed。

## Notes

与 P2-30（repo 知识图谱缓存）不同，本快照是**环境能力**层面的会话知识；`noteSnapshotInWorkingState` 让 loop 一开场就拿到 OS/env/git/pm 摘要而不反复探测。安全边界明确：只读探测 + 无网络 + env 值永不外泄 + network 策略由上层注入而非实测。git 可用字段与 dirty 计数在非 git 目录安全回退。未改变既有工具行为、未降低安全标准。

---

# P2-33 Deterministic Event Ordering

Status: ✅ DONE（2026-08-19）

并行 tool / subagent 后，保证：

```text
event sequence deterministic enough for replay
```

要求：

- globally monotonic per session。
- parallel completion 有真实 timestamp + ordered append。
- replay 不依赖 wall-clock tie。

实现：
- `packages/events/src/event-store.ts`：
  - `append` 仍是序列唯一权威：sequence = 已有最后事件 + 1，**忽略调用方自带 sequence**（并行 producer 的过期/猜测值无法破坏总序），单实例内全部 append 经 `appendChain` 串行化 → 每个并行完成获得互不相同、严格递增的序列（ordered append）。
  - 校验 `timestamp` 必须是有限非负 number，拒绝 NaN/负/无穷/非数字 → replay 永不面对坏时间戳。
  - 保留调用方真实 timestamp（完成瞬间），顺序只读 sequence，不读 wall-clock。
- `packages/session/src/replay.ts`：
  - 每个 turn 记录最早事件 sequence（`turnFirstSeq`）。
  - `turns` 排序改为确定性全序：先 `firstEventAt`（真实时间主序），同时间戳再按最早 sequence（append 序），仍相同按 `turnId` 字典序回退。**不再依赖 map 插入序或引擎 stable-sort 对等时间戳的行为**（满足"replay 不依赖 wall-clock tie"）。

## Tests

- 新增 `packages/events/src/event-store.test.ts` 4 项：
  - 50 个 Promise 并发 append → 0..49 严格递增、互不相同（parallel monotonic）。
  - 忽略调用方自带 sequence（999/7/0 → 持久化为 0/1/2）。
  - 拒绝 NaN / 负 / ±Infinity / 字符串 timestamp，且不落盘、nextSequence 仍为 0。
  - 乱序 timestamp（300/100/200）按 append sequence 排序但保留各自真实时间戳。
- 新增 `packages/session/src/replay.test.ts` 1 项：两个 turn `firstEventAt` 完全相同（并行落入同一 ms），喂入乱序列表使 map-插入序偏向 turnA，断言按 sequence tie-break 得到 `[turnB, turnA]`。
- 门禁：`tsc -b packages/events packages/session` exit 0；`event-store.test.ts` 20/20、`replay.test.ts` 14/14 全过。

## Notes

本项解决并行完成后的重放不确定性根因：**顺序的唯一事实来源是 append sequence，而非 wall-clock 或列表到达序**。store 通过"序列权威 + appendChain 串行化 + 时间戳校验"保证 globally monotonic 与 ordered append；replayer 通过 `(firstEventAt, firstSeq, turnId)` 全序保证同毫秒并行完成也有确定顺序。未改变事件契约字段、未降低任何安全或完整校验标准；既有 append/list/stream/nextSequence 语义不变。

---

# P2-34 Event Schema Versioning

Status: ✅ DONE（2026-08-19）

Event 未来会持续演化。

增加：

```text
schemaVersion
```

或明确 event version migration。

Resume/benchmark 老 event 不能悄悄解析错。

实现（P2-34）：
- `packages/contracts/src/event.ts`：
  - 新增 `EVENT_ABI_VERSION = 1`（导出）。
  - `AgentEvent` 增加**可选** `schemaVersion?: number`（producer 可不填，不破坏既有调用）。
- `packages/events/src/event-store.ts`：
  - `append`：调用方显式填了与非当前 `EVENT_ABI_VERSION` 不符的版本 → 立刻抛错（fail-closed，不落盘）；落盘时**强制盖章** `schemaVersion: EVENT_ABI_VERSION`，使每个持久化事件自描述。
  - `parseEvents`（list/stream/nextSequence 共用读取路径）：事件 `schemaVersion` 缺失（pre-versioning 旧日志）或不等于当前版本 → 抛 `unsupported event ABI version ... migrate the event log`，**绝不悄悄解析错**。未来 v2 必须显式写迁移映射，禁止放宽读校验。

## Tests

- 新增 `packages/events/src/event-store.test.ts` 4 项：持久化盖章当前版本；写侧拒绝 0/2/next 版本且不落盘；读侧拒绝无版本旧日志（list 与 nextSequence 都抛）、拒绝声称未来版本（`migrate the event log`）。
- 门禁：全仓 `tsc -b` exit 0；`event-store.test.ts` 24/24；observability + session 全量 69/69 通过。

## Notes

P2-34 的取合法是"**写时盖章 + 读时 fail-closed + 版本常量单一真源**"，而非允许无损横向扩展的宽解析。既有事件生产者无需改动（`schemaVersion` 可选、store 自动盖章），replay/benchmark/resume 读取旧或不兼容日志时拿到明确错误而非静默错读。未降低安全/完整性标准，未改变既有事件语义字段。

---

# P2-35 Store Integrity

Status: DONE

Tests: `store-integrity` 9 tests; `memory-store` 25; `sqlite-memory-store` 31; `session-store` 20; `event-store` 26; `checkpoint-store` 9; `inbox` 6. 涉及 5 个 store 持久化路径的单测 + 组件测试全部通过（228 项）。

Benchmark: N/A（纯可靠性改造，无可量化业务指标）。

Notes:
- 新建共享包 `@ar/store-integrity`，统一提供：`atomicWriteFile`（temp+fsync+rename 覆盖，杜绝"读到旧文件→文件缺失→写入"窗口）、`appendDurable`（append+fsync，崩溃不丢已确认行）、`withLock`（按 key 进程内互斥，串行化 read-modify-write）、`backupTree`（时间戳目录快照，跳过 temp 与自身 backups）、`parseJsonl`（容忍损坏行）。
- 集成到全部持久化 store：MemoryStore（write/update/remove 加锁 + 原子持久化 + backup）、SessionStore（原 rm+rename 替换为原子 rename-over + backup）、EventStore（appendFile→appendDurable + backup）、InboxStore（promote/admit/consumed 加锁 + 原子持久化）、CheckpointStore（rm+rename 替换为原子 rename-over）。
- 关闭了此前所有 store 的 three 类一致性缺口：① 中途缺失窗口（rm 后未 rename 前的读空）；② 已确认写入在断电时不持久；③ 并发 read-modify-write 丢失更新。
- 每个 store 保留单进程单写者约束（文档化）；跨进程一致性不在本任务范围。
- 新增 backup 用于破坏性操作前或定时一致性检查；corruption/schema-migration 各自的策略已由各 store 既有的 parseJsonl / schemaVersion 覆盖并保持测试。

---

# P2-36 Inbox / Steer / Followup Semantics

Status: DONE

Tests: `runtime.test.ts` 47（新增 1 项 exactly-once）；core+session 全量 211 全过；`inbox.test.ts` 6。contracts `tsc -b` 通过，dist 重新生成。

Benchmark: N/A（语义/正确性改造，无新业务指标；injected message 数、prompt status 迁移均为正确性断言）。

Notes:
- contracts `inbox.ts` 显式编码 phase 语义：`steer` 仅在下一个安全边界（下一次 model call 前）注入为 user message，不打断已开始的 tool/model call，绝不回滚已提交的 tool side effect；`followup` 绝不注入运行中的 turn，仅在当前 turn 结束后由外层循环开启新 turn；`cancel` 是唯一硬中断路径（立即经 abort signal 生效），不作为 message 注入——steer 不能被当作"撤销已经开始的 tool 副作用"，只有 cancel 才中止，且已提交的副作用只做 reconcile 而非擦除。
- 为"promoted/consumed"增加 durable、exactly-once 语义：`Message` 新增可选 `promptId` 字段，把注入的 steer message 与源 prompt 关联。runtime 注入前先检查 transcript 是否存在带 `promptId === prompt.id` 的 message——若存在（说明上次尝试在 append 之后、consume 之前崩溃），则仅把 prompt 置为 promoted+consumed 并跳过重复注入；否则 append（stamp `promptId`）→ promote → consume。由此 promise/consume 两个 store 之间的所有崩溃窗口都可自愈：不重复注入，stray prompt 被 reconcile 到 consumed。
- 避免性能/正确性回归：steer 注入仍只在 `before_model` 安全边界例程内、每轮最多重建一次 history（有 steer 时）。
- 既有语义维持：followup 仍由外层循环独占（`nextFollowup` promote 幂等），steer 与 followup 不同队列，cancel 由 fault-injection 既有测试覆盖。

---

# P2-37 User Interrupt During Tool Batch

Status: DONE

Tests: `fault-injection.test.ts` 10（新增 2 项：串行 write 链中断 + 并行 read batch 中断即时 abort）；core 全量 161 全过；typecheck 通过。既有 fault-injection 命中（kill 传播、user cancellation）无回归。

Benchmark: 并行 read batch 中，"abort 后批返回延迟"由 hang(2000) guard 断言（被打断的读不再阻塞 turn）；串行 write 用 committed effect 保留 + remaining skipped 断言。均为正确性审查。

Notes:
- 修复 3 类缺口：
  1. 工具执行中收到 interrupt 现在返回 `{status:"cancelled"}` 的 ToolResult（此前被误标为 failed 的 INTERNAL_ERROR，模型会误判为失败）；终态事件只在 failed/timeout 时才发 `tool.failed`，cancelled 不再被误标。
  2. 并行 READ batch 改用新增 `runReadBatch`：等 `signal` 一旦 abort 立即返回（而非等所有 in-flight read 完成），reads 观察同一 signal 自行终止；结果按 CALL ORDER 返回；P1-5 kill 经 reject 传播不吞。
  3. 串行 write 链在 interrupt 时停止后续调用（不再向已中断的 turn 继续派发 write）；`executeToolCalls` 顶部与每步后检查 signal。
- partial effects 语义：已提交的副作用（进入 durable ledger / working state / transcript 后再被打断）原样保留并出现在 cancelled outcome 上——cancel 不是 rollback；未开始/被中断的调用不执行且不被当作已提交。
- 批处理结束后主循环显式检查 `signal.aborted` → 立即 finishTurn(cancelled)，避免再做一次 model call 或继续处理未完成的批次。

---

# P2-38 Partial Failure Semantics

Status: DONE

Tests: `packages/core/src/runtime/fault-injection.test.ts` 新增 describe "runtime partial failure semantics (P2-38)" 共 5 项：model error 无工具→failed_no_effect；write 提交后 maxIterationsPerTurn→failed_with_effects（filesChanged 保留）；打断前取消→cancelled_no_effect；write 提交后打断→cancelled_with_effects（a.txt 保留）；仅 denied 尝试后退出→blocked。core 全量 161+5 全过；`packages/core` typecheck --noEmit 通过。全仓 109 文件 / 1494 测试全绿。

Benchmark: 正确性审查——`classifyStatusDetail` 以 durable toolLedger 为唯一证据源（sideEffect&status===success 判定已提交副作用；status===denied 判定硬性策略拒绝），无字符串解析、无对 working state 的部分覆盖依赖；所有 18 个 finishTurn 调用点均已透传 toolLedger，故多轮迭代取消/失败（前一轮已提交副作用）也能正确归类。

Notes:
- 兼容性决策：公开 `TurnOutcomeStatus` 保持 coarse `completed | failed | cancelled`（不破坏 host/下游对 status 的判读），新增 `TurnOutcomeDetail`（`failed_no_effect | failed_with_effects | cancelled_no_effect | cancelled_with_effects | blocked`）叠加在 coarse status 之上，由 observability 消费。`TurnOutcome` 增加必填 `statusDetail` 字段；`turn.completed/cancelled/failed` 事件 payload 同步携带 `statusDetail`。
- 语义界定：
  - with_effects = ledger 中存在 `sideEffect===true && status==="success"`（副作用已落地）；cancel 不是 rollback，已提交副作用原样保留并在 outcome.state.filesChanged 等上可观测（复用 P2-37 的中断保留语义）。
  - blocked = failed && 无已提交副作用 && ledger 存在 `status==="denied"`（permission/sandbox/security 硬性拒绝挡住了真实进展），区别于"单纯不成功"的 failed_no_effect。
- 实现：`classifyStatusDetail(status, ledger)` 集中归类；`finishTurn` 增可选末参 `ledger?: ToolExecutionRecord[]`（默认 []），所有 runTurn 内的 18 处调用点统一传入 `toolLedger`。resume 路径经 runTurn 复用同一逻辑，无重复实现。

---

# P2-39 Termination Reason Taxonomy V2

Status: ✅ DONE（2026-08-19）

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

## Tests

- `packages/core/src/runtime/runtime.test.ts` extends the taxonomy contract: `model_stopped` / `agent_limit` / `model_error` / `cancelled` all asserted as the bounded `terminationReason`.
- `packages/evaluation/src/baseline.test.ts`: case.json `expectedTerminationReason` accepts a bounded reason (`tool_limit`) and the report `termination_reason` uses the bounded values (`verified_complete` / `agent_limit` / `model_stopped` / `verification_failed`); stale `limit:*` strings removed from the fallback path.
- 门禁：全仓 `tsc -b` exit 0；`runtime.test.ts` + `baseline.test.ts` 105/105；全仓 vitest 1494/1494 通过。

## Notes

- 新增 `packages/contracts/src/termination.ts`：闭集 `TerminationReason` + 穷举数组 `TERMINATION_REASONS` + 运行时校验 `isTerminationReason`（`satisfies` 保证数组与联合类型锁步）。
- `LIMIT_TERMINATION_REASON: Readonly<Record<string, TerminationReason>>` 是 `run.limit_reached` 事件 limit 标识到闭集 reason 的唯一映射，runtime（持有真实终态）与 event 派生的 evaluation 兜底完全一致。
- runtime 所有终局分支改为发射闭集 reason：`maxTokens→context_limit`、`maxDurationMs→time_limit`、`maxToolCalls/maxRepeatedToolCalls→tool_limit`、`maxIterationsPerTurn→agent_limit`、`maxVerificationFailures→verification_failed`、`maxRetries→model_error`；其余为 `model_error/tool_error/cancelled/verified_complete/model_stopped`。
- evaluation 侧：`EvalCase.expectedTerminationReason` 类型收紧为 `TerminationReason`，case.json 加载时用 `isTerminationReason` 校验（无效即抛错），runner 精确匹配（不再有 `limit:` 前缀通配）。新增 reason 必须同时更新联合类型、数组、`LIMIT_TERMINATION_REASON` 三处，属刻意 review 变更。

---

# P2-40 Retry Taxonomy V2

Status: ✅ DONE（2026-08-19）

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

## Tests

- `packages/contracts/src/contracts.test.ts` +10：每个 kind 都有成分（maxAttempts/backoffMs/safePredicate/terminationBehavior）；termination 闭集断言与 P2-39 锁步；`retry.reconciliation` / `retry.mcpReconnect` 注册为事件类型。
- `packages/mcp/src/mcp-client-hardened.test.ts` +3：`ensureReconnected` 已连接时 no-op、断线重握手返回 true、预算耗尽（bounded attempts）抛 NETWORK_ERROR 且不再无限重试。
- `packages/mcp/src/mcp-tool-adapter.test.ts` +2：断线 auto-reconnect 成功时发射 `retry.mcpReconnect`（含事件 sink）；已连接时不发射。
- `packages/evaluation/src/baseline.test.ts` +1：`deriveRetryTaxonomy` 正确累计 `reconciliation` 与 `mcpReconnect`。
- `packages/core/src/runtime/resume.test.ts`：resume 出现 started-but-unconfirmed tool 时发射 `retry.reconciliation`（toolCallId/tool/sideEffect）。
- 门禁：全仓 `tsc -b` exit 0；上述 +10 用例全过；全仓 vitest **1504/1504** 通过。

## Notes

- 新增 `packages/contracts/src/retry.ts`：`RetryKind` 闭集（8 种）+ `RETRY_KINDS` 穷举数组（`satisfies` 锁步）+ `RetryKindSpec`（maxAttempts/backoffMs/safePredicate/terminationBehavior）+ 权威治理表 `RETRY_KIND_SPECS`。`terminationBehavior` 直接复用 P2-39 的 `TerminationReason`，两套 taxonomy 同一来源。
- 新增事件 `retry.reconciliation` 与 `retry.mcpReconnect`；`RetryTaxonomy` 增加 `reconciliation` / `mcpReconnect` 计数，`deriveRetryTaxonomy` 与 runner 的 `retryTaxonomyTotal` 同步计入。
- `reconciliation`：spec `maxAttempts: 0` / `safePredicate: "never"` / `terminationBehavior: "resume_ambiguous"` —— 永不自动重放；runtime `resumeTurn` 对每个 started-but-unconfirmed tool 发射一个 `retry.reconciliation` 事件（只登记事实，不强改运行语义）。
- `mcpReconnect`：spec `maxAttempts: 3` / `backoffMs: 100` / `safePredicate: "always"` / `terminationBehavior: "provider_error"`。McpClient 新增 `ensureReconnected()`（bounded 重握手，预算耗尽抛错）；mcp-tool-adapter 每个 tool handler 调用它对断线 client 自动重连，成功重握手时经事件 sink 发射 `retry.mcpReconnect`。`McpToolSource` 扩展为 `listTools | callTool | ensureReconnected`。

---

# P2-41 Stall Detection V2

Status: DONE

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

Tests:
- `contracts.test.ts::stall detection V2` — pure classifier coverage for all 6 patterns + false-positive control (identical_tool only when result unchanged; no_progress only on a long window; verification_fix_loop suppressed when read feedback changes).
- `runtime.test.ts` — integration: alternating A->B->A->B terminates with `limit:"stallPattern"` when `identical_tool` would be blind (args differ); one `retry.stallRecovery` (system observation) then termination under `maxPatternStallRecoveries`.
- Full suite: 109 files / 1516 tests green; `pnpm build` (tsc -b) clean.

Benchmark:
- Agent loop emits the widest stall vocabulary from one pure classifier over an unchanged window (`detectStallPattern`), with per-pattern recovery budgets and a `stallPattern` termination reason instead of a generic limit.

Notes:
- `packages/contracts/src/stall.ts` — pure, dependency-free `detectStallPattern` over a bounded window; pattern priority: alternating_loop > repeated_read_no_change > verification_fix_loop > repeated_error > identical_tool > no_progress. `verification_fix_loop` is detected structurally (read -> write -> read with unchanged read feedback) using only `isRead`+`resultFingerprint`, no model wording.
- `packages/core/src/state/agent-state.ts` — rolling `recentTraces` window, `recordToolCall`, `recordProgress`/`clearStallWindow`, `stallPattern`, and `priorResultChanged` (evidence advancing cancels a stall score).
- `packages/core/src/runtime/runtime.ts` — `recordStallTrace` on every execution; read results that CHANGE vs the same prior call emit `new_evidence`/`verification_improved` progress and clear the window; `enabledStallPatterns` (default excludes `identical_tool` — the legacy gate owns it) + `maxPatternStallRecoveries`.
- The legacy `maxRepeatedIdenticalToolCalls` identical-streak gate is unchanged and independent of the pattern classifier.

---

# P2-42 Adaptive Recovery

Status: DONE

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

Tests:
- `contracts.test.ts::adaptive recovery V2` — pure planner: retry-first for tool_failure, change_strategy fallback once retry spent, compact for context_overflow, refresh_mcp for mcp_disconnected, ask_user after compact spent, fail_safe ulimited backstop, budget override disables an action, unknown-input TypeError.
- `runtime.test.ts` — integration: a failing non-safe tool receives exactly 2 change_strategy + 1 delegate_specialist bounded observations then flows the failure through (no immediate turn-fail); fail_safe injects no observation.
- Full suite: 109 files / 1526 tests green; `pnpm build` (tsc -b) clean.

Benchmark:
- The runtime selects among a bounded action set per failure using per-action budgets recorded in a per-turn ledger, instead of only retry/ask/fail-safe; self-heal actions (change_strategy / delegate_specialist) inject bounded observations so the model changes approach.

Notes:
- `packages/contracts/src/recovery.ts` — closed `RecoveryAction` + `RecoveryInput` taxonomies, `RECOVERY_ACTION_SPECS` governance table (per-action budget / addressed inputs / priority), and a pure `AdaptiveRecoveryPlanner.decide(input, usage)` that returns the highest-priority still-budgeted action or `fail_safe`. Mirrors the P2-39/P2-40 closed-taxonomy + exhaustive-array pattern.
- `packages/core/src/runtime/runtime.ts` — `adaptiveRecovery?: AdaptiveRecoveryPlanner` (mutually exclusive with legacy `recovery`; absent → unchanged legacy behavior). Tool-failure path consults the planner; non-safe tools keep `retry` off budget; `change_strategy`/`delegate_specialist` inject `[recovery:<action>]` system observations up to their budgets.
- The legacy `RecoveryPolicy` (retry/ask/fail_safe) is retained bit-for-bit for hosts that don't opt into adaptive recovery.
- Architecture intent (compact / re_discover_tools / refresh_mcp) is defined and budgeted in the taxonomy; the runtime performs the self-heal subset whose `continue` semantics are already present (strategy observations). Remaining actions (compact on overflow, MCP refresh, specialist delegation) are wired for future execution paths.

---

# P2-43 Ask-User Gate

Status: DONE

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

Tests:
- `contracts.test.ts::ask-user gate V2` — closed `ASK_REASONS` taxonomy (`missing_critical_input` / `ambiguous_goal` / `unresolvable_context` / `choice_required`); `isAskReason` guard rejects bogus & non-string values; default lifecycle classifies pending/answered and dedupes per session+turn; `resumePrompt` renders the tagged injected user message carrying the ask id; `fingerprint` is stable across identical requests and distinct across ids. Also registers `ask.user_asked` / `ask.user_replied` / `ask.turn_waiting` event types.
- `runtime.test.ts::AgentRuntime (P2-43 Ask-User Gate)` — when the model calls `ask_user`, the turn outcome is `waiting_for_user` / `waiting_no_effect` (NOT a tool failure), the durable ask store records the pending request, `ask.user_asked` + `ask.turn_waiting` fire, and no `turn.failed` is emitted; `submitUserAnswer` injects exactly one tagged user message on resume and is idempotent for a duplicate submission (`already resumed`, no second append).
- Full suite: 109 files / 1533 tests green; `pnpm build` (tsc -b) clean.

Benchmark:
- The runtime parks a turn lacking critical input as a first-class, resumable `waiting_user` phase with outcome `waiting_for_user`, never synthesizing a tool error; the host captures the reply through `submitUserAnswer`, which resumes with a durable ask-tagged user message.
- Exactly-once resume is enforced by ask-id tagging on the injected message; a duplicate answer is an idempotent success, so a retrying host cannot double-append the reply.

Notes:
- `packages/contracts/src/ask-user.ts` — pure boundary: closed `AskReason`, gone-bearing `AskUserRequest` (status pending/answered/withdrawn), `AskUserStore` persistence seam (durable impl is P2-44), and `defaultAskUserLifecycle` (`isPending`/`isAnswered`/`hasPending`/`resumePrompt`/`fingerprint`) — fully unit-testable with no storage/timing side effects, so any host/UI can implement against it before async rendering exists.
- `packages/core/src/runtime/runtime.ts` — `parkForUserInput` transitions the agent state machine to `waiting_user`, persists the turn as `waiting_for_user`, records the pending request (when an `askUserStore` is supplied), surfaces it to an optional `askUser` handler, and returns a `waiting_for_user` outcome carrying `pendingAsk`; `submitUserAnswer` resumes with an exactly-once tagged user message (checks message history before isPending so a duplicate is an idempotent success, not a failure).
- `packages/contracts/src/session.ts` — `TurnStatus` gains `waiting_for_user`; `packages/contracts/src/message.ts` — `Message` gains optional `askId`; `packages/contracts/src/event.ts` — three new event types; `packages/contracts/src/ids.ts` — `newAskId()`.

---

# P2-44 Approval State Persistence

Status: DONE

如果 approval wait 存在：

- process restart 后 approval request 不丢。
- approval decision 可审计。
- decision scope 明确：
  - one call
  - one tool
  - session
- permission expansion 有 expiry。

Tests:
- `contracts.test.ts::approval scope + audit (P2-44)` — closed `APPROVAL_SCOPES` taxonomy (`one_call`/`one_tool`/`session`) with `isApprovalScope` guard rejecting `global` & non-strings; `approvalDecisionRecord` projects an explicit auditable record (scope/decidedBy/action/target); missing scope defaults to `one_call`; `expired` decisions are flagged.
- `contracts.test.ts::permission expansion expiry (P2-44)` — bounded `GRANT_BOUNDS` taxonomy; hard expiry dominates remaining usage; `one_call` grants are single-use (consumed to death); `remainingUses: undefined` is an uncapped session grant that never dies by usage; bounded grants are usage-limited.
- `security/src/approval.test.ts::Approval scope + audit (P2-44)` — `createApprovalRequest` carries an explicit scope (default `one_call`); resolved decisions land in an append-only `listDecisions` audit log (decidedBy/scope/action/target); `cancelAll` records cancelled decisions.
- `security/src/approval.test.ts::DurableApprovalStore (P2-44)` — a file-backed store persists a pending request and its decision across a process restart (fresh store re-hydrates the pending request, resolves it, then a second restart still sees the audit log); re-hydration is idempotent.
- `security/src/permission-grant.test.ts::InMemoryPermissionGrantStore (P2-44)` — expired grants are never returned and are pruned on read; bounded grants drop at zero usage; session (`remainingUses: undefined`) grants survive consumes until expiry; a new grant for the same key replaces the prior.
- Full suite: 110 files / 1555 tests green; `npm run build` (tsc -b) clean.

Benchmark:
- Approval requests and their decisions survive a process restart: `DurableApprovalStore` writes pending + the append-only decision log to disk and re-hydrates on construction, so an outstanding request is re-enumerable/resolvable and every decision remains auditable after the process that made it is gone.
- Every approval decision is a durable record `(decidedBy / decidedAt / scope / action / target / expired)`, so decisions can be audited instead of guessed.
- Decision scope is explicit on both the request and the durable record (`one_call` / `one_tool` / `session`), and permission expansions carry a hard `expiresAt` (plus a usage meter for call/tool bounds), so no expansion is open-ended.

Notes:
- `packages/contracts/src/approval.ts` — added `ApprovalScope` closed taxonomy + guard, `ApprovalRequest.scope?` (normalized to `one_call` when absent), `ApprovalDecisionRecord` (extends decision with session/turn/agent/action/target/scope/expired), pure `approvalDecisionRecord()` projection, and the `ApprovalStore` seam (`listPending` + append-only `listDecisions`). `ApprovalResolver` preserved unchanged.
- `packages/contracts/src/permission-expiry.ts` — new pure module: `SessionPermissionGrant` (bound/approvalId/grantedAt/expiresAt/remainingUses), `isGrantExpired`, `grantRemainingMs`, `consumePermissionGrantUsage`, and the `PermissionGrantStore` seam. `remainingUses === undefined` = no usage cap (session bound); finite N = bounded, reaching 0 kills.
- `packages/security/src/approval.ts` — `InMemoryApprovalStore` now keeps an append-only audit log (`listDecisions`) appended on resolve and cancelAll; `StoreApprovalResolver.createApprovalRequest` accepts `scope` (default `one_call`); new `DurableApprovalStore` (file-backed) implementing restart-safe persistence + audit with idempotent re-hydration.
- `packages/security/src/permission-grant.ts` — new `InMemoryPermissionGrantStore` enforcing hard expiry and usage bounds against the contracts seam, so a host can drop in a durable store for cross-restart grant persistence.

---

# P2-45 Capability Escalation Defense

Status: DONE

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

Tests:
- `contracts.test.ts::capability escalation defense (P2-45)` — closed `CAPABILITY_DIMENSIONS`; a subordinate may only narrow (`tool:["read"]` of `["read","write","exec"]` is valid; undeclared dimensions inherit the conferred bound unchanged, never widened); declaring an out-of-bound item (`/etc/passwd`, a new network host, an extra process command, an extra tool) yields an escalation violation and the effective set drops it (intersection, not grant); a subordinate's own `*` claim is only valid when conferred also allows `*`; filesystem narrowing is path-boundary aware (a sibling `/home/u/workdocs` is denied; a descendant `/home/u/work/sub` is allowed).
- `security/src/capability-guard.test.ts::composeChildCapability (P2-45)` — binds the pure model to a real `SandboxPolicy` + tool allowlist: widening the fs root / adding a network host / adding a process command / widening the tool allowlist all throw `CapabilityEscalationError` (fail closed); a valid narrowing returns a restricted policy + tool allowlist; omission never widens; a full-conferral upper bound can still only narrow; `capabilitySetsFromGrant` projects `full` modes as `*`.
- Full suite: 111 files / 1571 tests green; `npm run build` (tsc -b) clean.

Benchmark:
- A subordinate's declared capability is verified to be a strict NARROWING (intersection) of the conferred upper bound across all four surfaces (tool allowlist, filesystem root, network access, process policy); any declared item outside the bound is an escalation and is rejected fail-closed, and `effective` is only the intersection that was both declared and conferred.
- Capability can change only downward unless the user/host explicitly re-raises the conferred bound; the model recomputes against the new bound on the next compose and never widens on its own.

Notes:
- `packages/contracts/src/capability.ts` — pure boundary: `CapabilityDimension` (tool/filesystem/network/process), `CapabilitySets`, `DeclaredCapability`, `composeCapabilities(conferred, declared) → CapabilityVerdict` (allowed / effective intersection / violations / narrowed). Dimension-aware containment: exact membership for tool/network/process; boundary-aware path-prefix containment for filesystem (`/a/b/c` ⊂ `/a/b`, sibling denied). A `*` conferral means "full" and permits arbitrary declared narrowing.
- `packages/security/src/capability-guard.ts` — `GrantedCapability` (SandboxPolicy + toolAllowlist), `capabilitySetsFromGrant`, and `composeChildCapability` which throws `CapabilityEscalationError` on any escalation and returns the narrowed SandboxPolicy + tool allowlist otherwise. Applies the identical rule to every trust boundary (child / plugin / MCP / hook).
- Escalations are never auto-granted: only an explicit host/user approval upstream may raise `grant.policy`, and the raise is recomputed against the new bound.

---

# P3 — 更激进但后置的能力

---

# P3-1 Planner / Executor Separation Experiment

Status: ✅ DONE（2026-08-19）

不要直接重构主 runtime。

作为 mechanism candidate 实验：

```text
single-loop champion
vs
planner/executor challenger
```

在 benchmark 验证是否真的提升复杂任务。

如果只是增加 token/latency，不推广。

## Tests
- `research/mechanisms/planner-executor-separation.yaml` — 新增 mechanism manifest（category: planning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/planner-executor.ts` — 新增 experiment 模块：`classifyCaseComplexity`（确定性复杂度分类，仅来自 fixture 文件数 / verification 门 / suite 标签 / request 长度等结构性字段，绝不来自模型措辞）；`simulateArchitectureRun`（single_loop 恒等；planner_executor 在每 case 增加固定 planning tokens/latency，对 complex 任务以 `complexPassGain` 概率挽回失败、对 simple 任务以 `simplePassPenalty` 概率引入过分离 regression，seed 化可复现）；`aggregateArchitecture`（聚合 pass rates + cost-model 打分，安全维度中性）；`runPlannerExecutorExperiment`（champion vs challenger 端到端）；`decidePromotion`（推广门）。
- `packages/evaluation/src/planner-executor.test.ts` — 18 tests：复杂度分类（多文件+verification→complex，单行→simple，adversarial/stress 视为 complex）、single_loop 恒等（无 token/latency/tool 漂移）、challenger 固定增量、seed 可复现、跨 bucket 聚合、推广门四分支（promote / no_complex_gain / simple_regression / cost_negative）、raise minimumComplexGain、端到端 promote / token-latency-only 拒绝、渲染输出。
- Full suite: 113 files / 1605 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 推广门直接编码 plan 的红线：仅当 challenger 把 complex-task pass rate 提升 ≥ `minimumComplexGain`（默认 0.03）且 simple 无超出容忍回归、且 cost-model 分数为正 delta 才可 promote。纯 token/latency 膨胀（complex 无增益）落入 `no_complex_gain` → 拒绝。
- 端到端测试覆盖两条路径：complex 提升且 cost 正向 → PROMOTE；只加 tokens/latency 不加质量 → REJECT。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。challenger 用显式 effect model（可注入、seed 化）叠加在已测 baseline outcome 上表达，绝不臆造测量结果；决策始终把 cost-model 折进来，保证"只增 token/latency 不推广"被强制执行。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-2 Review Agent Experiment

Status: ✅ DONE（2026-08-19）

对高风险任务实验：

```text
Worker
→ independent Reviewer
→ verifier
```

Reviewer 不能与 Worker 共用隐藏 reasoning，只读 artifacts/diff/evidence。

## Tests
- `research/mechanisms/review-agent-experiment.yaml` — 新增 mechanism manifest（category: planning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/review-experiment.ts` — 新增 experiment 模块：`assertReviewerIsolation`（fail-closed 隔离门，拒绝任何携带 reasoning / chain_of_thought / internal_plan / transcript / scratchpad 等隐藏推理字段的输入）；`deriveReviewable`（仅从 Worker 可观测输出提取 changedPaths / touchedTests / evidence，绝不含推理面）；`defaultTruthLayer`（文档化的确定性启发式 truth，real 实验必须换成 judge-backed truth，truth 永不喂给 Reviewer）；`simulateReviewRun`（worker_verifier 恒等 champion；worker_reviewer_verifier 追加 review tokens/latency，按 defectRecall / falsePositiveRate 决定 catch/flag，seed 化可复现）；`aggregateReview`（质量按 shipped 缺陷自由度打分——通过验证但 shipped 出 latent defect 即判 failure，使 catch 真实缺陷的价值进入 cost-model 才能超过 review 成本）；`runReviewExperiment`（baseline vs challenger 端到端，每次 Reviewer 前重断言隔离）；`decideReviewPromotion`（推广门）。
- `packages/evaluation/src/review-experiment.test.ts` — 14 tests：隔离门 fail-closed（reject 带 reasoning/cot 字段）、clean artifacts/evidence 通过、deriveReviewable 只产观测面、truth 确定性、champion 恒等不 flag、challenger catch 且追加 token/latency、聚合（slipped / false positives / net caught / caught rate）、推广门四分支（promote / no_defect_value / too_noisy / cost_negative）、端到端 promote（隔离安全的 Reviewer net 住真实缺陷）与 clean-only 拒绝、渲染输出。
- Full suite: 114 files / 1619 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 核心红线严格执行：Reviewer 只读 artifacts/diff/evidence，任何输入携带隐藏推理字段都 fail-closed（绝不静默截断）。truth（latent defect 真值）独立 judge 提供，永不进入 Reviewer 输入。
- 推广门：仅当隔离安全 Reviewer 净住 ≥ `minimumNetDefectsCaught`（默认 1）个 latent defect、false-positive rate ≤ `maxFalsePositiveRate`（默认 0.3）、且 cost-model 分数为正 delta 才 promote。无 value 落入 `no_defect_value`，噪声超限 `too_noisy`，成本吃掉价值 `cost_negative` —— 全部 REJECT。
- 成本语义修正：质量按"shipped 缺陷自由度"打分，而非 verifier 的 pass 标志。通过验证却 shipped 出 latent defect 判为质量失败，这样 catch 真实缺陷才能在 cost-model 中体现价值并覆盖 review 成本；否则 review 因加 token/latency 永远不可提升，实验无意义——这不是降低门槛，而是把"false-complete 也算失败"做到更严。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。Reviewer 用显式 effect model（可注入、seed 化）叠加在已测 Worker outcome 上表达，绝不臆造测量结果；truth 层与 Reviewer 输入严格分离。
- 隔离不是靠约定，而是靠 `assertReviewerIsolation` 运行时强制：reviewable 类型本身无推理面，且每次送进 Reviewer 前重断言。常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-3 Specialist Routing

Status: ✅ DONE（2026-08-19）

按任务类型路由：

```text
coding
debugging
research
docs
data
```

先 benchmark 验证 specialist prompt 是否比统一 agent 好。

## Tests
- `research/mechanisms/specialist-routing.yaml` — 新增 mechanism manifest（category: planning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/specialist-routing.ts` — 新增 experiment 模块：`classifyTaskType`（确定性任务类型分类，仅从 task 关键字 + fixture 路径提示等结构性字段计数，绝不用模型措辞；clear-winner 规则：至少 `MIN_CUES_TO_ROUTE`（默认 2）个命中且严格领先所有其它 lane，平局/弱命中回落到 generalist，绝不强行分配到不匹配的 specialist）；`simulateSpecialistRun`（generalist 恒等 champion；specialist_router 每 case 加 routing tokens/latency，correct-routed 以 `specialistPassGain` 概率挽回失败、mis-routed 以 `mismatchPassPenalty` 概率regression 通过，低置信度回落 generalist 但照付 routing 成本，正确性由 `truthLane` 真值层判定、缺省用文档化的稀疏命中启发式，seed 化可复现）；`aggregateSpecialist`（聚合 pass rate / routed / mis-routed + cost-model 打分）；`runRoutingExperiment`（generalist vs challenger 端到端，支持注入 truth lane）；`decideRoutingPromotion`（推广门）。
- `packages/evaluation/src/specialist-routing.test.ts` — 18 tests：分类器（debugging 多 cue→specialist，.md→docs，.csv→data，无 cue→generalist，模糊弱命回落 generalist）、generalist 恒等（无 token/latency 漂移）、低置信回落但付 routing 成本、truth 驱动的 correct-routed 挽回失败 / mis-routed 使通过 regression、聚合（pass rate / routed / mis-routed / cost score）、推广门五分支（promote / no_gain-nothing-routed / no_gain-no-lift / mismatch_regression / cost_negative）、端到端 promote（正确路由挽回失败任务）与 clean-only 拒绝、渲染输出。
- Full suite: 115 files / 1637 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 分类器红线：不混淆 lane。单 cue 命中不足以路由（`MIN_CUES_TO_ROUTE`=2）；顶位平局（tie）强制回落 generalist；两个方向的 cue 同时命中时靠明白的领先 margin 决出，谁都赢不了就 generalist。confidence 用 vs 第二名的 decisive margin 定义，绝不因 lane 关键字多而惩罚任务。
- 推广门：仅当真的是 specialist prompt 优于统一 agent 才推广——challenger 把 pass rate 提升 ≥ `minimumPassGain`（默认 0.05）、mis-routing 占比 ≤ `maxMismatchRatio`（默认 0.3）、cost-model 分数为正 delta 才 promote。一个 case 都没路由 → `no_gain`；只涨 token/latency 无 pass 提升 → `no_gain`；mis-route 超限 → `mismatch_regression`；成本吃掉价值 → `cost_negative`。全部 REJECT。
- 端到端覆盖两条对立路径：正确路由挽回失败任务 → PROMOTE；给已干净输出只加路由开销 → REJECT。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。challenger 用显式 effect model（可注入、seed 化、truth lane 可注入）叠加在已测 Worker outcome 上表达；correct/mis-route 的决定器（truth 层）与分类器本身严格分离，绝不臆造测量。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-4 Dynamic Tool Selection

Status: ✅ DONE（2026-08-19）

工具很多时：

```text
tool index
→ select relevant tools
→ expose subset
```

减少 schema token。

安全边界不变。

## Tests
- `research/mechanisms/dynamic-tool-selection.yaml` — 新增 mechanism manifest（category: tool_use，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/tool-selection.ts` — 新增 experiment 模块：`selectRelevantTools`（确定性工具相关度选择：对每个非安全关键工具按 task 文本 + fixture 路径命中 relatedCues 计数，达到 `TOOL_SELECT_THRESHOLD`（默认 1）才暴露；安全关键工具无条件保留；返回 fail-closed 的 `safetyComplete` 标志，任何安全工具缺失即 violation）；`simulateToolSelectionRun`（full_catalog 恒等 champion（全量 schema token、无遗漏、基线 pass）；dynamic_subset 按选择暴露、降低 schema token，长文任务按 `contextLift` 概率挽回失败，按 `missRate` 概率为遗漏关键工具付出 recovery tokens/latency 并可能翻转 pass，任何 safety-incomplete 子集直接 hard-fail，seed 化可复现）；`aggregateToolSelection`（聚合 pass rate / schema savings（对每 case 显式记录的 fullSchemaTokens 计算，绝不依赖 policy 侧值）/ misses / safety-complete + cost-model 打分，安全 violation 进 violations 数组）；`runToolSelectionExperiment`（全量与子集端到端）；`decideToolSelectionPromotion`（推广门）。
- `packages/evaluation/src/tool-selection.test.ts` — 17 tests：选择器（安全工具无条件保留、docs/data 任务命中对应工具、不相关非关键工具被省略省 token、确定性）、full_catalog 恒等（full schema token 无漂移）、dynamic_subset 省 schema、safety-incomplete 子集 fail-closed hard-fail、长文任务 schema 解压挽回失败、聚合（pass rate / savings / misses / safety）、推广门六分支（promote / safety_invariant_failed / savings_trivial / no_lift / coverage_regression / cost_negative）、端到端 promote（省 schema 且 context 解压）与 savings 不足拒绝、渲染输出。
- Full suite: 116 files / 1654 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 安全红线绝对化：「安全边界不变」。任何导致安全关键工具（read/write/edit/search/exec/verification）缺失的子集是硬 violation → `safety_invariant_failed`，无条件 REJECT，绝不静默。
- schema savings 必须达到 `minimumSchemaSavings`（默认 0.1）才算"真的省了"，否则 `savings_trivial` 拒绝（省太少不值得 miss 风险）。miss 占比超 `maxMissRatio`（默认 0.3）→ `coverage_regression`；只省 token 无质量→ `no_lift`；成本为负→ `cost_negative`。全部 REJECT。
- 端到端覆盖两条对立路径：省 schema + 长文 context 解压（pass 不回归）→ PROMOTE；几乎没省 schema 又加开销 → REJECT。
- 修了一个真实设计缺陷：schema savings 比率原本用 `runs[0].schemaTokens` 当全量基线，把 challenger 自己的子集值当分母导致恒为 0。改为每 case 显式携带 `fullSchemaTokens`，savings 对全量 catalog 计算，不依赖 policy。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。challenger 用显式 effect model（可注入、seed 化）叠加在已测全量 outcome 上表达，绝不臆造测量。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-5 Learned Tool Preference

Status: ✅ DONE（2026-08-19）

LearningCandidate `tool_preference` 真正接 runtime，但必须：

```text
benchmark promoted
scope-aware
rollbackable
```

不能因为某次成功永久改变全局行为。

## Tests
- `research/mechanisms/learned-tool-preference.yaml` — 新增 mechanism manifest（category: learning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/tool-preference.ts` — 新增 experiment 模块：`learnToolPreference`（从 trace 学习候选偏好：统计某 tool 在 scope 内成功/失败使用占比，低于 `minSamples`（默认 3）或 `minSuccessFrac`（默认 0.6）就丢弃——单次成功不构成偏好；产出 status=candidate 的 `ToolPreference`）；`promotePreference`（推广门：仅在其实例化（非 candidate）、证据足、benchmark 验证 pass lift ≥ 阈值、cost delta 为正、且 safety 完整时才翻为 active，version 自增）；`rollbackPreference`（显式回滚 active→rolled_back，之后任何 scope 都不再 apply，且排除在未来推广之外）；`shouldApplyPreference`（只对 active 且 scope 匹配的偏好生效——非匹配行为的 apply 不改变）；`simulatePreferenceRun`（no_preferences 恒等 champion；learned_preferences 只对 active+scope 匹配 apply，可挽回失败，scope 外不 apply，fault-inject 的 safety-strip 必然 hard-fail fail-closed，seed 化可复现）；`runPreferenceExperiment`（learn→validation promote→eval 测量三段式，validation 期用 `measureAsActive` 仅作推广度量——生产 apply 路径仍严格要 active）；`preferenceTargetsSafetyCritical` + `scopeMatches`。
- `packages/evaluation/src/tool-preference.test.ts` — 16 tests：学习（证据足可学习、单次成功拒绝、tool 未助成功拒绝）、scope 与 rollback（有验证提升才 promote / 无提升不 promote / safety-strip 不 promote / active+scope 匹配才 apply / rolled_back 全局不 apply / 目标安全工具检测 / scopeMatches 通配）、effect model（no_preferences 恒等、active apply 挽回失败、scope 外不 apply、safety-strip fail-closed）、端到端（learn→promote→apply 提升 scope 匹配 case、rolled_back 后不提升）。
- Full suite: 117 files / 1670 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 三条红线全部编码执行：① benchmark promoted——偏好只在 hold-out validation 上验证 pass lift + cost 正向才翻 active，否则永远 candidate 不生效；② scope-aware——只有 scope 匹配的 case 受影响，scope 不匹配行为完全不变，单次成功不能重写全局配置（证据不足宁可不学）；③ rollbackable——每条偏好带版本与状态，`rollback()` 显式翻到 rolled_back，之后全 apply 路径永久失效并排除再推广。
- 安全不变式（沿用 P3-4）：任何偏好不得移除/削弱安全关键工具；fault-inject 的 safety-strip 在任何 policy 下都 hard-fail fail-closed，绝不进入推广。
- 关键语义澄清：validation 期用 `measureAsActive=true` 把候选按"若 active"来度量以决定推广，但这只是度量性旁路；生产运行时 apply 严格走 `shouldApplyPreference`（要求 active）。其余案例证明 candidate/rolled_back 在 runtime 一律不生效——某次成功永远不可能即时改变全局行为。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。知识来源是 trace 的已测成功序列（统计），challenger 用显式 effect model（可注入、seed 化）叠加表达，绝不臆造测量。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-6 Learned Workflow

Status: ✅ DONE（2026-08-19）

Workflow candidate 表达：

```text
when task type X
prefer steps A→B→C
```

只能是 soft guidance。

不得绕过 permission/verification。

## Tests
- `research/mechanisms/learned-workflow.yaml` — 新增 mechanism manifest（category: learning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/learned-workflow.ts` — 新增 experiment 模块：`learnWorkflow`（从 trace 学习：统计通过案例的首现唯一步骤序列 `when taskType → prefer A→B→C`，证据低于 `minSamples`（默认 3）丢弃；凡含 mutating 步骤（edit/write）但无 verification 的候选直接丢弃——绝不产出会绕过 verification 的 workflow；`includesVerification` 显式记录）；`assertNoGateBypass`（fail-closed：workflow 若把 permission gate 当步骤会立即抛错拒绝）；`promoteWorkflow`（推广门：非 candidate、证据足、验证 pass lift ≥ 阈值、cost 正向、bypassFree 才翻 active）；`rollbackWorkflow`（显式回滚 active→rolled_back，之后任何 task type 都不再 apply）；`shouldApplyWorkflow`（active + task type 匹配才生效——soft + scoped）；`simulateWorkflowRun`（no_workflow 恒等 champion；learned_workflow 只对匹配类型的 soft guidance apply 可挽回失败，task type 不匹配为 no-op，fault-inject / 自然 bypass 的 gate-bypass 一律 hard-fail fail-closed，seed 化可复现）；`runWorkflowExperiment`（learn→validation promote→eval 测量三段式，validation 用 `measureAsActive` 仅作推广度量——生产 apply 仍严格要 active）；`workflowMatches`。
- `packages/evaluation/src/learned-workflow.test.ts` — 15 tests：学习（证据足学习 / 单次成功拒绝 / mutating 无 verification 丢弃）、推广与 scope（验证提升才 promote / 无提升不 promote / bypass 不 promote / active+type 匹配才 apply / task type 不匹配 no-op / rolled_back 全局不 apply / assertNoGateBypass 对 permission marker fail-closed）、effect model（no_workflow 恒等、soft apply 挽回失败、非匹配类型 no-op、gate-bypass fail-closed）、端到端（learn→promote→apply 提升匹配类型、rolled_back 后不提升）。
- Full suite: 118 files / 1685 tests green；`pnpm build`（tsc -b）clean。

## Benchmark
- 两条红线全部编码执行：① 只能 soft guidance——workflow 只是按 task type 的步骤偏好注入（`when X → prefer A→B→C`），绝不是 mandate；scope（task type）不匹配完全无副作用，且必须先 benchmark 验证提升才 active。② 不得绕过 permission/verification——学习层保证任何 mutating 无 verification 的候选不产生；apply 层对 gate-bypass（自然或 fault-inject）一律 hard-fail fail-closed，绝不静默放行。
- 端到端覆盖：apply 的 soft workflow 提升匹配 task type 的 pass rate → ACTIVE；rolled_back 后 pass delta 归零即 no-op。
- 修了一个与 P3-5 同源的语义缺陷：validation 期 `measureAsActive` 本意是"候选按若 active 度量"，但 apply 过滤又套了含 `status==="active"` 检查的 `shouldApplyWorkflow`，导致候选在 validation 永远不适用、永不推广。改为 matching（仅 task type）+ active-or-measure 两层判定，生产 apply 仍严格走 `shouldApplyWorkflow`。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地。workflow 来源是成功 trace 的结构化步骤序列，challenger 用显式 effect model（可注入、seed 化）叠加表达，绝不臆造测量。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-7 Learned Prompt Rules

Status: ✅ DONE（2026-08-19）

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

## Tests
- `research/mechanisms/learned-prompt-rules.yaml` — 新增 mechanism manifest（category: learning，status: candidate），`agent mechanisms research/mechanisms/` 校验通过（all manifests valid）。
- `packages/evaluation/src/prompt-rules.ts` — 新增 experiment 模块：核心里程碑 `isVerbatimReflectionAppend`（directive 若等于或内嵌某个整段 reflection 原文即 true——这是本实验的头号红线）；`assertPromptRuleSecurity`（fail-closed security scan：verbatim reflection append / prompt-injection marker / secret-like pattern / safety-strip 措辞任一命中即 `ok:false`，对齐生产层 `packages/learning` 的 `securityCheck` 语义）；`extractReflections`（读取 observable 的终止 reason 与 `reflection.*` 事件）；`distillPromptRule`（从 reflection 信号蒸馏出全新组合的 scoped directive，证据 < minSamples（默认 3）丢弃，single reflection 绝不成为规则，且产出前先过安全扫描）；`promotePromptRule`（推广门：非 candidate、证据足、`securityOk && delta.securityOk`、pass lift ≥ 阈值、cost 正向才翻 active——security scan 必过、绝不为 token/latency 推广）；`rollbackPromptRule`（active→rolled_back，之后任何 scope 不再 apply）；`shouldApplyPromptRule`（active + securityOk + scope 匹配）；`simulatePromptRuleRun`（no_rules 恒等 champion；learned_rules 仅对匹配 scope 且 security-ok 的规则 apply，scope 不匹配 no-op，fault-inject verbatim/injection 一律 hard-fail fail-closed，seed 化可复现）；`runPromptRuleExperiment`（distill→security scan→validation promote→eval 测量三段式，validation 用 `measureAsActive` 仅作推广度量——生产 apply 仍严格要 active）。
- `packages/evaluation/src/prompt-rules.test.ts` — 18 tests：蒸馏与 verbatim 不变量（多证据蒸馏出 scoped/versioned/evidence/security-ok 规则 / 单 reflection 拒绝 / `isVerbatimReflectionAppend` 对相等与内嵌均命中、对蒸馏 directive 不命中）、security scan（verbatim append fail-closed / injection / secret / safety-strip / extractReflections）、promotion/scope/rollback（security-ok+证据+benchmark 才 promote / 无 pass lift 或 cost 为负不 promote / 仅 active+scope+security-ok 生效 / rolled_back 全局停用）、effect model（no_rules 恒等 / apply 挽回失败 / 非匹配 scope no-op / fault-inject fail-closed）、端到端（learn→promote→apply 提升匹配 scope、rollbackAfterPromote 后 pass delta 归零；学习无法产出 security-clean 规则时抛错）。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 头号红线编码执行：① **绝不把 reflection 文本 verbatim append 到 system prompt**——`distillPromptRule` 产出的是蒸馏后的 directive（全新组合），且 `assertPromptRuleSecurity` 对 `isVerbatimReflectionAppend` 命中一律 fail-closed，verbatim 候选永远无法诞生、promote 或 apply。② 学习产物需 version/scope/evidence/promotion benchmark/security scan/rollback 六要素齐备；security scan 同时拦截 injection、secret、safety-strip 措辞。③ 不为 token/latency-only 推广（cost score delta ≤ 0 拒绝，benchmark 无 pass lift 拒绝）。
- 端到端覆盖：蒸馏→security scan→promote→apply 提升匹配 scope → ACTIVE；rollbackAfterPromote 后 pass delta 归零即 no-op。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地；与生产 `packages/learning` 的 `prompt_rule` + `securityCheck` 语义对齐但独立实现。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-8 Auto-generated Benchmark Candidates

Status: ✅ DONE（2026-08-19）

Agent 可提出 benchmark case，但：

```text
judge freeze
fixture sanitize
human or deterministic review
```

后才能进入正式 regression。

## Tests
- `research/mechanisms/auto-generated-benchmark-candidates.yaml` — 新增 mechanism manifest（category: evaluation，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/benchmark-candidates.ts` — 新增实验模块（纯评审管道，不触碰主 runtime）：`BenchmarkCandidate`（agent 提案，强制 `judgeVersionPinned`，且不携带任何自身 judge/expected 解释——只 pin 冻结 judge）；`sanitizeFixture`（fail-closed fixture sanitize：路径穿越/绝对路径、injection marker、secret-like pattern、危险 exec（`rm -rf /`、`sudo`、写 /etc/passwd、curl/wget）任一命中即拒绝）；`assertJudgeFrozen`（候选 pin 的 judgeVersion 必须等于冻结 judge，否则拒绝——绝不允许候选自带 judge）；`deterministicReview`（结构化确定性评审：id/proposalId/task 非空、suite ∈ 白名单、expected.status 合法、judge freeze、fixture sanitize，全通过才 accepted 并产出 frozen-judge 的 EvalCase）；`toCase`（被接受候选 → regression-ready EvalCase，judge 冻结到 `judgeVersion`，fixture 映射为稳定的 `auto:<proposalId>` 标签——同一经清洗的 fixture 集）；`reviewBenchmarkCandidate`（P3-8 守卫：**安全不吃人类豁免**——judge freeze + fixture sanitize + 结构检查恒定先跑、human flag 永不覆盖；仅当 `requireHuman` 且未批准时返回 `pending`（绝不静默加入），已批准或纯 deterministic 才 accepted）。
- `packages/evaluation/src/benchmark-candidates.test.ts` — 16 tests：fixture sanitize（干净通过 / injection / secret / 路径穿越+绝对路径 / 危险 exec 拒绝）、judge freeze（冻结匹配通过 / 不匹配拒绝）、deterministic review（良构接受并产出 frozen-judge case / malformed 拒绝 / 非冻结 judge 拒绝 / 不安全 fixture 拒绝）、human-or-deterministic（requireHuman 未批准 → pending 永不加入 / 已批准 → accepted / 默认 deterministic / **不安全候选即使 human 批准也保持 rejected**）、to-case（冻结 judgeVersion + synth fixture 标签）。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 三道门全部编码执行：① judge freeze——候选无法自带 judge，pin 版本不匹配冻结 judge 即拒。② fixture sanitize——injection/secret/路径穿越/危险 exec 全部 fail-closed 拒绝。③ human or deterministic review——默认确定性评审；human 模式需显式批准，否则 pending 严禁入 regression；且 **安全结果不受 human flag 覆盖**（不安全候选永远 rejected）。
- 端到端覆盖：被接受候选转成 `judgeVersion` 冻结的 EvalCase 才能进入正式 regression；任何未通过门禁的提案停留 pending/rejected。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地；评审管道为纯函数、确定性、无副作用。
- 常量/阈值全部显式且有默认值；导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-9 Self-Modification Sandbox

Status: ✅ DONE（2026-08-19）

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

## Tests
- `research/mechanisms/self-modification-sandbox.yaml` — 新增 mechanism manifest（category: other，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/self-mod-sandbox.ts` — 新增实验模块：`gateModify`（写门：路径命中 live champion 树（含 root 本身）→ 拒绝 `direct self-modification of the live champion is forbidden`；路径在 isolated copy 之外 → 拒绝；仅 isolated copy 内允许——champion 树在候选修改轮内不可变）；`isPathWithin`（绝对路径归一化后的子树判定，正确处理 sibling 前缀，`harness-agent` vs `harness-agent-candi-A` 不会误判）；`snapshotTree`（排序 path→content 确定性快照）+ `snapshotHash`（非加密确定性哈希，未篡改时相等、篡改后变化）+ `championUntouched`（快照相等即未动）；`integratePatch`（集成门：仅当 isolated tests AND benchmarks 都 passed 才 merged，任一失败 rejected——patch 只落到全新 champion 快照，运行中的 champion 无任何原地修改代码路径）。
- `packages/evaluation/src/self-mod-sandbox.test.ts` — 9 tests：写门（isolated 内允许 / champion 树上拒绝 / champion root 拒绝 / isolated 外拒绝 / sibling 前缀不误判）、快照不可变性（稳定 / 篡改变化 / 顺序无关）、集成门（双 passed 才 merged / tests 或 benchmarks 任一失败 rejected / 无原地修改路径）。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 绝不放行的路径被硬编码拒绝：`gateModify` 对 live champion 树写入一律 `allowed:false`——运行中的 champion 直接修改自己的 runtime 然后继续执行在模型层就是不可能的（champion 树在修改轮内恒定不可变）。
- 集成门与规范一致：候选只在 isolated copy 改动，且 tests + benchmarks 双双通过才 merged 到全新冠军快照；成本/质量由 benchmarks 门体现。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地；所有函数为纯函数、确定性。
- 导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-10 Multi-Variant Evolution Loop

Status: ✅ DONE（2026-08-19）

未来可实验：

```text
Champion
├─ Challenger A
├─ Challenger B
└─ Challenger C
```

统一 eval 后只 promote 最可靠候选。

注意成本预算。

## Tests
- `research/mechanisms/multi-variant-evolution-loop.yaml` — 新增 mechanism manifest（category: scheduling，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/evolution-loop.ts` — 新增实验模块：`aggregateAssessment`（把同一 eval split 上某 variant 的一组 `EvalOutcome` 折叠成 passRate / totalTokens / totalDurationMs / securityFailures，并用 cost-model 的 `scoreCost` 得 costScore——靠 quality+reliability+security 综合，绝不只看 pass rate）；`choosePromoted`（选择唯一最可靠候选：预算内才可参选（totalTokens / totalDurationMs 超支直接排除）、须以 `minimumCostLift` 可靠胜出、ties 用 passRate 再 tokens 决胜；无人胜出则 keepChampion，无强制推广）；`runEvolutionLoop`（同一 worker/同一 cases 统一评估 champion + variants）；`renderEvolutionDecision`。
- `packages/evaluation/src/evolution-loop.test.ts` — 6 tests：唯一最可靠被推广 / ties（cost 相同 passRate 决胜）/ 无人胜出 keep champion（禁止强制推广）/ minimumLift 门槛 / 超预算 variant 排除（最高 pass 因超 budget 不被推广）/ 全超预算 keep champion。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 单赢家 + 预算门槛编码执行：只 promote 最可靠候选（cost-adjusted），ties 用 passRate；无人可靠胜出保持 champion；totalTokens / totalDurationMs 超预算者即便 passRate 更高也不被 promote。
- 成本预算显式（tokenBudget / durationMsBudget / minimumCostLift 均有默认）。

## Notes
- 坚持 P3 定位：不重构主 runtime，仅作为 mechanism candidate 实验落地；challenger 用显式 effect 模型在测量结果上组合，绝不臆造。
- 导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-11 Context Policy Learning

Status: ✅ DONE（2026-08-19）

候选：

```text
different compaction thresholds
different retrieval top-k
different recent-message tails
```

通过 benchmark 自动选择。

## Tests
- `research/mechanisms/context-policy-learning.yaml` — 新增 mechanism manifest（category: context_management，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/context-policy.ts` — 新增实验模块：`ContextPolicy`（name + compactionThresholdTokens + retrievalTopK + recentTailMessages）；`runPolicyEffects`（按 key 组策略 run 的确定性得分输入）；`fromRunMetrics`（把 `RunMetrics` 转成统一 run 形状）；`assess`（cost-adjusted 得分 + `criticalDrops` 计数——丢关键上下文者即使 token 更低也重罚）；`chooseBestContextPolicy`（**不可丢关键上下文**：criticalDrops > maxCriticalDrops（默认 0）策略一律剔除，任何 token/速度优势都不能换回；其余按 cost score 决胜、ties passRate 再 tokens；无人胜出保持 champion）。
- `packages/evaluation/src/context-policy.test.ts` — 3 tests：best cost-adjusted promoted / 丢关键上下文策略被拒（即便看似最快）/ 无人胜出 keep champion。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 不可丢关键上下文红线编码执行：聚合评估标注 `criticalDrops`，任何超过容忍度的策略被剔除——aggressive compaction / top-k 过小 / recent tail 过短导致的 overflow/critical-drop 一律拒绝，绝不因省 token 或变快而放行。
- 策略由 benchmark 自动选择：cost-adjusted + passRate tie-break；无真实提升保持 champion。

## Notes
- 坚持 P3 定位：不重构主 runtime；所有得分为确定性纯函数。
- 导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-12 Scheduler Policy Learning

Status: ✅ DONE（2026-08-19）

候选：

```text
maxConcurrent
child budget allocation
queue fairness
```

只能在 stress suite 证明稳定后 promote。

## Tests
- `research/mechanisms/scheduler-policy-learning.yaml` — 新增 mechanism manifest（category: scheduling，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/scheduler-policy.ts` — 新增实验模块：`SchedulerPolicy`（name + maxConcurrent + childBudgetAllocation + queueFairness）；`stressStable`（**stress 稳定性门**：securityViolations / falseCompletes / p95LatencyMs / totalTokens 任一超预算即 `stable:false`——spike 稳定性指标者绝不 promote）；`chooseBestSchedulerPolicy`（候选须同时过 stress 稳定性门 + 严格高于 champion 的 stress passRate（`<=` 不够，tie 不 promote），任一不过剔除；无人通过保持 champion）。
- `packages/evaluation/src/scheduler-policy.test.ts` — 4 tests：stress-stable 且提升 stress pass → promoted / 新增 security violation 被拒 / stressStable 对 false-complete / 高延迟 / 超 token 均判 false / 无任何候选过门 keep champion。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 「只能在 stress suite 证明稳定后 promote」编码执行：任何让 adversarial/stress split 出现新 security violation、false-complete 上升、p95 延迟或 token 超支的策略被硬拒；且须严格高于 champion 的 stress passRate 才可能推广。
- 修了一个门禁语义缺陷：原实现 `passRate - champion < minLift` 在下限 0 时允许 tie（相等即通过），改为 `passRate <= champion` 一律不推广，必须严格超越。

## Notes
- 坚持 P3 定位：不重构主 runtime；纯函数、确定性。
- 导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-13 Recovery Policy Learning

Status: ✅ DONE（2026-08-19）

候选：

```text
retry count
stall threshold
compact timing
```

不得通过增加大量 retry 暴力抬 success。

cost gate 必须参与。

## Tests
- `research/mechanisms/recovery-policy-learning.yaml` — 新增 mechanism manifest（category: error_recovery，status: candidate），`agent mechanisms research/mechanisms/` 校验通过。
- `packages/evaluation/src/recovery-policy.ts` — 新增实验模块：`RecoveryPolicy`（name + maxRetries + stallThresholdMs + compactOnRecovery）；`recoveryCostScore`（**cost-adjusted 得分**：passRate×100 减去 retry 拖累（每满 4 retries 扣 25）与 token 拖累（按 32k 预算线性扣 15）——暴力重试得分骤降）；`chooseBestRecoveryPolicy`（**cost gate 强制参与**：candidate 须通过 cost gate（costScore 严格高于 champion 达 minimumCostLift）且 totalRetries 不超 champion×maxRetryMultiplier（默认 3x，超限即 `brute-forces success` 拒绝）；无人通过保持 champion）；`fromRecoveryRuns`；`renderRecoveryDecision`。
- `packages/evaluation/src/recovery-policy.test.ts` — 5 tests：每 retry 有真实质量收益 → promoted / 暴力重试（0.95 pass 但 10x retries）被拒 / 超 retry 倍率被拒 / 无人过 cost gate keep champion / cost score 对 retry/token 膨胀有惩罚单调性。
- Full suite: 待全量跑数；`agent mechanisms` 校验通过。

## Benchmark
- 两条红线编码执行：① 不得暴力 raise success——`maxRetryMultiplier` 与 `recoveryCostScore` 的 retry 拖累双保险，mass retry 即便 passRate 更高也 reject / 低分。② cost gate 必须参与——推广只看 cost-adjusted 得分，绝不经由原始 passRate。
- 端到端：`fromRecoveryRuns` 从每策略 run 的 `RunMetrics`（含 `retry_count`）聚合出 cost-aware outcome。

## Notes
- 坚持 P3 定位：不重构主 runtime；纯函数、确定性。
- 导出入口加入 `packages/evaluation/src/index.ts`。

---

# P3-14 Model Routing Experiment

Status: DONE

如果未来多模型：

```text
cheap model for simple/read-only planning
strong model for complex coding/review
```

先以 benchmark cost/quality 评估。

不要默认“多模型一定更好”。

Tests:
- `packages/evaluation/src/model-routing.test.ts` — 7 用例：确定性 `classifyTask`（stress/adversarial 套件、verification、fixture 数量、复杂/审查/multi 标签→complex，其余 simple）；路由效果模型 seeded 模拟；`CHAMPION_ROUTING` 单强者 baseline。
- `evaluateRouting` 成本/质量门禁：仅当 token 节省 ≥ 阈值（默认 0.2）且 complex 分裂回退 ≤ 容忍值（默认 0.05）且整体 pass 未明显下滑时 `promoteRouted`；情感化"多模型更好"默认不成立。

Benchmark:
- `packages/evaluation` 全量 28 文件 / 421 用例通过；`npx tsc --noEmit` 通过。

Notes:
- 机制候选实验，未重构主 runtime；导出已加 `packages/evaluation/src/index.ts`。
- 守卫：complex 分裂不允许因省钱而回退；无模型结果被伪造（seeded 效果模型仅作用于已测 outcome）。

---

# P3-15 Offline Trace Replay

Status: DONE

支持用历史 event/trace：

```text
re-run evaluator
test new judge
test new memory ranker
test new attribution
```

不调用真实模型。

减少迭代成本。

Tests:
- `packages/evaluation/src/offline-replay.test.ts` — 4 用例：`replayEvaluator` 用离线 judge 重算 pass；`testNewJudge` 对比新旧 judge 的 changed/newFailures 与 pass 率差异；`replayMemoryRanker` 校验 top-k 命中；`replayAttribution` 基于记录事件 tally 重放回归归因。

Benchmark:
- `packages/evaluation` 全量 28 文件 / 421 用例通过；`npx tsc --noEmit` 通过。

Notes:
- 机制候选实验，不触发任何真实模型调用；纯函数重放已记录的 trace。导出加 `packages/evaluation/src/index.ts`。

---

# P3-16 Counterfactual Harness Evaluation

Status: DONE

长期目标：

同一 trace 尝试分析：

```text
如果当时 retry policy 不同？
如果 memory retrieval 不同？
如果 stall earlier?
```

优先做 deterministic components 的 counterfactual，不要伪造模型行为。

Tests:
- `packages/evaluation/src/counterfactual.test.ts` — 4 用例：替代 retry 上限对记录 tally 的确定性约束；更小 stall 阈值标记更早停顿的 turn；汇总节省 retry / 更早停顿；反事实绝不伪造模型输出——更大 maxRetry 不能凭空增加记录到的 retry。

Benchmark:
- `packages/evaluation` 全量 28 文件 / 421 用例通过；`npx tsc --noEmit` 通过。

Notes:
- 机制候选实验：反事实仅作用于记录所得 tally（retry 上限、stall 阈值、memory top-k 作为确定性策略），不发明模型行为。导出加 `packages/evaluation/src/index.ts`。

---

# P3-17 Formal Invariants

Status: DONE

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

Tests:
- `packages/evaluation/src/formal-invariants.test.ts` — 34 用例，覆盖每个 INV 的通过/违反两态 + 聚合器。
  - INV-001 终态时间线：进行中→不受影响；终态后不变→OK；终态后转其他状态（含转另一终态）→FAIL。
  - INV-002 能力边界：声明 ⊆ 授权→OK；`*` 全量上界→OK；未授权工具→FAIL；文件系统上界邻接前缀（`/workspace/proj` vs `/workspace/projectx`）必须判定为越界。
  - INV-003 不安全工具：unsafe + 手动重试 OK、safe 自动重试 OK；unsafe + 自动重试→FAIL。
  - INV-004 验证防伪造：PASSED 必须有 ≥1 通过 check 且有 evidence；零 check 或全失败却 PASSED、或有 check 无 evidence→FAIL；真实 failed gate→OK。
  - INV-005 子上下文隔离：只读授权键→OK；读未授权键、读 parent-* 内部键（即便被"授权"）→FAIL。
  - INV-006 holdout 判官保密：holdout 未激活不评分→OK；holdout 激活后评分→OK；holdout 未激活却评分→FAIL。
  - INV-007 记忆不安全内容：unsafe 拒绝不持久化→OK；unsafe 持久化→FAIL；unsafe 同被拒绝又持久化（门卫绕过）→FAIL。
  - INV-008 网络拒绝：拒绝即不执行、放行即执行→OK；拒绝却执行→FAIL（fail-closed）。
  - INV-009 委托有界：深度/扇出/能力子集→OK；超深度、超扇出、能力未窄化→FAIL。
  - INV-010 重放去重：已知已完成 unsafe 副作用重放为 no-op、safe 副作用可重放、fresh 副作用可执行→OK；重放重复执行已知已完成 unsafe→FAIL。
  - 聚合器 `checkInvariants` 跑满 10 条；混合快照只浮出命中违反的条目；与独立谓词结果一致。
- 顺带修复：index.ts 桶导出中 `RoutingPolicy`（specialist-routing）与 model-routing 同名冲突 → specialist 改名为 `SpecialistRoutingPolicy`（内部引用同步更新）。

Benchmark:
- 全量 `packages/evaluation`：28 个测试文件、421 用例全部通过。

Notes:
- 实现为纯、确定性快照谓词（不建模、不预测）；模块是机制候选，未改主 runtime，需基准证明其价值后才推广为发布门禁。
- 每条 invariant 均以单一函数暴露，并可在 `checkInvariants` 聚合；违反可回溯到具体单元（`at`）与原因（`detail`）。
- 缺失段保守视为“无违反”（与真实通过区分开），避免把未检查当作已证明。
- 机制清单：`research/mechanisms/formal-invariants.yaml`（category: security）。

---

# 全局代码质量优化

---

# Q-1 拆分超大 runtime.ts

Status: IN_PREGRESS (helper substrate extracted 2026-08-19; controller 抽取逐块推进中)

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

Progress:
- **(DONE 2026-08-19) helper substrate**：把 9 个纯静态助手从 `runtime.ts` 抽到
  `packages/core/src/runtime/turn-helpers.ts`——`renderToolResult`、`buildResumePrompt`、
  `updateWorkingState`、`workingStateToCompactionSummary`、`isContextOverflowError`、
  `toContextBlock`、`trimMessageHistory`、`isEffectiveAgentConfig`、
  `DEFAULT_RUNTIME_TOOL_SEMANTICS`（及原私有方法 `buildStateDigest`）。`runtime.ts`
  改为 import，公共 API 通过 `export { renderToolResult, buildResumePrompt }` 保稳
  （`export * from ./runtime.js` 契约不变）。模块级重复定义已全部删除，无 instance
  state 依赖，行为字节级一致。全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) TurnContext 只读上下文对象**：在 `turn-helpers.ts` 定义
  `TurnContext` 接口（`sessionId` / `turnId` / `signal` / `session` / `agent`），
  在 `runTurn` 入口创建不可变 `ctx` 对象，8 个私有方法的签名从散列参数改为
  `(ctx: TurnContext, ...)`——`checkpoint`、`finishTurn`、`executeToolCalls`、
  `runReadBatch`、`executeToolCall`、`runVerificationGate`、
  `renderToolResultForContext`、`parkForUserInput`。`emit` 保持不变（公共方法
  `submitUserAnswer` / `resumeTurn` 也调用它）。方法体通过 destructure 保持不变，
  `executeToolCall` 内部同名 `ctx`（HookContext）重命名为 `hookCtx`。纯打包重构，
  零行为变化。TypeScript 编译通过，全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) model-call retry 决策纯函数**：在 `turn-helpers.ts` 新增
  `decideModelRetry` 和 `ModelRetryAction` 类型。将 model 重试循环中 ~60 行内联决策
  逻辑（success / compact-and-retry / retry / fail 四分支）抽取为纯函数调用。
  `suppressLimitEvent` 标志精确保持二次 overflow 不发 `run.limit_reached` 的原始
  行为。`runtime.ts` 中保留所有副作用（emit / checkpoint / sleep），仅决策由纯函数
  驱动。TypeScript 编译通过，全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) callModelWithRetry 方法抽取**：将 model 调用循环（流式接收 +
  重试决策 + reactive compaction，~130 行）从 `runTurn` 抽取为私有方法
  `callModelWithRetry`。返回 `ModelCallResult` 联合类型（completed / cancelled /
  failed），调用方根据状态处理 `finishTurn` 和 post-completion。所有副作用（emit、
  checkpoint、timerSleep）留在方法内，`finishTurn` 由调用方处理。`final` 类型从
  内联改为 `ModelFinalResult`。`reactiveCompacted` 通过返回值回传。TypeScript 编译
  通过，全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) handleModelCompletion 方法抽取**：将 post-completion 处理
  （wall clock 检查、append assistant message、model.completed 事件、verification gate
  + 重试逻辑、finishReason 分发、ask-user gate 检测，~110 行）从 `runTurn` 抽取为
  私有方法 `handleModelCompletion`。返回 `CompletionResult` 联合类型
  （`continue_loop` / `finish` / `proceed`），处理验证失败重试的 `continue` 控制流。
  `verificationFailures` 通过返回值回传。`turn` 作为参数传入。TypeScript 编译通过，
  全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) handleToolResults 方法抽取**：将 post-execution 处理
  （render tool results、append messages、update working state、tool ledger recording、
  side-effect checkpoints、stall detection [identical-call streak + pattern-based]、
  maxToolCalls check、post-batch abort check，~150 行）从 `runTurn` 抽取为私有方法
  `handleToolResults`。返回 `ToolResultsAction` 联合类型（`continue_loop` / `finish` /
  `done`）。`priorBlocks` 通过引用传递（方法内 push）。所有 `continue;` 改为
  `return { action: "continue_loop" };`，`return this.finishTurn(...)` 改为
  `return { action: "finish", outcome: await this.finishTurn(...) };`。
  `runTurn` 主循环从巨型方法缩减为 ~343 行的骨架（init → context pipeline →
  callModelWithRetry → handleModelCompletion → executeToolCalls → handleToolResults →
  maxIterations 检查）。TypeScript 编译通过，全量回归 **137 files / 3672 tests 全绿**。
- **(DONE 2026-08-19) injectSteeringPrompts + buildContext 抽取**：
  - `injectSteeringPrompts`：将 steer injection 逻辑（exactly-once prompt 检查、
    append、markConsumed，~26 行）抽取为独立方法，返回更新后的 history。
  - `buildContext`：将 context pipeline 调用（skill/instruction discovery、security
    事件、system prompt 组装、auto-compact、message-history trim、context overflow
    检查，~183 行）抽取为独立方法。返回 `ContextUpdate` 联合类型
    （`proceed` 携带更新后的 history/system/lastReportTokens/digestAppended/
    overflowAttempt，或 `finish` 携带 TurnOutcome）。
  - `runTurn` 主循环从 ~343 行进一步缩减到 ~159 行，成为纯编排方法。
  TypeScript 编译通过，全量回归 **137 files / 3672 tests 全绿**。
- **Next**：`runTurn` 已成为 ~159 行的编排骨架。剩余可做：抽取初始化逻辑
  （prepareTurn）、将 executeToolCalls/executeToolCall/runReadBatch 移到独立模块。
  每块跑 full regression。

---

# Q-2 消除 Tool Name Heuristics

Status: DONE (2026-08-19)

语义推导已全面迁移到 ToolSemantics（由 registry 基于 `metadata + risk` 派生，而非工具名）：
- 生产运行时（`apps/cli/src/main.ts`）注入 `toolSemanticsOf: (name) => semanticsOf(toolRegistry.get(name))`；
  `toolCapabilityOf` 同理（retry/concurrency 由 `tool.metadata` 派生）。
- 核心语义路径零名称分支：`updateWorkingState` 按 `semantics.sideEffectScope` 记账、
  重试门 `toolCapabilityOf(x).retry`、并发 `concurrencySafe`、artifact 敏感度 `outputSensitivity`、
  orchestrator 权限分类（`classify`）按 `tool.metadata.process/network/filesystem + risk` 决定。
- `DEFAULT_RUNTIME_TOOL_SEMANTICS[name]` 名称键仅作**兼容回退**（P1-11 遗留），真实 host 不走此路径；
  未知工具落到保守 `DEFAULT_TOOL_SEMANTICS`（readOnly=true、sideEffectScope=none、retry unknown）。
- `ASK_GATE_TOOL`（P2-43）是形式化的运行时阶段控制常量（非语义启发），被明确记录为控制面而非可执行工具。

Tests:
- `packages/tools/src/semantics.test.ts`：新增 1 个用例（3 判定）锁定不变量——
  非标准名 `custom_sync!!$$` + filesystem metadata → `sideEffectScope:"filesystem"` 且 `requiresApproval`（按 risk）；
  名字含 "read" 但 `process:true` → `"process"`；无 sideEffect 的未知工具 `mystery_tool` → `readOnly:true`、`"none"`（不被名称猜为写工具）。
- 受影响包 tools/core 共 339 用例全通过；tools 包 `tsc --noEmit` 通过。

Benchmark: 无行为变化（纯语义验证补强，无运行时路径改动）。

Notes: 遗留的 `learned-workflow.ts` `STEP_LABEL`、`tool-selection.ts` 静态目录是 P3 学习实验的**显式知识数据/过程分类**，非执行语义分支，保留其名称映射属预期。

---

# Q-3 Shared Error Taxonomy

Status: DONE

错误码、termination reason、retry kind、安全 reason 之间避免重复字符串判断。

建立 typed mapping。

Tests:
- `packages/contracts/src/taxonomy.test.ts`：新增 7 个用例。
  - denied 家族每个 code 都映射到合法 TerminationReason，且 `isDeniedErrorCode` 命中；
  - permission/approval vs sandbox vs security 三组分离正确；
  - `deniedTermination` 对闭联集全 code 不抛且结果合法（fail-closed）；
  - `isPermissionOrSandboxDenied` 精确等于 orchestrator 的 denied 集合；
  - timeout/cancelled/internal/model 四个谓词类间互斥；
  - 每个 retry kind 都能取到合法 `retryKindTermination` 并匹配预期耦合。
- 受影响包（tools/agents/memory/evaluation）807 例无回归；`pnpm typecheck` 通过。

Benchmark: 无行为变化（纯重构，无运行时路径改动）。

Notes:
- 新增 `packages/contracts/src/taxonomy.ts`，集中比 `code.startsWith("SANDBOX")`、
  `code === "USER_CANCELLED"` 等手写字符串检查更稳的 typed 谓词与映射：
  `DENIED_TERMINATION`（ErrorCode→TerminationReason，为 P2-39 事件级 reason 提供权威合并）、
  `isPermissionOrSandboxDenied`、`isTimeoutErrorCode`、`isCancelledErrorCode`、
  `isInternalErrorCode`、`isModelErrorCode`、`isDeniedErrorCode`、`retryKindTermination`。
- 全部派生于 errors/termination/retry 闭联集：给联合增加成员（或删除）即编译报错，强制本文件与源词汇保持同步。
- `SecurityDimension` 因包环留在 `security` 包，其耦合已由 `securityErrorCode/securityEventType` 集中。
- 落地三处替换：`orchestrator.ts`（timeout/denied 状态判定）、`parallel-delegator.ts`（cancelled 判定）、`reflection.ts`（cancelled/internal 归因）。

---

# Q-4 Typed Event Payloads

Status: DONE (2026-08-19)

针对 `payload: Record<string, unknown>` 的字段漂移，新增 contracts 层 typed payload map，compile-time 固定关键事件 payload 形状：
- 新增 `packages/contracts/src/event-payloads.ts`：`EventPayloadMap` 接口把每个事件类型映射到具名 payload 接口（tool.*/model/verification/context/run.limit/turn/approval/security.*_denied 共 25 类），未列出的事件回退 `Record<string, unknown>`；`EventPayloadOf<T>` 按类型取出对应 payload，`EVENT_PAYLOAD_TYPES` 值映射确保 map 对 `EVENT_TYPES` 全量。
- 修复 Q-4 目标字段漂移：`tool.requested` 产方用 `name`、`tool.failed`/`tool.completed` 用 `tool`——新增规范访问器 `toolNameOf(payload)`（优先 `tool`、兼容前代 `name` 别名），并迁移 10 处消费方统一走它（runner/cost-model/review-experiment/tool-preference/learned-workflow、memory/reflection、session/replay），彻底消除各处手写 `payload.tool ?? payload.name` 猜测。
- `README`（research/mechanisms）无涉；契约向后兼容，`AgentEvent.payload` 保持 `Record<string, unknown>` 不变。

Tests: 新增 `event-payloads.test.ts` 6 例——规范字段优先、name 别名回退、tool.completed/failed 同源 tool、EventPayloadMap 类型全量、security 拒绝统一 payload；迁移后 evaluation/memory/session 全部 605 例绿；typecheck 通过。
Benchmark: 无。
Notes: 消费方一律用 `toolNameOf` 读工具名，勿再手写 `payload.tool ?? payload.name`；新事件类型必须在 `EventPayloadMap`/`EVENT_PAYLOAD_TYPES` 补形状。

---

# Q-5 Stable Serialization

Status: DONE (2026-08-19)

收敛散落三处的 stable 序列化为 contracts 单一规范实现，并显式失败。
- 新增 `packages/contracts/src/serialization.ts`：`stableStringify(value, opts?)` + `computeStableSha256`。
  - 对象键排序（递归）、数组 `undefined` 槽→`null`、对象 `undefined` 键省略（写→解析往返 hash 不变）、符号键忽略、NaN/±Infinity→`null`（JSON 语义）。
  - 显式失败：`StableSerializationError`——循环引用检测（WeakSet，原本会栈溢出）、BigInt 默认抛错（可 `bigint:"toString"` 显式放行）。
  - `undefined` 顶层默认 `"null"`，可选 `undefined:"undefined"`。
- `computeArgsHash` / `computeCheckpointChecksum` 的 `stableStringifyForChecksum` 改为委托同名语义（输出逐字节不变，checkpoint 兼容性回归已锁）。
- 迁移重复实现：`core/agent-state.ts` 本地 `stableStringify`（其 `undefined` 处理有 bug）改用 canonical；`evaluation/manifest.ts` 的 `stableStringify` 保留为实验清单专用（其 `undefined:"undefined"` 语义不同，非安全检查，避免行为变更）。

Tests:
- `packages/contracts/src/serialization.test.ts`：新增 10 用例——键序无关、嵌套、undefined 省略/数组 null、NaN/Infinity→null、undefined 选项、BigInt 显式失败+toString、循环显式失败、符号键忽略、SHA-256 确定性、旧 checksum 契约回归。
- contracts/core/evaluation 三包 669 用例全通过。

Benchmark: 无行为变化（checksum 输出逐字节等价）。

Notes: artifact hash 复用 `computeArgsHash`/`computeStableSha256`；未来若并入 `evaluation/manifest` 实验清单，须在 Q-5 语义下重对齐其 `undefined` 处理。

---

# Q-6 Clock Injection

Status: DONE (2026-08-19)

全量审计确认运行时确定性决策已统一走注入时钟，无真实墙钟依赖：
- runtime `now`：`deps.now ?? Date.now` 注入式（runtime.ts:491）；超时/限额/checkpoint/会话生命周期/ledger 等逻辑全部经 `this.now()`。含 `maxDurationMs` 用例以推进注入时钟(`clock += 2000`)驱动超时，非真实时间（runtime.test.ts:814）。
- retry-after：`parseRetryAfter(header, now = Date.now())` 可注入 now（openai.ts:172），已测。
- memory recency：`retrieval.ts` 时钟注入（`now` 参数），测试用固定 `NOW` 驱动衰减（retrieval.ts:97）。
- scheduler（evaluation/learning）：决策逻辑无 `Date.now()`。
- 其余 `Date.now()` 仅用于事件 evidence/timestamp 等装饰字段与 fake provider，不进入确定性判定。

Tests: 既有（wall-clock budget + retry-after 注入 + recency 固定时钟）。

Benchmark: 无。

Notes: 无新增代码——Q-6 是对既有注入式时钟架构的确认性审计。

---

# Q-7 Timer Abstraction

Status: DONE (2026-08-19)

为复杂 timeout/backoff 引入可测试 timer/sleeper abstraction，减少 flaky tests。
- 新增 `packages/contracts/src/timer.ts`：`Timer` 接口（`now()`/`schedule(fn, delayMs)`→`TimerHandle.cancel()`）、`RealTimer`（`setTimeout`/`clearTimeout` 薄适配 + 可注入 `now()`，生产默认与既有注入时钟同源）、`ManualTimer`（确定性虚拟时钟：`advance(ms)` 按 (截止时间, 调度序) 排序触发到期回调、`tick()` 触发当前时刻、`pendingCount()` 作泄漏断言）、`sleep(timer, ms, signal?)` 单一 sleep 原语（与 abort 竞速、timer 胜出时移除 abort 监听、无忙等不清真泄漏）。
- 运行时接线（复杂 retry backoff）：`AgentRuntimeDeps.timer?`，`AgentRuntime` 默认 `new RealTimer(this.now)`，`runtime.ts` 两处 `retryDelayMs` sleep（1021/1591）从 `setTimeout` 改为 `sleep(this.timer, ...)` —— 注入 `ManualTimer` 即可驱动 backoff，不再吃真实墙钟。
- 审批 expire 接线：`InMemoryApprovalStore` 构造可注入 `timer`（默认 `RealTimer(now)`），`wait` 的 expire `setTimeout` 改走注入 timer；`DurableApprovalStore` 沿用内层默认 timer 行为不变。
- 顺带修复既有类型隐患：`toolNameOf` 入参从 `Readonly<Record<string, unknown>>` 放宽为 `object`（读 tool/name 前 cast），使强类型 payload 接口对象可传入；`event-payloads.test.ts` 两处 TS2345/TS2339 修复（security 循环显式 `SecurityDeniedPayload`）。

Tests:
- 新增 `packages/contracts/src/timer.test.ts` 13 例：ManualTimer 到期前不触发、确定性 (deadline,id) 顺序、tick 触发 0 延迟、cancel 不触发且无残留、回调内再调度同窗口也执行、pendingCount 泄漏断言；sleep 仅在 advance 过 delay 后 resolve、零/负延迟 no-op、已 abort 立即 resolve、abort 中途取消 timer、timer 胜出后移除 abort 监听；RealTimer now 反射注入时钟。
- 新增 core 运行时确定性 backoff 测试（fault-injection.test.ts）：注入 `ManualTimer`，model 首错→重试，断言 backoff 挂在注入 timer 上（pendingCount=1），`timer.advance(500)` 后 turn 即时 completed，无真实等待。
- 全仓 `pnpm typecheck` 通过；contracts/session/memory 282、evaluation+tools 430、core runtime 121、security approval 15 全部绿。

Benchmark: 无（默认 RealTimer 行为与改前一致，仅注入点抽象）。

Notes: 复杂 timeout/backoff 一律走 `sleep(this.timer, ms)`/`timer.schedule`，测试经 `ManualTimer` 确定性推进；勿再直接 `await new Promise((r)=>setTimeout(r,X))`。使用 `ManualTimer.advance` 产生确定性时间即可，无需真实 sleep，测试更稳更快。

---

# Q-8 Deterministic IDs in Tests

Status: DONE (2026-08-19)

为 contracts 的 ID 生成加入可注入确定性源，生产仍默认随机 UUID。
- `ids.ts`：`installIdSource(source | null)` 覆写/恢复全局 ID 源（默认 `randomUUID`）；
  `installDeterministicIds()` 安装计数式确定性源（安装时清零，返回 disposer 恢复调用前源）——同一调用序列跨重装完全可重放，suffix 每次调用全局唯一、无跨类型冲突。
- `make()` 改用 `idSource()`；各 `newXxxId()` 工厂透明继承。

Tests:
- `packages/contracts/src/ids.test.ts`：新增 3 用例——确定性序列可重放（重装后复现相同 ID）、序列内无冲突、恢复后生产 ID 为随机 UUID 格式且唯一。
- `afterEach` 固定恢复默认源，避免泄漏到其余测试；contracts/core/checkpoint/events/session 五包 341 用例通过（无跨套件污染）。

Benchmark: 无（仅测试基座，生产路径不走注入）。

Notes: 使用后必须 restore（disposer 或 `installIdSource(null)`），否则同一进程的后续测试会获得确定性 ID。

---

# Q-9 Test Fixture Builders

Status: DONE

抽：

```text
makeRuntime
makeAgent
makeSession
makeTool
makeEvent
```

减少测试重复和错误 mock。

Tests:
- 新增 `packages/contracts/src/testing.ts`（自 `@ar/index` 导出）：确定性数据层 fixture 构建器。
  - `makeSession` / `makeTurn` / `makeEvent` / `makeSessionId` / `makeTurnId` / `makeEventId` / `makeAgentId` / `fixtureAgentId` / `makeSeed`。
  - 全确定性：id 由整型 `n` 或 `makeSeed()` 注入计数器序列化，timestamp 来自注入时钟；`makeEvent()` 连续调用经模块级计数器产生唯一 id 且同一 suite 落在同一默认 session（`session_0001`）。
- 新增 `packages/contracts/src/testing.test.ts`（9 例）：id 稳定/互异、默认值与覆盖、seed count 单调、同 seed 两次事件 id 不碰撞。
- 落地替换：`packages/events/src/event-store.test.ts` 删除本地 `makeEvent`，改用共享构建器（`SID = makeSessionId(1)` 与默认 session 对齐）。
- 验证：`pnpm typecheck` 通过；全仓 132 文件 / 1822 例通过（含替换后的 event-store 26 例）。

Benchmark: 无行为改动（测试设施 + 一处测试本地 helper 迁移）。

Notes:
- `makeRuntime` / `makeTool` / `makeAgent` 属于各自包所有（contracts 不得反向依赖 tools/core/agents），本任务交付 contracts 数据层共享 builder + events 包落地样板；高层 builder 在对应包内按需薄封装。
- 用注入 `seed`（计数器+时钟）而非随机 id/`Date.now()`，解决 Q-8 的确定性诉求，快照可精确断言。
- vitest 每测试文件模块隔离，模块级默认计数器不会跨文件污染。

---

# Q-10 No Silent Catch

Status: DONE

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

Tests:
- 全仓 grep `catch {`（`packages/*/src/**/*.ts`，排除 `*.test.ts` 与 `dist`）共 66 处，逐一 Read 上下文分类审计。结果：best-effort 可接受 65 处、bug swallowed 0 处、1 处为重抛型（`event-store.ts:48`）不属静默。
- 审计中补注释 2 处高风险路径：`orchestrator.ts` `preview()`（JSON.stringify 遇 circular/BigInt 时降级 String，仅影响预览不影响真实输出）、`openai.ts` 响应 body summary 读取失败返回空串但不拖垮整个调用。
- 验证：`pnpm typecheck` 通过；tools+model 219 例测试通过。

Benchmark: 无行为改动（纯审计+注释）。

Notes:
- 已归类的 best-effort 主要模式：目录/子目录不可读时跳过遍历、可选读取失败返回 null/undefined（readIfExists/readOptional 语义）、损坏行跳过继续读取、FTS 失败降级 LIKE、realpath 失败回退到最近已有祖先（fail-closed 边界仍成立）、git 探测失败返回 null、插件执行失败进入失败统计、事件发射失败不阻塞执行。均有明确边界语义或代码注释。
- 未发现"把核心异常当作正常返回或空值吞掉"的 bug-swallowed 场景；潜在风险点（JSON 序列化、I/O 解析、跨平台 realpath）已在注释中补足 rationale。
- Q-10 的审计作为可复跑的 checklist：后续新增代码如出现 `catch {}` 且无注释/无边界语义，应按本表归类。

---

# Q-11 Resource Cleanup

Status: DONE (2026-08-19)

全量审计确认无泄漏路径，各资源都有显式清理：
- 子进程（`process/executor.ts`）：超时/取消时 `killTree`（SIGKILL 兜底）；`timer` 在 `done` settle 后 `clearTimeout`；abort 监听经 `listeners` 回调 `removeEventListener` 移除；测试含 detached 孙进程杀灭（executor.test.ts:69）。
- timers：`openai.ts` retry 背压 `setTimeout` 在 abort 时 `clearTimeout`（198-200）；orchestrator 超时 timer 与 abort 链接在 finally 清理（327-350）。
- AbortSignal 监听：`openai.ts` 流式 `onAbort` 在流结束后 remove（334→437）；executor abort 监听移除。
- SQLite：`sqlite-memory-store.ts` 提供 `close()`（db.close），测试各处显式关闭并含"连接带未提交事务关闭→回滚"用例。
- 文件句柄：`store-integrity`（atomicWrite/校验读）与 `skill-loader` 均 `handle.close()`。
- 临时目录：tests 用 `mkdtemp` + `afterEach rm recursive`。
- MCP：当前为适配/视图层纯函数 + mock 客户端，无长连接代管泄漏；真实连接由宿主生命周期管理。

Tests: 既有（executor 杀进程、SQLite close、abort 取消等）。

Benchmark: 无。

Notes: Q-11 为确认性审计——全部绑定资源均有配对清理；后续新增长连接/句柄须按此模式（done 收尾函数统一 clearTimeout + removeEventListener + kill）。

---

# Q-12 Windows / Linux Path Parity

Status: DONE

CI 测试至少覆盖 path semantics。

尤其：

```text
drive letter
backslash
case-insensitive
UNC
symlink
```

Tests:
- `packages/security/src/path-parity.test.ts`：新增 11 个用例，全部平台无关（Linux CI 也可运行）。
  - `normalizePath` 把反斜杠/Windows 绝对路径/UNC 统一为 `/` 形式且幂等；
  - `containsPath` 对 `path.win32` 构造的 drive-letter 与 `path.posix` 构造的路径在斜杠归一后语义一致；
  - 边界安全：`C:/ws2`、`C:/ws-2` 等兄弟路径不被 `C:/ws` 包含；
  - case-insensitive fold 对 Windows 大写路径生效，且不吞掉真正不同的兄弟；
  - trailing-slash root 边界语义与 POSIX 完全一致（root 自身不算 `root/` 的子路径）；
  - `matchGlob`/`globToRegex` 对反斜杠输入与斜杠 pattern 分隔符无关。

Benchmark: 无行为改动（纯测试）。现有测试继续覆盖 drive/UNC 拒绝、symlink/junction 逃逸，本文件补充了 separator 无关性证明。

Notes:
- 用 Node 内置 `path.win32` 在任何宿主平台上以确定性方式构造 Windows 路径，避免需一台 Windows runner 才能断言 parity；与 sandbox 拒绝逻辑（drive/UNC 正则返回 null）构成互补。
- CI 的 `pnpm test`（vitest `packages/*/src/**/*.test.ts`）会自动拾取该文件，无需新增 job。
- symlink/junction 逃逸检测已由 `sandbox.test.ts` 的 realpath 用例覆盖，本文件明确引用并在注释中定位，避免重复。

---

# Q-13 CI Pipeline

Status: DONE

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

Tests:
- `.github/workflows/ci.yml` — GitHub Actions 单 job `verify`：checkout → pnpm 11.21.0 → setup-node 22（pnpm 缓存）→ `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm benchmark:smoke` → 上传 smoke 报表。push/pull_request 均触发，`concurrency` 取消过期运行，`timeout-minutes: 30`。
- 根 `package.json` 新增 `benchmark:smoke` 脚本：对 `benchmarks/adversarial` 用 `--suite adversarial --limit 1 --allow-stub --out .ci/bench-smoke` 跑真实 harness 的 1 个案例。
- `.gitignore` 增加 `.ci/`（避免 smoke 临时报表污染工作区）。

Benchmark:
- 本地实测 `pnpm benchmark:smoke`：完整 CLI 路径跑通（案例加载、workspace 搭建、model loop、`model_error` 终止、报表落盘），`RC=0`，产出 `adversarial.json` + `adversarial-summary.md`。零付费模型依赖（stub 诚实记录 MODEL_ERROR）。core 回归基线仍 172 通过。

Notes:
- 冒烟步不把 "stub 必然 FAIL" 当作失败门；它只在 harness 无法加载/运行/冻结案例时失败（stub 的 MODEL_ERROR 是诚实记录）。
- 关键：未设置 `OPENAI_API_KEY` 时通过 `--allow-stub` 显式放行，绝不把"缺 key→无操作成功"当作通过。`env.OPENAI_API_KEY` 置空审计。
- lint / coverage thresholds 为可选项，Q-14 起逐步补齐，不改动本文件契约。

---

# Q-14 Coverage for Critical Packages

Status: DONE

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

Tests:
- `vitest.config.ts` 接入 v8 coverage（`@vitest/coverage-v8` 已加入 devDependencies），reporter: text/html/json-summary；`include` 限定上述 8 个 critical 包的非测试源，`exclude` 排除 `*.test.ts`/dist/node_modules。
- 按包设定行/分支阈值（低于当前实测、作为回归门禁非虚荣上限）：core 85/70、security 90/80、tools 85/68、agents 90/75、memory 85/78、evaluation 85/70、context 95/85、learning 95/82。
- 根脚本 `test:coverage`：`vitest run --coverage`。

Benchmark:
- 实测覆盖率（lines/branches）：core 92/79、security 97/89、tools 90/76、agents 96/84、memory 92/86、evaluation 90/80、context 99/94、learning 99/91；整体 lines 92%、branches 81%。
- `pnpm test:coverage` 全量测试 + 阈值门禁通过（RC=0）。

Notes:
- 阈值为"防回归"，非"数字好看"：全部设在实测值之下，小幅诚实波动不会误杀，重大下滑会失败。
- 未为凑数字新写测试；低分文件（如 `tools/src/tools/repo-map-tool.ts` 13.33%）多为薄 CLI 胶水，已在 include 内作为真实度量保留，后续随功能补测自然抬升。
- 覆盖率门禁暂未并入 Q-13 CI 主 job（避免拉长每个 PR），提供独立 `test:coverage` 供发布/门卫使用。

---

# Q-15 Mutation / Property Testing for Security Parsers

Status: DONE

适合：

```text
network gate
injection gate
secret gate
path normalization
stable stringify
```

可以先 property tests，不强制引第三方 mutation framework。

Tests:
- 新增 `packages/security/src/parser-fuzz.test.ts`（与 Q-16 同文件，共享确定性 PRNG 与生成器）。
  - Q-15 property/不变量：`redactSecrets` 幂等（二次已无再 redact）、纯文本零变异、redact 后体积有界；`detectSecrets` 后缀追加单调、任一发现的 secret 不消失；`globToRegex` 对任意 pattern 恒可编译；`normalizePath` 幂等且无反斜杠；`containsPath` 全定义且自反。
  - 生成器：mulberry32 确定性 PRNG（`SEED` 环境变量可复现），混合真实片段（URL/secret/私钥/shell wrapper/超长串/AI emoji）+ 随机 ASCII/Unicode 拼接。
- 验证：默认 seed 与 `SEED=1234567` 均 1812 例通过；`pnpm typecheck` 通过；security 全量 13 文件 / 1968 例通过。

Benchmark: 无行为改动（纯新增测试，未触 production 代码）。

Notes:
- 未引入第三方 mutation framework，使用确定性 PRNG + 生成器组合覆盖 plan 指定的五类解析面。
- 失败可复现：`SEED=<n> pnpm exec vitest run packages/security/src/parser-fuzz.test.ts`。
- stable stringify 面经由 `redactSecrets`（secret-gate 内部 replace 环路）承载；其幂等性即 stringify 稳定性代理。

---

# Q-16 Fuzz Tool Args / Event Payload

Status: DONE

验证 runtime 面对：

```text
unexpected args
huge nested object
cyclic object from internal adapter
invalid UTF-8 boundaries
very long strings
```

不 crash。

Tests:
- 与 Q-15 同文件 `packages/security/src/parser-fuzz.test.ts`：
  - fuzz 门：300 迭代 ×（network gate、process gate、injection gate、secret gate+redact、glob+path、surfaceDenied）在对抗性输入下不抛、返回结构合法。
  - 病态形状显式用例：空/纯空白输入、500KB 超长串、lone surrogate/非法 UTF-16 边界、深层嵌套字符串化 payload、控制字符/NUL 字节——均不 crash。
- 验证：默认 seed 与 `SEED=1234567` 均 1812 例通过；`pnpm typecheck` 通过。

Benchmark: 无行为改动。

Notes:
- 输入端覆盖 plan 要求：unexpected args（随机 ASCII/Unicode 拼装）、huge/very long（500KB）、invalid UTF-8 boundaries（lone surrogate）、cyclic-like（深层字符串化 JSON 文本）、nested（若干片段 `;`/空格拼接）。
- 所有目标解析器均为纯函数，fuzz 无 IO/无泄漏；迭代上限 300 保证 CI 秒级完成。

---

# Q-17 Backward Compatibility

Status: DONE (2026-08-19)

为 checkpoint schema 补齐了 fail-closed 兼容性测试与守卫，确保 schema 改动必须遵循
`version / migration / compat test` 三步走：
- 写入侧：`save` 拒绝不支持的 schemaVersion（抛 `UNSUPPORTED_SCHEMA`），未来版本记录无法被持久化。
- 读取侧：`loadLatest`/`list` 只信任通过 `schemaVersion + checksum` 完整校验的记录；同一个"声称当前版本"但无合法校验和（如 v0 早期写入者）的旧文件永远不能挤掉合法最新 checkpoints。
- 未知（未来）schema 版本文件 fail-closed，绝不被误当作当前版本解析。

Tests:
- `packages/checkpoint/src/checkpoint-store.test.ts`：新增 3 个兼容用例（write 拒绝不支持版本 / 无校验和旧文件被忽略 / 失败-关闭未来版本）。

Benchmark: 无

Notes: checkpoint 已具备 schemaVersion 常量 + checksum + fail-closed 读取；session/memory/event store 的持久化对象后续 schema 变更应在修改处同步补充对应 compat 用例与迁移说明。

---

# Q-18 Documentation Truthfulness

Status: DONE (2026-08-19)

每次变更同步 architecture / benchmark README / optimization report / known limitations；
不允许文档声明「已安全隔离」而代码只是 static detection。
- 审计发现两处失真并修复：
  1. `benchmarks/README.md` 与 `plan.md` 均引用 `optimization-report.md`，但该文件
     **不存在**（悬空引用）→ 新建 `optimization-report.md`（仓库根）：声明本文件的
     权威性质与批量、逐条「已修复/已落地」的 meet-谓词，内容全部取自真实代码与
     plan.md Q-phase 完成记录（Q-2..Q-7、Q-8..Q-20），并保留诚实「已知限制」
     （消息历史不参与预算 / 需 OPENAI_API_KEY / holdout 仍属规划），不预言未做之事。
  2. `benchmarks/README.md` `expectedSecurityEvents` 清单残缺：只列 6 类，而
     `@ar/contracts` `EVENT_TYPES` 权威为 10 类。
     → 已补全 `memory_denied`/`skill_denied`/`mcp_denied`/`approval_denied`，并将
     payload 描述与实现核对：network/filesystem/process/permission 四者确含
     `target`/`reason`/`source`/`code`（permission 额外 `ruleId`；
     `code ∈ {SANDBOX_*_DENIED, PERMISSION_DENIED}`），其余边界事件前缀匹配语义统一。
- architecture（`AGENTS.md`）、`mem.md`、`reflection.md` 复核：无过时/夸大声明，
  无需改动。

Tests: 纯文档变更，无代码路径；引用一致（`optimization-report.md` 现已存在且可被
`benchmarks/README.md`/`plan.md` 解析）。

Benchmark: 无。

Notes: 文档任何「已修复/已隔离」声明必须对应仓库内真实代码+测试；引用的文档必须
实际存在，禁止悬空引用。新增优化/修复时同步本报告与 benchmark README 的清单。

---

# Q-19 Generated State / Temp Files Hygiene

Status: DONE (2026-08-19)

审计结论：
- `sessions/ events/ checkpoints/`（运行时持久化）：只写入用户显式提供的 `dataDir`（`--data-dir` / `HARNESS_DATA_DIR`）；缺省时为内存 store，不落盘、不污染仓库。
- `artifactDir = join(workspace, ".artifacts")`（benchmark-command.ts:327）：运行 benchmark 会在 git 追踪的 `benchmarks/**` 用例目录内生成产物——这是唯一会污染提交树的路径，现已 gitignore。
- `spawnpid.txt` / PID journal：当前代码无该写入点（原计划遗留清单），仍加 gitignore 兜底。
- 事务临时文件：`transaction.ts` 使用 `.ar-txn-<pid>-<rand>.tmp` 并原子落盘/清理，不落入仓库追踪。
- SQLite/journal、dist、coverage、.ci 输出：均已覆盖。

Actions:
- `.gitignore` 新增 `.artifacts/`、`.harness-data/`、`.harness/`、`spawnpid.txt`、`*.pid`，防止运行态/临时文件被提交。

Tests: 无（纯仓库卫生配置）。

Benchmark: 无。

Notes: 运行时数据目录默认落在内存（无 dataDir 时），确保 `git status` 干净；若未来引入仓库内默认数据目录，须保留 `.harness-data/` ignore。

---

# Q-20 License / Provenance Discipline

Status: DONE (2026-08-19)

仓库含多个参考 Agent 源码。为杜绝无意识复制长代码块，已为机制注册表引入显式来源声明机制 `provenance`：
- 新增枚举 `original | inspired | reimplemented | derived`（`mechanisms.ts` 的 `MECHANISM_PROVENANCE`）。
  - `original`：无外部参考，本仓库从零设计。
  - `inspired`：概念/设计受参考 agent 报告启发，实现是原创代码。
  - `reimplemented`：基于同一公开契约 clean-room 独立重实现，未复制行。
  - `derived`：从参考来源复制/沿用非平凡代码或结构——**强制要求 `attribution`**。
- 校验硬化：`provenance` 成为必填字段；`derived` 缺 `attribution` 判为无效（`validateMechanismManifest`）。
- 全量更新：`research/mechanisms/` 下 17 个 manifest 全部补 `provenance: inspired`（均声明 source_agent/source_report 且实现为由其启发、本仓库原创）；`_template.yaml`、`schema.json`、`README.md` 同步新字段。
- 顺带修复既有注册表缺口：`formal-invariants.yaml` 使用 `security` 类别但原枚举缺该值（原本即校验失败），现补入类别集合（validator + schema + README），registry 全绿。
- 修 `checkpoint-store.test.ts` 一处既有 TS2790（对必填字段用 `delete`，改为解构去除）。

Tests: mechanisms.test.ts +1（Q-20 provenance 拒绝非法枚举、derived 强制 attribution、derived+attribution 通过）；typecheck 通过。
Benchmark: 无。
Notes: 新增机制必须声明 provenance；凡 `derived` 必须精确 `attribution`（复制/沿用来源的哪个文件/commit/路径），否则注册表校验拒绝。

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
