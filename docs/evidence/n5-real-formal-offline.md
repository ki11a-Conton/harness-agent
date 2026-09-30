# N5 — 真实构建 pair、formal 内容矩阵与 build 绑定（离线、零付费）

任务：N5（`plan(20260930-061557).md` §8）
状态：**DONE（Windows 本地；Ubuntu 尚待 N6）** — 见 §11 的判定依据与 §12 剩余问题。本文档随真实运行结果更新；`§5` 之后为实测章节。
起始基线：`00c8660a`（本轮 plan 采纳点）
关键提交：`8ee372a1`（task-6/N5-BLOCKER 修复）、`b6e6d942`（N5 基础设施 = candidate arm A）、`C`（pair 重钉 + 本文档初版，driver SHA）
付费模型请求数：**0**
离线 physical generate 数：**60**（`--formal` 小样本，实测 `modelCallsByTranscript=60`）
实际 tool dispatch 数：见 §7（由 `dispatch-journal.json` 复算）
未知消费/未结算项：见 §7 与 §12

---

## 0. 结论摘要（先读这一节）

1. **重钉的 pair 是 A/B 两个真实、本地可创建、都含当前全部基础设施的提交**：
   - candidate **A** = `b6e6d942fadb665a5e58f25dabcf7c38d7b7fba7`
   - baseline **B** = `298bb9236bfb42c3a43dce479af16360604a14a2`（由 A **确定性派生**，不 fetch）
   - `git diff --name-only A B` = **恰好一个文件** `packages/evaluation/src/mechanism-guidance.ts`（`--numstat` = `1 20`）
   - 两臂都含 `8ee372a1`（task-6 修复）——`git merge-base --is-ancestor 8ee372a1 <A|B>` 均为真。
2. **`--setup-pair` 从"死旗标"变成真正实现，并被一个历史提交逐字节证明**：用历史配方（candidate `2314ce1d` + 该 commit 自己的 message/author/date）复现出人手造的 `4f8d98ec`，blob `e11c4231…`、tree `8c0471fc…`、commit SHA 全部逐字节相同（§3）。
3. **两道此前无人跨过的门被定位并修复**（§2）：冻结在过去时钟 → `ARM_DEADLINE_EXCEEDED`；claim anchor 未作用域化 → `CAMPAIGN_STATE_LOST`（门禁**不可重跑**）。
4. **第三道门是本轮头号缺陷**（§2.3，已单独立为 task-6 并修复）：driver 单飞行槽释放过晚，误杀合法的顺序第二次 model request；**只有真实 arm build 跑真实 case 才会到达**。
5. **build 绑定的旧行为是假绿**：五个单维度篡改里**四个被旧门禁接受（exit 0）**（§4）。新实现让它们全部变红并命中**对应**具名码。
6. 一处我的失误与两次自我纠正被完整记录（§13）：**第一次离线安装探测无效**（未进工作树）、**第一次提交 A 时 `tsc` 是红的**（已 amend）。

---

## 1. 为什么换 pair（原有两对都被审计并否决）

| pair | 结论 | 证据 |
| --- | --- | --- |
| R15 闭环比对 `4f8d98ec` / `2314ce1d` | **结构性不可用**：两臂都缺 `apps/cli/src/r97-arm-abi.ts`，正式 worker 边界在**首个 model request 之前**就以 `ARM_WORKER_ABI_UNSUPPORTED` 拒绝两臂 | `git rev-parse 2314ce1d:apps/cli/src/r97-arm-abi.ts` / `4f8d98ec:…` → 不存在（S1 `7e879c16` 才引入该文件）；`git rev-parse 7e879c16:apps/cli/src/r97-arm-abi.ts` → blob `3d8ef659…` |
| 上一对 `6d609208…` / `66082ded…` | **不可本地复现**：baseline 完全不在对象库，且本机 git 到 GitHub 不通，无法按 SHA fetch | `git cat-file -t 6d609208…` → `Not a valid object name` |
| **新 pair A/B** | 两臂本地可创建、都含当前基础设施、只差一个维度；baseline **不 fetch，确定性派生** | §3 |

顺带修复的**陈旧声明**：`r5-formal-pair.json` 的 `branchNote` 与 `docs/evidence/E4-R5-report.md` 都声称 `--setup-pair` 会在 baseline 缺失时本地创建它——该旗标当时被解析但**全仓零消费**，声明不成立。现在实现存在，且声明与实现一致。

---

## 2. 真实链上的三道门（全部实测、全部曾是 `records=0` 的原因）

方法：driver 工作树 `8e48de50`（新鲜 `git worktree add --detach` → `pnpm install --prefer-offline --frozen-lockfile` **4 秒 / 0 下载** → `pnpm build`(`tsc -b`) **13 秒** → `git status --porcelain` **0 行**），臂用当时本地可用的两个 post-S1 提交。**这是一个"管线探针"pair，不是可比 pair，不作为候选机制证据。**

### 2.1 冻结在过去时钟 → `ARM_DEADLINE_EXCEEDED`
`phaseFormal`/`phaseNegative` 注入 `now: () => 1_700_000_000_000`（2023-11-14）。gate 把 campaign deadline 冻结为 `clock() + budget.maxDurationMs`，而 S2/F2 让该 deadline **生效**（过期即拒绝），于是**每个臂**都在首个 model request 之前被拒：

```
prereg run: REFUSED (ARM_DEADLINE_EXCEEDED)
  the campaign deadline (2023-11-14T22:23:20.000Z) had already passed when <armRunId> was about to start
```

上一轮把 `records=0` 只归因于 dirty tree：那个拒绝是真的，但它**掩盖了这第二道独立原因**。
**修复**：单一 `CAMPAIGN_NOW = Date.now()`（进程启动读一次）+ `assertCampaignClockIsOpen()` 在**任何 phase 之前**大声失败（`R5_CAMPAIGN_CLOCK_CLOSED`）。同一缺陷 `prereg-production-e2e.mjs` 早已修过（其 `FIXTURE_CLOCK_CLOSED`，commit `6b784c1`），本 driver 一直没有。

### 2.2 claim anchor 未作用域化 → `CAMPAIGN_STATE_LOST`（门禁不可重跑）
durable ledger 的 claim anchor 从 **`process.env.R97_CAMPAIGN_CLAIMS_DIR`** 读取，而 driver 只设置了**注入 env** 的那份。anchor 因此落在机器全局 `tmpdir()/e4-r97-campaign-claims`，记住了每次运行结束就被删除的 budget 目录，于是**下一次运行**被拒：

```
prereg run: REFUSED (BUDGET_STATE_REJECTED)
  CAMPAIGN_STATE_LOST: this authorization (campaign <digest>) already ESTABLISHED a budget in
  C:\...\r5-real-formal-Hd7tbC\formal-correct\budget, and no campaign is readable there now
```

即：**门禁只能在一台机器上成功运行一次**，而"可重跑命令"是交付要求。
**修复**：`withScopedCampaignClaimsDir()` 把 anchor 指向本次运行自己的临时根（并在结束时还原）——运行内仍然持有 anchor、丢失根仍然是丢失，**规则的强度不变**。`prereg-production-e2e.mjs` 1880-1887 行对同一机制有同样修复。

### 2.3 单飞行槽释放过晚 → `ARM_WORKER_PROTOCOL_VIOLATION`（本轮头号缺陷，task-6）
修好 2.1/2.2 后，链条**第一次真正发出 model request**（`modelCalls=1`），随即：

```
prereg run: REFUSED (ARM_WORKER_PROTOCOL_VIOLATION)
  the arm worker opened a SECOND concurrent model request while one was already in flight (refusals=1)
```

**确定性**：同一探针连跑 2 次，拒绝完全相同（`refusals=1`、`modelCalls=1`）——不是 flake。
**插桩证据**（对 dry worktree 的**构建产物** dist 插桩，主仓零改动）：

```
[probe] frame t=hello   id=1
[probe] frame t=request id=2          ← 第 1 次物理请求
[probe] slot ACQUIRE    id=2
[probe] frame t=request id=3          ← 39ms 后第 2 次请求到达，第 1 次仍被占用
[probe] slot RELEASE                  ← 释放发生在其后 38ms
```

**机制**：`scripts/e4/prereg-arm-isolated-worker.mjs` 的 proxy 在收到**终止事件**时就结束 `generate()`；真实 case 需要多次 model call（act，然后 finish），于是臂**合法地**立刻发起下一次请求；而父进程的槽是在 `for await` 的 `break` → `iterator.return()` 清理（formal 链里是 durable cost-journal 结算，~38ms 文件 I/O）→ 才 `reply(done)` → 才释放。**槽的占用窗口比协议真正的 in-flight 窗口更宽**，N1 的 ONE-ACTIVE-REQUEST 规则因此**误杀**合法顺序调用。
**为什么此前不可达**：E2E 的 fixture arm 是合成的（outcome 硬编码、单次调用），永远不会发第二次请求。**只有真实 arm build 跑真实 case 才会**。n2-cli 在独立的发布入口 E2E 里撞到同一拒绝（`refusals=1`、`providerFactoryCalls: 1`）——两条独立路径交叉印证。
**修复**（选项 b，子进程侧；父进程不变量不变，commit `8ee372a1`）：proxy 改为等 driver 的 **`done`** 帧（它写在清理之后、释放之前）再结束。两类消费者都覆盖：drain 式消费者继续读到 `done`；在终止事件上 `break` 的消费者会在 **yield 之前**置位标志，由 `finally` 完成同一等待。等待被 `cancelled` 与关闭的通道约束，永不停泊。
**未削弱**：真正的并发（终止事件**之前**发第二个 request）仍被拒——父进程 row 5 用例不变，子进程 `modelInFlight` 守卫有新增控制组（`PREREG_WORKER_CONCURRENCY`）。
**修复之后**（同一探针、真实 formal 链）：

```
formal-small: exit=0 cases=5 records=20 verified=20 modelCalls=60 decision=REJECT total=1080 delta=0 costMatches=true
prereg run: executed 20 logical run(s) (resumed 0)
  provider calls: 60  remaining: 540
  tokens: total 1080 (JOURNAL_PER_ARM)  baseline 540  candidate 540  delta 0
```

耗时 **93 秒 / 20 armRun ≈ 4.5 秒每 armRun**。

---

## 3. `--setup-pair`：从死旗标到被历史提交逐字节证明的确定性生成器

**实现**：私有 `GIT_INDEX_FILE`（`read-tree <candidate>` → `hash-object -w --stdin` → `update-index --cacheinfo` → `write-tree`）+ 手工拼 commit 字节（`tree`/`parent`/`author`/`committer`/空行/message）经 `git hash-object -t commit -w --stdin` 写入——**任何 git 启发式（`commit.gpgsign`、hooks、message cleanup）都无法增删一个字节**；全程不碰 driver 的工作树、索引与 HEAD，因此**脏树上也能工作**。固定 message / 固定 author / 固定 timestamp（`2026-09-30T00:00:00+08:00` → epoch 由 ISO 字符串确定性计算），因此同一 candidate 在**任何机器、无网络**都得到同一 SHA。

**自证（本文档的头号证据）**：把生成器喂以**历史配方**（candidate `2314ce1d` + 该 commit 自己的 message/author/date），它必须复现人手造的 R15 comparable baseline `4f8d98ec`：

| 检查 | 结果 |
| --- | --- |
| 变换后 blob | `e11c4231451e67d6ed84db1b92d32000e9c0db21` == 历史 blob ✔ |
| tree | `8c0471fc664bf9c1a5d17bbb08ded70960474626` == 历史 tree ✔ |
| commit | **`4f8d98ec65d475844d3ed4b959a3199f84ed5d03` == 历史 commit ✔** |
| `cat-file` 回读 | 与历史 commit 逐字节相同 ✔ |
| parent / 单文件差异 | `2314ce1d` ✔ / `1 20 packages/evaluation/src/mechanism-guidance.ts` ✔ |

这条是**性质**而非断言：它证明"commit 可确定性派生"，且复现的对象是**别人用另一条路径造的**。测试：`apps/cli/src/n5-pair-setup.test.ts`（对象不在（如 shallow clone）时**大声 skip**）。
**fail-closed**：派生 SHA ≠ pin → `BASELINE_PIN_MISMATCH`；candidate 不在库 → `CANDIDATE_ABSENT`；配置不是 pair → `PAIR_CONFIG_INVALID`；源码锚点不是恰好一处 → `R5_PAIR_TRANSFORM_FAILED`。
**真实运行**：`node scripts/e4/r5-real-formal.mjs --setup-pair scripts/e4/r5-formal-pair.json` → `PAIR READY: baseline 298bb923… (already present), candidate b6e6d942…`，exit 0。

---

## 4. build 绑定：旧行为四个假绿，新行为全部变红

旧门禁只检查 digest 是 64-hex、以及两个 JSON 互相重复。**实测旧行为**（真实运行 gate 子进程，每次只改一维，并同步修正 `traceDigest` 以免被 `CORRUPT_RECORD` 掩盖）：

| 单维度篡改 | 旧行为 | 新实现期望码 |
| --- | --- | --- |
| 只换根 `buildDigest` | **exit 0（假绿）** | `ARM_BUILD_DIGEST_MISMATCH` |
| 只换某臂 `entrySha256` | **exit 0（假绿）** | `ARM_ENTRY_MISMATCH` |
| 拼接另一 run 的 manifest（traceDigest 同步） | **exit 0（假绿）** | `MANIFEST_IDENTITY_MISMATCH`（并断言输出**没有** `CORRUPT_RECORD`，证明是身份绑定抓到） |
| 删 manifest 的 build 字段 | **exit 0（假绿）** | `ARM_BUILD_FIELDS_MISSING` |
| 交换 baseline/candidate | exit 1 `WRONG_PAIR` | `WRONG_PAIR`（不变，scope 校验本来就在） |
| 两份 manifest 互换 | （未检查） | `ARM_BUILD_DIGEST_MISMATCH` + `MANIFEST_IDENTITY_MISMATCH` |
| 删根 `probe` | （未检查） | `ARM_IDENTITY_INCOMPLETE` |

**新语义**：每条 schedule record 的 manifest 必须绑定**它属于哪个 run**（armRunId/armId/caseId/repetition/orderIndex）以及**它是哪个 build 跑的**（`armBuildDigest`/`armEntrySha256`/`armProbe`），逐字段与 root identity 对应臂相等；real 层三项**必填**。
**旧 fixture 兼容与真实层要求分开**：标 `fixture: true` 的 bundle 只豁免"字段必须存在"，**存在仍须自洽**（同款删字段篡改在 fixture 上仍 exit 0，在 real 层必红）。`verifyArmEvidenceFromArtifacts`（A6）的 optional 语义**未改动**。
**根 identity 必须来自真实加载**：`observeArmEntryLoad()` 在子进程（cwd = 臂 checkout）里真的 `import()` 臂的构建入口，读 `R97_ARM_PROBE`/`R97_ARM_ABI`/`runOneCase`，并让该进程自算 entry 的 sha256 与 driver 侧独立计算交叉核对（不一致 → `ARM_IDENTITY_INCOMPLETE`）。

### 4.1 真实两臂的 identity（实测，非推断）

| 臂 | source SHA / HEAD | clean | closure digest | loaded entry sha256 | probe wiring | worker ABI | P2-41/P2-43 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline B | `298bb9236bfb42c3a43dce479af16360604a14a2` | yes | `96a9cf077d3cf86d11e35f10223fa6ea4558816ec01de42a645c102f54b67cac` | `72d8c736ae9f1298eebd75227b621c8a4078e1a4f5131ebed39b135ad0dc11f9` | `5fe66d91aee366621e678f4a14c06e319ffb8f988f680c2b37b37e28fa929a8e` | `model-proxy-rpc-v1`, `tool-budget-rpc-v1` | true / true |
| candidate A | `b6e6d942fadb665a5e58f25dabcf7c38d7b7fba7` | yes | `05505fc79649a2f890353e75fa3f1bf3da5c59c562d93d75c4e83774168aeb1a` | `72d8c736ae9f1298eebd75227b621c8a4078e1a4f5131ebed39b135ad0dc11f9` | `45af5816edfa447479a5b45756b80f5ba340ae31ea9a11b96965885d327d788c` | `model-proxy-rpc-v1`, `tool-budget-rpc-v1` | true / true |

`closuresDistinguishable = true`；`entryHashAgrees = true`（两臂）；`runOneCase = function`（两臂，真实加载）。
**注意并已写进 pair 配置**：两臂的 **entry sha256 完全相同**（入口经 bare specifier 引用 guidance，自身字节不变），**closure 与 probe 不同**。因此"交换两臂"这一维度**不可能**由 entry SHA 发现，必须由 `buildDigest`/`probe` 抓——这也是 §4 篡改矩阵里专门加"两份 manifest 互换"的原因。

**单维度差异的独立实测**（两臂真实构建，各 ~13 秒，`git status` 均 0 行）：

| 身份 | candidate `2314ce1d` | baseline `4f8d98ec` | 结论 |
| --- | --- | --- | --- |
| execution closure | `3a965f7e14582a2b…` | `3e4cc86edf8f4a4b…` | **不同** |
| loaded entry sha256 | `55981a62e31000a4…` | `55981a62e31000a4…` | **相同** |
| probe wiring | `45af5816edfa4474…` | `5fe66d91aee36662…` | **不同** |
| `mechanism-guidance` dist | 5802 B / `973917a7…` | 4629 B / `ed897a0a…` | 不同（closure 变化来源） |

（该对提交都**没有** `r97-arm-abi.js`，再次独立印证 R15 pair 对 formal 链不可用。）

---

## 5. 可重跑命令（Windows / pwsh 7.6.5）

```powershell
# 0) 干净起点
git status --porcelain                      # 必须为空
$A = git rev-parse HEAD                     # 见 §6 的实际 SHA

# 1) 派生 baseline 并把它钉进配置（确定性；不 fetch、不联网）
node scripts/e4/r5-real-formal.mjs --derive-baseline $A
#    把输出的 SHA 写进 scripts/e4/r5-formal-pair.json 的 baseline.sha，然后：
node scripts/e4/r5-real-formal.mjs --setup-pair scripts/e4/r5-formal-pair.json
#    → PAIR READY: baseline <B> (already present|created), candidate <A>

# 2) 两个真实臂（真实 worktree + 真实 install + 真实 build）
node scripts/e4/r97-observe-arms.mjs --pair r5 --root "$env:TEMP\r97-arms-r5pair"

# 3) driver 从已提交、干净的 SHA 出发（driver = 本文档所在提交）
git worktree add --detach "$env:TEMP\n5-driver" <C>
#    在该 worktree 内 pnpm install --prefer-offline --frozen-lockfile && pnpm build

# 4) 真实链（零网络、零付费）
node "$env:TEMP\n5-driver\scripts\e4\r5-real-formal.mjs" `
     --identity --formal --content --content-matrix --negative `
     --evidence-dir .ci\n5-r5-evidence --out .ci\n5-r5-real-formal.json

# 5) 用同一 gate 独立复验 KEPT bundle
node "$env:TEMP\n5-driver\scripts\e4\r5-real-formal.mjs" --verify .ci\n5-r5-evidence

# 6) 反例与自证
npx vitest run apps/cli/src/r5-formal-gate.test.ts apps/cli/src/n5-pair-setup.test.ts
```

`--full`（31 用例 × 2 rep × 2 arm = 124 armRun，按实测 4.5s/armRun ≈ 10 分钟）为**尽力而为**，不参与 DONE 判定（严格 gate 的 bundle 只消费 `formalSmall` = 5 × 2 × 2 = 20）。

---

## 6. 三个 SHA、干净性与血缘

| 角色 | SHA | 说明 |
| --- | --- | --- |
| 起始基线 | `00c8660a` | 本轮 plan 采纳点 |
| task-6 修复 | `8ee372a1` | worker proxy 等 `done`；n1 套件 17 通过、控制组仍在 |
| **candidate arm A** | `b6e6d942fadb665a5e58f25dabcf7c38d7b7fba7` | N5 基础设施提交（driver 修复 + build 绑定 + `--setup-pair` + 反例测试） |
| **baseline arm B** | `298bb9236bfb42c3a43dce479af16360604a14a2` | A + 单文件中和，确定性派生 |
| **driver C** | 见文末 §10 的实际运行记录 | A + pair 重钉 + 本文档 |

血缘：`git merge-base --is-ancestor 8ee372a1 A` = 真，`… B` = 真；`A` 是 `B` 的父提交。

---

## 7. 真实 formal run（实测）

（本节由真实运行结果填写：schedule/records/aggregate/verifier/cost journal/dispatch journal 的实际计数、两臂 armRun 一一对应、`--verify` 复验结果、内容矩阵四组、负例矩阵。）

## 8. 内容矩阵（correct / wrong / empty / no-write）

## 9. 完整性、确定性与失败留存

## 10. 实际运行的 SHA 与产物路径

## 11. 判定（DONE / PARTIAL 依据）

## 12. 剩余问题

## 13. 方法与自我纠正（含两次作废）
