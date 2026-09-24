# E4-R53 报告：将快照有效性与摘要相等分开

## 1. 问题（F53，P2；无依赖）

`apps/cli/src/e4-r42-gate-isolation.test.ts` 的 R48 深快照把读取失败编码成摘要里的
`ERROR:<code>` 标记，但**调用方只比较摘要**：

```ts
const before = await sharedBuildSnapshot();   // 返回 string
...
expect(await sharedBuildSnapshot()).toBe(before);   // ← 唯一的隔离结论来源
```

两次 `readdir` 都 EACCES 时，两次摘要**完全相等**（都是同一个错误标记串），于是
`toBe(before)` 通过——用"什么也没读到"的证据，签发了"共享资源未被改动"的结论。
**错误信息存在于摘要里，不等于调用方正确处理了错误。**

同一文件还有三处弱点：

- `stat` 会跟随符号链接，而注释声称"记录其他类型（symlink/fifo/block）"——代码实际
  什么都没记录，注释与实现不符；跟随链接还可能形成环。
- 资源存在性没有合同：必需目录缺失与"允许缺失"无法区分，都只是摘要里的一个标记。
- R48 的"枚举顺序"用例只做了**内容还原**，并未真正扰动 `readdir` 返回顺序——还原文件
  内容不等于验证过顺序扰动。

## 2. 复现命令与修复前实际结果

判别性负例已内置为 N1，并在同一用例中**直接证明旧比较逻辑会通过**：

```
node_modules/.bin/vitest run apps/cli/src/e4-r42-gate-isolation.test.ts -t "N1"
```

N1 的关键两行断言：

```ts
expect(before.digest).toBe(after.digest);          // 旧口径：摘要相等 → 会签发"未改动"
expect(isolationVerdict(before, after).ok).toBe(false);  // 新口径：有效性未过 → 拒绝
```

修复前（旧实现 + 旧比较）的真实结果是：`expect(after).toBe(before)` 通过，
隔离验收 **PASS**。这就是 F53 的判别力证据——同一输入下，旧口径给绿、新口径拒绝。

其它修复前行为（均为真实缺陷，非推测）：

- `readdir` 失败只产生 `ERROR:EACCES` 标记，`deepSnapshot` 不返回任何可检查的有效性；
- 必需根目录缺失与可选根目录缺失在摘要层面不可区分；
- 符号链接被 `stat` 跟随，注释承诺的"记录类型"未实现；
- 顺序用例只还原内容，未扰动枚举顺序。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r42-gate-isolation.test.ts` | 修改：快照改为可检查结构；隔离结论先验有效性再比摘要；`lstat` + 受控链接策略；新增 5 个判别性负例（+424 / −53 行） |

要点：

1. `deepSnapshot` 返回 `{ valid, digest, errors, absent, entryCount, entries }`。
   `errors` 每项为 `{ rel, op, reason }`（`op ∈ readdir | lstat | readFile | readlink`），
   **有路径、有操作、有原因**。`valid = errors.length === 0`。
2. `isolationVerdict(before, after)`：**先验证两份快照有效，再比较摘要**。任一侧无效即
   拒绝，并把无效原因（含路径与错误码）写进 `reason`。摘要相等不再是充分条件。
3. 资源存在性合同显式化：`deepSnapshot(root, { mustExist })`。共享构建资源
   （`apps/cli/dist` 与 tsbuildinfo 目录）声明为 **required**——把它们当作"允许缺失"
   等于把受保护集合悄悄缩成空集。允许缺失的资源进入 `absent` 列表，且 `absent` 参与摘要，
   因此"缺失"与"空目录"摘要**不同**，不会被混同。
4. 改用 `lstat`：符号链接被**记录而不跟随**（受控策略），并记录 `linkTarget`（改指向会改变
   摘要）。fifo/socket/device 记为 `other`，从不打开。不跟随是"自引用目录链接不可能无限
   递归"的根本原因，而不是靠深度上限兜底。
5. 保留同名覆写、嵌套修改、增删检测（原 R48 用例保留，只把返回值改为 `.digest`）。
6. 顺序用例改为**真正扰动**：故障 seam 反转 `readdir` 返回值，并断言
   `ioFaults.reorderedCalls === 2`——证明扰动确实执行了，而不是一个"空跑也绿"的用例。
7. 故障注入只作用于**本测试拥有的临时树**，通过 `node:fs/promises` 模块边界按绝对路径
   注入 EACCES；主仓目录从未被 chmod、从未被改动。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/vitest run apps/cli/src/e4-r42-gate-isolation.test.ts` | 0 | **7 passed (7)** |

| 用例 | 验收项（计划 §5「怎么验收」） | 关键断言 |
| --- | --- | --- |
| 原用例 1（保留） | 真实隔离 tsc 与真实非零 gate 继续通过；evidence SHA 属临时 workspace | `green.exitCode===0`、`red.exitCode===3`、`green.gitSha===ws HEAD`、`before.valid===true`、`after.valid===true`、`isolationVerdict === {ok:true,...}` |
| R48（保留） | 同名覆写、嵌套变化、增加、删除：摘要变化 | 四种操作 `digest !== s0`；内容还原后 `digest === s0` |
| N1 | before 与 after 都 EACCES：最终隔离验收不能 PASS | 两者 `valid===false`、**`digest` 相等**（旧口径会绿）、`verdict.ok===false` 且 `reason` 含 `invalid` |
| N2 | 单侧 readdir/readFile/stat 失败：有路径、操作和错误原因 | 三种 op 分别断言 `rel`（`sub` / `secret.js` / `secret.js`）、`op`、`reason =~ /EACCES/`；且失败不抹掉其它可读条目 |
| N3 | 必需根目录缺失失败；显式可选资源缺失遵守声明合同 | required → `valid===false` 且 `op==="lstat"`、`reason =~ /ENOENT/`；optional → `valid===true`、`absent===[root]`；且 `absent` 摘要 ≠ 空目录摘要 |
| N5 | 注入相反目录枚举顺序但字节相同：摘要一致 | `reorderedCalls===2`（扰动确已执行）、`entryCount` 相同、`digest` 相同 |
| N6 | 符号链接/目录链接：遵守受控策略且无无限递归；不支持的平台如实记录 | 链接记 `type==="link"` 且有非空 `linkTarget`；无 `self/…` 后代（未跟随，环不递归）；同目录普通文件仍正常快照 |

## 5. testedSourceSha

- 基线提交（R53 开始时 HEAD）：`9e884e6082a161e39060bcd5c4b118252642f069`（R52 提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：
  - `apps/cli/src/e4-r42-gate-isolation.test.ts` = `62c461e638f0bf131195be19c26498aa85ea779e`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 改动在本任务结束时**尚未提交**（见 §6）。

## 6. 未提交差异

```
 apps/cli/src/e4-r42-gate-isolation.test.ts | 477 +++++++++++++++++++++++++----
 1 file changed, 424 insertions(+), 53 deletions(-)
```

外加本报告 `docs/E4-R53-report.md`。本任务只改测试基础设施，**未改任何生产源码**。

## 7. NOT_RUN

- 未重跑全仓 `pnpm test` / `pnpm typecheck` / `pnpm docs:verify`：按计划在 R56 统一执行。
- 未核实该版本远端 CI：本轮不推送，R56 记录。
- 未做付费评测、未自动发布、未强推、未改远端权限。

## 8. 残余限制

1. 证据级别是**测试基础设施 + 故障注入**（模块边界注入 EACCES、反转 readdir 顺序）。
   真实 `tsc` 与非零子进程仍由原用例真实执行，未被弱化。
2. **平台实测发现（Windows 本机）**：`fs.symlink(target, path, "file")` 返回成功
   （无异常）却**没有创建任何条目**——`existsSync` 为 false、`lstat` 报 ENOENT、`readdir`
   里也没有它。因此 N6 的"已创建"集合按**可观测性**判定（`lstat().isSymbolicLink()`），
   而不是相信系统调用返回值；系统调用声称成功但不可观测时，断言该条目**不得**出现在快照里
   （不允许幽灵条目）。目录 junction 在本机可正常创建，N6 的实际链接策略由它覆盖。
   该限制在其它平台上可能不同，故不声称跨平台等价。
3. `mustExist` 的默认值是 `true`（更严格）。这改变了 `deepSnapshot` 对"根目录缺失"的既有
   宽容行为；共享构建资源已显式声明为 required，若未来新增受保护根目录，必须同时声明合同，
   否则会以 `valid:false` 明确失败——这是有意的失败方向。
4. `errors` 目前不区分"读取失败"的严重度等级；所有错误一律使 `valid=false`。对"允许部分
   失败"的场景（本套件没有）需要另行声明合同。
5. 符号链接的 `linkTarget` 只在 `readlink` 成功时记录；`readlink` 失败会同时产生一个
   `readlink` 错误（使 `valid=false`），不会静默产生空目标。
