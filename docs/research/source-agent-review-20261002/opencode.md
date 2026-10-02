# OpenCode 源码研究与 Harness 对照（2026-10-02）

## 快照、许可证与证据边界

- 分析根：`/workspace/HARNESS-SRC-FORK/opencode-dev`。收集仓库 commit 为 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，该目录不是独立 upstream Git checkout，**未核实上游 commit**。源码 `packages/opencode/package.json:3` 自报版本 **1.18.16**；顶层 `package.json` 指向 `https://github.com/anomalyco/opencode`。
- `LICENSE:1-21` 是 MIT、Copyright (c) 2025 opencode；如果移植实质源码，应保留版权与许可证声明。优先独立实现机制，不搬入 Bun/Effect 服务架构。
- collection 的 `reports/opencode/FREEZE.md:12-13`、`AGENT_LOOP.md:3` 描述 **1.18.18**，与当前源码不一致。它们只能作检索线索，不能证明当前版本、行号、运行能力或测试通过。读取的实际源码 SHA-256 在 `opencode-manifest.json`。
- Harness 对照基线 `acf8dcc394de6c6efefed52602e49014b372f372`。读过根 `AGENTS.md` 及 `tasks/P0/TOOL-001.md`、`tasks/P3/CTX-001.md`、`CTX-002.md`、`CTX-003.md`、`tasks/P4/LOOP-001.md`。Runtime Freeze 要求可复现正确性/security/Runtime 性能问题；模型策略假设必须先 challenger / paired eval。
- 本次未安装上游依赖、未运行 OpenCode 测试、未联网、未使用 GitHub 连接器。下文“上游测试”指读取的验收代码，不冒称已跑绿。当前项目通过已有 dist 模块的公共 API 做离线重现，无生产代码变化。

## 入口 → loop → tool/permission → context → knowledge/verification

两代实现都实际存在，不能把 V1 功能自动宣称为 V2 功能。

**V1 可追踪链**：`packages/opencode/src/index.ts:85` 注册 `RunCommand` → `cli/cmd/run.ts:859` 调用 `client.session.prompt`；服务组装 `server/routes/instance/httpapi/server.ts:242-247` 注册 `SessionProcessor/Compaction/Prompt/Instruction` → `session/prompt.ts:1052-1070` 的 `prompt` → `:1343-1346` 的 `loop` / `ensureRunning` → `:1081-1094` 的 `runLoop` 每轮重载历史 → `:1226-1240` 的 `SessionTools.resolve` 冻结工具面 → `:1257-1286` 组装 skills/environment/instruction/MCP/model messages → `SessionProcessor.process` 在 `processor.ts:640` 调 `llm.stream`。`session/tools.ts:59-89` 的 `Tool.Context.ask` 调 permission，`:102-129` 实际执行 leaf tool。`read.ts:300,355-365` 按所读文件附附近规则；`instruction.ts:179-220` 实现按路径找规则并按消息去重。`prompt.ts:1319-1338` 处理 stop/compact/prune，`compaction.ts` 选择近期完整轮次与摘要；源码没有等价 Harness 的独立完成 Verification gate，不能以 stop/摘要代替验收。

**V2 可追踪链**：`packages/server/src/handlers/session.ts:139-149` 的 `session.prompt` → `packages/core/src/session.ts:360-383` 的 `SessionV2.prompt` 先 durable admit `SessionInput` 再 `execution.wake` → `session/execution/local.ts:16-35` 的 process-local coordinator 根据 Session location 找 `SessionRunner` → `session/runner/llm.ts:173-215` 的 `runTurnAttempt` 加载 SystemContext/skills/references、promote inbox、重载 durable history、materialize tools、触发 compaction → `:232` 一次 `llm.stream(request)` → tool event 经 materialization settlement（`:250-271`）→ `tool/registry.ts:50-81` 的 `settleWith` 检查冻结注册身份、调用 tool settlement 后 `ToolOutputStore.bound` → `tool/edit.ts:138-161` 的路径/权限检查及读 bytes → `:191-196` 的 `FileMutation.writeIfUnchanged`。`:383` 起的 runner 继续 drain，而 `file-mutation.ts:198-207` 明示 undo/LSP/多文件 rollback 等仍待设计，不能把 V1 LSP/undo 承诺给 V2。

上游对应测试路径：`packages/opencode/test/session/{processor-effect,instruction,compaction}.test.ts`、`packages/opencode/test/tool/{edit,write,truncation}.test.ts`、`packages/core/test/session-runner*.test.ts`、`packages/core/test/session-compaction.test.ts`、`packages/core/test/system-context/*.test.ts`、`packages/core/test/{file-mutation,tool-edit,tool-output-store}.test.ts`。

Harness 当前链为 `packages/harness/src/create-harness.ts:432-464` 组装 `AgentRuntime` / `ToolOrchestrator` / `ContextPipeline` / artifact store → `packages/core/src/runtime/context-controller.ts:216-255` 每 step 构建 context 并锁定 instruction identity → `packages/core/src/runtime/tool-call-controller.ts:239-280` 按 semantics 执行工具与冲突控制 → `packages/tools/src/orchestrator.ts:297-381` 经过 deadline/budget、执行、输出限额、证据与事件归一化 → `packages/core/src/runtime/verification-controller.ts:46-90` 完成 gate。所有新增实际副作用仍应沿这条链。

## 候选 1：工具输出的 UTF-8 字节限额修复（高优先级 Runtime 正确性维护）

**上游有用机制**：V2 `packages/core/src/tool-output-store.ts:50-71` 的 `takePrefix/takeSuffix` 按 Unicode code point 计 UTF-8 byte，`:98-103` 的 `boundedPreview` 先预留 marker 空间，再分配 head/tail；`:138-170` 的 `bound` 在保存完整结果后生成可控模型视图。`packages/core/test/tool-output-store.test.ts:68` 对模型输出总 byte 验证上限；V1 `tool/truncate.ts:103-120` 按完整行计 UTF-8 byte，`test/tool/truncation.test.ts:176-191` 验证全量文件可回读。

**当前真实差距**：Harness 已有 artifact，绝非“缺少持久化输出”。但 `packages/tools/src/orchestrator.ts:625-632` 比较 `Buffer.byteLength` 后却 `slice(0,maxBytes)`，把 byte 当 UTF-16 code unit，既超限又可能切坏 surrogate。`orchestrator.test.ts:400-417` 仅用 ASCII，并只检查字符长度 `<5000`，没有证明 1024-byte 上限。公共 `ToolOrchestrator.execute` 配真实 `read_file`、`maxOutputBytes=5`：中文截断正文 **15 byte**；emoji 正文 **11 byte** 且尾部为未配对高位 surrogate；ASCII 正文正好 5 byte。JSON 重现证据在 `opencode-repro.json`，包含真实 status=success。

**怎么做**：在 `packages/tools` 的输出限额边界独立实现按 UTF-8 byte 的安全 prefix，明确 cap 的语义是否含 marker 并把所有 marker byte 算入模型视图上限；极小限额必须仍成立。不要为了保存所有输出取消 `sandboxPolicy.process.maxOutputBytes` 的资源控制；先区分 process 捕获上限与 context preview 上限，artifact 保留的是实际被允许捕获的内容。`context-controller.ts:484-553` 已做 redact → hash → artifact → head/tail，保留这个流程与 metadata/evidence/status。

**怎么验收**：公共 orchestrator RED→GREEN：ASCII/CJK/emoji、byte=0/1/3/4/5、exact-boundary、单超长行、混合换行；正文/最终视图两种声明的 byte 口径都检查，Unicode round-trip 不产生替换字符，未超限逐字节不变。集成验证 metadata、error/status/evidence、reservation settlement 不变；secret 不进 artifact/model，injection 被拦且 gate 未绕过。不可声称 OpenCode V1 hint 自身受 byte 限制，V1 是 body 限额；本次借鉴的是 V2 更完整的 bounded-preview 口径。

## 候选 2：按目标文件提供 scoped instruction（先 fixture / strategy challenger；有契约缺口再维护）

**上游有用机制**：V1 `session/instruction.ts:179-220` 从被读取的目标文件所在目录向上找 AGENTS/CLAUDE/CONTEXT，跳过已进 system 的文件并依据 prior read metadata、per-message claim 防重。`tool/read.ts:300,355-365` 明确与实际 read path 联动。测试 `session/instruction.test.ts:128-205` 覆盖 nested 指令、直接读 AGENTS 时不重复附加、同消息不重复、clear 可重载、prior read 去重。借鉴“绑定目标路径与 provenance”，不复制网络 fetch 或 `<system-reminder>` 权威升级。

**当前真实差距与必须区分的边界**：Harness 已有层级发现、注入扫描、provenance、冻结 identity，并非缺少 AGENTS 支持。实际发现算法是 `packages/context/src/discovery.ts:67-90` 全子树枚举后截至 maxDocuments，`:109-137` 在首个缺失的中间 ancestor 停止，`:47-48` 明示省略夹在 topmost 与 cwd 间的祖先。公开 API 已复现 `repo/AGENTS.md=ROOT`、`repo/packages/p/AGENTS.md=PACKAGE`、`repo/packages/p/src/AGENTS.md=CWD`、`repo/packages` 没有文件时，从 src cwd 只能看到 PACKAGE/CWD，ROOT 丢失。root cwd 时又会同时注入 `a/AGENTS.md=A_ONLY` 和 `b/AGENTS.md=B_ONLY`，默认4文档额度可让实际工作包规则被无关兄弟文档挤掉。证据同 `opencode-repro.json`。已有 `discovery.test.ts:95-110` **明确锁定“最后添加的 cwd 可以被 maxDocuments 丢弃”**，不能直接改变并说无兼容成本。

**怎么做**：先建立 monorepo failure fixtures 和清晰契约：repo-root 边界如何定义（优先已知 workspace root，不能越过授权路径），缺 AGENTS 的中间目录是否终止、ancestor 顺序、目标文件 scoped 文档预算、多个 target 的并集去重、cwd 是否保留。链漏 ROOT 如与 CTX-001 的 root→nested→cwd 既有验收相矛盾，fixture pin 住后可做有边界的 correctness 维护；**把全树规则改为按目标加载本身属于策略选择**，应做可注入的 `InstructionDiscovery` challenger / Harness composition seam，先离线 paired eval 再讨论升级默认。目标 path 从成功 read/search evidence / current plan 收集，不让模型任意字符串绕过 sandbox。目标变化下一 step 重新 resolve，并纳入现有 `instructionSources` / step snapshot identity；compaction 后可重新派生。

**怎么验收**：三包互斥规则场景，使用同 model/script/task 输入 baseline/candidate 成对验证：root 通用规则可见，A 文件只加载适用 A 规则，B 不污染 A；无 ancestor 文档仍可到合法 root；深层祖先 root→package→cwd 顺序明确；maxDocuments 1/2/4 边界可审计而不悄悄把必要规则吞掉；目标切换、repeat-read、compaction/reload 的去重和再装载正确；扫描目录/读取文档数、context byte/token、正确任务结果一起记录，不以少 token 代替正确性。负例：`root-sibling` 前缀路径、`..`、symlink、workspace外路径、不可读文件、prompt injection、超长单行、多字节。保留 `pipeline.ts:284-314` 中 project docs 的 **untrusted/data-only/instructional=false/persistable=false** 契约。OpenCode 的 `instruction.ts:194` 用 `startsWith(root)`，不能照搬这类 lexical-prefix 边界判断。

## 候选 3：编辑时协作并发防丢更新（有确定重现的工具层正确性维护）

**上游有用机制**：V2 `packages/core/src/file-mutation.ts:69-82,144-155` 按 canonical target 在同一个 process-local lock 内比较当前原始 bytes 与 expected bytes，changed 则 `StaleContentError`，匹配才写。`tool/edit.ts:161,191-196` 从真实读结果携带 expected bytes，到 commit 做条件检查。`core/test/file-mutation.test.ts:260-312` 验证同 expected bytes 的并发只能一方成功与 stale 时零写；`core/test/tool-edit.test.ts:384-405` 控制读后外部变化并保证旧编辑不能覆盖较新内容。

**当前已有保护及其边界**：Harness `edit_file` 有文本 anchor、occurrence/all、行区间与 before/after diff；`write_file` 有破坏性缩水 guard；tool metadata 标 `concurrencySafe:false`。`tool-call-controller.ts:239-280` 也在单批次阻止相同资源并发，因此不能声称“没有并发控制”。但保护限于当前 turn 的批次，两 session / 两 orchestrator 对同一 workspace 的 `edit-file.ts:98-118` 都是裸 read→replace→write，未共享文件锁/conditional commit。通过两个公共 `ToolOrchestrator.execute`，只用真实 fs.readFile barrier 强制“两个 snapshot 都读完再写”的合法交错：原文件 alpha=0/beta=0；一个编辑 alpha→1、一个编辑 beta→1；**两调用均 success，最终 alpha=0/beta=1**。完整证据 `opencode-edit-race-repro.json`。这是确定数据丢失，不是模型质量假设。

**怎么做**：局部 `packages/tools` 文件 mutation guard，在授权/sandbox/durable intent 之后、tool body 实际修改之前，对 canonical workspace+file 使用共享 process-local keyed lock；最小方案在锁中完整读/改/写，使协作的独立 anchor 编辑都保留。若采用 optimistic expected bytes，锁内重新比较且失配明确 fail，不能自动重放 side-effect（metadata retry:none 保持）。与 `write_file` / transaction 等参与者的锁覆盖范围必须明确，不只保护一个 edit caller。保留 resource limits、cancel before dispatch、evidence、版本冻结与 tool reservation 语义。

**怎么验收**：两个不同 session、两个不同 orchestrator 的 barrier fixture：可接受两成功合并、或一成功一显式 stale失败；不能“两成功丢编辑”。同文件别名 canonical 归一、不同文件可独立执行、取消/抛异常一定释放锁、连续调用不积累 map entries；deny/sandbox/intent失败必须零写；第三方读后改写的 fixture 显式失败且新内容保留。明确保障仅为**本进程协作写入**，外部进程在最终检查与写之间的竞争不能凭此宣称全局原子 CAS；跨进程安全另立设计，不扩大当前 plan。

## 不应借鉴或重复的功能

- OpenCode V1 `processor.ts:29,353-379` 只检查当前 assistant 最近3个同名/同 JSON.stringify 参数工具；Harness `state/agent-state.ts:190-225,278-327` 已有稳定 args key、结果指纹、进展取消、滚动模式，`runtime.ts:1401-1462` 有 bounded recovery。**不替换为更简单 doom-loop，也不加第二套 loop detector**。
- Harness 已有工具 artifact 注册、hash、sensitivity、redaction、injection scan（`context-controller.ts:484-565`、`artifact-store.ts:3-35`）。上游 7-day cleanup 不是理由直接替换现有 retention/security policy；完整输出保留有不同捕获边界，不能借鉴成绕开 maxOutputBytes。
- Harness 最近已修 UTF-8 compaction preview、protected anchors、原文去重、参数/reasoning 消息预算与线性 trimming，不重写 compaction。OpenCode 的 tail-turn selection 可作以后长任务质量 challenger，当前没有相应 paired failure cluster，暂不列即时 Runtime任务。
- `edit.ts` V1 有 fuzzy replace，但 V2 `core/src/tool/edit.ts:83-88` 仍把 fuzzy/LSP/undo留 TODO。Harness 默认first-match属公开行为，不能把上游“多匹配必须失败”的语义强行改默认；如需严格编辑策略，先 optional challenger + ambiguity fixture。
- 不引入 Effect/Bun 架构、双 V1/V2 loop，也不沿上游 leaf 工具去分散 Harness 统一 PermissionEngine/Sandbox/Verification 边界。

## 给主计划的推荐顺序

1. 所有候选先落 evidence fixture，确认源/基线 hashes，界定 stdout capture cap、context view cap、instruction scope 与协作写并发契约。
2. byte-safe tool limit 作为直接正确性修复；它与 Codex 来源是交叉证据，主计划合为一个任务。
3. scoped instruction 建成按 target path 的 opt-in discovery challenger，并单独处理 fixture 能证实的 ancestor-chain correctness bug；不要把策略收益作为 Runtime Freeze 例外。
4. 并发 edit 丢更新是独立 correctness 候选，可在工具层局部修复，不需要重写 Runtime。和计划其他范围/代码owner协调后决定本轮纳入。
5. 当前任务要求分析后产 plan，本研究只提供做什么/怎么做/怎么验收，不宣称任何生产优化已实施或上游测试已运行。
