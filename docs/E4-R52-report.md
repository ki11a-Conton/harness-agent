# E4-R52 报告：保存真实原始字节并校验副本摘要

## 1. 问题（F52，P2；依赖 R51）

`apps/cli/src/e4-09-diagnostics.ts` 的小文件分支把**文本**当成副本来源：

```ts
const text = read.headText ?? "";        // headText = head.toString("utf8")
await writeFile(target, text, "utf8");   // ← 再编码回 UTF-8
```

`headBytes` / `headDigest` 却是按**原始字节**算的。于是任何非 UTF-8 源都会被静默转码，
而记录仍声称"这就是原始字节"：

```
source      : fffe0061 (4 bytes)
after round : efbfbdefbfbd0061 (8 bytes)     ← 两个 U+FFFD
equal?      : false
sha(source) : 5f210d5e4547399c
sha(copy)   : 89502cc1c784f581
```

（上面是独立于仓库代码、用 `node -e` 复算的结果。）`headBytes` 仍写 4、`headDigest`
仍是源字节摘要——**记录的摘要可证明地不描述它自己的副本**。会撒谎的证据比没有证据更糟。

同文件还有第二个缺陷（计划 §4 第 5 条）：`cap` 由**初次 `stat().size`** 决定，而
`truncated` 由**流式读到的 `total`** 决定。stat 之后文件变长时会出现
`sourceBytes > headBytes` 且 `truncated === false`——一条声称"完整采集"、副本却缺尾部的记录。

## 2. 复现命令与修复前实际结果

复现文件：`apps/cli/src/e4-r52-raw-bytes.test.ts`（新增，4 例）。

```
node_modules/.bin/vitest run apps/cli/src/e4-r52-raw-bytes.test.ts
```

**修复前实际结果（退出码 1）**：

```
 Test Files  1 failed (1)
      Tests  3 failed | 1 passed (4)
```

- 例 1/2（`fffe0061` 副本字节一致）失败：`expected false to be true`（`copy.equals(src)`）；
- 例 4（cap−1/cap/cap+1 边界）失败：截断边界处的半截多字节字符被转码；
- 例 5（stat 后源变长）失败：`truncated` 被写成 `false`，记录宣称完整却只有 10/60 字节；
- 例 3（合法 CJK / 非法 JSON / 空文件）修复前也通过——合法 UTF-8 恰好是唯一不受该缺陷
  影响的输入，这本身说明缺陷的触发条件是"非 UTF-8 字节"。

例 5 的注入点只在 I/O 边界：文件真实存在（`stat` 返回真实的 10 字节），读流被替换为一个
真实的 `Readable`，实际吐出 60 字节。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-diagnostics.ts` | 修改：副本一律按**字节**落盘；`truncated` 改为按读取事实判定；新增 `statBytes` / `sourceChangedDuringRead`（+59 / −42 行） |
| `apps/cli/src/e4-r52-raw-bytes.test.ts` | 新增：原始字节保真与副本一致性回归套件（4 例，含边界与注入场景） |

要点：

1. `BoundedRead.headBuf` 现在对**每种尺寸**都产出，且恰好是 `headBytes` 个字节；
   `captureFailure` 统一 `writeFile(target, read.headBuf)`，不再有 `"utf8"` 写回分支。
2. `headText` 语义收窄并写进类型注释：**仅供内联 JSON 摘要解码**，永不参与副本生成；
   且只在副本就是整份内容（未截断）时才产出。
3. `truncated` 改为 `headUsed < total`——"副本是实际读到的字节的**严格前缀**"。这一个
   谓词同时覆盖超限截断与"stat 后源变长"，且 `false` 现在真的意味着"副本就是全部源"。
4. 新增 `statBytes` 与 `sourceChangedDuringRead`，把 stat/流的尺寸分歧变成**显式事实**，
   而不是留给读者从别的字段去推断。
5. `sourceBytes` 语义澄清为"实际读到的字节数"（流式计数），不再与初次 stat 混淆。
6. 非法 JSON：**保留真实原始字节**，`captured=true`，记 `parseError`；不会因解析失败丢掉
   artifact，也不会把解析失败写成"文件缺失"。
7. 内存仍有界：只有受限 head（≤ `MAX_COPY_BYTES`）被物化，`sourceDigest` 继续流式计算，
   没有退回整文件 `readFile`。

**消费者核查（计划 §4 第 7 条）**：`headText` / `headBuf` / `headBytes` / `headDigest` /
`sourceBytes` / `sourceDigest` / `truncated` 的引用全部落在本模块与 `e4-r47`、`e4-r51`
两个测试内；`packages/context`、`packages/tools` 里的同名 `truncated` 是无关模块的字段。
没有外部消费者，且 `truncated` 的变化方向是**更准确**而非不兼容，故未做 schema 版本升级。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/vitest run apps/cli/src/e4-r52-raw-bytes.test.ts` | 0 | **4 passed (4)** |
| 同次运行 R47（6 例）+ R51（6 例） | 0 | **16 passed (3 files)**，R47 既有断言零改动 |

| 例 | 验收项（计划 §4「怎么验收」） | 关键断言 |
| --- | --- | --- |
| 1/2 | `[0xff,0xfe,0x00,0x61]` 复制后完全相同，actual length=4；副本 SHA-256 = headDigest，源 SHA-256 = sourceDigest | `copy.equals(src)`、`copy.byteLength === 4`、`headDigest === sha256(copy)`、`sourceDigest === sha256(src)` |
| 3 | 合法中文 UTF-8 / 小文件非法 JSON / 空文件各自语义正确 | CJK 副本逐字节相等且 `summary.msg === "中文内容"`；非法 JSON `captured===true` + `parseError` + 副本字节相等；空文件 0/0/`truncated===false` |
| 4 | cap−1、cap、cap+1 边界正确；多字节字符跨截断边界按字节保存、不补写替换字符 | 三者 `sourceBytes`/`truncated`/`headBytes` 正确；`copy.equals(buf.subarray(0,kept))`；`copy` 不含 `EF BF BD`；截断例中 `copy[CAP-1] === 中[0]`（证明切口确实落在 3 字节字符中间） |
| 5 | 初次 stat 小于最终读入长度时，不再出现"完整"却缺尾部的记录 | `sourceBytes===60`、`headBytes===10`、**`truncated===true`**、`copy.equals(grown.subarray(0,10))` |
| — | 恢复字符串写回，新非法 UTF-8 回归测试失败 | §2 已实测：旧实现 3 failed |

## 5. testedSourceSha

- 基线提交（R52 开始时 HEAD）：`4be74bdd5d00e2fdc0e2bdca1a7c5a019b9c4c09`（R51 提交）
- 被测源码内容标识（`git hash-object`，提交前实测）：
  - `apps/cli/src/e4-09-diagnostics.ts` = `78968da427c16fe0c66359e86ba3565da628b539`
  - `apps/cli/src/e4-r52-raw-bytes.test.ts` = `c30912674da7295453239ebcec43e87951dfd697`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。
- 改动在本任务结束时**尚未提交**（见 §6）。

## 6. 未提交差异

```
 apps/cli/src/e4-09-diagnostics.ts | 101 ++++++++++++++++++++++----------------
 1 file changed, 59 insertions(+), 42 deletions(-)
```

外加新增未跟踪文件 `apps/cli/src/e4-r52-raw-bytes.test.ts` 与本报告
`docs/E4-R52-report.md`。

## 7. NOT_RUN

- 未重跑全仓 `pnpm test` / `pnpm typecheck` / `pnpm docs:verify`：按计划在 R56 于干净已提交
  版本上统一执行。
- 未在真实生产 E2E 链路上验证副本字节（真实链路是否产出非 UTF-8 artifact）：属 R55 范围。
- 未核实该版本的远端 CI：本轮不推送，R56 记录。
- 未做付费评测、未自动发布、未强推、未改远端权限。

## 8. 残余限制

1. 证据级别是**单元 + I/O 边界故障注入**（`createReadStream` 被包裹），`stat`、recorder、
   bundle 落盘为生产代码；不等于整条生产 E2E 接线已验证。
2. 例 5 只断言"变长"方向。**变短**方向（stat 报 N，实际读到 M<N）在当前实现下
   `headUsed === total`、`truncated === false`、`sourceBytes === M`，语义自洽（副本确实是
   实际读到的全部内容），故未单列断言；`sourceChangedDuringRead` 会为 `true` 供事后判读。
3. `statBytes` / `sourceChangedDuringRead` 是**新增**字段，属于向后兼容的 schema 追加；
   未找到外部消费者，因此未做版本号升级。若未来有下游按固定 schema 校验，需要同步。
4. 例 4 需要构造 cap±1 的文件（约 16 MiB × 3），是本次最慢的用例（约 2.5 s）；这是
   `MAX_COPY_BYTES` 为常量所致的固有成本，未通过调小上限来加速（那会改变生产语义）。
5. 极端情况下 `total` 与 `statBytes` 的差异无法区分"源被替换"与"源被追加"，只如实标记
   `sourceChangedDuringRead`；不声称能归因到具体机制。
