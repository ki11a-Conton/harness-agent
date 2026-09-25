# harness-agent 下一步 plan.md：从“安全拒绝”走到“可验证地执行”

- 审查仓库：`ki11a-Conton/harness-agent`
- 上轮计划基线：`1c9a848ba17285b28c3666c5230b8a7756f1e5ab`
- 本轮固定 HEAD：`7157653ff0303a583bd0b971fb459a05b6b30391`
- 提交差异：相对上轮基线前进 5 commits、16 个改动文件；最后一个 `7157653` 只改阶段报告。
- CI 事实：固定 HEAD 的 Actions run `36133801590` 已完成，7/7 jobs success；Windows/Ubuntu 闭环日志各报告 122/122 离线测试、20/20 mutation caught，两侧 artifact 名称绑定 `7157653`。

这是离线回归的有效证据，**不是**生产 paired run 已可执行，也**不是**真实模型效果证据。

本次是远端源码、提交差异、Actions job/log/artifact 元数据审查；没有在本地检出并复跑 `7157653`，没有启动外部模型或付费实验；下述未验证项用下一轮 RED/GREEN 测试来证明。

---

## 一、先把上一轮任务的状态讲准确

新提交修好了真实问题：`main()` 现在先分派 prereg，不会为了 validate 先构造普通 provider；`allowResume=false` 会拒绝显式和隐式恢复；重试预约失败会停止迭代；loader 校验普通重复 key 和两个策略枚举；20 个 mutation 在最新双平台 CI 中被抓住。**这些要保留，不需要重做。**

但仓库的阶段报告写 S0–S6 PASS，应按“离线子项”而不是“上一轮计划全部完成”的语义理解：报告的 S 表没有 S1；生产 observer 主动把关键字段标为 `UNOBSERVABLE`，生产 `runArm` 尚未接线。**安全地拒绝是真实进步，但不等于具备成功执行条件。**

| 上轮任务 | 代码审查判定 | 下一轮处理 |
| --- | --- | --- |
| S0 缺口复现 | 部分完成：针对 CLI、retry、恢复、布尔值有 tests；已有正向测试仍用自报 fixture 和 fake runner | 保留既有 tests，补“假 digest 但格式正确”“真实 transport 次数”“成本文件崩溃”等 RED |
| S1 实际身份/样本 | 未完成：build 仍读用户提供的 catalog/selection；生产 observer 仅重算 case content，未独立证明 eligibility、selection、runtime/request profile、价格和执行上界 | A1、A2 |
| S2 真实 CLI/adapter | 部分完成：预路由和 adapter 注入已做；但其 `runArm` 明确 `ARM_EXECUTOR_NOT_WIRED`，关键身份恒 `UNOBSERVABLE`；CLI 未严格拒绝未知/重复参数，旧 candidate 路径仍并行 | A2、A3、A5 |
| S3 多维预算 | 部分完成：`allowResume`、第二活跃目录和 retry event 拒绝已修；token/USD 仍返回后 charge，tool/duration 未归集，成本文件更新有删除窗口 | A4 |
| S4 可信判定 | 部分完成：字段从新的 evidence 结构推导；但该结构仍由 runner 填写，仅检查 digest 是 64 位 hex、未读取 trace/验证 verifier；恢复记录亦未做内容复验 | A6 |
| S5 真正不同的 E2E | 部分完成：122 个离线 tests、20 mutations；release `main()` 的测试只证明不会说“no adapter”，没有成功跑真实双臂；某些 0 调用计数为脚本常量 | A7 |
| S6 CI/文档 | 离线 CI 已完成；production ready 未完成：当前 HEAD 两平台 7/7 成功，但 artifact 不可替代 production runner/verifier 的正向证明 | A7 中更正报告及独立门禁 |
| S7 真实付费 | 保持 BLOCKED / PAID_NOT_RUN：本请求只是审查与规划，不构成付费授权 | A8 是条件式提示词，默认不执行 |

### 本轮优先处理的源码事实（固定到 7157653）

**F1 / P0：生产命令仍无法走完执行链。** [prereg-production-runner.ts](file:///workspace/apps/cli/src/prereg-production-runner.ts) `#L115-L151` 把 `runtimeConfigDigest`、`requestProfileDigest` 设为 `UNOBSERVABLE`，价格设为 `null`；`#L215-L246` 中的 `runArmNotWired` 始终抛错。当前设计正确地失败关闭，但不能宣称正式 paired runner 已落地。

**F2 / P0：样本与选择出处不真实。** [prereg-command.ts](file:///workspace/apps/cli/src/prereg-command.ts) `#L108-L137` 直接从 config JSON 调用 builder；`observeCaseContentDigests#L180-L212` 按 artifact 给出的路径找 case，计算 content 时传入 `eligible:true, holdout:false`，没有真实校验这些事实。测试 fixture 的 `content-reg-01`、`r87-selection-digest` 是占位符。真正的 `e4-r87-case-selection.json` 属于 H2 progress-blind gate 的 3 个 target + 5 个 counterexample，不能直接冒充 `tool_call_efficiency_v1` 的真实适用样本；要先设计并冻结对应机制的选择。

**F3 / P0：成本账本仍不能事前证明全部额度。** [tool-call-efficiency-formal-run.ts](file:///workspace/packages/evaluation/src/tool-call-efficiency-formal-run.ts) `#L364-L462` 读异常一律当文件不存在、只在事后 charge input/output/USD、先 `rm` 再 `rename`；tool/duration 从调用方从未 charge。`#L510-L595` 每次新请求只先预约 call ledger；其他维度未做不可越限的物理请求前预约。OpenAI provider 的 retry 事件在下次 fetch 前 yield，现有预约点的时序有用，应以真实 fetch 计数测定并保留，**不要笼统回退这项修复**。

**F4 / P0：evidence 有形状，不等于证据被验证。** [tool-call-efficiency-paired-campaign.ts](file:///workspace/packages/evaluation/src/tool-call-efficiency-paired-campaign.ts) `#L62-L160` 的 `verifiedCompletion` / `securityViolations` / `activationEvidenceDigest` / `traceDigest` 仍由 runArm 返回；只验证类型与 hex 形状。测试里的 armRunner 用 `"a".repeat(64)`、`"b".repeat(64)` 构造“trace/activation”而无原始 trace/真实 verifier。`readRecord#L205-L227` 恢复时仍未复算证据内容。

**F5 / P1：恢复与判定的关联不完整。** `runPreregisteredCampaign#L234-L304` 无论 `opts.resume` 是否为 true，遇到已有记录都复用；未逐项核 `orderIndex/outcome`，未排除额外文件。`aggregate#L366-L471` 把 `tokensUsed ?? 0` 用于决策，但未让成本账本的 unknown/超额状态参与 `decideChampionV3`。

**F6 / P1：旁路与输入解析。** [prereg-command.ts](file:///workspace/apps/cli/src/prereg-command.ts) `#L86-L105` 跳过未知 `--flag`，build/validate/run 仅取第一个 positional；[benchmark-command.ts](file:///workspace/apps/cli/src/benchmark-command.ts) `#L1397-L1485` 的旧 `--candidate` 路径有自身 plan digest/付费 cap 保护，但对本机制未强制 v2 prereg gate。不能误称旧路径“无保护”，也不能视为与 v2 等价。

**F7 / P1：canonical/路径仍有边界案例。** [tool-call-efficiency-preregistration-v2.ts](file:///workspace/packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts) `assertNoDuplicateJsonKeys#L660-L701` 比较的是原始字符串片段：`"x"` 与 `"\u0078"` 经 JSON 解码是同一 key，却不会按同一 key 比较；loader 亦未要求原始 JSON 字节等于 canonical 序列化。[prereg-production-runner.ts](file:///workspace/apps/cli/src/prereg-production-runner.ts) `locateCaseDir#L168-L177` 按 artifact 的 suite/caseId 拼接路径，须给 `../`、符号链接、跨 suite 建立边界测试。

**F8 / P1：离线产物的零调用字段不是实测。** [n5-prereg-closed-loop.mjs](file:///workspace/scripts/e4/n5-prereg-closed-loop.mjs) `#L177-L195` 将 `externalProviderFactoryCalls`、`externalProviderCalls`、`networkRequests`、`costUsdMicros` 直接写为 0；它验证了没有付费 key/开关且 suite 用 fake，但 artifact 中的这些数本身不是统一插桩测量。要么升级为真实计数，要么明确标为 `NOT_OBSERVED`，不能当作可复核的零调用证明。

---

## 二、给所有 Agent 的统一边界

下面 A0–A8 每节都是一条可复制给 Agent 的任务提示词。依赖顺序：A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7；**A8 默认不启动**。每条先运行 `git rev-parse HEAD` 与 `git status --short`，核查上一步提交与当前主分支差异，阅读仓库 `AGENTS.md` 及相应 `tasks/` 文件。未经确定性 bug/security/release-integrity 的复现，不碰 frozen Runtime，也不能绕过 `ToolOrchestrator`、`PermissionEngine`、`SandboxManager`、`Verification`。

**A0–A7 统一约束：0 外部模型请求、0 费用；密钥/真实 endpoint 不入日志。** 本地执行以 Windows PowerShell 为准，不要求用户安装 WSL、Docker 或本地 Linux；Ubuntu 证据来自 GitHub Actions。测试可用 fake provider 和可计数的本地 HTTP stub，但不能对真实 provider 发请求。每一项新增红灯的反例必须先说明“旧代码如何失败、修复后什么断言通过”；若不能复现，就撤销对应推断。不得为“绿灯”删除旧 122 个 tests / 20 个 mutations，不能用 skip、`.fails` 常驻或硬编码 0 代替观测。

计划中的 `PAID_NOT_RUN` 是默认且必须维持的验收结果。仓库里的 `paid:true` fake JSON、API key、`RUN_PAID_BENCHMARKS=1`、口头“做完计划”均不代表用户批准预算；A8 要求另行获得明确授权。

### A0 — 校正状态与反例基线，别让报告提前宣称完成

**直接给 Agent 的提示词**

你在 `ki11a-Conton/harness-agent` 当前 HEAD 工作。目标是把最新 CI 的有效事实和生产未闭环的缺口分开，先写可复现的 RED，不要在本任务内用文档描述代替运行结果。全程 0 外部模型调用。

**做什么**

- 固定起始 SHA `7157653`；记录它相对 `1c9a848` 的 5 个提交、最新 HEAD run `36133801590` 的 7/7 job、双平台 122/122 与 20/20、artifact HEAD。区分测试数字与生产 readiness。
- 按 F1–F8 写“源码证据 → 当前失败复现 → 期望 hard gate → 负责后续任务”的矩阵。报告 S1 尚未验收、S2/S3/S4/S5/S6 的离线与生产范围，不把安全拒绝说成真实执行。
- 建立 RED：prereg validate 对真实样本无法认证关键身份、run 无 arm executor；假 64-hex evidence 不具真实 trace；多维预算事后越限；first-run 错用旧 resultsDir；转义后重复 JSON key 被接受；未知 CLI flag 被忽略。**只新增测试/诊断，不修生产逻辑。**

**怎么做**

- 阅读 `prereg-production-runner.ts`、`prereg-command.ts`、`formal-run.ts`、`paired-campaign.ts`、`preregistration-v2.ts`、R97 worker/ledger、阶段报告；记录断言的实际文件/行号。测试均在临时目录，用短 fake request 与本地 HTTP 计数器。
- 让失败测试可单独运行并附预期 reason code；不要把旧 122 个测试改成必然 RED。可在独立 RED 测试文件里先断言旧行为、留可机读失败记录，再由对应 A1–A6 将其转绿；CI 在修复前标示 known gap，但不能把该文件从生产门禁永久排除。
- 用 `git status --short` 确保没覆盖用户工作树；重跑 `pnpm typecheck` 和已有 targeted suite，保存退出码与日志摘要。

**怎么验收**

- 有起止 SHA、对照表、当前 HEAD 双平台 CI URL 与七个 job 状态；明确“未在真实付费模型上测试”。
- F1–F8 每项要么有确定 RED/源代码证明，要么注明无法复现并从后续任务删除；没有“凭计划说 PASS”。
- 现有测试及 20 mutation 不被删改/跳过，任何真实 provider resolver/factory/client/HTTP 计数由 spy 实测；全程 0 外部网络付费请求。
- 建议单独提交：`test(evaluation): pin remaining formal execution gaps`。

### A1 — 给工具调用机制挑选真正适用的冻结样本，替换自报 catalog

**直接给 Agent 的提示词**

当前 R87 选择文件针对 H2 stall/progress-blind gate，不是 `tool_call_efficiency_v1`。你要先找到本机制的真实 dev-set、资格规则、holdout 边界、case 内容及选择理由，冻结选择后才可以建设 production prereg build。此任务不准读 holdout 明文来挑样本，不准新增模型调用。

**做什么**

- 清点 `benchmarks/`、现有 case loader、机制 contract、历史候选/失败分层与 holdout 声明；提出 `tool_call_efficiency_v1` 的真实、足量、机制相关 case selection 与版本化选择规则。若没有足够合格样本或选择会泄露 holdout，返回 `BLOCKED / INSUFFICIENT_ELIGIBLE_CASES`，提交差距说明，不编造样本。
- 建生产 `catalogFromRepository` + `selectionFromFrozenEvidence`：实际 case ID、suite、request/expected/fixture/case metadata、eligible/holdout/source rule 内容被只读重算；CLI `prereg build` 不再允许任意 catalog、`eligibilityDigest`、`selectionProvenanceDigest`、source SHA、`maxModelCallsPerRun` 由 JSON 自证。
- 给输入路径边界：只能读允许的 repo benchmarks 根及冻结 artifact；拒绝 `../`、绝对/驱动器路径、符号链接逃逸、重复/跨 suite ID，失败时不能把文件内容或绝对路径写进公共报告。

**怎么做**

- 先对比 `e4-r87-case-selection.json` 的 H2 规则与 tool-call mechanism；发布非付费的选择提案（规则、候选 ID、未查看 holdout、为何覆盖工具调用目标和反例）。选择是否代表用户期望的评测范围若不明确，等待用户确认再冻结，不要偷偷把 R87 8 个 case 改个名字沿用。
- 从真实 `case.json`/case loader、`caseInputFingerprintV1` 与 eligibility 规则派生 canonical case/selection digest；build 只读取允许的选择引用。validate/run 不从 artifact 猜 eligibility，要从相同独立来源重新观察；冻结证据与 subject SHA 分离，避免生成文件自引用让 Git tree 变 dirty。
- 将原 `n5-prereg-config.json` 和 `tool-call-efficiency-preregistration-v2.fixture.json` 明确标 `TEST_ONLY`，旧 fixture 可保留历史离线 tests，不得在 production observer 当真实样本。

**怎么验收**

- 新的 0-call production build 只对真实、非 holdout、合格、机制相关的 case 成功，selection digest/每 case content + eligibility digest 可从文件和冻结规则独立复算。
- 更换真实 request/expected/fixture/case metadata、改 eligibility/holdout、删 case、复制 ID、改选择规则/顺序、输入 `../`/symlink，validate/run 在 provider factory 前明确拒绝；旧占位 `content-reg-01` 不能通过。
- 说明本选择与历史 H2 R87 8 case 的区别；如果真实样本数不足，保持 BLOCKED，不能降低 `minEligibleCases` 使测试通过。
- Windows PowerShell 可完成构建与 targeted tests；`pnpm typecheck`、`pnpm build` 成功。建议提交：`fix(evaluation): derive tool-call prereg cases from frozen real selection`。

### A2 — 让 production observer 有可证实的运行身份与价格来源

**直接给 Agent 的提示词**

不能通过把 `UNOBSERVABLE` 简单替换成 artifact 中的值来让 gate 通过。你要让 `runtimeConfigDigest`、`requestProfileDigest`、baseline/candidate arm、judge/verifier/scorer、provider/model/endpoint、价格和真实最大调用次数来自将要实际执行的同一份配置；观测不了就保持拒绝。0 外部付费调用。

**做什么**

- 建只读 `observeExecutionPlan` 与生产 prereg build 的共同身份源，不依赖已批准 artifact 回显；默认 provider/model 与实际 `resolveModelProvider`/client 参数一致，包括未显式设置 `OPENAI_MODEL` 的默认值。
- 真实解析 arm checkout/build、隔离后端、harness max iterations、内部 retry 最大数、可能另行调用 provider 的 judge/verifier；建立完整 worst-case calls/tokens/USD 与版本化定价快照。价格、usage 或上限无法证明时用稳定 `UNOBSERVABLE`/`PRICING_UNKNOWN`/`BOUND_UNKNOWN` 拒绝，不能给 0 或 null 金额上限放行付费路径。
- 冻结 subject/source commit、版本化 schema 与审批关系；修改任何批准语义时升 schema，旧 artifact/approval 仅可验证为历史证据，不能在新解释下自动付费。

**怎么做**

- 从实际 provider resolution、模型配置、request profile、R97 两臂实际可执行 checkout 与 benchmark worker 中取值，并在 build/validate/run 复用同一序列化/哈希函数；绕开 env 配置的隐藏默认会形成 identity drift，必须测试。
- 给每一字段制作来源表：权威文件/运行参数、哈希算法、被谁消费、缺失时 reason code；明确 `selectionProvenanceDigest`、judge/verifier/scorer 及实际 `maxModelCallsPerRun` 的来源。不得把注释 `REAL` 当实测上界。
- 使用只读 dry-run 生成生产 artifact 到仓库外路径；同一冻结 commit 上 validate 必须确实成功，更改任一关键来源必须 fail closed。继续保持 `main()` 先分派 prereg 的 0 provider resolver 性质。

**怎么验收**

- 成功路径：真实 case + 两臂 checkout + 完整配置 + 可审计价格时，发行版 `node apps/cli/dist/main.js prereg validate <artifact>` 返回成功，resolver/factory/client/HTTP 全为 0。
- 失败路径：去掉任一来源、默认 model 与观察不一致、不同 arm build、judge/verifier/请求 profile、价格快照/计费单位、provider endpoint、source SHA 变化，均给稳定拒绝码且 0 provider construction。
- `30 × 32 = 960` 只能在实际执行器上限确为 30 且 judge/retry/其他物理调用已另计时称 worst case；报告真实公式和具体上限。
- `pnpm typecheck`、observer tests、`pnpm build`、Windows dry-run 通过，0 外部模型调用。建议提交：`fix(cli): observe formal execution identity independently`。

### A3 — 严格的授权输入、canonical JSON 与唯一 candidate 入口

**直接给 Agent 的提示词**

你要堵住“命令看起来接受了输入，其实静默忽略”和“旧 benchmark candidate 流绕过新协议”的差异。保持别的 benchmark 功能；`tool_call_efficiency_v1` 对外付费入口只能有同一套正式准入。不得把现有旧 guard 描述成没有保护，且整个任务不发真实模型请求。

**做什么**

- `prereg build/validate/run` 用严格参数 schema 拒绝未知、重复、矛盾 flag、额外 positional、空值、危险路径；`--mode` 只允许显式 `first-run`/`resume`，付费路径不可默认 auto。
- v2 prereg 与 authorization 的 JSON parser 对转义等价 key、重复键、非 canonical 原始字节、未知/坏 enum、丢失字段做一致的拒绝；不要在同一 schema 静默换审批语义。
- `benchmark --candidate tool_call_efficiency_v1` 若可达到真实付费 provider，必须转入同一 pre-registration/authorization gate，或者在任何 provider construction 前明确拒绝并给迁移提示；其他 candidate/普通 benchmark 保留现有保护。

**怎么做**

- 复现 `{"x":1,"\u0078":2}` JSON 解码后同名、现有 scanner 比较原始 escape 文本的差异；选择可靠的重复键处理/严格 canonical 字节入口，并给 `preregistration-v2.ts` 及 `formal-run.ts` 的 authorization 都加测试。仅仅做 `JSON.parse` → `JSON.stringify` 不足以发现原始重复键。
- 把 `prereg-command.ts` 的 flag/positionals 改为显式参数白名单，先 parse 后任何 observer/provider；对 `--out`、`--budget-dir` 分离路径用途，拒绝相同/重叠导致记录覆盖和复用的组合。
- 审查旧 benchmark 对该 candidate 的可付费分支，选“统一 gate”或“明确禁用”；写真实 `main()` 测试，保留老路径原有 `RUN_PAID_BENCHMARKS`/plan digest/cap 针对其他工作负载的行为。

**怎么验收**

- 重复键（包括 escaped key）、非 canonical 原始输入、未知 flag、重复 `--out`、多余 positional、`--model`/预算覆盖、无效模式均稳定拒绝且 provider resolver/factory/HTTP=0；不泄漏 key/endpoint。
- 没有 v2 approval 的旧 tool-call-efficiency candidate paid-eligible 命令绝不构造真实 provider；其他 benchmark 的原 paid guard、dry-run、smoke tests 仍通过。
- CLI help、README 与错误码反映真实使用方法；`pnpm typecheck`、CLI/loader tests、`pnpm build` 成功。建议提交：`fix(cli): reject prereg overrides and close candidate bypass`。

### A4 — 将多维账本改成耐崩溃、不可重置的事前预算

**直接给 Agent 的提示词**

本任务是付费安全边界，优先于运行正式双臂。已有 retry event 失败即停止、`allowResume=false` 等修复要保留；不能仅靠事后 charge 或 `budgetRemaining` 数字保证不越限。用本地 fake transport、假时钟、并发/崩溃注入，全程 0 真实外部请求。

**做什么**

- calls、input/output/total tokens、tool calls、duration、USD 为每个可能计费的物理请求先在同一 durable state 中预留保守上界，再发送；真实用量结算，unknown 不能退款。对独立 provider-backed judge/verifier/compaction/retry 也要单独预留。
- 修复 `CostBudget.open` 全部读错都变“文件缺失”、`writeAtomic` `rm`→`rename` 缺失窗口；first-run 不采纳已有历史，resume 要求原 authorization/root/caps/价格/历史与 resultsDir 同一身份，多个进程/目录不能各得一份额度。
- 对 model output 上界/价格不存在、provider usage 缺失、tool/duration 无法限制或计量的情况，拒绝准入，不得把这些量记为 0；金额上限必须为有限显式值。

**怎么做**

- 设计 versioned journal/atomic replace（同卷 rename + fsync/恢复策略，Windows 兼容）与 R97 既有锁的单一事务边界；把 `ENOENT` 与 `EACCES`/`EPERM`/坏 JSON 区分，只能真正的全新 campaign 建空账本。unknown 状态按最坏可能花费保留并阻断后续请求，不能回滚成满额。
- 对每次 generate 先 reserve calls + token/output/price/tool/time 的可证明上界。OpenAI retry 事件当前在下一次 fetch 前 yield，做真实 transport fetch 次数测试：余额 1 时第一次可送、第二次绝对不送；将来的 provider 若无 pre-send 信号则禁用内部 retry 或新增 hook。
- 将 tool/duration 真实消耗或可证明上界接入统一账本；aggregate 在产生 ACCEPT 前核实际用量、超额、unknown、跨目录重复批准。授予恰好用尽可接受的是完整且无超额的实验，不能误把 `remaining=0` 一概作失败。

**怎么验收**

- 每个维度的“恰好到上限、超过 1、未知、并发、取消、进程崩溃后恢复”均不能超过授权；真实 fetch 计数证明未预算的 retry 不发送。
- 缺失/坏 JSON/权限拒绝的成本文件、`rm`→`rename` 崩溃窗口、不同目录重放相同 approval、第一次执行遇旧 resultsDir、`allowResume=false` 均在 provider factory 前失败；既花额度不能重建。
- `maxToolCalls`/`maxDurationMs`/`maxInputTokens`/`maxOutputTokens`/`maxTotalTokens`/`maxUsdMicros` 实际生效；缺价格或 usage 时不是 0；所有记录可从 durable journal 复算。
- Windows PowerShell targeted tests、`pnpm typecheck`、`pnpm build`，以及 Ubuntu Actions 的故障注入均通过；保留原 20/20 mutation。建议提交：`fix(evaluation): reserve and recover every billed dimension`。

### A5 — 装上真正的 production 双臂 executor，不伪造成功

**直接给 Agent 的提示词**

当前 `runArmNotWired` 是正确的安全停机，不是已经完成的 runner。你要把已有 R97 worker/driver 的真实隔离执行能力接到 v2 `PreregRunnerAdapter.runArm`；不能用 N5 fake arm runner 代替。先只跑本地 fake provider 与真实 case/verifier，不发真实外部模型请求。

**做什么**

- 为每个 `(case, repetition, arm, orderIndex)` 创建隔离运行单位，baseline/candidate 来自冻结的两个实际 checkout/构建，case fixture 相同，只有预注册候选机制差异；不能用一个构建跑两臂。
- 把 A4 gate 返回的 budgeted provider 传至唯一可出网路径；worker/child process 不得从 env 再构造旁路 provider。调用既有 `ToolOrchestrator`、`PermissionEngine`、`SandboxManager` 与真正 verifier；失败 category 与 timeout 可观察。
- 完成时返回不可变运行结果的引用和运行身份，A6 再复验；缺 executor/checkouts/verifier/isolation 保持 `ARM_EXECUTOR_NOT_WIRED` 或更精确拒绝，不给假 `status:"passed"`。

**怎么做**

- 对照 `packages/evaluation/src/r97-*` 的 driver/worker/ledger、`apps/cli/src/benchmark-command.ts` 的 harness factory 和 `prereg-production-runner.ts`，列“复用的实际 API/数据流/需要的最小适配”。若 frozen runtime API 不支持传入预算 provider，先提交接口差距及可复现阻塞，不私改核心。
- arm 启动前对 `sourceSha`/`armDigest`/selection/case bytes/executor schema 复验；在临时隔离目录读 fixture、将同一冻结 model/provider/策略传入；所有 provider 调用跨进程可计数/预算，或者根本不放行。
- 先做一个真实 case 的 baseline/candidate 离线正向，再扩展到全部已批准 schedule；最后通过发行版 `main()` 执行，而不只是调用 `runCommand(...fakeDeps)`。过程中不得自行创建用户“付费授权”；测试只用明确 `TEST_ONLY` 授权 fixture。

**怎么验收**

- 真实 CLI adapter + fake provider + 真实 case/verifier 在 0 外部请求下至少完成一对双臂，且可回溯两臂 build SHA/digest、隔离后端、fixture、verifier 结果；新增 tests 能在把两臂强行改成同一构建时失败。
- 未提供真实 arm checkout、执行器或 verifier 时 0 provider factory/calls 拒绝；子进程不能实例化未包预算的真实 provider。
- R97 回归、`pnpm typecheck`、`pnpm test`、`pnpm build` 成功；Windows 本地可复现，Linux 仅 Actions。建议提交：`feat(evaluation): execute preregistered arms through verified worker`。

### A6 — 让 trace、verifier、activation、security 和 resume 真正可复核

**直接给 Agent 的提示词**

不能再用长度正确的 `"a".repeat(64)` 当作有效 trace，亦不能让 runner 自己同时宣称“verifier=true、安全事件=0”就完成可信判定。你要实现“运行原始记录 → 独立校验 → aggregation → decision”的闭环；继续只用离线 fake 模型。

**做什么**

- 用真实执行器记录的不可变 trace/manifest、请求边界 guidance 激活事件、verifier 原始产物、安全/权限事件及统一 budget journal 生成每 arm 的 evidence；验证 digest 必须读取并哈希实际 bytes，校验其来源和 schema。
- 修复 resume：`resume=false` 时已有记录必须拒绝；`resume=true` 要逐项校验 schema/root/plan/case/repetition/arm/orderIndex/outcome/evidence，扫描并拒绝额外文件、重复或缺少的已宣称记录；记录持久化与预算状态必须具有一致恢复契约。
- 决策只依赖经过独立验证的证据与已冻结 policy；`tokensUsed` 来自 ledger/usage，不接受 runner 自报默认 0；价格/unknown/越限、基线污染、缺 verifier/activation/安全记录均不可能 ACCEPT。

**怎么做**

- 将 `PreregisteredArmOutcome` 的决策输入改为原始 artifact 引用，不让可控 runner 直接赋 `verifiedCompletion`/`securityViolations`/`activationEvidenceDigest`；对照 R97 verifier 与 `activation-evidence-v2` 的原始结构编写单独 validator。普通 hash 是完整性校验，不是“内容来源可信”的证明，要绑定真实 execution manifest 和预算日志。
- 使用同一回放校验器处理刚产生的记录和恢复记录；按 plan 的完整矩阵扫描结果目录。必要时升级 run-record/aggregate schema；旧记录默认不可授权新 schema 的 ACCEPT。
- aggregate 执行前从被验证的证据派生所有 `DecisionGateInputV3`，冻结 `policyDigest`，核 cost budget 与 provider call ledger；judge 结果不完整时给 `INVALID/INCONCLUSIVE`，不准硬写 0 个违规。

**怎么验收**

- 构造 32 条 `status:"passed"` + 合法形状的 `traceDigest:"a"*64`、`activationDigest:"b"*64`、`verifiedCompletion:true`，但没有相应 trace/verifier/request event：拒绝或 INVALID，不可 ACCEPT。
- 篡改 trace 一字节、交换两臂 manifest、把真实 verifier fail 改 pass、隐瞒一次安全事件、给 baseline candidate guidance、修改 tokens、复用跨实验的记录、额外文件/重复 arm、first-run 有旧记录、resume 缺账本，逐一给稳定错误码；这些测试 0 外部请求。
- 正向 fake 模型仍走实际 verifier + 被验证的 request-bound 激活 + 完整账本，可在离线环境生成自洽的机器判定，但文档明确不推断真实模型效果。
- `pnpm typecheck`、paired-campaign/decision/CLI E2E tests、`pnpm build` 通过。建议提交：`fix(evaluation): verify per-arm evidence and fail closed on resume`。

### A7 — 发行版入口的离线正反 E2E、实测计数、双平台 CI 与诚实文档

**直接给 Agent 的提示词**

现在把 A1–A6 变成每个新 HEAD 都能重复的离线门禁，不能仅靠 122 个 injected fixture tests 或“0 次调用”的字面常量证明 production ready。用户本地仅需 Windows PowerShell；Ubuntu 由 GitHub Actions 执行。整个任务仍是 0 外部付费模型调用。

**做什么**

- 两类 suite 分开统计：历史 N5 假 catalog/注入 runner（回归用）与 发行版 `node apps/cli/dist/main.js` + 真实 selection/observer/arm executor/verifier + fake transport（production wiring 证明）。实际双臂 schedule 要在真实 case 上完成；旧 benchmark 路径也测拒绝/统一 gate。
- 每个 preflight 反例测 resolver/factory/client/HTTP=0；真实正向离线路径测物理 calls/retries/usage/ledger/trace/verifier 数。将 `n5-prereg-closed-loop.mjs` 的四个字面 0 改为插桩得来的有来源数字，测不了就写 `NOT_OBSERVED`，不冒充 0。
- 保留现有 20 个 mutation，再添加能抓住：假 evidence 被接受、`resume=false` 偷用旧结果、cost budget 无法原子恢复、tool/duration 未计量、转义等价重复 key、旧 candidate 旁路、同一构建两臂、真实 CLI adapter 从未跑通。mutation 必须改变目标源码且让目标断言 RED。
- 报告/attestation 分开 `offlineFixtureReady`、`productionOfflineReady`、`paidExperimentRun`、`championPromotion`；更新 `docs/evidence/tool-call-efficiency-p1-p7-report.md` 的 S1 与 S0–S6 状态，不能沿用过宽的 PASS。

**怎么做**

在 Windows PowerShell 从仓库根执行：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm docs:verify
node scripts/e4/n5-prereg-closed-loop.mjs
node scripts/e4/r97-mutation-check.mjs
```

- 新的 production-offline E2E 建单独脚本/测试入口并加进 `.github/workflows/ci.yml` 的 `windows-latest`、`ubuntu-latest`；清空真 key/付费开关，拒绝任何真实外部请求。
- 插桩由测试使用的同一个 composition root/transport 产生，导出每项计数来源/测试名/checkout SHA；artifact 名含 `github.sha`、OS、run id、attempt。Windows 与 Ubuntu 的 root/selection/identity 和预期案例摘要可逐项比对。
- mutation 脚本先断言源码确实被改变、用 `finally` 恢复；不可同常规测试并行。发布 PASS 前下载或检查两个平台的 artifact/日志，核 HEAD、测试数、mutation 抓取数与 run ID。

**怎么验收**

- 同一新 HEAD 的标准 Windows/Ubuntu、closed-loop Windows/Ubuntu、coverage、release attestation 全绿；新 production-offline E2E 正向跑完整 paired matrix，负向矩阵覆盖 F1–F8，0 外部网络费用由插桩实测。
- 旧 122/122 和 20/20 不倒退；新增测试/mutation 单独列出，全部捕获；脚本不能打印未经测量的 0，不能把 fake 模型跑通写成真实效果。
- artifact HEAD/OS/identity/reason code/计数与 checkout 和日志一致，不含 key/raw endpoint；报告每个 PASS 有源码路径、命令、CI/产物链接；S7=BLOCKED / PAID_NOT_RUN、`championPromotion=NOT_RUN`。
- 只需本地 Windows PowerShell 和 GitHub Actions Ubuntu；不能要求作者做本地 Linux 冷启动。建议提交：`test(ci): prove prereg production path offline on both platforms`，再单独 `docs(evidence): report actual readiness by evidence level`。

### A8 — 条件式真实付费实验（默认停止，不在本次请求执行）

**直接给 Agent 的提示词**

你现在没有发起付费请求的授权。本节只是未来的准入条件；A0–A7 即使全部绿，也只证明“可以安全考虑实验”，不证明用户批准费用、候选优于基线。只有用户日后单独、明确批准 exact prereg digest、provider/model、case selection、时效以及 calls/tokens/USD 的有限预算，才能转入人工审核后的执行。未取得授权时输出 `BLOCKED / PAID_AUTHORIZATION_REQUIRED`，provider resolver/factory/client/HTTP=0，cost=0，然后停止。

**做什么**

- 将 A7 冻结的 executable-source commit 与可复算的真实 pre-registration、两臂 build、case/selection、judging、最坏 calls/tokens/USD/price snapshot 交给用户审阅，不能由 Agent 自造授权文件。
- 经用户另行签字/明确授权后，执行一次 zero-call validate；身份/预算/审批/账本均匹配且无未知时才能运行正式成对实验；任何异常停止新请求、保留已花预算与 trace。
- 依据可复核证据输出 `ACCEPT/REJECT/INCONCLUSIVE/INVALID`；即便 ACCEPT，也不自动把 candidate 应用为 champion，另设独立审批。

**怎么做**

- 用户未给批准时只准备供审查的非敏感计划摘要与 `PAID_NOT_RUN` 报告；API key、旧 `RUN_PAID_BENCHMARKS`、测试 `paid:true` 均不能替代授权。
- 获授权后用 exact-match approval 文件验证完整 identity、expiry、`allowResume`、所有 cap 与价格；从冻结 checkout 和原始 manifest 复算 case、arm、verifier/policy digest。所有会付费的 provider-backed judge、主调用、重试均受 A4 事务预算约束。
- 完整 paired runs 才进入 A6 verdict；`INCONCLUSIVE/REJECT` 不自行追加 paid repetition 或变更预算。审计输出实测物理请求、token、金额、证据链与安全事件。

**怎么验收**

- 当前验收：必须拒绝并保持 `PAID_NOT_RUN`，0 resolver/factory/client/HTTP/费用。任何 Agent 不能因看到本节便实际消费 API 额度。
- 如果未来有用户另行授权：准入与批准 exact-match，不超任一 cap；记录可复算，无 unknown/伪证；只有真正完整且所有 hard gates PASS 时可提出人工审查 champion apply。

---

## 三、每项任务交付格式与本轮完成判据

每个 Agent 结束必须给：任务编号和 PASS/PARTIAL/BLOCKED；起止完整 SHA 与工作树；production/test/CI/docs 改动；RED→GREEN 的测试名与命令、退出码/通过/跳过数；Windows 本地和对应 HEAD 的 Windows/Ubuntu Actions URL；resolver/factory/client/physical fetch/retry/tool/token/USD 的实测计数（不可测写 `NOT_OBSERVED`）；source/selection/prereg/approval/ledger/verifier/decision 摘要链；剩余风险与下一任务是否解锁。不输出 secret、原始 endpoint、私人文件内容。

本轮完成标准不是“又多几个绿测”：

- 真实选择和身份可从代码/文件重算；
- production observer 对合法冻结实验能成功验证；
- 发行版入口能在 fake provider 下实际跑完整双臂与 verifier；
- 所有物理付费维度均事前受耐崩溃预算约束；
- run evidence 能复验原始 bytes、伪造 hash 不可 ACCEPT；
- 恢复和旧 candidate 入口不能旁路；
- 当前 HEAD 双平台 CI 与 artifact 支持这些具体不变量。

达到这些才可写 `productionOfflineReady=PASS`；真实模型表现与付费许可仍分别为 `UNKNOWN` 和 `PAID_NOT_RUN`。