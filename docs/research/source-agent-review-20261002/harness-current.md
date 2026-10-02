# Harness 当前能力与可落地边界审查

审查对象：`/workspace/harness-agent`，HEAD `acf8dcc394de6c6efefed52602e49014b372f372`。
对照对象：收集仓库 HEAD `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` 下的 `harness-agent-src/`。
本轮仅审查、执行离线反例和现有测试；未安装上游依赖、未联网、未使用 GitHub 连接器、未修改生产代码或 plan.md。

## 1. 必须服从的当前项目约定

已读当前 `AGENTS.md`、`HANDOVER.md`，及 `tasks/P0/TOOL-001.md`、`SEC-001.md`、`VS-001.md`、`tasks/P4/VERIFY-001.md`、`RECOVERY-001.md`、`LOOP-001.md`、`tasks/P9/EVAL-001.md`、`BENCH-001.md`。

- 所有效应仍走 ToolOrchestrator → PermissionEngine → SandboxManager；不能为了提高完成率绕过 Verification。
- 当前 AGENTS 的 Runtime Freeze 比收集快照更严格：模型质量问题先走 benchmark → failure cluster → hypothesis → challenger → paired eval；Runtime 修改需要确定性正确性反例、安全缺陷、发布完整性缺陷或可归因于 Harness 的性能证据。
- HANDOVER 的 N1–N6 已 DONE；不能把历史 TODO 或旧快照中没有的模块重新当作当前缺口。付费实验与 champion promotion 为 NOT_RUN，本轮离线分析不应偷偷开启。

## 2. 收集快照不能替代当前代码

已生成 `.ci/source-research/harness-snapshot-comparison.json`，含两仓库提交、代表文件原始字节 SHA256 和统计。按两仓库 `git ls-files` 比较：

| 项目 | 当前 Harness | 收集中的 Harness 快照 |
| --- | ---: | ---: |
| tracked files | 2750 | 281 |
| packages 子目录 | 24 | 18 |
| 两者共同文件 | 279 | 279 |
| 共同文件原始字节不同 | 183 | 183 |
| 忽略 CRLF 后仍内容不同 | 177 | 177 |
| 仅当前存在 | 2471 | — |
| 仅快照存在 | — | 2 |

收集仓库提交时间 `2026-08-18T09:23:53Z`，提交名为 `refactor: update harness-agent-src to latest version`。这只能证明收集仓库版本，不能证明每个上游目录的真实 upstream commit。未发现此 Harness 目录的独立 revision manifest。

例：快照 `packages/tools/src/tools/edit-file.ts:25-61` 是 v1、仅 first/replaceAll；当前 v2 已有 occurrence、line-range、diff。当前 `packages/core/src/runtime/context-controller.ts`、`model-call-controller.ts`、`packages/evaluation/src/candidate-registry.ts`、`paired-executor.ts`、`packages/harness/src/create-harness.ts` 在该快照中不存在。因此不能依据快照提议“新建 paired evaluation”“第一次加入验收重试”或“第一次加入编辑 diff”。

## 3. 已存在，不应重复列为待实现

| 能力 | 当前真实入口 / 测试 | 对计划的意义 |
| --- | --- | --- |
| 编辑锚点、指定 occurrence、replaceAll、line range、记录 diff | `packages/tools/src/tools/edit-file.ts:6-30,98-122`；纯函数 `packages/tools/src/edit.ts:58-96,101-130`；`edit.test.ts`、`vs001.test.ts:122-179` | 改进防护和读取版本，不重建编辑工具。默认 first occurrence 是显式兼容行为，不能无评估改成默认拒绝所有重复锚点。 |
| 超长字符串输出 artifact、SHA256、注册、密文/敏感度、注入检测 | `packages/core/src/runtime/context-controller.ts:474-577`；`create-harness.ts:463-464` 启用 dataDir 后配置 64 KiB；`artifact-store.test.ts` 等 | 输出预算/脱敏/artifact 机制已有。存在对象输出等边界问题，需修边界，不提“新建 artifact 系统”。对象输出研究由另一审查者覆盖。 |
| 验收失败后反馈并继续修复；有硬上限 | `model-call-controller.ts:301-355`，尤其 322-349；默认 maxVerificationFailures=3 在 `runtime.ts:556`；`loop-integration.test.ts:202-267` | 修复闭环已有且真实：失败 system observation + continue_loop；耗尽 VERIFICATION_FAILED。不能宣称当前失败后立刻不反馈退出。 |
| 自动验收计划：显式 specs 优先，否则按改动/发现命令派生 | `harness/src/verification-planner.ts:8-12,20-31`；`compose/compose-verification.ts:38-65`；`core/runtime/verification-controller.ts:67-111`；`verification-wiring.integration.test.ts` | 只增加有证据的诊断/策略，不另建 verifier 或改 frozen truth 判定。无命令仍 fail closed，不能伪造验证成功。 |
| 相同 name/args + 相同结果的循环保护；结果改变会取消 streak | `state/agent-state.ts:204-226`；`runtime.ts:1393-1437`；`r85-h2-progress-blind-gate.test.ts:130-180` | 不照搬上游“重复三次就拒绝”的简化策略；当前已有结果 fingerprint，可避免误停合法 test rerun。 |
| 非连续重复、A→B→A→B、重复错误、无变化 read、verification_fix_loop、no_progress | `runtime.ts:132-144,1441-1454`；stall classifier / `state/agent-state.test.ts` | 不重写 loop guard；新增策略必须保持结果变化视为进展和恢复预算。 |
| Read-only bounded parallel；mutating 工具单批次 serial；resource conflict | `tool-call-controller.ts:189-305`，尤其 239-253、279-288 | 局部 serial 并不等于跨 session/跨 harness 文件写锁。可精准修复文件编辑竞争。 |
| 崩溃后未知效应语义分类，不盲目重放写入 | `turn-helpers.ts:184-222`；`crash-sideeffect.test.ts`、`recovery-durable.test.ts`；`harness/durable-recovery-store*.test.ts` | 不能以“恢复”为由自动重放 exec、network 或无证据 filesystem writes。 |
| CandidateRegistry、真实语义差异、ArmFactory wiring / activation / digest | `evaluation/candidate-registry.ts:13-58,77-189`；`arm-factory.ts:137-175,215-284,335-384`；同名 tests | 新策略应新增独立候选与真实 wiring，不能只加一个无法实际影响 model request 的 flag。 |
| Pair schedule、AB/BA seed、完整 pair、identity-bound resume、model-call budget | `paired-plan.ts:127-183,217-260`；`paired-executor.ts:1-20`；同名 tests | 复用已有 paired 平台，不新建无身份隔离的比较脚本。 |
| CLI candidate 自动走 paired，V3 production/strict reload | `apps/cli/src/benchmark-command.ts:460-466,651-971` | 注册 challenger 后复用此真实入口；记录两个 arms 的配置/prompt/tool/source digest。 |
| 预注册 campaign / frozen champion decision / raw-artifact corroboration | `tool-call-efficiency-paired-campaign.ts:1-25,64-108` | 离线 fake 的 PASS 只证明 wiring/边界，不能宣称实模质量提升或 promotion 成功。 |
| Champion profile / production startup proof | `evaluation/champion-profile.ts:1-24,resolveChampionProfile,proveApplication`；`apps/cli/src/champion-application.ts`；`harness/create-harness.ts:852-860`；`champion-application*.test.ts` | 安装的 completionGuidance 必须等于评估过的文本，身份随文本 SHA256 改变；默认 C0 不应被未经验收的新策略覆盖。 |

已有候选包括 adaptive_recovery / v2、memory_retrieval、deferred schema、adaptive_context_policy、budget_aware_completion_v1、tool_call_efficiency_v1；另有明确 unsupported 的 reviewer / learning / scheduler 等。`evaluation/mechanism-guidance.ts:76-101` 的 tool-call efficiency 指引已经要求失败后改变原因/参数、合法修复后允许重试、减少重复读取和完整编辑。它的实际版本是 `tool-call-efficiency:v2`，id 的 v1 不等于策略文本仍 v1。进一步优化应针对新 failure cluster，而不是换名重复文本。

## 4. 确定性反例：编辑新鲜度与跨 session lost update

运行命令（当前 dist 已由最近验收构建）：

```sh
cd /workspace/harness-agent
node .ci/source-research/harness-edit-repro.mjs
```

脚本所有被测 read/write/edit 调用通过真实 ToolRegistry / ToolOrchestrator，显式 read/edit allow 和 workspace-write sandbox、network deny。仅在临时 workspace 运行，不改仓库。它使用真实 fs read 的 rendezvous 来控制两个读快照同时完成；内容读取/写入仍是实际文件系统操作。

实际 exit 0（表示反例断言全部证实）：

```json
{
  "staleRange": {
    "observed": "A\nB\nC",
    "status": "success",
    "actual": "HEADER\nFIXED_B\nB\nC",
    "intendedTargetUnchanged": true,
    "wrongLineChanged": true
  },
  "concurrentIndependentEdits": {
    "readers": 2,
    "statuses": ["success", "success"],
    "actual": "A=1\nB=0\n",
    "bothEditsPresent": false
  }
}
```

第一例：agent 看过 A/B/C，将第二行 B 作为目标；另一个 session 在头部插入 HEADER；沿用旧行号编辑返回 success，却删除 A 而 B 未变。它显示缺乏读取版本前置条件；当前 line-range API 本身并不承诺隐式知道历史版本，不能单靠此例就宣称整个 Runtime 错误。

第二例更强：两个独立 session 分别把 A=0 改 1、B=0 改 1；两个 edit 都先读同一个初始内容，都返回 success；其中一个更新被全文件重写覆盖。这是确定性 lost update。根因当前 `edit-file.ts:98` 读快照，`:118` 无共享锁/版本比较写回；metadata concurrencySafe=false 只导致各自批次 serial，不能排除两个 session 或两个 harness 实例同时编辑同一目标。

可借鉴的代码机制：

- 收集的 `claude-code-fork-main/src/tools/FileEditTool/FileEditTool.ts:275-307` 要求完整 read 并检测更新；`:442-465` 在修改前再检查读状态并在内容变化时拒绝。它还对 Windows 仅 timestamp 变化、内容未变的情况做 fallback，避免误拒绝。
- 收集的 `opencode-dev/packages/opencode/src/tool/edit.ts:35-44,88-89` 用 resolved path-keyed semaphore 包住 read-modify-write。只能借鉴机制，不能整包照搬其权限/LSP/Event/Snapshot依赖。

可落地边界：

1. 工具层按规范文件身份共享锁，使同 Node process 内多个 session/harness 的 read→transform→write 串行；持锁期间检查取消、释放必须 finally，等待取消不产生写入；不同目标仍可并行。
2. 提供显式 `expectedSha256` 前置条件（基于读到的原始字节，不使用 mtime 作为唯一真相），以及可供 agent 获取的读版本。保持默认 read_file 输出兼容；具体 hash 的 schema/元数据如何进入 model 可见输出要在实现计划中明确，不能只藏在模型看不见的 metadata。
3. 严格模式/新 challenger 在 line-range 和 ambiguous anchor 前使用版本前置条件。默认 first occurrence、replaceAll、指定 occurrence 必须按现有测试保持，或以明确新版本策略另行评估；`edit.test.ts` 还明确允许 lineEnd 超长 clamp，不应误当未实现 bug 改掉。
4. stale hash 冲突返回可操作的“重新读取并计算编辑”失败；不自动反复重放原写入。
5. 测试最低覆盖：两个 session 同文件独立编辑保留两项修改；不同路径别名归同锁；不同文件无全局串行；stale hash 无磁盘修改；同内容仅 mtime 变化仍允许；取消等锁零写入；missing anchor/old API regressions；outside workspace/symlink escape/permission deny 均先拒绝。
6. 明确保证范围：进程内 mutex 和写前 hash 检测不能承诺跨进程/任意外部编辑器的原子 compare-and-swap。仅再 read/hash 然后 write 仍有 TOCTOU；若计划要求跨进程原子保证，应先选择并验证具体平台机制，不能以“atomic rename”冒充 CAS。Windows 是项目必须考虑的运行平台。

这个 lost-update 反例可以支撑局部工具正确性修补；不需要为此重写 Runtime 调度或绕过 Permission/Sandbox。

## 5. 验收反馈已有闭环，但详细失败信息会丢失

当前 `TaskVerifier.checkCommand` 接收 ProcessExecutor 的 stdout/stderr（`tools/src/process/executor.ts:9-16`），但 `verification/task-verifier.ts:191-219` 的 VerificationCheck 只保留 `exit code N in Xms` 与 `command: exit N`。`core/verification/runtime-verifier.ts:148-155` 的 reason 只汇总 check.description 与 error.message。`model-call-controller.ts:335-337` 再把这个 reason 放入失败 observation。因此 pytest/vitest 的失败文件、断言和堆栈可能完全不会从自动 gate 到达 model。

离线、零进程效应反例：

```sh
node .ci/source-research/harness-verification-feedback-repro.mjs
```

用一个只返回固定 ExecOutcome 的注入 executor，复用真实 TaskVerifier 和 RuntimeVerifier，实际 output：

```json
{
  "executorStderr": "AssertionError: src/add.ts:12 expected 3 received 4",
  "gateStatus": "failed",
  "gateReason": "unit tests: test-runner: exit 1",
  "failureDetailPreservedInVerificationResult": false,
  "failureDetailPreservedInModelFeedback": false
}
```

该例没有指控错误通过验收；fail closed 正常。它是诊断缺口，优先选择 Agent strategy challenger：先用已有 exec 跑 targeted tests 并读取真实诊断，再修复，最后仍由原 Verification 决定完成。若扩大验证结果携带诊断，必须先定义 bounded + redacted + data-only 的上下文输出合同，确保 secret/injection 不直接进入 system observation，完整日志 artifact 经现有授权路径；不能仅在 system reason 拼入原始 stderr。

策略验收应隔离单一变量并复用 CandidateRegistry/ArmFactory/paired-executor。离线 fixtures 要观察实际 model request、完整工具轨迹和最终内容 verifier；包括测试断言定位、重复错误不盲重试、修复后同命令重跑可通过、伪造“已通过”仍失败、diagnostic injection/secret、预算上限和 baseline contamination 负例。离线结果只能证明工程合同，真实质量增益需要随后独立授权的实模 paired eval；不把 scripted model 的结果写成模型质量提升。

## 6. 本轮已运行的当前能力回归

```sh
pnpm exec vitest run \
  packages/tools/src/edit.test.ts \
  packages/tools/src/vs001.test.ts \
  packages/core/src/runtime/loop-integration.test.ts \
  packages/core/src/runtime/r85-h2-progress-blind-gate.test.ts \
  packages/evaluation/src/paired-plan.test.ts \
  packages/evaluation/src/paired-executor.test.ts \
  packages/evaluation/src/candidate-registry.test.ts \
  packages/evaluation/src/arm-factory.test.ts \
  packages/evaluation/src/champion-profile.test.ts \
  packages/harness/src/verification-wiring.integration.test.ts \
  --reporter=dot
```

2026-10-02 14:47:59 UTC 开始；4.61s；**10 files / 119 tests passed，exit 0**。此证据覆盖上述已有编辑、失败反馈闭环、真实进展重复保护、paired/candidate/profile和自动验收接线；它不是新实现验收、不是全仓测试、不是实模 benchmark，也不是 Windows CI attestation。两个诊断脚本各 exit 0，其断言确认现状缺口，不代表问题已修复。

## 7. 建议给总 plan 的取舍

- 优先局部修复能够通过真正反例证明的工具 lost update / 明确 stale precondition，保持当前 12-step orchestration 和安全规则。
- 避免重建 artifact、recovery、loop guard、verification loop、candidate registry、paired eval、champion profile，当前代码已远超过收集的 Harness 快照。
- 可将安全编辑/诊断优先的策略作为单变量 challenger；生产默认不自动启用，评估身份包括真实 schema/prompt/config digest，复用既有 paired/V3/failed-closed路径。
- 对 snapshot/upstream provenance、许可证与源码重用边界，由总 manifest 和各上游审查补齐；本报告只有机制来源引用，没有复制上游代码。
