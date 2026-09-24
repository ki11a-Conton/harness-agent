# E4-R77 报告：校准基线能力标签，离线验证判分有效性

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260915-033502).md` §6（F3、V4 及判分校准） |
| reviewedSourceSha | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 本次起点 HEAD | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 环境 | Windows (win32)、Node `v24.18.1`、pnpm `11.21.0`、vitest `4.1.10` |
| 真实模型调用 | **0 次**（providerCalls = 0，全程离线） |
| 改动 | 3 个冻结用例内容修订（reg-06 / reg-24 / stress-10-subagents）、新 oracle 测试 26 项、能力表修订 `docs/E4-R77-baseline-cases-rev1.md`、本报告 |

**未**扩大 benchmark 数量（仍 8 例，不新增第 9 个任务）；**未**修改 holdout；
**未**把答案写进被测 fixture（全部对照在临时副本）。

## 2. 逐例映射表（计划 §6.1）

已交付 `docs/E4-R77-baseline-cases-rev1.md` §3：8 个用例逐例的
「用户要求 → 运行时机制 → oracle → 实际可证明结论」表，全部基于对实现的读取
（`packages/tools/src/verification/task-verifier.ts`、`packages/evaluation/src/runner.ts`、
`packages/evaluation/src/baseline.ts`、`apps/cli/src/benchmark-command.ts`），
**不从文件名推断能力**。

## 3. 判分有效性发现（本轮实测）

### 3.1 V1：win32 上 command 校验系统性失效（产品缺陷，有复现）

`TaskVerifier.checkCommand`（`packages/tools/src/verification/task-verifier.ts:170-212`）
把参数用 POSIX 单引号转义（`shellQuote`），而 `ProcessExecutor` 在 win32 上默认 shell
是 `cmd.exe`。拼出的命令在 cmd 下变成非法语法：

```
组装后: node -e 'import('\''./src/strings.js'\'').then(...)'
cmd 下: SyntaxError + "'m.reverse' 不是内部或外部命令"
```

**后果**：任何 `verification.kind=command` 用例在 Windows 上都会失败，**与实现正确
与否无关**。反例（oracle 测试 V1 组）：正确实现经真实 TaskVerifier 判 **FAIL**；
**同一命令**去掉 POSIX 引号直接执行判 **PASS**（exit 0）。原始实现（broken fixture）
在两种路径下都正确判 FAIL，证明 oracle 仍能区分——只是 win32 路径被引号缺陷整体
阻断。

**处置**：记录为产品缺陷（确定性、有复现，满足 AGENTS.md Runtime 变更依据第 1 条），
但**本轮未改** verifier —— R77 授权范围是「校准并验证 8 用例能证明什么」，修 verifier
属于另一项工作。文档层已落实：rev1 §2 明确「Windows 上不得据此判能力；真实基线按
runbook 在 Linux 执行」。`docs:verify` 与本报告如实记录，不装作未发现。

### 3.2 V2：artifact 校验不查内容（基准用例本身弱）

artifact 检查 = 文件存在 + （mustChange 时）出现在 changedPaths，**从不检查内容**
（task-verifier.ts:214-246）。实测零字节文件满足 `mustChange`。影响 stress 用例：
**修订前**「只写一个文件」即可通过 artifact 断言——计划 §6.5 担心的场景实测成立。

### 3.3 V3 / V3b：reg-06 原 spec 不可运行

- V3：`node --test test/` 在本 Node 上把 `test/` 当模块路径（`Cannot find module`），
  **正确实现也会失败**——即使代理完成全部工作也拿不到 PASS。
- V3b：候选替代「裸 `node --test`」在**没有**测试文件时 exit 0，无法区分「没写测试」。

修订为显式路径 `node --test test/parse.test.js`（存在且通过才 exit 0；缺失 → FAIL），
并同步 request.md / expected.md。

### 3.4 V4：reg-24 的 R74 能力标签失实

R74 把 reg-24 称为「工具失败恢复」。事实：request 只要求代码层 catch parse 错误；
oracle 只查坏 JSON 单点返回值；**没有任何机制观测**「agent 运行时遭遇工具失败→
恢复」。且修订前 `readJson` 恒返回 `null` 的实现能通过（恒 null 反例，实测
exit 0）。处置：reg-24 标签改为「**代码错误处理修复**」；「工具失败恢复」记为
**缺失能力**；oracle 增加正确路径（合法 JSON 仍返回对象）使恒 null 失败（§4）。

### 3.5 其他映射校正

- stress 的 `subagent.started ≥ 10` 是**启动数**，不证明并行度、十次成功或内容正确
  （rev1 §3.8「未覆盖」栏）；并行机制走真实 Delegator（`runner.ts` expectedEvents
  judge + benchmark-command 既有 P4-8 测试），不重复实现计数。
- adversarial 两例的违规判据（forbidden reads/commands/network、denied 语义）走
  **既有真实 judge**：`packages/evaluation/src/runner.test.ts`（「expected a denial
  but no tool was requested」「forbidden read succeeded」）与
  `security-taxonomy.test.ts`，本轮引用不复制。未读取真实 `/etc/passwd`、未执行恶意
  指令。

## 4. 冻结用例修订（计划 §6.7：形成修订版与新指纹）

| 用例 | 修订内容 | 旧→新指纹（caseInputFingerprintV1，前 16 位） |
| --- | --- | --- |
| reg-06-json-parse-test | spec 改显式路径；request/expected 对齐 | `fcb96fcafef67906…` → `db758ccd35be4f37…` |
| reg-24-error-handling | 增加合法 JSON 断言 + `fixture/data/good.json` | `59ee72b3444ea5d9…` → `f0fa666d25bac795…` |
| stress-10-subagents | 增加 ≥10 非空行 content 断言 | `a01b1467086e7bf9…` → `6a3ad4ce65e8af7e…` |

其余 5 例指纹未变。新旧对照全部 8 例见 rev1 §1。**R74 历史文档原样保留**，不伪称
原冻结集未变；执行真实基线前必须重新 dry-run（rev1 + runbook 已注明）。

## 5. 离线 oracle 双向对照（计划 §6.3/§6.4）

新增 `packages/evaluation/src/e4-r77-baseline-oracle.test.ts`（26 项，**全 PASS**），
走**真实 loader + 真实 TaskVerifier/ProcessExecutor**，不测自建平行判分函数；正确/
作弊实现只进临时副本：

| 对照 | 断言 |
| --- | --- |
| 5 个 regression（原始 fixture） | 全部 FAIL（直接执行路径） |
| 5 个 regression（request 最小正确实现） | 全部 PASS（含修订后 reg-06/reg-24） |
| reg-24 恒 null（修订前 spec，历史） | PASS（证明原 oracle 弱） |
| reg-24 恒 null（修订后 spec） | **FAIL**（V4 已修） |
| reg-24 忠实实现（修订后 spec） | PASS |
| stress 空文件（旧 artifact-only） | PASS（V2 复现） |
| stress 空文件（修订后完整 spec） | **FAIL**；10 行文件 → PASS |
| reg-06 旧 spec / 新 spec 双向 | 旧不可运行；新 spec 正确测试 PASS / 无测试 FAIL |
| V1 | 正确实现经真实 verifier 在 win32 FAIL；直接执行 PASS（缺陷钉住） |
| loader | 修订后目录仍被真实 loader 接受，8 例加载 |

**注意**：以上 command 类对照在 Windows 上用「直接执行 spec argv」评估（避开 V1 引号
缺陷），这是 win32 环境的诚实下限；Linux 上真实 TaskVerifier 路径不受 V1 影响，由
R78 交接时在 Linux 上验证。

## 6. 命令与退出码

| 命令 | 退出码 |
| --- | --- |
| `pnpm exec vitest run packages/evaluation/src/e4-r77-baseline-oracle.test.ts` | **0**（Tests 26 passed） |
| 证据 | `docs/r77-evidence/r77-oracle.txt` |

`pnpm build` 与 `pnpm docs:verify` 在 R78 收尾统一执行（见 `docs/E4-R78-report.md`）。

## 7. 验收对照（计划 §6）

| 计划 §6 验收项 | 结果 |
| --- | --- |
| 8 个用例均有准确映射表 | ✅ rev1 §3 |
| reg-24 不再被当作恢复率证据 | ✅ 标签改为「代码错误处理修复」，恢复率记缺失能力 |
| regression 原始错误实现失败，正确实现通过 | ✅ §5 双向；reg-24 恒 null 反例失败 |
| stress 仅「写个文件」不足以通过；启动数量下限保留；不可证明项明确列出 | ✅ V2 修复 + 事件下限保留 + rev1 §3.8 未覆盖栏 |
| 使用真实 loader/judge 路径 | ✅ 非自建判分；既有 judge 测试引用 |
| 构建、所修改测试、docs:verify 通过 | ⏳ 目标测试 ✓；build/docs:verify 在 R78 |
| 保存离线结果，providerCalls=0，不填真实模型成功率 | ✅ |
| 交付能力表、case/test 改动、修订说明 | ✅ rev1 + §4 |
| 没有证据的问题不得列为已确认产品 bug | ✅ 发现均先建复现测试再定论（V1/V2/V3/V4） |

## 8. 未做的事（边界）

1. **未**修 verifier 的 win32 引号缺陷（V1）——超 R77 授权；已用测试钉住 + 文档声明。
2. **未**在真实 Windows TaskVerifier 上让 command 用例"变绿"——V1 使 win32 系统性
   FAIL，这是被测平台缺陷，不是能力结果。
3. **未**读取真实 `/etc/passwd`、未执行真实恶意命令、未用真实模型。
4. **未**修改 holdout；**未**新增第 9 个用例；**未**为通过而削弱权限、digest、计费或
   隔离检查（V1 修复会加强而非削弱，已留待授权）。
5. 保留历史：R74 全部文档与旧指纹原样，修订只走 rev1。
6. 真实基线成绩仍 **NOT_RUN**；费用 **UNKNOWN**。
---

## 9. 勘误与后续修复（E4-R79，追加，不修改上文历史事实）

本节由 E4-R79 追加。上文第 1～8 节记录的是 R77 当时的事实，**不予改写**。

1. **V1 已在 E4-R79 修复。** 本报告 §8.1 写明「未修 verifier 的 win32 引号缺陷」。
   E4-R79 已将该缺陷修好：结构化 `command + args` 现在由
   `ProcessExecutor.runArgv` 以 `spawn(file, args, { shell: false })` 直接执行，
   `TaskVerifier.checkCommand` 明确分流（有 `args` 走 argv，无 `args` 保留 legacy
   shell recipe），`shellQuote` 已删除。修复后 6 个冻结 command 用例经**真实
   TaskVerifier** 判分：错误 fixture 失败、正确实现通过（Windows 与 Ubuntu 一致）。

2. **§8.2 的「command 用例在 win32 系统性 FAIL」不再是现状。** 该条描述的是 R77
   当时的平台缺陷，现已不成立。R77 当时**没有**把 command 用例在 Windows 上做绿是
   正确的（那时它确实系统性失败）；本勘误只更正「当前状态」，不否认历史。

3. **新增的注入风险已一并消除。** 原实现把 args 拼进 shell 字符串，参数内的 `&`、
   `;` 会被当作第二条命令执行（E4-R79 实测复现）。argv 路径下结构上不可能发生。

4. **测试契约变更。** 本报告 §5 依赖的 `runCommandSpecDirectly` 曾是「绕过
   verifier 的自建 direct-argv helper」。E4-R79 已把它改为调用**真实
   `TaskVerifier`**——否则 oracle 无法发现生产路径自身的缺陷。该 helper 的名字保留，
   行为已换。

5. **CI 事实更正。** R77 交付时 CI 在 Ubuntu 上为红：本报告钉住 V1 的测试无条件断言
   `expect(false)`，而 Ubuntu 上真实 verifier 正确返回 `true`。该断言在 E4-R79 中已被
   替换为**平台无关的正向契约**（不是加 `skipIf`、不是删除）。

详见 `docs/E4-R79-report.md`；原始实测数据见 `docs/r79-evidence/`。
