# HANDOVER.md — 未完成任务交接（Unfinished Work）

> 本文是**未完成任务**的交接清单，由执行 Agent 维护。
> 机器可推导的事实由 `pnpm docs:verify` 校验（例如 `packages/（24 个包）` 是机器校验项，
> 不得删除或改错数字）；已完成的发布真值以各轮 exact-SHA CI attestation 与
> `docs/evidence/*.md` 为准，不在本文重复记录。
> **本文只写"还没做完什么、下一步做什么、证据在哪"。**

**本轮交接快照**：起始基线 `00c8660a`，当前 HEAD **`245e3957`**（工作树干净）。
本轮 10 个提交全部**只在本地 `main`**，**未 push**（原因见 §8）。

## 0. 本文件的历史（为什么它是重写的）

- 旧 `HANDOVER.md` 描述的是 **E4-R36…R39 批次**（2026-09-12 前后），其引用的 `plan.md`
  早已从工作树移除，内容整体过期。
- `HANDOVER-20260928-E4-R0-R7.md`（E4-R0/R7 批次）已**删除**：它的结论已全部并入
  `docs/evidence/current-prereg-status.md` 的 CURRENT 段与 `docs/evidence/*.md`。
  删除该文件后，仓库内仅剩本文件作为**未完成任务**的唯一交接入口。

## 1. 当前状态速览

- 仓库规模：`packages/（24 个包）`（工作区包，均自带 package.json；docs:verify 机器校验项）。
- 当前执行计划：`plan(20260930-061557).md`（已提交，N1–N6）。
- `plan.md` **不存在**（无进行中的旧式计划入口）。docs:verify 的 E4-00 在"确实不存在"时诚实
  判 PASS；**不要**留下引用缺失 spec 的悬空 `plan.md`。
- 用户本地只有 **Windows**。Linux 冷启动与正式 Ubuntu 验收**只能由 GitHub Actions 完成**；
  不得要求用户安装 Linux/WSL/Docker。

### 1.1 五级 readiness（当前实测，绝不合并成一个 PASS）

```text
fixtureProtocolReady:   PASS
realBuildOfflineReady:  PARTIAL   (pair 已在本地可派生；正式排期仍 0 次 verifier success)
budgetEvidenceReady:    PARTIAL   (producer 已存在；bundle 已收拢，--verify 已 0 失败)
paidExperimentRun:      NOT_RUN
championPromotion:      NOT_RUN
```

| 等级 | 状态 | 依据 / 边界 |
| --- | --- | --- |
| `fixtureProtocolReady` | PASS | 合成 fixture arm 构建上的离线闭环（124/124 armRun，`journalBinding: MEASURED`，预算 1240 = 620 + 620，delta 0）。**这不蕴含任何真实双构建结论。** |
| `realBuildOfflineReady` | **PARTIAL** | 已不再是 `NO_REAL_ARM_PAIR`：pair 改为**两个本地可确定性派生的真实提交**（candidate `b6e6d942` / baseline `298bb923`，B 的父就是 A，`git diff` 恰好 1 文件 `1 20`），两臂均真实 `pnpm install` + `pnpm build`、干净、closure 与 probe 不同、`loadedEntryAgrees=yes`。**但正式排期仍未取得任何一次 verifier success**（见 §6）。 |
| `budgetEvidenceReady` | **PARTIAL** | 工具 dispatch journal 的 **producer 已存在**（N3），bundle 现在真的收拢 `cost-journal.json`（43102 B）+ `dispatch-journal.json`（5397 B）+ 24 个 per-armRun evidence 目录；最新一次完整运行的 gate 仍有具名失败（见 §6）。**不得** flatten 成 PASS。 |
| `paidExperimentRun` | NOT_RUN | 无付费授权，脚本从不自行创建。 |
| `championPromotion` | NOT_RUN | 独立的后续审批阶段。 |

## 2. 本轮（N1–N6）任务状态

| 任务 | 计划章节 | 状态 | 实现 commit |
| --- | --- | --- | --- |
| **N1** worker 终止与请求生命周期（F30-1） | §4 | ✅ **DONE** | `2e818af`（上一轮） |
| **N4** pricing expiry 接入每次物理发送（F30-5） | §7 | ✅ **DONE** | `e243a40`（上一轮） |
| **N2** release CLI 统一离线身份、脚本作用域、接入 pricing guard（F30-2, F30-3） | §5 | ✅ **DONE（子项 (d) PARTIAL）** | `04dbd711` |
| **N3** 生产 dispatch journal 与严格 request/tool 关联（F30-4） | §6 | ✅ **DONE** | `8e48de50` |
| **N5** 真实构建 pair + formal 内容矩阵 + build 绑定（F30-6） | §8 | 🟡 **PARTIAL（未完成）** | `b6e6d942` `f2dda8b2` `5cd70acf` `245e3957` |
| **N6** 同 SHA 双平台终验 + 状态收尾（F30-7） | §9 | 🟡 **PARTIAL**：F30-7 已修；双平台同 SHA 终验 **BLOCKED** | `213a63e9` |
| **（新增）task-6 / N5-BLOCKER** —— 不在 F30-1…F30-7 内 | — | ✅ **DONE** | `8ee372a1` |

本轮完整提交链（`00c8660a` → HEAD）：

```text
213a63e9  fix(e4): N6/F30-7 — the join resolves its evidence root artifact-relative, never from an unrelated cwd
8e48de50  fix(e4): N3/F30-4 — a durable tool-dispatch journal and a strict request/tool binding
04dbd711  fix(n2): one resolved selection, conversation-scoped offline script cursor, armed pricing guard
8ee372a1  fix(cli,e4): task-6/N5-BLOCKER — the arm proxy must outlive the driver's post-terminal cleanup
b6e6d942  feat(e4): N5 — a re-pinnable formal pair, a real build/evidence binding, and two blockers the gate could not survive
f2dda8b2  fix(e4): N5 — re-pin the formal pair to two locally derivable commits, and report each arm's LOADED build identity
eeea7859  docs(e4): task-6 — evidence for the arm request lifecycle defect
0a66b4ad  docs(e4): N5 — record the real campaign result as PARTIAL
5cd70acf  fix(e4): N5 — schedule a case the offline provider can actually finish, gather raw evidence BEFORE the scratch root dies, make the ABI-less fixture resolvable
245e3957  fix(e4): N5 — inject the CONTENT_FIXES bodies in the module form the case workspace can actually load (CJS), fix the aggregate gathering path, stop the negative phase dying on git ENOBUFS
```

### 2.1 上一轮遗留、本轮已闭环

- **N4 的 "proven but NOT ARMED"**：已由 N2 关闭。`resolvePreregSelection(env)` +
  `pricingExecutionGuardFor(pricing)` 在 **CLI 组合根**用**同一份** selection 构造 guard，经
  `selection.pricingGuard` 传到 `openPreregisteredCampaignGate`。组合验收由
  `apps/cli/src/n2-pricing-guard-armed.test.ts`（**2 passed**）覆盖：已 ADMITTED 但窗口过期 ⇒
  `PRICING_WINDOW_EXPIRED (initial send)` 且**计数 transport 实测 = 0**，另有窗口有效的**控制组
  真的发送**。⚠️ 该组合用的是 **paid 形状 selection**，`付费模型请求数 = 0`；**不得**声称
  "offline 也 armed"（离线 profile `offline-scripted` → `provider_unknown`，无可 armed 窗口）。
- **task-10 / S6b 的交叉绑定**：N3 已产出 journal 与严格校验，umbrella 码由
  `REQUEST_DISPATCH_JOURNAL_NOT_BOUND` 细化为具名 `DISPATCH_*` 失败，不再 flatten 成 PASS。

### 2.2 上一轮遗留、**仍未**闭环

- **task-5 / S3（F4）Phase E**：`scripts/e4/prereg-production-e2e.mjs` 的
  `runId`/`attempt`/`platform`/`dualBuild`/`evidenceRoot` 字段仍未补。
- **`§7 item 6`（真实内容闭环）**：真实内容 case 在多 turn 脚本下仍会撞
  `OFFLINE_SCRIPT_EXHAUSTED`。**不要**靠把 turn 扩到 30 来"通过"。

## 3. N1 —— worker 终止路径统一（F30-1）✅ DONE

- **实现 commit**：`2e818af`。缺陷与修复见上一版交接（`launchArmWorker` 只有 timeout 路径 abort；
  唯一的幂等 `finalize(reason)`；一个 worker 只允许一个活跃 model request，第二个以
  `ARM_WORKER_PROTOCOL_VIOLATION` 拒绝）。
- **命令与结果**：`n1-worker-lifecycle.test.ts` **15 passed**；`r0-f8-formal-budget-cancel-gaps.test.ts`
  **7 passed**；`tsc -b` exit 0。
- **证据**：`docs/evidence/n1-worker-lifecycle.md`。

## 4. N4 —— pricing expiry 接入物理发送与 retry（F30-5）✅ DONE

- **实现 commit**：`e243a40`。窄类型 frozen `PricingExecutionGuard` + 纯函数
  `checkPricingExecutionGuard(guard, nowMs)`，在**首次发送前**（任何 reservation 之前）与
  **retry 前**两个真实边界执行；分类码 `PRICING_WINDOW_EXPIRED` / `PRICING_NOT_EXECUTABLE` /
  `PRICING_COVERAGE_INSUFFICIENT` / `PRICING_BASIS_DRIFT`；依赖方向保持
  （`packages/evaluation` 不 import `apps/cli`）。
- **命令与结果**：`tool-call-efficiency-pricing-send-guard.test.ts` +
  `tool-call-efficiency-pricing-basis-wiring.test.ts` → **25 passed**。
- **证据**：`docs/evidence/n4-pricing-send-guard.md`。
- **遗留项已于本轮由 N2 关闭**（见 §2.1、§5）。

## 5. N2 —— release CLI 统一离线身份、脚本作用域、pricing guard ✅ DONE（子项 (d) PARTIAL）

**实现 commit `04dbd711`**（10 files，+2436/−68）。起始基线 `00c8660a`。

- **(a) 同一份已解析 selection**：`apps/cli/src/main.ts` 新增 `resolvePreregSelection(env)` 与
  `preregCommandDeps(env)`，把 selection（env / profile / pricing / guard / capability）**整体**
  交给 runner，不再出现"capability 读注入 env、observer 读 `process.env`"的分叉。
  `prereg-production-runner.ts` 另修一处同类缺陷：`observeExecutionIdentity` 现在优先采用
  selection 的 profile/pricing，否则 keyless 进程会自报 `stub` 而 build 绑的是
  `offline-scripted`，产生假 `PREREGISTRATION_IDENTITY_DRIFT`。
- **(b) 脚本游标作用域**：`provider.ts` 的实例级 `let turn = 0` 改为**会话级**游标
  （按 transcript 的 assistant 消息数计步 + 高水位守卫；无会话身份的请求保留历史顺序契约）。
  **没有**放进 `createClient`——driver 每个 model request 都建 client，那会把游标重置回第 1 步。
  离线内容任务从 **demo 文件写入**改为真实冻结用例 `regression/reg-22-api-stub`。
- **(c) pricing guard 接入**：见 §2.1。
- **(d) 发布入口 E2E**：`apps/cli/src/n2-release-cli-forward.test.ts` 用**真实**
  `node apps/cli/dist/main.js prereg build/validate/run` + 两个字节不同的真实 arm checkout 驱动
  runtime→tool dispatch→verifier。**状态 PARTIAL**：该 E2E 默认 **skip**，需
  `N2_RUN_RELEASE_E2E=1` 才跑；它当时在 `ARM_WORKER_PROTOCOL_VIOLATION` 处被拒（见 §7 的 task-6），
  该缺陷**已修**但**这条 E2E 尚未在修复后重跑**。
- **命令与结果（Lead 独立复核）**：`tsc -b` → exit 0；`n2-script-scope.test.ts` **10 passed**、
  `n2-unified-selection.test.ts` **9 passed**、`n2-pricing-guard-armed.test.ts` **2 passed**。
- **反例**：实例级游标 RED = **6 failed / 4 passed**（`candidate.writes` 期望 1 实得 0）；
  裸 `preregCmd`（不传 deps）仍读 `process.env` 的旧行为有专门用例记录。
- **证据**：`docs/evidence/n2-release-cli-forward.md`。
- ⚠️ 诚实口径：`reg-22-api-stub` 改的是**仓库内建零网络脚本 provider**，**不是** frozen verifier、
  **也不是**冻结任务；用例内容要求未被放宽。

## 6. N5 —— 真实构建 pair + formal 内容矩阵 + build 绑定 🟡 PARTIAL（未完成）

- **pair 已重钉**：candidate **A = `b6e6d942`**、baseline **B = `298bb923`**（B 的父提交就是 A；
  `git diff --name-only A B` 恰好 1 文件 `packages/evaluation/src/mechanism-guidance.ts`，
  `--numstat` = `1 20`；A0 的 task-6 修复在**两臂血缘**里）。旧 R15 pair 本地虽在但**结构性不可用**
  （两臂都没有 `apps/cli/src/r97-arm-abi.ts`，worker 边界会在首个 model request 前拒两臂），
  旧 R5 strict pair 的 baseline `6d609208…` **不在对象库且当前无法 fetch**。
- **`--setup-pair` 从死旗标变成真实现**：用私有 `GIT_INDEX_FILE`（`read-tree`/`hash-object`/
  `update-index --cacheinfo`/`write-tree`）+ 手工拼 commit 字节经 `git hash-object -t commit -w --stdin`；
  **自证**：同一生成器用历史输入**逐字节复现**了历史 commit `4f8d98ec`（blob `e11c4231…` /
  tree `8c0471fc…`）。派生 SHA ≠ pin 则 `BASELINE_PIN_MISMATCH` fail-closed。
- **真实双构建已跑通**：`r97-arms-r5pair` 两臂真实 `pnpm install --prefer-offline --frozen-lockfile`
  （**0 下载**）+ `pnpm build`，干净；`identity` 实测
  `baseline closure 96a9cf077d3c / candidate 05505fc79649`、**entry sha256 两臂相同**
  （`72d8c736…`）、probe 不同（`5fe66d91…` vs `45af5816…`）、两臂 ABI 齐全、`loadedEntryAgrees=yes`。
- **build 绑定已补齐**：`verifyEvidenceBundle` 新增 `ARM_IDENTITY_INCOMPLETE` /
  `MANIFEST_IDENTITY_MISMATCH` / `ARM_BUILD_FIELDS_MISSING` / `ARM_BUILD_DIGEST_MISMATCH` /
  `ARM_ENTRY_MISMATCH` / `ARM_PROBE_MISMATCH`；fixture 兼容与真实层要求**分开**。旧 gate 的
  **5 维单维度篡改里 4 维是假绿**（只换根 buildDigest / 只换某臂 entrySha / 拼接另一 run manifest /
  删 build 字段），新实现让它们全部变红且命中**对应**码。`r5-formal-gate.test.ts` **34 passed**。
- **已修的三个真实阻塞（本轮才发现）**：
  1. `r5-real-formal.mjs` 注入**过去的固定时钟** → `ARM_DEADLINE_EXCEEDED`；
  2. 只把 `R97_CAMPAIGN_CLAIMS_DIR` 放进**注入 env**，而 ledger 读 `process.env` → 第二次运行必
     `CAMPAIGN_STATE_LOST`（**门禁不可重跑**）；
  3. **N5-BLOCKER**（§7）。
- **gate 的 `MISSING_EVIDENCE` 与 `JOURNAL_MISMATCH` 已修**：根因是
  `writeEvidenceBundle` 在**临时根被删之后**才收拢，所有 `cp` 静默落空。把删除移到 bundle 写入的
  `finally` 后，最新完整运行的 bundle 已含 `evidence/`（24 个 per-armRun 目录）+ `raw/`（108 文件）
  + `cost-journal.json` + `dispatch-journal.json`。
- **`CONTENT_CORRECT_FAILED` 的根因已实测定位**：用例工作区是
  `mkdtemp(join(tmpdir(),"harness-bench-"))`，其中**只有 fixture 文件、永远没有 `package.json`**
  （`apps/cli/src/benchmark-command.ts` L1955-1967 + `assertWorkspaceIsolated`）。两个 CONTENT_FIXES
  用例的 fixture 与 verifier 都是 **ESM**（`export` + `import('./src/x.js')`），在裸工作区里
  Node v24.14.0 会 `Failed to load the ES module … SyntaxError: Unexpected token 'export'`；
  实测 `--experimental-detect-module`、`--no-experimental-detect-module`、`.mjs` 包装器**都救不了**，
  只有 (i) 工作区带 `{"type":"module"}`，或 (ii) **内容写成 CJS 形式**，两条路才能让 verifier 通过。
  `245e3957` 选了 (ii)：把注入的 CONTENT_FIXES 三份内容改成
  `exports.parse_csv = …` / `exports.countDown = …`（正确版修剪字段/正常递减），并修好 aggregate
  收拢路径、给 git 调用加 `GIT_MAX_BUFFER` 以免 negative 阶段 `spawnSync git ENOBUFS` 整段中止。
  **verifier、用例、`CONTENT_FIXES` 语义、`assertWorkspaceIsolated` 一个都没动。**

### 6.1 N5 还没做完的部分（下一位接手请从这里开始）

1. **`245e3957` 尚未被一次完整运行验证**：其后的第三次运行在 campaign 中途**被中断**
   （`%TEMP%\n5-rerun2.log` 仅 6.8 KB，止于 `trusted-build mode` 行），**没有**写出 report/bundle。
   必须重跑同一条链并**在同一回合内收结果**。
2. **正式排期仍 0 次 verifier success**。必须判定：CONTENT_FIXES 的 `correct` 变体是否从
   `failed` → **`passed`**，且 `empty`/`wrong`/`skipped` **仍然 failed 且各自真正到达 verifier**。
   - 若通过且 gate 变绿 → N5 可标 **DONE**（注明 Ubuntu = NOT_RUN，属 N6）。
   - 若仍不过 → **如实标 BLOCKED 并写清机制**，**绝不允许**改 frozen verifier、改
     `CONTENT_FIXES` 语义去回避、伪造 verification 判定、或删掉失败用例。
3. **负例矩阵六行要重新确认**：修 `maxBuffer` 前，`gitInitCommit` 的 `spawnSync git ENOBUFS`
   会让整个 negative 阶段中止 → 6 条 `NEGATIVE_ROW_MISSING`。修好后必须确认
   `missing-ABI` 行给出 **`ARM_WORKER_ABI_UNSUPPORTED`**（而非 `ERR_MODULE_NOT_FOUND` 找不到
   `@ar/contracts`），这同时是 (d) 的验收。
4. **`absolute aggregate`**：此前 `JOURNAL_MISMATCH: aggregate.json is absent`；`245e3957` 已改收拢
   路径，需在一次完整运行里确认该条消失。
5. **`--full`（31 用例 × 2 臂 × 2 rep = 124 armRun，约 10 分钟）为尽力而为**，不是 DONE 的必要条件；
   严格 gate 的 bundle 只消费 `formalSmall`。
6. **更新 `docs/evidence/n5-real-formal-offline.md` 的 §11 判定与 §14（改前/改后数字）**，
   并把 §7–§13 里"判定 = PARTIAL"的口径与新运行结果对齐。
7. **收尾清理**：`git worktree remove` 掉 `%TEMP%\n5-driver`、`%TEMP%\r97-arms-r5pair`、
   `n5-dim-*`、`n5-dryroot`、`n5-scratch-arm`；`.ci\n5-r5-evidence`、`.ci\n5-r5-evidence-r2`
   是运行产物（git 忽略），可保留作证据。

## 7. （新增）task-6 / N5-BLOCKER —— 单飞行槽释放过晚 ✅ DONE

**不在 plan 的 F30-1…F30-7 里，是本轮 N5 才使其可达的真实缺陷。实现 commit `8ee372a1`。**

- **缺陷**：父进程 `serviceModelRequest` 的单飞行槽占用窗口 =
  `[取槽, iterator.return() 清理完成]`，而协议真正的 in-flight 窗口 = `[取槽, 终止事件交付]`，
  **前者更宽**（差值是 durable cost-journal 结算，实测约 38 ms 文件 I/O）。子进程 proxy 收到终止事件
  `completed` 就结束 `generate()` 并**合法**发起下一次请求 → 撞上尚未释放的槽 → 被 N1 的
  ONE-ACTIVE-REQUEST 规则误杀 → arm 被 stop、`records=0`。
- **插桩实测**：`request id=2` → **+39 ms** `request id=3` → **+38 ms** `slot RELEASE`；
  连跑两次逐行相同 → **确定性，非 flake**。
- **已排除**：campaign 严格顺序执行（`tool-call-efficiency-paired-campaign.ts` L441
  `for (const run of orderedRuns)`）；子进程 `budget.modelInFlight` 是 per-worker（真并发会在
  子进程内抛 `PREREG_WORKER_CONCURRENCY` 而非发出第二帧）。
- **修法（选 (b)，更保守）**：子进程 proxy 等到父进程的 **`done` 帧**再结束本请求——该帧写在
  **清理之后、释放之前**，正是窗口终点；保留 `terminalDelivered` 的 EOF 兼容分支，避免把 stop
  变成 spurious EOF；不动父进程不变量。
- **不变量未被削弱**：控制组 `[control] a genuinely CONCURRENT second request is still refused`
  仍绿，父进程 row 5（`ARM_WORKER_PROTOCOL_VIOLATION` / `concurrencyRefusals>0`）**未改动**。
- **RED → GREEN**：还原 worker 后 `[sequential]` **1 failed | 16 skipped**（拒绝原文含
  `ARM_WORKER_PROTOCOL_VIOLATION … refusals=1`）；重新应用后 **17 passed (17)**。
- **命令与结果**：`n1-worker-lifecycle` **17** + `r0-f8-formal-budget-cancel-gaps` **7** +
  `n3-dispatch-journal` **19** + `r0-f6-ci-readiness-classification` **42** = **85 passed (85)**；
  `tsc -b` exit 0。
- **交叉印证**：N2 的发布入口 E2E 在**完全独立**的路径上撞到**同一个**拒绝
  （`refusals=1`、`providerFactoryCalls: 1`）。
- **Runtime Freeze 许可**：P38.4-11 第 1 类「确定性正确性 bug（有复现）」。
- **证据**：`docs/evidence/n5-arm-request-lifecycle.md`。

## 8. N6 —— 同 SHA 双平台终验 + 状态收尾 🟡 PARTIAL

- **F30-7 已修**（commit `213a63e9`）：`scripts/e4/dual-platform-acceptance.mjs` 的 join 现在
  **artifact-relative** 解析证据根，**永不**把"拼接进程的 cwd"当自动候选；新增
  `EVIDENCE_ROOT_AMBIGUOUS` / `EVIDENCE_ROOT_ESCAPE` / `EVIDENCE_ROOT_OVERRIDE_UNUSABLE`。
  在**陈旧 cwd bundle 存在**时 DP 套件由 `1 failed | 22 passed (23)` → **`28 passed (28)`**。
  证据：`docs/evidence/n6-f30-7-evidence-root-resolution.md`。
- ⛔ **双平台同 SHA 终验 BLOCKED（外部原因，非代码问题）**：
  - 本机 **git 出口已断**：`http.proxy`/`https.proxy` = `http://127.0.0.1:7897`（**未监听**），
    直连 github 超时（约 2.1 s 后失败）；本机仅 8080（`ApplicationWebServer`）在听，返回
    `Proxy CONNECT aborted`。因此**本轮 10 个提交无法 push**，也**无法 fetch**缺失的
    `6d609208…`。
  - 没有 push 就没有新 run，**因此本 SHA 无 CI URL / run / attempt / artifact**，Ubuntu 侧
    一律 **NOT_RUN**。
- **N6 尚未做的收尾**：把 required levels 从当前 CI 的
  `--require fixtureProtocolReady --strict` 扩到
  `fixtureProtocolReady` + `realBuildOfflineReady` + `budgetEvidenceReady`（`.github/workflows/ci.yml`
  L1151-1152，**属 Lead，不由队友改**）；以及 `current-prereg-status.md` 的状态收尾。
  ⚠️ 只有在 §6.1 第 2 条真的达成后才应扩 required levels，否则 CI 会被合法地判红。

## 9. 下一轮最小起点（按依赖顺序，不要并行改同一文件）

1. **N5 收口（最高优先，见 §6.1）**：重跑 `245e3957` 的真实链并在同一回合内收结果 → 判定
   CONTENT_FIXES `correct` 是否 passed、负例六行是否齐全且各按**对应**码拒绝 → 更新
   `n5-real-formal-offline.md` §11/§14 → 提交。
2. **N6 同 SHA 双平台终验**：先恢复本机 git 出口（启动 7897 上的代理，或清掉
   `http.proxy`/`https.proxy` 走直连），push 后等 workflow **completed**，再按 §8 扩 required levels
   并收尾状态文档。**在 push 成功之前，任何"CI 绿"的声明都不成立。**
3. **（可选）task-5 / S3 Phase E** 与 `§7 item 6` 的真实内容闭环（见 §2.2）——不要靠扩 turn 通过。

## 10. 执行约定（每项任务必须遵守）

1. 先读根 `AGENTS.md` 与 `plan(20260930-061557).md` 对应章节；记录 HEAD 与工作树状态。
2. **Runtime Freeze (P38.4-11)**：Runtime 改动需至少满足一项——确定性正确性 bug（有复现）、
   安全漏洞、发布完整性缺陷、可证明源自 Harness 基础设施的 benchmark 失败、实测性能回归。
   仅"模型质量差"**不构成**改 Runtime 的许可。不要大规模重构、重命名或清理历史报告。
3. 负例从**已通过的正例**派生，一次只改**一个**维度；不能用"另一项缺失导致提前失败"假装目标门禁生效。
4. 必须用**真实生产入口**（真实 CLI / campaign / verifier）。helper 测试**不能**替代生产接线
   （N4 的验收明确点名了这个陷阱）。
5. 默认离线：不读真实 key、不访问真实 endpoint、不跑付费实验、不做 promotion。
   不得新增能从 argv/env/JSON/marker 注入任意非付费 capability 的通道。
6. **省略字段 = NOT_PROVEN；伪造字段 = F3 缺陷。** 数值未知写 `null`，**绝不填 0**。
   readiness 不得由 exit=0、日志字符串或自报 PASS 生成。
7. 完成度用 DONE / BLOCKED / PARTIAL / NOT_RUN 如实标注；未运行写 NOT_RUN，**不要**用
   "已实现但未验收"冒充 DONE。
8. 跑全量期间**不得并发编辑被跟踪文件**（工作树瞬时变脏会让干净树门禁假失败）。
9. **提交信息写入文件并用 `git commit -F`**；**只 add 自己 scope 的文件**，**绝不** `git add -A`；
   **不要 `git push`**（由 Lead 统一决定推送时机，以保持同 SHA 验收单元的完整性）。
10. **后台任务会随回合结束被杀**：长链（如 N5 的 ~5 分钟 campaign）必须**在同一回合内收结果**；
    把输出重定向到日志文件再读，**绝不要**用 `Select-Object -First N` 截断（会杀掉上游进程，
    `EXIT=0` 是假象）。

### 10.1 已知陷阱（踩过的坑，别重踩）

- **`pnpm test` = `tsc -b && vitest run`，且排除若干套件**，但
  `packages/evaluation/src/r97-mutation-check.test.ts` **不在**排除列表里。**跑整套，不要只跑你以为
  相关的那部分。** 另：裸 `npx vitest run` **不等于** `pnpm test`（少了 5 个 `--exclude`）。
- **本机 Node 是 v24.14.0，CI 是 node 22**：`import()` 一个 CJS 作用域里的 `.js` 会走 CJS loader
  → `SyntaxError: Unexpected token 'export'`；Node 22 会自动检测 ESM。**本地红点未必是缺陷**
  （`e4-r77-baseline-oracle`、`r97-arm-worker-contract` 即属此类），**本地绿也不能替代 CI**。
- **vitest 把 `-t` 当正则**：`[EPERM-4]` 是非法字符类，会让 vitest 在**启动时**崩溃。
  用转义 `EPERM\-4` 或短唯一前缀。
- **干净树门禁是鸡生蛋**：gate 拒绝脏树，而编辑就会弄脏。用隔离 `git worktree add --detach`
  提交后再 `git diff <base> HEAD -- <file> | git apply` 带回。
  **绝不 `git stash`——它会静默测试错误的代码。**
- **`git cat-file -e "<sha>:<path>"` 的退出码在循环里会被误读**；筛查提交内容请用
  **`git rev-parse <rev>:<path>`** 或直接读报错文本。"文件存在于工作树"≠"存在于提交"。
- **`r97-mutation-check.mjs` 的 pre-flight 在树脏时以 `EXIT_DIRTY_TREE=4` 拒绝**（并会取锁）。
  N3 的 5 条 mutation kill 结论是**手工 apply + 定向测试 + sha256 字节级还原**取得的，
  **自动化 gate 本体是 NOT_RUN**——不要把其中任一条写成"gate 跑过了"。
- **接受纪律**：只在**当前 HEAD** 上 workflow **completed** 且必需 job 成功时报告绿。
  `concurrency: cancel-in-progress: true` 意味着每次 push 都会取消在飞的 run，
  因此"被取代 SHA 上的绿"**不是**验收证据。**run 还是 `in_progress` 时不要宣布完成。**
- **PowerShell**：不支持 heredoc；`-replace` 与 `git commit -m` 会破坏含 `$` 的文本——
  **总是**把提交信息写入文件并用 `git commit -F`。

## 11. 本次交接时的验证状态（如实记录）

- 当前 HEAD：**`245e3957`**（工作树干净）。起始基线 `00c8660a`。
- 在 `04dbd711` 上 Lead 独立复核：`npx tsc -b` → **exit 0**；7 个关键套件
  （`n2-script-scope` 10 / `n2-unified-selection` 9 / `n2-pricing-guard-armed` 2 /
  `n3-dispatch-journal` 19 / `r5-formal-gate` 25 / `dual-platform-acceptance` 28 /
  `r97-mutation-check` 35）→ **128 passed (128)**。
- 在 `8ee372a1` 上 Lead 独立复核：`n1-worker-lifecycle` **17** + `r0-f8` **7** = **24 passed (24)**，
  含 `[sequential]` 与 `[control]` 两条决定性用例。
- **全仓 `pnpm test` 在本轮任何 SHA 上均 NOT_RUN**（本机 Node 24 vs CI node 22 差异已知）。
  **不声称全仓门禁已绿。**
- **`npx tsc -b` 在已提交状态上为 exit 0**；但 `245e3957` 之后的**完整链未跑完**，
  其 runtime 效果**未经一次完整运行验证**。
- **本轮 SHA 无 CI 结论**：git 出口断（§8），提交未 push，**没有**对应的 workflow run。
- **Ubuntu = NOT_RUN**（本机仅 Windows；无 CI）。

## Historical / superseded

以下内容会随新提交过期，仅作历史快照，**不得**用作新代码的验收证据。

- 上一轮收口实现 SHA 与运行号见 git 历史与 `docs/evidence/current-prereg-status.md` 的
  CURRENT 段；上一轮 4 个未推送提交为 `7a095da` → `83f8ee8` → `e243a40` → `2e818af`。
- 最近一次全绿的双平台 workflow run 为 `36671123844`（8 个 job 全部 success），对应的是
  **被取代的** SHA。起始基线 `00c8660a` 上另有一次全绿 run `36688955701`（attempt 1，8/8 job，
  含 Windows/Ubuntu 全量 `pnpm test`）——同样**不能**证明其后 10 个提交。
- 历史 P35…P38、E4-R12…E4-R44 各批次结论见 `docs/E4-R*-report.md` 与 git 历史。
- `HANDOVER-20260928-E4-R0-R7.md` 已删除；其残留结论已并入
  `docs/evidence/current-prereg-status.md` 与 `docs/evidence/*.md`。
