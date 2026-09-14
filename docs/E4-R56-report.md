# E4-R56 报告：固定版本验收与停止维护循环

## 1. 本轮范围与版本绑定

- 计划审查基线 `reviewedSourceSha`：`79cba18ecdadb701fc57edb0c0dcf44447178da8`
  （本轮开始时远端 `main` 与本地 HEAD 均已对齐到该 SHA，工作树仅有一份**仓库外**计划文件）。
- 本轮验收版本（本报告绑定的 HEAD）：**`c9ccfe07a94853cb7b94023050537eb39ef91041`**
- 本轮提交共 **13** 个，全部为 R51–R56 的实现/测试/报告提交：

| # | SHA | 内容 |
|---|---|---|
| 1 | `4be74bd` | R51 实现 + 回归套件 + 报告（F51） |
| 2 | `9e884e6` | R52 实现 + 回归套件 + 报告（F52） |
| 3 | `9bf7876` | R53 测试基础设施 + 负例 + 报告（F53） |
| 4 | `9a86dbb` | R54 实现 + 回归套件 + 报告（F54） |
| 5 | `71f2317` | R55 共享真实接线抽取（前置） |
| 6 | `14edb86` | R55 隔离子夹具 + 专用 config |
| 7 | `3b20330` | R55 父验证程序 + 顺序变异反向对照 |
| 8 | `2110dcf` `90fea4a` `d547cd2` `c5c96d6` | R55 变异实现修正（4 个连续小修） |
| 9 | `32f54a8` | R55 报告 + R45/R50 带日期补记 |
| 10 | `c9ccfe0` | R56：改写 R54 注释，避免触发 P14-6 静态扫描 |

**版本归属声明**：本报告只归属 `c9ccfe0` 的本地门禁结果。R50 报告中的
`440b2895` / `109cc5e6` 结果**不属于**本版本（见 §7）。

## 2. F51–F55 关闭矩阵

| ID | 复现（修复前实测） | 修复 | 能抓住旧实现的断言 | testedSourceSha（blob） | 真实结果 |
|---|---|---|---|---|---|
| **F51** | `e4-r51-read-settle.test.ts` 对**未改动**源码：**5 failed / 1 passed**，5 例断言均为 `captureFailure never settled` | `readArtifact` 改为单一 settle-once 完成协议（error/end/提前 close 各有终态；close 在 end 后不翻案） | 6 例：异步 EIO、部分 data 后 error、close 先于 end、正常完成一次、失败+成功混合、原始异常保留 | src `b4ac6c17…` / test `2068356c…` | **6 passed (6)**；回退旧实现 → 5 failed |
| **F52** | `e4-r52-raw-bytes.test.ts` 对未改动源码：**3 failed / 1 passed**；`fffe0061`(4B) → `efbfbdefbfbd0061`(8B)，摘要不匹配副本 | 副本一律按**字节**落盘；`truncated = headUsed < total`；新增 `statBytes`/`sourceChangedDuringRead`；`headText` 仅用于摘要 | 4 例：非 UTF-8 逐字节一致 + 双摘要独立复算、CJK/非法 JSON/空文件、cap±1 边界（含跨界多字节字符）、stat 后源变长不再声称完整 | src `78968da4…` / test `c3091267…` | **4 passed (4)**；R47 既有 6 例零改动通过 |
| **F53** | N1 在旧口径下：两次 EACCES 的**摘要相等** → `toBe(before)` 通过 → 隔离验收 PASS | 快照改为 `{valid,digest,errors,absent}`；`isolationVerdict` **先验有效性再比摘要**；`lstat` + 受控链接策略 | 5 例：N1 双 EACCES（摘要相等但判定 false）、N2 单侧 readdir/readFile/lstat 失败带路径+操作+原因、N3 required/optional 合同、N5 真实反转 readdir 顺序摘要一致（`reorderedCalls===2`）、N6 链接记录不跟随无递归 | test `62c461e6…` | **7 passed (7)**（含原 2 例） |
| **F54** | `docs-verify.test.ts -t E4-R54` 对旧源码：**3 failed / 16 skipped**，全部 `expected true to be false`（目录/EACCES/EIO/悬空链接被判 truthful=true） | 保留真实错误码；只有真正 ENOENT 且 `lstat` 确认不存在才进"无计划"分支；悬空链接用 `lstat` 判别 | 3 例：plan.md 为真实目录、注入 EACCES/EIO、悬空链接签名 | src `d8ea2e34…`（注释改写后为 `c9ccfe0` 版本）/ test `933bad50…` | **19 passed (19)** |
| **F55** | R45 的 A/B/C/E 四例在生产顺序变异下**全部仍绿**（验收绑定 recorder 而非接线） | 生产接线抽为共享模块；父验证程序 spawn 隔离子进程跑真实链；顺序变异用**临时副本** | 父验证 1 例：真实非 ACCEPT 决策+reasonCodes、副本摘要自洽且子进程退出后仍可读、注入异常被标注、benchmark 前置失败、成功链零 bundle、**变异副本使同一验收失败** | src `1e6ea1bf…`、父 `31cf8413…`、子 `394fd9fa…`、config `d65ec628…` | **1 passed**（134 s，含 2 次真实子进程） |

## 3. 定向套件（顺序执行，均在本版本上）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `vitest run apps/cli/src/e4-r51-read-settle.test.ts` | 0 | 6 passed |
| `vitest run apps/cli/src/e4-r52-raw-bytes.test.ts` | 0 | 4 passed |
| `vitest run apps/cli/src/e4-r47-bounded-copy.test.ts` | 0 | 6 passed（R52 未破坏既有字节语义） |
| `vitest run apps/cli/src/e4-r42-gate-isolation.test.ts` | 0 | 7 passed |
| `vitest run apps/cli/src/docs-verify.test.ts` | 0 | 19 passed |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts` | 0 | 1 passed |
| `vitest run apps/cli/src/e4-09-production-e2e.test.ts` | 0 | 5 passed（共享接线重构后干净树复验） |
| `vitest run packages/security packages/harness/src/security-regression-matrix.test.ts` | 0 | **18 files / 2133 passed** |

## 4. 全量门禁（本版本、干净已提交、运行期间静止）

| 门禁 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 类型检查 | `tsc -b` | **0** | 全仓 tsc -b 无错误 |
| 文档验证 | `node apps/cli/dist/main.js docs:verify` | **0** | **ALL CHECKS PASS**（含 E4-00「no plan.md — no in-progress plan」） |
| 全量测试 | `vitest run --exclude …（与 `pnpm test` 同口径）` | **1** | **316 files passed / 10 failed；5770 passed / 15 failed / 1 skipped** |

### 4.1 全量测试 15 项失败的逐条归因

失败**不是**本轮改动的回归，逐簇归因如下（每条都有独立复验）：

| 簇 | 文件 | 项数 | 归因 | 独立复验 |
|---|---|---|---|---|
| A | `packages/security/src/no-silent-catch.test.ts` | 1 | **本轮自身回归**：R54 的注释里出现了字面量 `` `catch {}` ``，被 P14-6 静态扫描命中 | 已改写注释；复跑 **4 passed (4)** |
| B | `apps/cli/src/benchmark-command.test.ts` | 1 | 并发脏树：`packages/evaluation/src/mining.test.ts` 在**仓库根**建 `.tmp-mining-*` 且未 gitignore，并发窗口内让 promotion benchmark 见脏树拒跑 | 干净树复跑 **67 passed (67)** |
| C | 6 个符号链接套件（canonical-path / adversarial-regression / security-regression-matrix / promotion-envelope-forgery / exec-workspace-policy / exec-workspace-root-alias） | 6 | 代理沙箱阻止创建符号链接（`symlink` 抛 EPERM） | 6 文件复跑 **87 passed (87)** |
| D | `apps/cli/src/e4-r24-final-result-protocol.test.ts` | 6 | 代理沙箱 safe-delete 垫片拦截 `fs.rm`：`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":76,"threshold":50}`，测试的 `cleanupFixture()` 被拒 | 复跑复现同一垫片错误（环境性，非仓库缺陷） |
| E | `apps/cli/src/release-command.test.ts` | 2 | 代理沙箱程序黑名单拦截 `wmic.exe`，`runGate` 的真实命令因此非零退出 | 复跑复现同一 `wmic.exe` 拦截 |

结论：**B–E 共 14 项均为代理运行环境（沙箱垫片 / 程序黑名单 / 符号链接限制 / 并发瞬态脏树）造成，与本轮改动无关**；A 是本轮唯一真实回归，已修复并复验。本轮自身新增/改动的 6 个套件在全量并发运行中**全部通过**（含 R55 的 183 s）。

## 5. CI 核实

| 项 | 状态 |
|---|---|
| 该实现版本的远端 CI | **NOT_RUN** —— 本轮**未推送**（计划 §2 第 6 条：不自动发布、不强推、不改远端权限），故 `c9ccfe0` 及本轮 13 个提交在远端**不存在**任何 CI run。 |
| 需要核实的 job（供后续推送后核对） | `.github/workflows/ci.yml` 的四个 job：`verify`（Ubuntu/Windows 矩阵）、`coverage gate (ubuntu)`、`release attestation` |
| 该实现版本的 CI head SHA / run ID / attempt | **NOT_RUN**（不存在） |
| artifact 内容重放 | **NOT_RUN** —— 未下载、未逐字节复核任何 release artifact |
| `440b2895` / `109cc5e6` / `34762901299` 等历史结论 | **不得归属本版本**（见 §7） |

## 6. 验收结论

| 验收项（计划 §8「怎么验收」） | 结果 |
|---|---|
| F51：读取错误不挂起，原始失败可见 | ✅ 6/6；旧实现 5 failed |
| F52：副本字节、大小、摘要真实一致 | ✅ 4/4；旧实现 3 failed |
| F53：无效快照不被相等断言认证 | ✅ 7/7；旧口径下 N1 会 PASS |
| F54：存在但不可读的计划入口不被当作不存在 | ✅ 19/19；旧实现 3 failed |
| F55：真实失败接线和反向变异验收完成 | ✅ 1/1；变异副本使同一验收失败 |
| 类型检查 | ✅ exit 0 |
| 全量测试 | ⚠️ **不能判定通过**：15 项失败中 14 项为代理沙箱环境所致、1 项为本轮回归已修复并复验。**未在本机取得"0 failed"的全量结果**，故不声称全量门禁通过。 |
| 文档验证 | ✅ ALL CHECKS PASS |
| 必需 CI | **NOT_RUN**（未推送） |
| NOT_RUN / 平台限制 / 未归因历史问题单独保留 | ✅ 见 §5、§7、§8 |
| 无自动发布 / 无付费模型调用 / 无与本轮缺陷无关的 Runtime 重写 | ✅ 本轮只改 `apps/cli` 的诊断采集与文档校验 + 测试基础设施；未触碰 Runtime、权限、沙箱、验证架构 |

## 7. R50 报告 §8 的版本说明更正（计划第 8 条）

已在 `docs/E4-R50-report.md` 追加 §10「补记（2026-09-14，E4-R55）」：

- 实测 `109cc5e6` 是 `440b2895` 的**祖先**，且 `440b2895` 修改了
  `apps/cli/src/e4-09-diagnostics.ts`（+5 行）。因此 §8 的"与 `109cc5e6` 逐字节相同"
  只在 `109cc5e6` 之后、`440b2895` 之前的窗口内成立，**该窗口已关闭**；
  `109cc5e6` 的 CI 结论不可归属后续版本。历史事实（当时确实存在过该纯文档提交窗口）
  予以保留。
- 同时下调关闭矩阵中 R45 一行的**证据等级**（单元测试未绑定生产接线），
  修复结论不变。

`docs/E4-R45-report.md` 亦追加 §8 补记，更正其三处过强表述（详见 `docs/E4-R55-report.md` §5）。

## 8. NOT_RUN 与残余限制

1. **全量 `pnpm test` 未取得绿色**：如上，14 项失败源于代理沙箱，1 项为本轮回归已修复。
   在**干净检出且无沙箱拦截**的环境（例如 CI 的 Ubuntu/Windows runner）上，本报告不声称
   结果，必须由推送后的真实 CI 判定。
2. **远端 CI 全部 NOT_RUN**：本轮不推送。计划允许"收尾纯文档提交不必无限追踪自己的下一次
   CI"，但本报告明确区分：本轮 13 个提交**包含代码与测试改动**，因此**不能**按"纯文档提交"
   处理，必须由推送后的 CI 覆盖。
3. **未做 artifact 内容重放**：未下载 release attestation / coverage evidence 做逐字节复核。
4. **平台限制（已实测，均为环境而非仓库缺陷）**：
   - `symlink(..., "file")` 在本机沙箱下抛 EPERM；非沙箱调用下可正常创建（同一进程不同
     invocation 表现不同，说明是沙箱策略而非文件系统缺陷）。
   - 代理沙箱 safe-delete 垫片在单"turn"内第 50 次 `fs.rm` 后拒绝执行。
   - 代理沙箱程序黑名单拦截 `wmic.exe`。
5. **R55 父验证要求干净工作树**（生产语义：promotion-eligible 运行需可证明干净的源树）。
   本地未提交时 `pnpm test` 会因该用例失败；CI 干净检出不受影响。已在该用例开头显式检查
   并给出可读原因。
6. **R54 有意保留的缺口**：`plan(<时间戳>).md` 的读取仍用 `.catch(() => false)`，
   故"存在但不可读"的 spec 仍会被报成 `spec file is missing`（fail-closed 方向安全，
   仅原因描述不精确）。计划明确要求不扩大修复范围。
7. **R55 变异只覆盖一种顺序缺陷**（decision 落盘移到断言之后），"注册前移"的变异未做。
8. **未归因的历史遗留**：`packages/evaluation/src/mining.test.ts` 在仓库根创建
   `.tmp-mining-*` 且未被 `.gitignore` 覆盖，并发下会让 promotion benchmark 见脏树
   （本报告 §4.1 簇 B 的直接成因）。这是**本轮之前就存在**的缺口，未在本轮修复
   （不属于 F51–F55），建议下一轮按 R46 同口径 gitignore 或改用外部输出目录。

## 9. 收尾

F51–F55 的具体缺口已关闭并有可复现证据。按计划 §9，**停止本轮维护**，不主动制造新功能任务。
若下一步目标是提升 Agent 实际任务完成率，应另立策略层计划（用户场景 → 失败簇 → 假设 →
challenger → paired evaluation → 预算）；本轮**没有真实模型质量证据**，不宣称 champion
质量已提升，也不把付费评测作为交付门槛。
