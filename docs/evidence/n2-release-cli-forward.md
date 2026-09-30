# N2 — 发布入口 CLI 正向证据（统一 selection / 脚本游标作用域 / 价格守卫接线）

## CURRENT — 2026-10-01，N2 (a)(b)(c)(d) DONE（本地 Linux）

`N2_RUN_RELEASE_E2E=1 pnpm exec vitest run apps/cli/src/n2-release-cli-forward.test.ts`
已真实运行通过（约 17 s）：release CLI subprocess 的 build → validate → run，原始 evidence
中 reg-22-api-stub 在 **baseline/candidate × 两次 repetition 共四次** verifiedCompletion=true，
真实 write_file settlement > 0；身份保持 offline-scripted，价格 NOT_BOUND，零付费请求。

旧测试把证据目录写成 arm-runs；实际是 out/runs/evidence。修复使用
PREREG_RUN_EVIDENCE_DIRNAME，并要求四次成功，未减少排期或放宽 verifier。
测试继续 opt-in；N6 producer 显式启用该测试，两个 CI 平台都必须运行。

Phase E 的 runId/attempt/platform/dualBuild/evidenceRoot 已在 prereg-production-e2e.mjs 存在，
本轮 fixture producer 用真实 local run 身份输出后也完整成功；不存在交接所述缺字段待实现项。

## Historical / superseded — 以下是上一轮记录


> 状态：**(a) DONE / (b) DONE / (c) DONE / (d) PARTIAL**
> 本文件是 `plan(20260930-061557).md` §5 N2 的交付证据，按 §10 汇报格式书写。
> 所有数字都是本机实测；**未知数值一律写 `null`，绝不写 0**。

---

## 1. 任务与状态

| 项 | 内容 |
| --- | --- |
| 任务 | N2（F30-2 身份不同源 / F30-3 脚本游标作用域 / N4 遗留 `PricingExecutionGuard` 接线） |
| 状态 | (a)(b)(c) **DONE**；(d) **PARTIAL**（跑到真实 arm executor + 真实隔离 worker，被驱动侧的并发守卫拒绝，见 §7） |
| 基线 HEAD | `00c8660a542dc0b514dc4ecd6f4375fd2e158b1c` |
| 实现提交 | 见 §11（提交后回填 SHA） |
| 平台 | Windows（`pwsh` 7.6.5）；Ubuntu **NOT_RUN**（本机无 Linux 环境，未伪造） |
| 付费模型请求 | **0**（无 key、无真实 endpoint、无真实网络调用） |
| 外部 HTTP 请求 | **0** |

## 2. 修复的三个缺陷

### 2.1 F30-2 身份不同源（`apps/cli/src/main.ts` 等）

**旧行为**：`preregCommandDeps(env)` 用**注入 env** 造 `offlineTransportForPrereg(env)`，却调用**不带 env** 的 `createProductionPreregRunner()`（回落 `process.env`）；`prereg-command.ts` 的 build/run 路径与 `prereg-production-runner.ts` 的 `makeProvider` 也各自读 `process.env`。同一次运行里，"能力、被观察的身份、绑定的价格、将要构造的 provider" 可以描述四种不同的执行。

**新行为**：**一份** `resolvePreregSelection(env)` 是唯一来源：

- `PreregResolvedSelection { env, profile, pricing, offlineProfileSelected, pricingGuard? }`；
- `preregCommandDeps(env)` 把这份 selection 交给 `createProductionPreregRunner({ selection })`，runner 的 `observe` / `makeProvider` 与 `prereg build/run` 全部从它派生；
- `makeProvider` 显式传 `apiKey: env["OPENAI_API_KEY"] ?? ""`（显式空串，避免 resolver 回落 `process.env`）；
- 观察者（`observeExecutionIdentity`）新增可选 `selected: { profile, pricing }`：**没有它时 keyless 进程会把 identity 报成 `stub`，而 build 绑的是 `offline-scripted`** —— 两者不一致会让发布 CLI 无法运行自己刚 build 出来的合法离线 profile（假的身份漂移）。这是本次实测发现的第二个同源缺口（见 §8 剩余问题）。

### 2.2 F30-3 脚本游标作用域（`apps/cli/src/provider.ts`）

**旧行为**：`createOfflineScriptedProvider` 内 `let turn = 0` 位于 **provider 实例**作用域。driver 每个 armRun 复用同一个 budget 包装 provider，于是 baseline 吃掉 turn 0/1、candidate 从 turn 2 开始 → 第二个 arm 直接越过"写文件"步骤（跨 arm 耗尽）。

**新行为**：游标改为**会话级**——`step = 请求 transcript 中已有 assistant 消息数`，按 `sessionId` 维护 high-water 上界（防止 context 裁剪把脚本倒回去重写文件）；**无会话身份的请求保留旧的顺序语义**（`ANONYMOUS_CONVERSATION`），因此既有 pinned 测试不变。

**为什么不是把游标塞进 `createClient`**：`prereg-arm-executor.ts::serviceModelRequest` 对**每一个模型请求**都调用 `provider.createClient(...)`。把游标放进 client 会让它每个请求都重置到第 1 步，"两条 arm 各自从初态开始"会退化成"每条 arm 永远停在第一步"——这是另一个方向的错误。

### 2.3 N4 遗留：`PricingExecutionGuard` 真的 armed

`PricingExecutionGuard` / `checkPricingExecutionGuard` 此前在 `apps/cli/src` 中**零引用**（proven but NOT ARMED）。现在：`pricingExecutionGuardFor(pricing)` 在 **CLI 组合根**里用**同一份** selection 构造 guard，`preregCommandDeps()` 把它放进 `selection.pricingGuard`，`runCmd` 原样传给 `openPreregisteredCampaignGate({ pricingGuard })` → gate 交给 `createFormalBudgetedProvider`，在**每一次物理发送前**（且在任何 reservation 之前）用当前时钟复核。

## 3. 反例：旧行为 vs 新行为（实测）

### 3.1 实例级游标 RED（b）

把游标临时还原成旧的实例级实现（`provider.ts` 备份于 `%TEMP%`，改回后 sha256 校验一致），跑同一个测试文件：

```
apps/cli/src/n2-script-scope.test.ts (10 tests | 6 failed)
× baseline and candidate EACH start at the script's first step and both complete
    AssertionError: expected +0 to be 1     ← candidate.writes 期望 1 实得 0
× the candidate is independent of the ARM ORDER (candidate first, then baseline)
× INTERLEAVED requests from two conversations keep their own positions
× several repetitions of the same case are independent
× replaying the IDENTICAL request does not advance the script
× a conversation past the table reports OFFLINE_SCRIPT_EXHAUSTED
✓ identity-less requests keep the historical sequential table order   ← 对照组，证明旧语义未被破坏
Tests  6 failed | 4 passed (10)
```

即：第二 arm 从 turn 2 开始、**一次都没写文件**（0），正是 F30-3 的跨 arm 耗尽。恢复实现后 **10 passed**。

### 3.2 注入 env 与 process.env 混读的反例（a）

`n2-unified-selection.test.ts` 里保留了一条**活的旧行为反例**：裸调用 `preregCmd([...])`（不带 deps）时，`prereg build` 仍然从 `process.env` 取身份 → `providerId = "openai"`；同一份 process env 下、只把 selection 交给它，则绑 `offline-scripted`。**唯一变量是 deps**，两种行为都被钉住，防止将来回退。

### 3.3 价格守卫的反例（c）

同一套夹具，**唯一语义变量是发送时的时钟**：

| 场景 | 结果（实测） |
| --- | --- |
| ADMITTED 时窗口有效，发送时窗口已过期 | 拒绝发送：`E4-N4: PRICING_WINDOW_EXPIRED (initial send)`；**计数 transport = 0**；arm driver 确实尝试过一次发送（所以 0 是"被拒"而非"没发"）；无 `BUDGET_EXHAUSTED`、无 `DEADLINE` |
| 控制组：窗口仍有效 | **真的发送**，`transport.sends >= 1`，无任何 `PRICING_` 拒绝 |

## 4. 变更文件

| 文件 | 说明 |
| --- | --- |
| `apps/cli/src/main.ts` | `resolvePreregSelection` / `pricingExecutionGuardFor` / `offlineTransportForSelection`；`preregCommandDeps` 只构造一份 selection 并交给 runner |
| `apps/cli/src/prereg-command.ts` | `PreregResolvedSelection` 类型 + `deps.selection`；build/run 从 selection 取 env/profile/pricing；`runCmd` 把 `pricingGuard` 传给 gate |
| `apps/cli/src/prereg-production-runner.ts` | `makeProvider` 显式使用注入 env；观察者可接收 selection 的 profile/pricing（同一身份，不再二次推导） |
| `apps/cli/src/provider.ts` | 会话级游标 + high-water；`OFFLINE_CONTENT_TASK` 指向真实冻结非 holdout 用例 `regression/reg-22-api-stub`；`OFFLINE_CONTENT_SCRIPT_VERSION` |
| `apps/cli/src/n2-script-scope.test.ts` | (b) 10 个用例（含用例自带 verifier 的正/负例） |
| `apps/cli/src/n2-unified-selection.test.ts` | (a) 9 个用例（含 §3.2 旧行为反例） |
| `apps/cli/src/n2-pricing-guard-armed.test.ts` | (c) 2 个用例（组合验收 + 控制组） |
| `apps/cli/src/n2-forward-fixture.ts` | E2E 夹具：临时身份根（自己的 git 仓库）+ 两个字节不同的真实 arm checkout（stub/real 两种模式） |
| `apps/cli/src/n2-release-cli-forward.test.ts` | (d) 发布入口 E2E（**默认 opt-in 跳过**，见 §7；`N2_RUN_RELEASE_E2E=1` 才跑） |
| `docs/evidence/n2-release-cli-forward.md` | 本文件 |

**未修改**（严守 scope）：`apps/cli/src/prereg-arm-executor.ts`、`packages/evaluation/**`（含 `tool-call-efficiency-formal-run.ts`）、`scripts/e4/**`、任何 frozen verifier / frozen task / `benchmarks/**`。

## 5. 实际命令与通过数

| 命令 | 结果 |
| --- | --- |
| `npx tsc -b` | **exit 0** |
| `npx vitest run apps/cli/src/n2-script-scope.test.ts` | **10 passed** |
| `npx vitest run apps/cli/src/n2-unified-selection.test.ts` | **9 passed** |
| `npx vitest run apps/cli/src/n2-pricing-guard-armed.test.ts` | **2 passed** |
| `npx vitest run apps/cli/src/provider-offline-profile.test.ts apps/cli/src/n2-unified-selection.test.ts apps/cli/src/n2-pricing-guard-armed.test.ts apps/cli/src/prereg-production-wiring.test.ts` | **46 passed**（回归：(a) 的同源改动没有破坏既有离线 profile 与生产接线套件） |
| `N2_RUN_RELEASE_E2E=1 npx vitest run apps/cli/src/n2-release-cli-forward.test.ts` | **(d) PARTIAL** — 见 §7 |
| 全量 `pnpm test` | **NOT_RUN**（按 Lead 指令：本机 Node v24 与 CI Node v22 有已确认行为差异，且本机不跑全量） |

未跑：Ubuntu / CI（**NOT_RUN**）。本地 `pnpm test` 的既有红点是环境差异，不属于本切片。

## 6. 离线正向：物理生成数与真实工具派发数

**(c) 组合验收（在进程内、paid 形状 selection）**：

| 指标 | 值 |
| --- | --- |
| 付费模型请求数 | **0**（计数 transport 是纯本地计数器；endpoint 是 `.invalid`，无法解析） |
| 外部 HTTP | **0** |
| 真实凭据读取 | **0** |
| 计数 transport：过期窗口场景 | **0** 次发送 |
| 计数 transport：控制组 | **≥1** 次发送 |

**(d) 发布入口 E2E（离线 profile）**：

| 指标 | 值 |
| --- | --- |
| 离线 physical generate 数 | **null（未知）** — 见 §7：run 在 arm→driver 的模型请求边界被协议守卫中止，未能完成一个用例，因此无法给出完整计数 |
| 实际 tool dispatch 数 | **null（未知）** — 用例未跑完，`dispatch-journal.json` 没有 `settled/dispatched` 事件可计 |
| frozen verifier raw success | **NOT_RUN** — `verifier.json` 未产生（该 armRun 未结束） |
| arm worker 侧已到达的模型请求 | 驱动侧记录 `refusals=1`，即**: 1 个在飞请求 + 1 个被拒的第二请求**（这是驱动自己的计数，不是我推断的） |

**绝不把 `null` 写成 0**：这里不是"测得 0 次生成"，而是"没测到"。二者含义完全不同。

## 7. (d) 为什么是 PARTIAL —— 原样贴出捕获的输出

`N2_RUN_RELEASE_E2E=1 npx vitest run apps/cli/src/n2-release-cli-forward.test.ts`（3 次运行，均在 230s 左右）：

**已完成的部分（真实、可复核）**：

```
[n2-e2e] identity root prepared: 1197 ms
[n2-arm:baseline] build copied + links created: ~4 s
[n2-arm:baseline] closure digest computed: ~11 s
[n2-arm:baseline] git tree committed: 105976 ms
[n2-arm:candidate] build copied + links created: 4044 ms
[n2-arm:candidate] closure digest computed: 15046 ms
[n2-arm:candidate] git tree committed: 103166 ms
[n2-e2e] two real arm checkouts prepared: 210160 ms
[n2-e2e] prereg build finished: 211114 ms      ← exit 0，绑定 offline-scripted、无价格 basis
[n2-e2e] prereg run finished: 228748 ms
```

`prereg build` / `prereg validate` 均 **exit 0**（`provider calls: 0`），身份是 `offline-scripted`、`pricing basis: NOT_BOUND`，dataset 含 `reg-22-api-stub`。`prereg run` 进入了完整的正式链路：

```
[prereg] trusted-build mode: baseline @ d436d77585c7 closure 46054f42bf24… network sandbox=none
[prereg] trusted-build mode: candidate @ a4e2bf6c3905 closure 26ef6845a72b… network sandbox=none
```

即：`trusted-build` / `no-os-network-sandbox` 姿态**自证通过**（两个真实 checkout、clean git、40-hex HEAD、**互不相同**的 execution closure），真实隔离 worker **已启动**并运行了用例。

**中止点（未完成的部分）**：

```
prereg run: REFUSED (ARM_WORKER_PROTOCOL_VIOLATION)
  ARM_WORKER_PROTOCOL_VIOLATION: the arm worker opened a SECOND concurrent model request while one was
  already in flight (refusals=1); this driver services ONE active request per worker, so the arm was
  stopped rather than let the first controller be lost (termination=protocol_violation,
  signalAborted=true, providerReturnedWithinGrace=true)
  providerFactoryCalls: 1
```

**诚实结论**：发布入口确实走完了 `build → validate → run → 正式 gate 准入 → provider 工厂（1 次）→ 真实 arm executor → 真实隔离 worker → 模型请求边界`，但**在 worker→driver 的并发模型请求守卫处被中止**，因此"runtime→tool dispatch→verifier 成功"这最后一段**没有跑通**，标 **PARTIAL**。

**已排除的替代解释**（都实测过，不是猜测）：

1. `ARM_WORKER_ENTRY_MISSING` —— 首次运行的真实拒绝：executor 以**运行中的 checkout**（发布 CLI 的 cwd = 身份根）为基准解析 `scripts/e4/prereg-arm-isolated-worker.mjs`。夹具已补齐该文件（自包含、仅 `node:` 内置依赖）后此拒绝消失。
2. `E4-R97-IDENTITY: packages/evaluation/dist/baseline.js imports "@ar/contracts", which resolves outside <arm>` —— 夹具最初只复制 5 个 declared entry，闭包走查要求**所有** `@ar/*` 都解析到 arm 内部。改为复制全部包的 `dist` 并把 `node_modules/@ar/*` 全部指向 arm 自己的副本后消失。
3. 身份/价格/能力链本身：`providerFactoryCalls: 1` 说明 gate **已准入**（身份、定价、fixture 能力三项都通过），所以中止点不是准入，而是准入之后的 arm worker 协议边界。

**未做**：没有为了让它变绿而放宽任何断言、伪造 verifier success、或把失败写成通过。该测试因此**默认跳过**（`describe.skipIf`），并在文件头写明原因与运行方式 —— 一个已知不通过的测试必须"带原因跳过并被报告"，不能静默变成绿灯。

**剩余问题（交回 Lead / 后续切片）**：

- **并发模型请求**：需要确认这是 N2 提供的 offline 脚本 provider 被 runtime 以并发方式调用（例如同 turn 内的并行子请求），还是 arm 侧 runtime 的既有行为；若是后者，属于 `prereg-arm-executor.ts`（**N3 scope**）的协议边界，需由对应 owner 决定修法。**N2 未修改该文件**。
- **夹具性能**：单次 arm 准备约 105s，其中 `git` 提交各约 100s（两个 arm）、闭包摘要各 11–15s。若后续要把该 E2E 纳入常规门禁，需先解决 arm 夹具的 git 成本（例如只提交被闭包覆盖的文件集）。

## 8. 未知/未消费项

| 项 | 值 |
| --- | --- |
| 实际 USD 消耗 | `null`（离线/unbilled；未消费分文，但**未观测到**用量，故不写 0） |
| 实际 token 消耗 | `null`（同上） |
| Ubuntu 平台结果 | **NOT_RUN** |
| 全量 `pnpm test` | **NOT_RUN**（按指令） |
| (d) 的 physical generate / tool dispatch / verifier success | `null` / `null` / **NOT_RUN**（见 §6、§7） |

## 9. 诚实口径（两条必须写清的边界）

1. **`reg-22-api-stub` 改的是仓库内建的零网络脚本 provider，不是 frozen verifier、也不是冻结任务。**
   `apps/cli/src/provider.ts` 里的离线脚本 provider 是**仓库内建**的测试夹具（它此前只写一个自造的 demo 文件，任何 frozen verifier 都不读它，"正向内容任务"因此无法被测量）。现在它写的是**冻结用例 `regression/reg-22-api-stub` 要求的那个文件**，由该用例**自带的** verifier 判定，因此跑的是真实判定而不是自造标记。
   - **`benchmarks/**`、frozen verifier、frozen 任务一个字都没改**；
   - 用例的内容要求**没有被放宽**：该用例的 verifier 会真的 `require('./server.js')`、绑定 loopback 端口、请求 `GET /health` 并要求 200 + `{"ok":true}`（脚本写入的是唯一能通过它的字节；单维度错的对照实测失败）；
   - 该用例在**已提交的 frozen selection 中且不在 holdout**，测试对此有断言。
2. **离线正向路径上没有可 armed 的价格窗口。**
   内建 offline profile 的身份是 `offline-scripted`，`resolvePricingBasis` 对它返回 `provider_unknown`（无价格 basis）；而"真实 provider 配置 + offline 选择"是**必须拒绝**的冲突（`ProviderIdentityConflictError`）。因此离线正向路径**本来就不计费、也没有价格窗口可以过期**，`pricingExecutionGuardFor` 对它返回 `undefined` 是**正确行为**（硬塞一个零金额/无窗口的 guard 会把每一次离线发送都拒成 "no windowed validity"，那是凭空的行为变更）。
   **本切片从未声称 "offline 也 armed"**：(c) 的 armed 证明用的是 **paid 形状的 selection**（声明式 `prereg-pricing-v2` 窗口 + 计数 transport），且**付费模型请求数 = 0**。

## 10. 原始证据位置

| 证据 | 位置 |
| --- | --- |
| (b) RED/GREEN 与 reg-22 verifier 正负例 | `apps/cli/src/n2-script-scope.test.ts`（自带断言与失败信息） |
| (a) 双向 env 同源 + 旧行为反例 | `apps/cli/src/n2-unified-selection.test.ts` |
| (c) 组合验收（拒绝 + 控制组） | `apps/cli/src/n2-pricing-guard-armed.test.ts` |
| (d) 捕获的 CLI 输出与阶段计时 | §7（原样引用）；DONE/PARTIAL 见文首状态行 |
| 类型门禁 | `npx tsc -b` → exit 0（§5） |

## 11. 剩余问题汇总

1. (d) 未跑通：arm worker 的并发模型请求被驱动侧守卫中止（§7）。需要确定归属（N2 的脚本 provider 调用形态 vs `prereg-arm-executor.ts` 的协议边界，后者是 N3 scope）。
2. arm 夹具的 git 成本（~100s/arm）使该 E2E 不适合放进默认套件；当前为显式 opt-in。
3. 观察者的同源缺口已在本次修复（`observeExecutionIdentity` 接收 selection 的 profile/pricing）；这是 (a) 的第二个实例，证据见 §2.1。
