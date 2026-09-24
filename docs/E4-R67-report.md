# E4-R67 报告：区分诊断复制完整性与整个归档完整性

## 1. 问题（J67，P2；无依赖）

`apps/cli/src/e4-r55-child-harness.ts` 的 `preserveEvidence` 有一个**语义**缺口：

1. 写 `child.stdout.txt` / `child.stderr.txt` 失败时，只调 `reportDegraded`（stderr 一行），
   **归档里没有任何痕迹**。
2. 写 `child-report.json` 失败时同样只记 stderr。
3. 返回的 `integrity` **直接取自 `copy.integrity`**（即**诊断子目录复制**的状态）。
4. `run.json` 的 `evidence` 也只记录诊断复制结果。

因此 **"诊断复制完整" 被当成了 "整个归档完整"**。一个 stdout 写失败的包，
`integrity` 仍然是 `complete`，而 `run.json` 里查不到那次 EIO。

## 2. 修复前复现（真实 helper + 单角色 I/O 注入，实测）

直接加载真实 helper，注入 `child.stdout.txt` 的 EIO（其它写入不变），并且**传入一个诊断目录**
（与计划 §1 的复现前置条件一致）：

```
R67_PROBE_RESULT={"ok":true,"diagnosticsCopyIntegrity":"complete","archiveIntegrity":"complete",
                  "stdoutExists":false,"errorRecorded":false,"declaredStdoutBytes":5,"failedRoles":[]}
```

与计划 §1 记录的复现**逐项一致**：`ok=true`、整体状态 `complete`、`stdoutExists=false`、
`errorRecorded=false`、`declaredStdoutBytes=5`。**原始错误只出现在 stderr，归档自身不含 EIO。**

**证据层级声明**：这是**受控 I/O 故障注入**（经 §4 的 seam），**不是**声称生产 CI 已遭遇磁盘故障。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | 修改：新增 `ArchiveIntegrity` / `EvidenceRole` / `EvidenceRoleStatus` / `EvidenceRoleRecord` / `EvidenceSeam`；`PreservedEvidence` 用 **`diagnosticsCopyIntegrity`** 与 **`archiveIntegrity`** 取代原单字段 `integrity`，并新增 `roles`；`preserveEvidence` 逐角色记录写入结果；`copyTree` 接受 seam；`run.json.evidence` 拆成 `diagnostics` / `archive` 两层 |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改：父验证 `conclude()` 消息改为以 `archiveIntegrity` 为主、`diagnostics` 为辅；R65 既有断言迁移到 `evidence.diagnostics.*`；新增 R67 套件（8 例） |

### 3.1 两层状态（一个字段只承担一种含义）

| 字段 | 含义 |
| --- | --- |
| `diagnosticsCopyIntegrity` | **只**描述诊断树复制，保持 E4-R65 语义：`complete` / `partial` / `missing` / `not-requested` |
| `archiveIntegrity` | 描述**所有被请求的归档角色**（含顶层日志与原始报告）：`complete` / `partial` / `archive-failed` |

判定规则：只要**任一请求角色写入失败**，或**被请求的诊断复制不完整**（`partial`/`missing`），
`archiveIntegrity` 就是 `partial`。**诊断复制完整不再能掩盖日志写入失败**（反之亦然）。

### 3.2 逐角色结构化状态

```ts
{ role: "stdout" | "stderr" | "raw-report", path, requested, status: "written" | "failed" | "not-requested",
  operation: "writeFile" | null, errorCode, reason, writtenBytes }
```

`reason` 在非 `written` 时**恒非空**；`writtenBytes` **只在 `written` 时非 null**。

### 3.3 关键设计取舍

1. **`ok` 的定义被收窄并写明**：`ok === true` 只表示"存在**可读取的自描述归档**"（即 `run.json` 写成功），
   **不**表示所有角色完整。完整性一律看 `archiveIntegrity`。避免一个布尔承担两种含义。
2. **`rawText === null` 记为 `not-requested`**：既不伪装成写入成功，也**不**无条件判归档失败；
   原因里带上真实的 `report.kind`，所以"源报告缺失"与"报告写入失败"是两条不同的记录。
3. **`run.json` 不在 `roles` 里**：它的结果无法写进它自己描述的文件。
   由 `ok` / `archiveIntegrity` 表达——`archive-failed` 恰好就是它没写成功的情形；
   而"能读到记录"本身已蕴含它写成功。**这个不对称是有意的，并在类型注释里写明。**
4. **`capture.*.capturedBytes` 的注释加了警告**：它是**内存**捕获字节数，**不是**磁盘已有字节数；
   磁盘事实看 `roles[].writtenBytes`。计划 §3.7 要求的正是这一点。
5. **`files` 只列真实写出的文件**：失败角色不 push（`write` 成功后 push），
   所以 `files` 与磁盘一致；实测见 §4 用例 B/G。
6. **没有引入新依赖、插件或统一归档框架**（计划 §3.9）；`copyTree` 的结果与语义**未重写**，
   只是把它的 `integrity` 归位到"窄层"。

### 3.4 测试 seam（计划 §2：故障注入在局部 seam 中进行）

```ts
seam?: { writeFile?: (path, data) => Promise<void>; copyFile?: (src, dest) => Promise<void> }
```

生产调用方不传，使用真实 `node:fs/promises`。它让**单个角色**的写入失败可确定性复现，
不靠 chmod 竞争或随机损坏（计划 §2 明确禁止）。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 类型检查通过 |
| `vitest run … -t "R67"` | **0** | **8 passed**（42 skipped） |
| `vitest run … -t "R65"` | **0** | **9 passed**（迁移到新字段路径后仍全绿） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整，干净树） | **0** | **50 passed (50)**，117.32 s |

同一注入在**新实现**下的结果：

```
R67_PROBE_RESULT={"ok":true,"diagnosticsCopyIntegrity":"complete","archiveIntegrity":"partial",
                  "stdoutExists":false,"errorRecorded":true,"declaredStdoutBytes":5,"failedRoles":["stdout"]}
```

逐条对应计划 §3「怎么验收」矩阵：

| 输入/故障 | 必需结果 | 用例 | 结果 |
|---|---|---|---|
| 全部请求输出成功 | 整体完整，角色清单与磁盘一致 | A：`archiveIntegrity=complete`、三个角色均 `written`、每个 `writtenBytes` **等于磁盘文件真实大小**（含 stdout=5） | ✅ |
| 仅 stdout 写入 EIO | 整体 partial；run.json 记录 stdout/write/EIO；stderr、报告、diagnostics 仍可读 | B：`archiveIntegrity=partial` 而 `diagnosticsCopyIntegrity=complete`；`failedRoles=["stdout"]`；`errorCode=EIO`、`operation=writeFile`、`writtenBytes=null`；stderr/报告/diagnostics **逐一读回内容一致**；`files` **不含** `child.stdout.txt` | ✅ |
| 仅 stderr 写入 EACCES | 同上，错误角色准确 | C：`failedRoles=["stderr"]`、`errorCode=EACCES`，且 stdout 仍为 `written` | ✅ |
| rawText 存在但报告写入失败 | 明确报告输出失败，不误写成源报告缺失 | D：`raw-report` 角色 `failed`/`requested=true`/`errorCode=EIO`；`report.kind="ok"`、`report.error=null` **保持原状** | ✅ |
| rawText=null | 该角色未请求/不可用，原 report.kind 保留 | E：`status=not-requested`、`requested=false`、`path=null`、`writtenBytes=null`、`reason` 含 `report.kind=missing`；`archiveIntegrity=complete`（**不**因此失败）；`report.kind="missing"` 保留 | ✅ |
| 顶层日志成功但 diagnostics 缺失 | 两层状态各自准确，不因日志成功覆盖诊断缺失 | F：`diagnosticsCopyIntegrity=missing` 且 `archiveIntegrity=partial`，同时 `failedRoles=[]`（**没有角色失败**）与 stdout 仍 `written` | ✅ |
| run.json 写入失败 | archive-failed，不声称可读取完整归档 | G：`ok=false`、`archiveIntegrity=archive-failed`、`error` 含 EIO、磁盘上**没有** `run.json`、`files` 不含 `run.json`；角色结果仍返回以便调用方自述 | ✅ |

附加要求：

| 要求 | 结果 |
|---|---|
| 删除源临时目录后，仅读 `run.json` 就能恢复顶层写入错误 | ✅ 用例 H：删掉 diagDir 后从 `run.json` 读回 `failed/writeFile/EIO/injected write failure` |
| 返回 `files` 仅列实际成功写出的文件 | ✅ B、G |
| 原始业务 failure/reasons 保留 | ✅ H：`reasons` 原样保留 |
| **旧实现下 stdout-EIO 反例必须失败，新实现通过** | ✅ 见 §5 |

## 5. 判别力（恢复旧实现后反例失败）

把"失败角色只记 stderr"与"整体状态直接取自窄层"恢复回去：

```
× B: an EIO on stdout makes the ARCHIVE partial even though the diagnostics copy is complete
× C: an EACCES on stderr names the stderr role, not stdout
× D: a failed RAW-REPORT write is reported as a write failure, never as a missing source report
× E: rawText=null is 'not-requested' — not a fake success and not an unconditional failure
× F: successful logs must NOT cover a missing diagnostics dir — the two layers stay separate
× H: after the source is gone, run.json ALONE still recovers the top-level write error
     Tests  6 failed | 2 passed | 42 skipped (50)
```

A 与 G 在旧实现下仍通过是**预期**的：A 是"全部成功"（旧实现在这种情况下确实正确），
G 是 `run.json` 失败路径（旧实现已有 `archive-failed`）。随后已从备份恢复：
`Tests 8 passed`、`tsc -b` 退出码 0。

## 6. 父验证接线（计划 §3.8）

```
[e4-r55] the <mode> run was not decidable — evidence preserved at <dir>
         (N files, archive integrity=<complete|partial>, diagnostics=<complete|partial|missing|not-requested>)
```

`archiveIntegrity` 在前，诊断状态作为**独立的窄事实**在后。
因此"日志缺失但诊断完整"的包**不会**被显示成完整包（用例 B 正是这个形状）。
归档失败时仍为：

```
[e4-r55] … the evidence archive could NOT be written (archive-failed: <reason>); no downloadable location
```

## 7. testedSourceSha

- 基线提交（R67 开始时 HEAD）：`fbe30fa263a6bc364fe44dc57e29e4372c1e7442`（计划 §0 的审查提交）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob（工作树） |
| --- | --- |
| `apps/cli/src/e4-r55-child-harness.ts` | `a3bbed61e787dc8f311f13d0d8f051d791a57864` |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `8835df57869f258ff7066aaf34b8b6277a47727f` |

- 实现提交：`3cb29fc`
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)

## 8. NOT_RUN

- 未在真实 CI 上验证（按计划顺序留给 R69）。
- 未做付费模型调用、未发布 release、未强推。

## 9. 残余限制

1. **`roles` 不含 `run.json`**（§3.3 第 3 条）：它的结果由 `ok` / `archiveIntegrity` 表达。
   若将来需要"run.json 自己的角色条目"，必须把它写进另一个文件，否则是自指。
2. **`seam` 是测试用注入点**，暴露在 `PreserveEvidenceInput` 上。生产调用方不传；
   它**只**能替换 `writeFile` / `copyFile` 两个操作，不能伪造 `mkdir` / `mkdtemp` 失败
   （那两条路径由"归档根不可用"用例覆盖）。
3. **`archiveIntegrity` 只有三档**（`complete`/`partial`/`archive-failed`），不区分"几个角色失败"。
   需要明细时读 `roles` / `failedRoles`。
4. 本任务**未重写 `copyTree`**（计划 §3 明确要求保留其已实现结果）；R65 的窄层语义原样保留，
   仅把它的字段从 `integrity` 更名为 `diagnosticsCopyIntegrity`（并嵌到 `evidence.diagnostics` 下），
   R65 的 9 个用例迁移后全部通过。
5. R68 仍需补齐"同一棵树一份成功一份失败"与"链接 skipped 分支确实执行"的验收；
   本报告不声称那两项已完成。
