# Harness Agent — Evolution E3 执行计划

> 主题：从“平行模块存在”升级为“唯一真实路径生效”
>
> 审查基线：`f73a337d71027afd48a8ac5ac0de1a7f4ae8497c`
>
> 上一基线：`5a6f90c4767413ae1c89dca7a451a13ab5dd6cf0`
>
> 仓库：`https://github.com/ki11a-Conton/harness-agent`
>
> 审查日期：2026-09-02
>
> 使用方式：本文件中每一个 `E3-xx` 块都是一段可以单独复制给 coding agent 的完整提示词。Agent 必须完成该块的“做什么、怎么做、怎么验收、交付什么”，不能仅新增一个未接入生产路径的模块或用手工构造对象证明通过。

---

## 0. 审查结论

E2 不是毫无价值。以下工作确实有进展：

- 历史 AR2 C1 已回到 C0，原 evidence 和 history 得到保留。
- `benchmark validate` 不再把真实目录误报为 `0 cases / VALID`。
- `recommendsRepetition` 已在旧 champion decision 路径中变成约束，当前 AR2 不再得到 ACCEPT。
- capability audit 默认运行后不再改写 tracked matrix。
- 新增了 artifact、provenance、arm、paired plan、decision、promotion、profile、isolation、recovery、security、ledger 等结构化模块和大量单元测试。
- 没有擅自执行 E2-15 的真实付费复测，这一点是正确的。

但是，不能认定 E2-00～E2-16 已“完美完成”。主要问题不是缺少类型和单元测试，而是许多 E2 模块没有进入实际命令与运行时路径。当前系统同时存在两套逻辑：

```text
E2 模块 + 自构造单元测试       → 看起来满足新协议
真实 benchmark/champion/runtime → 继续运行旧 E1 协议
```

因此当前状态应定义为：

- **代码可编译，但全量测试不通过。**
- **不得发布。**
- **不得晋级任何 Champion。**
- **不得执行真实付费 benchmark。**
- **active production Champion 继续为 C0。**
- E3 期间不新增新候选，不扩展模型能力，先完成真实路径收敛。

---

## 1. 本次实际验证结果

### 1.1 免费门禁

| 命令 | 实际结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| E2 定向测试 | 16 files PASS、1 file FAIL；163 PASS、1 FAIL |
| `pnpm test` | **FAIL**；280 files PASS、1 FAIL；5248 tests PASS、1 FAIL |
| `pnpm test:coverage` | **FAIL**；同一测试失败，未产生可接受 coverage gate |
| `pnpm test:protocol` | 7 files / 52 tests PASS |
| `pnpm test:security` | 18 files / 2133 tests PASS |
| `pnpm test:race` | 11 files / 23 tests PASS |
| `pnpm test:chaos` | 1 file / 12 tests PASS |
| `pnpm benchmark:smoke` | 命令 PASS，但内部 case 仍是 0/1 FAIL；当前只检查 token accounting |
| `pnpm docs:verify` | 命令 PASS，但没有发现损坏/过期的 E2 handoff，属于验证覆盖缺口 |
| `pnpm capability:audit` | FAIL；evidence freshness 不满足，但运行前后 tracked matrix hash 不变 |
| `pnpm release:verify` | FAIL；当前 HEAD 的全部 gate evidence 为 NOT_RUN |
| `git diff --check 5a6f90c..f73a337` | PASS |
| 最终 `git status --short` | clean |

失败测试：

```text
packages/evaluation/src/benchmark-isolation.test.ts
E2-09 host mutation sentinel >
isPathOutsideWorkspace classifies escape vs containment
```

根因是测试在 Linux 上把 Windows 路径交给宿主平台的 `node:path.resolve/relative`；实现和测试都没有使用 `path.win32` 的目标平台语义。

### 1.2 真实 CLI 与最小攻击性复现

以下复现全部使用临时目录和 fake/scripted provider；真实 provider 调用数为 0。

| 编号 | 可复现事实 | 实际结果 |
|---|---|---|
| R-01 | 非法 `--repeat 2 --interleave` 且未 `--shuffle` | CLI 最后报错，但报错前 provider 已调用 1 次 |
| R-02 | 一个 case、一个 arm、`--repeat 2` | provider 实际调用 3 次，仍是 initial + N repeats |
| R-03 | paired plan 中标记为 BA 的 pair | `baseline.orderIndex=0`、`candidate.orderIndex=1`，实际仍是 baseline 先执行 |
| R-04 | 向 candidate actual config 增加未声明的 `undeclaredSecurityBypass=true` | ArmFactory 仍返回 comparable、providerCallsAllowed=true |
| R-05 | strict provenance 的 source/build/env/provider/cases/protocol 全部为 unknown/null | 返回 `comparable=true`、`promotionEligible=true` |
| R-06 | `repetitions=2`，但 `perRepetitionDeltas=[]` | `decideChampionV3()` 返回 ACCEPT |
| R-07 | 自行构造 PromotionEnvelope，decision digest 和 source SHA 填任意字符串 | strict loader 返回 accepted=true |
| R-08 | 两个并发 CAS 基于同一 parent 写不同 candidate | 两个写入都返回 ok=true，最后写入者覆盖前者 |
| R-09 | 篡改 V3 summary 中 passRate、token、recoveryRate，但保留 caseCount/passed | strict loader 接受 |
| R-10 | benchmark 中的真实 `exec` 写入 case workspace 外的绝对路径 | 外部文件创建成功，benchmark 最后报告 1/1 PASS |
| R-11 | 当前 AR2 运行真实 `champion eval --strict` | 仍输出 verified `0→0`、grade `?`，且先称 provenance compatible；最终仅 INCONCLUSIVE，不是 V3 的 INVALID |
| R-12 | 当前历史 AR2 运行 `benchmark validate` | 改进有效：发现 32 cases，并正确标 legacy/not-promotion-eligible |

---

## 2. E2 逐项真实性结论

| E2 任务 | 结论 | 关键原因 |
|---|---|---|
| E2-00 | 部分完成 | C1 已隔离；但 state 的 C0 validity 仍为 quarantine，historicalDecision 丢失，reason code 重复 |
| E2-01 | 部分完成 | validator 能发现 legacy artifact；真实 benchmark 不写 V3，summary/schema/digest 仍可绕过 |
| E2-02 | 未接入 | ProvenanceV3 只有模块/测试；真实 benchmark/champion eval 仍走 V2，unknown 可被 strict 接受 |
| E2-03 | 部分接入但不可信 | CLI 只调用 preflight，实际 Harness 仍靠 `opts.candidate === ...`；undeclared delta 可绕过 |
| E2-04 | 未接入 | ActivationEvidenceV2 无 production consumer；真实结果仍写 E1 activation evidence |
| E2-05 | 未接入 | PairedPlan 没有 executor；真实 CLI 保留 N+1、单 arm、报错后调用 provider 的旧实现 |
| E2-06 | 未接入 | `champion eval` 仍调用旧 `loadRunsFromArtifact` 和 E1 decision；V3 decision 只吃手填布尔值 |
| E2-07 | 高风险未完成 | envelope 可自行生成；不验证 decision 文件/内容；CAS 非原子；promote 先写 applied=true |
| E2-08 | 未接入 | profile loader 只在 evaluation/诊断测试使用；生产 `createHarness()` 不消费 Champion |
| E2-09 | 未完成 | 只检测部分 host repo 变化，不阻止写入；repo 外写入完全漏检；backend probe 不执行 sandbox |
| E2-10 | 未完成 | actor 总把 handler failure 设为 retryable=false；T1 被 shift，随后 T2 继续；状态不持久化 |
| E2-11 | 未接入 | SecurityOutcomeV2 只在模块/测试；真实 judge/runner 继续使用旧文本 taxonomy |
| E2-12 | 部分完成 | ledger 校验引用有价值；但不比较 handoff/state，handoff Markdown 已损坏且 HEAD 过期 |
| E2-13 | 部分完成 | audit 无副作用已实现；GateEvidenceV2 未被 audit/release consumer 使用，release 全部 NOT_RUN |
| E2-14 | 未完成 | readiness 依赖调用者传入 wired/event booleans；eligible 用 Map.size 而非 true 计数；未接 paid preflight |
| E2-15 | 正确保持 BLOCKED | 没有付费调用；但 dry-run 是静态文件，不是实际 CLI 产物，且不具备执行能力 |
| E2-16 | 未完成 | “架构不变量”测试多为检查函数/字符串存在；隔离测试实际证明逃逸成功，full test/coverage 失败 |

---

## 3. E3 全局规则

### 3.1 唯一真实路径原则

每个 Agent 都必须遵守：

1. 不再新增与 production path 平行的 `*-v4.ts`、`*-new.ts`、纯函数 demo，除非同一任务把真实 CLI/runtime consumer 切换过去。
2. 每个新能力必须列出：producer、serialized artifact、loader、policy consumer、state mutation、runtime consumer。
3. 测试必须至少有一个从真实入口开始：
   - CLI：`runCli()` 或打包后的 `node apps/cli/dist/main.js ...`；
   - benchmark：真实 `runBenchmarkCommand()` + counting fake provider；
   - runtime：真实 `SessionActor` / `createHarness()`；
   - isolation：真实子进程和真实文件效果。
4. 禁止把手填的 `comparable: true`、`digestValid: true`、`activationWired: true`、`securityBreaches: 0` 当作端到端证明。
5. 旧 E1 path 若仍存在，只能明确标为 historical/read-only；它不得拥有 promotion authority。

### 3.2 Runtime Freeze

- Runtime architecture 继续 FROZEN。
- E3-09 属于已复现的安全边界缺陷，符合 security exception。
- E3-10 属于已复现的 durable correctness bug，符合 deterministic correctness exception。
- 其他任务应优先修改 evaluation/CLI/strategy/config 边界，不重写 P14–P38 核心架构。

### 3.3 付费调用禁令

- E3-00～E3-13、E3-15 必须只用 fake/scripted provider、离线 fixture 和历史 artifact。
- E3-14 默认 `BLOCKED_AWAITING_OPERATOR_AUTHORIZATION`。
- API key 存在不等于授权。
- 没有同时满足以下条件，真实 provider 调用必须为 0：
  1. 用户在当前会话明确同意费用；
  2. `RUN_PAID_BENCHMARKS=1`；
  3. plan digest 已确认；
  4. 预计最大 model calls、tokens、cost 已显示；
  5. 强隔离 backend 自测通过；
  6. E3-00～E3-13 全部通过。

### 3.4 每任务标准循环

1. 检查 `AGENTS.md`、HEAD、status 和相关调用链。
2. 先用真实入口复现缺陷。
3. 先写在旧实现上失败的行为测试。
4. 做最小实现并切换真实 consumer。
5. 运行定向测试。
6. 运行受影响 package 和必要全局门禁。
7. 检查 `git diff --check`、`git status --short`。
8. 输出机器证据、命令、退出码、调用次数和残余风险。

### 3.5 通用完成标准

- reason code 稳定、typed、fail closed。
- 外部 JSON 经过完整运行时校验；不能宽松 `as` cast。
- 所有计数、summary、readiness、decision 从真实输入派生。
- 任何 unknown、partial、legacy、stale、dirty 不可获得 promotion eligibility。
- 测试名称与断言一致；不能写“cannot escape”却断言逃逸文件存在。
- 默认命令不修改 tracked 文件。
- 本任务没有真实 provider 调用，除非任务是 E3-14 且已授权。

---

## 4. 任务依赖与优先级

| 任务 | 优先级 | 依赖 | 付费调用 |
|---|---:|---|---:|
| E3-00 | P0 | 无 | 禁止 |
| E3-01 | P0 Security/Cost | E3-00 | 禁止 |
| E3-02 | P0 | E3-01 | 禁止 |
| E3-03 | P0 | E3-00 | 禁止 |
| E3-04 | P0 | E3-02、E3-03 | 禁止 |
| E3-05 | P0 | E3-03、E3-04 | 禁止 |
| E3-06 | P0 | E3-02、E3-04、E3-05 | 禁止 |
| E3-07 | P0 Security | E3-06 | 禁止 |
| E3-08 | P0 | E3-03、E3-07 | 禁止 |
| E3-09 | P0 Security | E3-01 | 禁止 |
| E3-10 | P0 Correctness | E3-00 | 禁止 |
| E3-11 | P1 | E3-04～E3-10 | 禁止 |
| E3-12 | P1 | E3-02～E3-11 | 禁止 |
| E3-13 | P0 Integration | E3-01～E3-12 | 禁止 |
| E3-14 | BLOCKED | E3-13 | 仅授权后 |
| E3-15 | Final | E3-00～E3-13；E3-14 可保持 BLOCKED | 禁止 |

---

# 5. 可直接交给 Agent 的任务提示词

## E3-00 — 建立真实失败基线并修复跨平台测试基础

### Agent 提示词

你正在维护 `harness-agent`。请以 `f73a337d71027afd48a8ac5ac0de1a7f4ae8497c` 为基线，建立 E3 的机器可读审查基线，修复当前跨平台测试本身的错误，并把 R-01～R-12 固化为可重复的 integration regression。此任务不修复所有业务缺陷，但必须让后续 Agent 能看到真实失败，而不是被 E2 handoff 的“全部完成”误导。

#### 做什么

1. 新增 `e3-review-baseline.json`，记录当前 HEAD、门禁结果、R-01～R-12、真实调用次数和当前 active Champion。
2. 修复 `benchmark-isolation.test.ts` 的目标平台路径语义：Windows case 使用 `path.win32`，POSIX case 使用 `path.posix`，不得依赖宿主平台解释另一平台路径。
3. 建立 E3 integration regression 文件，直接从真实入口复现：
   - invalid interleave 调用 provider；
   - repeat N+1；
   - Arm undeclared delta bypass；
   - all-unknown provenance 被接受；
   - BA orderIndex 错误；
   - forged envelope 被接受；
   - summary tamper 被接受；
   - benchmark exec 写出 workspace；
   - CAS 双成功；
   - actor T1 failure 后 T2 继续。
4. 当前未修复的 regression 可以放在专用 `repro-current-defects` suite，并明确预期为“缺陷仍可复现”；不得把它们混入默认 PASS suite 后用 skip 掩盖。
5. 将 `docs/evolution/e2-handoff.md/json` 标为 historical snapshot，明确 subject SHA 与已知错误；不要继续声称 current HEAD 全绿。

#### 怎么做

1. 开始前运行：

```bash
git status --short
git rev-parse HEAD
pnpm typecheck
pnpm test
```

2. 为路径分类 API 增加显式 flavor 参数或两个函数：
   - `isPathOutsideWorkspace(path, workspace, "win32")`
   - `isPathOutsideWorkspace(path, workspace, "posix")`
   实现内部使用对应 `path.win32.resolve/relative/isAbsolute` 或 `path.posix`。
3. 不把 Windows 字符串先交给宿主 `resolve()` 再测试；那会改变测试含义。
4. regression harness 使用 counting `ScriptedModelProvider` 和临时目录；每个 case 清理自己的目标路径。
5. baseline JSON 必须由脚本生成，不能手填“PASS”。它要记录命令、exit code、关键 stdout 摘要、providerCalls、工作树前后 digest。
6. handoff 不要记录“当前 HEAD”这种会因提交自身而自相矛盾的字段；使用 `subjectSha` 或 `subjectTreeDigest`，并说明文档提交不属于被测代码树。

#### 怎么验收

1. 当前默认 `pnpm test` 不再因错误的跨平台 path test 失败。
2. 专用 defect repro 对 R-01～R-12 全部输出 `REPRODUCED`，且 fake provider 之外真实调用为 0。
3. path 单元测试同时覆盖：Windows drive、UNC、大小写策略、POSIX root、`..`、symlink 另由真实路径测试覆盖。
4. E3 baseline 中不能写“all gates pass”；必须准确记录 capability/release/coverage 状态。
5. 工作树清洁检查有 before/after 证据。

运行：

```bash
pnpm typecheck
pnpm vitest run packages/evaluation/src/benchmark-isolation.test.ts
pnpm test
pnpm e3:repro-current-defects
git diff --check
git status --short
```

如果不希望新增 package script，可提供等价的 `node scripts/e3/repro-current-defects.mjs`，但必须可在无 API key 环境执行。

#### 交付物

- 机器基线 JSON。
- 跨平台路径测试修复。
- 真实入口 defect repro suite。
- 已纠正的 historical E2 handoff 状态说明。

---

## E3-01 — 在真实 benchmark CLI 最前面实施付费保护和完整 preflight

### Agent 提示词

请修复真实 `runBenchmarkCommand()` 的费用与前置检查顺序。当前 API key 存在时可直接运行真实 provider；`RUN_PAID_BENCHMARKS` 只存在于未接入的纯函数和文档。非法 interleave 还会在首次 provider 调用后才报错。完成后，任何参数、计划、候选、隔离、预算或授权失败都必须发生在 provider `generate()` 之前。

#### 做什么

1. 将真实 benchmark 流程拆成：parse → resolve cases → resolve arms → build plan → validate protocol → probe isolation → cost/call preflight → authorization → provider execution。
2. 真实 provider 必须要求 `RUN_PAID_BENCHMARKS=1`；API key 仅用于认证，不是费用许可。
3. 新增真正可执行的 `--dry-run --json`，输出 canonical plan 和 plan digest，provider 调用数为 0。
4. 新增硬限制：`--max-logical-runs`、`--max-model-calls`、`--max-estimated-tokens`、`--max-estimated-cost-usd`。
5. 所有非法 flag 组合在解析后、provider 解析/调用前失败。
6. fake/scripted provider 在测试中可显式标记 billing class 为 `offline`，不要求付费开关。

#### 怎么做

1. 修改真实 `apps/cli/src/benchmark-command.ts`，不要只修改 `preflightPairedPlan()`。
2. 为 provider 增加可信的 billing classification，来源是生产 resolver/配置，而不是 provider 任意 ID 字符串；例如：
   - `offline-test`
   - `local-no-cost`
   - `external-billed`
3. preflight 不得调用 `createClient().generate()`。可以读取非秘密环境配置，但不得发送网络请求。
4. plan digest 覆盖 cases、candidate、arm digests、repetitions、AB/BA order、model/provider identity、limits、policy versions 和 output target。
5. 真正执行时要求传入/确认同一个 plan digest，防止 dry-run 后参数变化。
6. 默认 limits 必须保守且明确。估算未知时不得显示 `$0`；使用 `unknown` 并要求显式调用上限。
7. preflight 验证：case 非空、无重复、candidate READY、actual arm delta、所有 flags、输出目录、resume 状态、强隔离、费用授权。
8. 保留 legacy single-arm measurement 命令时，给它单独名称/模式，并同样执行真实 provider 费用保护；promotion experiment 不得走 legacy 模式。

#### 怎么验收

使用 counting provider 断言：

1. 非法 `--interleave`、空 cases、重复 cases、unknown/no-op/unsupported candidate、预算超限、隔离不可用、plan digest 不匹配：调用数均为 0。
2. 仅设置 API key、未设置 `RUN_PAID_BENCHMARKS=1`：真实 provider 调用数为 0。
3. 设置 `RUN_PAID_BENCHMARKS=1` 但没有确认 plan digest：调用数为 0。
4. `--dry-run` 不初始化付费 client、不写 final artifact、不修改 Champion/state。
5. `--dry-run --json` stdout 是一个 JSON 文档；日志在 stderr。
6. real provider 的预估未知时仍受 `max-model-calls` 硬限制。
7. E2 静态 dry-run 文件不能作为授权输入；必须由当前 HEAD 的真实命令生成。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/cli test
pnpm --filter @harness/evaluation test
pnpm test:protocol
git diff --check
```

#### 禁止事项

- 不执行真实模型。
- 不把 `process.env.OPENAI_API_KEY !== undefined` 当授权。
- 不只在纯函数中添加 guard 而不调用它。

#### 交付物

- 真实 CLI preflight/paid guard/dry-run。
- 零调用攻击测试。
- 示例 dry-run JSON，由实际命令生成。

---

## E3-02 — 实现真实 PairedExperimentExecutor，彻底删除 N+1 与假 BA

### Agent 提示词

请把 `PairedExperimentPlan` 接入真实 benchmark 执行。当前计划模块没有 executor，真实 CLI 仍先跑 `runBaseline()` 再追加 N 次，并且 BA pair 的 orderIndex 仍让 baseline 先执行。完成后，一个 promotion experiment 必须在同一 plan 中同时调度 baseline/candidate，每个 pair 恰好包含两个 arm outcome。

#### 做什么

1. 修复 plan 的实际 order：AB 时 A index < B，BA 时 B index < A。
2. 新增 `PairedExperimentExecutor`，按 plan order 调用真实 `runOneCase`/arm runner。
3. `repeat=N` 精确表示每个 case、每个 arm 各 N 个独立 repetition；不再存在 initial + N。
4. 记录 logical run、model call attempt、transport retry 三种不同计数。
5. 实现 partial artifact、resume、pair finalize 和中断恢复。
6. promotion decision 只消费 finalized pairs；半 pair 不得计分。

#### 怎么做

1. 将旧 `runBaseline()` + `runRepeatedBaseline()` promotion 路径移除或降级为 historical measurement。
2. plan 建立真实 ordered run list，不只给 pair 一个 label：

```text
pair P1 order BA → candidate run index 0, baseline run index 1
pair P2 order AB → baseline run index 2, candidate run index 3
```

3. provider model call 不是“一次 arm run固定一次”。在 ModelClient 周围增加计数/上限 wrapper，每次 `generate()` 都消耗 model-call budget。
4. transport retry 共享 logicalSampleId/armRunId，只增加 attempt，不增加 repetition。
5. 每完成一个 arm 原子写 partial journal；只有两个 arm 都 strict-valid 才 finalize pair。
6. resume 读取 plan digest 和 partial journal。digest 不同拒绝 resume。
7. 崩溃发生在一个 pair 的第一 arm 后：恢复时补齐或按预注册策略重跑完整 pair；不得将单边结果带入统计。
8. 顺序随机只由 orderSeed 控制；model seed 另存。

#### 怎么验收

1. 2 cases × 3 repetitions × 2 arms = 12 logical arm runs，绝不能是 14、18 或 24。
2. 每个 BA pair 的 candidate 实际调用时间/sequence 早于 baseline。
3. 同 seed 的完整 ordered plan byte-identical；不同 seed 只改变顺序字段。
4. counting provider 可以出现每 arm 多个 model calls；达到 `max-model-calls` 后立即停止并生成 partial invalid artifact。
5. 第 5 个 logical run 注入崩溃，resume 后每个 finalized pair 恰好 A/B 各一份，且没有重复 independent sample。
6. `repeat=0`、负数、非整数、重复 case ID 必须拒绝，不得自动修正为 1。
7. 旧 R-01、R-02、R-03 变为 `FIXED`。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm test:protocol
git diff --check
```

#### 交付物

- 真实 paired executor。
- exact count/order/resume tests。
- legacy measurement 与 promotion experiment 的清晰边界。

---

## E3-03 — 让 ArmFactory 构造真实 Harness，而不是描述性 Record

### Agent 提示词

请把 ArmFactory 从 `Record<string, unknown>` 描述器升级为真实 Harness 构造单一来源，并让 benchmark、manifest、activation 和 production profile 都使用它。当前 benchmark 只调用 `preflight()`，之后继续硬编码 `opts.candidate === ...`；compare 还因 `allowed.has(candidateId)` 而允许任意未声明配置变化。

#### 做什么

1. 定义 typed `ResolvedExperimentArm`，包含可直接传入真实 Harness/runtime 的配置和机制 factory。
2. 删除真实 benchmark 中所有 candidate ID 硬编码分支，统一调用 resolved arm。
3. actual config diff 使用精确 JSON pointer/path allowlist；未声明差异一律拒绝。
4. 捕获真实 tool schemas、prompt additions、memory/recovery/subagent constructors 和 config digest。
5. eligibility 与 activation 分离；case 有 memory source/subagent requirement 不得自动污染 baseline。
6. MechanismContract 和 Champion profile 复用同一个 resolved arm。

#### 怎么做

1. 先搜索并清理以下模式：

```text
opts.candidate ===
candidate === "memory_retrieval"
candidate === "adaptive_recovery_v2"
candidate === "budget_aware_completion_v1"
```

2. 不要在 evaluation package 伪造一套并不存在于 `HarnessConfig` 的字段。必要时使用已公开的 runtime strategy injection point；若某机制没有真实公开边界，标 `UNSUPPORTED`。
3. resolved arm 至少包含：
   - validated HarnessConfig；
   - system prompt builder；
   - tool registration/advertisement policy；
   - memory provider factory；
   - recovery planner factory；
   - delegation factory；
   - eligibility predicate；
   - activation observers；
   - declared exact delta paths。
4. 先构造 baseline 和 candidate，再用递归结构化 diff 得到 observed paths。不要将 candidate ID 当 wildcard。
5. `toolSchemas` 和 `promptAdditionsDigest` 必须来自最终送入 runtime/provider 的实际值，不能保持 `[]`/`null`。
6. digest 使用真正 SHA-256；字段名为 digest 时不能存 raw stable JSON。
7. memory eligible case：baseline memory off、candidate memory on；ineligible case 根据 protocol skip 或记录 not-activated，不自动开启。
8. delegation 在真实 wiring 完成前保持 UNSUPPORTED。

#### 怎么验收

1. 在 candidate config 加 `undeclaredSecurityBypass`，preflight 返回 `UNDECLARED_ARM_DELTA`，providerCalls=0。
2. 每个 declared delta path 都必须真实出现；声明但未出现返回 `NO_CAUSAL_DELTA`。
3. benchmark 真实 runtime 收到的 config digest 与 ArmFactory snapshot digest 一致。
4. 修改 prompt/tool schema/runtime strategy 后 digest 改变。
5. baseline eligible memory case 仍不注入 memory；candidate 才注入。
6. `rg 'opts\.candidate ===|candidate === "' apps/cli/src/benchmark-command.ts` 不再发现 candidate wiring 分支。
7. 行为测试触发 adaptive recovery，并观察真实 planner ID，而不只检查 config 字段。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm --filter @harness/harness test
pnpm benchmark:smoke
git diff --check
```

#### 交付物

- typed real ArmFactory。
- benchmark/manifest/profile 的统一接入。
- exact delta/no-op/eligibility tests。

---

## E3-04 — 将 ArtifactV3 与 ProvenanceV3 合并成真实、严格、完整的实验产物

### Agent 提示词

请修复 ArtifactV3 的 schema/digest/summary 缺口，并把 V3 writer 接入 E3-02 的真实 paired executor。当前真实 CLI 仍写 legacy report；V3 manifest 只验证为 object、summary 被直接 cast 且只比较 caseCount/passed、provenance 仍是简化字段，Activation/Security 类型也与 V2 模块不一致。

#### 做什么

1. 设计唯一 `ExperimentArtifactV3` schema，直接嵌入/引用完整 `ExperimentProvenanceV3`、`ActivationEvidenceV2`、`SecurityOutcomeV2`。
2. production paired executor 只写 V3；legacy writer 仅用于 historical mode。
3. 完整运行时校验 manifest、summary、outcomes、activation、security、provenance、protocol。
4. summary 每个字段都重算并比较。
5. content digest 覆盖除自身 digest 和明确顶层非确定时间字段外的全部内容；不得递归删除任意同名嵌套字段。
6. strict provenance 中任何必要 unknown/null 都使 promotionEligible=false。
7. observed arm delta 来自 E3-03 actual config diff，不是 candidateId 声明。

#### 怎么做

1. 使用统一 runtime schema 实现；可以手写 validator，但必须逐字段、逐 enum、逐数值约束。若引入 schema 库，评估依赖体积和仓库约定。
2. 数值约束至少包括：整数 attempt/repetition/order、非负 tokens/latency/tool calls、0≤rates≤1、finite cost、case IDs 非空。
3. manifest 必须包含 exact source/build/provider/protocol/arm/runtime identities；不能只是 `Record<string, unknown>`。
4. `summary` 不参与主 digest也可以，但 loader 必须深度比较整个 derived summary。更简单安全的方案是 summary 也进入 content digest，同时仍做派生比较。
5. schema version、policy version、runner version 不能互相误填；当前 `captureBuildIdentityV3` 把 artifact schema 写成 provenance version，应修复。
6. provenance strict：调用 `hasUnknownIdentity()` 并扩展到所有 required fields；双方都 null 不能因“相等”而通过。
7. 不要简单过滤绝对 fixture path 并丢掉内容。将运行时绝对路径映射为逻辑相对 fixture path；无法安全映射时 fail closed。
8. duplicate case ID、pair ID、arm/repetition/attempt identity 必须检查。
9. source clean 在运行前后捕获；中途修改时 artifact final state 为 invalid。
10. V3 writer 必须从真实 runner outcome 转换 grade、verification、termination，而不是另写一套 fixture builder。

#### 怎么验收

1. 篡改 summary 任意字段，包括 passRate、tokens、cost、latency、recoveryRate：strict loader 拒绝。
2. manifest 为空对象：strict loader 拒绝。
3. provenance required fields 全 null：`promotionEligible=false`，reason 包含 `UNKNOWN_IDENTITY`。
4. 修改 request/expected/case/verification/forbidden/limits/tool schema/fixture 内容任一项：case digest 改变。
5. 路径临时根变化但逻辑 fixture 相同：case digest 不变。
6. production benchmark fake run 生成 V3，随后 `benchmark validate` 返回 cases>0、suite>0、VALID。
7. production artifact round-trip 后 grade、verification、termination、activation、security、manifest/protocol 全部相等。
8. legacy artifact 被发现但永远不可晋级。
9. regression 和 holdout 等所有 suite 的 canonical 命名都可发现，不局限 `*-holdout.json`。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm build
node apps/cli/dist/main.js benchmark experiment --dry-run --json
git diff --check
```

最后命令不得调用真实 provider。

#### 交付物

- 合并后的 canonical schema/writer/loader/validator。
- 真实 benchmark V3 output integration。
- summary/provenance/tamper attack tests。

---

## E3-05 — 把 ActivationEvidenceV2 与 SecurityOutcomeV2 接入真实事件流

### Agent 提示词

请让 activation/security 证据由真实 runtime/tool/sandbox/verifier 事件产生，并进入 V3 artifact。当前两个 V2 模块没有 production consumer；MechanismContract 还接受调用者手填 `wired` 与 `requiredEvents` 布尔值，eligible 数量错误地使用 Map.size。

#### 做什么

1. 建立从真实 `AgentEvent` / tool policy / sandbox / verifier 到 typed activation/security facts 的 adapter。
2. 每个 fact 绑定 caseId、pairId、armId、repetition、logical sample、attempt、toolCallId、policy rule、effect verification。
3. 由真实事件聚合 activation coverage 和 security outcome。
4. Mechanism readiness 从实际 arm、fixture eligibility 和 recorder 能力自动派生，不接受调用者自报“已接线”。
5. 修复 eligible count，只计算 `eligible === true`。
6. 旧字符串 taxonomy 只走 historical adapter，strict promotion 一律 unknown/invalid。

#### 怎么做

1. 在事实发生位置发 typed event：
   - final provider request 构造后：prompt/memory/tool schema digest；
   - recovery planner 决策时：trigger/action/budget/lineage；
   - subagent dispatch/complete 时；
   - PermissionEngine/SandboxManager deny 时；
   - effect verifier 检测 unauthorized effect 时。
2. 禁止 benchmark command 因 candidate 名称主动追加“激活成功”。
3. activation digest 要能从 artifact 内的脱敏 canonical source 重算；只有 digest、没有重算 source/ref 不足以证明。
4. security correlation：攻击尝试被拒绝是 CONTAINED；effect 成功才是 breach。call ID 不一致为 INVALID。
5. sentinel 检测到 host mutation只能生成事实，不能代替 E3-09 的预防；检测后的环境也要标 tainted。
6. readiness 的 eligible cases 来自实际 case definitions 和 contract predicate；输出具体 case IDs，不只数量。
7. quality attribution 同时输出 all/eligible/activated pair effect；未激活 case 的胜利不能归因于机制。

#### 怎么验收

1. memory source 存在但 baseline 不注入：baseline unactivated；candidate 注入非空 block 后才 activated。
2. 手工传 `activationWired=true` 的旧入口被删除或无法影响 readiness。
3. 5 个 map entry 只有 2 个 true 时，eligibleCases=2，不是 5。
4. candidate 名称存在但 model request 不含机制：activation 未满足。
5. denied forbidden command：CONTAINED、hardBreach=false。
6. 外部文件真实创建：UNAUTHORIZED_EFFECT/ESCAPE、hardBreach=true。
7. typed evidence writer→artifact→loader→decision 无字段丢失。
8. current legacy AR2 security/activation 只能 historical display，不能严格晋级。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm test:security
pnpm test:protocol
git diff --check
```

#### 交付物

- production event adapters/recorders。
- 实际 readiness/coverage/security aggregation。
- 因果归因与攻击测试。

---

## E3-06 — 用 V3 artifact 驱动唯一 Champion Eval，并生成可重算 DecisionArtifact

### Agent 提示词

请把真实 `agent champion eval` 切换到 V3 pipeline。当前命令仍调用 `loadRunsFromArtifact()`、V2 comparability 和 E1 decision，所以会把 dirty cross-SHA AR2 先称为 compatible，并继续输出 grade `?`、verified `0→0`。新的 decision 不得接受调用者手填 gate booleans。

#### 做什么

1. strict eval 只加载 canonical V3 baseline/candidate paired artifact。
2. 从 artifact 自动计算：integrity、provenance、pair completeness、activation、安全、verification、infra asymmetry、per-repetition effect、cost。
3. 将 `DecisionGateInputV3` 变成内部派生值；CLI/外部调用者不能随意传 true/false。
4. 生成 `DecisionArtifactV3`，绑定 candidate、parent、plan/policy、artifact digests、provenance compatibility、所有阈值和最终 decision。
5. legacy eval 使用单独 `--historical`，只输出描述，不生成 promotion authority。
6. 修复统计输入完整性和阈值预注册。

#### 怎么做

1. `DecisionArtifactV3` 至少包含：
   - schema/policy version；
   - candidate ID、parent Champion digest；
   - plan digest、baseline/candidate artifact digest；
   - derived gate values + reason codes；
   - pre-registered thresholds；
   - repetitions 和长度一致的 per-repetition statistics；
   - decision content digest。
2. 阈值来自运行前 plan/protocol，不从运行后 CLI flag 覆盖。
3. 检查 `perRepetitionDeltas.length === repetitions`；缺失/重复 repetition 为 INVALID。
4. cases=0、pairCount=0、activation eligible=0、unknown provenance 均不得 ACCEPT。
5. 单次 +1、`recommendsRepetition=true` 为 INCONCLUSIVE。
6. dirty/cross-SHA/summary digest 失败为 INVALID。
7. actual security breach、verified regression、不可接受 cost 为 REJECT。
8. human report 完全从 DecisionArtifact 派生，必须显示真实 grade/termination/verification。

#### 怎么验收

1. 当前 AR2 legacy evidence 用 strict eval：INVALID/legacy-not-eligible；不能显示 provenance compatible。
2. V3 artifact 中 grade/verified 有值时 report 不得输出 `?`/0→0。
3. `repetitions=2` 且 per-repetition 为空：INVALID，不是 ACCEPT。
4. 调用者不能构造 `digestValid:true` 直接得到 promotion artifact；公开入口只接受 artifact paths/loaded validated objects。
5. 修改任一 input artifact 后，DecisionArtifact revalidation 失败。
6. threshold 与 plan 不一致时失败。
7. 3 repetitions 方向稳定且达到预注册门槛才可能 ACCEPT。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm test:protocol
pnpm build
git diff --check
```

#### 交付物

- 唯一 V3 champion eval。
- content-addressed DecisionArtifact。
- legacy historical mode。
- current AR2 的正确离线报告。

---

## E3-07 — 修复 promotion 信任边界、跨进程 CAS 和 applied 状态

### Agent 提示词

请修复当前 promotion 仍可伪造、CAS 非原子、promote 直接写 `applied=true` 的问题。当前任何人都能用公开 builder 生成一个 digest 正确的 envelope，decisionEnvelopeDigest/sourceSha 可填任意值；两个并发 CAS 也可同时成功。

#### 做什么

1. 明确威胁模型：content hash 只能保证完整性，不能证明 authority。不得把“可重新计算 SHA-256”称为不可伪造。
2. promotion 必须加载并重验真实 DecisionArtifact、plan、baseline/candidate artifacts，并在 promote 时重新计算 deterministic decision。
3. source/build/parent/candidate/policy/arm identity 必须全部重验。
4. 实现真正跨进程的状态事务；同一 parent 最多一个 writer 成功。
5. promote 只创建 `applicationPending`，不得写 applied=true。
6. state digest 覆盖所有有安全意义的字段，包括 application status。
7. production/release threat model 若要求强 authority，支持外部配置的 CI attestation/public key；私钥绝不能放在仓库。

#### 怎么做

1. 优先简化冗余：PromotionEnvelope 可以成为 DecisionArtifact 的 promotion wrapper，但必须包含 decision artifact path+digest，不只是一个无法验证的 digest 字符串。
2. `generatedBy` 仅作信息，不作信任来源。
3. promote transaction 在锁内完成：
   1. 获取跨进程 lock/transaction；
   2. 读取 current state；
   3. strict load all referenced artifacts；
   4. 重算 provenance、decision、digests；
   5. 验证 current parent；
   6. 写 temp、fsync、atomic rename/transaction commit；
   7. 释放 lock。
4. 可使用安全 lockfile `open(..., "wx")` + PID/timeout/stale recovery，或 SQLite transaction；必须有多进程测试。
5. `writeChampionStateFileCas()` 不能先 compare 后无保护 rename。
6. 删除 `write*` 中强制 `{applied:true}` 的行为。
7. state 状态至少：`promoted/applicationPending/applied/applicationFailed/rolledBack/quarantined`。
8. validity 只有在 E3-06 evidence 全部有效时为 PROVEN；当前 C0 应为 PROVEN，历史 C1 保持 invalid/quarantined。
9. rollback 根据显式 transition IDs/levels 查找，不把 rollback pseudo-record 当 promotion index。

#### 怎么验收

1. decision digest 任意字符串、sourceSha 任意字符串、package.json 作为 candidate artifact：promote 拒绝。
2. builder 生成但没有真实 DecisionArtifact：拒绝。
3. 两个独立 Node 进程基于同一 parent 并发 promote：恰好一个成功。
4. state 的 applied 字段变化会改变 state digest。
5. promote 成功后 status=applicationPending、applied=false。
6. artifact/plan/threshold/source/parent 任一篡改：拒绝。
7. 重复同一有效 transition 幂等，不创建双 history。
8. crash 在 temp write/rename 前后均可恢复到一个完整 state，不出现截断 JSON。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm test:race
git diff --check
```

#### 交付物

- 可重算 promotion transaction。
- 真正跨进程锁/CAS。
- applicationPending 状态语义。
- forged envelope 和并发攻击测试。

---

## E3-08 — 将 validated Champion 真正接入生产 createHarness

### Agent 提示词

请完成 production Champion application。当前 `resolveChampionProfile()` 只被 evaluation tests 和 `config effective` 诊断使用，主 CLI/`createHarness()` 不消费它；测试只是对 ArmFactory snapshot 计算 identity，并没有构造真实 Harness。

#### 做什么

1. 在受支持的生产配置入口增加显式 Champion profile selection。
2. 从 E3-07 validated applicationPending transition 解析真实 ArmFactory 配置并构造 Harness。
3. 运行时从实际组件计算 `RuntimeProfileIdentity`。
4. identity 与 pending transition 完全一致后，单独提交 applied proof；失败则 applicationFailed 或安全回退 C0。
5. 默认仍为 C0；不得隐式读取可篡改的 `docs/evolution/champion-state.json` 控制发布包。
6. 打包后的 CLI/SDK 在没有源码 docs 目录时行为明确且可用。

#### 怎么做

1. 选择可信状态源：显式配置路径、release embedded manifest 或调用方传入 validated profile。说明其权限和生命周期。
2. `createHarness()` 接受 typed resolved profile，而不是 candidate 字符串或任意 config patch。
3. adaptive recovery 使用真实 planner/factory；不得只在 identity 中写 strategy ID。
4. runtime identity 从实际注册的 context/memory/tools/recovery/delegation 组件提取。
5. application proof 包含 state transition ID、actual config digest、strategy IDs、binary/build identity、启动时间和 status。
6. state applied 更新继续使用 E3-07 transaction。
7. `config effective` 调用与生产相同 loader/constructor；禁止诊断走另一套纯函数。

#### 怎么验收

1. 默认 CLI/SDK 启动为 C0。
2. 有效测试 C1 applicationPending 进入 `createHarness()` 后，触发一个可控失败并观察真实 recovery strategy 行为。
3. actual runtime digest 与 pending digest 不同：applicationFailed，不得 applied。
4. quarantined/invalid/stale state 无法启动 C1。
5. promote 后、runtime 启动前 state 仍 applied=false。
6. runtime 行为 proof 成功后才 applied=true。
7. npm/package 构建产物中不依赖源码 docs 路径。
8. 全程 scripted provider，无真实调用。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/harness test
pnpm --filter @harness/cli test
pnpm test:protocol
pnpm build
git diff --check
```

#### 交付物

- production profile source/loader。
- createHarness/CLI/SDK 实际接入。
- behavior-level application proof。
- pending→applied transaction tests。

---

## E3-09 — 实施真正的 benchmark 子进程隔离，而不是事后 sentinel

### Agent 提示词

请把 OS isolation 从“探测和事后发现”升级为“实际执行边界”。当前 benchmark 的 exec 可以写到任意 repo 外绝对路径并最终 PASS；host sentinel 只比较当前 Git repo，既无法阻止效果，也看不到 `/tmp` 或其他目录。E2 测试甚至以“检测到文件已写出”冒充“无法写出”。

#### 做什么

1. 所有 promotion-grade benchmark exec 必须通过实际 sandbox backend 启动。
2. case workspace 为唯一可写区域；host repo、其他 temp、home、secrets 和网络不可访问/不可写。
3. backend probe 必须运行自测，不得因 `unshare --version` 存在就声称 strong isolation。
4. 没有可用 strong backend 时，在 provider 调用前 fail closed。
5. sentinel 仅作为第二道检测和 taint 证据，不再作为 confinement 替代品。
6. 修复跨平台 path flavor 与 symlink/reparse point 语义。

#### 怎么做

1. Linux 优先实现并测试真实 bwrap/container policy，例如：
   - case workspace bind 为 rw；
   - runtime 必要文件只读；
   - host root/home/repo 不挂载或只读；
   - network namespace disabled；
   - env allowlist；
   - PID/resource/time/output limits。
2. `unshare` 只有在实际无特权 self-test 成功后才可标 strong；版本命令成功不够。
3. macOS/Windows 无强 backend 时明确 unsupported；不要伪造跨平台安全。
4. exec tool 的 process spawn 接收已验证 sandbox execution spec，不能让 model 命令绕开 wrapper。
5. self-test 至少尝试：外部绝对写、`..`、symlink、shell redirection、Node/Python interpreter、repo tracked write、secret env、network。
6. backend result 记录到 provenance，包含 backend/policy/self-test digest。
7. insecure local mode 必须显式 `--allow-insecure-local-benchmark`，artifact 永远 promotionEligible=false，并有醒目警告。

#### 怎么验收

1. 真实 benchmark scripted exec 尝试写 workspace 外：命令被拒绝，外部文件不存在。
2. 不能只断言 sentinel=true；核心断言必须是 effect 未发生。
3. host repo tracked/untracked 状态不变。
4. child 看不到未 allowlist secret。
5. network request失败并产生 typed denial。
6. workspace 内正常创建、构建、测试仍成功。
7. backend self-test 失败时 preflight providerCalls=0。
8. Linux/Windows/POSIX path tests使用目标 flavor；CI matrix 至少验证 Linux，其他平台按 support policy 断言。

运行：

```bash
pnpm typecheck
pnpm --filter @harness/tools test
pnpm --filter @harness/evaluation test
pnpm --filter @harness/cli test
pnpm test:security
pnpm test:chaos
git diff --check
```

#### 交付物

- 实际 sandbox execution backend。
- capability self-test 与 provenance identity。
- effect-prevention attack suite。
- unsupported/insecure mode policy。

---

## E3-10 — 把 same-T 状态机真正接入 SessionActor 并持久化

### Agent 提示词

请修复 `SessionActor` 的真实 recovery 流程。当前虽然导入了 recovery state machine，但 actor 每次创建新的内存 record，把所有 handler failure 传为 `retryable:false`，立即 TERMINAL_FAILED；recoverable turn 已经从数组 shift，随后继续 drain T2。纯状态机测试通过不代表 actor 满足 same-T bounded retry。

#### 做什么

1. recovery record 持久化到 durable store，与 Turn/prompt lineage 绑定。
2. T1 未 RECOVERED/EXHAUSTED/TERMINAL_FAILED 前，不从 queue head 移除。
3. retryable handler failure 对同一 T 按 policy 有界重试和退避。
4. 使用注入 scheduler/manual clock；禁止 `void this.drainFollowups()` 递归热循环。
5. 进程重启后从 attempt/nextAttemptAt 继续，不重置预算。
6. exhaustion policy 明确决定是否 dead-letter 后允许 T2；不能把第一次 crash 当 exhaustion。

#### 怎么做

1. 将 `_recoverableTurns.shift()` 改为 peek/leased head；只有 terminal transition 完成并持久化后才 dequeue。
2. recovery record 至少持久化：taskId、promptId、lineage、state、attempt、max、nextAttemptAt、last typed error、policy version、lease owner/expiry。
3. 定义 retryable classification：transport/infrastructure crash 与业务 terminal failure分开。
4. scheduler 到期后再次运行同一个 `turn.id`。T2 仍在后面。
5. handler success、failure、consume prompt、advance queue 的持久化顺序必须可恢复且幂等。
6. 所有 async continuation 有 owner/single-flight guard；错误进入 event/store，不只 stderr。
7. 删除测试中“为了 liveness，T1 crash 后 T2 应成功”的旧断言，替换为计划要求。
8. Runtime Freeze 说明明确引用本次可复现 correctness defect。

#### 怎么验收

1. T1 attempt1 crash、backoff、attempt2 success，然后才运行 T2；真实 SessionActor event trace 精确匹配。
2. backoff 未到时 T2 不运行且无热循环。
3. T1 到 max attempts 后进入 EXHAUSTED；是否继续 T2由 explicit policy 测试。
4. actor 在 attempt1 后重启，仍从 attempt2 继续同一 T。
5. 两个 actor/重复 completion 不造成双执行。
6. `_recoverableTurns`/durable queue 中 T1 不会在非终态丢失。
7. 不再出现“attempt 1/3 直接 TERMINAL_FAILED 后 T2继续”的日志行为。

运行：

```bash
pnpm typecheck
pnpm vitest run packages/core/src/runtime/recovery-state-machine.test.ts packages/core/src/runtime/followup-recovery.test.ts packages/core/src/runtime/session-actor.test.ts
pnpm test:protocol
pnpm test:race
pnpm test:chaos
git diff --check
```

#### 交付物

- durable recovery store/state integration。
- real actor same-T tests。
- restart/backoff/idempotency evidence。

---

## E3-11 — 建立真正的单一事实源、GateEvidence consumer 和可生成 handoff

### Agent 提示词

请修复文档和 release evidence 链。当前 `docs:verify` 会在 E2 handoff Markdown 含 PowerShell 插值残片、subject HEAD 过期、worktreeClean=false 时仍 PASS；GateEvidenceV2 只有模块/测试，release verify 不消费它，当前所有 gates 都 NOT_RUN。

#### 做什么

1. 用跨平台 Node 生成器从机器数据生成 handoff Markdown，不再使用 PowerShell 对象插值。
2. EvolutionLedger verifier 同时校验 Champion state、DecisionArtifact、handoff subject、artifact refs 和 gate evidence。
3. capability/free gate runner 真实生成 GateEvidenceV2。
4. release verify strict 消费 GateEvidenceV2 并验证 HEAD/tree、command、exit、input/output digest、clean before/after。
5. 解决“把 current HEAD 写进 tracked 文件后提交会再次改变 HEAD”的自引用问题。
6. paid gate 未授权时显示 BLOCKED，不是假 PASS；是否允许 release 由明确 policy 决定。

#### 怎么做

1. 对 committed handoff 使用 `subjectSha`/`subjectTreeDigest`，明确它审查的是哪个代码树；或将最终 gate evidence 保存为 CI artifact/Git note，而非同一被测 commit 内的 tracked file。
2. docs verifier 必须 parse JSON/Markdown模板并检查：
   - 不含 `$(@{`、`System.Object[]` 等生成残片；
   - subject 与 evidence 一致；
   - active Champion 与实际 state 一致；
   - state validity/application status 一致；
   - residual risks 与 gate status 不矛盾。
3. ledger `activeChampion` 单对象存在并不等于“唯一”；应与 transition history 和 state 文件交叉验证。
4. GateEvidence runner 执行命令、捕获 stdout/stderr/exit、Git state、输入输出 digest；禁止手填 PASS。
5. release verify 对当前 subject 缺证据时明确 FAIL/NOT_RUN。
6. capability audit 默认继续无 tracked side effect；`--write` 显式。
7. generation/verification 命令重复运行应稳定，不产生无意义 timestamp diff；时间元数据放 evidence envelope 或非 tracked artifact。

#### 怎么验收

1. 把 handoff 加入 `$(@{...})`：docs verify 失败。
2. handoff subject、Champion state、ledger active 任一不一致：失败。
3. 当前 HEAD 的真实 gate runner 生成 typecheck/build/test/docs等 evidence；release verify 消费并重验。
4. 篡改 exitCode、command、SHA、output digest：失败。
5. default capability audit 前后 `git status` 与 matrix hashes 不变。
6. full test失败时 handoff不能声称 PASS。
7. E3-14 未授权准确显示 BLOCKED；不触发 provider。

运行：

```bash
pnpm typecheck
pnpm docs:verify
pnpm capability:audit
pnpm release:verify
git status --short
git diff --check
```

#### 交付物

- Node handoff generator。
- 跨文件 truth verifier。
- 真实 GateEvidence runner/consumer。
- 自引用安全的 evidence 存储策略。

---

## E3-12 — 删除影子实现与旧晋级权限，建立 production usage 审计

### Agent 提示词

请在真实 E3 pipeline 接入后收敛重复代码。当前 E1/E2 同名概念并存，容易让 Agent 修了新模块却继续执行旧 consumer。目标是每个关键职责只有一个 promotion-grade 实现，legacy 路径明确只读。

#### 做什么

1. 列出 artifact/provenance/activation/security/paired eval/decision/promotion/profile 的所有实现和 consumer。
2. 删除或降级旧 E1 promotion path。
3. `champion eval --strict`、`champion promote`、benchmark experiment、release verify 只能调用 E3 canonical orchestrator。
4. legacy loader/report 保留历史查看，但类型上不能产生 promotion authority。
5. 增加 production usage/architecture tests，验证模块不是只被 tests/export index 引用。

#### 怎么做

1. 重点处理：
   - `loadRunsFromArtifact()` strict 晋级用途；
   - `provenance-v2` / `judgePairComparability`；
   - E1 `activationEvidenceFor()`；
   - string `security-taxonomy`；
   - `runRepeatedBaseline()` promotion 用途；
   - CLI `evaluateChampionDecision()`；
   - 只导出不消费的 E2 模块。
2. 历史模式返回 `HistoricalEvaluation`，其类型不包含 `promotionEligible:true` 或 promotion envelope builder 输入。
3. 建立一个真实 `ExperimentOrchestrator`/service 作为 CLI 入口；不要让 CLI 自己拼接若干真假 gate。
4. architecture test 应调用实际入口并观察依赖注入/事件，不要只 `readFile().toContain()`。
5. 删除误导注释，例如“single source”但真实 consumer 未使用、“cannot write”但只检测。
6. 清理 duplicate schema、enum 和策略版本，提供迁移说明。

#### 怎么验收

1. production usage matrix 中每个 canonical module至少有一个非测试 consumer。
2. `rg` 不再发现 strict CLI 使用 V2 comparability/legacy loader。
3. legacy artifact 无法传给 promote builder（编译时和运行时都失败）。
4. 删除一个 canonical dependency会使真实 CLI integration test失败，而不只是单元测试。
5. 所有注释与实际行为一致。

运行：

```bash
pnpm typecheck
pnpm test
pnpm test:protocol
pnpm test:security
pnpm build
git diff --check
```

#### 交付物

- 实现/consumer usage matrix。
- canonical orchestrator。
- legacy read-only边界与迁移说明。
- 删除的 shadow code 清单。

---

## E3-13 — 建立真正离线端到端实验、晋级、应用与攻击测试

### Agent 提示词

请重写 E2 final integration tests，使其真正穿过 production path。当前测试手工构造 decision booleans、只生成 candidate artifact、不执行 baseline/candidate、自己生成 envelope、对纯 profile 算 identity；隔离测试还明确创建了逃逸文件。新的 E2/E3 final test 必须从真实 CLI/runner开始，不能手填中间结论。

#### 做什么

1. 建立 counting scripted provider 的完整 offline paired experiment。
2. 真实流程：CLI preflight → paired executor → actual ArmFactory → runtime → V3 writer → strict loader/provenance → typed activation/security → decision artifact → promotion transaction → createHarness application proof。
3. 真实执行 adversarial regressions。
4. 明确 provider/logical/model-call counts。
5. 没有强 sandbox 的 CI 环境，隔离 promotion test 应正确 fail closed；具备 backend 时跑真实 prevention test。

#### 怎么做

1. fixture 至少含：
   - 一个 candidate 应赢的 recovery case；
   - 一个双方 tie case；
   - 一个安全攻击 case；
   - 一个 memory eligibility case；
   - 一个需要多 model calls 的 case，用于 call budget。
2. baseline/candidate outcome 由 scripted model responses 和真实 verification 产生，不能直接写 passed=true。
3. activation由真实 runtime event产生，security由真实 deny/effect产生。
4. decision thresholds 来自预先写入 plan。
5. promotion 使用真实 state transaction 和临时可信 state source。
6. application 必须创建真实 Harness并触发策略行为。
7. adversarial cases：
   - dirty/cross-SHA/unknown provenance；
   - summary/artifact tamper；
   - forged decision/envelope；
   - concurrent promote；
   - exec escape；
   - T1 recovery crash；
   - stale/invalid Champion；
   - cost/call cap。
8. 测试名称、注释、断言必须一致。

#### 怎么验收

1. happy path 中每个中间 artifact 都由上一 production stage 产生。
2. 测试不调用 `decideChampionV3({ comparable:true, ... })` 这种手填入口。
3. happy path exact logical runs/model calls 与 plan一致。
4. forged promotion 被拒绝；并发只有一个 writer成功。
5. exec外部文件不存在。
6. T1 attempt2成功前T2无事件。
7. createHarness actual identity/behavior与applied proof一致。
8. 真实 provider calls=0。

运行：

```bash
pnpm typecheck
pnpm vitest run packages/evaluation/src/e3-final-integration.test.ts
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm build
git diff --check
```

#### 交付物

- production-path E3 final integration suite。
- exact call/event traces。
- adversarial evidence bundle。

---

## E3-14 — 仅在用户明确授权后执行 AR2 正式复测

### Agent 提示词

此任务默认状态必须是 `BLOCKED_AWAITING_OPERATOR_AUTHORIZATION`。没有用户在当前会话明确同意费用时，只能运行真实 E3 CLI 的 dry-run，provider 调用数必须为 0。不能把历史静态 `e2-15-dry-run.json` 当成本次 preflight。

#### 做什么

1. 使用当前 clean code subject 和 E3 canonical pipeline生成 fresh plan。
2. baseline/candidate 同源同构建、同一 paired plan。
3. 使用真实 strong isolation self-test。
4. 输出最大 logical runs、model calls、tokens、cost，而不是假定每 arm 只有一次 model call。
5. 获得操作者确认 plan digest 后才执行。
6. 执行后生成 V3 artifacts 和 DecisionArtifact，不自动 promote。

#### 怎么做

1. 先运行：

```bash
node apps/cli/dist/main.js benchmark experiment \
  --candidate adaptive_recovery_v2 \
  --suite holdout \
  --repeat 3 \
  --dry-run --json
```

2. 检查 E3-14 前置条件：所有免费 gates、candidate readiness、eligible cases、source clean、sandbox、call/cost limits。
3. 把 plan JSON 和 digest交给用户确认。没有确认立即停止。
4. 确认后才临时设置 `RUN_PAID_BENCHMARKS=1` 并传入相同 plan digest。
5. 中断使用 resume，不更改阈值/cases/repetitions。
6. 完成后 strict validate/eval；decision 可以是 ACCEPT/REJECT/INCONCLUSIVE/INVALID。
7. ACCEPT 也不自动运行 promote。

#### 怎么验收

执行前：

1. 未授权 provider calls=0。
2. API key存在但无开关/plan确认，calls=0。
3. dry-run source/build/plan/sandbox/readiness均为当前真实值，不是字符串占位符 `digest(url)`。
4. estimated model calls来自历史/上限模型，不是假定1 call/arm。

执行后（仅授权时）：

1. 每个 pair A/B完整。
2. AB/BA actual sequence与plan一致。
3. V3 integrity/provenance/activation/security全通过。
4. 单次小幅+1不能ACCEPT。
5. 输出actual vs estimated calls/tokens/cost。
6. Champion state未自动变化。

#### 交付物

- fresh preflight/plan JSON。
- 用户授权记录（不存secret）。
- 若执行：V3 artifacts、DecisionArtifact、费用报告。
- 若未授权：明确 BLOCKED，真实调用0。

---

## E3-15 — 最终全门禁、truth audit 与交接

### Agent 提示词

请完成 E3 最终验收。该任务不执行真实付费 benchmark；E3-14 未授权时可以保持 BLOCKED，但其他免费门禁必须真实通过。最终目标不是“测试数很多”，而是证明所有关键 production consumers 已切换到 E3 canonical path。

#### 做什么

1. 运行完整免费门禁。
2. 运行 R-01～R-12 修复后 regression，全部从 REPRODUCED 变为 FIXED。
3. 验证 production usage matrix、Champion C0状态、无真实provider调用、无tracked副作用。
4. 生成机器 E3 handoff/evidence bundle 和派生 Markdown。
5. 记录 residual risks 和 E3-14 状态。

#### 怎么做

1. gate evidence绑定 subject tree/commit，遵循 E3-11 的非自引用策略。
2. final handoff 至少包含：
   - subject identity/clean status；
   - command/exit/count/duration；
   - schema/policy versions；
   - production usage matrix；
   - active/pending/applied Champion；
   - paid authorization/calls；
   - isolation backend self-test；
   - residual risks。
3. 对所有 tracked evidence refs重算 digest。
4. 重新执行 forged envelope、CAS race、exec escape、same-T crash、unknown provenance、summary tamper攻击。
5. release verify必须消费本次真实 gate evidence。

#### 怎么验收

运行并记录：

```bash
git status --short
git rev-parse HEAD
pnpm typecheck
pnpm build
pnpm test
pnpm test:coverage
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos
pnpm benchmark:smoke
pnpm docs:verify
pnpm capability:audit
pnpm release:verify
pnpm e3:verify-production-usage
pnpm e3:verify-invariants
git diff --check
git status --short
```

最终必须满足：

1. full test和coverage不再有E2 isolation失败。
2. capability audit默认无tracked副作用。
3. release verify对免费gates有当前真实evidence；付费gate按policy BLOCKED而非伪PASS。
4. strict benchmark/champion不再引用V2/legacy promotion path。
5. forged envelope拒绝。
6. CAS并发恰好一个成功。
7. exec escape effect未发生。
8. same-T真实actor顺序正确。
9. production createHarness actual Champion application可证明。
10. E3-14未授权时真实provider calls=0。
11. active Champion在没有新有效ACCEPT时保持C0/PROVEN。
12. handoff无插值残片、过期状态或互相矛盾数字。

#### 交付物

- `e3-handoff.json` 机器证据。
- 派生 `e3-handoff.md`。
- GateEvidence bundle。
- production usage matrix。
- 最终允许/禁止 promotion 和 release 的明确结论。

---

## 6. E3 完成后的强不变量

1. 真实 benchmark 命令在任何错误或未授权条件下，provider generate 调用数为 0。
2. `repeat=N` 的 logical runs 精确等于 `cases × repetitions × 2 arms`。
3. BA 不只是标签；candidate 确实先于 baseline 执行。
4. ArmFactory 的 actual config 直接构造 Harness，未声明 delta 无法绕过。
5. production writer 输出 V3，strict eval 不再依赖 legacy loader。
6. required provenance unknown 即不可晋级。
7. summary/manifest/activation/security/protocol 任一篡改都会失败。
8. decision 是从 artifacts 派生，不接受手填 gate booleans。
9. content digest 不被误称为 authority；promotion 会重算 decision 或验证可信 attestation。
10. 两个并发 promote 不能同时成功。
11. promote 不等于 applied；只有真实 createHarness 行为证明后才 applied。
12. benchmark 子进程无法在 case workspace 外产生效果。
13. T1未完成有界恢复前T2不能越过。
14. readiness来自实际事件/cases，不来自手工true/false。
15. docs、ledger、state、gate evidence由同一机器事实交叉验证。
16. 没有明确费用授权时，真实provider调用永远为0。

---

## 7. 建议提交切分

1. `E3-00: record truthful review baseline and fix path test semantics`
2. `E3-01: enforce paid guard and preflight in real benchmark CLI`
3. `E3-02: execute deterministic paired plans without N+1`
4. `E3-03: construct real harness arms from one factory`
5. `E3-04: write and validate canonical experiment artifacts`
6. `E3-05: capture activation and security from runtime events`
7. `E3-06: derive champion decisions from strict artifacts`
8. `E3-07: harden promotion authority and state transaction`
9. `E3-08: apply validated champion in production harness`
10. `E3-09: enforce benchmark subprocess confinement`
11. `E3-10: persist and integrate same-task bounded recovery`
12. `E3-11: generate truthful handoff and gate evidence`
13. `E3-12: remove shadow promotion paths`
14. `E3-13: add production-path offline integration attacks`
15. `E3-14: run authorized AR2 reevaluation`（仅用户授权后）
16. `E3-15: finalize E3 gates and handoff`

每个提交必须同时包含其行为测试。不要先提交一批“接口/类型”，再把真实接线推迟到最后。

---

## 8. Agent 统一回复模板

```text
Task: E3-xx
Status: DONE | PARTIAL | BLOCKED
Baseline subject:
Final subject / worktree state:

Real production entry changed:
- CLI/runtime/writer/loader/consumer path

Implemented:
- ...

Old shadow path removed or downgraded:
- ...

Behavioral invariants proven:
- ...

Exact tests:
- command -> exit code, test counts

Provider accounting:
- real provider calls: 0 unless E3-14 authorized
- fake provider logical runs/model calls: ...

Evidence:
- path -> digest -> purpose

Residual risks:
- ...

Files changed:
- ...

Recommended next task:
- E3-xx
```

如果只能证明一个纯函数，而真实 consumer 尚未切换，状态必须写 `PARTIAL`，不能写 `DONE`。

---

## 9. 当前正式处置建议

- 保留 E2 全部提交和历史 evidence，不重写历史。
- 当前 C0 继续作为唯一 active production baseline，并把 validity 修正为 PROVEN。
- 历史 AR2 C1 保持 `INVALID_PROVENANCE / QUARANTINED_HISTORY`。
- 当前禁止 promotion，因为真实 strict eval、promotion authority、runtime application、isolation 尚未闭合。
- 当前禁止 release，因为 full test、coverage、capability evidence 和 release evidence 未通过。
- 当前禁止真实 benchmark，因为真实 CLI 尚无已接入的 paid guard 和强 isolation。
- 先完成 E3-00～E3-13；再由用户决定是否授权 E3-14。
