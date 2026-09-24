# E4-R54 报告：区分「没有 plan.md」与「无法读取 plan.md」

## 1. 问题（F54，P2；无依赖）

`apps/cli/src/docs-verify.ts` 的 E4-00 检查用一个无差别的 `catch` 把**所有** `readFile`
异常都解释成"文件不存在"：

```ts
let planExists = true;
try {
  planEntry = await readFile(join(root, "plan.md"), "utf8");
} catch {
  planExists = false;        // ← EACCES / EISDIR / EIO / 悬空链接 全部落到这里
}
if (!planExists) {
  checks.push({ truthful: true, reason: "no plan.md — no in-progress plan ..." });
}
```

于是 `plan.md` 是**真实目录**（EISDIR）、**不可读**（EACCES）、**I/O 错误**（EIO）或
**悬空链接**时，检查都进入"无进行中计划"的成功分支——用"存在"的证据，签发"不存在"的结论。
R50 收口引入的"无 plan.md 可诚实 PASS"本身是采用的行为，问题在于它的前提条件没有被真正
校验：只有**确实不存在**才能用这个理由。

## 2. 复现命令与修复前实际结果

复现命令（新增 3 例，位于既有 `docs-verify.test.ts` 的 E4-00 段）：

```
node_modules/.bin/vitest run apps/cli/src/docs-verify.test.ts -t "E4-R54"
```

**修复前实际结果**（临时 `git checkout` 回旧源码实测，退出码 1）：

```
 × E4-R54: plan.md that is a real DIRECTORY fails closed — never reported as 'no in-progress plan'
 × E4-R54: an injected EACCES / EIO on plan.md fails closed and preserves the real error code
 × E4-R54: a dangling-symlink entry (readFile ENOENT while the entry exists) fails closed
 AssertionError: expected true to be false   (×3)
 Test Files  1 failed (1)
      Tests  3 failed | 16 skipped (19)
```

三次失败都是 `expected true to be false`——旧实现把"目录当 plan.md""EACCES""EIO"
"悬空链接"一律判为 `truthful: true`。这正是计划 §1 记录的 F54 证据
（"真实创建 plan.md 目录后 truthful=true"）。

平台实测：本机 `readFile(dir)` → `code: EISDIR`、`lstat(dir)` 正常返回 `isDirectory()===true`。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/docs-verify.ts` | 修改：E4-00 保留真实错误码；只有真正 ENOENT 才可进入"无计划"分支；新增悬空链接判别；更新过时注释（+51 / −14 行） |
| `apps/cli/src/docs-verify.test.ts` | 修改：新增 3 个判别性负例 + 模块边界故障 seam（+119 行） |

要点：

1. 读取 plan.md 时保留 Node 错误 `code` 与 `message`（不再用裸 `catch {}`）。
2. **只有** `code === "ENOENT"` 且 `lstat` 也确认路径不存在时，才进入"无进行中计划"的
   PASS 分支——该理由的原文与既有断言保持一致。
3. 目录 / 不可读 / I/O 错误 → `truthful=false`，`reason` 为
   `plan.md could not be read (<CODE>): <message> — this is not 'no in-progress plan'`，
   **保留真实原因**。
4. **悬空链接**显式区分：悬空链接从 `readFile` 看也是 ENOENT，但入口**存在**（是坏链接）。
   用 `lstat` 作为判别器——`lstat` 成功说明入口在链接层面存在 → `truthful=false`，
   `reason` 明确写 `dangling symlink`；`lstat` 也 ENOENT 才是真正不存在。`lstat` 因其它
   原因失败同样 fail-closed，并带上该错误码。
5. 保留既有入口 marker、spec 引用与 spec 文件存在性校验；未把本次修复扩为计划体系重构
   （`plan.md` 未恢复、未放宽任何既有规则）。
6. 过时注释更新为与实现一致：明确"无计划可 PASS"**仅**适用于确实不存在的情形。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/vitest run apps/cli/src/docs-verify.test.ts` | 0 | **19 passed (19)**（16 例既有 + 3 例新增） |

| 用例 | 验收项（计划 §6「怎么验收」） | 关键断言 |
| --- | --- | --- |
| 既有：plan.md 真正不存在 | E4-00 通过，理由为不存在 | `truthful===true`、`reason =~ /no plan\.md — no in-progress plan/` |
| 新增 1 | plan.md 是真实目录：失败，不得出现 no in-progress plan 的成功理由 | `truthful===false`、`reason !~ /no plan\.md — no in-progress plan/`、`reason =~ /could not be read/` 且 `=~ /EISDIR/` |
| 新增 2 | 注入 EACCES/EIO：失败并保留原因 | `truthful===false`、`reason` 含 `EACCES` / `EIO`、不含 no-plan 理由 |
| 新增 3 | 悬空链接：失败 | 注入 ENOENT + 入口存在 → `truthful===false` 且 `reason =~ /dangling symlink/`；真实链接可创建时同样断言，不可创建时如实记录平台限制 |
| 既有：缺 marker | 维持失败 | `truthful===false`、`reason =~ /does not declare itself the current plan entry/` |
| 既有：无 spec 引用 | 维持失败 | `truthful===false`、`reason =~ /does not reference a detailed plan spec/` |
| 既有：悬空 spec | 维持失败 | `truthful===false`、`reason =~ /spec file is missing/` |
| 既有：有效入口 + 存在 spec | 通过 | `truthful===true` |
| — | 将读取异常统一改回不存在，新负例能发现回归 | §2 已实测：旧实现 3 failed |

## 5. testedSourceSha

- 基线提交（R54 开始时 HEAD）：`9bf7876e9beed1b9beb36560ffbedfdf654d2876`（R53 提交）
- 被测源码内容标识（`git hash-object`，提交前实测）：
  - `apps/cli/src/docs-verify.ts` = `d8ea2e34a05098d55198772a2c4800fb50c1d65a`
  - `apps/cli/src/docs-verify.test.ts` = `933bad5044ddc31d626e4872982da8adbed2a8f1`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 改动在本任务结束时**尚未提交**（见 §6）。

## 6. 未提交差异

```
 apps/cli/src/docs-verify.test.ts | 119 ++++++++++++++++++++++++++++++++++++++-
 apps/cli/src/docs-verify.ts      |  65 ++++++++++++++++++++++++----
 2 files changed, 170 insertions(+), 14 deletions(-)
```

外加本报告 `docs/E4-R54-report.md`。

## 7. NOT_RUN

- **未在仓库根运行真实 `pnpm docs:verify`**：该命令执行 `apps/cli/dist/main.js`，而 dist
  是构建产物，需先 `tsc -b` 重建才会包含本次源码改动；按计划在 R56 于干净已提交版本上
  统一执行 `pnpm typecheck` → `pnpm test` → `pnpm docs:verify`。
  预期行为：仓库根已无 `plan.md`（R50 收口），E4-00 应走"确实不存在"分支并 PASS。
- 未核实该版本远端 CI：本轮不推送，R56 记录。
- 未做付费评测、未自动发布、未强推、未改远端权限。

## 8. 残余限制

1. 证据级别是**单元/回归 + 模块边界故障注入**（`readFile` 注入 EACCES/EIO/ENOENT），
   真实 fs 与真实 fixture 目录参与，未声称完整 `verifyDocs` 已在真实仓库根跑过。
2. **`plan(<时间戳>).md` 的读取仍沿用 `.catch(() => false)`**（计划 §6 第 4 条明确要求
   不扩大修复范围）。因此一个"存在但不可读"的 spec 仍会被报成 `spec file is missing`。
   它只会让 E4-00 判 FALSE（fail-closed 方向安全，不会误报通过），但**原因描述不精确**。
   这是本任务有意保留的残余缺口，未顺手修，以免把修复扩成计划体系重构。
3. 悬空链接的真实创建在本机不可用（实测：`symlink(..., "file")` 返回成功却不创建任何
   条目）。因此该用例的主断言用**确定性签名注入**（`readFile` ENOENT + 入口存在）覆盖，
   真实链接分支仅在平台可创建时才执行，否则如实记录——不把平台限制伪装成绿色断言。
4. `lstat` 判别器只能区分"入口在链接层面存在 / 不存在"，无法进一步区分"坏链接"与
   "入口被其它进程并发删除"。后者会落在 fail-closed 分支，方向安全。
5. 本任务只动了 E4-00 检查，未触碰 E2-12 / E4-10 等其它检查。
