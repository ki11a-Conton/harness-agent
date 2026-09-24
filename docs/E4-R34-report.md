# E4-R34 Report — 隔离故意失败的测试夹具并收敛验收噪声（H04）

- reviewedSourceSha（计划基线）：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- testedSourceSha：**dirty worktree on `bcf3f42c`**（本轮 R32/R33/R34 改动未提交；被测即工作树源码 + 重建 dist）
- 状态：**PASS**（确定性隔离 + 判别性证据 + 回归；两个"波动断言"经重复实测判为 NOT_REPRODUCED）
- 真实模型调用：0（全部离线；子进程为 scripted provider + 真实 CLI 路径）
- 变更文件：
  - `apps/cli/src/e4-r24-final-result-protocol.test.ts`（夹具目录/专用配置/断言强化）
  - `apps/cli/test-infra/observation-vitest.config.ts`（新增，子进程专用配置）
  - `apps/cli/test-infra/observation-fixtures/.gitkeep`（新增，占位）
  - `.gitignore`（新增新夹具目录忽略规则）

## 1. 问题与范围

H04（P2）：`apps/cli/src/e4-r24-final-result-protocol.test.ts` 会生成**故意失败**的
`e4-r24-fixture-*.test.ts` 到 `apps/cli/src/`，而该路径落在**根 vitest `include`**
（`apps/*/src/**/*.test.ts`）范围内。若父测试的 `finally` 清理被打断（例如被沙箱
safe-delete shim 拒绝、进程被杀），残留夹具会被**下一次全量运行当作真实测试收集**并
报失败 —— 是验收噪声，不是产品缺陷。

范围声明：证明的是**验收夹具与根收集范围之间的结构性隔离**，不声称一个残留夹具会改变
产品行为；产品代码未改动。

## 2. 复现（修复前的真实表现，确定）

E4-R31 全量运行（`/tmp/full-test-r31.log`，shim 生效、未清理残留）实测：

```text
× proto capability chain                                       <- 残留夹具被当真实测试收集
FAIL  apps/cli/src/e4-r24-fixture-19408-1789176916973-hook-fail.test.ts > observing-suite
FAIL  apps/cli/src/e4-r24-fixture-19408-1789176916973-hook-fail.test.ts > hook-fail-suite
 Test Files  4 failed | 314 passed (318)
      Tests  8 failed | 5712 passed | 1 skipped (5721)
```

清理 shim + 删除 5 个残留夹具后（`/tmp/full-test-r31b.log`）降为仅 4 个 e4-09 干净树门禁
失败 —— 证明 H04 的失败**完全由残留夹具贡献**，与产品无关。

**判别性证据（旧位置 vs 新位置）**：把一个失败夹具放到**旧位置**，根配置会收集它：

```text
$ node node_modules/vitest/vitest.mjs list --config vitest.config.ts "e4-r24"
apps/cli/src/e4-r24-final-result-protocol.test.ts > ...（父测试，正例）
apps/cli/src/e4-r24-fixture-oldloc-probe.test.ts > old-location probe   <- 旧位置被根配置收集（缺陷）
```

而新位置（`apps/cli/test-infra/observation-fixtures/`）**不出现在根配置的收集结果里**
（由 R34 测试断言 `rootList` 不含该夹具、`fixtureList` 含该夹具）。

## 3. 根因与修改点

| # | 位置 | 缺陷 |
|---|---|---|
| 1 | 夹具写盘路径 = `apps/cli/src/` | 落在根 vitest `include` 内，残留即被收集 |
| 2 | 子进程用**根配置**跑夹具 | 根配置同时收集整个仓库 → 父子互相污染 |
| 3 | 子进程结果只断言退出码 / stderr 摘要 | "0 测试被实际执行 / reporter 未接线"也可能假通过 |

修复（结构性隔离，不改产品代码）：

1. **夹具目录移出根 include**：`apps/cli/src/` → `apps/cli/test-infra/observation-fixtures/`
   （路径无 `src` 段 → 根 `include` 不命中；且在 `apps/cli/tsconfig.json` 的 `include:["src"]`
   之外 → 残留夹具也永不破坏 `tsc -b`）。
2. **子进程改用专用配置** `apps/cli/test-infra/observation-vitest.config.ts`：`root` 指向仓库根，
   `include` **仅**夹具目录，并保留**生产 reporter**（`./apps/cli/test-infra/observation-vitest-reporter.ts`）
   —— 子进程仍走真实 final-result 提交路径，不是 mock-reporter 捷径。
3. **夹具源码 import 改相对路径** `../../src/observation-evidence.js`；`testFile` 记为夹具相对路径。
4. **断言强化**：对三类子进程结果同时断言
   - 退出码（green=0；assert-fail/hook-fail≠0）；
   - **实际执行测试数**（`ranTestCount` 解析 vitest 摘要，先剥离 ANSI 色码，green=1 / assert-fail=1 / hook-fail=2）；
   - evidence 摘要（`committed N row(s), dropped M candidate(s)`）与独立 `runUsageAudit` 结论。
   这样"0 测试被跑 / reporter 未接线"不再可能假通过。
5. **清理只删自己指向的文件**，并由新测试断言"同目录 sibling 文件不被误删"。
6. **`.gitignore`** 增加 `apps/cli/test-infra/observation-fixtures/*.test.ts`，使被打断的清理
   残留也不会被提交。
7. **并发稳健性**：隔离测试对**专用配置**的收集列表按**本进程自己的夹具名**过滤
   （`listCollectedFiles(FIXTURE_CONFIG, mineName)`）。当两个 `apps/cli` 套件**并发**跑、共享同一
   夹具目录时，不加过滤的 `vitest list` 会在 A 列目录的同时导入 B 正在删除的夹具 →
   `ERR_MODULE_NOT_FOUND`，使断言取不到自己的文件名（实测在"双份 `apps/cli` 并行"下复现）。
   根配置侧的正例/负例仍用整目录列表（根 `include` 不覆盖夹具目录，不受影响）。

## 4. 验收（真实命令 / 结果）

| 检查 | 命令 | 结果 |
|---|---|---|
| R34 全套 | `vitest run apps/cli/src/e4-r24-final-result-protocol.test.ts` | **4 passed (4)** |
| 其中 green | 同上 | ✓ 提交恰好 1 行；独立 strict audit 观测到能力；`ranTestCount=1` |
| 其中 assert-fail | 同上 | ✓ 0 行提交、丢 1 候选；本 run 不可观测（内联 runId）；`ranTestCount=1` |
| 其中 hook-fail | 同上 | ✓ 体 pass + afterAll 失败 → 0 行提交、丢 2 候选；`ranTestCount=2` |
| 隔离（H04） | 同上 | ✓ 残留夹具不被根配置收集、被专用配置选中；清理只删自身 |
| 并发稳健 | 双份 `apps/cli` **并行** × 2 轮 | ✓ 隔离测试在共享夹具目录下不再互相干扰（仅 e4-09 干净树门禁失败） |
| 类型检查 | `tsc -b` | **exit 0** |
| benchmark 回归 | `vitest run apps/cli/src/benchmark-command.test.ts` × 3 | **66/66** 全绿 |

## 5. 两个"波动断言"的有限归因

计划要求对 `finalizedPairs 4→3` 与 `E4-09 promotionEligible true→false` 做有限归因，证据不足标
NOT_REPRODUCED。

### 5.1 `E4-09 promotionEligible true→false` —— 已归因（干净树门禁）

`apps/cli/src/e4-09-production-e2e.test.ts:166` 先断言 `res.exitCode === 0`；`:179`
才断言 `candV3.manifest.promotionEligible === true`。该运行是 **promotion-eligible**
（probe 被 mock 为 strong isolation），因此受 `apps/cli/src/benchmark-command.ts:665`
的**干净树门禁**（`promotionEligibleRun && !executionSource.clean`）约束：

- 工作树**脏**（有未提交改动）→ CLI 退出 1 → 断言在 :166 即失败，`promotionEligible` 永不达 true；
- 工作树**干净** → 门禁通过，`promotionEligible=true`。

已用生产函数 `probeSourceSnapshot` 直测证明：当前脏 cwd → `clean:false`；干净临时仓库 →
`clean:true, treeFingerprint:null`。**结论：非产品缺陷，是"未提交 → 工作树脏"的确定性结果**，
提交后（R35 干净树 E2E）即应消失。

### 5.2 `finalizedPairs 4→3` —— NOT_REPRODUCED

`apps/cli/src/benchmark-command.test.ts:1068`（`--repeat 2 on 2 cases → finalizedPairs.length === 4`）。
固定夹具 `verification:[{kind:"command",command:"echo ok"}]` 会真实执行一条命令，
**理论上**若该命令瞬时失败，对应 pair 就不会 finalize（4→3）。但实测无法复现：

| 观测 | 次数 | 结果 |
|---|---|---|
| 单测 `-t "3. --repeat 2 on 2 cases"` 顺序 | 10 | 10/10 `1 passed` |
| 整文件 `benchmark-command.test.ts` | 3 | 3/3 `66 passed` |
| 单测并行 6 份（制造竞争） | 6 | 6/6 `1 passed` |
| 历史全量日志（r31 / r31b） | 2 | 0 次出现该断言失败 |

**结论：NOT_REPRODUCED**（19 次观测零波动）。受限假设已记录（真实 `command` 验证在极端资源
竞争下可能瞬时失败），但**无证据**，故不声称已修复、不修改相关断言。

### 5.3 额外发现：`prevents cross-case contamination`（benchmark-command.test.ts:283）—— 间歇性，非本计划改动引入

在做 R34 回归（整包 `apps/cli`）时**额外**观测到一次 `benchmark-command.test.ts >
prevents cross-case contamination: case B cannot read case A's workspace file` 失败
（`expected { task_id: 'b', … } to match object { task_id: 'b', success: true }`，即 `success:false`）。
该断言**不在** H04 范围，但必须诚实记录：

| 观测条件 | 次数 | cross-case 失败 |
|---|---|---|
| 单测隔离 `-t "prevents cross-case contamination"` | 5 | **0** |
| 整文件 `benchmark-command.test.ts` | 8 | **0** |
| 整包 `apps/cli`（顺序） | 6 | **1** |
| 历史全量日志（r31 / r31b） | 2 | **0** |

**结论：环境相关的间歇性失败（约 1/6，仅在整包高并发下出现），隔离/整文件下不可复现。**
归因假设 = 资源竞争：该用例做真实文件 I/O + 真实 session runtime 的**只读工具自动重试**，
在高并发（含 e4-r24 子进程再起嵌套 vitest）下某步超时/失败即 `success:false`。
**与 R32/R33 无因果**：R32 改动全部位于恢复存储**故障**路径（健康运行时行为逐字节不变，
见 §3 与 `session-actor.ts` diff），R33 仅改 `execution-plan.ts` 的**解析**（本用例走
`buildBenchmarkExecutionPlan`，不经该 parser）。若 CI 复现，需补确定性注入后再归因。

## 6. 残余限制

- 隔离证明的是**当前 commit 的工作树**；干净树 E2E 归 R35 处理。
- 5.2 的 NOT_REPRODUCED 只说明**本机、本轮**未复现；不排除 CI 或其他平台在极端竞争下出现，
  如未来出现应补最小可复现（重复运行 + 强制验证命令失败注入）后再归因。
- 5.3 的间歇性失败**未定位到根因**（仅给出资源竞争假设与"非 R32/R33 引入"的排除证据）；
  如 CI 复现应按该用例的只读重试路径补最小可复现。
- 子进程专用配置**不参与 `tsc -b`**（在 `apps/cli/tsconfig.json` 的 `src` 之外）——这是有意的，
  与新夹具"永不破坏类型检查"一致；代价是配置本身不被类型检查覆盖。
