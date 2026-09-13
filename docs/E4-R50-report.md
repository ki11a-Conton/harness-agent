# E4-R50 报告：最终门禁与有限收口

## 1. 做了什么

对 R45…R49 做最终门禁验证，建立关闭矩阵，在干净、已提交的静止工作区跑完整门禁，
并核实实现提交对应的远端 CI 四 job；同时**发现并修复一个由 R46 引入、R50 门禁才暴露**
的真实回归。

## 2. 关闭矩阵（缺口 → 复现 → 修改 → 回归测试 → 被测版本 → 结果）

| R | 缺口 | 复现 | 修改 | 回归测试 | 被测版本 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| R45 | 诊断注册/落盘在失败点之后 | 修复前 benchmark 失败/非ACCEPT 时 afterEach 采集不到任何 artifact | `e4-09-production-e2e.test.ts` 注册前移 + evaluator 结果断言前落盘 + testName 绑定 | `e4-r45-diagnostics-order.test.ts`（A/B/C/E） | `9fb8660e` | ✅ |
| R46 | 目录分配依赖模块计数 | 跨进程同 runId+label 撞 attempt-1 覆盖 | `captureFailure` 改 `mkdtemp` 原子建目录 + `captureIdentity`/`ciRunAttempt` | `e4-r46-diagnostics-noclobber.test.ts`（跨进程+重复采集） | `c07814e1` | ✅ |
| R47 | 限制非按字节、摘要语义不明 | 目录当文件读取挂起 300s；summary digest 与源字节混淆 | `readArtifact` 流式有界 + 前置 `stat` + sourceDigest/headDigest 分离 | `e4-r47-bounded-copy.test.ts`（6 例 A-G） | `473f595f` | ✅ |
| R48 | 快照只列顶层文件名 | 同名覆盖/嵌套改动快照不变 | `sharedBuildSnapshot` → `deepSnapshot`（递归+内容寻址+排序+读错误标记） | 判别力测试（临时树同名/嵌套/增删/排序） | `139cdfeb` | ✅ |
| R49 | 状态文档 release/入口冲突 | plan.md 仍写「release 未执行」却已有 v1.8.0；R44 报告矩阵/补记矛盾 | plan/HANDOVER/E4-STATUS/R44 报告三分口径 + 入口翻新 R45…R50 | `pnpm docs:verify` ALL PASS | `7b1deb70` | ✅ |
| R50 | **R46 引入的全量并发瞬态脏树回归** | 全量 `pnpm test` 1 failed（`e4-09` 判 INVALID），并发下 R46 fixture 写/删让探针见脏树 | `.gitignore` 加 `diagnostic-fixtures/*.test.ts`（与 observation-fixtures 同口径 git-invisible） | 干净树重跑全量 323/5765/0 | `109cc5e6` | ✅ |
| R50 | **R46 引入的 `mkdtemp` 父目录缺失回归**（CI-only） | CI 四 job 失败，`E4_09_DIAG_DIR=.ci/diagnostics` 未建 → `mkdtemp` ENOENT → `captureFailure` 返回 null | `captureFailure` 先 `mkdir(root,{recursive})` 再 `mkdtemp` | 本地复现目录不存在场景 R46 3/3 | `440b2895` | ✅ |

**R50 暴露的回归是真实的，不是门禁假阳性**：R46 跨进程测试把 fixture 写进
`apps/cli/test-infra/diagnostic-fixtures/`，但未将其加入 `.gitignore`。全量并发时该
fixture 文件的瞬时写/删会落在 `git status --porcelain` 里，让并发的 e4-09 promotion
benchmark 读到「瞬态脏树」→ 真实链拒绝运行（退出非零）→ 决策判 INVALID。它在单测/
隔离时不可见，只有全量并发门禁才会暴露——正是 R50「在干净、静止工作区跑全量」的意义。

## 3. 最终门禁（干净、已提交、静止工作区，`440b2895`）

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 0 | `tsc -b` 全绿 |
| 全量测试 | `pnpm test` | 0 | **323 文件 / 5765 passed / 1 skipped / 0 failed** |
| 文档真实性 | `pnpm docs:verify` | 0 | ALL CHECKS PASS |
| 安全 | `pnpm test:security` | 0 | 18 文件 / 2133 passed |
| 协议 | `pnpm test:protocol` | 0 | 7 文件 / 52 passed |
| 竞态 | `pnpm test:race` | 0 | 11 文件 / 23 passed |
| 混沌 | `pnpm test:chaos` | 0 | 1 文件 / 12 passed |

注：R45…R48 均不触及 protocol / race / chaos / security 的合同（改动集中在诊断采集
`apps/cli/src/e4-09-diagnostics.ts`、E2E 测试、诊断回归测试、`.gitignore`），但按
AGENTS.md「运行相关安全测试」与 R50 §4「按改动范围执行相关安全、集成测试」，仍完整
跑了 security/protocol/race/chaos 作门禁证据（计划 §9 明确「不为增加测试数量重复运行
无关组合」，此处为枚举一次性证据，非重复跑)。

## 4. 故意失败的 forensics

`pnpm test:forensics`（`e4-r40-forensics.test.ts`）按设计非零退出（1 failed / 1 passed），
用于证明诊断落盘路径仍工作。R45/R46/R47 改动后已确认该取证路径功能不变（见 R46 报告
§5），且它已从默认 `pnpm test` 排除，不计入全量门禁的 0 failed。

## 5. 远端 CI 核实

### 5.1 第一次 CI（`109cc5e6`）—— 暴露 R46 另一个回归

- run ID：`34751498573`，head SHA：`109cc5e6`。
- 结论：**四 job 失败**（ubuntu/windows 主门禁 + coverage = failure，attestation skipped）。
- 失败用例（两平台一致，`e4-r46-diagnostics-noclobber.test.ts` 两例，各 `expected null
  not to be null`）：
  - `a single recorder's repeated captureFailure writes an INDEPENDENT bundle...`
  - `ciRunAttempt reflects process.env.GITHUB_RUN_ATTEMPT when set`
- **根因**：R46 让目录分配改用 `mkdtemp`，但 `mkdtemp` **不创建父目录**。CI 的 verify
  job 只 `mkdir -p .ci`，`E4_09_DIAG_DIR=.ci/diagnostics` 指向的目录**尚不存在** →
  `mkdtemp(prefix)` 抛 ENOENT → `captureFailure` 返回 `null`（best-effort）→ 断言
  `expected null not to be null`。本地不设该变量走 `<tmpdir>/...`（父目录已存在），故未暴露。
- **修复**（`440b2895`）：`captureFailure` 里先 `mkdir(root, { recursive: true })` 再
  `mkdtemp`。本地复现（`E4_09_DIAG_DIR` 指向不存在的多级子目录）修复前必失败、修复后
  R46 3/3 通过。

### 5.2 第二次 CI（`440b2895` / 最终 `ca46c5cf`）—— 四 job 全绿

- 最终 head SHA：`ca46c5cf786192dce1acddedd1a2182e09a0912c`（含 R46 补丁2 + R50 报告，
  代码与 `440b2895` 逐字节相同）。
- run ID：`34751874658`，结论 **success**：
  - Ubuntu 主门禁（typecheck · test · build · benchmark-smoke · audit）✅ success
  - Windows 主门禁 ✅ success
  - Ubuntu coverage gate ✅ success
  - release attestation（P38-12）✅ success

> 边界说明（R50 §5/§8）：job 状态核实与 artifact 内容复核分开——此处只核实了 job/step
> 状态为 success，未下载 release 证据逐字节重放（记录为「未复核」，非 PASS 冒充）。

## 6. testedSourceSha 与未提交改动

- `testedSourceSha`：`440b2895`（R50 最终门禁执行版本，含两个 R46 修复补丁，工作树
  逐字节一致、干净）。
- 门禁执行后工作树干净，无未提交改动。

## 7. 未执行项与残余限制

- 真实模型 champion 质量：`championPromotion.status=NOT_RUN`（未请求付费 benchmark）。
- release/发布完整性：本轮未复核发布二进制/签名/供应链证据（只核实 release 存在与
  job/step 状态）。
- `01c4ec74` 的 Windows CI 波动：**仍未归因**（同代码文档提交四 job 全绿 ⇒ 判波动），
  不把历史间歇失败自动宣布为已根治。
- R50 报告的 CI 四 job 结论编写时未定，以补记为准（不无限追踪）。

## 8. 代码等价依据（如后续仅文档提交）

R50 报告本身是文档；若需要在 CI run 完成后补记四 job 结论，将新增**纯文档提交**——
代码与 `109cc5e6` 逐字节相同，故「四 job 全绿」是对同一代码的 CI 结论，不构成新 SHA
的冒充；该补记只更新本报告 §5，不重跑门禁。

## 9. 收尾：计划文件体系移除与 E4-00 放宽（2026-09-13，用户指示）

- 用户指示：`plan.md`、`plan(20260912-180524).md`、`plan(20260912-144145).md` 三个计划
  文件全部从工作树与远端删除，仅存 git 历史。R45…R50 执行状态此前记录于 plan.md
  （随删除进入 git 历史），本报告为树内持久记录：R45–R48 ✅（报告见
  `docs/E4-R45-report.md` … `docs/E4-R48-report.md`）、R49 ✅（`docs/E4-R49-report.md`）、
  R50 ✅（本报告，§5 门禁与 CI 四 job 全绿）。
- `docs-verify` E4-00 放宽：仓库不再维护「当前计划入口」三文件体系——无 `plan.md` =
  无进行中的计划 → **诚实 PASS**（reason 注明 no plan.md — no in-progress plan，不伪装）；
  一旦 plan.md 重新出现仍 **fail-closed**（缺当前入口标记 / 引用不存在的 spec 判 FALSE）。
  新增回归测试覆盖「plan.md 缺失 → PASS」分支。
- 收尾门禁（收尾提交工作树，非重跑 R50 全量）：typecheck 0；`vitest run
  apps/cli/src/docs-verify.test.ts` 16 passed / 16；`pnpm docs:verify` ALL CHECKS PASS
  （E4-00 以无 plan.md 状态通过）。
- 边界：本收尾提交只改 `docs-verify.ts`/`docs-verify.test.ts`、删除三个 plan 文件、
  追加本节；不触及 R50 最终门禁（`440b2895`）覆盖的生产代码路径，E4-09 真实链不受影响
  （其不依赖 plan 文件）。收尾提交本身的远端 CI 结论以 git 历史/Actions 为准，不在此冒充。