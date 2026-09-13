# E4-R47 报告：让诊断文件限制真正按字节生效

## 1. 做了什么

修复 `apps/cli/src/e4-09-diagnostics.ts` 的 `readArtifact`，使诊断采集的资源限制与
摘要语义**真正按字节生效**，并新增边界回归测试
`apps/cli/src/e4-r47-bounded-copy.test.ts`（6 例）。

修复前的问题（计划 §6「做什么」）：`readArtifact` 用 `readFile(path)` **整文件读入
内存**，再 `buf.toString("utf8")`，之后才判断 `bytes > MAX_COPY_BYTES`：

- 内存随文件线性增长（无有界读取）；
- `slice(0, MAX_COPY_BYTES)` 用**字符数**截取，非字节；
- 超限文件**仍整体 `JSON.parse`**；
- digest 基于**解码后的文本**，不是源文件原始字节；
- `captured`/`bytes`/`digest` 语义不清（一个 digest 字段两种含义混用）。

## 2. 为什么需要改

计划 §6 要求：让限制、摘要和报告字段与实际行为一致，且**资源使用不随整个源文件
线性增长**、超限时不整体 JSON parse、明确 head 截取、digest 不得一字段两义。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-diagnostics.ts` | 修改：`readArtifact` 重构为流式有界读取 + 前置 `stat` 确定性失败 + `sourceDigest`/`headDigest`/`headBuf` 语义分离 |
| `apps/cli/src/e4-r47-bounded-copy.test.ts` | 新增：字节边界回归测试（6 例） |

## 4. 复现方法与修复前结果

**修复前**：诊断模块读 artifact 时整文件 `readFile`，`slice(0, MAX_COPY_BYTES)` 按
**字符**截断、`JSON.parse(read.text)` 无条件解析、`sha256(read.text)` 对**文本**做摘要。

**判别力实测（修复前缺陷会被新测试捕获）**：

- 目录当文件读取（验收 G）：修复前 `createReadStream(dir)` 在部分平台**挂起**（无
  data、无 end、无 error），测试超时 300s；修复后前置 `stat` 使目录确定性返回
  `EISDIR`，测试 **58ms 通过**。这是最有力的判别力证据——同样的测试在修复前必失败。
- 超限文件：修复前会整体 JSON.parse；修复后头部截断、`parseError` 记「bounded
  copy」，不解析整文件。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | tsc -b 全绿 |
| `pnpm vitest run apps/cli/src/e4-r47-bounded-copy.test.ts` | 0 | **6 passed** |

R47 六例覆盖计划 §6「怎么验收」的 7 类（合并为 6 个断言组）：

- **A 限额以下合法 JSON**：副本与源字节一致（`Buffer.equals`）、`truncated=false`、
  `sourceDigest` = 独立 `sha256(原始字节)`、`headDigest` = 副本 digest；
- **B 恰好限额**：不截断（`sourceBytes === cap`、`truncated=false`）；
- **C 超限额**：`truncated=true`、`headBytes===cap`、`sourceDigest` = **整文件**流式
  digest（`sha256(整buf)`）、`headDigest` = **仅头部 cap 字节** digest、副本文件 =
  前 cap 字节（`subarray(0,cap)` 相等、头 4 字节 `ABCD`）、`parseError` 记
  「truncated…bounded」，**不整体 JSON.parse**（summary=null）；
- **D 多字节 UTF-8**：`sourceBytes` = **字节数**（CJK 下 bytes > chars），非字符数；
- **E 非法 JSON**：`parseError` 记录、原始失败 message/stage 保留；
- **F 缺失文件**：`captured=false` + `ENOENT` 错误，bundle 仍产出（捕获不掩盖原失败）；
- **G 目录当文件**：`captured=false` + `EISDIR` 确定性错误（修复前会挂起超时）。

关键语义区分（计划 §5「摘要必须说明针对源文件还是截断副本」）：

- `sourceBytes` / `sourceDigest` —— 针对**整个源文件**（流式 sha256，内存不随文件增长）；
- `headBytes` / `headDigest` —— 针对**实际保留的副本字节**（≤ cap head）；
- `truncated` —— 源是否超限；
- 一个 digest 字段不再被两种含义共用。

## 6. testedSourceSha 与未提交改动

- `testedSourceSha`：`d201da5e8071e2780a745ffb86ddb31d3cdf547d`（计划审查基线）。
- 实现提交后工作树干净。

## 7. 未执行项与残余限制

- **资源验收方式**：采纳计划「用有界读取路径的断言或隔离进程验证，不用毫秒阈值/
  RSS 精确数值作唯一依据」——本测试用 `sourceBytes`/`headBytes`/流式 digest 断言，
  不依赖耗时或内存数值。
- 超限副本**只保留头部**（head truncation），**非头尾双截取**；该选择已在实现注释与
  报告明确（计划 §6.3 允许「明确实现头部截取还是头尾截取，并同步注释」）。
- 诊断模块其余跨进程/重复采集语义由 R46 处理；顺序/注册由 R45 处理；本任务只负责
  字节有界与摘要语义，不越界重构为通用日志平台。
