# Claude archive source review

研究基线：`harness-agent` `acf8dcc394de6c6efefed52602e49014b372f372`；档案路径：`/workspace/HARNESS-SRC-FORK/claude-code-fork-main`。本次只做静态阅读及运行 Harness 自身的确定性探针，没有执行档案代码、联网、安装依赖、复制档案实现或修改生产代码。

## 1. 内容、来源与证据边界

- 实测目录仅有 `README.md` 和 `src/`，1903 个文件，1884 个 `.ts/.tsx`，没有 `package.json`、锁文件、构建配置、LICENSE/COPYING，也没有 `.test.` / `.spec.` 测试文件。不能独立构建验证。
- README 自称来自 2026-03-31 泄露源代码档案，并称原代码属于 Anthropic。这是档案作者声明，当前无法独立认证其来源或与发行版的一致性；不能把它称为完整、具有开源许可证的 Claude Code 项目。
- 可见文件为可读 TypeScript，并非仅一个压缩 bundle；但至少 237 个不同相对 import 字符串解析不到本地目标（静态近似统计，部分属于条件分支/内部功能/生成文件），例如 `src/services/compact/cachedMicrocompact.ts` 实际不存在。
- README 对文件规模也不可靠：其称 QueryEngine/Tool 分别约 46K/29K 行，实测为 1295/792 行。因此没有采用 README 的功能、规模或性能结论作为代码证据。
- 下述标为“静态链可见”的机制只说明本档案的实现意图和本地代码关系，不能说明其运行配置默认启用、官方发行版具有此行为、测试已通过或模型表现更好。没有可验证的宽松授权，建议仅借鉴概念，独立实现 Harness 需求，不移植源码。

## 2. 可见调用链与已有能力对照

### entry / loop / tools

`src/main.tsx:424` 在非 bare 模式初始化 skill change detector。可见 SDK 路径：`src/QueryEngine.ts:675` 消费 `query(...)`；`src/query.ts:219` 包装 `queryLoop`，`query.ts:241` 创建跨迭代 state，`:307` 为 `while (true)`；`:379` 在请求前应用 aggregate tool-result budget；`:414` 经依赖对象调用 microcompact；`:1380` 根据配置消费 StreamingToolExecutor 或 `runTools(...)`。普通工具执行后，`src/services/tools/toolExecution.ts:1403` 的 `addToolResult` 调用 `processPreMappedToolResultBlock` / `processToolResultBlock`，再进入 `src/utils/toolResultStorage.ts:272` 的持久化路径。

Harness 已有 `packages/core/src/runtime/runtime.ts:1126` 的 ToolCallController 执行入口、`:1344` 的 ContextController 渲染、`:1346` 的持久消息写入。所有工具仍须走 ToolOrchestrator / PermissionEngine / Sandbox；档案里的直接文件写入模式不作为允许绕过 Harness 契约的依据。

### context / knowledge / skills

`src/context.ts:116` 的 getSystemContext 和用户上下文组装可见；git 信息以明确标注的会话初始快照注入（`:96`），不应误用为实时状态。`src/skills/loadSkillsDir.ts:100` 按 name/description/whenToUse 估计技能元数据 token，正文由调用加载；`:118` 的 realpath 身份用于去重。`src/tools/SkillTool/SkillTool.ts:122` 的 executeForkedSkill 可见构造子任务上下文并调用 runAgent 的路径，但大量依赖/功能门缺少运行验证。

Harness 已有 `FileSkillLoader.discover` 有界 frontmatter 读取、按需正文加载（`packages/skills/src/skill-loader.ts:87/:112`）、词法选择（`packages/skills/src/selection.ts:46`）、semi-trusted/instructional:false/persistable:false 的 skill body 注入、requiredTools 检查以及效果/token ROI 台账（`packages/harness/src/skill-context.ts:104-155`）。**progressive disclosure、技能工具权限约束、artifact 引用、history token 估算和分层 compaction 不是当前缺失的新能力，不建议重复做一套。**

压缩方面，`src/services/compact/microCompact.ts:253` 可见先时间触发、再受 feature/model/source 约束的 cached path；`:288` 明确外部构建或不支持时不在此处压缩。cachedMicrocompact 文件缺失，所以只记录边界，不以 cache-editing 方案提出移植任务。Harness 已有 DefaultCompactor、protected-facts 验证、pipeline budget 和 history trim，不借缺失链重写 Runtime。

## 3. 建议 A：修复技能刷新被上层永久缓存遮蔽（优先）

**档案证据：静态链可见，无运行/测试证据。**

- `src/utils/skills/skillChangeDetector.ts:85` initialize → `:110` watcher → `:133-135` add/change/unlink → `:255` scheduleReload → `:274-277` 清技能缓存、清命令缓存、重置已发送名称、通知订阅者。
- `src/main.tsx:424` 存在初始化调用；`src/hooks/useSkillsChange.ts:28/:43` 订阅后重新 getCommands；`:35` 的 debounce 和 watcher 稳定等待防止每次事件全量重建。
- 可借鉴的是“索引、正文、发送状态同时感知版本变化”，无需采用 chokidar、Bun 特殊轮询或原实现。

**Harness 实际缺口：确定性 correctness bug，已复现。**

- `packages/skills/src/skill-loader.ts:119-125` 每次 load 读取最新 stat，mtime 变化时重新读正文；`:79` 已有 invalidateBodyCache。
- 但 `packages/harness/src/skill-context.ts:89-94` 只发现一次技能；`:113-123` 外层 bodyCache 按名称永久复用，之后根本不再调用 loader。`packages/harness/src/create-harness.ts:400` 实际生产组合使用该 provider。
- 运行 Harness 的现有构建：第一次加载后更新 SKILL.md 并推进 mtime，provider 再 load 仍注入旧命令，直接 FileSkillLoader.load 读到更新命令；删除文件后 provider 仍注入旧正文。探针及结果见 `.ci/source-research/claude-repro.mjs` / `claude-repro.json`。
- 这不是“Claude 模型质量更好”的推断；它是本项目已有 controlled refresh 在组合层失效，修改落在 harness/skills，不需要重写 frozen core Runtime。

**做什么：**让同一 Harness 实例的技能正文、metadata/requiredTools 与文件删除在下一次规定的刷新边界生效。

**怎么做：**先建立回归测试；优先取消外层无版本 bodyCache，让每次被选中的技能走现有 loader 的 stat+安全检查缓存；索引采用受控 revision/刷新边界，不在每次模型请求无差别全量扫描。将 skill 身份/版本一致地传给 metadata、requiredTools 检查和 provenance。任何更新都不得扩大 host toolPolicy；相同名称不同路径、删除或改名须失效。保留 existing security scan、typed denial、semi-trusted 注入、ROI 计数，不直接把 body 升级成系统指令。

**怎么验收：**

1. 同 provider `load → 修改正文/推进mtime → load` 注入更新；删除后不再注入。
2. 修改 requiredTools 为超出 host policy 后不得注入，产生 required-tools denial；更新正文包含 injection/secret 时 loader 拒绝且事件可观察。
3. 改名/新增技能在明确的刷新边界可发现；同名异路径与配置隔离保持成立。
4. 不改文件时正文 read 次数继续由现有 cache 降到一次；避免重新读正文和全量目录扫描造成的性能回退；mock clock/revision 控制测试，避免真实 sleep。
5. `packages/harness/src/skill-context.test.ts`、skill integration、`packages/skills/src/skill-loader.test.ts`、skill capability/security、typecheck 通过；随后依项目要求跑完整验收。不能只证明底层 loader refresh，要证明生产 provider/组合链生效。

## 4. 建议 B：整轮工具结果预算作为 strategy challenger（次优先、先评测）

**档案证据：可读静态完整选择/持久化/重放链，无执行/效果证据。**

- `src/constants/toolLimits.ts:49` 有 200000 字符的整 API user-message 工具结果预算，单工具阈值 `:13` 为 50000 字符。
- `src/utils/toolResultStorage.ts:575` collectCandidatesByMessage 将连续 user tool results 按实际 API 合并边界分组；`:675` selectFreshToReplace 按最大结果优先选择；`:731` buildReplacement 先 persist 完整文本、再构建引用；`:855` 并行持久化。
- `:475` replacement record 保存模型实际看到的字串；`:796` 区分 mustReapply/frozen/fresh；`:802` 历史预览纯 Map 重放；`:865-874` 成功后保存新替换，resume 可以复用精确字节。磁盘 `writeFile(..., flag:'wx')` 在 `:162`，重复轮次不重写。
- `src/query.ts:379` 存在请求前集成入口，`applyToolResultBudget` 在 `:924` 受可选 state 控制。state 由 feature flag gate 建立（`:447`），所以不能声称默认启用。
- 此实现使用字符而非字节，selectFreshToReplace 不计算实际 preview 成本（`:686-689`），frozen overage 允许保留，Read 等 Infinity 工具不计入预算（`:816-820`）。**不能把它当严格总预算保证，也不建议照抄 50K/200K 常量。**

**Harness 对照：**

- 已有单输出 artifact 注册/哈希/脱敏/头尾预览：`packages/core/src/runtime/context-controller.ts:480-553`；模型看到的渲染字串已存入持久消息（`packages/core/src/runtime/runtime.ts:1344-1353`），无需再做 Claude 式旁路 replacement log。
- 但目前 maxInlineBytes 逐输出判断，多个分别小于阈值的结果可以在同批累计很大；ContextPipeline 的 block 优先级逐出（`packages/context/src/budget.ts:50-61`）和 history trim（`context-controller.ts:378-397`）是后续全局防护，可能不得不逐出较早任务信息。
- 尚未证明此路径在当前 benchmark 中形成基础设施失败或性能回退。它目前只能是策略层待验证假设，不能据此绕过 AGENTS Runtime Freeze 改 core。

**做什么：**比较“每工具独立阈值”与“给本轮结果分配总可见预算、只对较大可回读数据生成引用”的信息保留与成本，先构建可插拔 Agent/context policy challenger。

**怎么做：**先固定离线 replay fixture，包含 1/4/16 并行工具、结果分别低于单阈值但合计超过预算、重要小错误与大量搜索/命令噪声混合；继承现有 artifactStore 和安全路径。由工具语义/任务证据决定受保护失败/验收内容，再按大小/类别对普通结果分配预算；实际计算预览+标头+引用 token 成本。只改变尚未入存储的本轮可见输出，老消息字节保持不变，同一 toolCallId 无额外写入。不在 frozen core 落实现，除非先复现预算契约漏洞或 measured infrastructure regression。

**怎么验收：**paired replay 输入一致，比较请求 token、history 被裁消息数、关键失败/文件位置/验收信号保留、回读次数和 artifact I/O；保证确定性、调用结果关联完整、脱敏先于任何 artifact/inline 边界、故障降级可观察。离线 token 减少不是模型成功率提高；真实模型 paired eval 需单独报告同模型、同任务、成本和安全基线，仅在优于基线且没有信息丢失/安全回退时建议启用。

## 5. 建议 C：统一 UTF-8 工具输出边界（与其他审查项合并）

**Harness 确定性 bug：已运行公开 execute 链复现。** `packages/tools/src/orchestrator.ts:625-632` 先按 Buffer.byteLength 检测，却以 JS `slice(0,maxBytes)` 截断。配置 maxOutputBytes=100、工具输出1000个汉字，返回payload为300字节、含标记为335字节。当前测试 `orchestrator.test.ts:398-417` 只测 ASCII 和 length<5000，未覆盖字节契约。

这与档案工具结果分层处理产生关联，但**发现与验收依据是 Harness 自身行为**，不假装 Claude 的字符阈值比 Harness 更正确。Runtime Freeze 条件 1 确定性缺陷成立。

**做什么/怎么做：**在现有 orchestrator 输出限制内独立实现 UTF-8 安全截断，明确 maxOutputBytes 覆盖 payload 还是包含标记并按契约测试；不得用移除 sandbox cap、raw output 旁路或未脱敏持久化来恢复尾部。artifact保留全量与执行安全硬上限是不同预算，不在本项顺带扩大硬上限。

**怎么验收：**ASCII、CJK、emoji/代理对、0/小边界/恰好边界、多行；最终字节不超约定界限且没有新增 replacement char，非字符串输出行为按显式契约测试。公开 ToolOrchestrator.execute 和生产 Runtime/ContextController 联调覆盖，包含 permission/sandbox deny、timeout、secret redaction及既有artifact安全验收。此项应与其他 agent 的 object/byte边界报告合并，避免重复计划。

## 6. 本次验证材料及未做事项

- `.ci/source-research/claude-repro.mjs` 使用本地既有 Harness `dist` 构建的 ToolOrchestrator / FileSkillLoader / SkillBodyBlockProvider；关键分支与当前 TS 源码逐一对照。没有新安装依赖或修改生产模块。
- `.ci/source-research/claude-repro.json` 记录：`returnedPayloadBytes:300`、`configuredBytes:100`、provider retained old / still injects deleted 为 true、direct loader updated 为 true。
- 未执行 Claude 档案，未声明其测试通过或模型效果优越；未借 missing cachedMicrocompact、remoteSkillSearch、internal coordinator 等模块提出实际实现任务。
- 没有改 plan.md；此报告为主 agent 汇总源码证据、制定合理计划使用。首选 A，B 作为先评测的可选挑战者，C 与整体输出边界维护任务合并。
