# E4-R65 报告：把证据复制失败写进归档本身

## 1. 问题（H65，P2；依赖 R64）

`apps/cli/src/e4-r55-child-harness.ts` 的归档协议有两个缺陷：

1. **`copyTree` 只把失败打到 stderr。** `readdir` 或 `copyFile` 失败时它
   `reportDegraded(...)` 后继续，返回值里没有任何错误集合。被跳过的非普通文件更是被
   **塞进同一个"已复制文件"列表**（`copied.push(\`${rel} (skipped: not a regular file)\`)`），
   于是"跳过的链接"与"真正写好的文件"在返回值里无法区分。
2. **`preserveEvidence` 的 `run.json` 不含复制结果。** 返回值只有 `{dir, files}`。

后果（计划 §0 独立复现第 2 条）：**"没传 diagDir"、"目录存在但为空"、"目录不存在"、
"复制失败"四种情况全部表现为 `files = []`**，归档使用者无法判断"没有诊断文件"到底是
"本来就没有"还是"复制失败"。

## 2. 修复前复现（实测）

修复前的可观测状态（函数层，`preserveEvidence` 直接调用）：

| 场景 | 旧返回值 | 旧 `run.json` |
|---|---|---|
| 不传 `diagDir` | `files = []` | 无 `evidence` 段 |
| 目录存在但为空 | `files = []` | 无 `evidence` 段 |
| 目录不存在 | `files = []`（只有 stderr 一行 ENOENT） | 无 `evidence` 段 |
| 目录不可读（ENOTDIR） | `files = []` | 无 `evidence` 段 |
| 非普通文件被跳过 | **混入 `files`**，与真实副本无法区分 | 无 `evidence` 段 |

即：**仅凭归档无法区分这五种情况**。判别性验证见 §6。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | 修改：`copyTree` 改为返回结构化 `CopyTreeResult`；新增 `CopyEntry` / `CopyEntryStatus` / `CopyIntegrity` / `EvidenceIntegrity`；`PreservedEvidence` 新增 `ok` / `copy` / `integrity` / `error`；`run.json` 新增 `evidence` 段；日志写失败改为降级而非致命；`run.json` 写失败 → `archive-failed` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：父验证 `conclude()` 的消息同时给出**位置与完整性**，归档失败时**不再宣称可下载位置**；新增 R65 套件（9 例） |

### 3.1 结构化复制结果

| 字段 | 含义 |
|---|---|
| `path` | 相对复制目标根的路径 |
| `status` | `copied` / `missing` / `unreadable` / `skipped` |
| `operation` | `readdir` / `mkdir` / `copyFile` |
| `errorCode` | 平台提供的 errno 风格错误码（无则为 null） |
| `reason` | 非 `copied` 时**恒非空**的原因 |

`CopyTreeResult`：`{ source, requested, sourceMissing, empty, copied, entries, integrity }`。
`integrity` ∈ `complete` / `partial` / `missing` / `not-requested`。

### 3.2 关键设计取舍

1. **`copied` 只列真实写好的普通文件。** 被跳过的链接/特殊文件进入 `entries`（`status: "skipped"`），
   **绝不**出现在 `copied` 或 `files` 中——"跳过的链接"不得被计为"已归档的证据"。
   不跟随链接的既有保护**保持不变**。
2. **`skipped` 不降低完整性。** `complete` 的定义是"发现的**每一个普通文件**都被复制了"。
   不跟随链接是**策略**而非失败，所以它不进 `partial`；但它仍然被记录，读者能看到它被排除。
3. **区分"空"与"缺失"。** 源根不存在 → `sourceMissing: true`、`integrity: "missing"`，
   并且**记录一条 ENOENT 条目**（`path: "."`、`operation: "readdir"`），
   所以仅凭归档就能解释缺失原因。源根存在但无条目 → `empty: true`、`integrity: "complete"`。
4. **不覆盖原始异常。** `reasons`（原始业务失败）与已复制的证据都保留；归档部分失败
   只是多一条 `entries` 记录，**不会**把原异常替换成一个 copy error。
5. **归档写不出就如实说。** 连 `run.json` 都写不出（或归档根不可用）时返回
   `ok: false` + `integrity: "archive-failed"` + `error`，父验证消息改为
   "the evidence archive could NOT be written … no downloadable location"，
   **不伪造可下载位置**（计划 §5.7）。
6. **确定性清单。** `copied` 与 `entries` 在返回前排序——`readdir` 的顺序依文件系统而异，
   会让归档清单不稳定（开发期实测到 `["nested/inner.json","top.json"]` 与写入顺序不同）。
7. **CI 仍上传 partial 包。** `.github/workflows/ci.yml` 的上传步骤是
   `if: failure()` + `if-no-files-found: ignore`，因此 partial 归档照常上传，不会丢证据。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 类型检查通过 |
| `vitest run … -t "R65"` | **0** | **9 passed**（33 skipped） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整，干净树） | **0** | **42 passed (42)**，100.95 s |

逐条对应计划 §5「怎么验收」：

| 验收项 | 用例与断言 | 结果 |
| --- | --- | --- |
| 未传 diagDir：状态为**未请求**，而非复制失败 | A：`copy === null`、`integrity === "not-requested"`、`run.json.evidence.requested === false`、`entries === []` | ✅ |
| 真实空目录：可证明为空，完整性成立 | B：`empty === true`、`sourceMissing === false`、`integrity === "complete"`、`copied === []`、`entries === []` | ✅ |
| 指定目录不存在：归档有 missing/partial **和 ENOENT** | C：`integrity === "missing"`、`sourceMissing === true`、存在 `errorCode === "ENOENT"` 且 `operation === "readdir"` 的条目 | ✅ |
| 非普通文件跳过有明确状态，files 只列真实已写文件 | F：`copied === ["real.json"]`、存在 `status === "skipped"` 的 `link.json` 条目（`reason` 含 `not followed`）、`integrity` 仍为 `complete`、`files` **不含** `diagnostics/link.json` | ✅（本机降级，见 §8.2） |
| 删除原目录后，仅凭归档就能区分上述场景 | I：空目录归档 `complete`+`empty` vs 缺失归档 `missing`+`sourceMissing`，两者完整性**互不相等** | ✅ |
| 原始 failure/reasons 仍然保存 | H：不传 diagDir 与传空目录两种归档的 `run.json.reasons` **都等于**原始 reasons | ✅ |
| 取消错误集合记录，新增验收必须失败 | §6：旧归档形状下 **7/9 失败**（A、B、C、D、E、F、I） | ✅ |
| 部分失败可从 `run.json` 恢复（操作+错误码+原因） | D：`diagDir` 为普通文件 → `integrity === "partial"`、条目 `status === "unreadable"`、`operation === "readdir"`、`errorCode` 与 `reason` 均非空 | ✅ |
| 成功副本可读 | E：嵌套两文件全部复制，`files` 含 `diagnostics/top.json` 与 `diagnostics/nested/inner.json`，两者**从归档重新读出内容一致**，`copiedCount === 2` | ✅ |
| 归档根不可用：报告"归档未成功" | G：`E4_R55_PARENT_DIAG_DIR` 指向一个**文件**下的子路径 → `ok === false`、`integrity === "archive-failed"`、`error` 非空、`files === []` | ✅ |

## 5. 父验证接线（计划 §5.6）

`conclude()` 的消息现在**同时**给出位置与完整性：

```
[e4-r55] the <mode> run was not decidable — evidence preserved at <dir> (N files, diagnostics integrity=<complete|partial|missing|not-requested>)
```

归档失败时改为：

```
[e4-r55] the <mode> run was not decidable — the evidence archive could NOT be written (<archive-failed>: <reason>); no downloadable location
```

## 6. 判别力（恢复旧归档形状后反例失败）

把 `copyTree` 的跳过分支改回"塞进 copied"、并删掉 `run.json` 的 `evidence` 段：

```
× A: a diagnostics dir that was never requested is 'not-requested', NOT a copy failure
× B: an existing EMPTY directory is provably empty, not mistaken for a missing one
× C: a specified directory that does not exist archives 'missing' with an ENOENT entry
× D: a directory that exists but cannot be read archives 'partial' with the operation and code
× E: a successful nested copy is complete, its files are readable, and they are listed under diagnostics/
× F: a non-regular entry is SKIPPED — never counted as a copied file, and never degrading integrity
× I: after the source is gone, the archive ALONE still distinguishes empty / missing / partial
     Tests  7 failed | 2 passed | 33 skipped (42)
```

G 与 H 在旧形状下仍通过是**预期**的：G 断言的是新增的 `ok`/`archive-failed` 行为，
H 断言的是**未被改动**的 `reasons` 保留。随后已从备份恢复：`Tests 9 passed`、`tsc -b` 退出码 0。

## 7. testedSourceSha

- 基线提交（R65 开始时 HEAD）：`6e02fe1`（R64 报告提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | `dc32370ddcca628b15cc775b6a25a86e5efd6f31` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `24f52bff9e44d8f4f86409f80ec10cfe41f0a9ee` |

- 实现提交：`06a4f75`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)。

## 8. NOT_RUN 与残余限制

1. **未在真实 CI 上验证**（留给 R66 在推送后核实四个必需 job）。
2. **`skipped`（非普通文件）分支在本机只能降级验证。** 本机代理沙箱会阻止符号链接创建；
   更隐蔽的是，本轮实测发现 `fs.symlink` 有时**既不抛错也不创建**（静默 no-op：
   `readdir` 里没有该条目、`lstat` 报 ENOENT）。因此用例 F 会先用 `lstat` 确认链接**真的存在**，
   否则走降级分支，只断言"没有任何 `skipped` 条目混进 `copied`"与"完整性仍为 complete"。
   **真正的 `skipped` 判定由允许符号链接的真实 CI 覆盖**（本报告不声称本机已验证该分支）。
3. **"同一棵树里一份成功、一份失败"未在本机构造成功。** 失败路径由"`diagDir` 是普通文件"
   （`readdir` ENOTDIR → `unreadable` → `partial`）覆盖；成功路径由用例 E 覆盖（两份都成功且可读）。
   两者**不在同一棵树**内同时出现——本报告如实记录，不把它写成"一份失败一份成功"。
4. **`integrity` 只描述普通文件。** `skipped` 不计入 `partial`（§3.2 第 2 条）。若将来需要
   "有链接被跳过"单独升级为 partial，需要显式改变该策略。
5. 本任务只处理归档完整性，未触碰 `appendBounded`（R63）与 `killTree`（R64）。
