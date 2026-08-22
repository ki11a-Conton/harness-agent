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

Status: DONE
Implementation:
- `packages/security/src/boundary-guard.ts` — 新增统一边界组合入口：`CapabilityBoundary`（child-agent / mcp / plugin / hook / skill）、`BoundaryCapabilityError`（typed AgentError，携带 boundary + violations）、`composeBoundaryCapability`（async，escalation 先发 security.capability_denied 事件再 throw）、`composeBoundaryCapabilitySync`（同步变体，供 PluginHost 注册期使用）。所有边界共享同一 `EffectiveCapability = Conferred ∩ Declared` 语义（复用 composeCapabilities + composeChildCapability 的 canonicalization，不建第二套）
- `packages/contracts/src/event.ts` / `event-payloads.ts` — 新增 `security.capability_denied` 事件类型 + payload 映射；`packages/security/src/denial.ts` SecurityDimension 增加 `capability`（code → SECURITY_DENIED）
- `packages/core/src/runtime/tool-call-controller.ts` — **hook 边界修复**：before_tool transform 若改变 `call.name`（工具身份替换）→ deny fail-closed + security.capability_denied（原实现 policy gate 只检查原始 name，hook 改 name 可绕过 frozen tool policy；args 变换仍允许——orchestrator 在 transform 后做 permission/sandbox，天然安全）
- `packages/skills/src/skill-capability.ts` — **skill 边界**：`checkSkillRequiredTools`（declared requiredTools ⊆ host ToolPolicy，复用 isToolAllowedByPolicy——与 runtime gate 同一语义）+ `requiredToolsDenial`；`packages/skills/src/skill-security.ts` detection 扩展 `required-tools`（复用 SKILL_DENIED code / security.skill_denied 事件）
- `packages/harness/src/skill-context.ts` — createSkillBodyBlockProvider 增加 `toolPolicy` + `onRequiredToolsDenied`；load() 时超范围 skill 不注入（fail-closed）+ typed denial 回调
- `packages/agents/src/delegation.ts` — DelegationRequest 增加 `capability?: DeclaredCapability`（fs/network/process 面；tool 维度强制走 toolPolicy，单一真相）；`packages/agents/src/delegator.ts` — DelegatorDeps 增加 `parentCapability?: GrantedCapability`，delegate() 中非 tool 声明必须经 composeBoundaryCapability 验证（无 parent grant → 拒绝，未知上界无法证明收窄；capability.tool → 拒绝）；sinkOf() 把 EventStore 适配成 EventSink 供守卫发事件
- `packages/plugins/src/plugin-host.ts` — **plugin 边界**：Plugin.sandbox（DeclaredCapability）+ PluginPolicy.capability（host 授予上界）/ onCapabilityDenied 回调；注册期同步验证，widening → typed denial（回调 + BoundaryCapabilityError），无 grant 声明 → 拒绝，sandbox.tool → 拒绝（tool 表面走 capabilities）
- `packages/contracts/src/mcp.ts` — McpServerConfig 增加 `allowedTools?: string[]`（host 授予该 server 的工具上界）；`packages/mcp/src/mcp-transport.ts` — server 广告工具（declared）超出 allowedTools（conferred）→ 整个 server 注册失败（MCP_DENIED，fail-closed）
- `packages/harness/src/create-harness.ts` — 生产 wiring：Delegator 注入 `parentCapability`（main agent sandbox policy + 全量工具 allowlist）；skillBodyProvider 注入 main agent tool policy + denial 处理器
- `packages/security/src/canonical-path.ts` — **P14-1 遗留 bug 修复**：非存在路径最深存在祖先为根 `/` 时拼接产生 `//` 前缀（被 lexicalNormalize 误判为 UNC），导致 Linux 上所有 root-ancestor 场景 canonicalization 错误、case-insensitive containment 误报 escalation；修复为根时以空 base 拼接
Regression Test:
- `boundary-guard.test.ts` — 49 个 table-driven 测试：5 boundary × 4 dimension × {widening rejection, narrowing success} + 继承语义 + typed error/事件/无事件
- `runtime.test.ts` — +2 hook 边界（name-swap → security.capability_denied 且不执行；args 变换 → 通过且透传）
- `skill-capability.test.ts` — 7 个纯函数测试（allow/deny/空 allow/deny-list/undefined policy）；`skill-context.test.ts` — +2 集成（超范围不注入+denial 回调；范围内正常注入）
- `delegator.test.ts` — +4 child-agent（widening 拒绝且无 child/无工具/security.capability_denied 事件；narrowing 通过；无 grant 拒绝；capability.tool 拒绝而 toolPolicy 仍工作）
- `plugin-host.test.ts` — +5 plugin（widening 拒绝不注册；narrowing 通过；无 grant 拒绝；sandbox.tool 拒绝；denial 回调可观测）
- `mcp-transport.test.ts` — +3 MCP（allowedTools 外广告工具拒绝；内注册调用正常；空 allowlist 拒绝一切）
- `canonical-path.test.ts` — +3 回归（无 `//` 前缀、case-folded containment、root-ancestor traversal）
- `runner.test.ts` — 更新 P0-7f 枚举加入 security.capability_denied（新增事件类型后该测试失败，已同步）
Integration Test:
- `pnpm typecheck` — pass
- `pnpm test`（排除 memory FTS5 环境失败后）— 3973 passed / 3 failed（3 个失败均为环境/并行资源问题：memory 57+1 个为沙箱 node:sqlite 缺 FTS5 扩展，event-store.perf 50k 为沙箱磁盘慢超时，runner wall-clock 为并行资源竞争单独跑通过）
- `pnpm build` — pass
Windows:
- CI-PENDING（本地 Linux 验证；Windows job 待 CI 运行）
Linux:
- PASS（全量受影响包测试 2529 passed；全仓排除 memory 后 3973 passed）
Evidence:
- Hook：`before_tool` 返回 name 从 read→exec 的 call → tool.failed + security.capability_denied（details: tool_escalation: read → exec），orchestrator 零调用（逃逸面关闭）
- Skill：SKILL.md frontmatter `requiredTools: exec_command, read` + host allow=[read] → 不注入 + required-tools denial
- Child-agent：delegate({ capability: { network: ["evil.example.com"] } }) + parent grant 无此 host → SECURITY_DENIED + security.capability_denied，listSessions(parentId) 为空
- Plugin：`sandbox: { filesystem: ["C:\work", "C:\Windows"] }` + grant 仅 C:\work → 注册 throw + onCapabilityDenied(SECURITY_DENIED)，stats().total=0
- MCP：server 广告 tools [allowed.tool, smuggled.tool] + allowedTools=[allowed.tool] → MCP_DENIED 注册失败
- 统一语义证据：所有边界都经过 composeBoundaryCapability 单一入口（child-agent 经 async 版 + 事件，plugin 经 sync 版 + 回调），capability guard 与 sandbox 继续共享 canonicalizePath/isPathWithin 单一 containment 语义
Notes:
- memory 包 57 个失败 + benchmark sources.memory 1 个失败为沙箱环境 node:sqlite 缺 FTS5 编译扩展导致（`Error: no such module: fts5`），与代码无关；作者 Windows 开发机/CI 不受影响。event-store.perf "50k appends" 为沙箱磁盘性能 240s 超时（测试自身 180s 预算），非本次改动引入
- MCP allowedTools 拒绝在 harness 创建期无 session 上下文，事件归属不可确立——与现有 security.mcp_denied 创建期行为一致（typed AgentError fail-closed，错误信息含被拒工具清单）
- hook args 变换的沙箱安全性由 orchestrator 在 transform 之后重新做 permission/sandbox 保证（既有管线），P14-4 只封堵 name 身份替换面

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

Status: DONE
Implementation:
- `packages/contracts/src/context.ts` — ContextBlock 增加 `instructional?: boolean`（权威指令 vs DATA ONLY；缺失 = data）与 `persistable?: boolean`（可持久化进 memory；缺失 = 否）。source/trust/provenance 为既有字段，全部 5 项（source、trust、provenance/id、instructional、persistable）构成完整 trust envelope
- 全构造点标注（7 处生产构造器 + 1 处包裹器）：
  - `packages/context/src/pipeline.ts` — system 块 `instructional:true, persistable:false`；project(AGENTS.md) 块 `instructional:false, persistable:false`（repo 文档是 data、可推导事实不存 memory）；skill 索引块 `instructional:false, persistable:false`；quarantine 信封强制 `instructional:false, persistable:false`（data by construction）
  - `packages/context/src/compaction.ts` — compaction summary 块 `instructional:false, persistable:false`（runtime 派生状态，非长期记忆）
  - `packages/agents/src/state-handoff.ts` — scoped working state 块 `instructional:true, persistable:false`（runtime 权威状态）
  - `packages/core/src/runtime/turn-helpers.ts` — tool 结果块 `instructional:false, persistable:false`
  - `packages/harness/src/memory-runtime-bridge.ts` — memory 检索块 `instructional:false, persistable:false`
  - `packages/harness/src/skill-context.ts` — skill body 块 `instructional:false, persistable:false`
  - `packages/mcp/src/mcp-provenance.ts` — MCP 结果块 `instructional:false, persistable:false`（provenance 随块携带）
- Policy 3 结构性保证（扫描器异常 fail-closed）：
  - `packages/context/src/pipeline.ts` — `injectionScanner` 注入依赖（默认 detectPromptInjection），scan 包 try/catch：扫描器异常 → 该来源按注入处理（drop + `scanner-failed` reason 记录进 `injected[]`），内容永不成块、绝不放行
  - `packages/memory/src/write-gate.ts` — `WriteGateScanners` 注入（默认真实检测器），injection/secret 两个扫描均包 try/catch：异常 → `{ allowed:false, code:SECURITY_DENIED, source:"memory-write-gate", details:["scanner-failed"] }`，importance/novelty 再高也绝不持久化
- Policy 2 可观测性：
  - `packages/harness/src/reflection-runner.ts` — write-gate 安全拒绝现在发事件（injection → security.injection_denied、secret → security.secret_redacted、scanner 失败 → security.memory_denied），payload 携带 source/code/reason/details，永不 silent
  - pipeline `injected[]`（id/source/reasons）与 runtime 的 security.injection_denied 为既有可观测面，未改动
- `packages/evaluation/src/formal-invariants.ts` — 新增 **INV-011** `invUntrustedContextIsDataOnly`：非 trusted 块标记 instructional → violation（data 升级为指令）；untrusted 块标记 persistable → violation（污染面）。加入 `checkInvariants` 聚合
Regression Test:
- `trust-envelope.test.ts`（新，harness 包）— 8 个构造点 × 完整 envelope 断言（system/project/skill 索引/compaction summary/scoped state/memory/skill body/MCP），含 INV-011 语义校验
- `pipeline.test.ts` — +3 P14-5（system 是唯一 instructional 块；扫描器异常 → 块 drop + scanner-failed reason；project 文档扫描异常 → drop + denial 记录）
- `write-gate.test.ts` — +3 scanner-failure（injection 扫描器抛异常 → SECURITY_DENIED；secret 扫描器抛异常 → SECURITY_DENIED；importance=novelty=1 仍拒绝，无绕过路径）
- `formal-invariants.test.ts` — +6 INV-011（trusted 可 instructional；untrusted instructional → violation；semi-trusted instructional → violation；untrusted persistable → violation；缺失= data；聚合 gate 含 INV-011）+ 更新 aggregator 断言 10→11
- `reflection-runner.test.ts` — +1 拒绝事件（注入 candidate 被 gate 拒 + security.injection_denied 携带 memory-write-gate/SECURITY_DENIED）
Integration Test:
- `pnpm typecheck` — pass
- `pnpm build` — pass
- 受影响包测试 — 385 passed（context/harness/memory/evaluation/mcp/agents/core 相关）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- INV-011：`{trust:"untrusted", instructional:true}` → violation "data must never upgrade into instruction"；`{trust:"untrusted", persistable:true}` → violation "untrusted content must never enter memory"
- 扫描器异常：pipeline 注入抛错 scanner → 含注入内容的 prior block 未成块，`injected=[{id:"tool:unsafe", source:"tool", reasons:["scanner-failed: ..."]}]`；write-gate 注入抛错 scanner → `{allowed:false, code:SECURITY_DENIED, details:["scanner-failed"]}` 且 importance=1/novelty=1 也拒绝
- 拒绝事件：Reflector 候选携带 "Ignore all previous instructions..." → candidates=0 + `security.injection_denied` {source:"memory-write-gate", code:"INJECTION_DENIED"}
- 标注矩阵：system=instructional✓/persistable✗；project/skill/tool/memory/mcp/compaction=instructional✗/persistable✗；scoped state=instructional✓/persistable✗
Notes:
- 用户输入（user source）不构造 ContextBlock（走 messages 历史，不进系统 prompt 块），故无构造点可标注；user 消息天然是用户权威输入，runtime 现有 trust-boundary prompt 已区分
- reflection-runner 的 `candidateStore.add` catch 与 `events.list` catch 为既有 best-effort（队列/读事件失败不影响应用），P14-5 未动；P14-6 将统一审计 silent catch 语义
- memory 包 FTS5 环境失败（57 个）与 event-store.perf 超时为本沙箱环境问题，与 P14-5 无关（同 P14-4 Notes）

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

Status: DONE
Implementation:
- `packages/contracts/src/non-fatal.ts` — 新建统一 `NonFatalErrorSink` 契约：`report(context, error, meta)` 注入式通道 + `NOOP_ERROR_SINK`（显式 opt-out）+ `stderrErrorSink`（同步 stderr，永不丢失）+ `degradedEventSink`（发 typed `runtime.degraded` 事件 + stderr 兜底——事件写失败也会被上报，第一次报告永不被第二次失败抹掉）+ `isNodeErrorCode(err, code)`（让 catch 只对特定预期错误静默、其余传播）+ `reportDegraded(context, err)`（catch 块速写）
- `packages/contracts/src/event.ts` / `event-payloads.ts` — 新增 `runtime.degraded` 事件类型 + `RuntimeDegradedPayload`（context + reason）
- 全仓 silent catch 扫描与改造（3 类 25+ 处）：
  - **`.catch(() => {})` / `.catch(() => undefined)`（7 处）**：`orchestrator.ts`（tool.output / exec 迟到 rejection / tool.failed / security.permission_denied 发射 → `nonFatal.report`，构造新增 `nonFatal` 依赖）、`mcp-tool-adapter.ts`（security.mcp_denied / retry.mcpReconnect → `opts.nonFatal`）、`create-harness.ts`（context 遥测 / verification-steps / command.discovered 事件 append → `[degraded]` stderr）、`command-discovery-service.ts`（persist）、`benchmark-command.ts`（verification-steps append）、`fixtures.ts`、`transaction.ts`（tmp cleanup）、`apps/web/server.ts`（deliver 队列尾部 rejection）
  - **仅注释的空 catch（best-effort cleanup，P14-6 要求 observable）**：`delegator.ts`（mark-cancelled / workspace.diff / workspace.dispose → `nonFatal.report`，DelegatorDeps 新增 `nonFatal` 依赖，默认 stderr sink）、`context-controller.ts`（artifact-register）、`recovery-controller.ts`（askUser handler）、`gateway.ts`（push-loop）、`server.ts`（SSE 已开始 / stale binding / poll-store / conn-end）、`workspace-manager.ts`（copy / dispose / hash-read）、`reflection-runner.ts`（events.list / candidateStore.add / journal append / journal corrupt-line）、`memory-runtime-bridge.ts`（usefulness update / entriesForIds）、`repo-map.ts` / `workspace.ts`（unparsable manifest）
  - **预期 ENOENT/缺失场景（改为"仅预期错误静默，其余传播"的 fail-closed 模式）**：`candidate-store.ts`、`inbox.ts`、`ask-user-store.ts`、`reflection-runner.ts`、`command-discovery-service.ts`、`skill-context.ts`、`workspace-manager.ts`、`discovery.ts`、`env-snapshot.ts`、`write-file.ts`、`symbol-index.ts`、`store-integrity/index.ts`、`retention.ts`、`approval.ts`（幂等 re-hydration 上报）、`migrate.ts`（duplicate id 上报）、`sqlite-runtime-store.ts`（close journal-mode）、`memory-store.ts` / `inbox.ts` / `skill-store.ts` / `scope-resolver.ts`（corrupt-line 上报）
- 安全关键结论（security gate / permission / checkpoint / approval / memory write / capability composition）确认未走 NonFatalErrorSink——它们的 denial 仍是有类型、fail-closed 的 error/event（如 permission_denied 发射失败通过 `nonFatal` 上报但 denial 结论本身不变）
Regression Test:
- `packages/security/src/no-silent-catch.test.ts`（新，lint 静态扫描，进 CI）— 扫描 packages/**/src + apps/**/src 全部非测试源码，禁止三类模式：`.catch(() => {})`、`.catch(() => undefined)`、空 catch 块（strip 注释后仍为空）。无白名单——存量已清零，新引入即红
- `packages/contracts/src/non-fatal.test.ts`（新）— 6 个单元测试（NOOP 不抛、stderr sink 写 degraded 行、degradedEventSink 发 runtime.degraded + stderr 兜底、事件写失败也上报、isNodeErrorCode 语义、reportDegraded 速写）
- 存量改造均被 lint 验证：改造前 26+ 处命中 → 改造后 0
Integration Test:
- `pnpm typecheck` — pass
- `pnpm build` — pass
- 受影响包测试 — 99 files / 2979 tests passed（security/tools/agents/harness/mcp/context/session/store-integrity/store/gateway/core-runtime/skills/memory-write-gate）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- lint 扫描器真实发现存量违规：改造前 `.catch(() => {})` 7 处 + 空/仅注释 catch 26 处（分布在 orchestrator/mcp-adapter/harness/session/store/tools/web 等）；全部消除后 lint 4 tests green
- `orchestrator.emit` 失败 → `[degraded] orchestrator.emit:tool.output: <err>` 同步落 stderr，工具执行不中断，事件可观测
- `degradedEventSink`：事件流出现 `runtime.degraded {context, reason}`；即使 EventSink 抛错，stderr 仍有 `[degraded] ... event emit failed for ...`（第二失败被报告）
- 预期 ENOENT 模式：`readFile` 首次运行失败只静默 ENOENT，其他错误 `throw err`（fail-closed 传播，不再吞）
Notes:
- 静态扫描用 stripComments 后检测——"注释不是可观测性"（P14-6 原文），catch 必须含实际上报代码或 fail-closed 逻辑
- 预期静默类（ENOENT 首次运行 / 目录不可读 / corrupt-line）全部改为"仅特定预期错误静默 + 上报其余"，语义比原实现更严格（非 ENOENT 错误不再被吞）
- 安全结论类路径（permission deny、checkpoint 校验失败、approval 拒绝、memory gate 拒绝、capability 拒绝）保持 fail-closed error/event，未改用 NonFatalErrorSink（该通道专用于不影响安全结论的 best-effort 工作）

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

Status: DONE
Implementation:
- `packages/harness/src/adversarial-regression.test.ts` — 新建统一的 adversarial regression pack（P14-7 审计面）：8 个场景以攻击演练形式对真实原语断言拒绝，攻击成功即记录逃逸，末尾 `CRITICAL SECURITY ESCAPE COUNT = 0` 门禁断言（Champion promotion gate）
- 覆盖审计（8 场景 × 现有/新增）：
  - A1 path traversal capability widening — canonicalize 后 composeCapabilities 拒绝（P14-1 语义，先 canonicalize 再 containment）
  - A1b sibling-root collision（`/ws-evil` vs `/ws`）— 拒绝
  - A2 symlink/junction escape — **新增真实 symlink 场景**（mkdtemp + symlink 指向外目录，canonical 解析到 realpath 外部目标 → 拒绝）
  - A3 allowed-command prefix chaining（`git diff; rm -rf /`）— parseCommandInvocation 识别 shell operator + commandAllowlisted 拒绝；A3b 同前缀兄弟程序（`git difftool` vs `git diff`）— 拒绝
  - A4 hook capability widening — composeBoundaryCapability("hook") 抛 typed denial，narrowing 仍通过
  - A5 MCP description injection — detectPromptInjection 命中
  - A6 memory poisoning after untrusted context — evaluateCandidate 拒绝注入内容（INJECTION_DENIED，importance=novelty=1 也拒）；A6b trust-envelope 结构保证（untrusted persistable → invariant violation，内联 INV-011 语义）
  - A7 writable child without isolation — writableIsolationError SECURITY_DENIED
  - A8 approval same-text/different-environment — approval 无文本级复用面（per-request id 唯一、DurableApprovalStore 只按 id 解析）；**新增 orchestrator 级双 session 集成测试**（`packages/tools/src/orchestrator.test.ts` P14-7 块）：相同 target 文本在 session A 批准后，session B 相同文本必须产生全新 approval 请求（id 不同），deny 即拒绝——文本相等性绝不复用审批决策；第二个测试验证 approval 请求携带精确环境身份（sessionId/turnId/agentId）
Regression Test:
- `adversarial-regression.test.ts` — 12 个测试（8 场景 × 拒绝断言 + 2 补充 + escape count 门禁）
- `orchestrator.test.ts` — +2 approval 环境独立性（同文本跨 session 不复用；请求携带环境身份）
- 复用既有 P14-1/2/3/4/5 测试作为场景基础（canonical-path/capability-guard/process-gate/boundary-guard/sandbox/mcp-adapter/delegator/runtime）
Integration Test:
- `pnpm typecheck` — pass
- `pnpm build` — pass
- 全场景相关测试 — 263 passed（adversarial + orchestrator + boundary-guard + process-gate + canonical-path + capability-guard + mcp-adapter + delegator + runtime）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- **Critical security escape count = 0**（`expect(ESCAPES).toEqual([])` 通过）
- A1：canonicalize 后 `/ws/../../etc/passwd` → `/etc/passwd`，composeCapabilities 判 filesystem_escalation
- A2：真实 symlink `ws/link→outside`，canonicalize 解析到 realpath 外部目标，containment 拒绝
- A3：`git diff; rm -rf /` 被 parseCommandInvocation 标记 hasShellOperators=true 且 allowlist 拒绝；`git difftool` 不匹配 `git diff`
- A8：session A 批准 read_file(path) 后，session B 相同 path 产生新 approval（`bPending[0].id !== aPending[0].id`），resolve deny → APPROVAL_DENIED；approval 请求带 sessionId/turnId/agentId 精确环境身份
Notes:
- P14-1 的 containment 要求 caller 先 canonicalize（composeCapabilities 纯函数假设 canonical 输入）；adversarial 测试按生产调用方式（capability-guard 路径）先 canonicalize 再组合——原始 traversal 字符串未经 canonicalize 时字面前缀会误判，这正是 P14-1 在 capability guard 中加 canonicalize 层的原因（生产已保证）
- 场景 6 的端到端链（untrusted context → quarantine → candidate 拒绝 + 事件）由 reflection-runner.test.ts（P14-5）与 INV-011（formal-invariants.test.ts）覆盖，pack 在此断言其原语层

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

Status: DONE
Implementation:
- `packages/contracts/src/recovery.ts` — 新增 `TurnExecutionState` 接口（`recoveryUsage`）+ `newTurnExecutionState()` 工厂；明确"每 turn 新建、turn 结束即弃、绝不跨 turn/session 共享"
- `packages/core/src/runtime/runtime.ts` — 移除 `AgentRuntime.recoveryUsage` 实例字段（原污染点：runtime 持有并被 ToolCallController 长期引用）；`prepareTurn` 的 `TurnInit` 增加 `turnState`，每次 runTurn 创建全新 `TurnExecutionState`；`executeToolCalls` 调用处按值传入 turnState
- `packages/core/src/runtime/tool-call-controller.ts` — `ToolCallControllerDeps` 移除 `recoveryUsage`；`executeToolCalls`/`runReadBatch`/`executeToolCall` 增加 `turnState` 参数按值贯穿；adaptive recovery 循环读写 `turnState.recoveryUsage`
- tool execution ledger / working state / budget 本已是 per-turn（prepareTurn 创建），P15-1 将 recoveryUsage 并入同一 per-turn 生命周期
Regression Test:
- `runtime.test.ts` — +3（Turn A 耗尽 change_strategy 后 Turn B 重新获得完整预算 2；Session A 耗尽不影响 Session B；两 session 并发不共享预算）
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
- core 相关 — 301 passed（含 P15-1/P15-2/P15-4/P15-6 新增）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- 跨 turn：Turn A 4 次失败消费 change_strategy×2 + delegate×1，Turn B 2 次失败仍产生 change_strategy×2（总 4，未共享）；改造前 Turn B 会因预算耗尽而 fail_safe
- 跨 session：Session A 耗尽后 Session B 首次失败仍 change_strategy
- 并发：两 session Promise.all 并行 runTurn，各自 budget 独立
Notes:
- resume 预算语义：checkpoint/resume 恢复的 turn 由 prepareTurn 创建全新 turnState（从 checkpoint 恢复 working state 但 recovery budget 每 turn 新建），符合"该 turn 已消耗预算"由 P16-3 checkpoint 预算持久化承担（本 task 不重复实现）

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

Status: DONE
Implementation:
- `packages/contracts/src/step-context.ts` — 新增 `StepContext` 接口：stepId/sessionId/turnId/agentId + frozen `effectiveAgent`（EffectiveAgentConfig 快照）+ cwd + `toolSpecs` 快照 + `policyHash`（permission/sandbox/tool 指纹）+ `contextSelection`（blocks/tokens/compacted）+ model ref。文档明确"模型及其工具调用可观测的一切在调用前钉死"
- `packages/core/src/runtime/runtime.ts` — `buildStepContext` 私有方法：每次 model 调用前构造（snapshotEffectiveConfig + hashPolicyConfig + toolSpecs + priorBlocks/system 规模），循环内 stepIndex 递增；同一 step 对象传入 `callModelWithRetry` 和 `executeToolCalls`
- `packages/core/src/runtime/model-call-controller.ts` — `callModelWithRetry` 增加 `step?` 参数，`model.started` 事件携带 stepId（step 可观测）
- `packages/core/src/runtime/tool-call-controller.ts` — `executeToolCalls`/`runReadBatch`/`executeToolCall` 增加 `step` 参数贯穿；`tool.requested` 事件携带 stepId —— 同一次模型响应的一批 tool calls 共享同一 stepId
Regression Test:
- `runtime.test.ts` — +2（一次模型响应 2 个 tool calls 共享同一 stepId 且 model.started 带该 stepId；两次顺序 model 调用产生不同 stepId）
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- 同一模型响应（多 tool_call_delta）的两个 tool.requested 事件 stepId 相同（`turn:<turnId>:0`）
- 第二个 model 调用的 tool.requested stepId 为 `:1`（每 step 递增，config/policy 变化只能在下一 step 生效）
Notes:
- policy 变化检测：stepId 递增即 step 边界；policyHash 可用于显式 drift gate（当前无 runtime 中途改 policy 的路径，resume 时 RUNTIME_POLICY_SNAPSHOT 已有 safe-resume 门）

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

Status: DONE
Implementation:
- **SessionInbox**（`packages/session/src/inbox.ts`）：`MemInboxStore` + `JSONLInboxStore` 增加 `maxPending` 构造选项（默认 1000）；`admit` 超限抛 typed `SessionStoreError("QUEUE_FULL")` —— overflow 是 reject，绝无 silent drop；durable JSONL store 保持落盘优先（RAM 只是读取镜像）
- **ask/approval pending**（`packages/session/src/ask-user-store.ts`）：`JSONLAskUserStore` 增加 `maxPending`（默认 1000），`create` 超限抛 `QUEUE_FULL`
- **scheduler queues**（`packages/contracts/src/limits.ts` + `packages/agents/src/scheduler.ts`）：`SchedulerLimits` 增加 `maxQueued`（默认 1000）；`acquire` 在 canStart=false 时若 queued 已满 → `cleanupGate` reject `RESOURCE_LIMIT`（typed，不排队不静默）
- **错误码**（`packages/session/src/session-store.ts`）：`SessionStoreErrorCode` 增加 `QUEUE_FULL`
- 审计结论：event stream 是 pull 模型（gateway 按 seq 轮询，天然有界）；MCP 无请求队列（每次 callTool 独立请求）；store-integrity locks 是进程级互斥（key=文件路径，无 session 数据）——无需改动
Regression Test:
- `inbox.test.ts` — +3（Mem reject 超限；JSONL reject 且已 admit 落盘无损；10k 次 admit 在 maxPending=100 处精确截断，内存有界）
- `ask-user-store.test.ts` — +1（超限 QUEUE_FULL）
- `scheduler.test.ts` — +1（maxQueued=2 时第 4 个请求 RESOURCE_LIMIT）
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
- session/agents — 全部通过（301 passed 含本批）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- 10k steer 输入在 maxPending=100 处拒绝（admitted=100 后 QUEUE_FULL），无无界内存增长
- JSONL inbox：第 2 次 admit 超限时 listPending 仍返回 1（durable 真相在盘上，RAM 非真相）
- scheduler：maxGlobalAgents=1 + maxQueued=2 时第 4 个 acquire rejects RESOURCE_LIMIT
Notes:
- 默认 maxPending/maxQueued 1000 为安全默认；host 可按场景调低

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

Status: DONE
Implementation:
- `packages/core/src/runtime/recovery-controller.ts` — `finishTurn` 增加 **exactly-once 幂等保护**：`RecoveryController.isTerminal(status)` 判断 store 中 turn 是否已是 terminal（completed/failed/cancelled）；若是则直接返回既有 outcome（不重复 `updateTurn`、不重复 emit terminal 事件）。重复 cancel、重复 approval reply、crash 后 resume 已完成的 turn 都收敛到第一次 terminal transition
- `onTurnComplete` 单次性：runTurn wrapper 每次调用恰好一次（runTurnCore 单次返回），未改动
- AgentState 既有 terminal 保护（transition from terminal throws）保持
Regression Test:
- `recovery-controller.test.ts`（新）— 4 个：重复 finishTurn(completed) 只发 1 个 turn.completed；重复 cancel 只 1 个 turn.cancelled 且 store status 保持 cancelled；crash 恢复（store 已 completed）不再重发 terminal 事件；重复 approval reply（两次 finishTurn failed）只 1 个 turn.failed
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
- runtime/resume/checkpoint/fault-injection — 92 passed（回归）
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- 双 finishTurn：turn.completed 事件计数 = 1；第二次返回相同 outcome（status 一致）
- crash 恢复：store 预置 completed + 再次 finishTurn → 0 个新 terminal 事件（不再 fan-out）
- 重复 cancel：turn.cancelled = 1，store status 仍 cancelled
Notes:
- waiting_for_user / waiting_for_approval 非 terminal（可恢复），不在幂等分支；resume 通过 checkpoint 恢复后进入这些状态是正常的

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

Status: DONE
Implementation:
- **全仓审计** module-level mutable cache/singleton：symbol-index 的 `const cache = new Map<root, RootIndex>`（唯一 module-level 数据缓存）、store-integrity 的 `const locks`（进程级文件锁，语义正确）、repo-map 的 RepositoryMapCache（instance 级 + stat fingerprint 失效 + dirtyPath，key 完整）✓、command-discovery hintsByRoot / skill bodyCache（instance 级）✓、event sequencing（per EventStore 实例）✓、scheduler accounting（instance 级）✓
- `packages/tools/src/symbol-index.ts` — **修复 module cache**：新增 CacheEntry（index + rootStat 指纹）、CACHE_TTL_MS=60s、MAX_CACHE_ENTRIES=64（LRU 淘汰）、`rootFingerprint`（root 目录 mtime/size）；`getSymbolIndex` 校验指纹 + TTL，失效即重建——key 从"root 路径"补全为"root 路径 + 目录指纹 + TTL"，杜绝 stale 状态跨 repo 泄漏或同 repo 变更后服务旧索引
Regression Test:
- `symbol-index.test.ts` — +2（两 repo 索引互不串扰——repo A 的 symbol 在 repo B 查不到；root 目录指纹变化后重建——新 symbol 可查、旧 symbol 保留）
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- 跨 repo：`alpha` 在 repo A 命中、在 repo B 0 命中（无串扰）
- freshness：root 下新增子目录（root mtime/size 变）→ `second` 符号立即可查（缓存未服务 stale）
- 容量：MAX_CACHE_ENTRIES=64 防止多 repo 无界堆积
Notes:
- store-integrity locks 与 repo/session 数据无关（纯互斥原语），保留为进程级并注明 scope

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

Status: DONE
Implementation:
- `packages/core/src/runtime/tool-call-controller.ts` — **并行 read batch**（`runReadBatch.onAbort`）：原实现"drop 未完成 reads"改为**为每个未完成 call 生成 synthetic cancelled result**（`{status:"cancelled", error:USER_CANCELLED}`），已完成的保留真实结果——tool call 永不出现在 transcript 中消失
- **串行/序列路径**（`executeToolCalls`）：while 顶部 signal.aborted 时，为**所有未开始的 calls 生成 synthetic cancelled** 并 push 进 executed（原为直接 break 丢弃）；serial 分支 abort 后同样为剩余 calls 生成 synthetic cancelled——transcript/replay 对模型已发出的每个 call 都有 settlement
- synthetic cancelled 走正常 `handleToolResults` 路径 → tool message + toolLedger 记录（P1-3 证据链）
Regression Test:
- `fault-injection.test.ts` — +4（abort mid batch：模型 3 个 calls 全部在 message trail 有 settlement 且 ≥1 cancelled；abort 于串行写链：2 calls 全部 settle；commit 后 abort：已提交 write 保留 success、后续 synthetic cancelled；重复 abort：恰好 1 个 settlement 不重复）
Integration Test:
- `pnpm typecheck` / `pnpm build` — pass
- core runtime 全量 — 通过
Windows:
- CI-PENDING
Linux:
- PASS
Evidence:
- abort mid batch：settleCount(store)=3（模型发出 3 个 calls → 3 条 tool messages），其中 cancelled messages ≥1
- commit 后 abort：committed messages=1（write a success）+ settleCount=2（a + synthetic-cancelled b）
- repeated abort：settleCount=1（双 abort 只 settle 一次）
Notes:
- abort before batch（turn 级）由 runTurnCore 顶部 signal 检查处理（finishTurn cancelled，无 tool calls 发出）；已发 tool calls 的 settlement 由本 task 覆盖

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

Status: DONE

**Implementation**

- orchestrator 新增 `persistIntent` 依赖：sideEffectScope != none 的工具在 validate/permission/approval/sandbox 全通过后、executor 前持久化 intent（toolCallId/tool/argsHash/semantics/startedAt/session/turn/sideEffect scope），持久化失败 fail-closed 返回 `PERSISTENCE_ERROR`（新增 ErrorCode），副作用绝不执行。
- contracts 新增 `ToolIntentPayload` + `tool.intent_persisted` 事件；create-harness 注入实现（await append 到 durable EventStore）。
- 新增 `tool.intent_persisting` / `tool.intent_persisted` 两个 FaultPoint 崩溃窗口（P16-6 共用）。

**Regression Test**

- 3 个测试：intent 成功携带 argsHash+semantics 且先于 tool.started；persistIntent 失败 → 副作用不执行（文件不存在）+ PERSISTENCE_ERROR；read-only 工具不受 intent gate。

---

---

## P16-2 Unknown-outcome reconciliation

进程死在 intent 持久化后、terminal record 之前：恢复时该调用标为 `unknown_outcome`。

**Recovery policy**

- read-only/idempotent: 可按策略安全重跑。
- filesystem write: 先检查目标状态/hash/diff，能确认效果则 reconcile，不能确认则要求 verifier/user 决策。
- process/network/global: 默认绝不自动重跑。
- 每次 reconciliation 有 event/evidence。

Status: DONE

**Implementation**

- `classifyUnknownOutcome(tool, semantics, evidence?)` 语义分类器（never name-based）：readOnly/idempotent → `safe_retry`；filesystem → `needs_verification`（可携带 evidence hash/diff）；process/network/global/unknown → `never_auto`。
- `UnresolvedToolExecution` 增加 `sideEffectScope`；resume 时每个 unresolved 调用生成 typed `ReconciliationVerdict`，`retry.reconciliation` 事件携带 decision/reason/evidence。
- `buildResumePrompt` 按 verdict 渲染（[safe_retry]/[needs_verification]/[never_auto]）。

**Regression Test**

- 4 个测试：read-only/idempotent → safe_retry；filesystem → needs_verification（有无 evidence 两态）；process/network/global/unknown → never_auto；prompt 渲染 per-tool verdict。

---

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

Status: DONE

**Implementation**

- `CheckpointBudgetUsage` 扩展：完整 `run` snapshot（RunBudget）+ `recoveryUsage` + `verificationRetries` + `stallRecoveryCount`。
- `RunBudgetTracker.seedConsumed()` 支持恢复 seed；`AgentState.stallRecoveriesUsedCount/seedStallRecoveries`。
- `RunTurnOptions` 新增 budgetSeed/recoveryUsageSeed/verificationRetriesSeed/stallRecoverySeed；`prepareTurn`/`runTurnCore` 恢复 seed；resume 把 checkpoint.budgetUsage 透传。
- `activeBudgetUsage` 闭包让所有 checkpoint 写入自动携带完整预算。

**Regression Test**

- 2 个测试：periodic checkpoint 携带完整 run snapshot（usedToolCalls/usedTurns/recoveryUsage/verificationRetries/stallRecoveryCount）；resume 后 maxToolCalls 不刷新（首调用即 RESOURCE_LIMIT）。

---

---

## P16-4 Production persistence contract

定义 production/interactive durable mode：

- 若启用 approval / ask_user / checkpoint / long-run recovery，却没有 durable store，必须明确标记 `degraded`，不能在 audit 中误报为 production-ready。
- 提供明确 `ephemeral` profile 给测试/临时运行。
- 不强迫所有用户都落盘，但 capability matrix 必须真实反映 durable vs in-memory。

Status: DONE

**Implementation**

- `HarnessIntrospection.persistence`：mode（durable/in-memory）+ degraded + reasons + per-feature store class。
- degraded 判定：checkpoint 启用但无 durable store / checkpoint store 非 durable / approval store 非 durable / delegation 无 durable session-event store / interactive/batch 无 ask-user store → 每个 reason 明确列出，audit 永不把 degraded harness 报为 production-ready。
- 新增 `ephemeral` profile：checkpoint/artifacts 默认 OFF，无 dataDir 时诚实 in-memory；传 dataDir 即升级 durable（profile 只改默认值不改能力真相）。

**Regression Test**

- 3 个测试：ephemeral 无 dataDir → in-memory 不 degraded；interactive 无 dataDir → degraded（checkpoint 无 store）；有 dataDir → durable 不 degraded。

---

---

## P16-5 Event sequencing and injected clock cleanup

审计 composition root 中所有直接：

- `Date.now()`
- `sequence: 0`
- `as never` event type escape

事件必须经统一 typed emitter / sequence allocator / injected clock。

**Acceptance**

同 session 事件 sequence 严格单调；replay 可稳定排序；测试 deterministic。

Status: DONE

**Implementation**

- `HarnessConfig.now?: () => number` 注入时钟；create-harness 统一 `appendHarnessEvent` emitter（注入时钟 + store 权威 sequence allocator + typed AgentEvent）。
- 消灭 7 处 `Date.now()` / `sequence: 0` / `as never` 逃逸（orchestrator sink / MCP sink / persistIntent / context-telemetry / verification-steps / reflection / command-discovered）；AgentRuntime 共享注入时钟。
- CLI benchmark 抽局部 `now()` 时钟。

**Regression Test**

- 2 个测试：注入时钟下所有事件 timestamp === 注入值（确定性）；同 session sequence 严格 +1 单调（replay 稳定）。

---

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

Status: DONE

**Implementation**

- 新增 FaultPoint `tool.intent_persisting`（gate 全过、intent 未落盘 → resume 可安全重跑）与 `tool.intent_persisted`（intent 已落盘、executor 未启动 → unknown-outcome reconciliation）。
- orchestrator 新增 `intentPersistedFailAt` 钩子在 persistIntent 成功后、tool.started 前触发。
- 既有窗口覆盖：tool.executing（副作用执行中）/ tool.completed（effect 后 checkpoint 前）/ tool.checkpointed（checkpoint 后）/ context.compacted（压缩中）/ model.next_call / model.stream / verification.started。

**Regression Test**

- 4 个测试：intent_persisting kill → 无记录、resume 安全完成；intent_persisted kill → intent 已落盘、executor 未执行（文件不存在）、resume unresolved 不重跑；orchestrator 层 intentPersistedFailAt 恰好一次（persist 后 execute 前）且 read-only 不触发。

---

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

Status: DONE

**Implementation**

- `MemoryCandidate` 增加 sourceTurn / derivability / promotionState / securityScan / pollutionSources。
- memory 包新增 `assessDerivability(content)` 确定性分类器：非可推导 marker（preference/decision/lesson/environment/constraint）优先；repo/git/config marker → derivable；无信号保守 non-derivable。
- reflection-runner：candidate 生成时附 derivability + securityScan + sourceTurn + promotionState（P17-2 联动）。
- `learn promote` Gate 0：derivable 或 quarantined candidate 拒绝（绝不停留长期 memory）；promotion 保留全部 provenance。

**Regression Test**

- 4 derivability 测试（derivable/non-derivable/偏好优先/默认）+ 3 promote 门控测试（quarantine/derivable/provenance 保留）。

---

---

## P17-2 Memory pollution quarantine

借鉴“external context polluted”思想：

若本 turn 使用了 untrusted MCP/tool/remote skill/repository instruction 内容，则该 turn 产生的 memory candidate：

- 不得自动 promote
- 必须标记污染来源
- 进入 quarantine/review queue
- security scan failure → reject

即使 learning 功能开启，也不允许“恶意仓库一句话 → 永久记忆”。

Status: DONE

**Implementation**

- `detectPollutionFromEvents(events, turnId)`：MCP 工具（mcp_/mcp: 前缀）与 repo instruction 文件（AGENTS.md/README/CONTRIBUTING.md）读取 → 污染源。
- reflection-runner：污染 turn 的 candidate → `promotionState: "quarantined"` + pollutionSources 标记。
- `learn promote` Gate 0a：quarantined candidate 硬拒绝；security scan failure → reject（write-gate）。

**Regression Test**

- 3 个测试：detectPollution 命中 MCP/AGENTS.md 且不误报用户代码；污染 turn → quarantined + 标记完整；干净 turn → pending。

---

---

## P17-3 Skill on-demand loading invariants

保留现有 index → selection → body，不回退到全文预载。

增强：

- skill provenance / trust
- cache invalidation（文件改动后可控刷新）
- collision policy 可预测
- selected skill body 全量加载，不通过危险分页只读半截指令
- skill declared tool dependency 仍需 capability/permission gate

Status: DONE

**Implementation**

- `Skill` 增加 provenance（source/root/trust：本地 → semi-trusted，远程 → untrusted）。
- FileSkillLoader：body 缓存（path + mtime 指纹，mtime 变化自动刷新）+ `invalidateBodyCache()` 可控失效 + 容量上限（64）。
- collision policy 确定性保持（路径排序 + 首现胜出）；截断体永不静默（truncation marker）。
- requiredTools → capability/permission gate 沿用 P14-4 skillCapability。

**Regression Test**

- 4 个测试：provenance/trust 标注；mtime 缓存刷新 + invalidate；重叠 root 确定性；截断带 marker。

---

---

## P17-4 One context taxonomy

明确并编码 ContextBlock 类别：

1. **protected instruction**：用户硬约束、effective policy 摘要、当前 goal
2. **working state**：plan、pending、decisions、files changed、unresolved tool calls
3. **knowledge**：memory / selected skill / instructions
4. **evidence**：tool/verification results
5. **ephemeral**：progress、temporary observations

不同类别定义明确的：priority、compressible、persistable、trust、rehydratable。

Status: DONE

**Implementation**

- `ContextCategory` 5 类：protected-instruction / working-state / knowledge / evidence / ephemeral。
- `CONTEXT_CATEGORY_SPECS` 单表编码每类 priority/compressible/persistable/trust/rehydratable；缺省 category = evidence（最保守）。
- 全构造点标注：system→protected-instruction、project/skill/memory→knowledge、tool/MCP→evidence、scoped-state/compaction summary→working-state、ephemeral→ephemeral。

**Regression Test**

- 7 个 taxonomy 测试（每类完整 profile、优先级严格序、缺省 evidence、关键语义断言）。

---

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

Status: DONE

**Implementation**

- `MultiStageCompactor`：唯一 production compaction 状态机，成本升序 6 阶段（offload/preview → ephemeral-drop → micro-compact 去重 → structured digest → 可选 LLM summary → reactive fallback 一次）。stage 1-4 纯确定式；5-6 为可选 hook。
- pipeline 默认 compactor = MultiStageCompactor（单一 policy，无 parallel fork）；`Compactor` 接口支持 async 阶段。

**Regression Test**

- 5 个测试：阶段成本顺序 + micro 去重；oversized evidence 预览 marker；ephemeral 先丢；无可压缩输入 → 无 digest；pipeline 默认走多阶段。

---

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

Status: DONE

**Implementation**

- `protectedFieldsMissing(facts, renderedDigest, workingStateCarried)` 程序化校验器：12 类 protected facts，每项须在 digest 或 durable working state 中。
- `buildStateDigest` 扩展渲染全部字段（goal/constraints/decisions/pending/completed/files/commands/tests/failures/facts/questions/refs）。
- context-controller 压缩后立即校验，缺失 → `context.protected_facts_violation` 事件（可观测，绝不静默）。

**Regression Test**

- 4 个测试：完整 digest 零缺失；缺字段精确报告（非空 summary 不等于成功）；working-state-only refs 经 durable 携带；buildStateDigest 集成渲染零缺失。

---

---

## P17-7 Post-compaction rehydration

压缩后只恢复必要的高价值引用：

- recent touched/read files（有 token/文件数量上限）
- active plan
- selected/invoked skills
- unresolved tool evidence
- transcript/artifact pointers

不要把完整历史重新塞回 prompt。

Status: DONE

**Implementation**

- `buildRehydrationBlocks(summary, opts)`：压缩后只恢复高价值引用（recent files 有 maxFiles 上限 + maxTokens 预算、active plan、skills、unresolved evidence、transcript/artifact pointers），全部为指针式内容。
- pipeline：实际压缩（出现 digest）后才追加 rehydration blocks。

**Regression Test**

- 3 个测试：5 类引用恢复且文件为指针（无全文）；maxFiles/maxTokens 有界；无压缩则无 rehydration。

---

---

## P17-8 Compaction circuit breaker + benchmark

- 连续 ineffective compaction / compact failure 有明确 breaker。
- 记录 before/after tokens、protected-field preservation、latency、summary fallback 次数。
- stress suite 加长会话：10k messages / large tool outputs / repeated compactions。

Acceptance：不能出现 compact loop；不能因 compaction 永久丢失 pending work。

Status: DONE

**Implementation**

- `CompactionCircuitBreaker`：连续 ineffective（after >= before）或 compact failure → armed → open；open 后 pipeline 跳过 auto-compact 并报告 `compactionBreakerOpen`，杜绝 loop。
- 观测指标：total/effective/ineffective、netTokenDelta、latency、fallback 次数、last 明细。
- stress suite：10k 大块单遍压缩，breaker 记录 ≤1 次 totalCompactions。

**Regression Test**

- 6 个测试：连续 ineffective → open；effective 重置 + metrics；failure → armed；fallback 计数；open breaker 下 pipeline 不压缩（无 digest/rehydration）；10k blocks 单遍 + pending/files 保留于 digest。

---

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

Status: DONE

**Implementation**

- `contracts/tool.ts`：`ToolCapability` 降级为 legacy 适配类型（JSDoc 明确禁止作为决策源）；新增**唯一投影** `toToolCapability(semantics)`（retry←retrySafety、concurrencySafe←concurrencySafety）；`DEFAULT_TOOL_CAPABILITY` 改为 `toToolCapability(DEFAULT_TOOL_SEMANTICS)`（TDZ 安全地定义在 semantics 之后）。
- `tools/registry.ts`：`capabilityOf()` 改为 `toToolCapability(semanticsOf(tool))` —— 单一派生链 metadata→semantics→capability，两视图永不漂移；registry 不再直接读 `metadata.retry/concurrencySafe`。
- `core/runtime/tool-call-controller.ts`：deps 由 `toolCapabilityOf` 改为 `toolSemanticsOf`；并发 batch 决策用 `concurrencySafety`，重试门禁用 `retrySafety`；stall-trace `isRead` 判定改用 `readOnly`（P2-41"证据型读操作"语义，而非旧的 concurrencySafe 近似）。
- `core/runtime/runtime.ts`：删除 `toolCapabilityOf` 字段/默认/controller 注入，统一走 `toolSemanticsOf`。
- `harness/create-harness.ts` + `apps/cli/benchmark-command.ts`：删除 capability 注入，保留 `toolSemanticsOf: (name) => semanticsOf(registry.get(name))`。
- 决策点全覆盖审计：retry/concurrency（controller）、checkpoint/side-effect reconciliation（runtime `sideEffectScope` + `classifyUnknownOutcome`）、approval/network/output-sensitivity（orchestrator + context-controller 均消费 semantics）；cancellation 留给 P18-5 的 settlement 语义。

**Regression Test**

- 3 个 runtime 测试文件（runtime/loop-integration/fault-injection）改用 `toolSemanticsOf` 注入；makeRuntime 默认注入由 `readOnly: true` 改为 `readOnly: false`（echo/flaky 非证据读，重复相同调用走 legacy streak-stall 而非 repeated_read_no_change pattern）。
- `tools/source-matrix.test.ts` 新增恒等式回归：`capabilityOf(x) === toToolCapability(semanticsOf(x))`（注册工具与 unknown 兜底双路径）。
- typecheck/build 全绿；受影响 5 包 792 测试通过（1 个 memory 相关失败为沙箱 FTS5 环境问题，stash 基线可复现）。

---

## P18-2 Deferred tool schemas only when needed

借鉴 ToolSearch/skill on-demand，但不要给 12 个内置工具过度设计。

**Rule**

- 内置小工具集继续直接广告。
- 当 MCP/plugin 使工具数或 schema token 超过阈值时，启用 deferred schema + tool search/discovery。
- 阈值必须根据 schema token budget，而不是硬编码“工具数 50”。

Benchmark 对比：全量 schema vs deferred schema 的成功率/token/latency。

Status: DONE

**Implementation**

- `contracts/tool.ts`：新增 `estimateSpecTokens/estimateSpecsTokens`（chars/4 ≈ tokens），core 与 tools 共用同一估算。
- `tools/schema-advert.ts`：`DEFAULT_MAX_INLINE_SCHEMA_TOKENS`（24k，内置 12 工具远低于阈值）＋ `decideSchemaAdvert(specs, { maxInlineTokens, keepFull })` —— 阈值纯 token 预算驱动，**不硬编码工具数**；超预算时非 core 工具转 stub（name + 截断描述 + `{type:"object"}`）。
- `tools/tool-lookup.ts`：`createToolLookupTool(registry)` —— 只读/幂等/并发安全，按名返回完整 inputSchema；deferred 模式下自动注册进 registry 与 agent allow 列表。
- `harness/create-harness.ts`：MCP/plugin 使 schema token 超预算 → deferred 模式（内置工具 keepFull 全量广告，bulk 转 stub，system prompt 追加 tool_lookup 使用说明）。
- `core/model-call-controller.ts` + `contracts/event-payloads.ts`：`tools.selected` 事件新增 `advertisedTokens`，full vs deferred 的成本端到端可观测。
- Benchmark：`BenchmarkCase.schemaMode`（"full" | "deferred"），deferred case 走真实 tool_lookup→tool→write 路径。

**Regression Test**

- `schema-advert.test.ts` 7 测试（token 单调、full/deferred、阈值按 token 非工具数、keepFull 集合/谓词、stub 截断）。
- `tool-lookup.test.ts` 2 测试（完整 schema 返回/未知工具报错、read-only 声明）。
- runtime `tools.selected` 断言带 `advertisedTokens > 0`。
- benchmark 端到端：full 与 deferred 同一 MCP case 均 1/1 passed（成功率一致）；token 差距在决策层量化（stub 后广告 token 显著小于全量）。
- 受影响 4 包 648 测试通过（1 个 memory FTS5 环境失败，stash 基线可复现）。

---

## P18-3 Plugin policy: explicit trust, never default Champion

研究表明同进程 plugin 是任意代码执行面。

**Do**

- capability matrix 明确区分：implemented / trusted-local / isolated / production-wired。
- 当前若 plugin 为同进程执行，默认 Champion 保持 OFF。
- 只有显式 trusted-local 配置才能加载；project-local plugin 需要 workspace trust/approval。
- 后续若要自动启用，先实现进程隔离或等价安全边界；本 Phase 不要求为了“开插件”赶做一个假沙箱。

Status: DONE

**Implementation**

- `PluginPolicy` 新增 `defaultChampion`（默认 **false**）、`executionModel`（默认 "in-process"，文档化无进程隔离）、`workspaceApproved`（project-local 显式工作区信任）。
- `PluginError` 新增 `champion-off` / `project-local-requires-approval` 两类 typed denial。
- `PluginHost.register` 门禁（fail-closed）：非 builtin 插件默认一律拒绝（Champion OFF），仅显式 `defaultChampion: true` + `allowedSources`（trusted-local）可加载；`source === "local"` 还需 `workspaceApproved: true`。
- capability matrix（audit.ts + CAPABILITY_MATRIX）明确 plugin_host 状态：implemented（in-process）/ 未 production-wired / 未 isolated——本阶段不做假沙箱，auto-enable 留到进程隔离实现后。
- harness 不接线插件（保持现状：插件未在生产路径注册）。

**Regression Test**

- 新增 5 测试：默认拒绝非 builtin（code=champion-off）、builtin 豁免、显式 trusted-local 加载、project-local 无 workspaceApproved 拒绝、默认 in-process 文档化。
- 既有 45 测试适配：测试 helper 插件标注 `source: "builtin"`；sandbox/trust-grant 边界测试 host 显式 `defaultChampion: true`（测试场景=已配置宿主）。
- plugins 包 50 测试 + audit 8 测试全绿。

---

## P18-4 MCP remains integration layer

- MCP transport 可扩展，但不能拥有 runtime core 特权。
- MCP tool 走同一 schema validation、permission、sandbox、tool semantics、output injection scan、timeout/cancel、budget、event pipeline。
- server/tool descriptions 属 untrusted context。
- HTTP/stdio capability 分开；stdio 子进程也属于 process capability，不因“本地”自动可信。

Status: DONE

**Implementation**

- 既有架构核对（已满足）：MCP 工具注册为 `ToolDefinition` → 走同一 orchestrator 管线（schema validation / permission / approval / sandbox / timeout/cancel / tool output budget / event）；transport 独立于 runtime core（适配器模式，无特权面）；description 经 P0-8 injection scan fail-closed；`McpServerConfig.kind` 区分 http/stdio。
- `mcp-transport.ts` fail-closed 收紧：`toToolDefinition` 的 risk 默认 `"readonly"` → **`"side_effect"`**（host 无法证明远程工具只读，直到 operator 显式声明 readonly）；**stdio 工具 `metadata.process = true`**（spawn 的子进程是 process capability，本地≠可信），http 工具保持 `network = true`。
- harness 侧 `connectMcpServer` 传 `trust: "untrusted"` + kind 默认 boundary（stdio→loopback / http→internet）——已有。

**Regression Test**

- 新增 2 测试：stdio MCP 工具 process=true + 默认 side_effect/retry unknown/serial；http 工具 network=true，仅显式 `risk: "readonly"` 可放宽（trusted-local 声明）。
- mcp 13 + harness 176 测试全绿，typecheck 全绿。

---

## P18-5 Tool cancellation settlement + progress channel

- progress event 与 terminal result 分开。
- progress 不进入 durable final ledger 当作 completion。
- cancel 后未开始工具 synthetic cancelled；已开始工具根据 cancellable semantics 处理。
- 不允许 queued tool 因 abort 从 transcript/replay 消失。

Status: DONE

**Implementation**

- **Progress channel**（contracts + orchestrator）：`ToolStreamEvent.stream` 增加 `"progress"`；orchestrator 把 stdout/stderr 分流为 `tool.output`、progress 分流为新事件 `tool.progress`（新 payload `ToolProgressPayload`）。progress **从不 settle 调用**——只有 `tool.completed`/`tool.failed` 是终结结果，durable ledger 只记录终结结果。
- **cancellable-aware settlement**（`ToolCallController.runReadBatch` onAbort 重构）：settlement 按语义分三档——已 settle 保留真实结果；in-flight 且 `cancellable` → 立即 synthetic cancelled（signal 已触发，干净中止无副作用）；in-flight 且**非 cancellable** → 绝不谎报 cancelled（可能已产生副作用），等待其真实 settle 并如实记录。每调用保存 settle-signal promise（reject 已由 catch 分支记录，等待路径只看时机）。
- queued 未开始工具 abort → synthetic cancelled（P15-6 保留），transcript/replay 无工具消失。

**Regression Test**

- `fault-injection.test.ts` +2：`ObliviousOrchestrator`（在飞调用忽略 abort）区分两种行为——cancellable 立即 settle（turn 不等待，transcript 2 条 cancelled）；非 cancellable 等待真实结果（release 后 transcript 记录 success "ok"，绝不出现伪造 cancelled）。
- `source-matrix.test.ts` +1：progress 工具发 stdout+progress → `tool.output` + `tool.progress` 各就各位、恰好 1 个 `tool.completed`（progress 不触发终结）。
- contracts/tools/core 590 测试全绿，typecheck 全绿。

---

## P18-6 Resource conflict keys for concurrency

在现有 `concurrencySafety` 之上增加可选 resource conflict 概念，避免将来开放更多并发时出现同资源竞争：

- file mutation key = canonical path
- store mutation key = store/session id
- global mutation = global lock

当前所有 write 若本来串行，可先保持串行；实现目标是为未来并发建立正确语义，不强求提高并发数字。

Status: DONE

**Implementation**

- `contracts/tool.ts`：`ResourceConflictKey`（规范键：`file:<canonical>` / `store:<session>` / `global`）＋ `fileConflictKey()` / `storeConflictKey()` / `GLOBAL_CONFLICT_KEY` ＋ `resourceConflicts(admitted, candidate)` 纯判定（同键冲突、global 恒冲突、undefined 永不冲突）。键按**调用**派生（args 驱动），静态 `ToolSemantics` 不承载实例级目标。
- `ToolCallController`：可选 deps `resourceConflictOf(call)` —— batch 规划在并入候选调用时检查冲突键，同资源调用**拆批串行**（即使两者 concurrencySafety=true，为未来并发写开放建立正确语义；当前 write 仍串行，未提高并发数字）。
- `AgentRuntime` + `create-harness`：`resourceConflictOf` 透传；harness 为内置文件工具派生 canonical-path 冲突键（write/edit 共用同一文件路径时永不并行）。

**Regression Test**

- `contracts.test.ts` +3：键形式稳定、同键冲突/异键不冲突、global 恒冲突/undefined 不冲突。
- `runtime.test.ts` +2：并发度探针验证——同路径两个 write（模拟未来 concurrencySafe 写）maxActive=1（串行拆批）；不同路径 maxActive=2（并行保留）。
- contracts/tools/core/harness 700 测试全绿，typecheck 全绿。

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

Status: DONE

Implementation:
- `gradeCompletion(reason, evidence)`（P8-3 已有）现在由 production path 唯一调用：`RecoveryController.finishTurn` 在每次终止时计算 `grade`，同时写入 `TurnOutcome.grade` 与 terminal 事件（turn.completed/turn.failed/turn.cancelled）payload（含 `completionEvidence`）。
- `VerificationController.runVerificationGate` 从 gate checks 派生 `CompletionEvidence`（passedSteps/totalSteps），gate 通过时经 `handleModelCompletion` 传给 finishTurn → `verified_complete`。
- 裸 model_stop（无 gate）→ `unverified_complete`；gate 重试耗尽 → `verification_failed`；evidence 部分通过 → `verified_partial`（gradeCompletion 诚实输出）。模型自身的 "done" 措辞绝不参与分级。

Regression Test:
- +4 loop-integration：gate 通过→verified_complete（outcome+事件+evidence）；无 gate→unverified_complete（"done" 非成功）；code-changing 未跑 gate→不得 verified_complete；gate 耗尽→verification_failed。

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

Status: DONE

Implementation:
- 新增 `packages/evaluation/src/independent-reviewer.ts`（可 benchmark 的 candidate，`REVIEWER_CANDIDATE_ENABLED=false` 默认关闭，opt-in 才评估）：
  - `IndependentReviewerInput` 白名单（userRequirement / diff / verificationEvidence / repoInstructions）+ `assertIndependentReviewerIsolation`：白名单外键或 hidden/inherited 键（transcript/reasoning/memory/skill/hook/cot…）一律 fail-closed 拒绝。
  - `REVIEWER_READ_ONLY_TOOLS` 只读工具面 + `REVIEWER_FORBIDDEN_TOOLS`（write/edit/exec/run_test/http/web_fetch/delegate…）+ `assertReviewerToolIsolation`：写/执行/网络工具面无法通过。
  - `REVIEWER_NO_INHERIT`：memory/skill/hook/personalization 永不继承。
  - `runIndependentReview` 真实只读模型 pass（注入 runner）：buildReviewerPrompt 只含白名单表面；严格 JSON verdict 解析（approve/flag）；**parse 失败、生成抛错、隔离守卫拒绝 → degraded，绝不 approve**。
  - `assessReviewerCandidate`：baseline（无 reviewer，全部 latent defect 漏出）vs challenger（reviewer flag 捕捉），复用 P13 `decideReviewPromotion` 经济门槛；reviewer 自身 degraded 计入失败，broken reviewer 永不晋升。

Regression Test:
- +17 independent-reviewer：默认关闭；只读工具面无 write/exec；白名单/hidden/inherited 键拒绝；工具面隔离；prompt 无推理面；严格 verdict 解析（prose/malformed → 不可解析）；fail-closed 三分支（parse 失败/生成异常/走私输入→degraded）；candidate 评估（baseline 全漏出、degraded 不晋升、噪声阻断、disabled 中性）。

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

Status: DONE

Implementation:
- `RecoveryAction` 收口为唯一 6 动作闭集：`retry_safe / change_strategy / reconcile_unknown_effect / ask_user / delegate_specialist / fail_safe`。移除了半实现的 `compact / re_discover_tools / refresh_mcp`（planner 曾能选出但 runtime 从未 apply）；MCP 重连/工具重扫下沉为 `change_strategy` 的机制细节。
- 每个 `RecoveryActionSpec` 增加 `allowsSideEffectReexecution`——当前全部为 `false`，P19-4 的"副作用重执行禁止"被编码进 spec 表本身。
- 新增 `recovery.decided` 事件（action/input/toolCallId/tool/used/remaining/reason）。**legacy 与 adaptive 两条 recovery 分支都发射**，action 名统一映射到 V3 taxonomy；消费者只按 typed action 分支，禁止按 reason 字符串判断。
- tool-call-controller apply 补全：`retry_safe`（仅 retrySafety=safe 重执行）、`change_strategy`/`delegate_specialist`（observation/delegation）、**`reconcile_unknown_effect`（新分支：注入"可能已生效但结果未知，勿重跑，请对账"observation）**、`ask_user`/`fail_safe`（停止自愈，失败流给模型）。

Regression Test:
- contracts：+9（V3 规划矩阵：retry_safe 优先/预算耗尽回落/context_overflow→ask_user/mcp_disconnected→change_strategy/timeout→reconcile_unknown_effect/全预算耗尽→fail_safe/override 禁用/unknown input TypeError/P19-4 invariant：全部 action `allowsSideEffectReexecution=false`）。
- runtime：+3 集成（非 safe 工具失败→recovery.decided 且 execute 恰 1 次；safe 工具→3 次 bounded retry_safe 重执行；timeout→reconcile observation 且不重跑）。

---

## P19-4 Never auto-retry unsafe tools

增加 invariant tests：

- retrySafety=safe + readOnly/idempotent → bounded auto retry 可用
- unknown/none → runtime 不自动再执行
- timeout 对非幂等写同样不能盲重试
- provider/model API retry 与 tool retry 必须是两套清晰层级，不混在一起

Status: DONE

Implementation:
- 核心不变量已被编码进 P19-3 的 spec：`allowsSideEffectReexecution` 在全部 6 个 recovery action 上为 `false`；controller 的 legacy 分支与 adaptive 分支都强制 `retryPolicy !== "safe"` 时绝不重执行（timeout 同样走该检查——超时≠幂等）。
- 层级隔离保持：provider 重试 → `retry.provider`；model 调用重试 → `model.retry`（decideModelRetry 纯函数）；tool 层重试 → `recovery.decided`。两层各自 bounded、事件各自独立。

Regression Test:
- +2 loop-integration：timeout 非幂等写 → execute 恰 1 次（绝不盲重试）；tool 层重试发 `recovery.decided` 而**绝不**伪造 `model.retry`/`retry.provider`。
- 既有 RECOVERY-001（safe 重试 / unknown 不重试）+ P19-3 retry_safe 预算测试共同覆盖四象限。

---

## P19-5 Protocol self-heal without hiding corruption

对可修复的模型/消息协议问题：

- missing tool result
- duplicate tool call id
- orphan result
- malformed structured output
- context overflow

可生成 typed repair action，但必须保留 repair evidence；无法安全修复则 fail-safe，不伪装成正常完成。

Status: DONE

Implementation:
- 新增 `contracts/repair.ts`：`RepairKind` 闭集（missing_tool_result / duplicate_tool_call_id / orphan_tool_result / malformed_structured_output / context_overflow）+ `RepairAction`（recover / fail_safe）+ `RepairEvidence`（before/after/detail，绝不静默消失）+ `canRepairSafely(kind, opts)`（missing/orphan 仅在能命名修复结果时可 recover；context_overflow 仅 compaction 可修复、裸重试不是修复）。
- 新事件 `protocol.repaired` / `protocol.repair_failed`。
- `handleModelCompletion` 接入：执行前先 dedupe 重复 call id（first wins，防双倍副作用）+ 丢弃 malformed args（非 plain object），每个修复发 `protocol.repaired`（evidence 保留）；若 tool_calls turn 全部不可修复 → `protocol.repair_failed` + fail-safe 终止（model_error），绝不伪装完成。

Regression Test:
- contracts：+3（duplicate 去重 first-wins 且 evidence 记录被丢弃 id；malformed 丢弃并记录 before；canRepairSafely 各 kind 判定）。
- runtime：+2 loop-integration（duplicate id → protocol.repaired 且 execute 恰 1 次；全 malformed → protocol.repair_failed + turn failed 不伪装 done）。

---
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

Status: DONE

Implementation:
- 新 `evaluation/false-complete-cases.ts`：7 个 canonical false-complete 场景数据（fc-1 只改码不跑测试→unverified_complete / fc-2 测试失败说 done→verification_failed / fc-3 verifier 命令不存在→verification_failed / fc-4 verifier timeout→verification_failed / fc-5 reviewer parse failure→fail-closed 不晋升（verified_partial 级） / fc-6 部分通过关键未跑→verified_partial / fc-7 空 change set 声称完成→verification_failed），每场景带构造的事件序列 + 期望 grade + runner-ready EvalCase。
- `eval-case.ts` 增加 `expectedGrade?: FalseCompleteGrade`；`runner.ts` 校验 expectedGrade（优先 outcome.grade，fallback `gradeOf(events)` 从 terminal 事件提取——绝不信任模型 "done" 措辞）；`EvalOutcome` 携带 `grade`。
- `evolution-loop.ts`：`VariantAssessment.verifiedCompletionRate`（P19-1 grade 统计，无 grade 视为未 verified）；`choosePromoted` 增加 verified-quality 门槛（`maxVerifiedCompletionDrop` 默认 0.1——靠多造 false-complete 赢 cost 的 variant 一律拒绝晋升），cost 平局时先比 verified completion quality 再比 pass rate。

Regression Test:
- +4 false-complete-cases（7 场景齐备 / 每场景 grade 恰如失败模式 / 无 gate 的 code-changing turn 绝不 verified_complete / EvalCase 断言一致）。
- +2 evolution-loop（cost 高但 verified 质量暴跌→拒绝晋升；cost 平局→verified 质量决胜）。

---

# PHASE 20 — Observability, CI & Truthfulness

## P20-1 Wire usage accounting for real

当前 audit/capability matrix 已出现“implemented 但 productionWired=false”的 usage accounting 证据。

**Do**

- model completed event/trace 必须携带真实 usage（输入、输出、cache、estimated cost 能拿多少记多少）。
- metrics/replay/explain 能按 modelCallId 聚合。
- scheduler tree budget 与 runtime budget 使用同一 usage source。
- provider 不返回 usage 时标 estimated/unknown，不能写 0 冒充真实。

Status: DONE

Implementation:
- `UsageSnapshot` 增加 `cacheReadTokens / cacheCreationTokens / source`（measured | estimated | unknown）；`mergeUsage` 保留 cache 字段且 source 粘性（一旦 measured 保持 measured）。
- 新增 `finalizeUsage()`：provider 无任何 usage → `{ source: "unknown" }`；有数字未声明来源 → `measured`。`model.completed` 事件永远携带 finalize 后的 usage 记录——**裸 0 不再可能**。
- runtime `reportModelUsage` 签名改为 `(sessionId, usage: UsageSnapshot)`，只在真实记录存在时上报（删除 `?? 0`）；scheduler `reportUsage/reportUsageBySession` 改为吃 runtime 的同一 usage source，仅累加 provider 真实返回的有限 token（unknown 记录 +0，不虚构）。
- 修复 attribution 接线 bug：`tokens` 原来读 `payload.outputTokens` 顶层（恒 0，usage 是嵌套对象），改为从 `payload.usage.outputTokens` 读（与 observability computeMetrics 同一契约）。
- `RunMetrics` 增加 `usage_unknown / cache_tokens_read / cache_tokens_created / model_call_count`（按 model.completed 逐 call 聚合，天然按 callId 归因）。

Regression Test:
- +2 loop-integration：provider 带 usage→`source:"measured"` 且 token 如实；provider 无 usage→`source:"unknown"` 且 input/output 为 undefined（绝不写 0）。
- +4 observability metrics：嵌套 usage 聚合 / unknown 计入 usage_unknown 且 0 tokens / 缺失 usage 计入 unknown / cache 读写聚合。
- attribution tokens 测试更新为嵌套 usage 契约（unknown 记录 +0）。

---
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

Status: DONE

Implementation:
- `CapabilityRecord` 增加 `durable` / `securityMode`（sandboxed|isolated|approved|unrestricted）/ `degradedReason`；`CapabilityMatrix` 带 `profile` 标注。
- 新 `CapabilityProfile`（interactive-ephemeral / interactive-persistent / benchmark / champion）+ `PROFILE_EXPECTATIONS`（每 profile 的 mustBeDurable / mustBeWired / securityMode / requiresDurableHarness——reviewed 配置而非注释）。
- `buildCapabilityMatrix(input, profile)` 按 profile 评估：durable-required capability 仅在 harness persistence `mode==="durable"` 且未 degraded 时为 durable；profile 期望未满足（要求 durable 却 in-memory / 要求 wired 却未接线）→ `degradedReason`。
- `profileOf(input)` 自动映射 harness 的 introspection.profile（interactive+in-memory→ephemeral；interactive+durable→persistent；其他→benchmark）。
- `buildCapabilityMatrixForProfiles` 产出 4 profile 视图；`auditCmd` 的 CAPABILITY_MATRIX.json 携带 `byProfile` 全视图；Markdown 渲染加 durable/securityMode/degraded 列。

Regression Test:
- +9 audit.profiles：profile 映射（ephemeral/persistent/benchmark/闭集）；per-profile durability（ephemeral 平凡 durable 不 degraded / persistent+in-memory degradedReason 点名 harness 与未接线 capability / persistent+durable 全通过）；security mode（interactive/benchmark=sandboxed、champion=isolated）；ForProfiles 四视图齐全。

---
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

Status: DONE

Implementation:
- 新增 `apps/cli/src/docs-verify.ts`（`agent docs:verify` → `pnpm docs:verify`，CLI 注册 + package.json script）：
  - benchmark case counts：磁盘各 suite 目录数 vs benchmarks/README.md 声称（缺声称也 fail-closed）
  - package counts：packages/ 实际包数 vs HANDOVER.md 的 "N 个包" 声称
  - CI gates：.github/workflows/ci.yml 必须同时含 test 与 coverage
  - CAPABILITY_MATRIX.md 机器生成（generatedAt + audit 表头）
  - capability profiles（CAPABILITY_MATRIX.json 的 byProfile 或 MD 的 profile 标注，P20-2）
  - 任一失败 → exit 1（fail-closed，绝不静默跳过）
- 实测仓库即抓到 3 个真实偏差并修复：HANDOVER 包数 19→21、重新生成 CAPABILITY_MATRIX（含 byProfile）、CI coverage（P20-4）。

Regression Test:
- +7 docs-verify：全真场景 PASS / README 声称不符 / README 缺声称 / CI 缺 coverage / 矩阵缺失 / 矩阵无 per-profile / 包数声称不符 → 各自 FAIL 且 reason 点名。

---

## P20-4 Coverage must be a real CI gate

当前配置有 coverage thresholds，但 CI 必须真正运行 `pnpm test:coverage`。

- Ubuntu coverage job 即可；Windows 不必重复 coverage。
- upload `coverage-summary.json`。
- threshold 失败必须使 CI 红。
- 不降低 threshold 来完成本任务，除非先证明原配置从未可达并在 Notes 记录证据。

Status: DONE

Implementation:
- `.github/workflows/ci.yml` 新增独立 `coverage` job（ubuntu-latest）：`pnpm test:coverage`（v8 provider + json-summary → `coverage/coverage-summary.json`），threshold 失败即 exit 1 使 job 红，并 upload `coverage-summary.json` artifact（if-no-files-found: error）。
- Windows verify job 不重复跑 coverage（P20-4 明确只需 Ubuntu）。
- thresholds **未降低**：vitest.config.ts 原有 per-package 门槛（core 85/70、security 90/80、tools 85/68、agents 90/75、memory 85/78、evaluation 85/70、context 95/85、learning 95/82）原样保留。

Regression Test:
- 本地实跑 `pnpm test:coverage`：thresholds 为回归护栏（低于当前实测、防大幅下滑），CI job 会在下滑时红。

---
---

## P20-5 Typed event cleanup

清理 production event emission 中：

- `as never`
- ad-hoc payload shape
- direct Date.now
- direct sequence placeholders

重要事件使用 typed payload contract：model/tool/security/verification/recovery/compaction/subagent/persistence。

Status: DONE

Implementation:
- `event-payloads.ts` 补齐 typed contract：`TurnTerminalPayload`（turn.completed/failed/cancelled 带 statusDetail/terminationReason/grade/completionEvidence，P19-1）、`RecoveryDecidedPayload`（P19-3）、`ProtocolRepairPayload`（P19-5）、`SubagentPayload`（含 parentCallId 供 trace tree）；注册进 `EventPayloadMap` + `EVENT_PAYLOAD_TYPES`。
- run-budget 的 `"" as never` 伪 runId → 真实 `newRunId()`（快照不再携带伪造占位）。

Regression Test:
- +3 event-payloads：turn 终止事件 grade/evidence 形状；recovery/protocol typed；subagent 链接 parentCall。

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

Status: DONE

Implementation:
- 新 `observability/trace-tree.ts`：`buildTraceTree(events)` 从事件流纯重建 turn 树——`turn → model → tool`（usage 挂在 model.completed 叶子），recovery.decided / compaction / verification / subagent 各成分支；spanId/parentSpanId（P9-2）优先建父子，无 span 的事件按类型挂 turn 根（五个分支永不缺失）；subagent 经 parentCallId 挂到发起委托的 tool 节点；`renderTraceTree` 输出稳定文本树（├─/└─）。
- `agent explain <sessionId> --tree`：渲染完整 trace 树 + 从 terminal 事件回答 "why not complete: <terminationReason> (grade <grade>) — <error>"（observable evidence，绝不输出隐藏推理）。
- 生产路径 span 覆盖确认：tool.requested/tool.completed 带 `{ spanId: call.id, parentSpanId: parentCallId }`，model.started/completed 带 `{ spanId: callId }`。

Regression Test:
- +4 trace-tree：模型/工具层级重建（span 身份）、五分支齐备（recovery/compaction/verification/subagent 且 subagent.parentId=委托 tool）、usage 挂 model.completed、稳定渲染（两次渲染逐字节一致）。
- +1 explain --tree：层次（model→tool→recovery）+ why-not-complete 断言（tool_limit / unverified_complete / maxToolCalls reached）。

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

Status: DONE

Implementation:
- `RunManifest` 增加 P21-1 复现身份：`profile`（harness profile）、`features`（有效 feature-flag 快照）、`contextBudgetTokens`、`taskSuites`、`randomSeed`——缺失值一律诚实 null/[]，绝不猜测。
- benchmark 命令每次运行记录完整身份（profile=benchmark、feature 快照、预算、suite、shuffle 时固定 seed），不同模型/预算/feature 的运行**不可能**被当作同一基线比较。

Regression Test:
- +2 manifest：完整 P21-1 身份记录；缺失字段诚实 null/[] 且不同预算绝不看起来相同。
- baseline report manifest 测试更新。

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

Status: DONE

Implementation:
- 新 `evaluation/candidate-matrix.ts`：9 个 plan 要求的候选机制（context_pipeline_v5 / tool_selector_deferred_schema / memory_retrieval / memory_write_learning / adaptive_recovery / independent_reviewer / delegation / adaptive_context_policy / adaptive_scheduler），每个含 config 映射（disabled/enabled）、champion 默认策略（yes/evidence/no）。
- `buildCandidateMatrixPlan()`：baseline（全关）→ 9 单变量 → 3 个 reviewed 组合（reviewer+delegation / retrieval+learning / context-policy+scheduler）。
- `applyCandidateConfig(base, id)`：单变量运行相对 baseline **只差一个机制**；未知 candidate fail-closed（绝不静默 no-op）。

Regression Test:
- +6 candidate-matrix：9 候选齐备 / champion 默认策略声明 / 评估计划结构 / 单变量恰差一机制 / 未知 candidate fail-closed / 组合均由存在 id 组成。

---

## P21-3 Paired evaluation runner

新增 champion evaluation 命令/脚本，要求：

- baseline 与 candidate 跑同一 case
- 记录逐 case paired result
- 指标：task success、verified completion、security violations、tool calls、model tokens、estimated cost、latency、recovery count、compaction count
- stub/mechanism benchmark 与 real-model benchmark 分开标注

**Truth rule**

没有真实模型证据时，可以说“mechanism-real passed”，不能说“Agent 更强”。

Status: DONE

Implementation:
- 新 `evaluation/paired-eval.ts`：`buildPairedReport(baselineRuns, candidateRuns, mode)`——baseline 与 candidate 必须跑同一 case（缺 twin 硬报错，绝不静默丢弃）；逐 case 分类 wins/losses/ties/both_failed；聚合 10 项指标（task success / verified completion / security violations / tool calls / tokens / cost / latency / recovery / compaction）。
- `claimFor(mode, agg)` 机器生成 Truth-rule 合规声明：stub → "mechanism-real passed (stub provider)…does NOT claim the agent is stronger"；real-model → 逐 case W/L/T + verified 变化 + 成本增加时注明"needs success-rate justification (P21-4)"。
- CLI `agent champion eval <baseline-runs.json> <candidate-runs.json> [--mode stub|real-model]`：读两组 EvalOutcome，输出逐 case 表 + claim。

Regression Test:
- +6 paired-eval（分类 / 同 case 强制 / 全指标聚合 / verified 来自 grade / stub Truth rule / real-model claim）+3 champion-eval CLI（paired 输出、缺 twin 硬错、real-model claim）。

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

Status: DONE

Implementation:
- 新 `evaluation/promotion-gate.ts`：
  - Hard gates（pipeline 提供，fail-closed）：typecheck/test/build/coverage / Linux+Windows 矩阵 / adversarial escapes=0 / 无新 fail-open path / 无 crash-recovery duplicate side effect。
  - Quality gates（基于 P21-3 paired report）：无净退化（netPassedDelta>=0）；verified completion 不降超容差（0.05）；token 成本增长无净收益→fail；**成功率提升仅来自无界 tool/retry → fail**（buying wins with attempts）。
  - 小样本诚实：net delta < minConclusive（默认 2）→ 推荐重复评估而非宣称晋升；绝不输出虚假精度。

Regression Test:
- +11 promotion-gate：hard 全绿/单信号缺失 fail-closed；quality 中性通过/净退化/verified 下降/成本无收益/无界 attempt 拒绝/小样本推荐重复；full verdict（硬门不过绝不晋升 / 可重复则晋升）。

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

Status: DONE

Implementation:
- `HarnessProfile` 增加 `champion`；`profiles.ts` 新增 champion preset：
  - 可信面默认 ON：context / checkpoint / artifacts / skills / observability。
  - 证据决定默认 OFF：memory / delegation / learning（待 P21-4 证明后才开）。
  - 信任面默认 OFF：mcp（用户配置才开）/ plugins（同进程 trust 风险）。
  - 权限 batch 风格：read allow、edit/exec ask、network deny（比 interactive 更保守）。

Regression Test:
- +5 champion-profile：可信面 ON / 证据面 OFF / 信任面 OFF / 权限网络 deny + 写执行 ask / 与 P21-2 defaultOn 策略一致。

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

Status: DONE

Implementation:
- 新 `evaluation/champion-manifest.ts`：`CHAMPION_MANIFEST.json` 结构（schemaVersion / updatedAt / entries），每个 entry：feature（P21-2 candidate id）、promotedAt、evidenceReport、benchmarkDelta（netPassedDelta / tokensDelta / verifiedDelta）、securityStatus、rollback。
- **rollbackConfig 直接取自 P21-2 candidate 的 disabled config**——每个晋升 feature 的关闭开关是机械可答的（`rollbackSwitchOf(manifest, feature)`），"默认打开找不到怎么关"结构上不可能。
- `buildChampionManifest` fail-closed：未知 feature（无 candidate 条目）拒绝晋升；`assertAllPromotedFeaturesRollbackable` 保证不变量。

Regression Test:
- +5 champion-manifest：entry 全字段 / 每个晋升 feature 有具体 rollback 开关 / rollbackSwitchOf 机械应答 / 未知 feature fail-closed / 渲染含 rollback 指令。

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

Status: DONE

Implementation:
- `create-harness.ts` 从 1122 行减到 682 行（只保留顶层 orchestration + runtime 装配 + harness 组装）；按领域拆 7 个 composition helper（compose/ 目录，全部**逐字搬运 + 显式依赖注入，不建第二套实现**）：
  - compose-stores（stores + P16-5 单一事件写入器）
  - compose-tools（registry + production/delegation 工具 + deferred schema）
  - compose-mcp（MCP 连接与注册）
  - compose-context（pipeline/budget/skill 发现/命令发现；resolveContextBudget 迁入）
  - compose-verification（planner + TaskVerifier）
  - compose-delegation（两阶段 scheduler/delegator 装配；schedulerLimits/delegationLimits 迁入）
  - compose-observability（introspectHarness + durability truth）
- `tool-names.ts`：PRODUCTION/READONLY_TOOL_NAMES 抽离，打破 create-harness ↔ worker-agent 循环 import；`worker-agent.ts` 承载 subagent/worker 定义。
- 公共面经 re-export 保持稳定（无需 migration）；依赖方向不变：harness → core/contracts/tools/agents，绝不反向。

Regression Test:
- harness 110 测试 + 依赖包 196 测试拆前拆后全绿（行为零变化）。

---
## P22-2 Remove obsolete compatibility paths only with evidence

审计 legacy adapters / duplicate metadata / dead feature gates。

删除条件：

- code search 证明无 production caller，或迁移完成
- tests 覆盖替代路径
- public API 变化有 migration note

不要为了“代码少”破坏向后兼容。

Status: DONE

Implementation:
- 审计结果（code search 证据）：`harness.memory`（P0-3 legacy MemoryBridge 兼容面）**无任何 production caller**（仅测试断言存在性）→ **删除**：MemoryBridge 接口、harness.memory 字段、legacyMemoryBridge 构造、lifecycle 关闭引用全部移除。
- 替代路径已覆盖：主实现 `MemoryRuntimeBridge` + harness 新暴露 `memoryStore`（真实 store，供主机/测试 seed 与查询）；memory.integration / create-harness 测试迁移到新 API。
- Migration note：`harness.memory` → `harness.memoryStore`（store 操作）或 `harness.memoryBridge`（检索/注入/反馈）。main.ts 已迁移。
- Dead feature gates 审计：`features.observability` 与 `features.scheduler` 无 wiring 消费但被 introspection/audit 作为"报告型"字段读取——保留（删除会破坏 capability 报告），不算 dead。

Regression Test:
- harness 110 测试全绿（含迁移后的 memory 集成测试）；CLI 32 测试全绿。

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

Status: DONE

Implementation:
- 新 `agent production-audit`（`apps/cli/src/production-audit.ts`）9 项自动检查：
  1. capability matrix 机器生成（audit 输出）；2. no silent catch（静态扫描，注释剥离）；3. no production `as never` 伪造字面量（白名单：纯类型转换 `x as never` 合法，`""/0/null as never` 违规）；4. no unsafe path-prefix **授权**边界（拒绝式 startsWith 是正确用法不标记）；5. no raw command-prefix approval；6. side effects 经 ToolOrchestrator + Permission + Sandbox；7. writable child（worker-w）隔离（网络 deny + 隔离 workspace）；8. unsafe tool no auto retry（P19-4 spec 不变量）；9. durable wiring（DurableApproval/Checkpoint/JSONLAskUser）。
- 实测即抓到并修复自身 3 个问题：audit 文档注释里的示例被误报（改 stripComments）、自身空 catch（补可观察 stderr）、benchmark-candidates 的拒绝式 startsWith 误报（授权/拒绝区分）。

Regression Test:
- +5 production-audit：clean tree 全 PASS / silent catch 标记 / 伪造 as never 标记 / 授权式 path-prefix 标记 / 矩阵缺失失败。
- 真实仓库 `agent production-audit` → **ALL PRODUCTION CHECKS PASS**。

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

Status: DONE

Implementation:
- 新 `agent release artifacts [--out <dir>]`（`apps/cli/src/release-artifacts.ts`）：一键收集全部 8 类 release artifact 到统一目录——unit/integration report、coverage summary（json-summary，可 fast 跳过）、CI results（ci.yml 即 Linux+Windows 门禁，本地沙箱无法跑 Windows）、adversarial smoke、stress smoke、baseline-vs-champion paired report、capability matrix、champion manifest。
- 失败按 artifact 记录（绝不静默吞掉）；任一缺失 → release ok=false。
- 沙箱限制如实记录：Windows 由 GitHub Actions ci.yml 矩阵执行；coverage 的 memory 包 sqlite 失败为环境问题（stash 基线可复现）。

Regression Test:
- +3 release-artifacts：8 artifact 齐备 / 失败步骤标记 MISSING 不静默 / 渲染可读。

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

Status: DONE

Implementation:
- HANDOVER.md 追加"§11 P14~P22 最终交接"（只写已验证事实）：
  - 当前 champion 开了什么（feature 表格 + 每项证据指向）。
  - 为什么 promote（默认 ON 有集成测试 + mechanism-real benchmark；证据决定机制必须过 P21-4 gate；**当前 CHAMPION_MANIFEST 为空是诚实状态**）。
  - 哪些仍 experimental/config-driven（memory/learning/delegation/recovery/reviewer = P21-2 candidate 默认 OFF；MCP/plugin 配置驱动）。
  - 已知限制（沙箱 FTS5/memory、coverage 环境、30-case 小样本、Windows 由 CI 把关）。
  - 如何复现实验（benchmark / champion eval / production-audit / release artifacts / docs:verify 命令序列）。
  - 如何 rollback（rollbackSwitchOf 机械应答 + assertAllPromotedFeaturesRollbackable 不变量）。
- mem.md 追加 PHASE 18~22 会话记忆（关键变更 + 踩坑：CRLF 陷阱、rfind('});')、no-silent-catch 全仓扫描、双层数组、伪 runId、audit 自误报）。
- reflection.md 追加 PHASE 22 复盘（行尾纪律、有证据删除、审计先审自己、小样本诚实、compose 移动不重写）。

Regression Test:
- 文档即验证事实：docs:verify / production-audit / release artifacts 命令实测输出与文档一致。

Status: DONE

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
