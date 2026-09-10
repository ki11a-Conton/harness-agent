# E4-R12 报告：Windows docs 红点诊断与失败原因保留（N01/N02）

```text
任务：E4-R12（修复 N01，验证 N02）
起始 SHA：36c9c267aff5f32a0ccd9364da3306e28114921c（main）
被测源码 SHA：e26af98（E4-R12 提交，本地 main，未推送）
开发工作树 fingerprint：e26af98 之上仅剩计划文件换版
  （plan(20260909-011405).md 删除 + plan(20260910-070001).md 未跟踪，
   属 R20 文档收口范围，本次未触碰）
状态：PARTIAL —— N01 已修复并端到端验证；N02 根因精确复现 + 契约已落地；
      “实际 Windows docs gate 全绿”需推送后的新 CI 复核，本次无推送授权，
      不伪称关闭（见“未完成”）。
```

## 1. 缺陷与复现

### N01 —— runner 吞掉失败原因（已修复）

复现（本任务修改前行为）：

- `release gate docs` 失败时，控制台只有一行
  `gate docs: exitCode=1 FAIL → <evidencePath>`，没有任何失败项内容；
- `runGateV2` 只把 stdout/stderr 前 4,000 字放进 `output` digest，全文随后丢弃；
- CI 的 `grep -niE "fail|error|..." "$ERR"` 在**外层** release gate 摘要里找不到
  内部 `docs:verify` 的真实失败项 —— 这就是“docs gate exitCode=1 但看不到原因”的机制根因。

修复后的真实端到端输出（本工作树当前 docs:verify 的既有真实失败项被正确暴露）：

```
gate docs: exitCode=1 FAIL → <tmp>\gates\windows\docs.json
  log: <tmp>\gates\windows\logs\docs-2026-09-10T07-30-12-806Z.log (digest 6977e9bc…db249)
  exitCode=1 (failed)
  FAIL  current plan entry (E4-00)
  plan.md references plan(20260909-011405).md but that spec file is missing
  FAILED: machine-derivable doc facts are untruthful
  [ELIFECYCLE] Command failed with exit code 1.
```

证据文件 `docs.json` 携带 `logRef`（保存日志的相对引用 + sha256 digest）与
`errorSummary`（有界、脱敏的失败摘要）；日志文件字节重算 digest 与记录值一致
（`6977e9bca72759358680f47b7597cdd4dfb7e90b8c5dad7f12744c31800db249`）。

### N02 —— CRLF checkout 使 ledger raw-byte digest 漂移（根因验证 + 契约落地）

- 复现：对 `verifyEvolutionLedger` 注入 CRLF 变换读取（模拟 Windows fresh
  checkout 在 core.autocrlf 下的换行重写），得到 **11 条 DIGEST_MISMATCH**
  （10 个引用 + 1 条重复引用 baseline-holdout.json），与计划 §1.2 观察到的
  “11 个 DIGEST_MISMATCH” 完全一致。
- 本地字节核对：ledger 全部 10 个引用文件的 git blob 与工作树字节均为 LF，
  记录的 digest 与 LF blob sha256 逐一匹配（如 baseline-holdout.json
  `0b647f1b9c78…`、e2-02-ar2-provenance-rejection.json `f407abf969a6…`）。
- 结论：digest 契约是“git blob（LF）字节”。Windows fresh checkout 若被
  autocrlf 重写成 CRLF，`docs:verify` 的 ledger 检查必然失败 —— 这正是
  Windows docs gate 红点最可能的根因（强假设，新 CI 复核确认前不伪称关闭）。

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/evaluation/src/gate-evidence-v2.ts` | `GateEvidenceV2` 新增 `logRef`/`errorSummary`；`runGateV2` 支持 `logDir` 持久化完整（有界、脱敏）输出日志并记录相对引用+字节 digest；`classifyChildFailure` 区分 timeout/signal/maxBuffer/spawn/runner_error 与真实 child exit；`buildGateErrorSummary` 从 stderr+stdout 提取真实 FAIL 行（无匹配回退尾部）；`redactSecrets` 脱敏；严格解析校验 `logRef`/`errorSummary` |
| `apps/cli/src/release-command.ts` | `runGate` runner 接入 `logDir`、显式 `timeout`/`maxBuffer` 上限、失败分类、stderr 为空时保留异常 message；`releaseGateCmd` 控制台打印 gate/exitCode/日志引用/真实失败项；程序化 `evidenceDir` 与 `releaseVerifyCmd` 对齐（一致性小修） |
| `.gitattributes`（新增） | 受 hash 约束证据文件的稳定 checkout 契约：`docs/evolution/*.json` 与 `benchmarks/results/**/*.json` 强制 `text eol=lf`（最小范围，`git check-attr` 已验证仅约束目录生效，源码文件不受影响） |

Runtime Freeze 符合性：未改任何 Runtime 代码；本任务属于发布证据链的
correctness/release-integrity 修复（计划 §3-1 允许范围）。

未修改的已完成部分：exec root containment（R07）、digest/candidateId/version
矩阵（R04）、V2 协议既有字段与 CLI/CI V2 接线（R09）、ledger 的 digest 算法
（拒绝归一化，保持 raw-byte 契约）。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 人为 docs 失败，完整原因能从日志引用读取，CI 摘要指向真实失败项 | ✅ | 真实 `release gate docs` 端到端：控制台打印真实失败项；logRef digest 可由日志字节重算一致 |
| empty stderr、spawn error、timeout、长输出均有有限且准确诊断 | ✅ | 测试：runner 抛错保留 message（ENOENT）、真实 defaultRunner ENOENT 分类、`classifyChildFailure` 单元矩阵（timeout/signal/maxBuffer/spawn/真实 exit/未知）、长输出截断标记、日志上限 |
| Windows fresh checkout 与 Linux 使用同一证据字节/版本化摘要契约 | ✅（代码层） | `.gitattributes` `text eol=lf` 落地且 `check-attr` 生效；Windows runner 实机复核待推送后 CI |
| 实际 Windows docs gate 通过 | ⚠️ PARTIAL | 本地 docs:verify 除 E4-00 计划入口（R20 收口）外全 PASS，ledger CRLF 检查已绿；Windows CI 复核需推送 |
| 修改受保护 artifact 实质内容后仍 DIGEST_MISMATCH | ✅ | 真实篡改演示：`e1-next-evidence.json` 追加内容 → `[DIGEST_MISMATCH] recorded 29bb3d863036, actual 3f4d541ddaec`；恢复后无 diff |
| 不再使用“无 FAIL 行所以是 runner 问题”的推断 | ✅ | runner 现在必然保存日志并打印真实失败行（见 §1 N01 输出） |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（tsc -b，exit 0） |
| `pnpm exec vitest run apps/cli/src/release-command.test.ts apps/cli/src/docs-verify.test.ts packages/evaluation/src/gate-evidence-v2.test.ts packages/evaluation/src/evolution-ledger.test.ts` | PASS：4 files / 84 tests |
| `pnpm test`（全仓） | 308 files：**5576 passed / 1 skipped / 1 failed**。唯一失败为 `e4-09-production-e2e` 的 clean-tree 前提测试：`runGateV2` 的 `passed` 要求 cleanBefore && cleanAfter，脏开发工作树下必然失败；已用 `git stash` 证明 pristine HEAD 下 5/5 通过，与本任务改动无关 |
| `pnpm docs:verify` | exit 1，唯一失败项为 E4-00 计划入口（计划文件换版中，R20 收口）；evolution ledger 检查已 PASS |
| CRLF 复现脚本（等价附录二 LEDGER_CRLF） | 11 条 DIGEST_MISMATCH，与计划观察一致 |

- evidence 路径/runId/digest：本任务为离线开发工作树验证；正式 evidence 待
  R20 固定 SHA 后按 R19 registry 生成。演示证据：
  `<tmp>/e4-r12-e2e-demo/gates/windows/docs.json`（logRef digest
  `6977e9bca72759358680f47b7597cdd4dfb7e90b8c5dad7f12744c31800db249`）。
- reviewedSourceSha：`e26af98`。
- 真实模型网络调用数：**0**；fake 调用数：**0**（本任务不涉及 provider）。

## 5. 未完成 / 后续任务接口

- **Windows runner 实机复核**：需推送后运行新 CI。CRLF 根因的证据链
  （11 条 mismatch 精确复现 + `.gitattributes` 契约）已建立，但“当前 Windows
  job 的 docs gate 失败确由 CRLF 造成”仍是强假设 —— 按计划 §R12 要求不伪称
  关闭，待新 CI 输出确认/否定。若实际失败另有原因，按真实检查项修复。
- **计划入口换版**（plan.md → plan(20260910-070001).md）：属 R20（§R20-6）
  “根 plan 保持唯一当前入口”范围，本任务未改 plan.md；R20 落地后
  `docs:verify` 的 E4-00 检查即可转绿。
- **给后续任务的接口**：
  - R19 可基于 `evidence.logRef`（保存的完整日志 + digest）重算 `outputDigest`，
    不再哈希被丢弃的 stdout 前 4,000 字；
  - `classifyChildFailure` / `buildGateErrorSummary` 已导出，供其他 runner
    （release-artifacts 等）复用同类诊断；
  - 新增测试文件均使用临时目录，无仓库污染（已核对测试前后 git 状态）。
