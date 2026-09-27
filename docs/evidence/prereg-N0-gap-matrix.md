# prereg 下一轮缺口矩阵（N0）

> 本文件是 `plan(20260926-175819).md` §N0 的交付物：把该计划列出的下一轮风险变成**可失败、
> 可单跑、离线**的行为级反例，并如实记录当前 HEAD 的可观测行为、预期拒绝码、实际物理
> 请求数/账本值、对应修复任务与复现命令。**N0 不修改生产实现**——它校准证据。
>
> 与 B0 的区别：B0 的反例允许"结构性 pin"（源码契约）；本轮计划 §N0 明确
> **"禁止凭源码字符串匹配充当行为证据"**，因此下面每一条都调用出厂函数或出厂 worker
> 子进程，并断言它产生的**返回值 / 异常码 / 退出码 / 落盘副作用**。

## 0. 基线与证据范围（如实声明）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 计划审查基线 SHA | `67ded22917db084cfadb70c690d7d4babc95d91c` | plan §前言 |
| 本工作树 HEAD | `1299e5cb51a668208501ceb103d50eac5bdcfdd3` | `git rev-parse HEAD`（本地实测） |
| HEAD 相对基线的代码差异 | 仅 `apps/web/public/index.html.zip`（二进制，0 增 0 删）；**源码与 67ded229 相同** | `git diff --stat 67ded229..HEAD`（本地实测） |
| `git status --porcelain`（N0 起始） | `D HANDOVER.md`、`D plan(20260926-070459).md`、`?? plan(20260926-175819).md`（**用户预置改动，保留未动**） | 本地实测 |
| 平台 / Node | Windows（win32）/ Node `v24.14.0` | 本地实测 |
| 本环境实际执行 | 离线 `vitest`（两套专用配置）+ `tsc -b`；**未**对真实付费端点发请求、**未**使用任何 API key、**未**下载 CI artifact 逐字节复核 | 本地实测 |
| 真实外部请求数 | **0**（唯一 socket 是测试自建的 127.0.0.1 loopback server，用于证明 arm 可绕过预算渠道直接出网） | 本地实测 |

**在无真实 key、无付费授权的前提下**：`paidExperimentRun = NOT_RUN`、`championPromotion = NOT_RUN`。

### 0.1 上一轮 G1–G7 反例的当前实跑结果（不删测试取绿）

计划 §N0 要求"把旧 G1–G7 的历史 RED 注释注明为历史、并确认当前 14 个用例实跑结果"。

```
pnpm exec vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts
```

| 项 | 实测 |
| --- | --- |
| 结果 | **`Test Files 2 passed (2)` / `Tests 14 passed (14)`** |
| 退出码 | **0** |
| 原始日志 | `.ci/n0/red-next-gaps.log`（`.ci/` 已 gitignore，可由上述命令重放） |

结论：B1–B6 已关闭 G1–G7；`14/14` 现在 GREEN。两个测试文件的**头部注释已补记 HISTORICAL 状态**
（`STATUS AT HEAD 1299e5cb … the historical RED is now GREEN`），正文断言**逐字未改**，作为回归 pin
保留。未删除、未放宽任何用例。

### 0.2 本轮 N0 反例如何"单跑"而不弄红绿色回归

新增两个**故意在 HEAD 上失败**的文件，因此从根 `vitest.config.ts` 的 `include` 中
**结构性排除**（见该文件 `exclude` 新增两项），并只由专用配置收集：

```
pnpm test:n0-gaps          # = vitest run --config apps/cli/test-infra/n0-gaps-vitest.config.ts
```

判别力核对：`pnpm exec vitest list` 的输出中匹配 `n0-gaps|prereg-next-gaps` 的行为 **0**
（根回归既不收集 N0 反例，也不收集旧 14 条）。`pnpm typecheck`（`tsc -b`）**exit 0**，
说明新增测试文件可编译，不会以编译错误污染门禁。

---

## 1. N0 行为反例矩阵（HEAD `1299e5cb` 实测）

命令：`pnpm test:n0-gaps` → **退出码 1**，`Tests 11 failed | 1 passed (12)`（原始日志 `.ci/n0/n0-red.log`）。

| 编号 | 计划风险 | 反例断言（行为级） | HEAD 实测 | 预期（修复后） | 对应任务 | 测试名 |
| --- | --- | --- | --- | --- | --- | --- |
| **N1a** | 真实 `benchmark-command` 缺 worker 所需导出 | 出厂入口模块必须导出**非空** `R97_ARM_PROBE` 与 `runOneCase` | `typeof mod["R97_ARM_PROBE"] === "undefined"`（`runOneCase` 为 function） | `string` 且非空 | N1 | `[N1] the shipped benchmark-command module must export a non-empty R97_ARM_PROBE and runOneCase` |
| **N1b** | （对照，非 RED）worker ABI 是否真的强制 | 缺 probe 的 checkout 条目被 worker 拒绝 | **通过**：退出码非 0，`code = PREREG_WORKER_PROBE_MISSING` | 不变（回归 pin） | N1 | `[N1] CONTROL: the worker refuses a checkout entry that exports runOneCase but no probe` |
| **N2** | 预注册 `isolation` 未传入生产 executor | 生产 adapter 对声明 `vm/strong` 的实验必须以 `ARM_ISOLATION_UNSUPPORTED` 拒绝 | **`ARM_CHECKOUT_MISSING`**（对照：把 isolation 显式传入 executor 时确实返回 `ARM_ISOLATION_UNSUPPORTED`） | `ARM_ISOLATION_UNSUPPORTED`，且发生在 provider factory 之前 | N2 | `[N2] the PRODUCTION adapter must refuse an unsupported isolation with ARM_ISOLATION_UNSUPPORTED` |
| **N3** | `paid:true` + `maxUsdMicros=null` + 未知价格仍可被接纳 | 未知价格（`usdMicrosPerCall: null`）必须被拒绝，且 `makeProvider` 调用数 = 0 | **`status = ADMITTED`，`makeProvider` 调用 1 次** | **已实现 GREEN**：`REFUSED` / `PAID_WITHOUT_USD_CAP`，factory 0（价格未知这一半另由 `PRICING_UNKNOWN` 覆盖） | N3 | `[N3] maxUsdMicros=null + usdMicrosPerCall=null must be REFUSED before any provider factory call` |
| **N4a** | `settle` 不校验工具调用维度 | `toolCalls` 实际值超过**持有预约**必须被拒绝 | **resolve**，且 `charged.toolCalls = 9`（持有预约仅 1） | 抛出；账本不得吸收超支 | N4 | `[N4] settling a toolCalls actual ABOVE the held reservation must be refused` |
| **N4b** | 工具调用 cap 从未被消费 | 一次真实 `completed`（携带 2 个 tool call）必须记入 durable 账本 | **`charged.toolCalls = 0`**（维度恒为惰性） | `2` | N4 | `[N4] a completed call that CARRIES tool calls must consume the maxToolCalls dimension` |
| **N4c** | 账本可被负数污染 | `charge()` 必须拒绝负数 | **resolve**，durable 账本 `charged.inputTokens = -5`、`totalTokens = -5` | 抛出；账本不变 | N4 | `[N4] charge() must reject a NEGATIVE actual instead of writing it into the ledger` |
| **N6a** | 伪造 outcome / verifier / activation 字段仍可自洽哈希通过 | 全手工（伪造）evidence 目录即使摘要如实重算也必须 `verified = false` | **`verified = true`**（verifier 的 `status`/`violations`/`grade` 从不读取；activation 内容从不解析） | `false`（绑定可信执行 manifest / 预算账本 / 请求绑定 activation） | N6 | `[N6a] forged artifacts with honestly recomputed digests must be verified=false` |
| **N6b** | token delta 读 outcome 自报值 | durable 账本 token 为 0 时 `tokensDelta` 必须为 0 | **`tokensDelta = 15999984`**（16 × 1,000,000 − 16，全部来自 `outcome.tokensUsed`） | `0`，且 `gates.costBounded = true` | N6 | `[N6b] a zero-token durable journal must pin tokensDelta to 0 despite huge self-reports` |
| **N6c** | `error` run 被静默排除复验，制造假绿空间（计划 §N0 第 2 条末项） | 全部 arm run 均为基础设施错误时**不得**通过 `artifactIntegrity` | **`artifactIntegrity = true`**：驱动对 `error` 直接盖 `evidenceVerified: true`（从不读任何 artifact），`armEvidenceProblems(undefined,"error")` 返回 `[]`，`rate()` 又把 `error` 从分母删除（0/0 → 0） | `false` + 稳定 reason code；E2E 的 `ok` 不得用 `filter(non-error)` 静默排除 | N6 | `[N6c] a campaign whose EVERY arm run is an infrastructure error must NOT pass artifactIntegrity` |
| **N5a** | worker 环境"复制全部再删 4 个键"不是凭证边界 | arm 构建**不得**观察到任意继承的环境变量 | **泄漏**：子进程读到 `R97_ESCAPED_SENTINEL = N0-LEAKED-SENTINEL-VALUE` | 白名单；任意变量不可见 | N5 | `[N5] the arm build must NOT observe an arbitrary inherited environment variable` |
| **N5b** | 子进程隔离 ≠ 网络沙箱 | arm 构建**不得**直接发出 loopback 请求 | **命中 1 次**：arm 顶层 `fetch("http://127.0.0.1:<port>/egress")` 到达测试自建 server | 命中 0 次（出网只能经预算渠道） | N5 | `[N5] the arm build must NOT be able to make a direct LOOPBACK request` |

**对照项的意义**：N1b 与 N2 中的"把 isolation 显式传入"分支在 HEAD 上**通过**，证明
worker ABI 要求与隔离校验**本身存在且正确**；失败的是**生产接线**——即"规则写对了，但真实
路径够不到它"。这排除了"测试写错/规则不存在"的替代解释。

### 1.1 判别力（这些反例确实能发现缺陷）

- N1a/N2/N5 若把缺陷修好（导出 probe、传入 isolation、环境白名单+出网约束），断言即转 GREEN；
  它们不是在断言"实现细节"，而是在断言计划要求的**可观察契约**。
- N4a/N4b/N4c/N6a/N6b 的断言直接读取**durable 账本与决策输出**（`charged.*`、
  `verified`、`statistics.tokensDelta`），不读取任何源码文本。
- N1b 是反向对照：证明 worker **会**拒绝缺 ABI 的构建，因此 N1a 的 RED 不是"worker 不检查"。

---

## 2. readiness 层级拆分（计划 §N0 明确要求）

计划要求把 `releaseCliSubprocessForward=PASS` 细分成"合成构建 IPC 闭环 PASS"与
"真实双构建 + 真实 verifier 尚未证实"。依据：

- `scripts/e4/prereg-production-e2e.mjs` 的 `armEntrySource(marker, activate)` 在**测试脚本内**
  合成 arm 条目（`export const R97_ARM_PROBE` + `runOneCase`），其 outcome **硬编码**
  `status: 'failed'`、`events: []`、`tool_call_count: 0`、`terminationReason: 'verified_incomplete'`；
  该条目的字节**不是** `e9776ba` / `a203737` 的真实冻结源码构建。
- 同一脚本的 readiness 文本却声称 "two real isolated arm builds"。
- N1a 实测：真实出厂入口**没有** `R97_ARM_PROBE`，因此真实构建**无法**满足 worker ABI。

| 层级 | 判定 | 依据（本环境实测） |
| --- | --- | --- |
| `fixtureProtocolReady`（合成 arm 模块 + release CLI + provider 代理 + durable ledger 的 IPC 闭环） | **PASS** | **同一 SHA 干净树实跑**：`prereg-production-e2e: PASS`，in-process `arms=124 physicalCalls=124 verified=124`、release-subprocess `arms=124 physicalStubRequests=124 ledgerCommitted=124 verified=124`，9/9 负向拒绝 0 HTTP，`decision=INCONCLUSIVE`（见 §3） |
| `realBuildOfflineReady`（真实冻结源码 SHA 的双构建） | **NOT_PROVEN** | **N1a RED**：出厂构建缺 `R97_ARM_PROBE`；当前只有合成条目能过 worker ABI（E2E 的 `armEntrySource` 是脚本内合成，且 outcome 硬编码 `failed`/空事件/0 工具调用） |
| `budgetEvidenceReady`（不可核价预算 + 同源账本） | **NOT_PROVEN** | **N3 已 GREEN**（付费准入无上限/未知价格现已 fail closed）、**N4a/N4b/N4c 已 GREEN**（工具维度成为上限、`charge()` 受校验与 cap 约束、工具调用被消费），但本项整体仍不足：**N6b RED**（token 自报）、**N6c RED**（全 error 仍 `artifactIntegrity=true`）；且 N3 的"可核查费率来源/费率 digest 绑定"、N4 的"逐次物理 dispatch 前预留额度/全局 wall-clock 截止"仍 `NOT_PROVEN` |
| `paidExperimentRun` | **NOT_RUN** | 无付费授权、无 key；本环境 0 外部请求（E2E 自报 `paidExperimentRun=NOT_RUN`） |
| `championPromotion` | **NOT_RUN** | 独立后续审批，绝不从离线证据推断（E2E 自报 `championPromotion=NOT_RUN`） |

> 因此 `productionOfflineReady` **不得**继续作为单一整体 PASS 展示：其中
> `releaseCliSubprocessForward` 只支撑"合成构建 IPC 闭环"，真实双构建与真实 verifier
> 由 N1/N6 的 RED 反例直接证否。此前 124 次合成闭环的 `INCONCLUSIVE` 不得改写为模型质量
> 或推广结论。

---

## 3. 复现命令与原始退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm exec vitest run --config apps/cli/test-infra/red-next-gaps-vitest.config.ts` | **0** | 2 files / **14 passed**（旧 G1–G7 回归 pin，现 GREEN） |
| `pnpm test:n0-gaps` | **0** | 2 files / **12 passed (12)** —— **全部 N0 反例（N1a/N1b、N2、N3、N4a-c、N5a/N5b、N6a-c）均已转 GREEN**，门禁整体通过 |
| `pnpm typecheck`（`tsc -b`） | **0** | 24 包全绿，含新增测试文件 |
| `pnpm exec vitest list` → 过滤 `n0-gaps\|prereg-next-gaps` | **0** | **0 匹配**（根回归不收集两类反例） |
| `pnpm build` | **0** | `tsc -b` 通过 |
| `node scripts/e4/prereg-production-e2e.mjs --out …`（**干净树**） | **0** | `PASS`：124/124/124/124，9/9 负向拒绝 0 HTTP，`INCONCLUSIVE` |
| `node scripts/e4/prereg-production-e2e.mjs --out …`（**当前脏树**） | **1** | `BLOCKED`：`CLEAN_TREE_REQUIRED`（正式观察器拒绝脏 checkout） |

原始日志（`.ci/` 已 gitignore，可由上表命令重放）：
`.ci/n0/red-next-gaps.log`、`.ci/n0/n0-red.log`、`.ci/n0/n0-eval-red.log`、
`.ci/n0/e2e-clean.log` + `.ci/n0/e2e-clean.json`（干净树 PASS）、
`.ci/n0/e2e.log` + `.ci/n0/e2e-evidence.json`（脏树 BLOCKED）、
`.ci/n0/root-regression.log`、`.ci/n0/attribution.log`。

### 3.1 根回归 `pnpm test` 的 22 个失败：已归因，**非本轮改动引入**

`pnpm test` 在本工作树为 **5 failed / 369 passed（22 failed / 7059 passed / 3 skipped）**。
计划要求"未破坏旧代码"，因此对每个失败套件做了**纯净树对照实验**：把本轮全部改动
`git stash -u` 后再跑，失败**逐字复现**。

| 失败套件 | 纯净 HEAD（stash 掉本轮改动） | 归因 |
| --- | --- | --- |
| `e4-09-production-e2e`（4）、`e4-r55-failure-wiring`（1）、`benchmark-command`（1） | **3 files / 6 failed \| 161 passed \| 2 skipped**（与带改动时相同） | **脏树前置条件**：日志明示 `E4-R55 requires a CLEAN committed working tree`，porcelain 即用户预置的 `D HANDOVER.md`、`?? plan(20260926-175819).md`。已由 §3 干净树 E2E `PASS` 反证 |
| `r97-arm-worker-contract`（9）、`e4-r77-baseline-oracle`（7） | **2 files / 16 failed \| 58 passed (74)**（与带改动时相同） | **本机 Windows 环境**：fixture arm 条目被判为 `Cannot use import statement outside a module`（ESM/CJS 判定），以及命令 oracle 的平台差异。与 N0 无关 |

> 归因方法可复现：`git stash push -u -m attr -- <本轮文件>` → 跑目标套件 → `git stash pop`。
> 结论：本轮改动**只新增/隔离**测试与文档，未触碰任何生产源码，未改变任何既有断言的通过状态。

---

## 4. 本轮改动清单

| 文件 | 性质 |
| --- | --- |
| `packages/evaluation/src/prereg-n0-gaps.test.ts` | 新增：N3/N4/N6a/N6b/N6c 行为反例（7 例；**N3、N4a/N4b/N4c 已 GREEN**，N6 共 3 条仍 RED） |
| `apps/cli/src/prereg-n0-gaps.test.ts` | 新增：N1/N2/N5 行为反例（5 例：N1a/N1b/N2、**N5a/N5b 已 GREEN**）。N5a 现在编码 plan §N5 line 98 的**另一条允许路径**：捕获"启动前拒绝"而非任其抛出，并断言若发生拒绝则必须是精确的 `EGRESS_ISOLATION_UNAVAILABLE`；白名单的**非空洞**证明在 `prereg-egress-trust-boundary.test.ts`（那里 fixture 真实运行） |
| `packages/evaluation/src/tool-call-efficiency-pricing-admission.test.ts` | 新增（N3 轮）：付费/合成 fixture 两类准入的逐类行为验收（10 例，全 GREEN，含正向对照 N3.10） |
| `packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts` | 新增（N4 轮）：工具额度上限、全或无、`charge()` 校验、零额度、消费、两臂共享、重开持久（9 例，全 GREEN） |
| `apps/cli/src/prereg-egress-trust-boundary.test.ts` | 新增（N5 轮）：环境白名单（含 `NODE_OPTIONS`/代理/云凭证/其他 provider token）、能力声明、未标记 checkout 的**启动前**拒绝且 loopback 命中 0、带标记 fixture 真实运行且不继承任何敏感变量（4 例，全 GREEN） |
| `packages/evaluation/src/prereg-activation-binding.test.ts` | 新增（N6 轮）：activation 内容绑定（真实产物通过；未知 schema、错 run identity、无 events、改一个 byte、删产物、unactivated 携带 activation 均被拒）（6 例，全 GREEN） |
| `packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts` | 追加（N6 轮）：N6.7 journal 决定 `tokensDelta`、N6.8 无 journal 佐证则不可比、N6.9 全员 error 不得 artifact-clean、N6.10 容错必须显式声明（4 例，全 GREEN） |
| `apps/cli/src/prereg-docs-smoke.test.ts` | 新增（N7 轮）：审批模板被 loader 拒绝且非 `ADMITTED`、只读 build 输入无 inline catalog/selection 且 root 可移植、两处文档不含 `file:///` 链接（4 例，全 GREEN） |
| `scripts/e4/ci-readiness.mjs` | 新增（N7 轮）：单份 `ci-readiness.json`，含 `ciRunSha`/OS/退出码/实测计数与**五级分离就绪**（无顶层 `ok`） |
| `apps/cli/test-infra/n0-gaps-vitest.config.ts` | 新增：N0 专用配置（只收集上述两文件） |
| `vitest.config.ts` | 修改：根 `exclude` 增加两个 N0 反例文件（结构性隔离，避免弄红 `pnpm test`） |
| `package.json` | 修改：新增 `test:n0-gaps`、`test:red-next-gaps` 两个显式脚本（分离 EXPECTED_RED 与正式门禁） |
| `packages/evaluation/src/prereg-next-gaps.test.ts` | 修改：**仅**头部注释补记 HISTORICAL（断言未动） |
| `apps/cli/src/prereg-next-gaps.test.ts` | 修改：**仅**头部注释补记 HISTORICAL（断言未动） |
| `docs/evidence/prereg-N0-gap-matrix.md` | 新增：本文件 |

**未改**：任何生产源码、任何安全负例、任何超时/并发设置、任何既有断言。

---

## 5. 未执行项与残余限制

- **N3 的判定依据存在产品决策依赖 —— 已在 N3 落地时解决**：`pricingUnknownPolicy` 至今
  仍**未被门禁读取**，因此 N3 没有依赖它，而是把拒绝做成**结构性**的：`paid:true` 必须同时
  满足 `maxUsdMicros !== null`（否则 `PAID_WITHOUT_USD_CAP`）与已知价格（否则 `PRICING_UNKNOWN`），
  在任何预算/账本/provider 构造之前 fail closed。N0 反例采用的强读法即为最终实现；
  合成 fixture 走**单独标识**的类（`fixtureMode` + `paid:false`），它放宽的是"已知价格"这一条，
  但必须证明观测到的传输不可计费，且 parser 拒绝它与 `paid:true` 并存。残余：
  `pricingUnknownPolicy` 字段仍然惰性（见 [`E4-N3-report.md`](./E4-N3-report.md) §8.2）。
- **N5b 的"修复"可能超出进程内可控范围**：环境白名单是纯代码改动；阻止 arm 直接 loopback
  出网需要真实沙箱/权限边界。N0 只负责给出反例；N5 落地时必须明确其可达强度，不得把
  "白名单已加"当成"网络沙箱已建立"。
- **本环境为 Windows 单平台**：N0 反例全部离线，未在 Ubuntu 实跑；两平台 CI 结论属 N7 范围。
  跨平台相关项（worker 子进程、`fetch` loopback、路径）在 Ubuntu 上的行为**未在本环境验证**。
- **干净树 E2E 需要临时 stash**：本工作树带有用户预置改动，正式观察器因此拒绝（`CLEAN_TREE_REQUIRED`）。
  本文件 §3 的 124/124 `PASS` 是在 `git stash -u` 后的**同一 SHA** 干净树上取得，随后立即
  `git stash pop` 还原；这不改变"当前工作树脏 ⇒ E2E BLOCKED"这一事实，两者如实分列。
- **N6c 的"ACCEPT"表述**：本反例断言的是 `artifactIntegrity`（以及非 ACCEPT），因为在
  `pairComplete:false` 时决策本就落到 `INVALID`。真正的假绿空间在于 **E2E 的 `ok` 谓词**用
  `records.filter((r) => r.outcome.status !== "error")` 作分母；该谓词的收紧属 N6/N7 落地范围。
- **未下载 CI artifact 逐字节复核**：本文件不声称已重放任何 release/CI 证据内容。
- 旧 14 条反例的"RED→GREEN"结论基于**本工作树 HEAD `1299e5cb` 的本地实跑**；其历史 RED
  时点为 `3ff8946`，两者分列陈述，不互相冒充。

---

## 6. 交接

- 本矩阵编号 **N1–N6** 交由对应任务：N1←N1a；N2←N2；N3←N3；N4←N4a/N4b/N4c；N5←N5a/N5b；
  N6←N6a/N6b/N6c。
- 任一 RED 转 GREEN 后，必须在**同一新 HEAD** 重跑：`pnpm typecheck`、`pnpm test`、
  `pnpm test:red-next-gaps`、`pnpm test:n0-gaps`，以及该 HEAD 的 Windows/Ubuntu CI（N7）。
- 本文件所有"实测"值均可由 §3 命令在本工作树复现；不可观察项一律标 `NOT_OBSERVED`，
  绝不以 `0` 冒充。

---

## 7. 后续轮次的状态更新（本轮）

基线 SHA `1299e5cb` → 本轮提交 `1f3df072`（N0/N1a/N2）、`bef6e474`（N0 readiness 拆分）。
N3 提交 `42e0cb16`（付费准入 fail closed + 合成 fixture 类）与 `a2c65e44`（N3 逐类行为证据）。
N4 提交 `35eeb5f4`（工具维度上限/校验/消费）。
N5 提交 `a142f666`（环境白名单 + 未标记 checkout 的启动前出网拒绝）与 `44d3641f`（fixture writer 补齐标记 + N5 证据）。
N6 提交 `42ea342d`（activation 内容绑定 + journal 化 tokensDelta + error 记录不可自证 + E2E `ok` 收紧）、`67ce2884`（release CLI 聚合绑定 journal）、`de7a5ecf`（fixture 改为真实 activation 形态）。
N7 提交 `cad5a1c7`（两平台 CI 门禁 + `ci-readiness.mjs`）、`d1f45c0d`（文档 smoke + 审批模板 + 相对链接）。
完整证据、原始命令与退出码见 [`E4-N1-N2-report.md`](./E4-N1-N2-report.md)、[`E4-N3-report.md`](./E4-N3-report.md)、[`E4-N4-report.md`](./E4-N4-report.md)、[`E4-N5-report.md`](./E4-N5-report.md)、[`E4-N6-report.md`](./E4-N6-report.md)、[`E4-N7-report.md`](./E4-N7-report.md)。

| 反例 | 本轮前 | 本轮后 | 依据 |
| --- | --- | --- | --- |
| N1a（出厂构建缺版本化探针） | RED | **GREEN** | 出厂 `benchmark-command` 入口现导出非空 `R97_ARM_PROBE`；同文件 CONTROL 仍证明无探针的 checkout 被 `PREREG_WORKER_PROBE_MISSING` 拒绝。 |
| N1b（CONTROL） | GREEN | GREEN | 不变。 |
| N2（预注册隔离未到达 executor） | RED | **GREEN** | 隔离契约随 run context 传递；出厂 adapter 对 `vm/strong` 在任一 arm 工作前返回 `ARM_ISOLATION_UNSUPPORTED`。该字段为**必填**，编译期即强制 driver 传递。 |
| N3（付费准入可绕过金额上限/未知价格） | RED | **GREEN** | 准入拆成两类且各自 fail closed：PAID 要求 `maxUsdMicros` 非空（`PAID_WITHOUT_USD_CAP`）且价格已知（`PRICING_UNKNOWN`）；合成 fixture 类（`fixtureMode` + `paid:false`，parser 拒绝与 `paid:true` 并存）必须证明**观测到的**传输不可计费。新增 10 条逐类行为用例，每条断言拒绝码 + provider factory=0 + 物理传输=0，并含正向对照（N3.10）。 |
| N4a / N4b / N4c（工具调用维度惰性、`settle` 不校验 tool 上限、`charge()` 零校验） | RED | **GREEN** | `settle` 的"已持有上限"校验纳入 `toolCalls`（超限即冻结，且在任何写入前，全部维度要么全写要么不写）；`charge()` 逐维度校验非负安全整数并在同一锁内执行全部 cap 校验，超限抛 `BUDGET_EXHAUSTED` 且不写入；`createFormalBudgetedProvider` 消费 `completed` 响应携带的工具调用数。新增 9 条行为用例（N4.1–N4.9：上限、全或无、零额度、消费、超限冻结、两臂共享、重开后仍持久）。 |
| N5a / N5b | RED | **GREEN** | worker 环境改为**显式白名单**（`buildWorkerEnv`，不再"复制全部再删 4 个键"）：代理、云凭证、其他 provider token、`NODE_OPTIONS` 全部不可见，而 worker 自己的声明输入仍到达。出网侧：本构建无法证明单一出网边界（`egressIsolationCapability().available === false`），因此**未带合成 fixture 标记的 checkout 在启动前**即以 `EGRESS_ISOLATION_UNAVAILABLE` 拒绝——loopback 计数为 0，且子进程的 import 期副作用从未发生；带标记的 fixture 仍真实运行（拒绝非"一刀切"）。此标记由 harness 自己的 fixture writer 写出，随产物传递，不依赖可遗忘的环境开关；**它不等于网络沙箱**。新增 4 条行为用例（N5.1–N5.4）。 |
| N6a / N6b / N6c | RED | **GREEN** | **N6a**：activation 产物此前**只校验 digest、从不解析内容**，因此 `{schemaVersion:"never-checked-by-the-validator"}` 只要 digest 自洽就能通过；现在解析并绑定 schema、arm/run identity 与真实 events（digest 只证明字节未变，不证明事件发生）。**N6b**：`tokensDelta` 由各 arm 自报 `tokensUsed` 求和（可自报 +15,999,984 而账本为 0），现取 durability journal（新增 `journalChargedTokens`），无 journal 佐证的自报使两臂**不可比**。**N6c**：`error` 记录因 `armEvidenceProblems(undefined,"error")===[]` 被当作"已核对"，使全员 `error` 的战役看起来 artifact-clean；现在 error 记录按定义不可自证，容错比例只能由 `evaluation.maxInfraErrorRatio` **显式声明**且默认 0。E2E `ok` 谓词不再静默排除 error 记录。 |
| N7 门禁入 CI | 未接线 | **接线并本地实测（Ubuntu NOT_PROVEN）** | `verify`（ubuntu+windows）新增三步：`pnpm test:n0-gaps`、`pnpm test:red-next-gaps`、文档 smoke；`r97-r98-closed-loop`（两平台）新增 `ci-readiness.json` 产出与 artifact 上传。历史"故意 RED"说明已按当前实际状态改写为 **12/12 GREEN**。本地（Windows）执行同三条命令：`12 passed` / `14 passed` / `4 passed`。**Ubuntu 无 runner 执行 → NOT_PROVEN**。 |
| N7 五级就绪 | 无 | **分层产出，禁止合并** | `scripts/e4/ci-readiness.mjs` 输出**没有**顶层 `ok`：`fixtureProtocolReady=PASS`、`realBuildOfflineReady=BLOCKED`（E2E 自述 forward basis 为 `SYNTHETIC_FIXTURE_BUILD`）、`budgetEvidenceReady=NOT_PROVEN`、`paidExperimentRun=NOT_RUN`、`championPromotion=NOT_RUN`。 |
| N7 只读 build 配置 | 报告引用了**不存在**的模板 | **部分 PASS / BLOCKED** | 报告引用的 `prereg-paid-approval.template.json` 实际缺失，本轮补齐（`paid:false`、无签名、placeholder，loader 实测拒绝）。只读 build 的**合法静态配置不可能存在**：实测 `INVALID_FIELD: subject.candidateSourceSha must be a 40-hex git SHA`（arm digests 只能由真实双 checkout 生成，属 N1）→ **BLOCKED**；只读性质（无 key、0 factory call）由 E2E certification 阶段证明 = **FIXTURE_PASS**。18 处 `file:///workspace/...` 链接已改为仓内相对链接，现为 0。 |
| N1 真实双构建可执行真实 harness | NOT_PROVEN | **PASS（Windows 本地实测）/ 默认冻结对仍 BLOCKED** | 用 `r97-observe-arms.mjs` 的双 worktree/install/build 机制真实构建两臂：baseline `1f3df072f6b03b9beb1e695662ba7b563dc4ff0b`、candidate `a89f5a8183eb4bfc6ed554a065a9821c51a5a135`（HEAD），各自独立 worktree、dirty=0。**实测**：默认冻结对 `e9776ba`/`a203737` 的 `benchmark-command.ts` 中 `runOneCase` 导出=**0**、probe 引用=**0**（缺 ABI，实测事实）；`1f3df072` 与实际构建产物的 `benchmark-command.js` 中 `runOneCase` 引用=**7**、`R97_ARM_PROBE` 引用=**3**（两侧同）。两臂**构建闭包 digest 不同**（`998cfba2…` vs `6bdb2ce0…`），但 5 个声明 entry 逐字节**相同**（入口 166182B 同一 sha256）。真实验收：`status=OFFLINE_ACCEPTED`、`ok=true`、16 单元、`executionMode=arm-worker`、`workerUnits=16`、`providerRequests=0`、`externalProviderCalls=0`、`paidStatus=PAID_NOT_RUN`、`promotable=false`；但 `strongPasses=0 / weakPasses=6` —— 链路真实跑通，**强验证通过数为 0**。**默认冻结 SHAs 未重钉**，故按 plan 原样配置的路径仍 `BLOCKED: NO_REAL_ARM_PAIR`。 |
| N8 条件性付费实验 | BLOCKED（默认） | **BLOCKED: PAID_NOT_AUTHORIZED（用户已点名模型/端点/密钥，但金额与时间窗缺失，且端点不可定价）** | 用户给出 `http://127.0.0.1:8317/v1` + 密钥 + `workbuddy-deepseek-v4.1-flash` +「很高并发」。仍停在 `PAID_NOT_AUTHORIZED`，三条各自充分：(1) plan 第 134 行要求**本次**明确模型/端点/**金额**/**时间窗**/SHA，而金额与时间窗**未给出**、未绑定 SHA；(2) plan 第 134/138 行规定 N8 **只准备审批前材料、不执行付费请求、不创建 `paid:true` 授权**，获授权后须**另开独立任务**且**手工启动**，禁止本计划自动启动；(3) **实测**该端点为 loopback（`endpointIsLoopbackAddress=true`）、每调用价格解析为 **`null`** → 资金门禁在任何 provider 创建前以 `PRICING_UNKNOWN` 拒绝（已由 `tool-call-efficiency-formal-gaps.test.ts` 15 passed 佐证）。本轮**付费请求数 0**、`paid:false` 模板保留、未写入任何可意外生效的审批文件；密钥已按要求掩码，未落盘于任何仓库文件。 |
| N1 验收摘要身份绑定 | RED（实测） | **GREEN** | `acceptance-summary.json` 的 `baselineSha`/`candidateSha` 原先读 `opts.baseline/--candidate`（缺省即 `DEFAULT_*_SHA` 常量）。以目录形式提供两臂时该选项缺失，于是本次真实跑的是 `1f3df072`/`a89f5a81`，摘要却打印 `e9776ba`/`a203737` —— **声称了从未测量的修订**，与本次自己的 `observation-summary.json` 直接矛盾。现改为**从本 run 的观测产物读取**，并另存 `declaredBaselineSha`/`declaredCandidateSha` 使「声明 vs 实测」不一致保持可见。修复后实测：摘要 = 观测 = `1f3df072`/`a89f5a81`。 |
| N0 readiness 过度声称 | 已记录 | **已修正** | E2E readiness 现显式标注 `forward basis: SYNTHETIC_FIXTURE_BUILD`，并把真实双构建 + 真实 verifier 标为 `NOT_PROVEN`。 |

本轮同时修复了被 N2 改写打断的 r97 mutation 锚点（`a5-real-cli-adapter-never-wired`），
变异行为不变；`r97-mutation-check.test.ts` 恢复 32/32 GREEN。

**N2 仍未完成的部分**：两臂的 git HEAD / clean-tree 身份仍由可遗忘的 `R97_ARM_REQUIRE_GIT`
环境开关控制，故 N2 的"真实执行模式强制身份"一项仍为 **NOT_PROVEN**。