# E4-R41 Report — 宿主机探测失败显式为 unknown，不再伪装成「已修改 / 未修改」（K02）

- reviewedSourceSha（本计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- 被测工作树：本报告所属的 **R41 实现提交**（`E4-R41: …`）。
- 状态：**RESOLVED（K02）**——探测失败不再被吞成空字符串，`unknown` 成为一等结果，
  promotion-grade 在必要宿主机状态不可验证时 fail-closed。
- 真实模型调用：**0**（全部离线；故障用可注入的命令执行 seam 确定性注入）
- 平台：Windows（win32）

---

## 1. 做了什么

K02 的实证复现（计划 §4）：**子进程友好的 fake git 下，`captureHostState` 把非零/超时错误
吞成空字符串**，于是 `hostMutated` 把「探测失败」与「探测成功且未变」混为一谈；
`withHostMutationSentinel` 在前后两次探测都失败时仍运行 callback，返回
`hostMutated=false`、`details=[]`——**缺失证明被当成了安全证明**。

本轮做了三件事，全部是**最小生产修复**（不重写 Runtime）：

1. `gitOutput`（吞错 → `""`）改为结构化的 `gitProbe`：成功/非零退出/超时/信号/spawn 失败
   各自成为**带原因的结果**；合法的空 porcelain 只可能来自**成功**的 `status` 调用。
2. `HostState` 增加 `headValid` / `statusValid` / `probeErrors`；新增三态比较
   `compareHostState(before, after) → "unchanged" | "changed" | "unknown"`。
   `unknown` 既不是「已修改」也不是「未修改」——它是「无法判定」。
3. promotion-grade 执行（`processConfinement === "strong"`）：**执行前**探测不可验证 ⇒
   该 case 不启动（不产生任何 provider 调用）；**执行后**探测不可验证 ⇒ 该 case 不可被认证为
   可晋升的成功，按 infrastructure 失败关闭。**不**把未知写成「子进程越界写入」的断言式原因。

---

## 2. K02 要求 → 实现对照

| 计划要求 | 实现落点 | 证据 |
|---|---|---|
| 修复 `gitOutput` 把非零/超时错误变成空字符串的语义丢失 | `benchmark-isolation.ts` 的 `gitProbe` → `GitProbeResult{ok,stdout,error}`；`HostProbeError{probe,kind,exitCode,signal,message}` | §5「non-zero / timeout / spawn failure 各自分类」 |
| `captureHostState`/sentinel 结果携带可判定有效性与失败原因 | `HostState.headValid/statusValid/probeErrors`；`SentinelReport.status/probeErrors` | §5「both probes failing yields UNKNOWN」 |
| promotion-grade 在必要宿主机状态不可验证时 fail-closed，错误归类准确 | `benchmark-command.ts` 的 before-probe 早退（`processConfinement === "strong"`）+ after-probe 的 unknown 分支；均 `failureCategory: "infrastructure"` | §5 CLI 路径测试 |
| 采用清晰的三态比较，unknown 不沿用「child processes wrote outside workspace」的断言式原因 | `compareHostState`；unknown 的 reason 为「host state is UNKNOWN / probe failed …」 | §4 |
| 合法空 porcelain 只能来自成功 status；rev-parse 失败不与合法源状态混同 | `captureHostState` 里 `status.ok ? stdout : ""` 与 `rev-parse` 独立 validity | §5「an empty porcelain is only 'clean' when the status call SUCCEEDED」 |
| 不得靠禁用 sentinel / 忽略错误 / 补默认 clean=true 取绿 | 未改 sentinel 开关；未知一律不被当作 clean | §3（无 `clean=true` 默认） |
| 健康探测发现真实变化仍拒绝并保留原始事实 | `changed` 分支与原有失败语义逐字保留 | §5「verified change … still 'changed'」 |
| 将错误信息接入 R40 的诊断；不输出无关命令环境/机密 | `HostProbeError.message` 只含 git 的 stderr/异常消息，不含 env/凭据；随 `hostMutation` 进入 paired 产物 | §3 |
| 不对探测失败无限重试，也不计作模型能力失败 | 单次探测；`failureCategory: "infrastructure"`（非 model/agent 失败） | §5 CLI 测试 |

---

## 3. 改动清单

- `packages/evaluation/src/benchmark-isolation.ts`
  - 新增 `HostProbeError`、`GitProbeResult`、`GitProbeFn`（可注入 seam，测试用）。
  - `gitOutput`（吞错）→ `gitProbe`（结构化、分类错误）。
  - `HostState` += `headValid`/`statusValid`/`probeErrors`；`captureHostState` 现支持
    `opts.gitExec` 注入并如实体现在有效性与原因。
  - `HostStateSummary` += `headValid`/`statusValid`/`probeErrors`（随 R40 产物持久化）。
  - 新增 `HostMutationStatus` / `HostMutationComparison` / `compareHostState`。
  - `hostMutated` 改为 `compareHostState(...).status === "changed"`（unknown ⇒ false，并在文档中
    明确「需要 fail-closed 的调用方必须看 `status`」）。
  - `SentinelReport` += `status`/`probeErrors`；`withHostMutationSentinel` 用三态比较，
    失败细节不再为空。
- `packages/evaluation/src/runner.ts`
  - `EvalOutcome.hostMutation` += `status`（三态）。
- `apps/cli/src/benchmark-command.ts`
  - `runOneCase`：新增 `hostProbeInfrastructureOutcome` 早退构造器；before-probe 记录
    有效性与原因，promotion-grade 不可验证即早退（**在任何 provider 调用之前**）；
    after-probe 改用 `compareHostState`，`changed` 走原失败语义，`unknown` 在 promotion-grade
    下 fail-closed（**不**断言逃逸）。
- `packages/evaluation/src/benchmark-isolation.test.ts`
  - 新增 `describe("E4-R41 host probe failure semantics (K02)")` 6 例（§5）；既有 14 例全部保留。
- `apps/cli/src/benchmark-command.test.ts`
  - 新增 `describe("E4-R41 promotion-grade host-probe fail-closed (CLI path)")` 1 例（§5）。

**未改**：`promotionEligible` 的判定、隔离后端矩阵、`isPathOutsideWorkspace`、
既有安全负例、任何 `clean=true` 默认。**未**新增重试。

---

## 4. 三态语义（核心）

```
             before 探测成功?  after 探测成功?
unchanged        ✓ ✓            且 head/status/treeDigest 均无差异
changed          至少一个「两侧都成功」的信号出现差异（head / status / treeDigest）
unknown          任一侧的必要探测失败 ⇒ 既不能确认变化，也不能排除变化
```

- `unknown` **不是** `changed`：因此不会再出现「无依据地被归因为子进程越界写入」。
- `unknown` **也不是** `unchanged`：因此不会被当作 clean 证明（这正是 K02 的 bug）。
- `hostMutated()` 保持 `boolean` 契约（`unknown → false`），需要 fail-closed 的调用方
  **必须**读 `compareHostState(...).status`／`SentinelReport.status`——这一点已写入代码文档。

---

## 5. 验证（确定性命令故障）

### 5.1 helper 层（`benchmark-isolation.test.ts`）

`env -u NODE_OPTIONS pnpm vitest run packages/evaluation/src/benchmark-isolation.test.ts`
→ **20 passed / 20**（既有 14 例 + 新增 6 例）。新增用例：

| 用例 | 断言要点 |
|---|---|
| both probes failing yields UNKNOWN | `status="unknown"`、`hostMutated()===false`、`probeErrors.length===2`、details 含 UNKNOWN 与状态原因 |
| an empty porcelain is only 'clean' when the status call SUCCEEDED | rev-parse 失败 ⇒ `headValid=false` 且整体 unknown；**status 失败 ⇒ `statusValid=false` 且 `kind="timeout"`**（空 porcelain 不等于 clean） |
| non-zero / timeout / spawn failure 各自分类 | `probeErrors[].kind` 分别为 `nonzero-exit`（exit=3）/`timeout`（signal=SIGTERM）/`spawn-failure` |
| a failure on EITHER side makes the comparison UNKNOWN | 前次成功、后次失败 ⇒ `unknown`（不是 changed） |
| verified change … still 'changed'；identical … 'unchanged' | 两侧成功且 HEAD 不同 ⇒ `changed`；两侧成功且一致 ⇒ `unchanged` |
| **the REAL sentinel** reports status=unknown + probe errors | `withHostMutationSentinel`（真实路径，注入故障 seam）：`status="unknown"`、`hostMutated===false`、**`details.length>0`**、`probeErrors.length===4`（2 探测 × 2 次捕获）——正是 K02 修复点 |

> 既有安全负例（E3-09 effect prevention、detect tracked modification、in-workspace 不误报）
> 全部保留并通过，未放宽。

### 5.2 CLI / 真实受保护调用路径（`benchmark-command.test.ts`）

`env -u NODE_OPTIONS pnpm vitest run apps/cli/src/benchmark-command.test.ts`
→ **66 passed**，新增用例在**脏工作树**上按预期被「干净树门禁」提前拒绝（见 §6 附录）。
新增用例（promotion-grade：mock 强隔离后端 + mock `captureHostState` 返回不可验证状态）：

- `expect(providerCalls).toBe(0)` —— **受保护动作从未执行**；
- `expect(res.exitCode).not.toBe(0)`；
- 落盘的 `paired-experiment.json` 含 `UNVERIFIABLE` 原因（干净树复验，见附录 A）。

---

## 6. 门禁实测（R41 自身范围）

| 项目 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | **PASS**（退出 0） | 全部改动类型正确 |
| `benchmark-isolation.test.ts` | **PASS 20/20** | 含 6 个新 K02 用例 |
| `benchmark-command.test.ts` | **66/67**（新增用例需干净树） | 无回归；见附录 A |
| 真实模型调用 | **0** | 全部离线 / seam 注入 |

> 全量 `pnpm test` / `docs:verify` / `security` / `protocol` / `race` / `chaos` 属 **R44**
> 的静止工作区最终门禁范围。

---

## 7. 一页结论

1. **K02 已关闭**：探测失败不再被吞成空字符串；`unknown` 是一等结果，既不被当作
   「已修改」（无依据归因子进程逃逸），也不被当作「未修改」（缺失证明冒充安全证明）。
2. **fail-closed 到位**：promotion-grade 在**执行前**探测不可验证时**不启动**（零 provider 调用），
   在**执行后**不可验证时不产出可晋升的成功；错误归类为 infrastructure。
3. **未越界**：未重写 Runtime；未改隔离后端矩阵与 prompotion 判定；未放宽任何安全负例；
   未新增重试；未补默认 `clean=true`。
4. **因果纪律**：**K02 与历史 K01（有效链被判 INVALID）的因果关系仍需单独证明**。R40 已把
   K01 归因于**干净树前置条件**；本轮 K02 修复的是**探测错误的语义**，两者是**不同**的缺陷，
   不因本轮修复而宣称历史 INVALID 已被一并解决。

---

## 8. 残余限制

- `probeErrors.message` 直接来自 git 的 stderr/异常消息；本仓 git 消息不含环境变量或凭据，
  但若未来替换 `gitExec` 需保持同样的「不输出机密」约束。
- `hostMutated` 保持 `boolean`（`unknown → false`）以兼容既有调用方；语义收紧体现在新 API
  `compareHostState`／`SentinelReport.status`。**未**强制旧调用方迁移（避免无谓的协议破坏）。
- `HostStateSummary` 新增字段会进入 R40 的 `paired-experiment.json`；这是**追加**（向后兼容），
  未改动 `schemaVersion`。
- CLI 路径用例与 E4-09 一样受「运行期干净源树」约束（见附录 A）。
