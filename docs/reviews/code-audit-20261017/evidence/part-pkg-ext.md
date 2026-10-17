# 外围能力包审查报告（part-pkg-ext）

- 审查人：ext-reviewer（Lead 派出）
- 仓库：`D:\Download games\harness agent`，HEAD=`44f3f51f`，`git status --porcelain` 为空（审查全程未修改任何被跟踪文件）
- 范围：`packages/evaluation`、`model`、`memory`、`mcp`、`context`、`agents`、`protocol`、`skills`、`gateway`、`orchestration`、`learning`、`observability`、`sdk`、`plugins`
- 规模：上述包共 493 个跟踪文件，其中非测试源文件 212 个（evaluation 98 + 其余 13 包 114），非测试源码约 63.6k 行
- ID 前缀：`EXT-`

## 0. 结论摘要

- 未发现 P0。P1 两条：`gateway` 的 stdio 传输 `close()` 不 reject 在途请求（调用方永久挂起）、`evaluation` 证据链自带的 `redactSecrets` 是 `@ar/security` 的弱子集却直接把日志写盘（脱敏覆盖缺口 8 类）。
- 外围包的工程质量整体高于预期：`model`/`mcp`/`gateway` 的取消、超时、结构化错误分类、有界队列、幂等表都做到了；`plugins` 对"同进程插件=任意代码执行面"有明确的 fail-closed 默认（`defaultChampion` 默认关）。
- 最集中的结构性问题在 `evaluation`：98 个非测试源文件里 92 个平铺在 `src/` 根目录、单个文件 2627 行；跨包重复实现 9 处（`redactSecrets`/`stableStringify`/`computeScoreCard`/`RecoveryPolicy`/`CAPABILITY_DIMENSIONS` 等），目前只靠"重名会在编译期冲突"被动守着，没有主动收口。
- 两处"看起来是结果、其实是随机数"的实现值得单独盯：`evaluation/src/experiment-harness.ts` 的默认 benchmark 用 `Math.random()` 产出 `passRate/latency/tokens` 并标记 `status:"completed"`，`ExperimentReport` 里没有任何 simulated 标记。
- 被禁用的用例：0（`describe.skip`/`it.skip`/`it.only`/`describe.only`/`xit` 全仓 0 命中）。
- 无界增长：`memory` 有 30 天 stale 状态但**没有物理删除/归档**；`observability` 与 `gateway` 都有"一次调用把某会话全部事件读出来"的接口。

## 1. 发现总表

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
| --- | --- | --- | --- | --- | --- |
| EXT-001 | `packages/gateway/src/stdio-transport.ts:160-163` | `close()` 只做 `this.pending.clear()`，既不 resolve 也不 reject 在途请求；`pending` 存的是各请求的 resolve 函数，清空后对应 Promise 永不 settle → 等待方永久挂起（进程不退出/超时失效） | D | P1 | `clear()` 前遍历 `pending`，对每项 reject 一个 `TRANSPORT_CLOSED` 结构化错误；加一条"close 后 inFlight=0 且所有等待方都拿到 rejection"的单测 |
| EXT-002 | `packages/evaluation/src/gate-evidence-v2.ts:403-411`（写入点 `:521-530`） | 证据链自己实现了一份 `redactSecrets`，只覆盖 3 类模式（`*_API_KEY`/`sk-`/JWT），而 `packages/security/src/secret-gate.ts` 的 `SECRET_PATTERNS` 有 11 类，此处缺 8 类（aws-access-key、github-token、slack-token、stripe-key、google-api-key、private-key、bearer-token、db-credentials）；这段文本会被写进 `evidence/*.log` 并算 sha256 → 证据文件可能落盘未脱敏真实密钥 | D | P1 | 删除本地实现，改为 `import { redactSecrets } from "@ar/security"`（注意签名是 `{content,redacted}`，需 `?` 适配）；补一条用例：用 11 类样本各造一条，断言落盘日志里没有原始密钥 |
| EXT-003 | `packages/model/src/openai.ts:702-714`；`packages/mcp/src/stdio-client.ts:183-186` | 同一模式两处：按行解析的 `buffer += chunk` 没有任何长度上限。provider/stdio server 若长时间不吐换行（异常、巨型 JSON 行、二进制作死），缓冲无界增长 → 内存被打满且无超时能救（读循环仍在等换行） | D | P2 | 给两个缓冲都加 `MAX_LINE_BYTES`（如 8–16 MiB），超限即按"协议错误"终止并结构化上报；`model` 侧对齐已有的 `maxBuffer` 分类思路 |
| EXT-004 | `packages/learning/src/index.ts:66` | 两条 export 语句挤在同一行：`export type { SandboxViolationKind } from "./sandbox.js";export * from "./change.js";`（缺换行）。同文件其余部分是显式具名导出 + 注释分组，这一行破坏了风格一致性，也让 diff 噪声变大 | A | P3 | 补换行；顺手把该行改成显式具名导出，与同文件其它分组保持一致 |
| EXT-005 | `packages/evaluation/src/experiment-harness.ts:31-52`（经 `src/index.ts:8` 导出） | `defaultRunBenchmark` 在未注入 `runBenchmark` 时用 `Math.random()` 伪造 `passRate/latencyP50/latencyP95/tokens`，并置 `status:"completed"`；`ExperimentReport`（`packages/contracts/src/experiment.ts`）没有 `simulated` 字段，报告与真实跑测结果在数据上不可区分 → 一旦被写进 evidence/ledger/champion-state 就是伪造证据 | D | P2 | 默认实现改为 `throw new Error("runBenchmark dependency required")`，或强制在 `ExperimentReport` 上加 `simulated: true` 并让下游写入方拒绝 `simulated` 报告；目前生产调用点 0 个（仅 `experiment-harness.test.ts`/`cross-model.test.ts`），改动成本很低 |
| EXT-006 | `packages/plugins/src/plugin-host.ts:173-196` | `withTimeout` 的 rejection 分支（`:188-193`，注释自陈 "failure treated like a skipped plugin"）把**插件抛错**和**超时**归并成同一个 `TIMEOUT_SENTINEL`，上层只能当作"跳过"，错误内容、堆栈、累计失败计数全部丢失——正是该文件头部注释声称要修掉的 "swallowed failures silently" | D | P2 | 返回三态 `{kind:"ok"|"timeout"|"error", error?}`，error 分支走 `maxConsecutiveFailures` 计分并把 `errorInfo` 带进 `stats()` |
| EXT-007 | `packages/context/src/tokenizer.ts:16-19` | `HeuristicTokenEstimator.estimate(text)` 忽略签名里的 `model` 参数，恒定用 `Buffer.byteLength/4`：① 对中文（3 字节/字）严重低估（实际约 1–2 token/字，估计值约 0.75），本仓中文提示占比高，预算可能低估 ~2 倍 → 触发 provider 上下文超限；② `Buffer` 是 Node 专有，浏览器/edge 构建会直接 ReferenceError | D | P2 | 按 `ModelRef` 选系数（CJK 段用 `chars*1.6` 之类），或至少 `typeof Buffer === "undefined"` 时退化为 `TextEncoder`；加中文样本的估算用例 |
| EXT-008 | `packages/memory/src/sqlite-memory-store.ts`（全文 561 行仅 `:220` 一处 `DELETE`，且为 FTS 索引同步）；`packages/memory/src/lifecycle.ts:11,108-109` | 记忆库没有保留/淘汰/归档策略：`lifecycle` 只在 30 天未用时把条目**标记为 stale**（状态迁移），从不物理删除；`memories` 表与 `memories_fts` 索引随时间无界增长，检索延迟随之退化 | D | P2 | 增加 `prune({olderThan, keepTop, maxRows})`：先删 stale+低 usefulness，再按行数硬上限裁剪，`VACUUM` 交由显式维护命令；把返回值做成结构化统计以便观测 |
| EXT-009 | `packages/gateway/src/rpc.ts:321-324`（同类 `:179`）；`packages/observability/src/trace-exporter.ts:282,299` | `trace.get` 无分页、无上限，直接 `return deps.events.list(sessionId)` 返回整个会话的全部事件；`thread/list`（`:179`）对每个 session 再拉一次全部事件；导出器把全部事件一次性 `join` 成 `events.jsonl` 字符串。长会话下是 O(n) 内存 + 巨型线缆帧 | D | P2 | `trace.get` 增加 `{after, limit, maxBytes}`，默认截断并回 `nextCursor`；`thread/list` 改成只取元数据（或 `deps.sessionService.summaries()`），不要在列表路径里展开事件 |
| EXT-010 | `packages/observability/src/trace-exporter.ts:244` | `spawnSync("git", args, {timeout:3000})` 在导出路径上同步阻塞事件循环，单次最长 3s，同文件 `captureGitState` 一处调用可能需要多次 → 导出期间整个进程（含正在进行的模型流）卡住 | D | P2 | 换 `execFile` + Promise（本仓 `gate-evidence-v2.ts:123`、`benchmark-isolation.ts:255` 已有异步范式），或在导出前一次性取好 git 状态快照传入 |
| EXT-011 | `packages/evaluation/src/gate-evidence-v2.ts:403` / `packages/security/src/secret-gate.ts:52`；`packages/evaluation/src/manifest.ts:243` / `packages/learning/src/change.ts:77`；`packages/evaluation/src/harness-metrics.ts:1523` / `packages/learning/src/scorecard.ts:75`；`packages/evaluation/src/recovery-policy.ts:24,41` / `packages/core/src/recovery/recovery.ts:14,46`；`packages/evaluation/src/baseline.ts:743` / `packages/contracts/src/termination.ts:31`；`packages/evaluation/src/formal-invariants.ts:130-132` / `packages/contracts/src/capability.ts:31-33`；`packages/evaluation/src/evolution-loop.ts` / `packages/skills/src/skill-evolution.ts`；`packages/evaluation/src/artifact-validate.ts` / `packages/core/src/runtime/r87-zero-call-replay-ab.ts` | 同仓 9 组同名导出（全量比对结果：`evaluation` 1355 个导出符号 vs 其他包 1656 个，交集 11 个，扣除 2 个纯常量重名后 9 组属"两套实现"）。最危险的三组：`redactSecrets`（见 EXT-002，语义已确认不同）、`RecoveryPolicy/RecoveryDecision`（评测侧对恢复语义的建模与 `core` 的路由状态机是两份独立真相，行为一旦漂移，评测通过的候选在运行时可能不等价）、`computeScoreCard`（评分卡两份，评测分数与学习侧分数可能对不上） | C | P2 | 把可共享的收敛到 `@ar/contracts`（纯类型）与 `@ar/security`/`@ar/core`（实现），`evaluation` 只做引用；短期至少在 `evaluation` 侧加"同名导出必须来自上游包"的守护测试（`formal-invariants` 已有类似断言范式） |
| EXT-012 | `packages/evaluation/src/n3-tool-dispatch-journal.ts:182`；`packages/evaluation/src/paired-executor.ts:322,334`；`packages/evaluation/src/tool-call-efficiency-formal-run.ts:1524`；`packages/evaluation/src/tool-call-efficiency-paired-campaign.ts:269` | 同一套"临时文件 + fsync + rename 覆盖"的原子写被复制了 5 份，其中 `paired-executor.ts:334` 的注释还写着"Windows 上 rename 覆盖会失败，所以先删目标"（其余 4 份没有这个处理）→ 原子写语义在 5 处并不一致 | C | P2 | 抽 `evaluation/src/atomic-write.ts`，统一处理 Windows rename 语义 + `Math.random()` 临时名 + fsync；5 处改为调用 |
| EXT-013 | `packages/evaluation/src/n6-evidence-cases.regressions.test.ts`(351 行) 与 `n7-evidence-cases.regressions.test.ts`(411 行)；`context-safe-tool-call-efficiency-v2.regressions.test.ts`(227) 与 `verified-completion-gate.regressions.test.ts`(210)；`context-safe-tool-call-efficiency-v2-preregistration.test.ts`(532) 与 `verified-completion-gate-preregistration.test.ts`(475) | 实测 148 个测试文件、2249 条用例标题，其中 12 条标题跨文件重复，且几乎全部落在上面 3 对文件里（n6/n7 共享 8 条标题；v2/verified 共享 4 条）——两对套件是"同一个模板换个候选名"的拷贝，模板修一处漏一处会让两条候选线的门禁强度悄悄分叉 | C | P2 | 抽 `makeEvidenceCaseSuite(candidateId, cases)` 工厂，两对套件各自只传差异数据；标题里去掉重复的序号前缀，改为模板生成 |
| EXT-014 | `packages/evaluation/src/`（根目录 92 个非测试源文件、44,253 行；最大 `tool-call-efficiency-formal-run.ts` 2627 行，其次 `r97-plan.ts` 2140、`r97-budget-ledger.ts` 1775） | 扁平目录 + 超大单文件：`src/` 下 92 个文件没有任何子目录分组（只有 `artifact-v3/` 一处 6 文件），按 R92/R97/N6/N7/E4 等世代命名的模块混在一起，无法从路径判断归属 | A | P2 | 按世代/职能分目录（`r92/`、`r97/`、`evidence/`、`metrics/`、`prereg/`），并把 2600 行的 formal-run 拆成"状态机/预算/落盘/校验"四块；先做目录搬迁（纯移动 + 改 import），风险可控 |
| EXT-015 | `packages/evaluation/src/benchmark-isolation.ts:117` 与 `packages/tools/src/process/sandbox-executor.ts:22` | `ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG = "--allow-insecure-local-benchmark"` 在两个包各定义一次（当前值相同）。这是一个**关闭隔离**的安全开关，值一旦漂移，接受不安全基准的判定就会出现两套标准 | C | P2 | 提到 `@ar/contracts` 或 `@ar/security` 单一导出，两处 import |
| EXT-016 | `packages/memory/package.json`、`packages/store/package.json`、根 `package.json` | 依赖 `node:sqlite`（`memory/src/sqlite-memory-store.ts:3`、`store/src/sqlite-runtime-store.ts:3`）但三个 `package.json` 都没有 `engines` 字段；`node:sqlite` 需要 Node ≥22.5 且长期为实验特性（需 `--experimental-sqlite` 或 ≥23 默认）→ 在 Node 20 上直接 import 失败，且失败点很深 | D | P2 | 三个 `package.json` 加 `"engines": {"node": ">=22.5"}`；启动处对 SQLite 后端做 capability 探测并给出可读错误（内存后端可退化） |
| EXT-017 | `packages/protocol/src/{types,idempotency,items}.ts`、`packages/mcp/src/{json-schema-zod,mcp-chaos/fixtures}.ts`、`packages/gateway/src/{app-server,rpc}.ts`、`packages/learning/src/change.ts`、`packages/orchestration/src/scheduler.ts`、`packages/sdk/src/client.ts`、`packages/skills/src/effectiveness.ts` | 22 个导出符号全仓 0 外部引用且定义文件内 0 次使用（判定：`git ls-files` 下全部 1176 个 ts 按词边界计数，排除定义文件与 `*/src/index.ts`，再统计同文件内使用次数）。清单：`requiredKeysOf`、`connectTimeout`、`firstThen`、`AppResult`、`ActiveTurnStatus`、`assertState`、`idempotentResult`、`isThreadItem`、`ThreadItemBase`、`ListSkillsResult`、`ThreadReadResult`、`ListAgentsResult`、`TraceReadResult`、`TurnStarted`、`ListToolsResult`、`ProtocolResponse`、`ProtocolRequest`、`ThreadStatus`、`SkillEffectivenessDelta`、`PLANNER_EXECUTOR_SYSTEM_PROMPT`、`platformSensitivity`、`HarnessCandidateChange` | C | P3 | 直接删除；`protocol` 的 8 个 `*Result/*Item` 建议保留类型骨架但改为 `@internal` 注释或移入内部模块，不进包导出面 |
| EXT-018 | `packages/model/src/openai.ts:830`；`packages/orchestration/src/reconciler.ts:184` | 全仓真 TODO 仅 2 条：`listModels` 待接 `GET /models`；`TODO(P33-5): thread interrupt via client (turn/interrupt)`（中断只能走内部通道，客户端侧无法打断） | A | P3 | 前者：要么实现要么删接口；后者：确认 P33-5 是否已有替代路径，否则在 `orchestration` 文档里标注已知缺口 |
| EXT-019 | `packages/evaluation/src/manifest.ts:243-254` 与 `packages/learning/src/change.ts:77-85` | 两份 `stableStringify` 语义不同：`evaluation` 版对 `undefined` 返回字符串 `"undefined"` 且显式排除 `null`；`learning` 版对 `undefined` 走 `JSON.stringify(undefined)`（返回 `undefined`，与声明的 `: string` 不符——类型谎言），数组内 `undefined` 元素两边产出不同。当前都用于哈希指纹 | D | P3 | 收敛到一份（放 `@ar/contracts` 或 `@ar/security` 的 canonical-json），返回类型改 `string \| undefined` 并让调用方显式处理 |
| EXT-020 | `packages/evaluation/src/index.ts`（90+ 行 `export *`，摊平 `src/` 下几乎所有模块） | 扁平 barrel：`evaluation` 把 92 个模块全部 `export *` 出去，跨模块重名会在编译期报错（当前 0 冲突，靠的是人力维护），且包导出面 ≈ 1355 个符号，消费者无法判断哪些是稳定 API | A | P3 | 分命名空间导出（`export * as r97 from "./r97-plan.js"`）或维护显式白名单 barrel；先从一个世代试点 |

## 2. 分模块明细

### 2.1 `packages/gateway`（9 个非测试源文件，1630 行）

线缆层：`app-server.ts`（334 行）做握手/有界队列/幂等表，`rpc.ts`（325 行）注册 runtime RPC，`stdio-transport.ts`（168 行）做 NDJSON 帧，`gateway.ts`（390 行）做会话编排。整体分层清楚，错误都走 `AgentError`+`errorInfo`。

### 说明 · EXT-001

`stdio-transport.ts:149-152` 正常路径是 `this.pending.get(id)` → `delete` → `resolve(...)`；`close()`（`:160-163`）只 `clear()`。也就是说 transport 关闭时在途请求的 Promise 永远不 settle——不是 reject 成错误，而是**静默挂起**。对 `await client.call(...)` 的调用方来说，表现为整个 turn 卡死且没有任何超时兜底（超时在更上层）。这属于"确定性挂死 + 资源泄漏"，因此定 P1 而非 P2。

### 说明 · EXT-009

`rpc.ts:321-324` 的 `trace.get` 只有一行 `return deps.events.list(...)`；`packages/observability/src/trace-exporter.ts:282` 也是 `const events = await deps.events.list(session.id)`，随后 `:299` 把全部事件 `join("\n")` 成一个大字符串写 `events.jsonl`。两个消费方都假设"事件不多"。会话越长越危险，且 `rpc.ts:179` 的 `thread/list` 在循环里对每个 session 调一次 `events.list`，是 O(sessions × events)。

### 2.2 `packages/model`（10 个非测试源文件）

provider 适配层，只有 OpenAI 一家真实实现（`openai.ts`，898 行），其余是能力解析、请求前缀观测、用量统计、chat 兼容性、诊断打包与两个 fake。取消（`AbortSignal` 参与 `Promise.race`）、重试退避（`P1-18`，带 jitter 且解析 `Retry-After`）、错误分类（spawn/timeout/maxBuffer/signal）都在位。

### 说明 · EXT-003

`openai.ts:702-714` 的读循环是 `while (buffer.indexOf("\n") < 0 && !streamEnded) { ... buffer += decoder.decode(...) }`——**没有行长上限**。正常情况下 SSE 每行几十到几百字节、很快遇到换行；但 provider 侧若返回一个不带换行的超长行（压缩流异常、proxy 注入的 HTML 错误页、超大 base64 图片块），`buffer` 会一直涨，而 abort 只能从外部触发。同类模式在 `mcp/src/stdio-client.ts:183-186` 的 `onStdout`。按 METHOD §8 合并为一条。

另外记录（未单列 ID，属 P3 观察）：`openai.ts` 中 `parseArgs` 用 `raw as unknown as Record<string, unknown>` 把字符串断言成对象，工具处理器随后 `args.x` 只会得到 `undefined` 而不是类型错误——是"类型工具说谎"而非当前 bug。

### 2.3 `packages/mcp`（12 个非测试源文件）

外部工具协议客户端：`stdio-client.ts`（子进程 + 行协议）、`transport.ts`（HTTP/JSON-RPC）、`connection-manager.ts`（有界自动重连 `P2-40`）、`json-schema-zod.ts`（schema→zod）。子进程只 `spawn` 且无 `shell: true`（全仓 0 处 `shell: true` 生产代码），注入面受控；注册期有 prompt-injection 扫描（`P0-8`，fail-closed）。

风险已在 EXT-003/EXT-004 记录（行缓冲无上限）。补充观察：`json-schema-zod.ts:88` 的 `requiredKeysOf` 是死符号（EXT-017）。

### 2.4 `packages/memory`（12 个非测试源文件，2301 行）

`node:sqlite` 持久化（`sqlite-memory-store.ts` 561 行，WAL、schema v6、6 个幂等迁移）+ 写入闸门（`write-gate.ts`：去重/敏感/容量）+ 安全闸门（`security-gate.ts`）+ 生命周期（`lifecycle.ts`）+ 检索（`retrieval.ts`）+ 反思（`reflection.ts` 508 行）。写入路径的质量不错：先过 security 再落盘。

### 说明 · EXT-008

`lifecycle.ts:11` 定义 `DEFAULT_MAX_IDLE_MS = 30 * 24 * 3600 * 1000`，`:108-109` 把超期且无 usefulness 的条目判为 stale——**只是状态迁移**。全文件唯一的 `DELETE` 在 `sqlite-memory-store.ts:220`，删的是 FTS 索引行（跟随主表删除），不是保留策略。结论：单库会无界增长。这在小规模自用场景可接受，但一旦作为长期运行的服务（本仓 `AGENTS.md` 描述的 runtime 形态），检索与 `memories_fts` 都会线性变差。

### 2.5 `packages/context`（12 个非测试源文件，2279 行）

上下文装配与压缩：`compaction.ts`（402 行，保留栅栏 + preview 上限 16 KiB）、`pipeline.ts`（595 行，阶段化 + quarantine envelope + rehydration 双重约束）、`budget.ts`、`circuit-breaker.ts`、`discovery.ts`（50 KB/文件、最多 4 文档）、`rehydration.ts`（maxFiles 截断）。上限设计整体齐备——**除了 EXT-007 的 token 估算**，它是所有预算计算的根。

### 2.6 `packages/evaluation`（98 个非测试源文件，45,838 行）

本仓最大的包，承担基准、预注册、门禁证据、配对执行、评分卡、候选注册表、triage 等。防御性写得很足（`assertInside` 路径逃逸校验、`execFile` 白名单命令、runner 失败分类 `spawn|timeout|maxBuffer|signal|runner_error`、证据与 HEAD 绑定、命令 argv 精确匹配 `COMMAND_MISMATCH`）。问题集中在**结构**而非单点实现质量：EXT-011（跨包重复实现）、EXT-012（原子写 5 份）、EXT-013（测试套件拷贝）、EXT-014（扁平目录 + 2627 行单文件）、EXT-002（弱脱敏）、EXT-005（伪造度量）。

### 说明 · EXT-002

`gate-evidence-v2.ts:403-411` 的三个正则与 `security/src/secret-gate.ts` 的 11 条 `SECRET_PATTERNS` 对比：只覆盖 `credential-assignment` 的一个变体、`openai-key`、`jwt-token`。缺少：`aws-access-key`（`AKIA...`）、`github-token`（`ghp_...`）、`slack-token`、`stripe-key`、`google-api-key`（`AIza...`）、`private-key`（`-----BEGIN ... PRIVATE KEY-----`）、`bearer-token`、`db-credentials`，共 8 类；另外 `credential-assignment` 只覆盖了引号形式的一个变体。调用点 `:435/:461/:463/:521` 覆盖了 errorSummary 与落盘日志两条路径，`:521-530` 写文件并算 sha256——即"脱敏后的日志"已经是落盘产物，弱脱敏 = 磁盘上的明文密钥。

### 说明 · EXT-005

`experiment-harness.ts:31-52` 的注释是 "Default benchmark: simulates a run with random metrics."，类注释 `:11-15` 写 "use the default simulation for testing"。也就是说这是**有意为之的测试替身**，问题不在动机而在**默认值**：`ExperimentHarness` 构造函数 `deps.runBenchmark ?? defaultRunBenchmark`（`:62`），漏传依赖不会报错，产出的报告看起来完全正常（`status:"completed"`、合理的 passRate/latency/token 数量级），而 `ExperimentReport` 无 `simulated` 标记。当前生产代码 0 个调用点（仅两个测试文件），所以定 P2；一旦有人把它接进预注册/门禁证据链，应升级为 P1。

### 2.7 `packages/plugins`（3 个非测试源文件，660 行）

同进程插件宿主。安全默认做得好：`defaultChampion` 默认关（`:111-115` 注释直说"same-process plugins are an arbitrary-code-execution surface"）、`allowedSources` 白名单、trust→capability 授权矩阵（`:147-152`）、P14-4 的 capability 只能收窄不能放宽（fail-closed）。缺陷在失败隔离（EXT-006）。

### 说明 · EXT-006

`withTimeout`（`:173-196`）把 `promise.then(onOk, onErr)` 的 `onErr` 直接 `resolve(TIMEOUT_SENTINEL)`，注释 `:192` 自陈 "failure treated like a skipped plugin"。后果：插件抛错 → 上层看到"超时/跳过"，`maxConsecutiveFailures` 的隔离计分（默认 5）虽然会累加，但 `stats()` 里反映不出错误内容，排障时只有"插件 A 老是被跳过"。对一个自称"no silent swallow"的组件，这是名不副实。

### 2.8 `packages/observability`（6 个非测试源文件）

trace 导出（`trace-exporter.ts` 360 行，产出 task.json/session.json/events.jsonl/context.json）、指标（`metrics.ts`）、trace 树、清单、harness 演化。EXT-010（`spawnSync` 阻塞）与 EXT-009（全量事件）在此。

### 2.9 `packages/learning`（9 个非测试源文件，1721 行）

演化闭环的持久侧：`sandbox.ts`（mkdtemp 隔离 + 前后 digest 对比做变异检测，且 `writeScratch` 拒绝 `..`/绝对路径/盘符）、`change.ts`、`candidate.ts`、`paired.ts`（535 行，配对评估）、`promoter.ts`（409 行，晋升）、`scorecard.ts`、`experiments.ts`、`paired-evaluation.ts`。死导出 3 个（EXT-017），`stableStringify` 类型谎言（EXT-019），`computeScoreCard` 与 evaluation 重名（EXT-011）。

### 2.10 其余包（`agents` 10 / `protocol` 10 / `skills` 9 / `orchestration` 9 / `sdk` 3）

- `agents`：并发与超时上限齐备（`DelegationLimits` 的 maxDepth/maxChildren/maxConcurrent/maxToolCalls/maxDurationMs 全部有落点，`parallel-delegator.ts:65-67` 对 `maxConcurrent<=0` 显式报 `RESOURCE_LIMIT`，`scheduler.ts:270-277` 队列满即拒绝而非无界排队）。未发现新问题。
- `protocol`：10 个文件共 1101 行，`bounded.ts` 有界集合、`idempotency.ts` 幂等表、`mapper.ts` 映射。问题只有 EXT-017 的死类型（8 个）。
- `skills`：`skill-loader.ts` 421 行做加载与校验，`skill-security.ts` 49 行做安全闸门，`skill-evolution.ts` 209 行。问题只有 EXT-011 的 `EvolutionDecision` 重名与 EXT-017 的 `SkillEffectivenessDelta`。
- `orchestration`：`reconciler.ts` 容量计算 `Math.max(0, (maxConcurrent ?? 4) - running - retrying)`（`:129-134`）正确；`workflow-loader.ts` 用扁平 front matter 解析（非完整 YAML，`:43` 有注释说明）。只有 EXT-018 的 TODO。
- `sdk`：`client.ts` 576 行，`AbortSignal` 贯穿（`:70/250/257/311/380-381/422/464`），`SdkError` 带 `code`+`retryable`，流中断有 `STREAM_TERMINATED_BEFORE_TURN_END`。未发现新问题；`ThreadStatus` 是死类型（EXT-017）。

## 3. 覆盖清单

统计口径：`git ls-files` 下 `packages/<pkg>/src/**/*.ts`，排除 `*.test.ts`。共 212 个非测试源文件（evaluation 98 + 其余 13 包 114），全部纳入本轮，无静默跳过项。

### 3.1 逐行阅读（40 个文件）

| 包 | 逐行阅读的文件 | 结论 |
| --- | --- | --- |
| evaluation | `gate-evidence-v2.ts`、`experiment-harness.ts`，以及 `benchmark-isolation.ts`/`r97-plan.ts`/`tool-call-efficiency-case-selection.ts`/`prereg-run-evidence.ts`/`manifest.ts`/`paired-executor.ts` 的关键函数段 | EXT-002、EXT-005、EXT-011、EXT-012、EXT-015 |
| model | 全部 10 个：`openai.ts`、`openai-usage.ts`、`openai-chat-compatibility.ts`、`registry.ts`、`provider-diagnostics.ts`、`capability-resolver.ts`、`request-prefix-observer.ts`、`fakes/scripted.ts`、`fakes/echo.ts`、`index.ts` | EXT-003、EXT-018 |
| mcp | 5 个：`stdio-client.ts`、`transport.ts`、`client.ts`、`json-schema-zod.ts`、`connection-manager.ts` | EXT-004、EXT-017 |
| gateway | 4 个：`app-server.ts`、`rpc.ts`、`gateway.ts`、`stdio-transport.ts` | EXT-001、EXT-009 |
| memory | 5 个：`sqlite-memory-store.ts`、`write-gate.ts`、`security-gate.ts`、`lifecycle.ts`、`retrieval.ts` | EXT-008、EXT-016 |
| context | 3 个：`compaction.ts`、`pipeline.ts`、`tokenizer.ts` | EXT-007 |
| learning | 3 个：`sandbox.ts`、`experiments.ts`、`paired.ts` | EXT-011、EXT-019 |
| plugins | 1 个：`plugin-host.ts`（前 200 行逐行，其余段按函数名与 grep 定位） | EXT-006 |
| observability | 1 个：`trace-exporter.ts` | EXT-009、EXT-010 |
| 其余 5 包 | 0 | 见 3.2 |

### 3.2 批量扫描（172 个文件）

扫描口径（对每个文件跑同一组模式 + 全仓交叉比对），聚合规则按目录：

1. 危险 API：`eval(`、`new Function`、`shell: true`、`child_process` 的 `spawn/exec/execFile/spawnSync`、`process.exit(`、`@ts-expect-error`、`as any`。
2. 不确定性与时间：`Math.random(`、`Date.now()`、`setTimeout`/`AbortSignal`/`timeoutMs`。
3. 上限与增长：`MAX_`/`maxEntries`/`maxChars`/`LIMIT`/`DELETE FROM`/`prune`/`slice(0,`。
4. 外部输入：`JSON.parse(`、`readFileSync`、`process.env.`。
5. 检查与占位：`describe.skip`/`it.skip`/`it.only`/`describe.only`/`xit`、`TODO|FIXME|HACK|XXX`、`not implemented|placeholder|stub|simulat|unimplemented`。
6. 死导出：抽取每个文件的 `export (const|let|function|class|interface|type|enum)` 名，在 1176 个 ts 里按词边界计外部引用，再统计定义文件内使用次数。

| 目录 | 文件数 | 聚合结论 |
| --- | --- | --- |
| `evaluation/src/`（根） | 84 | 除 3.1 已列者外，`eval(`/`new Function`/`shell: true` 均 0 命中；`Math.random()` 10 处（6 个文件，除 `experiment-harness.ts` 外均为临时文件名或重试 jitter，见 EXT-005）；`JSON.parse` 50 处（集中于 artifact/plan/journal 加载，抽查的加载路径都有 schema 校验或 `try/catch` + 结构化错误）；`execFile` 4 个文件均白名单命令 + 超时；无 `process.env` 读取 |
| `evaluation/src/artifact-v3/` | 6 | `schema.ts`/`loader.ts`/`validate.ts`/`writer.ts` 有 `JSON.parse` 3 处，均伴随校验；无新问题 |
| `model/src/` | 0（已全读） | — |
| `memory/src/` | 7 | `reflection.ts`(508)、`memory-store.ts`(285)、`derivability.ts`、`evidence.ts`、`search-text.ts`、`usefulness.ts`、`index.ts`：无 DELETE/prune/上限（并入 EXT-008 说明）；无子进程、无 `eval` |
| `context/src/` | 9 | `budget.ts`、`circuit-breaker.ts`、`coding-summary.ts`、`discovery.ts`、`path-scoped-discovery.ts`、`policy-versioning.ts`、`prompt-versioning.ts`、`rehydration.ts`、`index.ts`：上限齐全（16 KiB preview / 50 KB/文件 / 4 文档 / maxFiles）；无新问题 |
| `mcp/src/` | 7 | 含 `mcp-chaos/fixtures.ts`、`schema-cache.ts` 等：除 EXT-003/017 外无新问题；`spawn` 仅 `stdio-client.ts:1` 一处，未见 `shell: true` |
| `gateway/src/` | 5 | `channel.ts`、`desktop-client.ts`、`transport.ts`、`fakes/fake-channel.ts`、`index.ts`：无新问题 |
| `learning/src/` | 6 | `change.ts`、`candidate.ts`、`promoter.ts`、`paired-evaluation.ts`、`scorecard.ts`、`index.ts`：除 EXT-004（`index.ts:66` 格式）外无新问题 |
| `skills/src/` | 9 | 全部 9 个均按 6 组模式扫描：0 命中危险 API；`skill-loader.ts` 的路径处理未见逃逸缺口；仅 EXT-011/017 |
| `agents/src/` | 10 | 全部按模式扫描 + 并发上限专项：无新问题 |
| `protocol/src/` | 10 | 全部按模式扫描：无新问题（仅死类型） |
| `orchestration/src/` | 9 | 全部按模式扫描：无新问题（仅 EXT-018 TODO） |
| `observability/src/` | 5 | `metrics.ts`、`trace-tree.ts`、`inventory.ts`、`harness-evolution.ts`、`index.ts`：`metrics.ts` 的 `events.filter(...)` 属 O(n) 但输入已是内存数组，未见无界累积；`harness-evolution.ts` 无新问题 |
| `sdk/src/` | 3 | `client.ts`、`transport.ts`、`index.ts`：无新问题 |
| `plugins/src/` | 2 | `plugin-registry.ts`、`index.ts`：无新问题 |

### 3.3 测试与被禁用例

- `evaluation` 148 个 `*.test.ts`，其余 13 包共 87 个 `*.test.ts`。
- `describe.skip` / `it.skip` / `it.only` / `describe.only` / `xit` 全仓 **0 命中**——没有被禁用的用例，也没有 only 残留（方法：对 456 个 ts 文件跑 Select-String）。
- 用例标题重复：`evaluation` 2249 条标题中 12 条跨文件重复（EXT-013）。

## 4. 存疑 / 需人工确认

1. **EXT-005 的定级取决于是否已被接入**：我只在全仓 `git ls-files` 范围内 grep 到 2 个测试文件 `new ExperimentHarness(...)`，生产代码 0 处。若仓库外（例如 `scripts/e4/*.mjs` 或外部调用方）有使用，应立刻升 P1。建议由 Lead 在后续核对 `scripts/` 与 `dist/` 的调用面。
2. **EXT-011 的 `RecoveryPolicy` 是否真的行为分叉未验证**：`packages/evaluation/src/recovery-policy.ts:24,41` 与 `packages/core/src/recovery/recovery.ts:14,46` 同名但签名不同（一个是 interface + interface，一个是 interface + class）。名字相同不等于逻辑相同，我没有逐字段比对两侧的恢复语义，需人工确认是"两份真相"还是"评测侧刻意简化的镜像"。
3. **EXT-007 的 CJK 低估倍数**是估算，未做实证：`Buffer.byteLength/4` 对中文约 0.75 token/字，而主流分词器对中文通常 1–2 token/字。建议用真实分词器跑 100 条本仓中文提示做校准后再定系数。
4. **EXT-016 的 Node 版本实际下界**未实测：我只确认了三个 `package.json` 都没有 `engines`。`node:sqlite` 在 22.5 需要 flag、23 起默认、24 起稳定，具体行为取决于运行时版本，建议由 Lead 在 `pnpm typecheck`/CI 环境确认实际 Node 版本。
5. **未运行的验证**：本轮为纯只读审查，没有执行 `pnpm typecheck` / `pnpm test`（task 授权只读，且全量测试耗时不可控）。上述所有"未发现问题"的结论都只代表静态扫描与阅读结论，不代表测试通过。
6. **低置信区间**：`agents`、`protocol`、`skills`、`orchestration`、`sdk` 五个包只有模式扫描，没有逐行阅读（共 41 个文件）。这五个包本轮未报告任何问题，属于"未发现"而非"已确认无问题"。
7. **`gateway/src/desktop-client.ts:459` 的 `@ts-expect-error`** 是全仓唯一一处（且在测试文件中），未深究原因；如需彻底清理类型逃逸可单独跟进。
