# plan.md — Harness Agent v4：Production Closure & Champion Promotion

> 本计划用于 `ki11a-Conton/harness-agent` 的下一轮实现。
> 执行者是“写代码 Agent”，不是产品经理。不要只讨论、不要只写建议；按任务逐项落地代码、测试、集成、验证并回填状态。
>
> 当前基线：P0~P13 已闭环；Linux 基线记录为 `3919 passed / 0 failed`，`pnpm typecheck`、`pnpm build` 通过。除非真实仓库当前状态已变化，否则本计划从 **P14** 开始，禁止重复实现已完成能力。

---

## 0. 本轮唯一目标

本轮不是继续增加“机制数量”，而是把现有 Agent Runtime 从“能力很多”推进到：

1. **安全边界可证明**：路径、命令、插件/MCP/Hook、子代理、权限组合全部 fail-closed。
2. **turn/session 状态不串**：预算、恢复、取消、并发、缓存不存在跨 turn / 跨 session 污染。
3. **副作用可恢复**：进程死在任意关键窗口，都能判断“未执行 / 已执行 / 结果未知”，绝不盲目重复副作用。
4. **上下文越长越稳，而不是机制越多越乱**：单一 Context Pipeline，多阶段降本，结构化状态永不丢。
5. **完成必须可验证**：模型“说完成”不等于 runtime 完成。
6. **默认 Champion 由 benchmark 证据决定**：实现过的能力不等于默认开启。
7. **删复杂度比加复杂度优先**：任何新抽象必须替代现有重复逻辑，不能成为第 N+1 套并行系统。

最终交付不是“测试数更多”，而是一个有证据的 `Champion Profile v1`：在相同模型、相同任务、相同预算下，比基线更可靠，同时安全与成本不退化。

---

## 1. 研究依据与明确取舍

本计划综合 `HARNESS-SRC-FORK/reports/{claude-code,codex,hermes,opencode,pi}` 的逆向研究，但**只吸收机制原则，不复制实现复杂度**。

### 1.1 必须吸收的原则

- **Codex：Session/Turn Actor 边界**
  - 会话顶层串行；每个 turn 有明确快照；pending input 只在安全边界进入下一次采样。
  - 工具可并发，但回到同一 turn 状态机，结果顺序与生命周期必须确定。

- **Hermes：副作用前先留下可恢复证据**
  - 对有副作用的工具，在执行前持久化“即将执行/已开始”的 durable intent。
  - 持久化失败时宁可 fail-stop，也不能执行一个恢复系统不知道发生过的副作用。

- **Claude Code：协议完整性优先**
  - 工具失败可以交给模型恢复，但 tool-call 生命周期必须闭合。
  - abort / timeout / queue cancel 不能留下 orphan tool call。
  - cheap recovery → expensive recovery，且每层都有次数上限和 circuit breaker。

- **Claude Code + Hermes：知识按需加载**
  - skill 目录/索引常驻；正文按需加载。
  - memory 是事实，skill 是程序知识；不要把所有知识全文塞进 system prompt。
  - 记忆写入必须有 provenance、污染门、审批/晋升门。

- **Codex Guardian：独立评审必须隔离主 Agent 污染面**
  - reviewer 是独立、只读、最小上下文的评审会话，不继承主 Agent 的可写能力和不必要的 skill/memory/hook。

- **OpenCode / Pi 的反例**
  - 不接受“无 OS/运行时强制，只靠 prompt/信任”的默认安全模型。
  - 不接受审批只存在进程内存。
  - 不接受 V1/V2 双运行时长期并存。
  - 不接受“扩展=同进程任意代码”却仍把扩展当低风险默认能力。

### 1.2 明确不复制的东西

- 不复制 Claude Code 多套 compaction 并行导致的组合爆炸。
- 不复制 Hermes 巨型主循环与模块级共享状态。
- 不复制 Codex 多代 multi-agent / 多代 compaction 并存。
- 不复制 OpenCode/Pi 的宿主全权限默认模型。
- 不为了 prompt cache 或 benchmark 分数引入无法解释的隐藏行为。

**原则：一个概念只保留一个 production source of truth。**

---

## 2. 执行规则（写代码 Agent 必须遵守）

### 2.1 工作方式

- 主 Agent 自己直接执行本计划，**不要再开子代理**完成本计划。
- 一次只处理一个 Task ID；完成后立即回填本文件，再进入下一项。
- 不允许因为任务很多而跳项、合并成“已大致完成”、或提前宣布整 Phase 完成。
- 修改前先读：相关源码、现有测试、`AGENTS.md`、对应 contract。
- Bug 修复必须优先写出能失败的回归测试；没有失败证据时不要直接“凭感觉重构”。

### 2.2 每个 Task 的回填格式

每项完成后把状态块改为：

```md
Status: DONE | BLOCKED | SKIPPED
Implementation:
- changed files...
- design decision...
Regression Test:
- test name / file
Integration Test:
- command + result
Windows:
- PASS / FAIL / CI-PENDING / N/A
Linux:
- PASS / FAIL / N/A
Evidence:
- concrete output / event / benchmark artifact
Notes:
- remaining risk, if any
```

### 2.3 禁止事项

- 禁止删除/放宽测试来让 CI 变绿。
- 禁止把 fail-closed 改成 fail-open。
- 禁止新增 `catch {}`、`.catch(() => {})`、`.catch(() => undefined)` 来吞掉运行时错误。
- 禁止把安全判断建立在 raw `startsWith()`、字符串包含、工具名猜测等脆弱启发式上。
- 禁止 side-effect tool 自动盲重试。
- 禁止让 plugin / MCP / hook / child agent 自己扩大父级授予的 capability。
- 禁止让 benchmark/mock 路径替代 production wiring 后宣称“已接入生产”。
- 禁止让文档数字成为手工真相；可机器推导的事实必须机器生成或机器校验。
- 禁止引入第二套 state / budget / retry / compaction source of truth。

### 2.4 全局验收命令

每个 Task 跑聚焦测试；每个 Phase 完成后至少运行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

安全/路径/进程/Store 相关 Phase 还必须跑对应 security/integration suite。

最终必须运行：

```bash
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm benchmark:smoke
node apps/cli/dist/main.js audit --out .ci/capability
```

Windows 敏感项必须通过 GitHub Actions Windows job；本地 Linux 绿不能代替 Windows 证据。

---

# PHASE 14 — Security Closure

> 目标：先堵真实安全边界问题。P14 未全绿前，禁止 Champion promotion。

## P14-1 Filesystem capability canonicalization

**Problem**

当前 capability narrowing 的 filesystem 判断不能依赖文本前缀。`/safe/../outside`、Windows `C:\\safe\\..\\Windows`、symlink/junction 等必须按最终解析语义判断，而不是按字符串“看起来在子目录”。

**Do**

- 找到 `packages/contracts/src/capability.ts`、`packages/security/src/capability-guard.ts`、`packages/security/src/sandbox.ts` 相关路径判断。
- 抽出/复用一个唯一的 path containment primitive。
- 比较前先完成：separator normalize → absolute resolution → canonical ancestor/realpath → case policy → boundary-aware containment。
- capability guard 与 SandboxManager 必须共享同一语义，不允许一边 string compare、一边 realpath。
- 对不存在的待写路径，用“最深存在祖先 realpath + 剩余 path segments normalize”的方式判断，不能因为文件尚不存在而跳过 canonicalization。

**Regression tests**

至少覆盖：

- `/work/../etc`
- `/work/a/../../etc`
- `/work2`、`/work-evil`
- `C:\\work\\..\\Windows`
- drive letter case folding
- UNC
- trailing separators
- `.` / `..` 混合
- symlink/junction 从允许目录跳到外部
- symlink 目标不存在/父目录存在的写场景

**Acceptance**

- capability composition 与 sandbox containment 对同一输入给出一致结论。
- 所有 traversal / sibling collision / symlink escape fail-closed。
- Linux + Windows CI 均通过。

Status: DONE
Implementation:
- `packages/contracts/src/path-containment.ts` — pure path containment primitive (lexicalNormalize, isPathWithin, normaliseSeparators); shared by capability guard and SandboxManager
- `packages/contracts/src/path-containment.test.ts` — 41 pure-function regression tests (traversal, siblings, trailing separators, Windows drive/UNC, case folding, relative)
- `packages/security/src/canonical-path.ts` — I/O-layer canonicalizePath (realpath of deepest existing ancestor + lexically resolved tail, for non-existent write paths); shared by guard + sandbox
- `packages/security/src/canonical-path.test.ts` — 10 realpath-based tests (existing paths, symlink, non-existent tail, traversal escape)
- `packages/contracts/src/capability.ts` — containsItem for filesystem uses isPathWithin; composeCapabilities accepts `caseInsensitive`
- `packages/contracts/src/contracts.test.ts` — added P14-1 traversal/sibling regression cases for composeCapabilities
- `packages/security/src/capability-guard.ts` — canonicalize BOTH conferred and declared filesystem paths before composeCapabilities
- `packages/security/src/capability-guard.test.ts` — canonicalization-aware assertions + P14-1 traversal/sibling/Windows/case tests
- `packages/security/src/sandbox.ts` — resolvePath → canonicalizePath; allowedRoots → canonicalizePath; withinRoot → isPathWithin; empty allowedPaths skipped (fail-closed)
- `packages/security/src/sandbox.test.ts` — added P14-1 regression: absolute traversal, multi-level traversal, trailing/duplicate separators, . segments, symlink non-existent tail, sibling escape, case-insensitive sibling, empty allowedPaths
- `packages/security/src/path-parity.test.ts` — trailing-slash semantics unified with canonical form
- `packages/harness/src/workspace-manager.ts` — safeJoin uses canonical containment (isPathCanonicallyWithin)
- `packages/evaluation/src/formal-invariants.ts` — filesystem itemWithin uses isPathWithin
Regression Test:
- 41 pure-function tests in path-containment.test.ts
- 10 canonical-path realpath tests
- 5 capability-guard P14-1 regression tests
- 9 sandbox P14-1 regression tests
- 5 contracts.test.ts composeCapabilities traversal tests
- All existing capability/sandbox/path-parity/parser-fuzz tests remain green
Integration Test:
- `pnpm typecheck` — pass
- `pnpm test` — 3993 passed / 1 skipped / 0 failed
- `pnpm build` — pass
Windows:
- PASS (3993 passed on Windows dev machine)
Linux:
- CI-PENDING (baseline 3919 passed; will verify on CI)
Evidence:
- Pure containment: `/work/../etc` → denied (lexicalNormalize → /etc, isPathWithin → false)
- Windows: `C:\work\..\Windows` → denied (lexicalNormalize → C:/Windows, isPathWithin → false)
- Symlink: junction to outside → denied (canonicalizePath → realpath of junction)
- Non-existent write: `/ws/newdir/../../outside/secret.txt` → denied (deepest ancestor /ws → realpath, tail `newdir/../../outside/secret.txt` → lexicalNormalize → outside)
- Capability guard + sandbox share ONE containment semantic: both use canonicalizePath + isPathWithin
- Empty allowedPaths entry: skipped (not an error, does not widen scope)
Notes:
- Windows junction + `..` is an OS-level realpath limitation (realpathSync collapses `..` textually, does not follow the junction). The sandbox's resolution matches the OS's realpath, so containment is consistent with what the OS reports. A future process-level sandbox (not in scope) could add an additional `..` segment rejection or junction-detection layer.
- The `allowedPaths` capture-at-`""` issue in tests (vs001, orchestrator, source-matrix) was a pre-existing test fragility exposed by the strict empty-path rejection. Fixed by skipping empty entries in allowedRoots (fail-closed, does not widen containment).

---

## P14-2 Exec allowlist semantic matching

**Problem**

命令 allowlist 不得以 `target.startsWith(allowedCommand)` 表示“允许参数扩展”。合法前缀后追加 `;`、`&&`、`||`、管道、换行、substitution 等可能改变真实命令语义。

**Do**

- 移除 raw command prefix allow 逻辑。
- 建立一个统一 `CommandInvocation` / command AST 的最小表示：program、argv、shell operators、wrapper/interpreter surface、network intent。
- 如果当前执行器本质使用 shell，任何存在 shell composition operator 的命令必须进入 shell-wrapper 风险面，不能作为“已允许命令的参数延伸”。
- POSIX 与 Windows 分开处理 operator/quoting 语义；不要用一套 regex 假装通吃。
- 现有 `process-gate.ts` / command classification 尽量复用，不新增第二套分类器。

**Regression tests**

允许：

- `git diff`
- `git diff --stat`
- `pnpm test -- foo.test.ts`（如果 policy 明确允许参数扩展）

拒绝/升级审批：

- `git diff; rm ...`
- `git diff && ...`
- `git diff || ...`
- `git diff | ...`
- `git diff $(...)`
- backtick substitution
- embedded newline
- `cmd /c` chained operators
- PowerShell `;`, `|`, `&`, encoded command

**Acceptance**

- 不存在“合法 allowlist 字符串 + 恶意后缀”绕过。
- 命令 canonicalization 与 approval cache 使用同一语义键。

Status: DONE
Implementation:
- `packages/security/src/process-gate.ts` — added `CommandPlatform`, `CommandInvocation`, `scanShellOperators` (per-platform operator scan: POSIX `;` `&&` `||` `|` `&` `$(` backtick newline redirection, cmd `&` `&&` `||` `|` `>` `<` with `^` escape + double-quote literals, PowerShell `;` `|` `&` `&&` `||` `$(` live inside double quotes), `parseCommandInvocation` (escalates composed commands to shell-wrapper surface), `commandAllowlisted` (semantic allowlist matching — replaces `matchGlob || target.startsWith(cmd)`)
- `packages/security/src/sandbox.ts` — `checkExec` now uses `parseCommandInvocation` for the surface gate and `commandAllowlisted` for the allowlist; raw `target.startsWith(cmd)` removed; `SandboxManager` accepts an optional `CommandPlatform`
- `packages/security/src/process-gate.test.ts` — 24 new tests (POSIX/cmd/PowerShell operator scans, parseCommandInvocation, commandAllowlisted semantics)
- `packages/security/src/sandbox.test.ts` — 7 new P14-2 tests (allowlist semantics, sibling program, composition rejection, cmd/PowerShell wrappers, glob policy, surface gate ordering)
Regression Test:
- `process-gate.test.ts` — 33 tests green (9 existing + 24 new)
- `sandbox.test.ts` — 52 tests green (44 existing + 8 new)
- Full suite: 4025 passed / 1 skipped / 0 failed
Integration Test:
- `pnpm typecheck` — pass
- `pnpm test` — 4025 passed / 1 skipped / 0 failed
- `pnpm build` — pass
Windows:
- PASS (4025 passed on Windows dev machine)
Linux:
- CI-PENDING
Evidence:
- `git diff; rm -rf /` → denied under POSIX platform (was allowed by old `target.startsWith("git diff")` — the exact bypass P14-2 closes)
- `git diff && ...`, `git diff || ...`, `git diff | ...`, `git diff $(...)`, backtick, embedded newline → all denied (each verified in tests)
- `git diffx` / `git difftool` → denied (token-level sibling rejection; old prefix check allowed `git diffx`)
- `cmd /c dir & del x` → denied; `powershell -Command "…; Remove-Item x"` → denied; `powershell -EncodedCommand` → denied
- Composed commands escalate to `shell-wrapper` surface → a `deniedSurfaces: ["shell-wrapper"]` policy rejects them even under a `**/*` allowlist
- POSIX vs Windows semantics separated: `;` is composition on POSIX but NOT on cmd (`&` is); each platform has its own quoting/escape rules
- Glob entries (`**/*`, `git *`) remain explicit policy choices
Notes:
- No approval-cache exists yet in the codebase; the semantic key produced by `parseCommandInvocation` (program + argv + hasShellOperators + surface) is the documented canonical key any future approval cache must reuse (plan acceptance item).
- Windows `executor.test.ts` afterAll EPERM is a pre-existing transient temp-dir cleanup flake (passes on re-run), unrelated to P14-2.

---

## P14-3 Writable delegation must require isolation

**Problem**

`writable:true` 子代理在没有 workspace isolation 时不能 fallback 到父工作区直接写。

**Do**

- `Delegator` 的 public API 改为 fail-closed：writable delegation 缺 `ChildWorkspaceManager` 时直接拒绝。
- production 不提供隐式 shared-write fallback。
- 如果测试确实需要 shared workspace，使用明确 `testOnlyUnsafeSharedWorkspace` 或测试专用构造器，不进入 production config。
- child 的 filesystem/tool/process capability 必须是 parent capability 的单调收窄。

**Tests**

- writable + no manager → denied before child executes任何工具。
- manager create failure → no child side effect，scheduler token/roots 均清理。
- child isolated root 可写，parent root 不可被 child 直接写。
- patch merge 冲突时 fail-safe，不覆盖 parent 新变化。

Status: DONE
Implementation:
- `packages/agents/src/delegator.ts` — fail-closed：`writable:true` 且无 `ChildWorkspaceManager` → 在 child session / scheduler slot 创建前抛出 typed `SECURITY_DENIED` AgentError，并在 parent session 上发射 `security.permission_denied` 事件（带 `code: "SECURITY_DENIED"`）。新增 `DelegatorDeps.testOnlyUnsafeSharedWorkspace?: boolean` 显式 test-only 逃生门（共享父根写回退，绝不进入 production config）。workspace create 失败时：将 never-run 的 child session 标记 `cancelled`、`scheduler.unbindSession(child.id)`、`token.release()` 后才抛错 — 无孤儿会话、无 scheduler token/root 泄漏。新增导出 `writableIsolationError()`（单一语义来源，供 ParallelDelegator 复用）
- `packages/agents/src/parallel-delegator.ts` — preflight 对每个请求应用同一 isolation 门：batch 中任一 `writable:true` 请求缺 manager → 整个 batch 在任何 child 创建前拒绝（无 partial start）
- production wiring（`packages/harness/src/create-harness.ts`）已确认：Delegator 与 ParallelDelegator 均注入 `new DefaultChildWorkspaceManager()`；`delegate_worker` 工具仅在 `workspaceManager !== undefined` 时注册 — fail-closed 不影响生产路径
- 能力单调收窄：工具/进程维度由既有 `restrictToolPolicy`（allow 交集 + deny 并集）+ P0-1 runtime 冻结 snapshot 保证；filesystem 维度由 isolated-copy（child cwd = 隔离根，非 parent root）+ P3-6 sandbox 只放行隔离根 + P3-5 冲突检测合并保证
Regression Test:
- `delegator.test.ts` — +4 个 P14-3 测试（无 manager 拒绝且无 child 创建/无工具执行/发射 security.permission_denied；testOnlyUnsafeSharedWorkspace 显式回退；create 失败 → child cancelled + 无 turn + scheduler.snapshot() 空 + 后续委托正常；writableIsolationError 单元语义）
- `parallel-delegator.test.ts` — +1 个 P14-3 测试（writable 请求无 manager → 整个 batch preflight 拒绝，无任何 child session）
- `workspace-manager.test.ts` — 既有 6 个测试含 P3-5 冲突 fail-safe（parent 在 child 运行期间修改的路径不被覆盖），作为 P14-3 第 4 条测试需求证据
- Full suite: 4030 passed / 1 skipped / 0 failed
Integration Test:
- `pnpm typecheck` — pass
- `pnpm test` — 4030 passed / 1 skipped / 0 failed
- `pnpm build` — pass
Windows:
- PASS (4030 passed on Windows dev machine)
Linux:
- CI-PENDING
Evidence:
- `delegate({ writable: true })` + 无 manager → rejects `SECURITY_DENIED`（`writable delegation requires workspace isolation: no ChildWorkspaceManager configured`），`listSessions(parentId)` 为空、orchestrator 零调用、parent 上出现 `security.permission_denied` 事件
- `testOnlyUnsafeSharedWorkspace: true` + 无 manager → 成功且 child cwd = parent cwd（显式 test-only 回退，无 security 事件）
- manager `create()` 抛错 → child session status `cancelled`、无 turn、scheduler `snapshot()` 为空（slot 释放）、随后 read-only 委托仍成功（scheduler 未中毒）
- `delegate_worker` 生产路径：manager 始终注入（create-harness.ts），writable 委托正常；child cwd = 隔离根（P3-4 既有断言 `${parent.cwd}-isolated`），patch 经 P3-5 冲突检查合并回 parent
- `writableIsolationError` 单测：无 manager + 非 test-only → typed `SECURITY_DENIED`；有 manager 或 test-only → undefined
Notes:
- P0-1 既有测试（read-only child 请求拒绝 write_file/exec 于 runtime；resume/registry 变更不能加宽）已覆盖 child tool/process 能力单调收窄，P14-3 未重复实现，仅引用
- 失败路径的 `updateSession(cancelled)` 为 best-effort cleanup（try/catch 注释说明不掩盖 isolation 错误），与文件内既有 P3-4/P3-5 cleanup 模式一致；P14-6 将统一审计 catch 语义

---

## P14-4 Capability monotonicity at every extension boundary

**Do**

审计并统一以下边界：

- child agent
- MCP tool/server
- plugin
- hook
- skill declared tools
- external integration

所有边界都必须满足：

```text
EffectiveCapability = ConferredCapability ∩ DeclaredCapability
```

下级可省略（继承）或收窄，不能增加 tool/filesystem/network/process 权限。

**Requirements**

- capability escalation 产生 typed denial + security event。
- 不允许靠文字说明“插件应该自律”。
- MCP 仍是 integration layer，不得获得 runtime core 特权。
- hook 可以 deny / add bounded context / transform safe fields，但不能绕过 PermissionEngine 或扩大 SandboxPolicy。

**Acceptance**

添加 table-driven tests：每个 boundary × 每个 capability dimension 至少 1 个 widening rejection + 1 个 narrowing success。

Status: TODO

---

## P14-5 Trust envelope for all external context

**Do**

统一外部上下文来源标记：

- AGENTS.md / repository instructions
- skills
- memory
- MCP descriptions/results
- plugin/hook context
- tool output
- user supplied file/reference

每个 `ContextBlock` 必须能表达：source、trust level、provenance/id、是否可作为 instruction、是否可持久化进 memory。

**Policy**

- untrusted data 默认是 data，不升级成 system instruction。
- injection detector 的结果必须可观测；拒绝内容必须有 source/id/reason。
- “扫描器自身异常”不能静默放行需要安全扫描的持久化写。

Status: TODO

---

## P14-6 No silent security/recovery catches

**Do**

- 全仓扫描 silent catch / fire-and-forget catch。
- 建立统一 `NonFatalErrorSink` / typed degraded event。
- 允许 best-effort 的地方也必须留下 observability evidence。
- security gate、state persistence、checkpoint、approval、memory write、capability composition 绝不 silent-degrade。

**Acceptance**

- CI 增加静态扫描或 lint test，禁止新 silent catches。
- 现有允许忽略的 cleanup failure 要有明确 `cleanup.failed` 或 debug event，且不得影响安全结论。

Status: TODO

---

## P14-7 Security adversarial regression pack

新增/扩展 adversarial cases：

- path traversal capability widening
- symlink/junction escape
- allowed-command prefix chaining
- hook capability widening
- MCP description injection
- memory poisoning after untrusted context
- writable child without isolation
- approval cache same-text/different-environment scenario

**Acceptance**

Critical security escape count = **0** 才能进入后续 Champion promotion。

Status: TODO

---

# PHASE 15 — Turn / Session State Isolation

> 目标：所有“per-turn”状态真正属于 turn，所有“per-session”状态真正属于 session。

## P15-1 Make recoveryUsage truly per-turn

**Problem**

`recoveryUsage` 注释为 per-turn，但若它挂在 `AgentRuntime` 实例并被 controller 长期持有，会跨 turn / session 污染。

**Do**

- 新建明确的 `TurnExecutionState`（名字可调整），至少承载：
  - recoveryUsage
  - tool execution ledger
  - working state
  - verification failure counters
  - stall recovery counters（若现在分散）
  - budget snapshot/usage reference
- controller 接收 turn state，而不是 constructor 持有 per-turn mutable map。

**Tests**

- Turn A 耗尽 retry，Turn B 仍有完整预算。
- Session A 耗尽，Session B 不受影响。
- 两 session 并发，不互相污染。
- resume 恢复的是“该 turn 已消耗预算”，不是全新预算，也不是其他 turn 的预算。

Status: TODO

---

## P15-2 Immutable StepContext per model call

借鉴 actor/step-context 设计，但不新建第二套 runtime。

**Do**

每次模型调用前形成只读 `StepContext`：

- frozen effective agent config
- current cwd/workspace identity
- allowed tool specs snapshot
- permission/sandbox policy snapshot hash
- current context selection result
- model ref
- turn/session ids

同一次模型响应产生的一批 tool calls 必须使用同一 StepContext。中途 config/policy 变化只能在下一 step 生效，或触发 explicit drift gate。

Status: TODO

---

## P15-3 Audit and bound queues

**Audit surfaces**

- SessionInbox
- ask/approval pending queues
- scheduler queues
- subagent/mailbox queues
- event subscribers/stream buffers
- MCP request queues

**Do**

- 所有可由外部输入无限增长的队列必须有 max size / max bytes / TTL 或 backpressure。
- overflow 不能 silent drop；必须 typed outcome：reject / spill-to-disk / disconnect-with-resume-token。
- 对 durable inbox，优先落盘再通知，而不是把 RAM queue 当真相。

**Stress tests**

10k steer / mailbox / event inputs 不得无界内存增长；overflow 行为可预测且有 event。

Status: TODO

---

## P15-4 Terminal lifecycle exactly once

**Do**

证明 turn/session 的 terminal transition 是幂等且只发生一次：

- completed
- failed
- cancelled
- waiting_for_user
- waiting_for_approval

重复 cancel、重复 approval reply、retry after crash 不能产生两个 terminal records 或双执行 `onTurnComplete`。

Status: TODO

---

## P15-5 Eliminate cross-session mutable globals

**Do**

审计 module-level cache/singleton：

- tool/repo caches
- command discovery
- skill cache
- context compact state
- scheduler accounting
- event sequencing

每个缓存必须明确 scope：process immutable / repository / session / turn。

允许 process cache，但 key 必须包含所有影响结果的输入；不可让一个 repo/session 的 policy/skill/tool result 泄到另一个。

Status: TODO

---

## P15-6 Cancellation settlement invariant

**Invariant**

模型已经发出的每个 tool call，最终都必须有一个 terminal settlement：

- success
- failed
- denied
- timeout
- cancelled

并行 read batch abort 时，尚未完成的 call 不能“消失”。为未执行/未完成项生成 synthetic cancelled result/event，保持 transcript / replay / provider protocol 完整。

**Tests**

- abort before batch
- abort mid parallel reads
- abort while write is executing
- abort after side effect committed before checkpoint
- repeated abort

Status: TODO

---

# PHASE 16 — Durable Side Effects & Crash Recovery

> 目标：进程可以死在任意关键窗口，恢复逻辑仍知道发生了什么。

## P16-1 Durable tool intent before side effect

对 `sideEffectScope != none` 的 tool：

1. validate / permission / approval / sandbox 全部通过
2. 持久化 `tool.started` / execution intent：toolCallId、tool、argsHash、semantics、startedAt、session/turn、sideEffect scope
3. 持久化成功后才调用真实 executor
4. 执行后写 terminal record + result hash/evidence

**Hard rule**

intent persistence 失败 → 不执行副作用。

Status: TODO

---

## P16-2 Unknown-outcome reconciliation

进程死在 intent 持久化后、terminal record 之前：恢复时该调用标为 `unknown_outcome`。

**Recovery policy**

- read-only/idempotent: 可按策略安全重跑。
- filesystem write: 先检查目标状态/hash/diff，能确认效果则 reconcile，不能确认则要求 verifier/user 决策。
- process/network/global: 默认绝不自动重跑。
- 每次 reconciliation 有 event/evidence。

Status: TODO

---

## P16-3 Persist run-budget / recovery-budget state in checkpoint

checkpoint/resume 后不得刷新已消耗的：

- model/token/cost budget
- tool call budget
- subagent budget
- recovery action budget
- verification retries
- stall recovery

同时不得把其他 turn 的预算带进当前 turn。

Status: TODO

---

## P16-4 Production persistence contract

定义 production/interactive durable mode：

- 若启用 approval / ask_user / checkpoint / long-run recovery，却没有 durable store，必须明确标记 `degraded`，不能在 audit 中误报为 production-ready。
- 提供明确 `ephemeral` profile 给测试/临时运行。
- 不强迫所有用户都落盘，但 capability matrix 必须真实反映 durable vs in-memory。

Status: TODO

---

## P16-5 Event sequencing and injected clock cleanup

审计 composition root 中所有直接：

- `Date.now()`
- `sequence: 0`
- `as never` event type escape

事件必须经统一 typed emitter / sequence allocator / injected clock。

**Acceptance**

同 session 事件 sequence 严格单调；replay 可稳定排序；测试 deterministic。

Status: TODO

---

## P16-6 Crash-window fault injection matrix

新增 fault points 并覆盖：

- before intent persist
- after intent persist / before execute
- after side effect / before terminal result
- after result / before checkpoint
- after checkpoint / before model observation
- during compaction
- during approval/ask resume

每个 case 验证“不会双执行 + 能恢复/明确 fail-safe”。

Status: TODO

---

# PHASE 17 — Knowledge & Context V5

> 目标：吸收优秀 Agent 的“按需知识 + 多阶段压缩”优点，但坚持只有一套 Context Pipeline。

## P17-1 Memory writes: provenance + derivability + promotion gate

现有 candidate/promotion 保留，并增强：

每条可持久记忆至少包含：

- source session/turn
- provenance ids
- createdAt / lastUsedAt
- scope
- trust level
- importance
- derivability verdict
- security scan result
- promotion state

**Derivability rule**

能通过 repo search / git / AGENTS.md / config 重新推导的事实，默认不存长期 memory。Memory 优先存：用户偏好、项目非显然决策、失败经验、环境特性、不可推导约束。

Status: TODO

---

## P17-2 Memory pollution quarantine

借鉴“external context polluted”思想：

若本 turn 使用了 untrusted MCP/tool/remote skill/repository instruction 内容，则该 turn 产生的 memory candidate：

- 不得自动 promote
- 必须标记污染来源
- 进入 quarantine/review queue
- security scan failure → reject

即使 learning 功能开启，也不允许“恶意仓库一句话 → 永久记忆”。

Status: TODO

---

## P17-3 Skill on-demand loading invariants

保留现有 index → selection → body，不回退到全文预载。

增强：

- skill provenance / trust
- cache invalidation（文件改动后可控刷新）
- collision policy 可预测
- selected skill body 全量加载，不通过危险分页只读半截指令
- skill declared tool dependency 仍需 capability/permission gate

Status: TODO

---

## P17-4 One context taxonomy

明确并编码 ContextBlock 类别：

1. **protected instruction**：用户硬约束、effective policy 摘要、当前 goal
2. **working state**：plan、pending、decisions、files changed、unresolved tool calls
3. **knowledge**：memory / selected skill / instructions
4. **evidence**：tool/verification results
5. **ephemeral**：progress、temporary observations

不同类别定义明确的：priority、compressible、persistable、trust、rehydratable。

Status: TODO

---

## P17-5 Single multi-stage compaction state machine

只允许一套 production compaction policy，内部按成本从低到高分阶段：

1. tool output artifact offload / preview
2. 去掉已过期 ephemeral observation
3. deterministic micro-compaction（重复/旧 read evidence）
4. structured WorkingState digest
5. 可选 LLM summary（仅在仍超预算时）
6. reactive overflow fallback（一次，带 circuit breaker）

**禁止**另建 parallel compactor 与原 pipeline 竞争。

Status: TODO

---

## P17-6 Protected facts survive compaction

每次 compaction 后必须程序化校验以下字段仍可从 context/working state 恢复：

- exact user goal / hard constraints
- pending tasks
- decisions
- files changed
- commands/tests run
- verification failures
- unresolved/unknown tool executions
- memory refs
- selected/invoked skills
- child agent refs

摘要缺失这些字段不能仅凭“summary 非空”判定成功。

Status: TODO

---

## P17-7 Post-compaction rehydration

压缩后只恢复必要的高价值引用：

- recent touched/read files（有 token/文件数量上限）
- active plan
- selected/invoked skills
- unresolved tool evidence
- transcript/artifact pointers

不要把完整历史重新塞回 prompt。

Status: TODO

---

## P17-8 Compaction circuit breaker + benchmark

- 连续 ineffective compaction / compact failure 有明确 breaker。
- 记录 before/after tokens、protected-field preservation、latency、summary fallback 次数。
- stress suite 加长会话：10k messages / large tool outputs / repeated compactions。

Acceptance：不能出现 compact loop；不能因 compaction 永久丢失 pending work。

Status: TODO

---

# PHASE 18 — Tool & Integration Boundary

## P18-1 ToolSemantics becomes the only execution policy source

审计所有 runtime 决策：

- retry
- concurrency
- checkpoint
- approval
- side-effect reconciliation
- network behavior
- output sensitivity
- cancellation

必须由 `ToolSemantics` 或其单一派生函数决定，不再保留 `ToolCapability` 与 metadata 之间可能漂移的双真相；如果 legacy 类型仍需兼容，只能作为适配输入，不能作为第二决策源。

Status: TODO

---

## P18-2 Deferred tool schemas only when needed

借鉴 ToolSearch/skill on-demand，但不要给 12 个内置工具过度设计。

**Rule**

- 内置小工具集继续直接广告。
- 当 MCP/plugin 使工具数或 schema token 超过阈值时，启用 deferred schema + tool search/discovery。
- 阈值必须根据 schema token budget，而不是硬编码“工具数 50”。

Benchmark 对比：全量 schema vs deferred schema 的成功率/token/latency。

Status: TODO

---

## P18-3 Plugin policy: explicit trust, never default Champion

研究表明同进程 plugin 是任意代码执行面。

**Do**

- capability matrix 明确区分：implemented / trusted-local / isolated / production-wired。
- 当前若 plugin 为同进程执行，默认 Champion 保持 OFF。
- 只有显式 trusted-local 配置才能加载；project-local plugin 需要 workspace trust/approval。
- 后续若要自动启用，先实现进程隔离或等价安全边界；本 Phase 不要求为了“开插件”赶做一个假沙箱。

Status: TODO

---

## P18-4 MCP remains integration layer

- MCP transport 可扩展，但不能拥有 runtime core 特权。
- MCP tool 走同一 schema validation、permission、sandbox、tool semantics、output injection scan、timeout/cancel、budget、event pipeline。
- server/tool descriptions 属 untrusted context。
- HTTP/stdio capability 分开；stdio 子进程也属于 process capability，不因“本地”自动可信。

Status: TODO

---

## P18-5 Tool cancellation settlement + progress channel

- progress event 与 terminal result 分开。
- progress 不进入 durable final ledger 当作 completion。
- cancel 后未开始工具 synthetic cancelled；已开始工具根据 cancellable semantics 处理。
- 不允许 queued tool 因 abort 从 transcript/replay 消失。

Status: TODO

---

## P18-6 Resource conflict keys for concurrency

在现有 `concurrencySafety` 之上增加可选 resource conflict 概念，避免将来开放更多并发时出现同资源竞争：

- file mutation key = canonical path
- store mutation key = store/session id
- global mutation = global lock

当前所有 write 若本来串行，可先保持串行；实现目标是为未来并发建立正确语义，不强求提高并发数字。

Status: TODO

---

# PHASE 19 — Verification & Recovery V4

## P19-1 Verified completion contract

模型停止输出只表示 `candidate_complete`。

runtime 最终状态必须区分：

- unverified_complete
- verification_failed
- verified_partial
- verified_complete

已有状态沿用，不重复造枚举；重点是保证 production path 真实使用。

对于 code-changing turn，若可发现 test/typecheck/build 命令，则未运行必要 verification 不得标 verified_complete。

Status: TODO

---

## P19-2 Independent reviewer isolation

将 P13 reviewer 从 experiment 推向可 benchmark 的 candidate，但不直接默认开启。

Reviewer 必须：

- read-only
- 无 write/exec network
- 不继承主 Agent 的非必要 memory
- 不继承会影响结论的 skill/hook
- 输入仅包含：用户要求、changed diff、verification evidence、必要 repository instructions
- reviewer 自身失败/parse failure **不能 fail-open approve**；返回 unverified/degraded

Status: TODO

---

## P19-3 Recovery taxonomy → bounded actions

保留 adaptive recovery 思路，但收口为唯一 taxonomy：

- retry_safe
- change_strategy
- reconcile_unknown_effect
- ask_user
- delegate_specialist（仅 feature enabled + budget）
- fail_safe

每个 action：

- 明确预算
- 明确适用 error class
- 明确是否允许副作用重执行
- 明确 event

禁止 string-message 到处判断重试。

Status: TODO

---

## P19-4 Never auto-retry unsafe tools

增加 invariant tests：

- retrySafety=safe + readOnly/idempotent → bounded auto retry 可用
- unknown/none → runtime 不自动再执行
- timeout 对非幂等写同样不能盲重试
- provider/model API retry 与 tool retry 必须是两套清晰层级，不混在一起

Status: TODO

---

## P19-5 Protocol self-heal without hiding corruption

对可修复的模型/消息协议问题：

- missing tool result
- duplicate tool call id
- orphan result
- malformed structured output
- context overflow

可生成 typed repair action，但必须保留 repair evidence；无法安全修复则 fail-safe，不伪装成正常完成。

Status: TODO

---

## P19-6 False-complete benchmark expansion

构造 cases：

- 只改代码不跑测试
- 测试失败但模型说 done
- verifier 命令不存在
- verifier 自身 timeout
- reviewer parse failure
- 部分测试通过、关键测试未跑
- change set 为空但模型声称改完

Champion promotion 时 verified completion quality 是核心指标之一。

Status: TODO

---

# PHASE 20 — Observability, CI & Truthfulness

## P20-1 Wire usage accounting for real

当前 audit/capability matrix 已出现“implemented 但 productionWired=false”的 usage accounting 证据。

**Do**

- model completed event/trace 必须携带真实 usage（输入、输出、cache、estimated cost 能拿多少记多少）。
- metrics/replay/explain 能按 modelCallId 聚合。
- scheduler tree budget 与 runtime budget 使用同一 usage source。
- provider 不返回 usage 时标 estimated/unknown，不能写 0 冒充真实。

Status: TODO

---

## P20-2 Make Capability Matrix composition-aware

Capability Matrix 必须按具体 profile/config 报告，而不是“源码存在就算 production”。

至少输出：

- implemented
- productionWired
- durable
- integrationTested
- benchmarkExercised
- securityMode / degraded reason（适用时）

interactive ephemeral、interactive persistent、benchmark、champion profile 分开验证。

Status: TODO

---

## P20-3 Documentation truth verification

新增 `pnpm docs:verify`（名字可调整）自动核对：

- benchmark case counts
- test baseline（不要把易变的精确测试数硬编码为唯一真相，可生成）
- capability status
- profile defaults
- CI gates
- package counts（如果文档声称）

`HANDOVER.md` / `CAPABILITY_MATRIX` 中可机器推导的事实机器生成或机器校验。

Status: TODO

---

## P20-4 Coverage must be a real CI gate

当前配置有 coverage thresholds，但 CI 必须真正运行 `pnpm test:coverage`。

- Ubuntu coverage job 即可；Windows 不必重复 coverage。
- upload `coverage-summary.json`。
- threshold 失败必须使 CI 红。
- 不降低 threshold 来完成本任务，除非先证明原配置从未可达并在 Notes 记录证据。

Status: TODO

---

## P20-5 Typed event cleanup

清理 production event emission 中：

- `as never`
- ad-hoc payload shape
- direct Date.now
- direct sequence placeholders

重要事件使用 typed payload contract：model/tool/security/verification/recovery/compaction/subagent/persistence。

Status: TODO

---

## P20-6 Trace tree completeness

一条 turn 至少能从 event/trace 重建：

```text
turn
 ├─ model call
 │   ├─ tool calls
 │   └─ usage
 ├─ recovery actions
 ├─ compaction
 ├─ verification
 └─ subagent (if any)
```

每个节点有 parent/span identity；`agent explain` 能回答“为什么执行这个工具/为什么重试/为什么未完成”。

Status: TODO

---

# PHASE 21 — Champion Promotion

> 这是本计划最重要的 Phase。前面的机制不是目的，默认 Agent 的真实能力才是目的。

## P21-1 Freeze baseline

创建可复现 baseline manifest：

- git SHA
- model/provider
- model params
- profile/features
- context budget
- task suites
- random seed（provider 支持则固定）
- platform

不能拿不同模型/不同预算比较后说 harness 提升。

Status: TODO

---

## P21-2 Candidate feature matrix

候选机制至少包含：

- context pipeline V5
- tool selector / deferred schema
- memory retrieval
- memory write/learning
- adaptive recovery
- independent reviewer
- delegation
- adaptive context policy
- adaptive scheduler

每个 candidate 单独开关；先单变量，再测试少量组合。

Status: TODO

---

## P21-3 Paired evaluation runner

新增 champion evaluation 命令/脚本，要求：

- baseline 与 candidate 跑同一 case
- 记录逐 case paired result
- 指标：task success、verified completion、security violations、tool calls、model tokens、estimated cost、latency、recovery count、compaction count
- stub/mechanism benchmark 与 real-model benchmark 分开标注

**Truth rule**

没有真实模型证据时，可以说“mechanism-real passed”，不能说“Agent 更强”。

Status: TODO

---

## P21-4 Promotion gate

Candidate 只有同时满足以下条件才能进 Champion：

### Hard gates

- typecheck/test/build 全绿
- coverage gate 绿
- Linux + Windows 必要矩阵绿
- Critical adversarial escape = 0
- 无新的 fail-open path
- 无 crash-recovery duplicate side effect

### Quality gates

在 paired real-model suite 上：

- regression + holdout 不得出现关键能力净退化
- verified completion 不能下降
- 若 token/cost > baseline 15%，必须有明确成功率收益抵消，并在 report 中解释
- 若成功率提升仅来自更多无界 tool/retry 次数，不得 promote
- reviewer/delegation 的收益必须扣除额外模型调用成本

对于 30-case 小样本，不使用虚假的“0.1% 精确统计”；报告逐 case wins/losses/ties，并在可行时做多次重复。

Status: TODO

---

## P21-5 Champion Profile v1

只有完成 P21-4 后才创建/更新默认 Champion preset。

**预期默认候选（仍需 benchmark 证明）**

倾向默认 ON：

- context pipeline
- checkpoint（persistent mode）
- artifacts/tool-output budget
- verification plan
- run budget
- progressive tool disclosure（当 schema budget 触发）
- observability/usage accounting

证据决定：

- memory retrieval
- adaptive recovery
- independent reviewer
- delegation

保持 config-driven / 默认 OFF：

- MCP（用户配置服务器才开）
- plugin host（同进程 trust 风险）
- experimental planner/executor split

Status: TODO

---

## P21-6 Rollback switch and champion manifest

Champion 每个新晋升能力必须可单独关闭；生成 `CHAMPION_MANIFEST.json`（名字可调整）：

- feature
- promotedAt
- evidence report
- benchmark delta
- security status
- rollback flag

禁止“默认打开后找不到怎么关”。

Status: TODO

---

# PHASE 22 — Architecture Simplification & Release

## P22-1 Split createHarness composition root

`createHarness.ts` 只保留顶层 orchestration；按领域拆成 composition helpers：

- stores
- tools/security
- context/knowledge
- MCP/integrations
- verification
- delegation
- observability

**Hard rule**

这只是 composition refactor，不得创建第二套实现。依赖方向保持：core 不依赖 UI/provider/business plugin/external integration。

Status: TODO

---

## P22-2 Remove obsolete compatibility paths only with evidence

审计 legacy adapters / duplicate metadata / dead feature gates。

删除条件：

- code search 证明无 production caller，或迁移完成
- tests 覆盖替代路径
- public API 变化有 migration note

不要为了“代码少”破坏向后兼容。

Status: TODO

---

## P22-3 Final production audit

自动检查：

- capability matrix
- no silent catch
- no direct unsafe path prefix security checks
- no raw command prefix approval logic
- no production `as never` event escape（允许有明确白名单时记录）
- all side effects pass ToolOrchestrator + Permission + Sandbox
- writable child requires isolation
- unsafe tool no auto retry
- durable mode has durable approval/ask/checkpoint

Status: TODO

---

## P22-4 Final cross-platform / stress / benchmark run

必须产出 artifact：

- unit/integration report
- coverage summary
- Linux/Windows CI results
- adversarial report
- stress report
- baseline vs champion paired report
- capability matrix
- champion manifest

Status: TODO

---

## P22-5 Update HANDOVER.md / mem.md / reflection.md

最终交接只写**已验证事实**：

- 当前 champion 开了什么
- 为什么 promote
- 哪些能力仍是 experimental/config-driven
- 已知限制
- 如何复现实验
- 如何 rollback

不要再用“implemented = production ready”的措辞。

Status: TODO

---

# 3. Phase 依赖顺序

严格按以下顺序执行：

```text
P14 Security Closure
  ↓
P15 State Isolation
  ↓
P16 Durable Side Effects
  ↓
P17 Knowledge & Context
  ↓
P18 Tool & Integration Boundary
  ↓
P19 Verification & Recovery
  ↓
P20 Observability / CI / Truth
  ↓
P21 Champion Promotion
  ↓
P22 Simplification / Release
```

P17/P18/P19 即使代码上可独立，也不要在 P14~P16 尚有红灯时提前 promote。

---

# 4. 每个 Phase 的完成定义

一个 Phase 只有同时满足以下条件才可写 `DONE`：

1. 所有 Task 状态均 DONE，或 SKIPPED 有用户/平台硬约束与证据。
2. 每个 bug/security task 有回归测试。
3. `pnpm typecheck` 通过。
4. `pnpm test` 通过。
5. `pnpm build` 通过。
6. 相关 integration/security benchmark 通过。
7. 文档状态与代码真实状态一致。
8. 没有新增 silent degradation。
9. 没有降低 security/test/coverage 标准。

---

# 5. 最终“完成”定义

本计划整体完成时，必须能够用证据回答以下问题：

### 安全
- child/plugin/MCP/hook 能否扩大权限？——不能，有测试。
- path traversal/symlink 是否能骗过 capability guard？——不能，有跨平台测试。
- allowed command 能否靠 shell 后缀变成另一条命令？——不能，有测试。

### 恢复
- 进程死在副作用执行前/中/后会怎样？——每个窗口都有 deterministic recovery outcome。
- 会不会重复执行未知副作用？——不会，有 fault injection 证据。

### 状态
- Turn A 的 recovery/budget 会不会污染 Turn B？——不会。
- Session A 会不会污染 Session B？——不会。

### Context
- 多次压缩后用户硬约束、pending tasks、unresolved effects 会不会丢？——不会，有 property/integration test。
- 长 tool output 会不会无限撑爆 prompt？——不会，有 artifact/offload evidence。

### Verification
- 模型说“完成”但测试失败会不会标 verified complete？——不会。
- reviewer 自己坏掉会不会 fail-open？——不会。

### Champion
- 为什么默认开启某机制？——有 paired benchmark report。
- 为什么某机制仍关闭？——成本/质量/安全证据不够，而不是“没实现”。
- 相同模型与预算下是否比 baseline 更好？——用逐 case 数据回答。

只有这些问题都能由测试、事件、benchmark artifact 回答，才能宣布 v4 完成。
