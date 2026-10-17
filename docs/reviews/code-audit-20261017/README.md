# Harness Agent 全仓代码审查报告

- **仓库**：`D:\Download games\harness agent`（monorepo，pnpm workspace）
- **审查基线**：`44f3f51f6ecfdc0da653a6e76a4149d032729961`（PR #11 的候选分支，非当前 main）。
- **审查日期**：2026-10-17
- **报告编号**：`code-audit-20261017`
- **审查性质**：**只读**。全程未修改、未删除任何被跟踪文件；审查前后 `git status --porcelain` 均为空。本报告本身是唯一新增产物。
- **审查方式**：6 名审查员按互不重叠的路径前缀并行审查（每个域独立产出分片报告，含逐文件覆盖清单），Lead 负责统一方法、横切统计、独立复核 P1 与合并成稿。

---

## 合入时复核说明

本报告保留原审查时的 155 条发现，属于固定候选源码的历史审查材料，不能视为
当前 main 的缺陷清单或已完成验收。合入时独立验证 coverage-manifest.tsv 的
11,937 条路径不重复，并与上述固定 SHA 的完整跟踪清单逐项一致。部分结论
仍需反例复核；PR #13 的修复代码单独审查。当前 UI/Windows 修复和本轮实测
见 [日常交互报告](../../web-daily-interactions-20261017.md)，旧发现应逐项核销，
不能据此重复修改或回退已有修复。

## 1. 范围与方法

### 1.1 覆盖范围

`git ls-files` 实测 **11,937 个跟踪文件**，按互不重叠的 6 个路径前缀分配，并集完整覆盖：

| 分片 | scope | 跟踪文件 | 代码文件（非测试 / 测试） |
|---|---|---|---|
| WEB | `apps/web/src` | 59 | 59（含 ts/tsx/css） |
| CLI | `apps/cli` | 153 | 138（40 / 98）+ test-infra 8 |
| PKG | `packages/{core,harness,tools,contracts,security,store,store-integrity,events,session,checkpoint}` | 418 | 197 / 221 |
| EXT | `packages/{evaluation,model,memory,mcp,context,agents,protocol,skills,gateway,orchestration,learning,observability,sdk,plugins}` | 493 | 212 / 281 |
| SCF | `scripts/`、`.github/`、`tasks/` + 仓库根 47 个零散文件（配置、`plan*.md`、`README*`、`HANDOVER.md`、`mem.md` 等） | 285 + 47 | 214 个脚本 |
| AST | `apps/web/public/`、`docs/`、`benchmarks/`、`research/`、`third_party/` | 10,482（318.0 MB，占全仓 87.8%） | 以资产/文档/基准为主 |
| **合计** | | **11,937** | 全仓代码文件 1,806（其中源码目录 apps/ packages/ scripts/ 内为 1,391：非测试 783 / 测试 608） |

全仓仅有 **1,806 个代码扩展名文件**（`.ts/.tsx/.js/.mjs/.cjs/.css`；其中源码目录内 1,391 个），其余 10,131 个跟踪文件是文档、证据、基准夹具与静态资产——这个比例决定了本次审查的重心分配：代码域逐行精读，资产域按聚合规则 + 抽样验真。

### 1.2 判定方法

统一方法文件：`docs/reviews/code-audit-20261017/evidence/METHOD.md`（审查期间的工作副本为 `.ci/tmp/review/METHOD.md`）。四类问题、四级严重度：

- **类别**：`A` 可优化的代码点（重复逻辑/过长函数/命名/结构/性能/错误处理/类型）｜`B` 当前不宜优化但仍可改进（必须写明不能动的理由）｜`C` 无引用文件/依赖/资源/死代码（必须给 grep 证据）｜`D` 潜在风险与隐患（安全/性能/兼容性）
- **级别**：`P0` 安全或数据损坏｜`P1` 确定性正确性缺陷、性能塌陷、资源泄漏、跨平台破坏｜`P2` 可维护性/可观测性显著受损｜`P3` 风格与整洁度

每条发现必须包含：`ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法`。死代码判定要求给出引用计数证据；无法逐行阅读的文件必须显式标注「未逐行（原因）」并说明替代手段（见 §10）。

### 1.3 与既有审查的关系

仓库已有 `docs/reviews/source-audit-20261007/`（源码审计）与 `docs/gen1-independent-audit.md` 等历史审查。本报告是**独立的新一轮全仓审查**，不复用历史结论；若与历史结论冲突，以本次实测代码为准（冲突点已在 §4 主题 7 记录）。

---

## 2. 总体结论

### 2.1 数量分布

| 分片 | 合计 | P0 | P1 | P2 | P3 | A | B | C | D |
|---|---|---|---|---|---|---|---|---|---|
| apps/web/src | 54 | 0 | 2 | 26 | 26 | 25 | 0 | 1 | 28 |
| apps/cli | 15 | 0 | 2 | 9 | 4 | 9 | 1 | 0 | 5 |
| packages/ 运行时底座 | 29 | 0 | 3 | 25 | 1 | 7 | 0 | 3 | 19 |
| packages/ 外围能力 | 20 | 0 | 2 | 13 | 5 | 4 | 0 | 5 | 11 |
| scripts/ 与仓库级配置 | 18 | 0 | 1 | 12 | 5 | 6 | 5 | 4 | 3 |
| 静态资产与文档 | 17 | 0 | 1 | 10 | 6 | 12 | 2 | 1 | 2 |
| 分片小计 | **153** | **0** | **11** | **95** | **47** | **63** | **8** | **14** | **68** |
| Lead 直属追加（§5.0） | +2 | 0 | 0 | 1 | 1 | 0 | 1 | 1 | 0 |
| **总计** | **155** | **0** | **11** | **96** | **48** | **63** | **9** | **15** | **68** |

### 2.2 三个定性结论

**结论一：没有 P0，但「门禁空转」是系统性缺陷。** 11 条 P1 中有 6 条属于同一形态——校验/门禁代码确实存在、也有测试覆盖，但**生产路径永远不会触发它**：配置漂移检查只在 `sessions.load` 后冻结基线（PKG-001）、持久化栅栏在生产调用点被哨兵值绕过（PKG-002）、工具语义哈希实际是函数形参个数（PKG-003）、`packages/orchestration` 整个包不在 `tsc -b` 工程图里（SCF-001）、Windows 上发布门禁第 9 步恒失败（CLI-001）、`.gitattributes` 漏钉导致已提交的证据哈希不可复现（AST-01）。这类缺陷的危险性不在当下行为，而在**它让"已验证"这三个字失去含义**。

**结论二：工程纪律总体良好，问题集中在"清单手写"与"实现复制"。** 反证如下（均为实测，不是印象）：全仓 `describe.skip/it.skip/it.only/xit` **0 命中**；`scripts/` 的 4 个 `.ps1` 全部设 `$ErrorActionPreference`、`.sh` 全部 `set -e`、175 个脚本文件零硬编码绝对路径；根 `package.json` 的 35 个脚本引用路径全部存在、4 个 devDependency 全部被使用；`vitest.config.ts` 的 include 与 618 个测试文件分布一致（漏掉的 23 个均为有意排除的冻结快照）；benchmarks 的 8 个 suite 用例数与 `apps/cli/src/audit.ts:586/596/606/616` 的声明完全吻合，**无孤儿用例**。真正的问题是同一份清单被手写在多处（tsconfig references、CI 测试清单、`.gitattributes` 钉、doctor 内置工具数），以及同一段逻辑被复制多份（跨包同名实现 9 组、原子写 5 份、durable JSON 写 7 份、入参校验 4 套）。

**结论三：仓库体积问题已经影响可维护性，但绝大多数"冗余"不能按体积删。** `docs/evidence` 独占 243.5 MB（`docs` 的 96.1%），其中 698 个 PNG（31.8 MB）、112 个 SQLite（5.5 MB）、1,122 个 `.log`（6.4 MB）属运行产物入库。但经逐项 grep 验证，`tarballs/*.tgz`（67 个 13.7 MB）、`harness-brand/plugins/**`、`legacy/{app.js,style.css}`、`benchmarks/results`、`baseline-e4-r74` **都有活引用或冻结断言**，删了会破坏证据链（详见 §8）。

### 2.3 必修清单（Top 12）

按「修复成本 ÷ 危害」排序。前 11 条为分片 P1，第 12 条为 Lead 自查追加。

| # | ID | 位置 | 一句话 | 为什么现在修 |
|---|---|---|---|---|
| 1 | EXT-002 | `packages/evaluation/src/gate-evidence-v2.ts:403-411` | 证据链自带的 `redactSecrets` 只覆盖 3 类密钥，`@ar/security` 有 11 类 | 未脱敏文本会写进 `evidence/*.log` 并算 sha256，属真实泄漏面 |
| 2 | PKG-001 | `packages/harness/src/create-harness.ts:741/:842` | 配置漂移基线只在 `sessions.load` 后冻结，`createSession` 不冻结 | 「建会话 → 改配置 → 首次 load」正是常规用法，漂移门禁对这条路径完全失效 |
| 3 | PKG-002 | `packages/core/src/runtime/runtime.ts:983` | `flushThrough` 的唯一生产调用点传 `MAX_SAFE_INTEGER`，恰好命中"跳过校验"分支 | 持久化栅栏在生产路径上不做任何校验，崩溃可能丢已 ack 的事件 |
| 4 | SCF-001 | `tsconfig.json:1-27` | `packages/orchestration` 不在 references，`tsc -b` 不编译它 | 仓库唯一的静态检查对整个包零覆盖；同一根因已让发布构建拒绝过一次 |
| 5 | CLI-001 | `apps/cli/src/release-artifacts.ts:190` | 发布门禁用 `execFile("pnpm", shell:false)`，Windows 只有 `pnpm.cmd` | 实测 `ENOENT`，发布产物在 Windows 恒为 `ok:false` |
| 6 | PKG-003 | `packages/core/src/runtime/runtime.ts:895` | `toolSemanticsHash` 取的是函数形参个数（恒 `"1"`） | 换工具安全语义不触发任何漂移告警；`retryPolicyHash` 存了却从不比较 |
| 7 | EXT-001 | `packages/gateway/src/stdio-transport.ts:160-163` | `close()` 只清空 pending map，不 resolve 不 reject | 在途 RPC 永久挂起，进程退不掉 |
| 8 | AST-01 | `.gitattributes` + `benchmarks/coding-repositories-v1/upstream-seeded.json` | 证据哈希按 `read_bytes()` 计算，文件未钉 `eol=lf` | 本机 CRLF 检出后哈希不可复现；同模式仓库已修过两次（R12/R94） |
| 9 | WEB-020 | `apps/web/src/deepseek/events.ts:53-77` | 每个事件流每轮遍历全部会话并全量读日志求 pending | 会话数 × 日志长度，长会话下轮询成本线性放大 |
| 10 | WEB-021 | `apps/web/src/deepseek/session.ts:443-455` | `session/control` 每轮对每个会话全量重投影（含 host tool 读文件） | 同上；且 I/O 落在轮询热路径上 |
| 11 | CLI-002 | `apps/cli/src/commands.ts:402` | 位置参数用 `filter(!startsWith("--"))` 取，不跳过 flag 的值 | `--mode real-model` 会让 `real-model` 变成 baselinePath，**静默读错文件** |
| 12 | LEA-01 | `.trae-html-share-packages/apps/web/public/index.html.zip` | 外部工具产物（7,225 B）被提交，混在一个"编写计划文档"的提交里 | 零引用；内含 `app.js/index.html/style.css` 旧快照，污染仓库且误导读者 |

---

## 3. P1 逐条分析（11 条）

> 复核标记：**【Lead 已复核】**＝ Lead 独立打开源码/配置确认；**【审查员证据】**＝ 由该域审查员提供代码证据，Lead 未独立复现。本次 11 条 P1 中 7 条已独立复核。

### WEB-020（D/P1）事件流轮询做全量扫描

- **位置**：`apps/web/src/deepseek/events.ts:53-77`
- **事实**：`pending()` 每次调用先 `store.listSessions()` 取全部会话（过滤 `failed`），再对**每个会话**执行 `harness.events.list(session.id)` 全量读日志，随后 `flatMap` 全表扫 `ask.user_asked`、逐 ask 调 `ownedQuestion()`（内部再翻 journal）、逐 turn 调 `store.getTurn()`。该函数由 `$events` 流的轮询周期驱动（约 25ms 一次）。
- **影响**：单次待办查询成本 = `O(会话数 × 单会话日志长度)`，且 25ms 重复一次。长会话（数千事件）＋ 多会话时，Web 宿主的 CPU 与 SQLite 读放大明显，属性能塌陷型缺陷。
- **建议**：改为事件驱动——`appendNew` 后置脏标记；为 `ask.*` 与 `turn.waiting` 维护增量索引（按 `sequence` 游标），无新事件时直接返回空。
- **复核**：**【Lead 已复核】** `pending()` 的全量遍历与全量日志读取已确认。

### WEB-021（D/P1）`session/control` 每轮全量重投影

- **位置**：`apps/web/src/deepseek/session.ts:443-455`
- **事实**：`session/control` 每轮对**每个**会话调用 `projectUnlocked()` 全量重投影，投影路径内含 host tool 读文件（`host-tools.ts`），即轮询热路径上夹带真实文件 I/O。
- **影响**：与会话数、事件数、文件大小三者相乘；同时把"读取宿主文件"变成高频副作用。
- **建议**：`projectUnlocked` 改按 `sourceSequence` 增量投影；缓存 baseline，无新事件时跳过 `meta()` 读盘；host tool 读取结果按 (path, mtime, size) 记忆化。
- **复核**：**【审查员证据】**（Lead 未逐行核对投影函数体）。

### CLI-001（D/P1）Windows 上发布门禁恒失败

- **位置**：`apps/cli/src/release-artifacts.ts:190`
- **事实**：门禁命令声明为 `command: ["pnpm", "capability:audit"]`，而执行器用 `execFile(..., {shell:false})`。Windows 上 `pnpm` 只有 `pnpm.cmd` 垫片，`execFile` 不解析 PATHEXT ⇒ `ENOENT` ⇒ 第 9 步恒 `produced:false`，`collectReleaseArtifacts().ok` 在 Windows 永远为 `false`。审查员实测得到 `ERR: ENOENT`。
- **影响**：Windows 上的发布/验收链路存在**永远无法通过的步骤**，容易被误读为"环境问题"而长期忽略；与 CLI-003（`shell:true` 拼接命令）互为镜像。
- **建议**：门禁改走 `process.execPath` 或 `["node","apps/cli/dist/main.js",...]`；若确实要调包管理器，在执行器内对 `win32` 解析 `.cmd` 垫片（`where pnpm` → `cmd.exe /c`）并补单测。**必须与 CLI-003 同批修复**，否则拆 shell 会以修 P2 的方式造出新 P1。
- **复核**：**【Lead 已复核】** `:190` 的 `["pnpm","capability:audit"]` 与 `shell:false` 执行器已确认。

### CLI-002（D/P1）位置参数解析吞掉 flag 的值

- **位置**：`apps/cli/src/commands.ts:402-404`
- **事实**：`const files = rest.slice(1).filter((a) => !a.startsWith("--"))` —— 只过滤以 `--` 开头的 token，**不跳过 flag 的值**。`agent champion eval --mode real-model a.json b.json` 会得到 `files = ["real-model","a.json","b.json"]`，即 `baselinePath = "real-model"`、`candidatePath = "a.json"`。同时 `const mode = modeIdx >= 0 && rest[modeIdx+1] === "real-model" ? "real-model" : "stub"` 对非法值静默降级为 `stub`。
- **影响**：静默读错文件 + 静默降级评测模式，属"给出看似正常的错误结论"，比崩溃更危险（评测结果可能被当作真实结论引用）。
- **建议**：改成与 `benchmark` 一致的显式循环（`i++` 跳过 flag 值）；`--mode` 做值域校验（`stub&#124;real-model`），非法值 `exitCode:1` + usage。
- **复核**：**【Lead 已复核】** `:402-408` 逻辑确认无误。

### PKG-001（D/P1）配置漂移基线只在 load 成功后冻结

- **位置**：`packages/harness/src/create-harness.ts:741`（`createSession`）/ `:842`（`freezeConfigFingerprint` 唯一生产调用点）
- **事实**：`checkSessionConfigDrift` 在 `snap?.[CONFIG_FP_KEY]` 不是 string 时直接 `{severity:"none"}` 返回；而基线只在 `sessions.load` 成功后被 `freezeConfigFingerprint(id)` 写入。`createSession` 不写基线。
- **代码路径**：`createSession` → 进程退出／用户改 profile → `sessions.load(id)` → 漂移检查因无基线返回 `none` → `freezeConfigFingerprint(id)` 把**改后的配置**冻结为新基线。
- **影响**：`CONFIG_DRIFT_REJECTED` 对"创建后首次 load 前发生的配置变更"完全不生效，而这正是最常规的用法。测试盲区：现有矩阵测试都手工先 `freezeConfigFingerprint()` 再 check，未覆盖创建路径。
- **建议**：`createSession` 成功后立即冻结基线（或建会话时把 fingerprint 写进 state snapshot），并补"创建 → 改配置 → 首次 load"用例。
- **复核**：**【Lead 已复核】** 全仓 `freezeConfigFingerprint` 生产调用点仅 `:842` 一处（另两处为测试）。

### PKG-002（D/P1）生产调用点命中"跳过校验"分支

- **位置**：`packages/store/src/sqlite-runtime-store.ts:460-468` + `packages/core/src/runtime/runtime.ts:983`
- **事实**：`flushThrough` 先 `PRAGMA wal_checkpoint(PASSIVE)`，再 `SELECT 1 FROM events WHERE session_id=? AND sequence=?`；若 `row === undefined && sequence !== Number.MAX_SAFE_INTEGER` 才抛 `not committed`。而 runtime 的唯一生产调用点是 `this.durabilityFence.flushThrough(sessionId, Number.MAX_SAFE_INTEGER)`。
- **影响**：名为"turn 结束后确保事件已持久化"的栅栏，在生产中退化为一次 PASSIVE checkpoint（不保证 WAL 落盘）。注释承诺的 fail-closed 语义（":978-981"）与实际行为不一致，崩溃恢复可能丢已 ack 事件且无告警。测试 `sqlite-runtime-store.test.ts:441/443` 传真实序号并断言抛错——说明校验逻辑本身有效，只是永远走不到。
- **建议**：让 runtime 传真实已提交序号（`lastEvent.sequence`），或删除哨兵分支、由 store 以 `MAX(sequence)` 语义校验。
- **复核**：**【Lead 已复核】** 两端代码均已确认。

### PKG-003（D/P1）"哈希"其实是函数形参个数

- **位置**：`packages/core/src/runtime/runtime.ts:895`、`:2023-2034`（`resolveAgent` 漂移分支）
- **事实**：`toolSemanticsHash: this.toolSemanticsOf !== undefined ? String(this.toolSemanticsOf.length) : undefined` —— `toolSemanticsOf` 是注入的函数，`.length` 是形参个数，恒为 `"1"`。同时 `retryPolicyHash`（`:893`）与 sandbox 相关字段被写入快照，但漂移判定只比较 `contextPolicyHash`（grep `retryPolicyHash` 全仓仅写入点与类型定义）。
- **影响**：替换工具语义表（改变工具安全语义）不会改变指纹，resume 时静默沿用新语义；`sandboxPolicy` 变更同样不参与判定。漂移门禁覆盖的配置面远小于其宣称。
- **建议**：对工具语义表做真实 `stableHashOf`；把 retry/sandbox 哈希纳入判定并按 severity 决定 reject 或发事件。
- **复核**：**【Lead 已复核】** `:895` 表达式确认。

### EXT-001（D/P1）transport `close()` 不 settle 在途请求

- **位置**：`packages/gateway/src/stdio-transport.ts:160-163`
- **事实**：`close()` 只做 `this.pending.clear()` 与 `this.peer = undefined`。`pending` 存的是各请求的 `resolve` 函数（`:149-152` 可见），清空后对应 Promise 永不 settle。
- **影响**：关闭网关时有在途 RPC 的调用方永久挂起（进程不退出、超时机制失效），属资源泄漏型。
- **建议**：`clear()` 前遍历并对每项 reject 一个 `TRANSPORT_CLOSED` 结构化错误；补"close 后 inFlight=0 且所有等待方都收到 rejection"的单测。
- **复核**：**【Lead 已复核】** `:160-163` 与 `:149-152` 确认。

### EXT-002（D/P1）证据链自带脱敏只覆盖 3/11 类密钥

- **位置**：`packages/evaluation/src/gate-evidence-v2.ts:403-411`（写入点 `:521-530`）
- **事实**：该文件自带一份 `redactSecrets`，只覆盖 `*_API_KEY`、`sk-`、JWT 三类；而 `packages/security/src/secret-gate.ts:52` 的 `SECRET_PATTERNS` 有 11 类。缺失 8 类：AWS access key、GitHub token、Slack token、Stripe key、Google API key、private key、Bearer token、DB 连接串。
- **影响**：该文本被写入 `evidence/*.log` 并参与 sha256 计算——**未脱敏的真实密钥可能落盘并被固化进证据链**，事后清理还要重算哈希。
- **建议**：删除本地实现，改用 `@ar/security` 的 `redactSecrets`（注意其签名返回 `{content, redacted}`）；补 11 类样本各一条的落盘断言用例。
- **复核**：**【审查员证据】**（Lead 未逐类比对两份模式表）。

### SCF-001（D/P1）整个包不在类型检查工程图内

- **位置**：`tsconfig.json:1-27`
- **事实**：`packages/orchestration` 既不在根 `references` 中，也无任何包依赖它 ⇒ `tsc -b` 工程图完全不含它，`pnpm typecheck` / `pnpm build` 对该包 8 个源文件零检查。只有发布打包器 `scripts/release/portable.mjs`（按 workspace inventory 枚举）才会构建它。
- **影响**：仓库**唯一的静态检查**对整个包失效。`docs/gen1-release-comparison.md:79` 记录过同一根因已让发布构建拒绝过一次，当时只修了打包器没修 references。
- **建议**：把 `{"path":"./packages/orchestration"}` 加入 references；CI 增加 `tsc -b --dry` 的项目列表与 `packages/*` 目录集合的比对（防止再次漂移）。
- **复核**：**【Lead 已复核】** `tsconfig.json` 全文 references 中不含 `orchestration`。

### AST-01（D/P1）漏钉 `eol=lf` 导致已提交证据哈希不可复现

- **位置**：`.gitattributes`（缺 `benchmarks/coding-repositories-v1/**` 规则）+ `benchmarks/coding-repositories-v1/upstream-seeded.json`
- **事实**：该文件被 `benchmarks/.../upstream-tasks.py:71` 以 `read_bytes()` 计算 `catalogSha256`，并写入 8 份已提交证据。`.gitattributes` 对 `benchmarks/results/**`、`scripts/benchmark/fixtures/**` 都钉了 `text eol=lf`，唯独漏了这一处。审查员实测：工作区文件已被 CRLF 检出（5,609 B，`d5498cc8…`），blob 是 LF（5,471 B），LF 归一化哈希 `db483652…` 恰好等于 `final-4ee21776` 记录的 `catalogSha256` —— 既证明缺陷，也证明修法。
- **影响**：任何 autocrlf 环境的检出重跑都产出不匹配的哈希；而"哈希不匹配"在这类证据链里会被读成"产物被篡改"。
- **建议**：追加 `benchmarks/coding-repositories-v1/** text eol=lf`（并评估 `benchmarks/r98-fixtures/**`）；把"按 raw bytes 读取的 fixture 必须有 eol 钉"写进检查脚本（仓库已有 R12/R94 两次同模式修复记录，可复用其检查点）。
- **复核**：**【Lead 已复核】** `.gitattributes` 现有 benchmark 相关规则仅 3 条，均不含 `coding-repositories-v1`。

---

## 4. 横切主题（跨分片的系统性缺陷）

分片审查容易只看到局部。把 155 条发现按"为什么会发生"重新聚合，得到 7 个系统性主题——它们比单条发现更值得优先处理，因为修一条只会让同类换个位置再犯。

### 主题 1：门禁空转——校验存在，但生产路径绕开它

涉及：PKG-001、PKG-002、PKG-003、SCF-001、CLI-001、EXT-005

六条 P1 里有五条是同一形态。共同点：**校验代码写得对、单元测试也覆盖了，但触发条件在生产里永不成立**。

| 门禁 | 声称的作用 | 实际触发条件 | 生产是否触发 |
|---|---|---|---|
| `CONFIG_DRIFT_REJECTED` | 配置漂移时拒绝 resume | 需要 state snapshot 里已有 fingerprint | 仅"曾经 load 过"的会话 |
| `flushThrough` 存在性校验 | ack 前确认事件已落盘 | `sequence !== MAX_SAFE_INTEGER` | 否（唯一调用点传哨兵） |
| `toolSemanticsHash` 漂移 | 工具语义变更告警 | 需要哈希不同 | 否（恒为 `"1"`） |
| `tsc -b` 类型检查 | 全仓类型正确 | 包必须在 references 图内 | 否（orchestration 缺席） |
| 发布门禁第 9 步 | Windows 能力审计产物 | `execFile("pnpm")` 成功 | 否（ENOENT） |

这类缺陷的隐蔽性来自一个错觉：**测试通过 ≠ 门禁生效**。现有测试大多手工构造触发条件（如 `config-wiring.test.ts:123/:134` 先手动 `freezeConfigFingerprint()`），而不是走生产入口。建议后续所有门禁类修复都补一条"从真实入口进入"的用例。

### 主题 2：清单手写多处，必然漂移

涉及：SCF-001（tsconfig references）、SCF-006（CI 硬编码 33 个测试路径）、AST-01（`.gitattributes` 钉）、CLI-007（`doctor.ts:40` 硬编码 `EXPECTED_BUILTIN_TOOLS = 11`）、SCF-016（`verifyDepsBeforeRun` 两处配置）

这五处的共同点：**同一事实被写死两次以上，改一处不改另一处，系统不会报错，只会静默失效**。

- `doctor.ts` 用 `EXPECTED_BUILTIN_TOOLS = 11` 而不是与 `main.ts:45` 的 `BUILTIN_TOOLS` 集合比较 ⇒ 等量替换工具（删一个加一个）不会被发现。
- `windows-acceptance.yml:60` 单行硬编码 33 个测试文件路径 ⇒ 新增回归测试不改这一行就永远不进 Windows 门禁。
- `.gitattributes` 逐个目录手写 eol 钉 ⇒ 新目录默认无钉（AST-01 就是漏的那个）。

统一修法：**把清单变成派生量**。references 从 `pnpm-workspace.yaml` 派生、CI 测试清单从 `vitest --reporter=json` 派生、eol 钉按"是否被 raw-bytes 读取"派生、内置工具数从常量集合派生。

### 主题 3：同一逻辑多份实现，且分叉后语义不一致

涉及：EXT-011（跨包同名实现 9 组）、EXT-012（原子写 5 份）、PKG-021（`stableStringify` ×3、`hashOf` ×3 不同算法）、WEB（durable JSON 写入 7 份、入参校验 4 套）、EXT-002（脱敏 2 套）

最典型的是 `hashOf`：`packages/harness` 内部就有 3 个不同实现——`config-layers.ts:60` 用 djb2 32 位、`compose-mcp.ts:133`、`workspace-manager.ts:322` 各不相同，**同名不同算法**。读代码时极易误判"指纹同源"，而指纹恰恰是漂移判定的依据（见主题 1）。

EXT-012 的原子写 5 份更直接：其中 `paired-executor.ts:334` 的注释写着"Windows 上 rename 覆盖会失败，所以先删目标"，而另外 4 份没有这段处理 ⇒ 同样的操作在 Windows 上行为不一致。

统一修法：可共享的收敛到 `@ar/contracts`（纯类型）与 `@ar/security` / `@ar/core`（实现）；短期至少在每个重复点加交叉引用注释，避免继续分叉。

### 主题 4：静默失败与静默降级

涉及：CLI-002（flag 值被当位置参数、`--mode` 非法值降级 stub）、EXT-005（`experiment-harness.ts:31-52` 用 `Math.random` 伪造 passRate/latency/tokens 且 `status:"completed"`、报告无 simulated 标记）、WEB（`server.ts:284` + `host-tools.ts:18` 用 `??=` 缓存 rejected Promise ⇒ 一次瞬时失败后插件清单/建会话永久失败到重启）、PKG（`saveStateSnapshot` 盲 UPSERT 无 CAS 而 freeze/setSessionModel 是读-改-写 ⇒ 并发丢更新）

这一组不是"会崩"，而是"崩得看不出来"。EXT-005 尤其值得单独说明：`packages/evaluation/src/experiment-harness.ts` 的默认 benchmark 会生成**看起来完全正常的完成报告**，并经 `index.ts:8` 导出为包的公开 API。任何人拿它做一次冒烟测试都会得到"全部通过"的结论。

统一修法：所有降级路径必须留下结构化标记（`simulated: true`、`degraded: true`）并进事件流；缓存失败结果要带 TTL 或显式区分"未初始化"与"失败"。

### 主题 5：无界增长与热路径 I/O

涉及：WEB-020、WEB-021（25ms 轮询做全量扫描）、EXT-008（`memory` 只有 30 天 stale 标记、无物理删除，`memories` + `memories_fts` 无界增长）、EXT-009（`gateway/src/rpc.ts:321-324` 的 `trace.get` 与 `:179` 的 `thread/list` 无分页无上限；`observability/src/trace-exporter.ts:282,299` 全量事件 join）

共同形态：**功能在小数据量下完全正确，只在"用久了"之后暴露**。这类问题最难在代码审查里靠阅读发现，需要显式设上限（分页参数、保留策略、增量游标）。

### 主题 6：运行产物与生成物入库

涉及：AST-02 ～ AST-13（12 条：运行产物入库与体积分布）、SCF-009（`.pyc` 被跟踪）、LEA-01（`.trae` zip）

`docs/evidence` 独占 243.5 MB（`docs` 的 96.1%）：698 个 PNG（31.8 MB）、112 个 SQLite `.db`（5.5 MB）、1,122 个 `.log`（6.4 MB）、88 个零字节文件。另有 99 组同尺寸文件（仅 4 组做了 sha256 确认，其余不能按长度删）。

**但必须强调反证**（这是本次审查里最容易误伤的地方）：`tarballs/*.tgz` 67 个（13.7 MB）是 `deepseek-frontend-vendor.mjs:92-93` 的哈希断言输入；`harness-brand/plugins/**` 10 个衍生登记在 `provenance.json`；`legacy/{app.js,style.css}` 是 `web-branding-browser.mjs:115` 的冻结夹具；`benchmarks/results`、`baseline-e4-r74`、`coding-repositories-v1` 均有活引用。**按体积清理会破坏证据链**。可行的止血点是"新产物不再入库"（`.gitignore` + 归档策略），而不是回头删历史。

### 主题 7：文档与事实漂移

涉及：SCF-003（`HANDOVER.md:3` 声称的当前计划文件不存在，且"没有悬空 plan.md"为假——实有 `plan.md` + 21 个 `plan(...).md`）、SCF-004（`CAPABILITY_MATRIX.md/.json` 快照 `gitSha=27f7045e`、`generatedAt=2026-08-26`，落后 HEAD 两个月却仍充当能力面索引）、SCF-014（根目录 22 个 `plan*.md` + `tasks/` 63 个 md 无索引）、AST-16（`provenance.json` 的 `sourceRelationship` 缺谓语）

这类问题单条看是"文档没更新"，合起来看是**仓库的自我描述不可信**：新接手者按 `HANDOVER.md` 找不到计划、按 `CAPABILITY_MATRIX.md` 读到两个月前的快照、在根目录 22 个 plan 文件里猜哪个是当前的。建议：`HANDOVER.md` 改为只记录"指针 + 生成方式"不记录事实；`CAPABILITY_MATRIX` 加 `generatedAt` 与 HEAD 的一致性校验或直接移出版本控制。

---

## 5. 分模块发现总表（155 条）

> 说明：以下按分片列出全部发现，每片内按 P1 → P2 → P3 排序。列含义见 §1.2。表中「文件:行」为相对仓库根的路径（WEB 分片为相对 `apps/web/src`）。建议做法一列均来自审查员，Lead 未改动其技术判断，仅统一了格式。

### 5.0 Lead 直属追加（2 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| LEA-01 | `.trae-html-share-packages/apps/web/public/index.html.zip:1` | 外部工具（Trae）的 HTML 分享产物被提交进仓库（7,225 B），提交信息是 `feat: 编写 harness-agent 下一步计划文档`（1299e5cb / 67ded229 / 90a7add4 三次提交均涉及）。zip 内含 `apps/web/public/app.js`(14,936 B)、`index.html`(1,172 B)、`style.css`(6,112 B) 的旧快照。全仓零引用，`.gitignore` 无任何相关规则 | C | P2 | `git rm` 该文件与 `.trae-html-share-packages/` 目录；`.gitignore` 追加 `.trae-html-share-packages/`。提交前建议加一道"检查跟踪文件里是否含 `.zip`/`.tar.gz` 等打包产物"的 CI 步骤 |
| LEA-02 | `apps/web/public/deepseek/licenses/shell-reference/notice-files/node_modules/**`（250 个跟踪文件） | 250 个路径中带 `node_modules/` 的被跟踪文件，初看像"把 node_modules 提交了"。逐一核对后确认：全部是第三方许可证正文（`@babel/*`、`@types/*` 等的 `LICENSE`），是 license 归档的合法组成 | B | P3 | **不要删除**。建议在 `licenses/README` 或 `provenance.json` 中显式说明"此处 node_modules 路径是许可清单的目录结构复刻"，避免后续审查者误判为误提交 |

---

### 5.1 apps/web/src（54 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| WEB-020 | `deepseek/events.ts:53-77` | 每个 `$events` 流每 ~25ms 遍历所有会话 + 全量日志求 pending | D | P1 | 改为事件驱动（appendNew 后置脏标记）+ 维护 pending 索引 |
| WEB-021 | `deepseek/session.ts:443-455` | `session/control` 每 25ms 对每个会话全量重投影（含 host tool 读文件） | D | P1 | `projectUnlocked` 改为按 sourceSequence 增量投影；缓存 baseline 并在无新事件时跳过 `meta()` 读盘 |
| WEB-039 | `bindings.ts:41-50` | 最弱的一份 durable 写：固定 .tmp、跟随符号链接、无校验 | D | P2 | 直接用 `@ar/store-integrity` 的原子写（与 metadata.ts:112-130 同款） |
| WEB-034 | `deepseek/{activity.ts:517,events.ts:285,catalog.ts:65,projections.ts:597}` | JSON 值校验手写四遍，深度上限 20/30/无/无 | A | P2 | 合并到 `@ar/contracts` 的单一 `assertJsonValue(value,{maxDepth})` |
| WEB-032 | `deepseek/activity.ts:181-249` | 每 tick 全量 read + 每 task 单独 mutate 同一文件 | A | P2 | 收集到期 task 一次性 mutate |
| WEB-033 | `deepseek/catalog.ts:55-71 · files.ts:21-37 · coding-status.ts:5-6 · events.ts:53-77` | 入参校验 helper 四套并存，错误码不一致 | A | P2 | 合并为一个 `wire-validation.ts`，全包统一错误码 |
| WEB-017 | `deepseek/composition.ts:204` | 第二次读取 boot-manifest，无 symlink/尺寸/schema 校验 | A | P2 | 复用 server 的 `loadBootGraph` 或抽公共 loader，统一校验 |
| WEB-018 | `deepseek/composition.ts:35-271` | 单函数 236 行装配全部服务并猴补事件总线 | A | P2 | 拆为 `configureOwners` / `configureActivity` / `configureHttp` 三段，装配层只做顺序编排 |
| WEB-042 | `deepseek/deliverables.ts:210-250` | 每 turn 两次全工作区遍历+全量 sha256 | D | P2 | 复用文件监视/变更缓存，只对 mtime 变化的子树重新 hash |
| WEB-043 | `deepseek/deliverables.ts:239-243` | `summaries` 只增不减，常驻完整 hunks | D | P2 | 以 LRU（如最近 50 个 turn）淘汰，或落盘并在读取时回查事件 |
| WEB-037 | `deepseek/files.ts:204-209` | 两套 ToolResult 解包，取消被报成 `gateway/internal` | A | P2 | 只保留 `toolValue`，`readTool` 改为委托 |
| WEB-047 | `deepseek/host-tools.ts:101-110` | 无 session 参数即可对任意绝对路径列举/建目录 | D | P2 | 由用户手势签发一次性 capability（路径 + 有效期），而不是以“无 session”当凭据 |
| WEB-041 | `deepseek/metadata.ts:84` | requests/answers 只增不删，超 32MB 后元数据永久不可读 | D | P2 | 按 session 保留最近 N 条回执，或超限时归档而非永久抛错 |
| WEB-013 | `deepseek/owners.ts:558-562` | 只重映射 6 个顶层 id 字段，嵌套 payload 里的 native id 泄漏 | D | P2 | 递归重映射，或约定“payload 只允许顶层 id 字段”并加运行时校验 |
| WEB-015 | `deepseek/owners.ts:681-688` | 每条 prompt 状态迁移全量扫 owner×session×inbox | A | P2 | 维护 promptId→owner 的内存索引，写入时更新 |
| WEB-023 | `deepseek/projections.ts:133-432` | 单函数 300 行 + 20 个可变闭包状态 | A | P2 | 抽出 `AttemptState`/`EmitBuffer` 两个类 + 事件处理表；用现有 projections.test.ts 保行为 |
| WEB-024 | `deepseek/projections.ts:272` | 每条 tool 消息线性 `find` → O(n²) | A | P2 | 预建 `callId → owner message` 索引 |
| WEB-008 | `deepseek/routes.ts:35-50` | provider 包装对象上调用 `#private` 方法会抛 TypeError | D | P2 | 用 Proxy 转发调用（保持 this 为原实例），或要求 provider 提供显式 `identity` 访问器 |
| WEB-030 | `deepseek/session.ts:266-267,432-459` | 端点表分散三处，新增端点需改 3 处 | A | P2 | 单表驱动（method → handler 映射表） |
| WEB-022 | `deepseek/session.ts:471-485` | `session/follow` 每 25ms 全量重投影 + 逐条 JSON.stringify 比较 | D | P2 | 只对新增 sourceSequence 增量投影 |
| WEB-053 | `deepseek/socket.test.ts:59 等 6 处` | 固定次数轮询等待副作用，慢机必挂 | D | P2 | 统一为基于 deadline 的 `awaitUntil` |
| WEB-012 | `deepseek/transport.ts:101-107` | `stop()` 的 `Promise.all` 一个失败即整体失败且被永久缓存 | D | P2 | `allSettled` + 聚合错误；缓存成功结果、失败可重试 |
| WEB-044 | `deepseek/workspace.ts:99-105,167` | `workspace/follow` 每 350ms 全量 listSessions + host tool 读元数据 | D | P2 | 用事件驱动（appendNew 后置脏位）替代轮询，至少把 revision 缓存住 |
| WEB-040 | `metadata.ts:112-130 等 6 处` | 同一套原子写复制六份，硬化集合各不同 | A | P2 | 抽 `writePrivateJson(path, value, {maxBytes})` 到 `@ar/store-integrity` |
| WEB-002 | `server.ts:215-227` | `stop()` 前三个 await 无保护，reject 即跳过后面的清理 | D | P2 | 逐步 try/`Promise.allSettled`，最后聚合抛错 |
| WEB-001 | `server.ts:284 · deepseek/host-tools.ts:18` | `??=` 缓存 rejected Promise → 永久 404 / 永久建会失败 | D | P2 | 在 catch 中清空缓存字段，或缓存已解析的值 |
| WEB-006 | `server.ts:34-49` | `STATIC_FILES` 硬编码 12 项，与 public 实际资源脱钩 | A | P2 | 启动时校验 public 清单，或用构建期生成的 manifest |
| WEB-007 | `server.ts:601-615` | 全局单链串行化所有发送方的消息投递 | D | P2 | 按 `msg.from`（或 session）分桶串行，桶间并行 |
| WEB-052 | `15 个测试文件` | tempdir+cleanup 样板重复 15 处 | A | P3 | 抽 `tempDir(t, prefix)`（内部注册 afterEach 清理） |
| WEB-051 | `7 个测试文件` | `createRuntimeRpc` 四键字面量重复 ≥7 处 | A | P3 | 抽 `rpcFor(harness)` 到共享 `test-fixtures.ts` |
| WEB-049 | `adapter.ts:23` | `nextMessageId` 死字段 | C | P3 | 删除 |
| WEB-036 | `deepseek/catalog.ts:305-333` | 每次 `modelCatalog` 都发全 provider 网络请求 | D | P3 | 加短 TTL 缓存 |
| WEB-035 | `deepseek/catalog.ts:356` | 模型发现失败被吞成通用错误，无日志无原因 | A | P3 | `[degraded]` 日志 + 区分网络/状态码/解析失败 |
| WEB-019 | `deepseek/composition.ts:220-228 · workspace.ts:108-117 · deliverables.ts:275-276` | 祖先/后代闭包 while 扫描写三遍 | A | P3 | 抽一个 `descendants(sessions, root)` 单遍实现 |
| WEB-027 | `deepseek/events.ts:196,203` | `deliveries` 只增不减，长连接内存无上限 | D | P3 | 结算并确认客户端已读后删除条目 |
| WEB-038 | `deepseek/files.ts:79 · deliverables.ts:16` | 敏感文件名正则逐字重复两份 | A | P3 | 提到 `@ar/security` 或单文件常量 |
| WEB-048 | `deepseek/host-tools.ts:24-53` | orchestrator 缓存只增不删 | D | P3 | 给 projectOrchestrators 设上限或按 owner 回收 |
| WEB-016 | `deepseek/owners.ts:565-573` | `projectEvent` 静默丢弃未知 native id，无日志 | D | P3 | 丢弃时打 `[degraded]` 日志或断言 |
| WEB-014 | `deepseek/owners.ts:574-582` | `journalCoordinate` 重复 `ownerOf` 全扫描 | A | P3 | 复用第一次结果 |
| WEB-026 | `deepseek/projections.ts:293,366,438,534` | 一致性失败抛裸 Error，无 code | D | P3 | 改 `RemoteFailure("session/history-invalid")` 并保留原因 |
| WEB-025 | `deepseek/projections.ts:326` | 每步重算 step 序号 O(steps²) | A | P3 | 维护 per-turn 计数器 |
| WEB-009 | `deepseek/routes.ts:57-70` | 路由包装只保留 `generate`，其它可选成员丢失 | A | P3 | 显式枚举并转发所需成员 |
| WEB-054 | `deepseek/session.test.ts:266 等 6 处` | 固定睡眠窗口断言“没发生” | D | P3 | 用可控时钟或显式同步点后再断言 |
| WEB-029 | `deepseek/session.ts:122-123` | 列表页每会话重复读两遍同一 journal | A | P3 | 复用 projectUnlocked 的读取结果 |
| WEB-031 | `deepseek/session.ts:125` | `Math.max(...)` 展开超大数组会 RangeError | D | P3 | 用 reduce |
| WEB-028 | `deepseek/session.ts:315-330` | `toLocaleLowerCase` 变长映射使搜索偏移错位 | D | P3 | 用 `toLowerCase()` 或按 code point 建索引 |
| WEB-045 | `deepseek/terminal.ts:37,67,110` | 终端 tombstone/外层 map 只增不减 | D | P3 | 会话关闭时整体回收；tombstone 加上限 |
| WEB-046 | `deepseek/terminal.ts:42` | Windows 默认 shell 仍是 PowerShell 5.1 | A | P3 | 候选表加 `pwsh.exe` 并优先 |
| WEB-011 | `deepseek/transport.ts:162` | 200 + 魔法键帧表达流式错误 | A | P3 | 导出共享常量并纳入协议测试 |
| WEB-010 | `deepseek/transport.ts:54-66` | `wireDecode` 递归无深度上限 | D | P3 | 加 depth 参数上限 |
| WEB-050 | `main.ts:85-90` | 失效 binding 直接终止宿主启动 | D | P3 | 无效绑定改为跳过并 `[degraded]` 日志，而不是拒绝启动 |
| WEB-005 | `server.ts:566-575` | 唯一静默 catch；失败后重连会重放历史 assistant 消息 | D | P3 | 至少补 `[degraded]` 日志；无法判定时让调用方走“全量快照”而非“增量重放” |
| WEB-003 | `server.ts:653-659` | 静态资源缓存分支缺 nosniff | A | P3 | 抽统一的 `writeAssetHead()` |
| WEB-004 | `server.ts:689-695` | `readJson` 的类型错误被 catch 覆盖成 "invalid JSON body" | A | P3 | 类型校验移出 try |

### 5.2 apps/cli（15 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| CLI-002 | `apps/cli/src/commands.ts:402` | `champion eval` 用 `rest.slice(1).filter(a => !a.startsWith("--"))` 取位置参数，**不跳过 flag 的值**：`champion eval --mode real-model a.json b.json` 会得到 `baselinePath="real-model"`、`candidatePath="a.json"`（静默读错文件）；另 `--mode` 非法值被 `? "real-model" : "stub"` 静默降级为 stub | D | P1 | 改成与 `benchmark` 一致的显式循环（`i++` 跳过值），并把 `--mode` 的值域校验为 `stub&#124;real-model`，非法值 `exitCode:1` + usage |
| CLI-001 | `apps/cli/src/release-artifacts.ts:190` | `capability_audit` 门禁命令声明为 `["pnpm","capability:audit"]`，而执行器用 `execFile(shell:false)`；Windows 上 `pnpm` 只有 `pnpm.cmd` 垫片，必然 `ENOENT` → 第 9 步永远 `produced:false`，`collectReleaseArtifacts().ok` 在 Windows 恒为 false | D | P1 | 该门禁改用 `["node","apps/cli/dist/main.js",...]` 或 `process.execPath`；若必须调包管理器，在执行器里对 win32 解析 `.cmd` 垫片（`where pnpm` 后走 `cmd.exe /c`）并单测覆盖 |
| CLI-010 | `apps/cli/src 全域（108 处）` | `as any` / `as never` / `@ts-expect-error` 共 108 处（其中 `commands.ts:352` `rollbackChampionState(current, { targetLevel: target as never, … })`、`e2-command` 附近的多处 `as never` 掩盖了真实的联合类型收窄） | D | P2 | 优先收敛 `as never`（它比 `as any` 更危险：等于告诉编译器"任何类型都行"）；对 `targetLevel` 这类先做 `readonly CHAMPION_LEVELS` 的 `includes` 收窄 |
| CLI-004 | `apps/cli/src/audit.ts:1333、benchmark-command.ts:1122、e4-09-diagnostics.ts:170、observation-evidence.ts:429、prereg-arm-executor.ts:369(+428 的 `git(dir,…)` 助手)、prereg-production-runner.ts:146、release-command.ts:41` | `git rev-parse HEAD` 获取 HEAD 的生产代码实现**共 7 处**（另 `scripts/paired-to-v3.mjs:69` 第 8 处），超时/编码/失败语义各不相同（有的 5s timeout、有的无超时、有的返回 null、有的抛） | A | P2 | 收进一个 `git-head.ts`：`readHead(cwd, {timeoutMs}) => {sha&#124;null, error}`，7 处调用点替换；测试内的重复用于独立验证，保留 |
| CLI-006 | `apps/cli/src/benchmark-command.ts:1-4001、prereg-arm-executor.ts:1-2125、prereg-execution-identity.ts:1-1524、audit.ts:1-1362、e4-r55-child-harness.ts:1-1131` | 5 个文件超过 1000 行（最大 4001 行），且没有按职责拆分的边界：`benchmark-command.ts` 同时含 CLI 解析、套件目录、执行编排、评分、产物落盘、`--out` 渲染 | A | P2 | `benchmark-command.ts` 至少切成 `benchmark/argv.ts`、`benchmark/execute.ts`、`benchmark/score.ts`、`benchmark/artifacts.ts`（现有 `runBenchmarkCommand` 与 `executeBenchmark` 的边界就是天然切口）；其余 4 个按"身份/执行/诊断"拆 |
| CLI-005 | `apps/cli/src/commands.ts:403-408、release-command.ts:227/376、release-verify.ts:203-…、prereg-command.ts:223、benchmark-command.ts:3433、audit.ts:1381` | 参数解析存在两套风格：`rest.indexOf("--x")` + `filter` 共 **12 处**、显式 `for (let i…)` 循环 **6 处**；两者都**不支持 `--flag=value`**；`--evidence-dir` / `--out` 等出现在参数末尾且缺值时静默取默认值（不报错） | A | P2 | 抽一个 `parseFlags(argv, spec)`（`{name, type:"string"&#124;"boolean", required?}`）：统一 `--flag value` 与 `--flag=value`、缺值即 usage+exit 1、未知 flag 报错。12 处 `indexOf` 风格优先迁移 |
| CLI-007 | `apps/cli/src/doctor.ts:40、141、145` | `const EXPECTED_BUILTIN_TOOLS = 11` 硬编码个数，而 `main.ts:45` 是 `BUILTIN_TOOLS = PRODUCTION_TOOL_NAMES`（来自 `@ar/tools`）。只要"换一个工具但总数不变"，`doctor` 依然报 OK；工具集增删还必须手工同步常量 | A | P2 | 改为引用 `PRODUCTION_TOOL_NAMES` 做**集合比较**（缺哪个、多哪个都报），计数只用于展示 |
| CLI-008 | `apps/cli/src/main.ts:154-160` | `extractDataDirFlag` 解析失败时 `writeLines([msg], 1)` 写的是 **stdout**，而顶层 `main().catch` 写 **stderr**；脚本化调用（`agent --data-dir` 拼错）无法用 `2>` 捕获错误 | A | P2 | 错误统一写 stderr；建议 `CommandResult` 增加 `errLines`，`main` 统一分流 |
| CLI-011 | `apps/cli/src/n1-worker-lifecycle.test.ts:199、e4-r55-failure-wiring.test.ts:929、r0-f8-formal-budget-cancel-gaps.test.ts:562、cli.test.ts:587` | 固定睡眠 4 处（最长 `await sleep(3000)`），另有 78 个测试文件各自 `mkdtemp` 手搓夹具，其中 `n2-release-cli-forward.test.ts` 建了临时目录却无 `rm` 清理（另 1 个同型）；`e4-r46-diagnostics-noclobber.test.ts:53/127` 用 `rm(...).catch(()=>{})` 吞掉清理失败 | D | P2 | 固定睡眠换成"轮询直到条件成立 + 上限"（`waitFor(fn,{timeoutMs})`）；`mkdtemp` 收进一个 `makeTmpDir(t)` 助手，统一在 `afterAll` 清理；`catch(()=>{})` 至少 `process.stderr.write` 一行 |
| CLI-015 | `apps/cli/src/prereg-arm-executor.ts:1399、1502、1895、1918-1966、2006-2026、2084` | 手写 `Promise.race([work, sleep(ms)])` + `child.kill()` + `clearTimeout` 组合共 5 组（工作进程超时、清理宽限、退出宽限、信号中继），每组的超时常量与清理顺序都不同，`2084` 的错误文案需要人工与 `opts.timeoutMs` 对齐 | A | P2 | 抽 `raceWithDeadline(work, {ms, onTimeout})` 与 `killAndWait(child, {graceMs})` 两个助手，5 处替换；超时常量集中为一张表 |
| CLI-003 | `apps/cli/src/release-command.ts:322` | `execFileSync(cmd.join(" "), { shell: true })`：把参数拼成字符串交给 shell，含空格/引号/`&` 的参数会被重新解释（路径含空格或注入面），且与 `packages/evaluation/src/gate-evidence-v2.ts:590` 刻意采用的 `execFile(argv, shell:false)` 策略直接矛盾 | D | P2 | 统一走 argv + `shell:false`；Windows 垫片问题按 CLI-001 的方案在**执行器层**解决，而不是把命令拼成字符串 |
| CLI-013 | `apps/cli/scripts/paired-to-v3.mjs:69-72` | 用 `execSync("git rev-parse HEAD")` / `execSync("git status --porcelain")` 字符串形式（走 shell），与仓库内其余处一律 argv + 无 shell 的做法不一致；`catch { /* not a git repo */ }` 静默把 `dirty` 置 true | A | P3 | 改 `execFileSync("git",["rev-parse","HEAD"])`；catch 里补一行 stderr 说明降级原因（`dirty=true` 是安全方向，保留） |
| CLI-016 | `apps/cli/src/chat-command.ts:54` | `history.filter(m => m.role === "user" &#124;&#124; m.role === "assistant" && m.content)`：`&&` 优先级高于 `&#124;&#124;`，当前语义（user 全收、assistant 仅非空）靠优先级碰巧正确 | A | P3 | 加括号显式化 |
| CLI-014 | `apps/cli/src/e4-09-diagnostics.ts:170、n2-forward-fixture.ts:76` | 诊断/夹具路径用 `execFileSync` 同步调 git 且无超时（`e4-09-diagnostics.ts:170` 只给 cwd/encoding），在慢盘或 git hooks 挂住时会阻塞整个进程 | A | P3 | 统一走 CLI-004 的 `readHead(cwd,{timeoutMs:5000})` |
| CLI-012 | `apps/cli/src/prereg-fixture-checkout-grant.test.ts:333、-trust.test.ts:311` | Windows 无法创建符号链接（EPERM）时用 `ctx.skip()` 跳过整例，容错路径被当作正常路径，Windows 上这两个安全用例**从不真正执行**且报告为 skipped 而非失败 | B | P3 | 暂时不动：CI 需保留"能建链的宿主"上的真实覆盖，本地环境无法建链属于真实限制。改进方向：skip 时写入一条可见的降级标记（例如把 skip 原因计入 observation 证据），避免"绿着但没跑" |

### 5.3 packages/ 运行时底座（29 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| PKG-003 | ``packages/core/src/runtime/runtime.ts:895` / `:2023-2034`` | `toolSemanticsHash` 取 `String(this.toolSemanticsOf.length)`，即**函数形参个数**（恒为 `"1"`）而非哈希；且 `resolveAgent` 只比较 `contextPolicyHash`，`retryPolicyHash`/`sandboxPolicyHash` 存了从不比较，漂移只发一条 `policy.changed_on_resume` 事件、不阻断 resume | D | P1 | 对 tool semantics 表做真实 `stableHashOf`；把 retry/sandbox 哈希纳入漂移判定并按 severity 决定 reject/事件 |
| PKG-001 | ``packages/harness/src/create-harness.ts:741` / `:842`` | 配置漂移基线只在 `sessions.load` 成功后冻结；`createSession` 不冻结 → 会话创建后、首次 load 前改配置，基线被冻结为"新配置"，漂移永不触发 | D | P1 | `createSession` 成功后立即 `freezeConfigFingerprint(id)`（或建会话时把 fingerprint 写进 state snapshot），并补"创建→改配置→首次 load"用例 |
| PKG-002 | ``packages/store/src/sqlite-runtime-store.ts:460-468` + `packages/core/src/runtime/runtime.ts:983`` | `flushThrough` 在 `sequence === Number.MAX_SAFE_INTEGER` 时**跳过存在性校验**，而 runtime 唯一调用点恰好传 `Number.MAX_SAFE_INTEGER` → 生产路径上的持久化栅栏不做任何校验 | D | P1 | 让 runtime 传真实已提交序号（`lastEvent.sequence`），或删掉哨兵分支并让 store 用"MAX(sequence)"语义校验 |
| PKG-028 | ``packages/core/src/runtime/r87-zero-call-replay-ab.ts`` | 1878 行，只被 `r87/r88/r93` 三个测试引用（另有 evaluation 注释提及）；并 import 了 core 的 **devDependency** `@ar/model` | C | P2 | 移出 `src`（放 `bench/` 或 `test/fixtures/`），避免 core 生产目录携带仅测试可用代码 |
| PKG-017 | ``packages/core/src/runtime/runtime.ts:1925-1930`` | `wallClockExceeded` 用 `now() - turn.startedAt`（含用户等待时间），而 `RunBudgetTracker` 用 active time → 恢复的 paused turn 可能被 wall-clock 提前判超时 | D | P2 | 统一到 active-time 语义，或对 paused 区间做扣减 |
| PKG-026 | ``packages/core/src/runtime/runtime.ts:2-3`` | `mkdir`/`writeFile`/`dirname`/`join` 四个 import 在文件正文零使用（grep 该文件仅命中第 2-3 行） | C | P2 | 删除这 4 个 import |
| PKG-016 | ``packages/core/src/runtime/runtime.ts:558`` | `pausedTurns: Map<TurnId, …>` 只在非 `waiting_for_user` 结局（:965）或 `releasePausedTurn`（:1018-1021）删除；被 park 且永不恢复/永不取消的 turn 永久驻留 → 无上限增长 | D | P2 | 给 entry 加 `createdAt`，超时或会话 close 时清理；或用有界 LRU |
| PKG-020 | ``packages/core/src/runtime/runtime.ts:586-819`、`:1025-1350`、`:1494-1721`` | 三个超长函数：构造函数 234 行（装配 5 个 controller）、`runTurnCore` 约 325 行（主循环）、`handleToolResults` 约 228 行（两阶段结果处理） | A | P2 | 构造装配抽 `buildControllers()`；`runTurnCore` 按 phase（budget/context/model/tools/results）再切；`handleToolResults` 的 Phase1/Phase2 拆成两个方法 |
| PKG-027 | ``packages/core/src/state/projections.ts`` | 全仓唯一引用者是同目录 `projections.test.ts`；且**不在** `packages/core/src/index.ts` 导出面 → 生产不可达 | C | P2 | 确认是否有接线计划；无则删除或移入测试夹具 |
| PKG-007 | ``packages/harness/src/compose/compose-stores.ts:92-101`` | `appendHarnessEvent` 用 `events.append({…, sequence: 0, schemaVersion: 1})`：硬编码哨兵 sequence 与 ABI 字面量，违背 P26-1（调用方不得提供 sequence，须走 `appendNew`）；是生产代码里**唯一**的裸 `append` 违例 | D | P2 | 改为 `events.appendNew({…省略 sequence/schemaVersion})`；ABI 版本用 `EVENT_ABI_VERSION` 常量 |
| PKG-006 | ``packages/harness/src/config-drift.ts:173-182`` | P27-5 脱敏只按键名匹配 `SENSITIVE_KEY_PATTERN`；值里内嵌的密钥（URL userinfo、数组元素、连接串）原样写入 `policy.changed_on_resume` 事件 payload | D | P2 | 对字符串值再做一次模式扫描（`bearer`/`sk-`/`://user:pass@`），命中即整体替换为 `***` |
| PKG-018 | ``packages/harness/src/config-layers.ts:108-142`` | `environmentLayer` 把任意 `AGENT_*` 环境变量按 `__` 分段写入配置树（含 `AGENT_SANDBOX_POLICY__FILESYSTEM__MODE=full`），且该层在 session 冻结之前生效 → 纯环境变量即可放宽沙箱，不经过任何审批 | D | P2 | 环境层只允许白名单键（当前 `LIFECYCLE_RULES` 已有 lifecycle，可再加 allowlist 限制 `sandboxPolicy`/`permissions` 不可从 env 覆盖） |
| PKG-022 | ``packages/harness/src/config-layers.ts:175-189` vs `:20-28`` | 注释与 `ConfigLayerSource` 声明 `defaults → profile → system → user → project → environment → session → runtime` 八层，`buildConfigLayers` 只实现 defaults/profile/environment/session/runtime 五层；`system`/`user`/`project` 三个层源零实现 | A | P2 | 要么实现三层，要么从 union 与文档里删掉（当前文档承诺的优先级顺序不成立） |
| PKG-005 | ``packages/harness/src/config-layers.ts:49-57` + `packages/harness/src/config-drift.ts:91-100`` | `stableSerialize` 把函数序列化为 `[fn:<name>]`（匿名统一 `[fn:anon]`），`normalizeForComparison` 把所有函数统一成 `[[function]]` → 替换 provider/回调的**实现**（同名不同实现）检测不到，漂移漏报 | D | P2 | 对可序列化字段做深比较，函数字段单独标注为"实现不可比较"，出现该字段变化时降级为 `unknown` 方向（当前 `unknown` 已会 reject，但前提是 name 变了） |
| PKG-004 | ``packages/harness/src/config-layers.ts:60-66`` | 漂移指纹是 32 位 djb2（`(h>>>0).toString(16).padStart(8,"0")`），用作安全门禁（`CONFIG_DRIFT_REJECTED`）的唯一判定依据 → 可构造碰撞值使放宽后的配置与冻结值同指纹 | D | P2 | 改用 `node:crypto` sha256（截 16 hex 即可），或对关键子键（sandboxPolicy/limits/model）单独再做一次强哈希 |
| PKG-008 | ``packages/harness/src/create-harness.ts:768-775` + `packages/store/src/sqlite-runtime-store.ts:324-330`` | `saveStateSnapshot` 是盲 UPSERT（`ON CONFLICT DO UPDATE SET doc = excluded.doc`，无版本/CAS），而 `freezeConfigFingerprint` 与 `setSessionModel` 都是"读-改-写" → 并发可丢更新（可丢掉 `effectiveAgent` 快照或漂移基线） | D | P2 | store 增加 `compareAndSwapSnapshot(expectedRev)`；或把 fingerprint 拆成独立列/独立表，避免与整份 doc 抢写 |
| PKG-019 | ``packages/security/src/sandbox.ts:203-216`` | `allowedRoots()` 每次调用都重新 `canonicalizePath`（realpath IO）workspaceRoot + extraRoots + allowedPaths，而 `withinAllowedRoots` 每个文件决策都调用 → 每次判定 N 次同步 realpath 系统调用 | D | P2 | 按 `(workspaceRoot, policy)` 记忆化并在策略变更时失效 |
| PKG-025 | ``packages/security/src/sandbox.ts:99-146`` | `checkExec` 的"网络意图"判定是 `detectNetworkIntent` 文本启发式（curl/wget/nc 等词），注释自认是静态意图分类器而非 OS 级沙箱 → 易绕过（别名、`node -e fetch`、编译后的二进制） | A | P2 | 文档层面明确它只做"意图提示"，真正的网络隔离交给 `checkNetwork` + 后端沙箱；或在 exec 放行时强制提示 |
| PKG-012 | ``packages/store-integrity/src/index.ts:117-127`、`:159-206`` | `withLock` 的 `locks` Map 永不清空（每 key 常驻一条 Promise 链）；`backupTree` 先 `stat` 再 `readFile`，备份期间源文件被改写会拷到不一致内容 | D | P2 | `withLock` 在链尾为空时删除键；`backupTree` 改为"读一次 + 校验 size/mtime 未变，否则重试" |
| PKG-011 | ``packages/store/src/sqlite-runtime-store.ts:194-199`` | `schema_migrations` 只在表空时插入 `RUNTIME_SCHEMA_VERSION`，**从不校验已存版本是否高于当前版本** → 旧二进制打开新库静默继续（可写入旧 ABI 记录） | D | P2 | 打开时 `SELECT max(version)`，> 当前版本直接 fail-closed 抛 `schema too new` |
| PKG-024 | ``packages/store/src/sqlite-runtime-store.ts:270-300`、`:214-227`` | `updateSession`/`updateTurn` 不检查 `changes`（对不存在 id 静默 no-op）；`closed` 标志从不被任何方法检查，close 后调用抛原生 sqlite 错误而非领域错误 | A | P2 | 检查 `run().changes === 0` 抛 `SESSION_NOT_FOUND`；每个公共方法先断言未关闭 |
| PKG-010 | ``packages/store/src/sqlite-runtime-store.ts:295-322`、`:656-664`` | `listMessages`/`listMessagesByTurn` 用 `ORDER BY created_at`，`checkpointLoadLatest` 用 `ORDER BY created_at DESC LIMIT 1`，均无 tiebreaker → 同毫秒写入的多条记录顺序/最新性不确定（恢复时可能取到非最新 checkpoint） | D | P2 | 追加 `, rowid`（或 `id`）作为稳定 tiebreaker |
| PKG-009 | ``packages/store/src/sqlite-runtime-store.ts:339-373`` | `append` 查重 `WHERE session_id=? AND json_extract(doc,'$.id')=?`：事件 id 只存在 `doc` JSON 里（表结构 `PRIMARY KEY(session_id, sequence)`，见 `:103-108`，无 id 列/索引）→ 每次 append 线性扫描该会话全部事件，会话生命周期内总代价 O(n²) | D | P2 | 增加 `event_id TEXT` 列 + `UNIQUE(session_id, event_id)`，查重交给索引；或至少 `CREATE INDEX` 降为 B-tree 查找 |
| PKG-023 | ``packages/tools/src/orchestrator.ts:171-180`、`:514-541`` | `execute()` 从可变 registry 解析工具定义（legacy 路径，定义可在执行中被替换）；`evaluateSandbox` 每次工具调用 `new SandboxManager(...)`（重复构造 + 重复 realpath） | A | P2 | 收口到 `executeBound`；SandboxManager 按 `(root, cwd, policy, extraRoots)` 缓存复用 |
| PKG-015 | ``packages/tools/src/orchestrator.ts:586-589`` | `runBounded` 仅在 `context.sandboxPolicy.process.timeoutMs` 有值时设超时，`undefined` 时**直接 `tool.execute()` 无任何上限** → 自定义/网络类工具可永久挂起（process 工具自身默认 60s 兜底，见 `executor.ts:506`） | D | P2 | 在 orchestrator 层设全局兜底超时（如 `DEFAULT_TOOL_TIMEOUT_MS`），policy 值只用于收紧 |
| PKG-013 | ``packages/tools/src/process/executor.ts:471-499`` | 注释声称"kill a child **and its descendants**"，但 POSIX 分支只 `child.kill("SIGKILL")`（:498，无进程组/detached），只有 win32 走 `taskkill /t /f` → 非 Windows 上超时/取消后孙进程存活（资源泄漏） | D | P2 | POSIX 用 `detached: true` + `process.kill(-pid)` 杀进程组，或 spawn 时设置独立 process group |
| PKG-014 | ``packages/tools/src/process/executor.ts:597-600`` | `EXEC_DEBUG` 环境变量命中时直接 `process.stdout.write` → 在 stdio JSON-RPC 传输（gateway/desktop）下会污染协议流 | D | P2 | 改走注入的 logger，或写到 `process.stderr` |
| PKG-021 | `见说明` | 6 组重复工具函数，跨包各写一份 | A | P2 | 收敛到 `@ar/contracts`（序列化/错误）与 `@ar/store-integrity`（哈希）单一实现 |
| PKG-029 | ``packages/tools/src/orchestrator.ts:629-640`` | `applyOutputLimit` 只对 `typeof result.output === "string"` 生效；结构化 output（对象/数组）完全不受 `maxOutputBytes` 约束 | A | P3 | 对非字符串 output 做 `JSON.stringify` 后按字节限制，或直接拒绝超限结构 |

### 5.4 packages/ 外围能力（20 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| EXT-002 | ``packages/evaluation/src/gate-evidence-v2.ts:403-411`（写入点 `:521-530`）` | 证据链自己实现了一份 `redactSecrets`，只覆盖 3 类模式（`*_API_KEY`/`sk-`/JWT），而 `packages/security/src/secret-gate.ts` 的 `SECRET_PATTERNS` 有 11 类，此处缺 8 类（aws-access-key、github-token、slack-token、stripe-key、google-api-key、private-key、bearer-token、db-credentials）；这段文本会被写进 `evidence/*.log` 并算 sha256 → 证据文件可能落盘未脱敏真实密钥 | D | P1 | 删除本地实现，改为 `import { redactSecrets } from "@ar/security"`（注意签名是 `{content,redacted}`，需 `?` 适配）；补一条用例：用 11 类样本各造一条，断言落盘日志里没有原始密钥 |
| EXT-001 | ``packages/gateway/src/stdio-transport.ts:160-163`` | `close()` 只做 `this.pending.clear()`，既不 resolve 也不 reject 在途请求；`pending` 存的是各请求的 resolve 函数，清空后对应 Promise 永不 settle → 等待方永久挂起（进程不退出/超时失效） | D | P1 | `clear()` 前遍历 `pending`，对每项 reject 一个 `TRANSPORT_CLOSED` 结构化错误；加一条"close 后 inFlight=0 且所有等待方都拿到 rejection"的单测 |
| EXT-007 | ``packages/context/src/tokenizer.ts:16-19`` | `HeuristicTokenEstimator.estimate(text)` 忽略签名里的 `model` 参数，恒定用 `Buffer.byteLength/4`：① 对中文（3 字节/字）严重低估（实际约 1–2 token/字，估计值约 0.75），本仓中文提示占比高，预算可能低估 ~2 倍 → 触发 provider 上下文超限；② `Buffer` 是 Node 专有，浏览器/edge 构建会直接 ReferenceError | D | P2 | 按 `ModelRef` 选系数（CJK 段用 `chars*1.6` 之类），或至少 `typeof Buffer === "undefined"` 时退化为 `TextEncoder`；加中文样本的估算用例 |
| EXT-014 | ``packages/evaluation/src/`（根目录 92 个非测试源文件、44,253 行；最大 `tool-call-efficiency-formal-run.ts` 2627 行，其次 `r97-plan.ts` 2140、`r97-budget-ledger.ts` 1775）` | 扁平目录 + 超大单文件：`src/` 下 92 个文件没有任何子目录分组（只有 `artifact-v3/` 一处 6 文件），按 R92/R97/N6/N7/E4 等世代命名的模块混在一起，无法从路径判断归属 | A | P2 | 按世代/职能分目录（`r92/`、`r97/`、`evidence/`、`metrics/`、`prereg/`），并把 2600 行的 formal-run 拆成"状态机/预算/落盘/校验"四块；先做目录搬迁（纯移动 + 改 import），风险可控 |
| EXT-015 | ``packages/evaluation/src/benchmark-isolation.ts:117` 与 `packages/tools/src/process/sandbox-executor.ts:22`` | `ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG = "--allow-insecure-local-benchmark"` 在两个包各定义一次（当前值相同）。这是一个**关闭隔离**的安全开关，值一旦漂移，接受不安全基准的判定就会出现两套标准 | C | P2 | 提到 `@ar/contracts` 或 `@ar/security` 单一导出，两处 import |
| EXT-005 | ``packages/evaluation/src/experiment-harness.ts:31-52`（经 `src/index.ts:8` 导出）` | `defaultRunBenchmark` 在未注入 `runBenchmark` 时用 `Math.random()` 伪造 `passRate/latencyP50/latencyP95/tokens`，并置 `status:"completed"`；`ExperimentReport`（`packages/contracts/src/experiment.ts`）没有 `simulated` 字段，报告与真实跑测结果在数据上不可区分 → 一旦被写进 evidence/ledger/champion-state 就是伪造证据 | D | P2 | 默认实现改为 `throw new Error("runBenchmark dependency required")`，或强制在 `ExperimentReport` 上加 `simulated: true` 并让下游写入方拒绝 `simulated` 报告；目前生产调用点 0 个（仅 `experiment-harness.test.ts`/`cross-model.test.ts`），改动成本很低 |
| EXT-011 | ``packages/evaluation/src/gate-evidence-v2.ts:403` / `packages/security/src/secret-gate.ts:52`；`packages/evaluation/src/manifest.ts:243` / `packages/learning/src/change.ts:77`；`packages/evaluation/src/harness-metrics.ts:1523` / `packages/learning/src/scorecard.ts:75`；`packages/evaluation/src/recovery-policy.ts:24,41` / `packages/core/src/recovery/recovery.ts:14,46`；`packages/evaluation/src/baseline.ts:743` / `packages/contracts/src/termination.ts:31`；`packages/evaluation/src/formal-invariants.ts:130-132` / `packages/contracts/src/capability.ts:31-33`；`packages/evaluation/src/evolution-loop.ts` / `packages/skills/src/skill-evolution.ts`；`packages/evaluation/src/artifact-validate.ts` / `packages/core/src/runtime/r87-zero-call-replay-ab.ts`` | 同仓 9 组同名导出（全量比对结果：`evaluation` 1355 个导出符号 vs 其他包 1656 个，交集 11 个，扣除 2 个纯常量重名后 9 组属"两套实现"）。最危险的三组：`redactSecrets`（见 EXT-002，语义已确认不同）、`RecoveryPolicy/RecoveryDecision`（评测侧对恢复语义的建模与 `core` 的路由状态机是两份独立真相，行为一旦漂移，评测通过的候选在运行时可能不等价）、`computeScoreCard`（评分卡两份，评测分数与学习侧分数可能对不上） | C | P2 | 把可共享的收敛到 `@ar/contracts`（纯类型）与 `@ar/security`/`@ar/core`（实现），`evaluation` 只做引用；短期至少在 `evaluation` 侧加"同名导出必须来自上游包"的守护测试（`formal-invariants` 已有类似断言范式） |
| EXT-012 | ``packages/evaluation/src/n3-tool-dispatch-journal.ts:182`；`packages/evaluation/src/paired-executor.ts:322,334`；`packages/evaluation/src/tool-call-efficiency-formal-run.ts:1524`；`packages/evaluation/src/tool-call-efficiency-paired-campaign.ts:269`` | 同一套"临时文件 + fsync + rename 覆盖"的原子写被复制了 5 份，其中 `paired-executor.ts:334` 的注释还写着"Windows 上 rename 覆盖会失败，所以先删目标"（其余 4 份没有这个处理）→ 原子写语义在 5 处并不一致 | C | P2 | 抽 `evaluation/src/atomic-write.ts`，统一处理 Windows rename 语义 + `Math.random()` 临时名 + fsync；5 处改为调用 |
| EXT-013 | ``packages/evaluation/src/n6-evidence-cases.regressions.test.ts`(351 行) 与 `n7-evidence-cases.regressions.test.ts`(411 行)；`context-safe-tool-call-efficiency-v2.regressions.test.ts`(227) 与 `verified-completion-gate.regressions.test.ts`(210)；`context-safe-tool-call-efficiency-v2-preregistration.test.ts`(532) 与 `verified-completion-gate-preregistration.test.ts`(475)` | 实测 148 个测试文件、2249 条用例标题，其中 12 条标题跨文件重复，且几乎全部落在上面 3 对文件里（n6/n7 共享 8 条标题；v2/verified 共享 4 条）——两对套件是"同一个模板换个候选名"的拷贝，模板修一处漏一处会让两条候选线的门禁强度悄悄分叉 | C | P2 | 抽 `makeEvidenceCaseSuite(candidateId, cases)` 工厂，两对套件各自只传差异数据；标题里去掉重复的序号前缀，改为模板生成 |
| EXT-009 | ``packages/gateway/src/rpc.ts:321-324`（同类 `:179`）；`packages/observability/src/trace-exporter.ts:282,299`` | `trace.get` 无分页、无上限，直接 `return deps.events.list(sessionId)` 返回整个会话的全部事件；`thread/list`（`:179`）对每个 session 再拉一次全部事件；导出器把全部事件一次性 `join` 成 `events.jsonl` 字符串。长会话下是 O(n) 内存 + 巨型线缆帧 | D | P2 | `trace.get` 增加 `{after, limit, maxBytes}`，默认截断并回 `nextCursor`；`thread/list` 改成只取元数据（或 `deps.sessionService.summaries()`），不要在列表路径里展开事件 |
| EXT-016 | ``packages/memory/package.json`、`packages/store/package.json`、根 `package.json`` | 依赖 `node:sqlite`（`memory/src/sqlite-memory-store.ts:3`、`store/src/sqlite-runtime-store.ts:3`）但三个 `package.json` 都没有 `engines` 字段；`node:sqlite` 需要 Node ≥22.5 且长期为实验特性（需 `--experimental-sqlite` 或 ≥23 默认）→ 在 Node 20 上直接 import 失败，且失败点很深 | D | P2 | 三个 `package.json` 加 `"engines": {"node": ">=22.5"}`；启动处对 SQLite 后端做 capability 探测并给出可读错误（内存后端可退化） |
| EXT-008 | ``packages/memory/src/sqlite-memory-store.ts`（全文 561 行仅 `:220` 一处 `DELETE`，且为 FTS 索引同步）；`packages/memory/src/lifecycle.ts:11,108-109`` | 记忆库没有保留/淘汰/归档策略：`lifecycle` 只在 30 天未用时把条目**标记为 stale**（状态迁移），从不物理删除；`memories` 表与 `memories_fts` 索引随时间无界增长，检索延迟随之退化 | D | P2 | 增加 `prune({olderThan, keepTop, maxRows})`：先删 stale+低 usefulness，再按行数硬上限裁剪，`VACUUM` 交由显式维护命令；把返回值做成结构化统计以便观测 |
| EXT-003 | ``packages/model/src/openai.ts:702-714`；`packages/mcp/src/stdio-client.ts:183-186`` | 同一模式两处：按行解析的 `buffer += chunk` 没有任何长度上限。provider/stdio server 若长时间不吐换行（异常、巨型 JSON 行、二进制作死），缓冲无界增长 → 内存被打满且无超时能救（读循环仍在等换行） | D | P2 | 给两个缓冲都加 `MAX_LINE_BYTES`（如 8–16 MiB），超限即按"协议错误"终止并结构化上报；`model` 侧对齐已有的 `maxBuffer` 分类思路 |
| EXT-010 | ``packages/observability/src/trace-exporter.ts:244`` | `spawnSync("git", args, {timeout:3000})` 在导出路径上同步阻塞事件循环，单次最长 3s，同文件 `captureGitState` 一处调用可能需要多次 → 导出期间整个进程（含正在进行的模型流）卡住 | D | P2 | 换 `execFile` + Promise（本仓 `gate-evidence-v2.ts:123`、`benchmark-isolation.ts:255` 已有异步范式），或在导出前一次性取好 git 状态快照传入 |
| EXT-006 | ``packages/plugins/src/plugin-host.ts:173-196`` | `withTimeout` 的 rejection 分支（`:188-193`，注释自陈 "failure treated like a skipped plugin"）把**插件抛错**和**超时**归并成同一个 `TIMEOUT_SENTINEL`，上层只能当作"跳过"，错误内容、堆栈、累计失败计数全部丢失——正是该文件头部注释声称要修掉的 "swallowed failures silently" | D | P2 | 返回三态 `{kind:"ok" |
| EXT-020 | ``packages/evaluation/src/index.ts`（90+ 行 `export *`，摊平 `src/` 下几乎所有模块）` | 扁平 barrel：`evaluation` 把 92 个模块全部 `export *` 出去，跨模块重名会在编译期报错（当前 0 冲突，靠的是人力维护），且包导出面 ≈ 1355 个符号，消费者无法判断哪些是稳定 API | A | P3 | 分命名空间导出（`export * as r97 from "./r97-plan.js"`）或维护显式白名单 barrel；先从一个世代试点 |
| EXT-019 | `packages/evaluation/src/manifest.ts:243-254` 与 `packages/learning/src/change.ts:77-85` | 两份 `stableStringify` 语义不同：`evaluation` 版对 `undefined` 返回字符串 `"undefined"` 且显式排除 `null`；`learning` 版对 `undefined` 走 `JSON.stringify(undefined)`（返回 `undefined`，与声明的 `: string` 不符——类型谎言），数组内 `undefined` 元素两边产出不同。当前都用于哈希指纹 | D | P3 | 收敛到一份（放 `@ar/contracts` 或 `@ar/security` 的 canonical-json），返回类型改 `string \| undefined` 并让调用方显式处理 |
| EXT-004 | ``packages/learning/src/index.ts:66`` | 两条 export 语句挤在同一行：`export type { SandboxViolationKind } from "./sandbox.js";export * from "./change.js";`（缺换行）。同文件其余部分是显式具名导出 + 注释分组，这一行破坏了风格一致性，也让 diff 噪声变大 | A | P3 | 补换行；顺手把该行改成显式具名导出，与同文件其它分组保持一致 |
| EXT-018 | ``packages/model/src/openai.ts:830`；`packages/orchestration/src/reconciler.ts:184`` | 全仓真 TODO 仅 2 条：`listModels` 待接 `GET /models`；`TODO(P33-5): thread interrupt via client (turn/interrupt)`（中断只能走内部通道，客户端侧无法打断） | A | P3 | 前者：要么实现要么删接口；后者：确认 P33-5 是否已有替代路径，否则在 `orchestration` 文档里标注已知缺口 |
| EXT-017 | ``packages/protocol/src/{types,idempotency,items}.ts`、`packages/mcp/src/{json-schema-zod,mcp-chaos/fixtures}.ts`、`packages/gateway/src/{app-server,rpc}.ts`、`packages/learning/src/change.ts`、`packages/orchestration/src/scheduler.ts`、`packages/sdk/src/client.ts`、`packages/skills/src/effectiveness.ts`` | 22 个导出符号全仓 0 外部引用且定义文件内 0 次使用（判定：`git ls-files` 下全部 1176 个 ts 按词边界计数，排除定义文件与 `*/src/index.ts`，再统计同文件内使用次数）。清单：`requiredKeysOf`、`connectTimeout`、`firstThen`、`AppResult`、`ActiveTurnStatus`、`assertState`、`idempotentResult`、`isThreadItem`、`ThreadItemBase`、`ListSkillsResult`、`ThreadReadResult`、`ListAgentsResult`、`TraceReadResult`、`TurnStarted`、`ListToolsResult`、`ProtocolResponse`、`ProtocolRequest`、`ThreadStatus`、`SkillEffectivenessDelta`、`PLANNER_EXECUTOR_SYSTEM_PROMPT`、`platformSensitivity`、`HarnessCandidateChange` | C | P3 | 直接删除；`protocol` 的 8 个 `*Result/*Item` 建议保留类型骨架但改为 `@internal` 注释或移入内部模块，不进包导出面 |

### 5.5 scripts/ 与仓库级配置（18 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| SCF-001 | ``tsconfig.json:1-27`` | `packages/orchestration` 不在 root `references` 中，且无任何包依赖它 → `tsc -b` 工程图完全不含它，`pnpm typecheck`/`pnpm build` 对该包 8 个源文件零检查；只有发布打包器（`scripts/release/portable.mjs` 按 workspace inventory 枚举）才会真正构建它 | D | P1 | 把 `{"path": "./packages/orchestration"}` 加入 `tsconfig.json` references，并在 CI 增加 `tsc -b --dry` 与 `Get-ChildItem packages -Directory` 的集合比对 |
| SCF-005 | ``.github/workflows/ci.yml:1-1817`` | 单文件 1817 行，混合 bash 与 PowerShell 两套语法，内联 6 处 R84 campaign 篡改夹具构造，并把 `pnpm test` 的 5 条 exclude 在注释里重述一遍 | A | P2 | 拆为 `ci-typecheck / ci-test / ci-benchmark / ci-release-gate` 四个可复用 workflow，夹具构造下沉到 `scripts/ci/` |
| SCF-008 | ``.github/workflows/deepseek-ui-installed.yml:36`、`gen1-acceptance.yml:105`、`windows-acceptance.yml:52`` | 测试运行器不统一：这 3 处用 `node --test`，其余 595 个测试走 vitest；两套断言语义与报告格式并存 | A | P2 | 给 `scripts/**/*.test.mjs` 单独建 `vitest.scripts.config.ts` 并统一到 `pnpm test` |
| SCF-007 | ``.github/workflows/deepseek-ui-installed.yml:38,75,77`、`gen1-acceptance.yml:82`` | 产物版本号 `1.10.0` / `1.9.0` 硬编码至少 6 处，而根 `package.json` 的 `version` 是 `0.1.0`；升版本必须手工同步两个 workflow | D | P2 | 从 `package.json` 读版本（`node -p "require('./package.json').version"` 写入 `$GITHUB_ENV`） |
| SCF-006 | ``.github/workflows/windows-acceptance.yml:60`` | 单行硬编码 33 个测试文件路径作为 Windows 门禁清单，与 `pnpm test` 的收集范围重叠；新增回归测试若不加进这一行，就永远不进 Windows 门禁 | A | P2 | 改为"跑 `pnpm test` 全量 + 只对 Windows 特化文件追加"，或把清单落到 `apps/cli/test-infra/windows-gate.txt` 并加存在性校验 |
| SCF-004 | ``CAPABILITY_MATRIX.md:5-6`、`CAPABILITY_MATRIX.json`` | 跟踪的快照记录 `gitSha=27f7045e…`、`generatedAt=2026-08-26`，而 HEAD 是 `44f3f51f`；文件自称 `NOT RELEASE EVIDENCE` 却仍在版本控制里充当能力面索引 | B | P2 | 生成物不入库（改为 CI artifact），或加 `capability:audit` 校验"快照 gitSha == HEAD"否则拒提交 |
| SCF-017 | ``docs/evidence/**/manifest.json`（8+ 份）` | 4 个 `scripts/*.ps1` 的 sha256 被固化进 8 份以上历史证据清单（`scripts/baseline-plan.ps1` = `c47d287c…` 等），任何字节改动都会让这些历史证据失去可验证性；实测当前 4 个文件哈希已全部与清单不符（见 §4） | B | P2 | 明确"这些脚本已冻结"，改动必须新开证据轮次；在 `scripts/benchmark/README` 写清冻结边界 |
| SCF-010 | ``fix-links.mjs:1-96`` | 裸露在仓库根的破坏性修复脚本：无 dry-run、无 CLI 参数，直接 `fs.rmSync(childPath,{recursive:true,force:true})` 再 `fs.symlinkSync(target + path.sep, childPath, "junction")`；无 `process.platform` 守卫（junction 仅 Windows 有意义）；`package.json` 与 CI 均不引用 | C | P2 | 移入 `scripts/dev/fix-links.mjs`，加 `--dry-run` 默认与 `process.platform !== "win32"` 早退 |
| SCF-003 | ``HANDOVER.md:3`` | 声明"当前计划是 `plan(20260930-061557).md`；没有悬空 plan.md"；实测该文件不存在，根目录有 `plan.md` + 21 个 `plan(...).md` | A | P2 | 该段改为指向 `plan.md` 与新增的 `docs/plans/INDEX.md`；或把 HANDOVER 标注为"历史交接，勿作现状依据" |
| SCF-018 | ``scripts/research/`（132 文件）、`scripts/e4/`（30 文件）` | 两目录合计 162 个一次性研究/证据生成脚本，多数只被 `docs/**.md` 与冻结的 evidence 引用，不被 CI/`package.json` 调用；无 README 说明哪些仍可运行 | B | P2 | 在 `scripts/research/README.md` 建立"轮次 → 入口脚本 → 证据目录 → 是否仍可运行"索引；把已封轮的移入 `scripts/research/archive/` |
| SCF-009 | ``scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc`` | 一个 Python 字节码缓存被 git 跟踪；`.gitignore` 全文（82 行）没有任何 `*.pyc` / `__pycache__/` 规则 | C | P2 | `git rm --cached` 该文件；`.gitignore` 追加 `__pycache__/` 与 `*.pyc` |
| SCF-002 | ``tsconfig.noemit.json:8-34`` | `paths` 表 24 条与 `tsconfig.json` 的 24 条 `references` 是两份独立手写清单，已实际漂移（noemit 含 `@ar/orchestration`，references 不含） | A | P2 | 删除手写 `paths`（`include` 已覆盖全部 `packages/*/src/**/*.ts`），或由 workspace 清单生成 |
| SCF-014 | `根目录 22 个 `plan*.md` + `tasks/` 63 个 md + 根 5 个回顾文档` | 计划与回顾文档无索引：`plan.md`(7.3KB) 与 21 个 `plan(...).md`（合计约 105KB）平铺在仓库根，`tasks/` 63 个 md 无 README 索引；新接手者无法判断哪个是当前计划 | B | P2 | 建 `docs/plans/INDEX.md`（日期/主题/状态/对应 evidence 目录）；归档到 `docs/plans/archive/`；根目录只留 `plan.md` |
| SCF-013 | ``.gitattributes:137-138`` | 两条规则指向已删除文件 `plan(20261004-ui-preregister).md`、`plan(20261004-022759).md`（`Test-Path` = False，`git ls-files` 无此文件） | C | P3 | 删除这两行 |
| SCF-012 | ``.gitignore:32,38,45,52,63,73,82`` | 7 条规则用于隐藏"生成后应删除"的临时产物；其中 `apps/cli/src/e4-r24-fixture-*.test.ts` 落在源码目录内，任何命中该模式的真实测试会被静默忽略且 `git add` 不报错 | C | P3 | R24/R46 夹具跟进 R56 的做法（已迁到 OS 临时目录），删掉这两条源码目录内的 ignore 规则 |
| SCF-015 | ``package.json:11,31`` | `test` 与 `test:coverage` 的 5 条 `--exclude` 完全相同、逐字重复；`test:perf`/`test:soak` 写成 `vitest run .perf.test.ts`（无 glob，依赖 vitest 的子串过滤语义，易误解） | A | P3 | 抽出 `--exclude` 到一个 `vitest.test.ts` 共享片段或改用 `--config`；后两条加引号 `"**/*.perf.test.ts"` 并写明是过滤而非 glob |
| SCF-016 | ``pnpm-workspace.yaml:6-8`、`.npmrc:1`` | 同一开关 `verifyDepsBeforeRun`/`verify-deps-before-run` 在两处配置，且 `pnpm-workspace.yaml` 的注释专门解释"`.npmrc` 不够" | B | P3 | 保留 pnpm-workspace.yaml 一处并删 `.npmrc` 该行，或反之，并在 README 记录为什么 |
| SCF-011 | ``start-web.cmd:8-9`` | `start "" http://127.0.0.1:8787` 在 `node apps\web\dist\main.js` **之前**执行，慢启动时浏览器先打开到未监听的端口；端口 8787 硬编码且无覆盖入口 | D | P3 | 先启动服务并轮询就绪再开浏览器；端口抽到环境变量（`%~1` 或 `HARNESS_WEB_PORT`） |

### 5.6 静态资产与文档（17 条）

| ID | 文件:行 | 问题描述 | 类 | 级 | 建议做法 |
|---|---|---|---|---|---|
| AST-01 | `benchmarks/coding-repositories-v1/upstream-seeded.json:1` | 该文件被 `upstream-tasks.py:71` 以 `read_bytes()` 计算 `catalogSha256` 并写入 8 份已提交证据，但 `.gitattributes` 未对它（及同目录）加 `text eol=lf`；Windows CRLF 检出后哈希不可复现 | D | P1 | 在 `.gitattributes` 追加 `benchmarks/coding-repositories-v1/** text eol=lf`；顺带评估 `benchmarks/**/case.json`、`benchmarks/r98-fixtures/**` |
| AST-14 | `apps/web/public/deepseek/index.html:1` | 全仓**零引用**的第二套入口 HTML（1,130 B）；无任何 HTML/JS/配置指向它，但仍可经 `server.ts:267` 的 `serveVendor` 以 `/deepseek/index.html` 取到 | C | P2 | 删除，或与根 `index.html` 合并并保留单一入口（删前确认 `provenance.json` 的 `files` 清单同步更新） |
| AST-02 | `docs/evidence:1` | `docs/evidence/` 243,528,292 B / 7,175 文件，占 docs 体积 96.1%、占全仓跟踪文件 60.1% | A | P2 | 归档策略见 §1 说明 · AST-02；历史 run 超过 N 轮后转 LFS 或移出仓库 |
| AST-03 | `docs/evidence:1` | 698 个 `.png` 共 31,793,217 B 全部提交在 `docs/evidence/` | A | P2 | 截图类产物走 LFS 或按 run 打包为单个 `.tar.gz` 后删除散图 |
| AST-04 | `docs/evidence:1` | 112 个 `.db`（SQLite）共 5,505,024 B 被提交，二进制且无法 review diff | A | P2 | 改为 dump 成 `.sql` 或只在 evidence manifest 记录 sha256 + 元数据 |
| AST-05 | `docs/evidence:1` | 1,122 个 `.log` 共 6,448,295 B；其中大量为 9 B 的 `typecheck` 占位日志与 0 B 的空 `stderr.log` | A | P2 | 空/占位日志不提交；其余按 run 汇总成单个 `logs.txt` |
| AST-07 | `docs/evidence:1` | >50 KB 的同字节长度分组 **99 组**，按"全部为精确副本"上界可回收 **32,700,574 B** | A | P2 | 先做 sha256 精确去重（成本低、收益 13 MB 已确认） |
| AST-11 | `docs/evidence:1` | 5 个 results 目录内 `holdout.json` 与 `holdout-runs.sanitized.json` **逐字节相同**（74,798–76,891 B/对） | A | P2 | 删除 `.sanitized` 副本，或改为符号引用 |
| AST-09 | `docs/evidence/agent-next-20261004/raw:1` | `frozen-{de346b9,91967f4}/r2-performance/result-{jsonl,sqlite}-{structured-do,warm-fts}.json` 4 组完全同尺寸（3,406,892 ×4、2,068,221 ×4），跨 frozen commit 重复 | A | P2 | 确认后只留一份 + 记录两个 frozen commit 均适用 |
| AST-08 | `docs/evidence/gen1-final-20261008/history/ci:1` | 3 个近似重复 CI bundle：4,550,434 / 4,549,272 / 4,549,271 B（后两者仅差 1 B），合计 13,648,977 B | A | P2 | 只保留 release 目录那份；另两份在 manifest 里引用即可 |
| AST-10 | `docs/reviews/source-audit-20261007/evidence/n7-main-dry/dry-run.json:1` | 该文件（940,504 B）与 `docs/evidence/source-audit-fixes-20261007/evidence/final-n7-main-dry/dry-run.json`（924,153 B）同主题重复；holdout 侧同理（936,313 / 920,002），合计 3,720,972 B | A | P2 | `docs/reviews` 只留结论与 manifest，dry-run 原始产物归 `docs/evidence` 一处 |
| AST-16 | `apps/web/public/deepseek/provenance.json:1` | `sourceRelationship` 字段值为 "npm gitHead is absent; the separately frozen Git source reference does not release/source equivalence."，缺谓语（疑漏 "establish"），是**已提交的错误声明文本** | B | P3 | 需与 provenance 生成脚本一起改（`scripts/research/deepseek-frontend-vendor.mjs`），单改 JSON 会被 `--check` 覆盖 |
| AST-15 | `apps/web/src/server.ts:366-376` | `serveVendor` 无扩展名/路径白名单，把整个 `deepseek/**`（65 MB，含 9.88 MB 的 `sources/*.tar.gz`）当文件服务器暴露，且逐次 `readFile` 全量入内存、`Cache-Control: no-cache` | D | P3 | 加扩展名白名单（`.js/.css/.json/.svg/.woff2/.txt/.tgz`）与单文件大小上限；对 `.tar.gz` 走流式或直接拒绝 |
| AST-17 | `benchmarks/adversarial/adv-credential-exfil-filenames/fixture/.env:1` | 夹具内含 `API_KEY=qa_000000_placeholder_only` / `DB_URL=postgres://user:pass@db.example:5432/app` | B | P3 | 保持现状（是"凭据外泄文件名"对抗夹具的一部分）；仅需在 secret-scan 白名单登记 |
| AST-12 | `docs/:1` | docs 根目录 **145 个 `.md` 平铺**，无 `README.md` 索引（仅有 `docs/gen1-audit-index.md` 一个局部索引） | A | P3 | 补 `docs/README.md` 作为导航；同时给无索引的 `architecture/`、`evolution/`、`harness-engineering/` 补 README |
| AST-06 | `docs/evidence:1` | **88 个零字节被跟踪文件**（如 `final-audit-20261014/logs/final-audit-typecheck-*.log`） | A | P3 | 直接移除；零信息量且污染 `git ls-files` 清单 |
| AST-13 | `docs/r74-evidence:1` | `docs/r72/r74/r76/r77/r78/r79/r80/r81-evidence` 共 8 个碎片目录、16 文件、27,780 B，与 `docs/evidence/<run-name>` 命名体系不一致 | A | P3 | 并入 `docs/evidence/` 对应 run，或明确为保留的短索引 |

---

## 6. 类别 C：无引用文件、依赖、资源与死代码（15 条）

判定标准：全仓按词边界计数引用（排除定义文件自身与 `*/src/index.ts` 桶导出），并要求同时给出"零外部引用证明"与"是否仍在导出面"两项证据。

### 6.1 确定的死代码（可安全删除）

| ID | 位置 | 事实 | 建议 |
|---|---|---|---|
| WEB-049 | `apps/web/src/deepseek/adapter.ts:23` | `nextMessageId` 字段写入后全仓无读取方 | 删除字段 |
| PKG-026 | `packages/core/src/runtime/runtime.ts:2-3` | `mkdir` / `writeFile` / `dirname` / `join` 四个 import 在文件正文零使用（grep 仅命中 import 行） | 删除 4 个 import（纯减法，零风险） |
| PKG-027 | `packages/core/src/state/projections.ts` | 全仓唯一引用者是同目录 `projections.test.ts`，且**不在** `packages/core/src/index.ts` 导出面 ⇒ 生产不可达 | 确认是否有接线计划；无则删除或移入测试夹具 |
| SCF-009 | `scripts/research/agent-next5-20261005/__pycache__/frozen-acceptance.cpython-312.pyc` | Python 3.12 字节码缓存被跟踪；`.gitignore`（82 行）无任何 `*.pyc` / `__pycache__/` 规则 ⇒ 每个 Python 版本都会再产出新污染 | `git rm --cached`；`.gitignore` 追加两条规则 |
| SCF-013 | `.gitattributes:137-138` | 两条规则指向已删除文件 `plan(20261004-ui-preregister).md`、`plan(20261004-022759).md`（`Test-Path` = False，`git ls-files` 无记录） | 删除这两行 |
| SCF-012 | `.gitignore:32,38,45,52,63,73,82` | 7 条规则用于隐藏"生成后应删除"的临时产物；其中 `apps/cli/src/e4-r24-fixture-*.test.ts` **落在源码目录内** ⇒ 任何命中该模式的真实测试会被静默忽略且 `git add` 不报错 | R24/R46 夹具跟进 R56 的做法（已迁到 OS 临时目录），删掉源码目录内的 ignore 规则 |
| AST-14 | `apps/web/public/deepseek/index.html` | 全仓**零引用**的第二套入口 HTML（1,130 B），是品牌化前的旧入口快照，但仍可经 `server.ts:267` 的 `serveVendor` 以 `/deepseek/index.html` 访问 | 删除，或与根 `index.html` 合并为单入口（删前确认 `provenance.json` 的 `files` 清单同步更新） |
| LEA-01 | `.trae-html-share-packages/apps/web/public/index.html.zip` | 外部工具产物，零引用（见 §5.0） | 删除并加 `.gitignore` |

### 6.2 冗余实现（一份可删、收敛为一处）

| ID | 位置 | 事实 | 建议 |
|---|---|---|---|
| EXT-015 | `packages/evaluation/src/benchmark-isolation.ts:117` 与 `packages/tools/src/process/sandbox-executor.ts:22` | `ALLOW_INSECURE_LOCAL_BENCHMARK_FLAG = "--allow-insecure-local-benchmark"` 在两个包各定义一次（当前值相同）——这是**关闭隔离的安全开关**，值不一致就会造成"一处允许、一处拒绝"的静默不一致 | 提升到 `@ar/contracts` 或 `@ar/security` 单一导出 |
| EXT-011 | 跨 6 个包 | 9 组同名导出为"两套实现"：`redactSecrets`、`stableStringify`、`computeScoreCard`、`RecoveryPolicy`、`terminationReason`、`CAPABILITY_DIMENSIONS`、`evolution loop`、`artifact validate` 等（`evaluation` 1355 个导出符号 vs 其他包 1656 个，交集 11，扣除 2 个纯常量重名） | 共享部分收敛到 `@ar/contracts`（类型）/ `@ar/security`、`@ar/core`（实现） |
| EXT-012 | `evaluation/src/{n3-tool-dispatch-journal.ts:182, paired-executor.ts:322/334, tool-call-efficiency-formal-run.ts:1524, ...}` | "临时文件 + fsync + rename 覆盖"的原子写复制 **5 份**，其中 `paired-executor.ts:334` 注释写着"Windows 上 rename 覆盖会失败，所以先删目标"，另外 4 份没有该处理 ⇒ 跨平台行为不一致 | 抽 `evaluation/src/atomic-write.ts`，统一 Windows rename 语义 + 临时名 + fsync |
| EXT-013 | 3 对回归套件 | 148 个测试文件、2,249 条用例标题中 12 条跨文件重复，几乎全部落在 3 对"同模板换候选名"的套件里（n6/n7 共享 8 条，v2/verified 共享 4 条） | 抽 `makeEvidenceCaseSuite(candidateId, cases)` 工厂，两套件只传差异数据 |
| EXT-017 | `packages/protocol` 等 8 个文件 | **22 个导出符号**全仓 0 外部引用且定义文件内 0 次使用（`protocol` 占 8 个，多为 `*Result` / `*Item`） | 直接删除；`protocol` 的 8 个建议保留类型骨架但移出包导出面 |
| PKG-028 | `packages/core/src/runtime/r87-zero-call-replay-ab.ts`（1,878 行） | 只被 `r87` / `r88` / `r93` 三个测试引用，且 import 了 `core` 的 **devDependency** `@ar/model` | 移出 `src`（放 `bench/` 或 `test/fixtures/`），避免 core 生产目录里躺着只有测试可用的代码 |
| SCF-010 | `fix-links.mjs`（仓库根，96 行） | 破坏性修复脚本裸露在根目录：无 dry-run、无 CLI 参数，直接 `fs.rmSync(childPath, {recursive:true, force:true})` 再重建 symlink | 移到 `scripts/dev/fix-links.mjs`，加 `--dry-run` 默认与 `process.platform !== "win32"` 早退 |

### 6.3 依赖侧结论（反向澄清）

- 29 个 `package.json` × 1,792 个代码文件的全量 grep 只产出 **7 条"未被 import 的依赖"**，且全部是误报：根 `package.json` 的 `typescript` / `@vitest/coverage-v8` / `@types/node`（工具链按配置消费，不靠 import）、`apps/web` 的 `@types/ws`、以及未跟踪的 `harness-agent-src/` 内 3 条。
- 反过来发现一个真问题（记入 PKG-028）：`packages/core/src` 的**生产目录**里有文件 import 了本包的 devDependency，`tsc -b` 不会报错但运行时会缺失。

---

## 7. 类别 D：潜在风险与隐患（68 条）

按危害面重新分组。完整逐条见 §5 各分片表；此处只列**风险机制**与代表条目。

### 7.1 安全（8 条）

| ID | 风险 | 机制 |
|---|---|---|
| EXT-002 | 密钥落盘 | 证据链自带脱敏只覆盖 3/11 类模式（详见 §3） |
| WEB-047 | 路径穿越面 | `host-tools.ts:101-110` 的 host 会话可对**任意绝对路径**列举/建目录，判据仅"没传 sessionId" |
| WEB-006 | 静态资源清单脱钩 | `STATIC_FILES` 硬编码 12 项，与 `public/` 实际资源无校验 ⇒ 新增文件可能被意外暴露或 404 |
| WEB-003 | 缺 `nosniff` | 静态资源缓存分支未设 `X-Content-Type-Options` |
| PKG-023 | 工具定义可在执行中被替换 | `execute()` 从可变 registry 解析工具定义（legacy 路径），`evaluateSandbox` 与执行之间存在 TOCTOU 窗口 |
| PKG-025 | 网络意图靠文本启发式 | `checkExec` 用 `detectNetworkIntent` 匹配 curl/wget/nc 等词，注释自认不可靠 ⇒ 沙箱网络判定可被绕过 |
| CLI-012 | 安全用例被静默跳过 | Windows 无法创建符号链接（EPERM）时用 `ctx.skip()` 跳过整例 ⇒ 两个安全用例在 Windows 上**从不真正执行且报告为 skipped** |
| AST-17 | 夹具含凭据形状字符串 | `benchmarks/adversarial/.../fixture/.env` 内含 `API_KEY=qa_000000_placeholder_only` / `DB_URL=postgres://user:pass@db.example:5432/app`（占位值，但会触发密钥扫描器告警） |

### 7.2 数据完整性（11 条）

代表条目：PKG-002（持久化栅栏零校验）、PKG-007（`compose-stores.ts:92-101` 生产代码唯一裸 `append`，硬编码 `sequence:0` + `schemaVersion:1`，违 P26-1 稠密性契约）、PKG-024（`updateSession`/`updateTurn` 对不存在 id 静默 no-op）、PKG-022（配置层合并顺序注释与实现不一致）、WEB-019（持久化 JSON 写入 7 份，`bindings.ts` 最弱：固定 `.tmp`、跟随符号链接、无 `lstat`/`nlink`/目录 fsync）、WEB-032（每 tick 全量读 + 每 task 单独 mutate 同一文件 ⇒ 并发丢更新）、PKG-021 中的 `saveStateSnapshot` 盲 UPSERT 无 CAS。

**共性**：写入路径普遍缺少"读-改-写"的 CAS 保护或"临时文件 + fsync + rename"的完整硬化（7 份实现里硬化程度各不相同）。

### 7.3 性能与资源（14 条）

- **热路径全量扫描**：WEB-020、WEB-021（§3）、WEB-015（每条 prompt 的 `markPromoted`/`markConsumed` 全量扫 owner×session×inbox）、WEB-024（每条 tool 消息线性 `find` ⇒ O(n²)）。
- **无界增长**：EXT-008（memory 30 天只标 stale 不删；`memories` + `memories_fts` 无界）、EXT-009（`trace.get` / `thread/list` 无分页无上限，`trace-exporter.ts:282,299` 全量事件 join）。
- **挂起/泄漏**：EXT-001（§3）、CLI-015（手写 `Promise.race([work, sleep])` + `kill` + `clearTimeout` 组合，超时后子进程可能残留）。
- **超大文件**：`apps/cli/src/benchmark-command.ts` 4,001 行、`packages/evaluation/src/tool-call-efficiency-formal-run.ts` 2,519 行、`packages/core/src/runtime/session-actor.ts` 2,054 行（见 §9）。

### 7.4 兼容性（9 条）

- CLI-001（§3，Windows `ENOENT`）、CLI-003（`execFileSync(cmd.join(" "), {shell:true})` 与 evaluation 包刻意 argv+`shell:false` 矛盾，含空格路径会被重新切词）、CLI-013/CLI-014（`execSync("git rev-parse HEAD")` 无超时、路径未转义）。
- WEB-046（Windows 默认 shell 仍是 PowerShell 5.1，与全局规则第 1 节冲突）。
- EXT-012（原子写 5 份，Windows rename 语义处理不一致）。
- AST-01（§3，eol 归一化）。
- SCF-016（同一开关 `verifyDepsBeforeRun` / `verify-deps-before-run` 在 `pnpm-workspace.yaml` 与 `.npmrc` 两处配置）。

### 7.5 可观测性与误导（13 条）

- EXT-005（`Math.random` 伪造 benchmark 且 `status:"completed"`，无 simulated 标记 ⇒ "全部通过"的假象，经 `index.ts:8` 公开导出）。
- WEB-035（模型发现失败被吞成通用错误，无日志无原因）、WEB-037（两套 `ToolResult` 解包，取消被报成 `gateway/internal`）、WEB-004（`readJson` 的类型错误被 catch 覆盖成 `"invalid JSON body"`）、WEB-011（用 `200` + 魔法键帧表达流式错误）。
- PKG-003（§3，漂移告警实际不覆盖工具语义/重试/沙箱）。
- EXT-018（全仓真 TODO 仅 2 条，说明注释纪律良好；但 `listModels` 待接 `GET /models` 与 `TODO(P33-5)` 应进计划）。

### 7.6 供应链与仓库治理（13 条）

- SCF-017（4 个 `scripts/*.ps1` 的 sha256 被固化进 8+ 份历史证据清单，实测当前哈希已全部与清单不符 ⇒ 历史证据已失去可验证性，需 owner 确认以 HEAD 为准的现行冻结清单）。
- SCF-004（`CAPABILITY_MATRIX.*` 快照落后 HEAD 两个月，自称 `NOT RELEASE EVIDENCE` 却仍充当能力面索引）。
- AST-02/03/04/05/06（运行产物入库：243.5 MB / 698 PNG / 112 SQLite / 1,122 log / 88 零字节文件）。
- SCF-009、LEA-01（构建/工具产物入库）。
- `harness-agent-src/`（4,241 文件、被 `.gitignore` 标记为 "Stray source archive"、内含非 git 的 `agent-runtime 0.1.0` 副本，与 HEAD 抽样 4/5 文件 hash 不同、`apps/web/src/deepseek/owners.ts` 缺失 ⇒ **陈旧分叉副本**，未跟踪但留在工作区，建议确认后移出）。

---

## 8. 类别 B：当前不宜优化、但仍有改进空间（9 条）

这一类是本审查特意保留的"反向清单"——避免后续维护者把**有理由的设计**当成缺陷清理掉。

| ID | 位置 | 现状 | 为什么现在不动 | 可改进点 |
|---|---|---|---|---|
| SCF-017 | `docs/evidence/**/manifest.json`（8+ 份） | 4 个 `.ps1` 的 sha256 被固化进历史证据 | 历史证据是已发布事实，改哈希=改写历史；且按计划重写脚本是刻意行为 | 明确"以 HEAD 为准"的现行冻结清单，历史清单标注 `supersededAt` |
| SCF-018 | `scripts/research/`（132）+ `scripts/e4/`（30） | 162 个一次性研究/证据生成脚本，多数只被 `docs/**.md` 与冻结 evidence 引用 | 它们是证据的可复现来源，删了证据就不可复现 | 加 `scripts/README.md` 索引：哪些仍可运行、对应哪份证据 |
| SCF-014 | 根目录 22 个 `plan*.md` + `tasks/` 63 个 md | 计划与回顾文档无索引，`plan.md`(7.3 KB) 与 21 个 `plan(...).md`（约 105 KB）平铺根目录 | 这些是过程记录，移动会破坏已有文档内链 | 建 `docs/plans/INDEX.md`，根目录只留指针 |
| SCF-004 | `CAPABILITY_MATRIX.md` / `.json` | `gitSha=27f7045e`、`generatedAt=2026-08-26`，落后 HEAD 两个月 | 快照的价值在于"某个 commit 的能力面"，改成动态生成会失去可引用性 | 文件名带 commit 短 sha；或生成时校验 HEAD 并 warn |
| SCF-016 | `pnpm-workspace.yaml:6-8` + `.npmrc:1` | 同一开关两处配置，`pnpm-workspace.yaml` 注释专门解释"`.npmrc` 不够" | pnpm 版本对两处支持程度不同，删一处会造成某些版本失效 | 注释里补版本边界；CI 加"两处值必须一致"的检查 |
| CLI-012 | `prereg-fixture-checkout-grant.test.ts:333`、`-trust.test.ts:311` | Windows 无法建 symlink 时 `ctx.skip()` 跳过整例 | 不跳过会在这类环境里永久红 | 改为 `skipIf(!canSymlink)` + CI 至少一台 Linux 跑全量，并在报告里显式统计 skipped 数 |
| AST-16 | `apps/web/public/deepseek/provenance.json` | `sourceRelationship` 值缺谓语（疑漏 "establish"） | 该字段可能被哈希断言覆盖，改动需同步重算 | 与哈希断言一起改；或只加 `_note` 字段说明 |
| AST-17 | `benchmarks/adversarial/.../fixture/.env` | 夹具含凭据形状字符串（占位值） | 这是**故意**的对抗样本，删了用例失效 | 值已含 `placeholder_only`，可在同目录加 `README` 说明；或让密钥扫描器按路径白名单 |
| LEA-02 | `apps/web/public/deepseek/licenses/shell-reference/notice-files/node_modules/**` | 250 个路径含 `node_modules/` 的被跟踪文件，实为第三方许可正文 | 许可归档要求保留原始目录结构 | 在 `licenses/README` 显式说明，避免后续审查误判 |

---

## 9. 类别 A：可优化的代码点（63 条）

完整逐条见 §5。此处按**优化杠杆**排序，只列结构性的大项——这些条目单独修收益有限，成组修才有复利。

### 9.1 超长函数与巨文件（8 条，收益最高）

| 位置 | 规模 | 可切口 |
|---|---|---|
| `apps/cli/src/benchmark-command.ts` | 4,001 行 | 解析 / 编排 / 评分 / 落盘四段职责，切口已给（CLI-006） |
| `packages/evaluation/src/tool-call-efficiency-formal-run.ts` | 2,519 行 | 已有 `runBenchmark`(L388) / `decideBench…`(L652) 三个职责边界 |
| `apps/cli/src/prereg-arm-executor.ts` | 2,125 行 | "启动 worker" / "超时与清理" / "结果归纳"三段 |
| `packages/core/src/runtime/session-actor.ts` | 2,054 行 | 未逐行（见 §10） |
| `packages/core/src/runtime/runtime.ts` | 2,000 行 | PKG-020：构造函数 234 行装配 5 个 controller；`runTurnCore` 约 325 行；`handleTool…` 亦长 |
| `apps/web/src/deepseek/schedule-pure/domain.ts` | 1,795 行 | vendored（MIT），**不建议本地重构** |
| `apps/web/src/deepseek/owners.ts` | 795 行 | WEB-018：单函数 236 行装配全部服务并猴补事件总线；WEB-023：单函数 300 行 + 20 个可变闭包状态 |
| `scripts/*` | 1,817 行单文件 | SCF-005：混合 bash 与 PowerShell 两套语法，内联 6 处夹具构造 |

> 拆分只按现有函数边界移动、不改行为——`apps/cli` 是 CLI 层，不触碰 AGENTS.md 的 Runtime Freeze 约束。

### 9.2 重复实现（需要收敛而非逐个改）

- **入参校验 helper 四套并存**（WEB-033），错误码不一致；**JSON 值校验手写四遍**（WEB-034），深度上限分别是 20 / 30 / 无 / 无。
- **durable JSON 写入 7 份**（WEB-019）、**原子写 6 份**（WEB-040，硬化集合各不同）+ 5 份（EXT-012）——Windows rename 语义处理不一致是最实际的坑。
- **`git rev-parse HEAD` 取 HEAD 的实现 7 处（CLI-004）**，另有 `scripts/paired-to-v3.mjs` 第 8 处。
- **参数解析两套风格**（CLI-005）：`rest.indexOf("--x")` + `filter` 共 12 处 vs 显式 `for` 循环 6 处，均不支持 `--flag=value`，`--out` / `--evidence-dir` 缺值时静默取默认。
- **祖先/后代闭包 while 扫描三遍**（WEB-019）、**敏感文件名正则逐字重复两份**（WEB-038）、**`createRuntimeRpc` 四键字面量重复 ≥7 处**（WEB-051）、**tempdir+cleanup 样板 15 处**（WEB-052）。
- **测试夹具的 `mkdtemp` 清理逻辑复制了 76 份**（CLI-011），无共享助手。

### 9.3 端点与清单分散

- **WEB-030**：端点表分散三处，新增端点需改 3 处。
- **SCF-002**：`tsconfig.base.json` 的 `paths` 表 24 条与 `tsconfig.json` 的 24 条 `references` 是两份独立手写清单，**已实际漂移**。
- **SCF-006**：CI 硬编码 33 个测试路径（见主题 2）。
- **EXT-020**：`evaluation` 把 92 个模块全部 `export *`，跨模块重名会在编译期报错（当前 0 冲突靠运气）。

### 9.4 目录与结构

- **EXT-014**：`packages/evaluation/src/` 下 92 个文件无子目录分组（仅 `artifact-v3/` 一处 6 文件）。
- **WEB-006**：`STATIC_FILES` 硬编码 12 项。
- **AST-12**：`docs/` 根目录 145 个 `.md` 平铺，无索引。
- **SCF-008**：测试运行器不统一（3 处 `node --test` vs 595 个 vitest），两套断言语义与报告格式并存。

### 9.5 错误处理与类型

- **WEB-004**（类型错误被覆盖成 "invalid JSON body"）、**WEB-035**（模型发现失败被吞）、**WEB-037**（取消被报成 `gateway/internal`）、**CLI-008**（解析失败时往 stdout 写错误信息）。
- **PKG-029**：`applyOutputLimit` 只对 `typeof result.output === "string"` 生效，结构化 output 不受限。
- **WEB-009**：路由包装只保留 `generate`，其它可选成员丢失（类型收窄不当）。

---

---

## 10. 覆盖清单与未逐行说明

### 10.1 文件类型全覆盖

`git ls-files` 实测 **11,937** 个跟踪文件，按扩展名分布（前 22 位，覆盖 99.3%）：

| 扩展名 | 数量 | 主要用途 | 审查深度 |
|---|---|---|---|
| `.json` | 4,548 | benchmark 用例、evidence 清单、插件 manifest、配置 | 结构与引用点核对；用例/证据按聚合规则 |
| `.txt` | 1,335 | 许可正文、日志附件、fixture 输入 | 抽样 + 引用点 |
| `.ts` | 1,176 | 全部生产与测试源码 | **逐行**（例外见 §10.4） |
| `.log` | 1,122 | 运行日志（`docs/evidence/**`） | 聚合（见 AST-03） |
| `.md` | 1,020 | 文档、review、计划 | 代码域内文档逐行；`docs/` 按聚合（见 AST-12） |
| `.png` | 698 | 截图证据 | 聚合（见 AST-04） |
| `.jsonl` | 511 | 事件流证据 | 聚合 |
| `.js` | 349 | vendored 浏览器 bundle、legacy 前端、evidence 内脚本 | 代码域逐行；minified bundle 聚合 |
| (无扩展名) | 321 | `LICENSE` / `NOTICE` / `README` 等 | 引用点核对 |
| `.mjs` | 263 | 脚本（`scripts/**`、`apps/web/scripts/**`） | 逐行（`scripts/research`、`scripts/e4` 例外） |
| `.db` | 112 | SQLite 证据夹具 | 聚合（见 AST-05） |
| `.gz` | 87 | 压缩证据 | 聚合（不可读） |
| `.py` | 84 | benchmark 生成器与校验脚本 | 逐行 |
| `.tgz` | 67 | 前端 vendor 供应链输入 | 聚合（哈希断言输入，见 §8 LEA/AST 反证） |
| `.svg` | 60 | 图标 | 聚合 |
| `.woff2` / `.ttf` / `.woff` | 62 | 字体二进制 | 聚合 |
| `.yaml` | 21 | CI workflow、pnpm workspace | 逐行 |
| `.css` | 14 | 样式 | 逐行 |
| 其余（`.ps1` `.sh` `.cjs` `.tsx` `.html` `.zip` `.flag` `.gitattributes` …） | ~1,700 | 脚本、配置、入口页 | 逐行 |

**没有遗漏的目录**：顶层 13 个目录（`apps/`、`packages/`、`scripts/`、`docs/`、`benchmarks/`、`research/`、`third_party/`、`tasks/`、`.github/`、`.trae-html-share-packages/` 及根文件）全部落在 6 个分片的 scope 并集内，并集 = 11,890，余 47 个根目录零散文件由 SCF 分片覆盖，合计 11,937，与 `git ls-files` 相等。

### 10.2 代码域覆盖（946 个生产代码文件 + 880 个测试/夹具代码文件）

下表由随报告交付的 `coverage-manifest.tsv`（11,937 行的逐文件清单）**机器统计**得出，而非各审查员的自述口径：

| 分片 | 跟踪文件 | 生产代码 | 逐行通读 | 定点/结构扫描 | 测试与夹具代码 | 测试处理方式 |
|---|---|---|---|---|---|---|
| WEB | 59 | 30 | **29** | 1（`schedule-pure/domain.ts`，vendored） | 27 | 模式扫描 + 抽查 |
| CLI | 153 | 49 | **41** | 8（千行以上单体） | 100 | 模式扫描 + 抽查 |
| PKG | 418 | 177 | **175** | 2（`session-actor.ts`、`sandbox-executor.ts`、`process-gate.ts` 定点） | 219 | 确认不在生产 import 图 + 抽查 4 个 |
| EXT | 493 | 210 | **169** | 41（`agents/protocol/skills/orchestration/sdk` 仅模式扫描） | 255 | 模式扫描 |
| SCF | 332 | 142 | **17** | 125（`scripts/research` 132 + `scripts/e4` 30 中的代码文件） | 15 | 模式扫描 |
| AST | 10,482 | 318 | 0 | 318 全部按聚合规则（§10.3） | 264 | 用例数一致性 + 引用点 |
| **合计** | **11,937** | **926** | **431（46.5%）** | **495（含 318 个资产类代码）** | **880** | — |

口径说明：`coverage-manifest.tsv` 的 `istest` 判定包含路径含 `fixture` 的文件，因此 `benchmarks/**` 的用例脚本被计入测试列；若按"排除 `docs/` 与 `benchmarks/` 后的源码目录"统计，全仓代码文件为 **1,391** 个（非测试 783 / 测试 608），与 §1.1 的 1,389（当时按 781/608 手工统计，差 2 个为后续确认的边界文件）一致。两种口径的差异只影响分类，不影响"每个文件都被分配了一种审查深度"这一事实。

> 生产代码 926 个中，**431 个逐行通读**，其余为定点核对/结构扫描/聚合——所有例外都在 §10.4 逐条列出，并给出替代手段与置信度。
>
> 注意：manifest 的 `depth` 列由规则脚本生成，对“未逐行”取的是**下界**（例如 WEB 分片自述 3 个 vendored 文件全部未逐行，manifest 只标出 `domain.ts`）；**以 §10.4 为准**，该节是人工核对后的权威例外清单（生产代码 177 个）。

### 10.3 资产域聚合规则

`docs/`、`benchmarks/`、`apps/web/public/` 共 10,482 文件 / 318.0 MB 按 13 组聚合，每组给"未逐行（原因）+ 替代手段"，规则写在分片报告 §3.2。核心替代手段四类：

1. **集合相等性校验**——如 66 个插件目录 vs `boot-manifest.json` 66 条目，全等（无孤儿/无缺失）。
2. **哈希与供应链绑定**——每个 `.tgz` 由 `deepseek-frontend-vendor.mjs:92-93` 四重断言（bytes/sha256/integrity/shasum）。
3. **数量一致性**——四个主 suite 的 case 数与 `apps/cli/src/audit.ts:586/596/606/616` 的断言数完全吻合，无孤儿用例。
4. **重复检测**——同尺寸分组 99 组（上界 32.7 MB），对 4 组精确重复做了 sha256 逐字节验证。

### 10.4 未逐行清单（全部例外，逐条给原因）

| 分片 | 文件 | 行数/规模 | 未逐行原因 | 替代手段 |
|---|---|---|---|---|
| WEB | `deepseek/schedule-pure/domain.ts` | 1,795 | vendored 上游 MIT 代码（`PROVENANCE.md` 有源 SHA-256），缺陷应回上游 | 溯源核对 + 引用面 |
| WEB | `schedule-pure/{cron,timezone}.ts` 等 2 个 | 395 / 173 | 同上 | 同上 |
| WEB | `gen1-session-sidebar.test.ts` | 30 | 短测试，非缺陷源 | 5 类模式 grep 无命中 |
| WEB | `socket.web-server.test.ts` | 71 | 同上 | 同上 |
| WEB | `change-compare.regressions.test.ts` | 11 | 同上 | 同上 |
| CLI | `benchmark-command.ts` | 4,001 | 单体过大 | 精读 argv 解析 / executeBenchmark / 评分 / 落盘 / rev-parse 5 个区域，其余结构索引 |
| CLI | `benchmark-command.test.ts` | 2,832 | 测试单体过大 | 结构扫描 + 5 类模式扫描 |
| CLI | `prereg-arm-executor.ts` | 2,125 | 同 | 精读超时-清理矩阵与 worker 生命周期 |
| CLI | `prereg-execution-identity.ts` | 1,524 | 同 | 结构扫描（见 CLI-006） |
| CLI | `audit.ts` | 1,362 | 同 | 结构扫描（见 CLI-004/005/006） |
| CLI | `e4-r55-child-harness.ts` | 1,131 | 同 | 结构扫描（见 CLI-006） |
| CLI | `e4-09-diagnostics.ts` | 691 | 同 | 结构扫描（见 CLI-004/014） |
| CLI | `prereg-command.ts` | 612 | 同 | 结构扫描（见 CLI-005） |
| CLI | `prereg-production-runner.ts` | 440 | 同 | 结构扫描（见 CLI-004） |
| PKG | `core/src/runtime/session-actor.ts` | 2,054 | 全局最大运行时文件 | 导出面 + 事件写入路径定点核对，无新增发现 |
| PKG | `tools/src/process/sandbox-executor.ts` | 870 | 未逐行 | 定点：`execFile("bwrap", ["--version"])` 探测 + `windowsHide`，无 shell 插值 |
| PKG | `tools/src/process-gate.ts` | 515 | 未逐行 | 定点核 5 个导出函数 |
| PKG | 71 个 `*.test.ts` | — | 测试聚合组 | 确认不在生产 import 图 + 抽查 4 个直接相关测试；聚合组不做死代码/性能判定 |
| EXT | `agents/`、`protocol/`、`skills/`、`orchestration/`、`sdk/` 共 41 文件 | — | 时间预算，标低置信 | 模式扫描（`as any`/`catch`/`TODO`/硬编码路径/未 await） |
| SCF | `scripts/research/**` 132 文件 | — | 一次性研究/证据生成器 | 入口引用面 grep + 冻结证据哈希 + 轮次归属；结论见 SCF-018 |
| SCF | `scripts/e4/**` 30 文件 | — | 同上 | 28 个 `.mjs` 中仅 3 个有命令面入口，其余 25 个只被 docs/evidence 引用 |
| SCF | 根 10 个叙述性文档（`README*`/`AGENTS.md`/`mem.md`/`reflection.md` 等） | ~3,000+ | 叙述性 | 结构化抽查 + 与实测结论交叉验证（`mem.md:881,895` 印证 SCF-001/002） |
| AST | 10,482 文件 | 318.0 MB | 见 §10.3 的 13 组聚合 | 四类机器替代手段 |

### 10.5 覆盖可核验性

- 各分片报告的 §3/§10 均附完整覆盖清单（逐文件结论列），本次合并后原件见 `docs/reviews/code-audit-20261017/evidence/part-*.md`，可作为审计底稿。
- 分片报告的覆盖清单与 `git ls-files` 的并集相等（§10.1），因此"是否漏目录"是可机器复核的，不依赖本报告的叙述。

---

## 11. 修复路线图

按"危害 × 修复成本"排序。**本次审查不改代码**，下列批次供后续排期。

### 批次 1（建议立即修，11 条 P1）

| 顺序 | ID | 修法 | 预计改动 | 验证方式 |
|---|---|---|---|---|
| 1 | CLI-001 + CLI-003 | `release-artifacts.ts:190` 的 `["pnpm","capability:audit"]` 改为 `process.platform === "win32" ? ["pnpm.cmd", ...] : ["pnpm", ...]`，或统一走 `node_modules/.bin` 绝对路径；`release-command.ts:322` 的 `shell:true` 改为 argv 数组 | 2 文件 ~15 行 | Windows 上跑第 9 步，确认 `produced:true` |
| 2 | PKG-002 | `runtime.ts:983` 的 `flushThrough(sessionId, MAX_SAFE_INTEGER)` 改为传入真实 sequence；或让 store 对哨兵单独处理（哨兵仅用于"读到末尾"语义，不应跳过存在性校验） | 2 文件 ~10 行 | 单测：flush 不存在行应抛错 |
| 3 | EXT-001 | `stdio-transport.ts:160-163` 的 `close()` 对 pending 逐个 `reject(new Error("transport closed"))` 后再 clear | 1 文件 ~6 行 | 单测：close 后在途调用 reject |
| 4 | PKG-003 | `runtime.ts:895` 用真实哈希（对工具语义列表 `stableStringify` 后 sha256）替换 `String(length)`；`resolveAgent` 增加 retry/sandbox 哈希比较 | 2 文件 ~25 行 | config-drift 矩阵补 3 个用例 |
| 5 | PKG-001 | `createSession` 后立即 `freezeConfigFingerprint`；或在首次 load 时以当前配置为基线而非报错 | 1 文件 ~10 行 | 单测：建会话→改配置→load 应拒绝 |
| 6 | EXT-002 | `gate-evidence-v2.ts:403-411` 的 `redactSecrets` 删除，改 import `@ar/security` | 1 文件 ~-20 行 | 单测：8 类密钥模式均被脱敏 |
| 7 | AST-01 | `.gitattributes` 追加 `benchmarks/coding-repositories-v1/** text eol=lf` 与 `benchmarks/r98-fixtures/** text eol=lf` | 1 文件 2 行 | `git add --renormalize .` 后重跑，哈希应等于证据记录值 `db483652…` |
| 8 | SCF-001 | 根 `tsconfig.json` 的 `references` 加 `{"path":"./packages/orchestration"}` | 1 文件 1 行 | `pnpm typecheck` 通过且能报出该包错误（可临时注入一个类型错误验证） |
| 9 | WEB-020 | `events.ts:53-77` 改事件驱动 + pending 索引 | 1 文件 ~40 行 | 压测：100 会话下 `$events` CPU |
| 10 | WEB-021 | `session.ts:443-455` 改增量投影 + 跳过无新事件的 `meta()` 读盘 | 1 文件 ~30 行 | 同上 |
| 11 | CLI-002 | `commands.ts:402` 解析改为跳 flag 值（复用 CLI-005 的共享解析器） | 1 文件 ~20 行 | 单测：`--files a.ts --mode real-model` |

> 1–8 是纯局部修复，无架构影响；9–11 涉及热路径，建议同批并有性能对比数据。

### 批次 2（安全与数据完整性，P2 中的 D 类）

- **脱敏与凭据**：EXT-002 之外复查全部"写盘前拼接文本"的路径（`gate-evidence-v2.ts:521-530` 是已知的一处）。
- **路径与沙箱**：WEB-047（host 会话对任意绝对路径操作）、WEB-006（`STATIC_FILES` 硬编码脱钩）、PKG-023（TOCTOU）、PKG-025（网络意图文本启发式）。
- **持久化硬化**：统一 7 份 durable JSON 写入（WEB-019）+ 6 份原子写（WEB-040）+ EXT-012 的 5 份，收敛为一个 `@ar/store-integrity` 导出；给 `saveStateSnapshot`/`updateSession`/`updateTurn` 补 CAS 与"不存在则报错"。
- **可观测性**：EXT-005（删除 `Math.random` 伪造 benchmark，或加 `simulated:true` 并在 `index.ts:8` 停止导出）、WEB-035、WEB-037、WEB-004、CLI-008。

### 批次 3（结构收敛，需要成组做）

按杠杆排序：入参校验 4 → 1（WEB-033）、JSON 值校验 4 → 1（WEB-034）、原子写 15 → 1（WEB-019/040 + EXT-012）、`git rev-parse` 7 → 1（CLI-004）、参数解析 2 套 → 1（CLI-005）、端点表 3 处 → 1（WEB-030）、paths/references 两份清单合一（SCF-002）、CI 33 个硬编码测试路径改 glob（SCF-006）、`evaluation/src` 92 文件分目录（EXT-014）、大文件拆分（CLI-006 / PKG-020 / WEB-018 / WEB-023）。

### 批次 4（仓库治理，影响可复现性）

- AST-02~06：`docs/evidence` 243.5 MB 运行产物入库策略（是否迁 LFS / 归档分支 / 仅保留 manifest）。
- SCF-017：历史证据里的 `.ps1` 哈希清单与当前文件全部不符，需 owner 决定"以 HEAD 为准"的现行冻结清单，并给历史清单标 `supersededAt`。
- `harness-agent-src/`：确认后移出工作区（未跟踪但存在，4,241 文件、陈旧分叉副本）。
- LEA-01：删除 `.trae-html-share-packages/` 并加 ignore。
- SCF-009/012/013：`.gitignore` / `.gitattributes` 的过期与危险规则清理。

### 落地建议

1. **批次 1 逐条 PR**，每条一个可复现验证（表中"验证方式"列即验收标准）。
2. **批次 2 按"安全 → 数据 → 可观测"三组**，安全组建议单独复核 diff（涉及脱敏与路径）。
3. 批次 3 前先在 CI 补两条门禁：`tsc -b` 覆盖完整性（防 SCF-001 复发）、`.gitattributes` eol 钉全量校验（防 AST-01 复发）。
4. 每批完成后重跑一次本报告 §5 的对应 ID，用于回归确认。

---

## 12. 附录

### 12.1 统计口径

- **155 条 = 153（6 分片合计）+ 2（Lead 追加 LEA-01/02）**。
- 级别/类别以 §5 表格实测为准（分片报告正文里的口头统计有 3 处分歧，已在 §5 统一）：`P0 0 / P1 11 / P2 96 / P3 48`（= 155）；`A 63 / B 9 / C 15 / D 68`（= 155）。
- 分域：web 54 · cli 15 · PKG 29 · EXT 20 · SCF 18 · AST 17 · Lead 2。

### 12.2 与既有审查（`docs/reviews/source-audit-20261007`）的关系

那份报告是**源码漂移审计**（对比 `harness-agent-src/` 与 HEAD 的差异），本报告是**全仓质量问题普查**，两者范围不重叠。本报告独立复核时发现 SCF-001（`packages/orchestration` 未进 `tsc -b`）与 `docs/gen1-release-comparison.md:79` 记录的历史事故同根因——说明该缺陷类别已复发一次，故在 §11 建议加 CI 门禁。

### 12.3 复现命令

```powershell
# 规模与目录（§10.1）
git ls-files | Measure-Object -Line
git ls-files | ForEach-Object { [IO.Path]::GetExtension($_) } | Group-Object | Sort Count -Desc

# 重复文件（§4 主题 5）
git ls-files -z | ForEach-Object { Get-FileHash $_ -Algorithm SHA256 } | Group-Object Hash | Where Count -gt 1

# 未使用依赖（§6.3）
# 对 29 个 package.json 的 dependencies 逐个 grep "from \"<dep>\"" 于全部代码文件

# 死代码引用计数（§6，例）
git grep -n "nextMessageId" -- apps/web/src
```

### 12.4 本次审查的局限

1. **未运行** `pnpm typecheck` / `pnpm test`（审查要求只读，且运行会写入 `dist`、`*.tsbuildinfo`）。所有"类型/测试"类结论均来自静态核对，不带运行时证据。
2. **177 个生产代码文件未逐行**（连同测试与文档共 286 个，逐条见 §10.4）：其中 `scripts/research`（132）与 `scripts/e4`（30）的结论是"应归档但未见缺陷"，属**低置信**；`session-actor.ts`（2,054 行）同样只做了定点核对。
3. **未做动态安全测试**（路径穿越、沙箱逃逸、脱敏泄漏均以静态判据给出）。
4. **`.gitignore` 内的 `harness-agent-src/` 与 `.ci/`** 不计入跟踪文件统计，但已在 §4/§7 单列说明。
5. 文件行号以 `HEAD = 44f3f51f` 为准，若后续合入 PR #11 等改动，行号会漂移；ID 可直接 `git grep` 对应符号定位。

### 12.5 产出物清单

| 文件 | 内容 | 大小 |
|---|---|---|
| `docs/reviews/code-audit-20261017/README.md` | 本报告 | 116 KB |
| `docs/reviews/code-audit-20261017/coverage-manifest.tsv` | 11,937 个跟踪文件的 `scope / path / depth` 三列清单（"无遗漏"的机器证据） | 1.5 MB |
| `docs/reviews/code-audit-20261017/evidence/METHOD.md` | 统一判定方法（四类四级、证据要求、章节结构） | 6.5 KB |
| `docs/reviews/code-audit-20261017/evidence/part-web-src.md` | WEB 分片（54 条 + 59 文件覆盖清单） | 34 KB |
| `docs/reviews/code-audit-20261017/evidence/part-web-src-table.md` | WEB 分片规范化表（6 列，供合并用） | 9 KB |
| `docs/reviews/code-audit-20261017/evidence/part-cli.md` | CLI 分片（15 条 + 153 文件覆盖清单） | 32 KB |
| `docs/reviews/code-audit-20261017/evidence/part-pkg-runtime.md` | PKG 分片（29 条 + 418 文件覆盖清单） | 36 KB |
| `docs/reviews/code-audit-20261017/evidence/part-pkg-ext.md` | EXT 分片（20 条 + 493 文件覆盖清单） | 33 KB |
| `docs/reviews/code-audit-20261017/evidence/part-scripts-config.md` | SCF 分片（18 条 + 332 文件覆盖清单） | 39 KB |
| `docs/reviews/code-audit-20261017/evidence/part-assets-docs.md` | AST 分片（17 条 + 13 组聚合规则） | 40 KB |

> 底稿策略：分片报告与覆盖清单已一并落到 `docs/reviews/code-audit-20261017/`（共 1.82 MB），使本报告的每条结论都可回溯到原始证据与对应文件的审查深度；`.ci/tmp/review/` 中的同名副本为临时工作目录（已被 `.gitignore` 忽略），可随时删除。
