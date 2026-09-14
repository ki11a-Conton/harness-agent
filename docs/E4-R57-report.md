# E4-R57 报告：对齐 coverage 干净检出的构建前置条件

## 1. 问题（G57，P1）

CI run `34798344295` 的 `coverage gate (ubuntu)` job（ID `103835750948`）失败，日志明确指出
**测试断言失败**（不是覆盖率阈值）：

```
e4-r42-gate-isolation.test.ts 的 before snapshot 无效；
apps/cli/dist 和 node_modules/.cache/tsbuildinfo 均 ENOENT
```

根因是**测试前置条件与执行入口不一致**，而且是我上一轮 R53 引入的：

- R53 把 `apps/cli/dist` 与 `node_modules/.cache/tsbuildinfo` 定义为快照的 **required**
  受保护资源（`deepSnapshot(root, { mustExist: true })`），并对 `before.valid` 断言。
- `verify` job 的步骤顺序是 **install → `pnpm typecheck` → 测试**，所以有构建产物，ubuntu 通过。
- `coverage` job 的顺序是 **install → `pnpm test:coverage`**，**没有前置构建**，干净检出上
  两个根目录都不存在 → `before.valid === false` → 断言失败。

注意这不是"无法读取目录时应当放行"的场景：目录**本来应该存在**（后续 job 步骤
`node apps/cli/dist/main.js release gate coverage` 本身就要求 dist）。缺的是入口没保证构建。

## 2. 修复前复现（本地，与 CI 日志一致）

模拟干净检出（把两个构建产物移出仓库，二者均为 gitignored 构建产物）：

```
mv apps/cli/dist /tmp/r57-dist-backup
mv node_modules/.cache/tsbuildinfo /tmp/r57-tsbi-backup
node_modules/.bin/vitest run apps/cli/src/e4-r42-gate-isolation.test.ts
```

**修复前实际结果**（退出码 1）：

```
     × green AND real-nonzero child commands record consistent evidence; ...
     ✓ E4-R48 / N1 / N2 / N3 / N5 / N6 （6 例通过）
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)

AssertionError: before snapshot must be valid —
  lstat(<root>): ENOENT: ... 'D:\Harness Agent\apps\cli\dist';
  lstat(<root>): ENOENT: ... 'D:\Harness Agent\node_modules\.cache\tsbuildinfo'
  : expected false to be true
```

与 CI 日志的失败原因逐字对应（同一文件、同一断言、同两个 ENOENT 路径）。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `package.json` | 修改：`test` 与 `test:coverage` 前置 `tsc -b`（统一脚本入口） |
| `README.md` | 修改：本地入口说明改为"先 tsc -b，再测试"，并新增"先构建后测试的合同（E4-R57）"段落 |
| `README.zh-CN.md` | 同上（中文） |
| `.github/workflows/ci.yml` | 修改：**仅注释**（coverage job 里说明构建来自入口脚本，避免后人误加重复步骤或误删脚本里的构建） |

**选择"统一脚本"而不是"workflow 前置步骤"，理由**：

1. **一个地方定义，所有调用方一致。** 该入口有四个调用方：
   - CI coverage job 第 5 步 `pnpm test:coverage`；
   - CI coverage job 第 7 步 `node apps/cli/dist/main.js release gate coverage ...`
     —— `apps/cli/src/release-verify.ts:81` 把 `coverage` 门禁映射到**同一个**
     `pnpm test:coverage`；
   - `apps/cli/src/release-artifacts.ts:91` 的 `execFn("pnpm", ["test:coverage"])`；
   - README 记录的本地入口。
   把构建放进脚本，这四处自动同时满足；放在 workflow 步骤里只能覆盖第 5 步。
2. **修的是前置条件，不是放宽断言。** 没有降低 coverage 阈值、没有删除 `before.valid`
   断言、没有把不可读目录当作缺失、没有加"可选目录"分支。
3. **不重复构建。** `verify` job 仍显式 `pnpm typecheck` 再 `pnpm test`；`test` 内部的
   `tsc -b` 是增量空操作。避免了"既自动构建又到处加步骤"的双机制。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| 从**无 dist / 无 tsbuildinfo** 的工作区执行 `pnpm test apps/cli/src/e4-r42-gate-isolation.test.ts` | **0** | **7 passed (7)**；入口先 `tsc -b` 生成 `apps/cli/dist` |
| 已构建工作区执行同一测试 | 0 | 7 passed (7)（原断言全保留） |
| **构建失败注入**：向 `apps/cli/src/` 写入一个真实类型错误文件后执行同一入口 | **1** | tsc 报错；**vitest 完全未启动**（日志中 `Test Files` 计数为 0）→ 构建失败时门禁停止，不会出具 coverage 成功 |

对应的验收项：

| 验收项（计划 §3） | 结果 |
| --- | --- |
| 从无 dist、无 tsbuildinfo 的新副本执行声明的完整入口，结果通过 | ✅ 7/7，exit 0（修复前同入口 1 failed） |
| 前置构建若失败，门禁停止，不得仍出具 coverage success | ✅ 注入真实类型错误 → exit 1，vitest 未启动 |
| 已构建的工作区执行原测试仍通过 | ✅ 7/7 |
| 两次 EACCES、单侧读取失败、同名改写等 R53 负例仍失败 | ✅ N1（双 EACCES 判定 false）、N2（单侧 readdir/readFile/lstat）、N3（required/optional 合同）、N5（顺序扰动）、N6（链接策略）全部保留通过 |
| 真实 gate 只写自有 workspace；主仓资源保持合同要求的状态 | ✅ 原用例 1 的断言未改动（`green.gitSha` 属临时 workspace；`after.digest === before.digest` 且 `isolationVerdict` 通过） |
| `pnpm test:coverage` 在实际 CI 流程成功，coverage 阈值不变 | ⏳ **未在本任务内确认**：阈值未改动（`vitest.config.ts` 未触碰），实际 CI 成功需要推送后由 R61 核实 |
| 报告说明修改了 workflow 前置步骤 / 统一脚本 / 存在性合同，及原因 | ✅ 见 §3（选择**统一脚本**） |

## 5. testedSourceSha

- 基线提交（R57 开始时 HEAD）：`6af8857a73763627c6d312e24648b6b8763b9fbf`（与计划 §0 一致）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob |
| --- | --- |
| `package.json` | `fe0c82ad088eae550ba54722b7e115258622962b` |
| `README.md` | `2e11e4dccf43e86cca66d868224d407c9c798569` |
| `README.zh-CN.md` | `d4a75937588c540e514c6cec1d2a3c17dc78201a` |
| `.github/workflows/ci.yml` | `71e4d1e598a09e8d6df86f115dcfa6b262fb7c3b` |

- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 改动在本任务结束时**尚未提交**（见 §6）。

## 6. 未提交差异

```
 .github/workflows/ci.yml |  7 +++++++
 README.md                | 12 ++++++++++--
 README.zh-CN.md          | 10 ++++++++--
 package.json             |  4 ++--
 4 files changed, 27 insertions(+), 6 deletions(-)
```

## 7. NOT_RUN

- **未在真实 CI 上验证** coverage job 转绿：需要推送后由 R61 核实（本任务不推送）。
- **未执行完整 `pnpm test:coverage`**（约 10 分钟且本机沙箱会干扰）：本任务用"同一入口 +
  单文件过滤"验证了前置条件与短路行为；完整覆盖率运行留给 R61。
- 未下载/复核任何 CI artifact。
- 未做付费评测、未发布、未强推。

## 8. 残余限制

1. **`tsc -b` 现在位于 `test` / `test:coverage` 内部**，因此本地跑这两个命令会多一次构建
   （增量，通常很快）。这是有意的取舍：换取"入口自包含、四处调用方不会漂移"。
2. `test:watch` 未加构建（开发用途），因此在**完全未构建**的工作区直接 `pnpm test:watch`
   仍可能命中同一问题。未改是因为 watch 是交互式开发入口而非门禁。
3. 其余定向脚本（`test:protocol` / `test:security` / `test:race` / `test:chaos` /
   `test:perf` / `test:soak` / `test:forensics`）**不包含** `e4-r42-gate-isolation.test.ts`，
   故未加前置构建；若将来某个定向脚本纳入该套件，需要同步补上。
4. `verify` job 的显式 `pnpm typecheck` 与 `test` 内部的 `tsc -b` 现在是重复的（增量空操作）。
   保留显式步骤是为了让 job 名称 `install · typecheck · test · ...` 与实际步骤一致，
   且让"构建失败"在日志里有一个独立的失败步骤。
5. 本任务的证据是**本地**复现（同一断言、同一 ENOENT 路径，与 CI 日志逐字对应）+ 失败注入，
   不等于 CI 已转绿。
