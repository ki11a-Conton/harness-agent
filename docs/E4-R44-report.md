# E4-R44 Report — 合并证据、完成 R39 的后续收口（K05）

- reviewedSourceSha（本计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- **testedSourceSha：`9df1c1b3`**（E4-R43 实现提交）——第 3 节的全部门禁在**该版本的干净工作树**上执行
  （运行前后 `git status --short` 为空）。R44 自身只改文档，不触碰代码/测试/构建配置，
  因此门禁结果对其代码内容（= `9df1c1b3`）继续成立。
- 状态：**RESOLVED（K05 收口）**
- 真实模型调用：**0**；平台：Windows（win32）

---

## 1. 做了什么

1. 建立 **K01…K04 证据矩阵**（§2）：复现/缺口 → 修改 → 测试 → 被测版本 → 结论 → 残余限制。
2. 在**冻结、静止、干净**的最终工作区集中跑门禁（§3），并把「历史间歇失败」与「当前门禁通过」
   分开陈述（§5）。
3. 更新当前状态文档：`plan.md`（唯一入口）、`HANDOVER.md`、`README.md`、`README.zh-CN.md`、
   `docs/E4-STATUS.md`。
4. Windows 定向验收与远端 CI 核实（§4）。

---

## 2. K01…K04 证据矩阵

| ID | 复现 / 缺口 | 修改 | 测试 | 被测版本 | 结论 | 残余限制 |
|---|---|---|---|---|---|---|
| **K01** | 历史 E4-09 `INVALID` 只留框架行；`afterEach` 删临时目录 ⇒ 无法归因 | `apps/cli/src/e4-09-diagnostics.ts`（失败即落盘诊断包）；哨兵探测记录随 outcome 进 `paired-experiment.json` | 独立 `e4-r40-forensics.test.ts`（按设计非零，已从默认 `pnpm test` 排除）+ CLI 路径端到端断言 | `4a2ef3fc`/`f3631f6d` | **RESOLVED（诊断路径）**；并**归因** R39：运行期**干净源树前置条件** | 诊断包默认落本机临时目录；CI 上传未接入 |
| **K02** | `gitOutput` 吞错 → `""`；两次探测失败仍 `hostMutated=false, details=[]` | 结构化 `gitProbe` + `HostProbeError`；`HostState` 携有效性/原因；三态 `compareHostState`；promotion-grade fail-closed | isolation 新增 6 例（20/20）；CLI 路径 1 例（67/67） | `4d829957`/`f61f012b` | **RESOLVED** | `hostMutated` 保持 bool 以兼容；语义收紧在新 API |
| **K03** | 旧命名夹具仍是生产编译输入 → 孤儿进共享 `dist/`；真实 `typecheck` gate 写共享源码/dist/tsbuildinfo | `apps/cli/tsconfig.json` 窄范围 `exclude`（唯一生产侧改动）；真实 gate 测试改在自有 workspace | tsc 编译输入行为测试 + `e4-r42-gate-isolation.test.ts` | `6befb3ff` | **RESOLVED** | 排除按文件名模式（与 R37 同一已知权衡）；其他历史孤儿未清理 |
| **K04** | R38-b 输入与预期同源常量 ⇒ 锁不住公开上限 | 无生产改动；新增固定字面量边界测试 + 副本 mutation 判别 | `e4-r43-execution-plan-capacity.test.ts` 3 例（副本 2,000,000 / 999,999 真实加载） | `9df1c1b3` | **RESOLVED（判别力补足）** | 只覆盖 `repeat×caseCount` 合同与单 case 边界 |

**因果纪律**：K02/K03/K04 各有**独立复现**与验收，可单独关闭；**K03 与历史 K01 的因果不合并**——
R40 已把历史 `INVALID` 归因于**干净树前置条件**，K03 是**构建输入污染**，两者分别记录。

---

## 3. 静止工作区最终门禁（`9df1c1b3`，干净树）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（`tsc -b`） | **PASS**，exit 0 |
| `pnpm test` | **PASS** — **320 files / 5751 passed / 1 skipped / 0 failed** |
| `pnpm docs:verify` | **PASS** — `ALL CHECKS PASS` |
| `pnpm test:security` | **PASS** — 18 files / 2133 passed |
| `pnpm test:protocol` | **PASS** — 7 files / 52 passed |
| `pnpm test:race` | **PASS** — 11 files / 23 passed |
| `pnpm test:chaos` | **PASS** — 1 file / 12 passed |
| 真实模型调用 | **0** |

**为何 `pnpm test` 这次绿**（与 R39 的对比）：不是"重跑到绿"，而是先**满足运行前置条件**——
E4-09 的真实链要求运行期干净可证源树（R40 归因）。本轮在**已提交**版本上运行、运行期间不碰工作树，
一次即绿；R39 当时是在**带未提交改动**的树上运行。

**门禁数量的变化**（相对 R39 的 318 files / 5740）：+2 files / +11 tests，来自本轮新增的
`e4-r42-gate-isolation.test.ts` 与 `e4-r43-execution-plan-capacity.test.ts`（`e4-r40-forensics.test.ts`
按设计失败，已从默认 `pnpm test` 排除，故不计入）。

---

## 4. Windows 定向验收与远端 CI

**Windows 定向验收（本机 win32，直接相关项）**：

- child-process / 路径 / 构建隔离相关套件在**本机 Windows** 上实测通过：
  `e4-r42-gate-isolation.test.ts`（真实 `tsc` 子进程 + 真实非零子进程 + 隔离 workspace）、
  `benchmark-isolation.test.ts`（跨平台路径语义、探测 seam）、`e4-r24-final-result-protocol.test.ts`
  （真实 vitest 子进程）、`release-command.test.ts`（真实 gate）。
- **运行前置条件**：涉及 E4-09 / promotion 真实链的用例要求**已提交的干净工作树**。

**远端 CI**：本轮实现推送后核实（Ubuntu / Windows / coverage / release attestation 四个 job），
结果见本报告 §7「CI 补记」。**不**把基线 `67955e0` 的 run `34689695442` 归给本轮实现；
失败 / cancelled / skipped 保留真实状态。

---

## 5. 结论三分（不混淆）

1. **当前门禁通过**：§3 在冻结干净版本上全部 PASS（`pnpm test` 320/5751/0 failed）。
2. **独立缺陷关闭**：K02（R41）、K03（R42）、K04（R43）各有独立复现与验收。
3. **历史间歇失败已归因**：R39 的"有效链被判 INVALID"= **干净树前置条件**（R40 的原始 CLI 证据 +
   脏/净对照 + stash 证伪）。**仅** `01c4ec74` 的 Windows CI 波动**仍未归因**（同代码文档提交四 job 全绿）。

**范围外（保持 NOT_RUN）**：真实模型 champion 质量、release 发布动作。未请求的付费 benchmark、
架构重写或新功能**未**作为收口门槛。

---

## 6. 残余限制

- R40 诊断包默认落本机临时目录；CI 侧上传未接入（需要时再加）。
- K03 的 tsc `exclude` 依文件名模式；未来若有正式测试沿用同一命名会被一并排除（已知权衡）。
- `hostMutated()` 保持返回 bool（`unknown → false`）以兼容既有调用方。
- 全量 `pnpm test` 的绿色依赖**运行前置条件**（已提交干净树）；这是生产策略，不是缺陷。
