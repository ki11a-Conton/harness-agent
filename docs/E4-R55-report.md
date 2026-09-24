# E4-R55 报告：补上生产失败接线的真实回归验收

## 1. 问题（F55，P2；依赖 R51、R52）

R45 声称关闭了"失败取证链"，但它的证据是 **recorder 单元级**的，与**生产接线**脱钩：

```ts
// e4-r45-diagnostics-order.test.ts 用例 B —— 手写夹具
await writeFile(daPath, JSON.stringify({ decision: "REJECT", reasonCodes: ["capacity"] }), "utf8");
// 用例 E —— 测试自己构造一个"什么都没注册"的 recorder
const rec = recorder("r45-e", "E: no registration");
const out = await rec.captureFailure({ ... });
expect(arts.find((a) => a.role === "decision-artifact")).toBeUndefined();
```

由此产生的三个可证伪的后果：

1. 用例 B 的 `{decision:'REJECT'}` 是**人工夹具**，不是 evaluator 的计算结果，却被称为"真实"。
2. 用例 E 只证明"未注册 ⇒ 角色缺失"这一 recorder 层事实。**把生产注册顺序改回旧版，
   A/B/C/E 四例都不会失败**——验收绑定的是 recorder，不是接线。
3. `e4-09-production-e2e.test.ts` 的 5 个用例都跑在**成功路径**上，`afterEach` 的失败分支
   从不触发，因此它**不承载**任何"失败时确实保存了证据"的接线级证据。

## 2. 复现命令与修复前实际结果

复现命令（新增父验证程序）：

```
node_modules/.bin/vitest run apps/cli/src/e4-r55-failure-wiring.test.ts
```

**修复前**：该文件不存在，上述三个后果无法被任何测试发现；`e4-r45-*` 四例在"生产注册
顺序改回旧版"的变异下**依然全绿**（这正是 F55 的定义：变异不可被观测）。因此修复前不存在
"失败结果"，需要的是**建立**有判别力的验收。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | 新增：**共享的真实生产接线**（注册前移、evaluator 结果断言前落盘、失败采集钩子）+ 顺序变异函数 |
| `apps/cli/src/e4-09-production-e2e.test.ts` | 修改：删除私有接线副本，改为依赖上述共享模块（行为不变，5/5 通过） |
| `apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts` | 新增：隔离子进程夹具（4 例，其中 3 例**预期失败**） |
| `apps/cli/test-infra/r55-vitest.config.ts` | 新增：子进程专用 config（仅选择该夹具目录，沿用 H04 口径） |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 新增：**父验证程序**（默认 CI 执行） |
| `.gitignore` | 修改：生成的变异副本必须对 `git status` 隐形（否则子进程内的 benchmark 见脏树拒跑） |
| `docs/E4-R45-report.md`、`docs/E4-R50-report.md` | 修改：**带日期补记**更正过强的证据描述与失效的版本等价表述 |

设计要点：

1. **真实接线只写一次**：生产接线抽到 `apps/cli/src/e4-09-real-chain.ts`，真实 E2E 套件与
   子进程夹具**都依赖它**。因此对该文件的顺序变异是**可观测**的——这直接回应计划第 7 条
   "不要只复制一段注册逻辑来验证原接线"。
2. **确定性非 ACCEPT 来自真实 evaluator**：`candidateWrites: false` 让候选臂与基线臂行为
   相同，真实 evaluator 因此返回非 ACCEPT。全程没有手写 decision JSON。
3. **父/子进程结构**：父程序 spawn 真实 `vitest run` 子进程，收集**真实退出码**、JSON 报告
   中的逐用例状态、以及子进程自己写的诊断包与副本。
4. **evaluator 抛异常**用调用边界的故障注入实现，并在 bundle 中打标
   `evaluatorFaultInjection: true` + 说明文字，**不冒充**真实 evaluator 结果。
5. **顺序变异用临时副本**：父程序对真实模块做**字符串手术**生成
   `apps/cli/src/e4-r55-mutated-chain.generated.ts`（把 decision 落盘移回 ACCEPT 断言
   **之后**），跑同一验收，要求它**必须失败**。该副本 gitignored、`afterAll` 删除、
   且手术带"找不到标记就抛错"的守卫，避免空转变异伪装成通过。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/vitest run apps/cli/src/e4-r55-failure-wiring.test.ts` | 0 | **1 passed**（耗时约 134 s，内含 2 次真实子进程运行） |
| 子进程夹具（父程序内 spawn） | 1 | 预期：**3 failed / 1 passed** |
| `node_modules/.bin/vitest run apps/cli/src/e4-09-production-e2e.test.ts` | 0 | **5 passed (5)**（重构后干净树复验） |

父验证程序实测得到的关键证据（真实运行输出）：

| 验收项（计划 §7「怎么验收」） | 实测结果 |
| --- | --- |
| 真实非 ACCEPT：诊断包含实际 decision/reasonCodes、生产生成的 paired/V3 | bundle `r55-nonaccept`：`decision="INCONCLUSIVE"`、`reasonCodes=["EFFECT_BELOW_THRESHOLD"]`、13 个 gate 全量；`paired-experiment` `complete=true`/6 对、`v3-candidate` `promotionEligible=true`/`isolationStrength=strong`/6 outcomes 0 passed；4 个 artifact 全部 `captured=true` |
| 原临时树删除后仍可读 | 副本在**子进程退出后**由父程序读取；每个副本 `sha256 == headDigest` 且 `byteLength == headBytes`（R52 契约在真实证据上的交叉验证） |
| evaluator 注入异常 | `stage=evaluate`、`failure.message` 含注入异常原文、`evaluatorFaultInjection=true`；decision 角色 `captured=false` 且 summary 为 `null`；故障前写出的 paired/v3 **仍被保存** |
| benchmark 前置失败 | `stage=benchmark`、`extra.benchmarkCli.exitCode=1`（真实 CLI 退出）、4 个输出角色全部 `captured=false` 且各自带真实 ENOENT 原因 |
| 成功 E2E：不产生失败包 | `r55-success` **无 bundle**；正常轮共 **3** 个 bundle（恰为 3 个失败用例） |
| 顺序变异副本：父验证失败 | 变异轮 `r55-nonaccept` bundle 存在但 `decision-artifact captured=false`；同一 `acceptance()` 返回 `ok=false`，理由含 `decision-artifact` —— 证明验收绑定接线而非 recorder |
| 默认 CI 执行该父验证 | 父验证位于 `apps/cli/src/`，被根 vitest `include`（`apps/*/src/**/*.test.ts`）收集，故随 `pnpm test` 默认执行 |
| 精确预期失败 | 断言子进程逐用例状态集合**恰好**为 3 failed + 1 passed，且退出码**恰好**为 1 |

## 5. 报告口径补记（计划第 8 条）

- `docs/E4-R45-report.md` 追加 §8「补记（2026-09-14，E4-R55）」：逐条更正
  §5「B」的"真实"用词、§5「E」的判别力声明、§7 的"E2E 自身承载接线级证据"，
  并记录干净树 5/5 复验已完成。历史原文保留。
- `docs/E4-R50-report.md` 追加 §10「补记（2026-09-14，E4-R55）」：更正 §8 的
  "与 `109cc5e6` 逐字节相同"表述——实测 `109cc5e6` 是 `440b2895` 的祖先，且
  `440b2895` 修改了 `apps/cli/src/e4-09-diagnostics.ts`（+5 行），故该等价窗口已关闭，
  `109cc5e6` 的 CI 结论不可归属后续版本；同时下调关闭矩阵中 R45 一行的**证据等级**
  （不是修复结论）。

## 6. testedSourceSha

- 基线提交（R55 开始时 HEAD）：`9a86dbb`（R54 提交）
- 本任务期间的实现提交：`71f2317`、`14edb86`、`3b20330`、`9d…`/`90fea4a`、`c5c96d6`
  （共享接线抽取 → 子夹具/config → 父验证 → 变异实现修正）
- 被测文件内容标识（`git hash-object`，本报告撰写时实测）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | `1e6ea1bf316085816250356c0bcf02d87057ba1c` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `31cf84136949aee3718c0d4770a938b724ef8033` |
| `apps/cli/test-infra/e4-r55-fixtures/failure-wiring.child.test.ts` | `394fd9fa9c9520ef99e0db972e93af9e2cfb66ee` |
| `apps/cli/test-infra/r55-vitest.config.ts` | `d65ec628de27f51aeff03a064dddd0d472926662` |
| `apps/cli/src/e4-09-production-e2e.test.ts` | `d1bb11157c9895cd91abc38ff7738692104b3d39` |

- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 报告撰写时工作树仅剩 `docs/E4-R45-report.md`、`docs/E4-R50-report.md` 两处补记未提交
  （与本报告一并提交）。

## 7. NOT_RUN

- 未重跑全仓 `pnpm test` / `pnpm typecheck` / `pnpm docs:verify`：按计划在 R56 于干净已提交
  版本上统一执行（`tsc -b apps/cli` 已单独跑过，退出码 0）。
- 未核实该版本远端 CI：本轮不推送，R56 记录为 NOT_RUN。
- 未做付费评测、未自动发布、未强推、未改远端权限。

## 8. 残余限制

1. **父验证要求干净工作树。** 生产 benchmark 拒绝在"不可证明干净"的树上产出可晋级运行
   （这是生产语义，不是本任务的限制）。父程序在开头显式检查 `git status --porcelain`，
   脏树时以明确文字失败，而不是把"benchmark 拒跑"误判为接线缺陷。代价：本地未提交时
   `pnpm test` 会失败；CI 在干净检出上不受影响。
2. **共享接线模块位于 `apps/cli/src/`**（而非 `test-infra/`）。原因：`apps/cli/tsconfig.json`
   的 `rootDir` 为 `src`，`src` 内的文件 import `test-infra` 会触发 TS6059/TS6307
   （实测）。放在 `src` 使其被 `tsc -b` 类型检查，且文件名不以 `.test.ts` 结尾，不会被
   vitest 收集为用例。副作用：该测试辅助模块会进入构建产物 `dist/`。
3. **变异副本生成在 `src/` 内**（`e4-r55-mutated-chain.generated.ts`），因为变异体必须与
   真实模块**同目录**才能保持相对 import 不变。它是 gitignored 的临时文件，`afterAll` 删除；
   若进程被强杀可能残留（此时它仍是语法合法的 TS，不会破坏 `tsc -b`）。
4. 变异只覆盖**一种**顺序缺陷（decision 落盘移到断言之后）。计划第 7 条允许"注册或
   decision 保存"二选一，本任务选了后者（因为它是 F55 的直接成因）；"注册前移"的变异未做。
5. 父验证耗时约 134 s（2 次真实子进程 × 真实 benchmark），是全仓 `pnpm test` 中最重的
   用例之一。未通过缩小用例数或跳过真实 benchmark 来加速——那会削弱证据。
6. 子进程夹具的 3 个"预期失败"用例在直接运行该 config 时会呈现为红色（`vitest run --config
   apps/cli/test-infra/r55-vitest.config.ts` 退出 1）。这是设计如此：它不在默认 `include`
   内，只能由父验证程序驱动；单独运行它得到的是"预期失败"，不是回归。
7. `benchmark-fail` 用的是"cases 目录不存在"，属于前置条件失败的一种形态；未穷举其它
   前置失败形态（如 cases 内容非法）。
