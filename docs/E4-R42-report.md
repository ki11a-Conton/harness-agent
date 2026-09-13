# E4-R42 Report — 测试夹具与真实构建的隔离，避免共享 src/dist 相互干扰（K03）

- reviewedSourceSha（本计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- 被测工作树：本报告所属的 **R42 实现提交**（`E4-R42: …`）。
- 状态：**RESOLVED（K03）**——构建污染在**根因处**消除（窄范围 tsc 排除），
  真实 gate 集成测试改为在**自有受控 workspace** 中执行并证明不触碰共享资源。
- 真实模型调用：**0**；平台：Windows（win32）

---

## 1. 做了什么

K03 的两个具体问题：

1. **旧位置夹具进入生产编译输入**：`apps/cli/src/e4-r24-fixture-*.test.ts`（E4-R37 兼容测试的
   旧命名残留）被 `.gitignore` 与**根 vitest exclude** 双双排除，但 `apps/cli/tsconfig.json`
   的 `include: ["src"]` 仍然把它当作**生产编译输入**，于是 `tsc -b` 把
   `dist/e4-r24-fixture-*-legacy-assert-fail.test.{js,d.ts,map}` 写进共享 `dist/`。
   **"git 忽略" ≠ "tsc 排除"。**
2. **真实 gate 测试写共享构建产物**：`release-command.test.ts` 执行真实 `pnpm typecheck`
   （`tsc -b`，root=主仓），写共享 `apps/cli/dist/**` 与
   `node_modules/.cache/tsbuildinfo/cli.tsbuildinfo`，与其他测试的读/写**无约束重叠**。

本轮（最小改动）：

- **根因修复**：`apps/cli/tsconfig.json` 增加**窄范围** `exclude`
  （`src/e4-r24-fixture-*.test.ts`）——临时源码永远不是生产编译输入，因此**无论是否与真实
  `tsc` 并发**都不会产生 dist 孤儿。**不**排除正式测试或业务源码。
- **隔离边界**：新增 `apps/cli/src/e4-r42-gate-isolation.test.ts`——真实 gate 命令在一个
  拥有**自己的 git 身份、package/script 配置与输出/构建缓存**的临时 workspace 中执行，
  并断言主仓共享 `dist` + `tsbuildinfo` **逐字节未变**。
- 澄清 `release-command.test.ts` 中一个**标题误导**的用例（标题说 FAILING，实际跑的是会通过的
  `chaos` 门并断言 exit 0）——它不是非零路径证明；真实非零路径由上述隔离测试覆盖。

---

## 2. K03 要求 → 实现对照

| 计划要求 | 实现落点 | 证据 |
|---|---|---|
| 旧位置临时源码不能进入生产编译输入与共享 dist | `apps/cli/tsconfig.json` 的 `exclude: ["src/e4-r24-fixture-*.test.ts"]` | §4（真实 `tsc -b` 下 dist 孤儿 = 0） |
| 先证明当前编译输入**会**包含该旧命名模式 | 用可控夹具实测（改前命中 1 次） | §4「改前」 |
| 窄范围排除；不排除正式测试或业务源码 | 实测：排除后仍有 36 个正式 `.test.ts` + `main.ts`/`benchmark-command.ts` 在编译输入内 | §4「改后」 |
| release 真实 typecheck/build 不与共享 src/dist/tsbuildinfo 无约束重叠 | 真实 gate 集成测试在**受控 workspace** 执行；断言主仓共享资源摘要不变 | §5 |
| 隔离环境要有真实 Git 身份、可解释 package/script 配置、自己的输出/构建缓存；证据 SHA 属于被测 workspace | 临时 workspace：`git init` + 提交 + 自有 `package.json`（含 `typecheck` 脚本）/`tsconfig.json`(outDir/buildinfo 在 ws 内) | §5（`green.gitSha === ws HEAD`，主仓 SHA 未被冒充） |
| 真实 green 与真实 nonzero 都跑真 child command，验证 exitCode/passed/cleanBefore/After/CLI 一致 | `runGateV2` 跑真实 `tsc`（green）与真实非零进程（exit 3 + stderr） | §5 |
| 不把「标题说 FAILING、实际跑健康 chaos」当非零路径证明 | 用例标题与注释更正，并指向真实非零测试 | §3 |
| 定向同时执行相关协议/gate 测试，确认不产生对方编译产物、不写对方 build info | 三文件并发运行后检查 `dist`/`src` | §4「并发」 |
| dirty-source / 真实 host mutation 拒绝行为不回退 | 既有负例全部保留（security / isolation / e4-09） | §6 |
| 临时数据清理只限自己创建的路径；不做全仓 dist 清空 | 仅删除 `apps/cli/dist/e4-r24-fixture-*`（48 个历史孤儿）；测试只删自己写的 fixture | §3 |

---

## 3. 改动清单

- `apps/cli/tsconfig.json`：`exclude: ["src/e4-r24-fixture-*.test.ts"]`（唯一的生产侧改动）。
- `apps/cli/src/e4-r42-gate-isolation.test.ts`（新增）：隔离 workspace 的真实 gate 测试。
- `apps/cli/src/e4-r24-final-result-protocol.test.ts`：新增 `E4-R42 (K03)` describe——
  行为化证明旧命名夹具不在 tsc 编译输入内，而正式源码/测试仍在。
- `apps/cli/src/release-command.test.ts`：更正误导性标题 + 加注释指明真实非零路径的覆盖位置
  （**未**改动其断言或放宽任何验证）。
- 清理：本机 `apps/cli/dist/e4-r24-fixture-*` 历史孤儿 48 个（构建产物，gitignore；不新增启动扫盘逻辑）。
- `docs/E4-R42-report.md`；`plan.md` R42 状态。

**未改**：`GATE_COMMANDS`、gate runner 生产逻辑、`release-verify` 契约、隔离后端矩阵、
任何安全负例、任何超时/并发度设置（**未**用全局串行化或增大超时替代隔离）。

---

## 4. 「构建污染修复」的实测证据

**改前（可复现，可控夹具）**：在 `apps/cli/src/` 放一个旧命名夹具后，
`tsc -p apps/cli/tsconfig.json --noEmit --listFiles`（等价列出编译输入）**命中该文件 1 次**。
历史上共享 `dist/` 里累积了 **48 个** `e4-r24-fixture-*` 孤儿（`.js/.d.ts/.map`）。

**改后**：

| 检查 | 结果 |
|---|---|
| 旧命名夹具是否在 tsc 编译输入内 | **否（0 次命中）** |
| 正式测试 `apps/cli/src/*.test.ts` 是否仍在输入内 | **是（36 个）** |
| 业务源码（`main.ts`、`benchmark-command.ts`）是否仍在输入内 | **是** |
| 夹具在盘上时真实 `pnpm typecheck`（`tsc -b`）后的 dist 孤儿 | **0**（改前会产出 4 个文件） |
| `pnpm typecheck` 退出码（夹具在盘上时） | **0**（排除未破坏构建） |

**并发验证**：`e4-r24-final-result-protocol.test.ts` + `release-command.test.ts` +
`e4-r42-gate-isolation.test.ts` **同时**运行 → **3 files / 29 tests passed**，
运行后 `apps/cli/dist` 旧夹具孤儿 **0**、`apps/cli/src` 残留 **0**。
即：真实的「协议测试临时写源码」与「release 真实 `tsc -b`」重叠时，**不再产生对方的编译产物**。

---

## 5. 「共享资源隔离」的实测证据（真实 gate，受控 workspace）

`apps/cli/src/e4-r42-gate-isolation.test.ts`（**1 passed**）：

- workspace = 临时目录 + **真实 `git init`/提交**（自有 SHA）+ 自有 `package.json`
  （`typecheck` 脚本）与 `tsconfig.json`（`outDir`/`tsBuildInfoFile` 均在 ws 内）+ `.gitignore`。
- **真实 green**：`runGateV2` 执行真实 `tsc -p tsconfig.json` →
  `exitCode=0`、`passed=true`、`state="passed"`、`cleanBefore/After=true`、
  `gitSha === workspace HEAD`（**不是**主仓 SHA）；产物落在 **ws 自己的 `out/`**。
- **真实非零**：`runGateV2` 执行真实失败子进程（exit 3 + stderr）→
  `exitCode=3`、`passed=false`、`state="failed"`；**真实失败细节**可从 `logRef` 保存的日志与
  `errorSummary` 中取回（`gate-failure-detail`），不是只有一个布尔。
- **共享资源未受污染**：调用前后对主仓
  `apps/cli/dist` 文件清单 + `node_modules/.cache/tsbuildinfo/cli.tsbuildinfo` 的 sha256 摘要
  **完全一致**。

---

## 6. 门禁实测（R42 自身范围）

| 项目 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | **PASS**（退出 0） | 含夹具在盘上的对照 |
| `e4-r42-gate-isolation.test.ts` | **PASS 1/1** | 真实 green + 真实非零 + 共享资源未变 |
| `e4-r24-final-result-protocol.test.ts` | **PASS**（含新 K03 用例） | 与 release/gate 并发 29/29 |
| `release-command.test.ts` | **PASS** | 未放宽既有验证 |
| 并发运行后 `dist`/`src` 污染 | **0 / 0** | 见 §4 |
| 真实模型调用 | **0** | 全部离线 |

> 全量 `pnpm test` / `docs:verify` / `security` / `protocol` / `race` / `chaos` 属 **R44**
> 的静止工作区最终门禁范围。

---

## 7. 一页结论

1. **构建污染已修（根因）**：`git 忽略 ≠ tsc 排除`；现在旧命名夹具**永远不进入生产编译输入**，
   因此**即使与真实 `tsc -b` 并发**也不会在共享 `dist/` 留下孤儿。实测：夹具在盘时真实构建后
   孤儿 = 0（改前 4 个/次），且排除范围足够窄（36 个正式测试 + 业务源码仍在输入内）。
2. **隔离边界已建立**：真实 gate 集成测试在自有 git 身份/配置/输出缓存的 workspace 中执行，
   并用「主仓共享 dist + tsbuildinfo 摘要不变」证明不写入共享构建资源；证据 SHA 属于被测
   workspace，未复制主仓 SHA 冒充。
3. **未越界**：未全局串行化、未增大超时、未删除真实 gate 测试、未用固定 exitCode mock 取代真实验证、
   未放宽任何安全负例；唯一的**生产侧**改动是一行 tsconfig `exclude`。
4. **归因纪律**：**历史间歇性 `INVALID` 未在本轮复现**，其与 K03 的**因果仍需 R40 证据单独判定**——
   R40 已把历史 `INVALID` 归因于**干净树前置条件**；K03 是**构建输入污染**，两者分别记录，
   **不合并归因**。

---

## 8. 残余限制

- 本轮**未**在 Linux/Windows CI 上重跑以观察 K03 是否曾影响 CI 稳定性（无 CI 触发）；结论限于
  本地可复现的构建输入污染。
- `exclude` 只针对**明确的临时命名模式**；若未来有正式测试采用同一文件名会被一并排除
  （与 R37 的 vitest exclude 同一已知权衡，报告如实记录）。
- 主仓 `apps/cli/dist` 中**其他**历史孤儿（非本模式）未清理，也未新增启动扫盘逻辑。
- `release-command.test.ts` 仍对主仓执行真实 `typecheck`（其断言依赖真实退出码）；本轮通过
  「根因排除 + 隔离测试证明不污染共享资源」而非重写该文件来满足隔离要求。
