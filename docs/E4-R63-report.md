# E4-R63 报告：让有界日志捕获真正满足字节预算

## 1. 问题（H63，P2；依赖 R62）

`apps/cli/src/e4-r55-child-harness.ts` 的 `appendBounded` 有两个缺陷：

1. **截断后可超过预算。** 它先 `chunk.toString("utf8")`，再取 `encoded.subarray(0, allowed)`
   （`allowed = cap - textBytes`），最后把这段**可能切在多字节字符中间**的字节解码回字符串。
   不完整的字节序列被解码成 U+FFFD，而 U+FFFD 是 **3 字节** —— 于是"预算 1 字节"保存了 3 字节。
   标记了 `overflow` 并不能阻止结果本身超预算。
2. **跨块字符被破坏。** 每个 `data` chunk 都独立做一次有损往返转码，所以一个合法字符
   被拆到两个 chunk 到达时，两半各自变成 U+FFFD。

## 2. 修复前复现（逐字重跑旧算法，实测）

把旧 `appendBounded` 的实现逐字取出执行（`node -e`，见 §5 的命令）：

```
cap=1 -> text="\uFFFD"  savedBytes=3  overflow=true   BUDGET_OK=false   ← 预算 1，实存 3
cap=2 -> text="\uFFFD"  savedBytes=3  overflow=true   BUDGET_OK=false   ← 预算 2，实存 3
cap=3 -> text="中"       savedBytes=3  overflow=false  BUDGET_OK=true
--- 同一字符按 3 个 1 字节 chunk 到达 ---
      -> text="\uFFFD"  savedBytes=3                    ← 应为 "中"
```

与计划 §0「独立复现结果」第 1 条逐项一致（cap=1、输出"中"、实存 3 字节、`outputOverflow=true`）。

## 3. 输出合同（明确选择，可测试）

选择**文本合同**（而不是"保留原始字节"），因为 `stdout`/`stderr` 是字符串：它们被
`judgeChildProcess` 当作文本使用，也被 `preserveEvidence` 以 UTF-8 文本写盘。

| 字段 | 含义 |
|---|---|
| `text` | 接收字节的**最长前缀**，其 UTF-8 编码 ≤ cap，且**结束在完整字符边界**上 |
| `capturedBytes` | `Buffer.byteLength(text, "utf8")`，**恒 ≤ cap** |
| `receivedBytes` | 子进程在该流上写出的**全部**字节（保留与否都计） |
| `truncated` | 捕获未表示全部接收字节时为 true（`capturedBytes !== receivedBytes`，或发生了丢弃/替换/裁剪） |

由此得到的可断言推论：

- 放不下的字符**不写一半**——预算小于一个字符时结果是**空字符串**，绝不产生一个超预算的替换字符；
- **非法 UTF-8 有唯一策略**：解码为 U+FFFD，并据此把文本按**码点**裁剪到预算内；
  由于替换会放大字节数，`truncated` 同时覆盖"替换"与"裁剪"，所以**不会既声称原始字节又保存转码结果**；
- `stdout` / `stderr` **各自独立**受 cap 限制；
- 落盘文件（`child.stdout.txt` / `child.stderr.txt`）以 UTF-8 文本写出，因此
  **其字节数 == `capturedBytes`**，归档使用者可以只凭文件复核预算。

## 4. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | 修改：删除 `OutputBuffer` / `appendBounded`；新增 `StreamCapture`、`completeUtf8PrefixEnd`、`decodeWithinBudget`、`createStreamCapture`；`ControlledChildOutcome` 新增 `capture`；`run.json` 新增 `capture` 段 |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：`syntheticOutcome` 同步 `capture`；新增 R63 套件（10 例） |

实现要点：

1. **保留原始字节，最后只解码一次**：`createStreamCapture.push` 只把 `chunk.subarray(0, take)`
   追加进 `parts`，不做任何转码；`finish()` 才 `Buffer.concat` 并解码。这消除了缺陷 2。
2. **按完整字符边界解码**：`completeUtf8PrefixEnd` 从尾部回扫最多 3 个续接字节，按前导字节
   算出该序列所需长度，不足则把边界退到该前导字节之前。这消除了缺陷 1。
3. **非法输入仍守住预算**：`decodeWithinBudget` 在解码后若字节数超 cap，就按**码点**（不是
   UTF-16 码元）逐个回退，避免把代理对切成两半。
4. **`truncated` 诚实**：除"字节数不等"外，还比较"解码文本重新编码后是否等于保留的完整前缀"，
   因此 U+FFFD 替换与预算裁剪都会被标为 truncated。
5. **没有引入第三方日志框架**，也没有扩散到其它输出系统（计划 §3.5）。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 全仓类型检查通过（接口新增 `capture` 后无破坏） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts -t "R63"` | **0** | **10 passed**（12 skipped） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整文件，干净树） | **0** | **22 passed (22)**，118.62 s —— 真实父/子主用例仍通过 |
| 旧算法逐字重跑（§2） | — | 复现 `cap=1 → 3 字节` 与跨块损坏 |

逐条对应计划 §3「怎么验收」：

| 验收项 | 断言 | 结果 |
| --- | --- | --- |
| 输出"中"、cap=1 / cap=2：保存字节 ≤ cap，截断状态真实 | A：`text === ""`、`capturedBytes === 0`、`receivedBytes === 3`、`truncated === true` | ✅ |
| 输出"中"、cap=3：完整保存，不因字符边界多截断 | B：`text === "中"`、`capturedBytes === 3`、`truncated === false` | ✅ |
| emoji 四字节边界 | C：cap=3 → `""`；cap=4 → `"😀"` 且 `truncated === false` | ✅ |
| ASCII 与中文混合 | D：`"ab中cd"` @ cap=4 → `"ab"`（2 字节），不在"中"中间切 | ✅ |
| 空输出覆盖 | E：`text === ""`、`receivedBytes === 0`、`truncated === false` | ✅ |
| 同一合法字符分多个 chunk 到达，结果与单 chunk 相同 | F：`split.text === whole.text === "中"`，且**不含 U+FFFD** | ✅ |
| 非法 UTF-8 有明确可测试策略，不既声称原始字节又保存转码结果 | G：`Buffer.from(text)` **不等于**原始字节，且 `truncated === true`，`capturedBytes ≤ cap` | ✅ |
| 两个输出流同时超限仍各自有界，sourceBytes 与 capturedBytes 语义清晰 | H：`out.capturedBytes ≤ 3` 且 `err.text === "中"` 未被饿死 | ✅ |
| 写出的日志文件字节数与声明一致 | J：`stat(child.stdout.txt).size === capture.stdout.capturedBytes === 3`，且 `run.json.capture` 与文件一致 | ✅ |
| 恢复旧切割方式，固定 cap=1 反例失败 | §6 实测：旧行为下 **6/10 失败**（含 A、C、D、F、G、I） | ✅ |

补充：**I** 用**真实子进程**（`process.stdout.write('中')`，`maxOutputBytes: 1`）验证
`termination === "exited"`、`stdout === ""`、`capturedBytes === 0`、`receivedBytes === 3`、
`outputOverflow === true` —— 不只在纯函数层验证。

## 6. 判别力（恢复旧切割方式后反例失败）

把 `createStreamCapture.push` 改回"每块有损往返"、`finish` 改回"按 cap 直接切字节再解码"：

```
× A: a budget smaller than one character yields EMPTY text, never an over-budget replacement char
✓ B: a budget that exactly fits one character captures it whole and is not truncated
× C: the four-byte emoji boundary
× D: an ASCII + CJK mix stops on a character boundary instead of splitting it
✓ E: empty output is complete, not truncated
× F: one character split across several data chunks decodes identically to a single chunk
× G: invalid UTF-8 has ONE documented policy — transcoded text, marked truncated, budget still honoured
✓ H: the budget is PER STREAM — one overflowing stream never eats the other's budget
× I: a REAL child writing a 3-byte character under a 1-byte budget reports empty, bounded output
✓ J: the preserved log files' on-disk byte counts equal the declared capturedBytes
     Tests  6 failed | 4 passed | 12 skipped (22)
```

B/E/H/J 在旧行为下仍通过是**预期**的：它们不触及"截断落在字符中间"这条路径。随后已从备份恢复，
复跑 **10 passed**。

## 7. testedSourceSha

- 基线提交（R63 开始时 HEAD）：`9240f65`（R62 提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | `34581428d65076cb76cc71602250d96cb3d96af2` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `7e5f500233a03117a8b84e109cc011d2ed105bb3` |

- 实现提交：`94ed80c`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。

## 8. NOT_RUN

- 未在真实 CI 上验证（留给 R66 在推送后核实四个必需 job）。
- 未做付费模型调用、未发布 release、未强推。

## 9. 残余限制

1. **这是文本合同，不是字节保真合同。** 非法 UTF-8 会被替换为 U+FFFD 并标记 `truncated`；
   若将来需要"原始字节"证据，必须新增一个字节字段（例如 base64 或落盘 `.bin`），
   **不能**从 `text` 反推。
2. `cap` 现在是"落盘文本的字节上限"，而**不是**"接收字节的上限"：`receivedBytes` 仍无上限计数
   （只是一个数字，不保留内容），所以内存占用由 cap 决定，与输出量无关。
3. `completeUtf8PrefixEnd` 对**连续超过 3 个续接字节**的畸形输入不做边界回退（返回原长度），
   此时预算仍由 `decodeWithinBudget` 的码点裁剪保证。
4. `createStreamCapture` 是新增的公开导出，仅服务于本测试工具；它不是通用日志组件，
   也未扩散到其它输出路径（计划 §3.5 要求）。
5. R64/R65 仍在本模块内（`killTree`、`copyTree`/`preserveEvidence`），本报告不声称已处理。
