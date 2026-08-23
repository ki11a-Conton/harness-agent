# 交接文档（HANDOFF）

- **生成时间**：2026-08-23 22:35（GMT+8）
- **仓库**：`D:\Download games\harness agent\harness-agent-src\harness-agent`（多包 TypeScript，pnpm workspace）
- **当前阶段**：P35（架构收尾/发布门槛），P34 全部完成

---

## 0. 任务状态总览

| 任务 # | 阶段 | 状态 | 说明 |
|---|---|---|---|
| #1–#29 | P27/P28/P29/P30/P31/P32/P33/P34-1~P34-8 | ✅ completed | 全部落地并回归 |
| #30 | **P35-1 移除过时全局依赖** | 🔄 **in_progress** | **主体代码已完成**，仅剩全量回归收尾（见 2.1） |
| #32 | P35-5 最终发布门槛验证 | ⏳ pending | 未开始 |
| #33 | P35-3 架构文档 | ⏳ pending | 未开始 |
| #34 | P35-4 迁移说明 | ⏳ pending | 未开始 |
| #35 | P35-2 能力矩阵真实化 | ⏳ pending | 未开始 |

---

## 1. 已做的工作（本会话 + 前序会话，供下一位 Agent 参考）

### 1.1 P34-5 / P34-6 — AppServer + SDK 一致性（✅ 全绿）

- **新建 `packages/gateway/src/stdio-transport.ts`**：同进程 JSONL 帧传输，`client/server` 角色，`pair()`/`connect()`。关键修正：**`pair()` 必须双向引用**（`this.peer=server; server.peer=this`），之前仅单向赋值导致 peer undefined、reply 被丢弃 → 挂死。
- **新建 `packages/gateway/src/transport-conformance.test.ts`**：20/20 通过（InMemory 与 Stdio 各 10），覆盖 initialize gate、方法映射、并发 SESSION_BUSY、背压 SERVER_OVERLOADED、中断/steer/cancel、reconnect replay。
- **修改 `packages/gateway/src/app-server.ts`**（真实适配缺口修复）：
  - 错误码透传：`if (err instanceof AgentError) return { error: { ...err.info } };`——此前只认 `ProtocolError`，`AgentError` 被吞成 INTERNAL_ERROR。
  - `mapMethod` 移除 `thread/read → session.status` 的错误映射；新增私有 `readThread()`：从 `deps.events` 拉拼接，用 `ProtocolEventMapper` 映射为 `{threadId, items, nextSequence}`；`invoke` 中 `thread/read` 分支提前于 `mapMethod`。
  - `adaptParams` 补 turn 系映射：`threadId → sessionId`、`prompt → text`。
- **新建 `packages/sdk/src/conformance.test.ts`**：3/3 通过，覆盖三路径等价：
  - `rawClientRun`：transport.subscribe + 手动 reduce；
  - `sdkStreamed`：只消费 events 流、不 await done；
  - `sdkRun`：`toEqual` 结果（SDK 在 done 后附加 turnId 等字段，比对时排除）。
- **关键坑（必读）**：`EventChannel` 是**单消费者** AsyncIterable——`runStreamed` 返回的 `events` 与 `done` 共享同一可迭代对象，**不可双消费**，否则死锁（P34-6 排查出的挂死根因）。

### 1.2 P34-7 — 配置漂移矩阵（✅ 13/13）

- **新建 `packages/harness/src/config-drift-matrix.test.ts`**：覆盖 `process_static / session_frozen / turn_dynamic / step_dynamic` 四个生命周期类别 × 变更方向，加 `emergency_revocation`、`next_step`。
- 生产消费点：`packages/harness/src/create-harness.ts` 674–735 行 `checkSessionConfigDrift`——severity reject/restart_required → 抛 `CONFIG_DRIFT_REJECTED`（fail-closed），否则放行并重新冻结。

### 1.3 P34-8 — 安全回归矩阵（✅ 12/12）

- **新建 `packages/harness/src/security-regression-matrix.test.ts`**：聚合 `detectPromptInjection/detectSecrets/redactSecrets/canonicalizePath/composeCapabilities`、`DefaultGrantCache`、`ERROR_RETRY_DEFAULTS`。
- **注意**：`ERROR_RETRY_DEFAULTS` 定义在 `@ar/contracts`，不是 `@ar/security`；`approveRequest`/`grantCoversRequest` 不存在，实际 API 是 `approvalFingerprint` + `newApprovalId`；`detectSecrets` 返回 `{ hasSecret, secrets: string[] }`。openai-key 样例需 `sk-`+20 字符；stripe 用 `sk_live_` 下划线。

### 1.4 全包回归绿

| 包 | 结果 |
|---|---|
| harness | 26 文件 / 182 测试全绿 |
| gateway | 85/85 |
| sdk | 9/9（P34-6 后） |
| core runtime.test.ts | 72/72（P35-1 改动后） |

### 1.5 P35-1 — 移除过时全局依赖（主体完成，见 2.1 收尾项）

**审计结论（全部确认干净）**：
- ✅ 全局 `toolSelector`：仅在 `buildStepExecutionSnapshot` 内调用一次（`packages/core/src/runtime/step-snapshot-factory.ts:134`），且 `model-call-controller.ts` 有 `_stepFrozenAdvertisementOnly?: never` 哨兵字段防回归；
- ✅ 全局 registry resolve：`tool-call-controller.ts:503` 一律 `step.tools.resolve()`（冻结绑定），不存在全局回退；
- ✅ 全局 MCP tool list：仅 `mcpBindingProvider` 在 snapshot build 时调用（runtime.ts:1206）；
- ✅ `ctx.agent.tools` / `session.agent.tools`：零残留；
- ❌ **唯一残留死字段 `AgentRuntimeDeps.toolSpecs`（runtime.ts:290）**——已删除。

**本次改动文件清单**：
1. `packages/core/src/runtime/runtime.ts`：
   - 删除 `AgentRuntimeDeps.toolSpecs?: readonly ToolSpec[]` 死字段（原 LOOP-001 注释：deprecated and ignored）；
   - 删除 `ToolSpec`、`StepContext` 两个死 import（StepContext 仅剩注释引用）；
   - 私有字段注释更新为「toolSpecs removed，advertisement 由 catalog 冻结」。
2. `packages/core/src/runtime/runtime.test.ts`：
   - `makeRuntime` opts 类型删除 `toolSpecs?`，新增 `toolRegistry?`；
   - registry 构造改为 `opts?.toolRegistry ?? defaultTestToolCatalog()`（不再从 toolSpecs 间接派生）；
   - P7 用例改为直接传显式 `toolRegistry`（含 `weather_lookup` 的 6 工具 catalog），并给 `get/list/specs` 补显式类型消除隐式 any；
   - 删除不再使用的 `z` import，导入 `inertTestToolDefinition`。
3. **保留不动**：`contracts/step-context.ts:37` 的 `StepContext.toolSpecs`——它是 P31-1 明确的「compatible legacy surface」+P23-1 intentional syrface，**不要删**。

**验证结果**：
- 全仓 `node_modules/.bin/tsc -b`：非 race 系列错误 **全部清零**（P35-1 改动 typecheck 干净）；
- `runtime.test.ts`：**72/72 全绿**；
- harness 包 create-harness（toolSelector 传递链）不受影响。

---

## 2. 未做的工作（下一位 Agent 的 To-Do）

### 2.1 🔴 P35-1 收尾（唯一进行中）

代码主体已完成（见 1.5），只差**最终全量回归确认**：
- 跑 `cd harness-agent && node_modules/.bin/vitest run packages/core/src`，**确认失败仅剩 race 系列**（见 3.1 已知噪音），P35-1 相关文件（runtime.ts / runtime.test.ts）全绿；
- 通过后把任务 #30 标记 completed，并**回填 plan.md 的 P35-1 小节**（记录审计结论 + 改动 + 验证数字）。

### 2.2 P35-2 能力矩阵真实化（plan.md:3351）

给能力矩阵加区分维度，杜绝「实现 ≠ 生产接线」的虚报：

```
implemented / productionWired / snapshotAuthoritative / durable / tested
```

建议按 P34-7 drift 矩阵与 P34-8 安全矩阵的覆盖交叉验证每行能力。

### 2.3 P35-3 架构文档（plan.md:3367）

创建这些文档，**每篇写不变量（invariants），不是只画类图**：

| 文档 | 核心不变量（至少） |
|---|---|
| `docs/architecture/runtime-scopes.md` | 配置生命周期 4 类 × 变更方向 |
| `docs/architecture/tool-snapshot.md` | INV-V5-001/002（advertised==executed fingerprint；step 绑定） |
| `docs/architecture/session-actor.md` | INV-V5-005（单活动 turn） |
| `docs/architecture/durability.md` | durable 边界 |
| `docs/architecture/app-server.md` | 协议 DTO、错误码透传 |
| `docs/architecture/mcp-runtime.md` | INV-V5-003（MCP generation 不静默升级） |
| `docs/architecture/orchestration.md` | P33 reconcile/authoritative state |

### 2.4 P35-4 迁移说明（plan.md:3385）

公开变更文档，覆盖：Step 兼容面、RPC→App Server、SDK 包、approval 类型化能力、config layers、MCP 惰性语义。

### 2.5 P35-5 最终发布门槛（plan.md:3400）

最低要求：

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm test:coverage && pnpm docs:verify
```

本项目附加：production-audit、benchmark smoke、protocol conformance、chaos suite。

---

## 3. 已知噪音与工具坑（务必先读，避免误判）

### 3.1 既有测试噪音（NOT 你的回归）

- **race 系列**（`race-part*.test.ts` / `race-bisect*.test.ts` / `race-split.test.ts`）：多轮会话一直存在的失败（如 `race-split.test.ts:117` 期望 `/SESSION_BUSY/` 却收到 `"session ... already has an active turn (turn_...)"`），**与任何 P-* 改动无关**。typecheck 过滤这些文件的 error 行后全绿。
- **Windows 平台限制**：`@ar/security` canonical-path/boundary-guard 12 条 POSIX 路径断言在 win32 失败（`path.resolve` 加盘符）；`adversarial-regression.test.ts` A2 symlink EPERM（Windows 未开开发者模式）——既有模式为 try/catch 优雅跳过。
- **git 索引错乱**：多阶段仓库搬移后 `git status` 把大量文件标为 deleted，**不要用 git diff 判断改动范围**，用本次给的文件清单。

### 3.2 工具层已知坑

- **pnpm 不可用**：corepack 入口坏 + 代理不可达 → 所有命令用 `node_modules/.bin/` 直接调：
  - typecheck：`node_modules/.bin/tsc -b`（慢，后台跑；过滤 `race-*`）
  - 测试：`node_modules/.bin/vitest run <path>`
- Windows 下全仓 vitest 很慢（core 全量 ~6-7 分钟），建议后台运行。

### 3.3 环境信息

- 用户指定终端 pwsh 7.6.5；工作日志在 `D:\Download games\harness agent\harness-agent-src\.workbuddy\memory\2026-08-23.md`；教训沉淀在仓库根 `mem.md` 的 PHASE 小节。
- 大坑记录：`(async function* {})()` 非法（需 `async function*()`）；fire-and-forget spawn 要 `setImmediate`；Windows pnpm 不可用 → `ln -sfn` 手工建 `node_modules/@ar` 链接已就绪。

---

## 4. 给下一位 Agent 的快捷路径

1. 读本文件 → `plan.md` P23–P35 段 → `mem.md` PHASE 28-34 即可恢复全部上下文；
2. 先用 `tsc -b` 看非 race 错误，0 即开工；
3. P35-2→P35-3→P35-4→P35-5 顺序执行，每步回归对应包；
4. 完成后回填 plan.md，更新任务列表 #32–#35 为 completed，并在 `.workbuddy/memory/2026-08-23.md`（或新一天文件）追加日志。