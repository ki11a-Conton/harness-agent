# E4-R37 Report — 升级后不再收集旧目录的故意失败夹具（J02）

- reviewedSourceSha（本计划基线）：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- testedSourceSha：**dirty worktree on `a7950fa1`**（本轮 R36+R37 改动未提交；被测即工作树源码）
- 状态：**PASS**（先证明根配置确实收集旧残留 → 结构性排除 → 正负对照 + 判别性回退验证）
- 真实模型调用：0
- 变更文件：
  - `vitest.config.ts`（根收集边界）
  - `apps/cli/src/e4-r24-final-result-protocol.test.ts`（helper 返回退出码 + 新增 R37 用例，共 **5** 例）

## 1. 问题与范围

R34 只迁移了**新生成**的夹具（`apps/cli/test-infra/observation-fixtures/`，位于根 `include` 之外）。**旧版本**遗留在 `apps/cli/src/e4-r24-fixture-*.test.ts` 的故意失败夹具仍落在根 `include: apps/*/src/**/*.test.ts` 内。

关键区分：**`.gitignore` ≠ Vitest `exclude`**。`.gitignore` 第 32 行确实忽略了该模式，所以工作树保持干净（`git status` 看不出来），但 Vitest 仍会**收集**它 → 一次正式全量运行会把它当作真实失败（本计划第 1.2 节实测：318 files / 5730 passed **1 failed**，唯一失败即旧位置残留的断言）。

要求：让**从旧版本升级**的工作区即使保留历史夹具，也得到正确的正式测试集合——不要求用户每轮手工删除。

## 2. 复现（修复前，确定性）

```text
$ printf 'import { it, expect } …expect(1).toBe(2)…' > apps/cli/src/e4-r24-fixture-probe-legacy.test.ts
$ git status --short
 M packages/core/src/runtime/recovery-durable.test.ts      ← 探针文件不出现在 git status（被 gitignore）
 M packages/core/src/runtime/session-actor.ts
…

$ env -u NODE_OPTIONS npx vitest list --config vitest.config.ts "e4-r24-fixture-probe-legacy"
apps/cli/src/e4-r24-fixture-probe-legacy.test.ts > legacy leftover must not be collected   ← 被 ROOT 配置收集
LIST_EXIT=0
```

修复后同一条命令输出为空（退出码仍为 0，说明是**配置加载成功且未选中**，而非配置损坏）。

## 3. 根因与修改点

### 3.1 `vitest.config.ts` —— 窄范围的结构性排除

```diff
-import { defineConfig } from "vitest/config";
+import { configDefaults, defineConfig } from "vitest/config";
…
     include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
+    // E4-R37 (J02): 升级后的工作区可能仍带旧代 e4-r24-fixture-*.test.ts 残留；
+    // gitignore 不能阻止 Vitest 收集它 ⇒ 在此结构性排除（仅按生成文件名模式）。
+    exclude: [...configDefaults.exclude, "apps/cli/src/e4-r24-fixture-*.test.ts"],
```

| 设计点 | 取值 | 理由 |
|---|---|---|
| 模式范围 | 仅 `apps/cli/src/e4-r24-fixture-*.test.ts` | 生成名唯一，**不**排除全部 `e4-r24`、全部 `apps/cli`、正式协议测试或 security/coverage 范围 |
| 默认排除 | 显式展开 `...configDefaults.exclude` | 自定义 `exclude` 会**替换**框架默认值；已实测本机 vitest 4.1.10 的 `configDefaults.exclude = ["**/node_modules/**", "**/.git/**"]` 并原样保留 |
| 清理脚本 | **无** | 不在生产启动或测试前加宽范围清理；残留存在时验收即可通过 |

### 3.2 `apps/cli/src/e4-r24-final-result-protocol.test.ts`

| 变更 | 说明 |
|---|---|
| `listCollectedFiles()` | 返回 `{ code, output }`——**配置加载失败也会打印「没有测试」，必须检查退出码**，不能把「收集为空」与「收集命令坏掉」混为一谈 |
| `runTargeted()`（新增） | 用根配置**显式指名**一个路径运行，证明残留即使被点名也跑不起来 |
| 新增 `E4-R37 (J02)` describe | 旧残留 + 新残留 + 正式父测试三者同时在磁盘上的正负对照（见第 4 节） |

## 4. 验收对照

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| 旧目录故意失败文件仍在磁盘上，根配置不再收集它；正式父协议测试仍被收集 | ✅ | **R37**：断言前 `readFile(legacy)` 含 "legacy residue"；根 `list`（filter `e4-r24`）`code===0`、**包含** `apps/cli/src/e4-r24-final-result-protocol.test.ts`、**不包含** `legacyName` |
| 新目录残留继续不被根配置收集；专用配置确实运行指定夹具 | ✅ | **R37**：根 `list` 不含 `modernName`；专用 `FIXTURE_CONFIG` 的 `list`（filter `modernName`）`code===0` 且包含 `test-infra/observation-fixtures/<modernName>`，且**不含**旧目录同名文件路径 |
| green 真正执行且提交观察；assert-fail / hook-fail 真正执行且拒绝伪 PASS；断言实际测试数量与 evidence | ✅ | 协议三例（未改动逻辑）：`ranTestCount` 分别 `1 / 1 / 2`；stderr 分别为 `committed 1 row(s)` / `committed 0 row(s), dropped 1` / `committed 0 row(s), dropped 2`；`loadObservationEvidence` 行数 `1 / 0 / 0`；独立 `runUsageAudit` 结论 `observed true / false / false` |
| 运行同一组测试第二次不因旧生成物增加正式测试数或失败数 | ✅ | **R37** 的 `rootListAgain.output === rootList.output`（不可变性）；另见第 5 节的**全局收集集合对比**：有无该规则时收集的测试点数量**均为 5755**，逐行排序后差异仅为含 PID 的 node 警告行 |
| 排除规则不屏蔽业务测试、security tests 或 coverage 中的业务源码 | ✅ | 全局 `vitest list`：有/无该排除均 **5755** 个测试点、`code===0`；`coverage.include`（8 个关键包）与 `coverage.exclude` 未改动 |
| cleanup 只处理本次生成物，其他文件保持不变 | ✅ | **R37** finally：仅 `rm` 自己创建的 legacy/modern；sibling 断言内容仍在（"sibling file owned by another actor"）后才删除。**R34** 用例保持原有「只删自己被指向的文件」断言 |
| 运行 observation 协议测试、`pnpm typecheck`；最终全仓在 R39 运行 | ✅ | 见第 5 节 |

## 5. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest list --config vitest.config.ts "e4-r24-fixture-probe-legacy"`（**修复前**） | 列出 `apps/cli/src/e4-r24-fixture-probe-legacy.test.ts` → J02 复现 |
| 同上（**修复后**） | 输出为空，`exit 0` |
| `vitest run --config vitest.config.ts "apps/cli/src/e4-r24-fixture-<stamp>.test.ts"`（显式指名残留） | `exit 1` + `No test files found`，并打印 `exclude: **/node_modules/**, **/.git/**, apps/cli/src/e4-r24-fixture-*.test.ts` |
| `vitest run apps/cli/src/e4-r24-final-result-protocol.test.ts` | **5/5 PASS**，Test Files 1 passed，exit 0 |
| 同上 `-t E4-R37`（**移除 exclude 后**，判别性回退验证） | **1 failed \| 4 skipped** → 恢复配置后 1 passed |
| `vitest list --config vitest.config.ts`（无 filter）**含** 该规则 | 5755 个测试点，exit 0 |
| 同上 **不含** 该规则 | 5755 个测试点，exit 0 —— **集合完全一致（无附带损害）** |
| `pnpm typecheck`（`tsc -b` 全仓） | **exit 0** |
| 残留检查 | `apps/cli/src` 与 `observation-fixtures/` 中 `e4-r24-fixture*` 计数 **0**；`git status --short` 无探针文件 |

## 6. 残余限制与诚实边界

- **排除的是「生成文件名模式」，不是「目录」**：若未来有人把正式测试命名为 `e4-r24-fixture-*.test.ts`，它会被一并排除。该模式在 R24 起专用于生成物，风险已在配置注释中写明。
- **只在根配置生效**：专用夹具配置（`apps/cli/test-infra/observation-vitest.config.ts`）仍选择夹具目录，这是**有意保留**的——子进程必须真正执行 deliberately-failing 夹具。
- **不清理历史残留**：本项**不**删除用户工作区里的旧夹具（可能是未提交的本地文件）；只保证它不再进入正式集合。这正是「升级后安全」的含义。
- **旧代夹具在 `tsc -b` 仍会被编译**（它在 `apps/cli/tsconfig.json` 的 `include: ["src"]` 内）：本轮未改动 tsconfig——把 src 下的 `.test.ts` 排除出编译会给业务测试带来更大范围的副作用，超出 J02 范围。
- **本轮改动未提交**：testedSourceSha = **dirty worktree on `a7950fa1`**；远端 CI 按 R39 收口处理。
