# E4-R58 报告：让源码变异兼容 LF 与 CRLF

## 1. 问题（G58，P1）

Windows 主门禁 job（CI run `34798344295`，job ID `103835751105`）失败于
`e4-r55-failure-wiring.test.ts` 调用 `mutateChainOrdering`，报：

```
START marker is not a standalone line
```

根因：旧实现用 `\n<marker>\n` 定位标记行。Windows 检出（git `core.autocrlf`）的文件是
CRLF，标记行后面是 `\r\n`，该 needle 永远匹配不上 → 定位失败 → 抛错。

本机实测：`apps/cli/src/e4-09-real-chain.ts` **不含 CRLF**（`has CRLF: false`），
所以本地一直通过，问题只在 Windows 暴露。这也解释了为什么"Linux 通过不能代替 Windows"。

## 2. 修复前复现（判别性反例）

新增 `apps/cli/src/e4-r58-mutation-newlines.test.ts`（5 例）。它从**真实模块**读源码，
再在内存里构造 LF 与 CRLF 两份输入，因此在任何检出状态上都能覆盖两种换行。

**修复前实际结果**（退出码 1）：

```
 × A: both conventions mutate successfully and produce the SAME bytes
 × B: the block really moves AFTER the assert, and the marker constants are not corrupted
 ✓ C: marker text inside a string literal is never matched (line-anchored matching survives)
 × D: missing / duplicated / mis-ordered markers and a missing assert all fail loudly
 × E: CRLF input with the markers present is not silently returned unmutated
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)

Error: R55 mutation: START marker is not a standalone line
```

A/B/E 的失败原因是同一句 `START marker is not a standalone line`——与 Windows CI 日志逐字对应。
D 的失败说明旧实现**不做数量/顺序校验**（缺失、重复、错序都不会明确失败）。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | 修改：`mutateChainOrdering` 改为**行数组匹配 + 显式前置校验 + 规范化换行**（+67 / −23 行） |
| `apps/cli/src/e4-r58-mutation-newlines.test.ts` | 新增：LF/CRLF 纯函数回归 + 常量安全 + 4 类非法输入（5 例） |

实现要点：

1. **换行规范化只作用于生成的临时副本**：`source.replace(/\r\n/g, "\n")` 后按行处理；
   仓库自身行尾从不重写，也**不需要**改 `core.autocrlf` 或用户 Git 全局配置。
2. **输出换行约定明确**：生成的副本**恒为 LF**。因此 LF 与 CRLF 两种输入产出**逐字节相同**
   的结果（比计划要求的"去除换行差异后一致"更强）。
3. **保持独立行匹配**：改为 `split("\n")` 后做**行相等**比较，而不是字符串 needle。
   本模块的 `MUTATION_START` / `MUTATION_END` / `MUTATION_ASSERT` 常量本身就含相同文本，
   裸 `indexOf` 会把块拼进字符串字面量（R55 开发期已踩过一次）。行相等把"独立行"变成
   **结构性**保证，而不是文本技巧。
4. **显式校验数量与顺序**：START / END / ACCEPT 断言各必须**恰好一行**；END 不得早于 START；
   断言必须晚于 END。任一不满足即抛出带具体数字/原因的错误——不可能静默产出未变异或损坏的源码。
5. **移动逻辑只搬 decision 持久化块**：移除 `[START..END]` 行区间，重新定位断言后插回；
   evaluator、benchmark 输入、其它业务逻辑一行未动。
6. 保留了"输出确实发生变化"与"块确实落在断言之后"两道 sanity 检查。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `vitest run apps/cli/src/e4-r58-mutation-newlines.test.ts` | 0 | **5 passed (5)** |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（真实父/子验证） | 0 | **1 passed**（102 s；未变异接线通过、变异接线被同一验收拒绝） |

| 用例 | 验收项（计划 §4） | 关键断言 |
| --- | --- | --- |
| A | 同源 LF 与 CRLF 输入都成功生成变异；两份输出去除换行差异后一致 | 两者都 `!==` 输入；`mutateChainOrdering(CRLF) === mutateChainOrdering(LF)`（**逐字节相同**）；输出不含 `\r` |
| B | 变异只把 decision 持久化块移到断言之后；常量不被破坏 | START/END/断言各自恰好一行；`START` 行号 > 断言行号；`export const MUTATION_*` 声明行与输入**逐行相同** |
| C | 常量中的相同文本不会被误命中 | 常量声明行不变；`MUTATION_START` 作为独立行只出现 1 次 |
| D | 标记缺失、重复、END 在 START 前、目标断言不存在时都失败且原因明确 | 6 种构造（START/END/断言各缺失、各重复）+ END 早于 START 全部抛出，且错误信息含对应标记名 / `exactly ONE` / 顺序原因 |
| E | 不静默返回未变异源码 | 输入中块在断言**之前**、输出中块在断言**之后** |
| 真实父/子 | 未变异真实接线的父验收成功；变异接线因 decision 未落盘被同一验收拒绝 | R55 父验证 **1 passed**——同时证明**变异副本能被真实测试工具加载**（子进程 vitest 实际 import 它），不是语法错误导致的失败 |
| Windows 主门禁真实执行成功 | ⏳ **未在本任务内确认**：本机是 LF 检出，无法代表 Windows；需由 R61 在真实 Windows CI 上核实（计划明确"Linux 通过不能代替 Windows"） |

## 5. testedSourceSha

- 基线提交（R58 开始时 HEAD）：`6af8857a73763627c6d312e24648b6b8763b9fbf`
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-09-real-chain.ts` | `d26a9ad65d1294491cd30659217822855e9ed6ed` |
| `apps/cli/src/e4-r58-mutation-newlines.test.ts` | `65803397326c5d082459b2de797979802e5d9869` |

- 实现提交：`82fe02d`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)，**LF 检出**。

## 6. 未提交差异

实现与回归测试已在 `82fe02d` 提交；本报告 `docs/E4-R58-report.md` 为后续提交。
（本任务只改 `apps/cli` 的测试基础设施模块与其回归测试，未触碰 Runtime。）

## 7. NOT_RUN

- **未在真实 Windows CI 上验证**：本机无法代表 CRLF 检出；留给 R61 核实（计划要求）。
- 未重跑全量 `pnpm test` / `pnpm test:coverage`：留给 R61 在干净已提交版本上统一执行。
- 未下载/复核任何 CI artifact。
- 未做付费评测、未发布、未强推。

## 8. 残余限制

1. **本机无法端到端复现 Windows 的 CRLF 路径**。原因不是没测，而是测试本身的前置条件冲突：
   R55 父验证要求**干净工作树**（其子进程里的 promotion benchmark 会拒绝脏树），而把
   `e4-09-real-chain.ts` 临时改成 CRLF 会让工作树变脏，从而以**无关原因**失败。因此
   CRLF 覆盖由**纯函数回归**（从真实模块内存构造 CRLF）承担，端到端确认留给 Windows CI。
   R59 把变异源改为可配置/独享路径后，Windows CI 上的真实检出本身就是 CRLF，该路径会被
   真实执行。
2. **输出恒为 LF**：如果将来有工具对生成副本的行尾有要求，需要同步该约定（当前无此消费者，
   生成副本是 gitignored 的临时文件，且 R59 会把它移出生产编译输入）。
3. 校验规则要求 START/END/断言的**原始顺序**必须是 START → END → 断言。若有人把断言
   移到块之前，函数会明确抛错（视为"已变异或顺序非法"），而不是猜测意图。
4. 测试助手函数（`lineIndex` / `constLinesOf`）在比较前会把 `\r\n` 归一为 `\n`。这是**有意**
   的：声明的不变量是"内容不变、仅按约定归一换行"，否则 CRLF 输入的行会仅因 `\r` 而不等。
   该归一写在测试助手里，不影响被测实现。
5. 本任务未处理变异副本的**位置/归属**问题（仍写在 `apps/cli/src/` 且被多个进程共享），
   那是 R59 的范围；也未处理子进程超时与证据保留，那是 R60 的范围。

---

## 9. 补记（2026-09-14，E4-R61）：Windows CI 已转绿

§4 与 §7 中"未在本任务内确认 / 本机无法代表 CRLF 检出"的 Windows 门禁，已由 R61 推送后核实：

| 项 | 值 |
|---|---|
| run | `#137` `34809270367`（head `08584422061322d82465377a773624a8f7f0315f`，attempt 1） |
| job | `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` = `103867145257` |
| 结果 | **success**（05:20:18Z → 05:25:29Z） |

**判别性佐证**：失败期（`#134`/`#135`/`#136`）每个 run 都上传了
`e4-09-diagnostics-windows-latest-<run>-attempt-1`（2844–2849 B）；**#137 没有该产物**，
说明 e4-09 家族在 Windows 上**不再失败**——是失败消失，而不是被忽略。
`e4-09-real-chain.ts` 的 blob 在最终实现中仍为 `6d4784e8…`（R60 重写后），
即本报告的 CRLF 修复内容被完整保留。详见 `docs/E4-R61-report.md`。
