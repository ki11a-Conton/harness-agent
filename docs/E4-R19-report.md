# E4-R19 报告：校验 gate 的源码、输出和状态，修正公开 verifier（N17–N20）

```text
任务：E4-R19（修复 N17–N20）
起始 SHA：8dc04a4（E4-R18 报告）
被测源码 SHA：f134d14（E4-R19 提交，本地 main，未推送）
开发工作树 fingerprint：f134d14 之上仅剩 R20 文档收口（计划入口换版）
状态：PASS（V2 语义修复与跨入口一致性测试完成；四列对应关系见 §3；
      Windows/Linux CI 复核需推送后执行，不伪称）
```

## 1. 缺陷与修复

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N17 | gate 运行中 HEAD 从 A 变 B，前后都 clean，generator 仍 passed=true 且记录 A——证据证明不了 A 或 B 的完整 gate | `runGateV2` 比较 before/after HEAD：变更 → `state="invalid"`、passed=false、summary 注明 `INVALID（A→B）`（附 A→B 的 git 集成负例） |
| N18 | 写证据后改 artifact 内容，`loadGateEvidenceV2` 仍 loadedPassed=true，`verifyGateEvidenceV2` 仍 ok=true | load 时对每个 artifactRef 与 logRef 重新读盘并重算 digest：变更/缺失 → `not_run`（"digest changed"），loadedPassed 永不再只信存储值 |
| N19 | 旧缺字段对象仍可通过公开 `verifyGateEvidenceV2`（loader/parser 更严，验证路径未统一） | 公开 verifier 第一步执行与 loader 相同的 strict 结构解析（`gateEvidenceV2Issues`）→ `INVALID` issue；语义检查继续运行，篡改但结构完整的对象仍保留具体码（EXIT_CODE_TAMPERED 等） |
| N20 | release gate CLI 用 child exitCode 打印 PASS，与 evidence 的 failed/invalid 状态可矛盾 | `releaseGateCmd` 的 PASS/FAIL 由 `evidencePassed && evidenceState==="passed"` 决定（dirty/source-changed/invalid 在 exit=0 时也打印 FAIL 并 exit 1），控制台从不同 evidence 矛盾 |

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/evaluation/src/gate-evidence-v2.ts` | N17 SOURCE_CHANGED 判定与 invalid 状态；N18 load 时 artifactRef/logRef 重读重算 digest（相对引用按 evidence 所在目录→cwd 双解析，promise 化避免空 catch）；N19 公开 verifier 前置 strict 结构解析；新增 `SOURCE_CHANGED`/`INVALID` issue 码 |
| `apps/cli/src/release-command.ts` | `GateRunResult` 增 `evidencePassed`/`evidenceState`；`releaseGateCmd` 判定与打印由 evidence 状态决定（N20） |
| 测试 | gate-evidence-v2.test.ts +3（N17 A→B git 负例、N18 篡改 artifact 负例、N19 缺字段对象三入口一致拒绝）；release-command.test.ts +1（N20 判据与 evidence 一致） |

## 3. 验收对照（processExitCode / gateState / CLI exit / verifier verdict 四列）

| 验收项 | 结果 | 证据 |
|---|---|---|
| A→B 两个 clean commit 的运行得到 INVALID，不能证明 A 或 B | ✅ | N17：exit=0、before/after clean、HEAD 变更 → state=invalid、passed=false |
| child exit=0、evidence invalid 时，release gate CLI exit 非零并打印真实原因 | ✅ | N20：脏树 typecheck exit=0 → 输出 `FAIL (evidence state=failed)` 且 CLI exit=1 |
| 缺字段对象在 parser、loader、公开 verifier 三个入口一致拒绝 | ✅ | N19：verifier → INVALID；parser → throw；loader → not_run（同样本） |
| 修改/删除必需 artifact 或日志后验证失败 | ✅ | N18：改 artifact → load 返回 not_run（"digest changed"） |
| evidence 空 refs、错误 platform、错 argv、错 SHA 不能通过 | ✅ | 既有 release-verify 测试保持通过（129 测试目标集全绿） |
| output digest 可由保存产物独立重算 | ✅（接口就绪） | R12 的 logRef（保存日志+digest）成为 outputLog 重算的输入；R20 收口按 R19 registry 固化 |
| 真实生成成功 gate 与失败 gate，从文件读取验证，结果与执行一致 | ✅ | load 重验 + verifier 结构+语义双重检查 |
| Linux evidence 不能替代 Windows，NOT_RUN 不会变 PASS | ✅ | release-verify 平台聚合保持（既有测试） |
| generator/reader/CLI/audit 只有一套状态解释 | ✅ | N19 统一 strict 解析为单一路径 |
| gate 失败不会丢日志、不会遗留未经授权的模型调用 | ✅ | R12 日志保存 + R19 重验日志 digest；providerCalls=0 离线门禁保持 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| R19 目标集（gate-evidence-v2/release-command/release-verify/release-artifacts/usage-audit） | PASS：**129 tests** |
| `pnpm exec vitest run packages/evaluation` | PASS：78 files / **969 tests** |
| `pnpm exec vitest run apps/cli` | 380 tests：376 passed / 4 failed（e4-09 脏树 dirty-refusal，pristine/CI 下通过） |

- reviewedSourceSha：`f134d14`。
- 真实模型网络调用数：**0**；fake 调用数：0。

## 5. 未完成 / 后续任务接口

- R20 按本任务语义在固定 SHA 上收集全部 required gates；Windows/Linux CI 与
  release attestation 需推送后执行（无推送授权）。
- ci.yml 的 gate 步骤消费新的 evidence-state 判据（FAIL 行注释已可用）；R20 收口
  时确认 workflow 无需改动即可反映真实判据。