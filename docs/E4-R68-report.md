# E4-R68 报告：补齐混合复制失败与链接跳过的确定性验收

## 1. 问题（J68，P2，验收缺口；依赖 R67）

R65 的测试**没有证明**两件事，而其中一条还会**显示为通过**：

1. **"同一棵树里一份复制成功、另一份失败"从未构造过。** R65 的 D 用例用**普通文件代替目录**
   制造 `ENOTDIR`，覆盖的是"根目录读取失败"，不是"同一棵树内部分成功、部分失败"。
2. **"链接跳过分支确实执行"无法从测试结果得知。** R65 的 F 用例在**无法创建链接**时执行
   **较弱的断言然后正常 `return`** —— 该条**仍然显示 `passed`**。也就是说：
   绿色结果**不能**推出 skipped 分支被执行过。

本任务**以测试改动为主**，不预设 `copyTree` 有实现缺陷（计划 §4）。实测结论见 §5：
**没有发现新的生产实现错误，`copyTree` 的复制/分类逻辑未作任何修改**；
唯一的生产改动是给测试 seam 增加一个 `readdir` 覆盖点（§3.1）。

## 2. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | 修改（**+11 / −3**）：`EvidenceSeam` 增加可选 `readdir`；`copyTree` 通过它取目录列表。**复制与分类逻辑一行未改。** |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改（**+295**）：新增 R68 套件（7 例）与一个**模块级能力探针**；R65 的 D/F 保留原样（仍通过） |

### 2.1 为什么增加 `readdir` seam（而不是靠权限或竞争）

计划 §4.2 要求"建立受控 copyFile seam 或隔离子进程 I/O 注入……**不要靠随机 chmod 或竞争删除**
制造不稳定失败"。而计划 §4.5 又要求一个"**无平台权限依赖的确定性分支测试**"。

本机沙箱**无法创建符号链接**（且实测 `fs.symlink` 有时是**静默 no-op**：不抛错也不创建），
因此"用真实链接测跳过分支"在本机不可行。`readdir` seam 同时解决两件事：

- **确定性分类**：测试可以直接给出一个"既非目录、也非普通文件"的 `Dirent`，
  从而**不依赖任何平台权限**就走到 skipped 分支；
- **确定性顺序**：遍历顺序被固定，于是"靠前的文件失败"与"靠后的文件失败"成为**可证明**的用例，
  而不是依赖文件系统返回顺序的偶然结果。

它**只**替换"列目录"与"复制一个文件"两个操作；真实文件仍然是**真复制**（走真实 `copyFile`）。

## 3. 证据层级（计划 §4.8 要求逐条列出）

| 用例 | 真实进程 / 真实 I/O | seam 注入 | 本机是否执行 |
|---|---|---|---|
| A 混合：一份真成功 + 一份 EIO 失败 | ✅ 真实文件、真实 `copyFile` 复制成功那份；失败那份由注入抛 EIO | `copyFile` | ✅ |
| B 删源后仅凭归档恢复 | ✅ 同 A，且**删除源目录**后只读 `run.json` | `copyFile` | ✅ |
| C 靠前文件失败 | ✅ 真实复制 b/c；`readdir` 顺序被固定 | `readdir` + `copyFile` | ✅ |
| D 靠后文件失败 | ✅ 真实复制 a/b；`readdir` 顺序被固定 | `readdir` + `copyFile` | ✅ |
| E **确定性跳过分支** | ✅ 真实文件 `real.json` 真复制；非普通条目为**构造的** `Dirent` | `readdir` | ✅（分类逻辑真实执行；条目本身是合成的） |
| F 能力探针 | ✅ 真实 `mkdtemp`/`symlink`/`lstat` | 无 | ✅ |
| G **平台真实链接** | ✅ 真实 `symlink` + 真实 `lstat` 前置条件 | 无 | ❌ **显式 skip**（能力探针为 false） |

**本机实测的能力探针输出**（来自 F 用例，运行期打印）：

```
R68_SYMLINK_CAPABILITY={"ok":false,"detail":"fs.symlink did not throw but created no link (silent no-op)"}
```

即：**本机没有真实执行链接分支**，G 用例被 **`it.skipIf` 显式跳过**（vitest 记为 `skipped`，
**不是** `passed`）。这正是计划 §4.6 要求的处理方式——**不把较弱的断言当作该链接测试通过**。
真实链接分支由**支持符号链接的 CI runner**执行（Ubuntu 必然；Windows 见 §6.2），R69 核实。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 类型检查通过 |
| `vitest run … -t "R68"` | **0** | **6 passed \| 1 skipped**（51 skipped by filter） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整，干净树） | **0** | **56 passed \| 1 skipped (57)**，111.43 s |

逐条对应计划 §4「怎么验收」：

| 验收项 | 用例与断言 | 结果 |
|---|---|---|
| 一个真实复制成功、一个注入失败，源删除后归档仍同时证明成功与失败 | A + B：`copied=["good.json"]`、`entries` 有 `bad.json`；**删源后**归档里 `good.json` 仍可读、`sha256` **独立复算一致**，`bad.json` 的 `EIO` 仍可恢复 | ✅ |
| EIO 原因可从 `run.json` 恢复，`operation=copyFile`，路径对应目标文件 | A：`bad.json` → `status=unreadable`、`operation=copyFile`、`errorCode=EIO`、`reason` 含注入原因 | ✅ |
| 失败项不出现在 `copied`/`files` 中；成功项的字节摘要独立复算一致 | A：`copied` 不含 `bad.json`，`files` 不含 `diagnostics/bad.json`；B：`sha256` 复算一致 | ✅ |
| 分别让排序靠前/靠后的文件失败，结果符合相同合同 | C（失败 a.json，靠前）→ `copied=["b.json","c.json"]` 且 b/c 可读；D（失败 c.json，靠后）→ `copied=["a.json","b.json"]` 且 a/b 可读；**两者都记录失败项与 `partial`**；`attempted` 断言遍历顺序确为 `[a,b,c]` | ✅ |
| skipped 非普通文件不被读取内容，不跟随循环或外部目标 | E：`ghost.link` **不在** `copied`、**不在** `files`、**磁盘上没有** `diagnostics/ghost.link`，只出现在 `entries` 且 `status=skipped`、`reason` 含 `not followed` + `symbolic link` | ✅ |
| 真实链接分支在至少一个 CI runner 实际执行，不是无条件 `return` 或整段被跳过 | 本机为 **显式 skip**；G 用 `it.skipIf(!capability.ok)`，并在**执行时**先断言 `lstat(link).isSymbolicLink()` 前置条件，再按平台自身的 `dirent` 分类断言。**待 R69 在 CI 核实** | ⏳ 见 §6.2 |
| 恢复旧"没有错误清单"的归档形状，新混合场景验收失败 | §5：**5/6 失败**（A、B、C、D、E） | ✅ |
| 若没有发现新的生产实现错误，不为了任务产出额外修改 `copyTree` | ✅ 未修改复制/分类逻辑；只加了 seam 取数点 | ✅ |
| 保留"不跟随链接是策略，不自动降低常规文件复制完整性"的现有合同；清单必须让调用者看见跳过的内容 | E：`skipped` 仍在 `entries` 里可查，而 `diagnostics.integrity` 与 `archive.integrity` **都仍是 `complete`** | ✅ |

### 4.1 保留的 R65 用例

计划 §4.1 要求保留根目录 `ENOENT`、`ENOTDIR`、全部成功三组用例——**原样保留且仍通过**
（R65 的 A–I 共 9 例在本轮完整运行中全绿）。

## 5. 判别力（恢复旧"没有错误清单"的归档形状）

把 `copyTree` 改回"复制失败只记日志、跳过的条目混进 copied 列表"：

```
× A: in ONE tree a real copy SUCCEEDS while an injected EIO copy FAILS
× B: after the SOURCE is deleted, the archive alone still proves success AND failure
× C: a failure on the FIRST-visited file does not block the LATER copies
× D: a failure on the LAST-visited file does not lose the EARLIER copies
× E: the SKIP branch itself — a non-regular entry, deterministically, with no symlink privilege
     Tests  5 failed | 1 passed | 51 skipped (57)
```

只有 F（能力探针）仍通过——它断言的是"环境是否支持真实符号链接"，**不依赖归档形状**，
这是预期的。随后已从备份恢复：`6 passed`、`tsc -b` 退出码 0。

## 6. 关于"至少一个受支持 CI runner 真实执行链接分支"

### 6.1 本机

**未执行**：能力探针为 `false`（`fs.symlink` 静默 no-op），G 被 `it.skipIf` 显式跳过。
本报告**不**把 E 用例（合成 `Dirent` 的分类测试）当作"真实链接分支已执行"的证据——
E 证明的是**分类逻辑**，不是**平台集成**。

### 6.2 CI（待 R69 核实）

G 在 CI 上**会执行**（不被 skip），并且它会**打印平台自身的分类结果**：

```
R68_LINK_DIRENT={"isSymbolicLink":<bool>,"isFile":<bool>}
```

若某平台**不把链接报告为链接**（`isSymbolicLink=false`），G 不会伪造通过，而是断言该平台的
**真实行为**（链接被当作普通文件处理），并把这一事实打印出来。因此：
**Ubuntu 上必然走"跳过"分支**（`uv_fs_scandir` 报 `UV_DIRENT_LINK`）；Windows 的归属由该行输出决定，
**不作假设**。R69 必须读取该输出才能下结论。

## 7. testedSourceSha

- 基线提交（R68 开始时 HEAD）：`0157d90`（R67 报告提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob（工作树） |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | `e1937ae47ef4fcbf480a16624234d2c169c9426a` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `3129434002fc57b6f2f6fb33cc1487e8312f5399` |

- 实现提交：`afeb3e5`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)，**符号链接不可用**

## 8. NOT_RUN

- **真实链接分支未在本机执行**（显式 skip，§6.1）。
- 未在真实 CI 上验证（留给 R69）。
- 未做付费模型调用、未发布 release、未强推。

## 9. 残余限制

1. **E 用例的非普通条目是合成的 `Dirent`。** 它确定性地证明**分类分支**，
   但**不**证明真实文件系统上的链接会被这样报告——后者由 G（CI）承担。两者互补，不可互相替代。
2. **G 的平台分支由该平台自身的 `readdir` 分类决定**，测试不强行要求"必须是 skipped"。
   这是刻意的：在不把链接报告为链接的文件系统上，`copyTree` **无法**表达"不跟随"策略，
   把这种平台判为失败会掩盖真实差异；测试改为**断言并打印**该平台的实际行为。
3. **C/D 的遍历顺序由 seam 固定**，因此"靠前/靠后"是确定性构造，不是文件系统的自然顺序。
4. `readdir` seam 只能替换"列目录"；不能伪造 `mkdir` 失败或根目录不可用
   （那两条路径由 R65 的既有用例覆盖）。
5. 本任务**未**修改 `copyTree` 的复制/分类逻辑（计划 §4 要求），也未触碰 R67 的两层完整性语义。
