# E4-R21 报告：统一生产 release 的结构、语义和文件复核（F01）

```text
任务：E4-R21（发布证据消费链统一）
审查基线（reviewedSourceSha）：bcf34b7179152ac2fc24931f268fada8a67f82d9
被测源码：bcf34b7 之上的本任务工作树（gate-evidence-v2.ts / release-verify.ts /
      release-command.ts / ci.yml / 三个测试文件，未提交）
状态：PASS（本地离线验收全绿；真实 CI 消费为 NOT_RUN——未授权 push，
      不声称远端已验证）
真实模型网络调用：0（全部测试为本地 fixture + 真实文件复核）
```

## 1. 问题（F01）与原路径为什么遗漏复核

计划 §2 F01 的最小复现：为全部必需 gate/platform 写入结构完整的 V2 fixture
（引用同一份原始日志并记录正确摘要），随后修改日志。结果：

```json
{"id":"RELEASE_REF_REVERIFY","genericLoaderPassed":false,"productionReady":true}
```

根因是**两条消费链从未共享文件复核**：

- 通用链（`loadGateEvidenceV2`，R19 N18 引入）：readFile → 结构校验 →
  重新读取 artifact/log 字节并重算 sha256 → 不匹配则 NOT_RUN。
- 生产链（`resolveReleaseVerdict` 的 `readGateEvidence`）：
  readFile → `parseRawEvidence` → `validateGateEvidenceInstance` → aggregate。

`parseRawEvidence` 是**有损映射**：只提取 gate/command/exitCode/passed 等简化
字段，把 `logRef`、`artifactRefs`、`environmentClass`、`providerCalls` 全部丢弃。
`validateGateEvidenceInstance` 又只做 HEAD/argv/状态语义检查，没有任何步骤重新
读取被引用的字节。于是 R19 在通用 loader 加的"输出事后篡改 → INVALID"保护，
对生产 release verify 完全不可见：篡改的日志、被删的 artifact、非 offline 的
provider 调用都能带着 READY 语义通过聚合。

## 2. 改动（一次实现，两个入口共用）

| 文件 | 改动 |
|---|---|
| `packages/evaluation/src/gate-evidence-v2.ts` | 新增 `reverifyGateEvidenceRefs`：重新读取并重算每个声明引用（artifact + log）的 sha256，结果类型 `EvidenceRefCheck` 携带 gate/platform/sourcePath/refPath/kind/reason。`loadGateEvidenceV2` 改为调用它（删除自研复核分支）。`RunGateV2Options` 新增 `logRefBase`（logRef 相对 evidence 目录记录，跨平台可携带）。`gateEvidenceV2Issues` 对 `logRef:null`、缺失 digest key、`artifactRefs` 非数组/null 元素/缺 digest key 全部按结构违规拒绝（且不再对 null logRef 抛 TypeError） |
| `apps/cli/src/release-verify.ts` | `RawGateEvidence` 保留 `v2` 原始证据、`providerCalls`、`environmentClass`（消除有损映射）；`validateGateEvidenceInstance` 新增 offline 语义检查：passed 证据必须 `environmentClass=offline` 且 `providerCalls=0` |
| `apps/cli/src/release-command.ts` | `readGateEvidence` 对每条平台实例在语义校验后调用 `reverifyGateEvidenceRefs`（`certifying: state==="passed"`）：certifying 实例必须携带持久化、摘要匹配的输出日志；任何 ref 失败 → 该实例 blocked 并归因 gate/platform/path。`runGate` 以 `logRefBase: evidenceDir` 记录相对日志引用 |
| `.github/workflows/ci.yml` | 上传/下载统一从 `gates/` 根进行，保留 `gates/<platform>/` bundle 布局（evidence refs 相对该目录），Windows→Linux 下载后可复核 |
| 测试 | 新增 `apps/cli/src/e4-r21-release-reverify.test.ts`（13 个用例）；更新 `release-command.test.ts` 夹具写入持久化日志 + 匹配摘要的 logRef；`gate-evidence-v2.test.ts` 补 `logRef:null` / 缺 digest key 结构负例 |

路径协议：相对引用**只**相对 evidence 文件所在目录（trusted bundle root）解析，
绝对路径按原样解析；禁止"先在 evidence 旁找，找不到再到 cwd 找"的隐式双根。
digest 证明的是内容完整性 + 受控证据来源边界，不声称第三方无法重算哈希。

## 3. 现在从读取到 READY 的调用链

```text
release verify（CLI/CI attestation）
  └─ resolveReleaseVerdict({root, evidenceDir, headSha})
       └─ readGateEvidence: 递归扫描 gates/ 下 .json
            每个文件：
            1. readFile + parseRawEvidence        → 结构失败 = structural failure（blocked 伪 gate）
            2. platform 推断 + validateGateEvidenceInstance
                                                 → HEAD/argv/状态语义 + offline providerCalls/environmentClass
            3. reverifyGateEvidenceRefs({evidence: raw.v2, sourcePath, platform,
                                         certifying: state==="passed"})
                                                 → 重新读取 artifactRefs[] + logRef 字节并重算 sha256
                                                 → 任一失败：实例 blocked，reason 指名 gate/platform/refPath
            4. aggregateGateInstances             → 平台覆盖合并（缺必需平台不可由重复平台抵消）
       └─ computeReleaseVerdict → ready ⇔ 全部必需 gate 在全部必需平台 passed
```

通用入口 `loadGateEvidenceV2` 的第 3 步是同一个函数（非 certifying 模式），
两条链对同一 bundle 的字节级判定从此一致。

## 4. 验收矩阵（计划 §5 逐条）

| 验收条件 | 证据（新增负例均在真实生产入口 `resolveReleaseVerdict`/`releaseVerifyCmd` 上） | 状态 |
|---|---|---|
| 有效完整 bundle：通用 loader 和真实 release verify 均成功 | `valid complete bundle … both the generic loader and the real release verify succeed` | PASS |
| 修改/删除任意必要 artifact 或 log → ready=false、CLI 非零、指出 gate/platform/path | `RELEASE_REF_REVERIFY`（篡改日志）、`a DELETED log blocks release READY`、`a tampered declared artifact blocks release READY and names the artifact path` | PASS |
| 同路径在 cwd 放另一份文件不能改变 bundle 判定 | `a file at the same relative path under the process cwd cannot change the bundle verdict`（篡改 bundle 日志后在 spoof cwd 种植原始字节，判定仍 blocked） | PASS |
| bundle 移动到另一目录、改变进程 cwd 后仍正确验证 | `the bundle still verifies after being MOVED to another directory with a different process cwd` | PASS |
| Linux/Windows/coverage 平台覆盖仍严格；缺 Windows 不能被重复 Linux 抵消 | `CI-layout bundle: gates/{linux,windows,coverage}/ keeps strict platform coverage`（删除 windows/build.json + 双 linux 实例 → blocked，reason 含 "missing required platform windows"）；另有 release-command.test.ts 的 P38.3-6 系列 | PASS |
| offline providerCalls 非零、坏引用结构均被拒绝且无未捕获异常 | `an offline gate reporting non-zero provider calls is rejected`、`a certifying instance with a non-offline environmentClass is rejected`、`structurally invalid refs (non-array artifactRefs, null element, missing digest, logRef:null) are rejected without an uncaught exception`（4 组结构负例，verdict 给出归因 reason 而非 TypeError） | PASS |
| 使用现有 release-command/release-verify/gate-evidence 测试集验证 | 见 §5 命令与退出码（122 通过，含更新后的 22 + 43 + 37 + 13… 不降断言） | PASS |
| CI 消费下载后的 bundle，包含必要引用文件，不能通过删除引用规避复核 | ci.yml：上传/下载都从 `gates/` 根保留 `<platform>/` 布局；`DELETING the logRef from the evidence JSON cannot bypass re-verification` 证明删除声明不能规避（certifying 实例缺 logRef 即 blocked）。真实 GitHub run 的跨平台消费：**NOT_RUN**（未 push，不伪称） | PARTIAL |

## 5. 验证命令与退出码

```text
pnpm exec vitest run apps/cli/src/e4-r21-release-reverify.test.ts \
  apps/cli/src/release-command.test.ts apps/cli/src/release-verify.test.ts \
  packages/evaluation/src/gate-evidence-v2.test.ts
→ 4 files / 122 tests passed（exit 0）

pnpm typecheck → tsc -b 无错误（exit 0）
```

- `release-command.test.ts`：22 通过。夹具更新为写入真实日志字节 + 匹配摘要
  的 logRef（协议升级后的正例形态），断言未降低。
- `release-verify.test.ts`：37 通过（无改动即通过——语义层兼容）。
- `gate-evidence-v2.test.ts`：43 通过（新增 `logRef:null` / 缺 digest key 负例）。
- `e4-r21-release-reverify.test.ts`：13 通过（本轮新增）。
- 修复前基线：`RELEASE_REF_REVERIFY` 等复现用例红（productionReady=true 与
  genericLoaderPassed=false 并存，即计划 §2 记录的矛盾）。

## 6. 残余限制

1. 真实 CI（Windows→Linux 下载后的 release attestation 消费）未运行：本任务
   未授权 push。ci.yml 的布局修正由本地
   `the bundle still verifies after being MOVED…` 与 `CI-layout bundle…` 用例
   等价证明目录协议，但跨平台真实 run 的确认留给 R26（或下次 push 后补记）。
2. `logRef.digest` 证明日志字节与运行结束时一致；它不证明日志内容由谁产生。
   内容完整性 + 来源边界是本协议的边界声明（计划 §5.8）。
3. 诊断（非 certifying）实例允许 logRef 缺失/未持久化——此时该日志"未被验
   证"而非"已验证"，输出不含对它的宣称。
4. 根 plan.md 仍指向已被删除的 `plan(20260910-070001).md`（工作树未提交的
   删除）；计划入口轮换按计划 §10.8 属于 E4-R26 收口任务，本任务不改写。
