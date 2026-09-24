# E4-R24 Report — 观察证据必须来自指定运行的最终通过结果（F03/F04）

- 被测 SHA（reviewedSourceSha）：`05c90f2a73b5f790398c637116711097c2ebce95`
- 上轮审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 状态：PASS（逐条验收证据见下）
- 真实模型调用：0（全程离线；e2e 使用 mock/scripted provider）

## 1. 问题复现（修复前）

### F03 — 旧 run 记录可被原样复制为新 run 的证据
`loadObservationEvidence` 按 runId 找文件，但不校验行内 runId。`old.jsonl` 原样复制为 `new.jsonl`
后，请求 `new` 时行内 runId 仍是 `old`，但旧 loader 照单全收：

```json
{"id":"OBSERVATION_RUN_REPLAY","requestedRun":"new","loadedRun":"old","observed":true}
```

另外 `usage-audit --strict` 分支此前不传 runId，会扫描全部历史 run——内部函数支持指定 run，
不等于 CLI 已落实严格单次运行语义。

### F04 — observation commit 早于测试最终结果
源码确认 `apps/cli/src/e4-09-production-e2e.test.ts` 在 `observationRun.commit()` 后仍执行 audit
断言、在 `finally` 中 `await harness.close()`；这些后续失败不会撤回已写入的 passed 记录。
commit 是测试函数内调用，不是测试框架确认最终结果后的 hook。

## 2. 改动

| 文件 | 改动 |
|---|---|
| `apps/cli/src/observation-evidence.ts` | 两阶段提交：`createObservationRun` 只写 candidates（append-only、worker 安全）；`commitObservationRun` 由框架最终结果发布 committed 行；loader 要求行内 runId == 请求 runId；safe-runId 校验（无分隔符、无穿越）；候选行 schema 与证据行 schema 分离；temp-file + atomic rename |
| `apps/cli/test-infra/observation-vitest-reporter.ts` | 新增 final-result reporter：`onTestRunEnd` 依据框架最终状态（测试自身 state + 全部 suite/module 祖先 errors，覆盖 afterEach/afterAll/collection）生成 finals 并调用 `commitObservationRun`；状态仅当 `finallyPassed` 才为 `passed`（vitest 4.1 实测：hook 失败后测试自身 state 仍为 `passed`，必须走祖先 errors 判定） |
| `vitest.config.ts` | `E2E_OBSERVATION_RUN_ID` 存在时挂载该 reporter；本地普通运行不变 |
| `apps/cli/src/usage-audit.ts` | `testName` 必须在 testFile 源码中声明（testFile 存在不等于 testName 执行过） |
| `apps/cli/src/commands.ts` | usage-audit 严格参数解析：`--strict` 缺 `--run` 非零、未知参数拒绝、`--run` 缺值拒绝、非法 runId 拒绝；诊断扫描标注 NOT release-grade |
| `apps/cli/src/e4-09-production-e2e.test.ts` | 移除测试内 commit 权威；testName 改为与框架字面测试标题完全一致（候选名与最终身份绑定） |
| `apps/cli/src/usage-audit.test.ts` | 新增 F03/F04 单测：old→new 复制不 observed、testName 未声明不 observed、无最终结果丢弃、retry 去重、candidates 文件不作证据、穿越 runId 拒绝、CLI 参数契约 7 例 |
| `apps/cli/src/e4-r24-final-result-protocol.test.ts` | 新增真实 Vitest 子进程协议测试（green/assert-fail/hook-fail 三模式） |
| `.github/workflows/ci.yml` | verify job 命名本轮 run（`E2E_OBSERVATION_RUN_ID=… ${{ matrix.os }}-${{ github.run_id }}`），证据写入 workspace；Build 后新增独立 `usage-audit --run <id> --strict` 步骤；观测证据上传为 artifact |
| `.gitignore` | 忽略 `apps/cli/src/e4-r24-fixture-*.test.ts`——临时 fixture 不进 `git status --porcelain`，避免与并发 promotion 基准（要求干净树）竞态 |

## 3. 实际调用链（测试运行 → 结果 → observation → strict audit）

```text
CI: E2E_OBSERVATION_RUN_ID=e4-r24-<os>-<run_id>  E2E_OBSERVATION_EVIDENCE_DIR=.ci/observation-evidence
        │
        ▼
vitest run（多 worker 并行）
  ├─ e4-09: createObservationRun(runId).observe(...)      ── 只写 <run>.candidates.jsonl（append）
  ├─ 其他测试：不产生候选
  │
  ▼  run 结束（onTestRunEnd，主进程）：
observation-vitest-reporter
  ├─ 逐测试收集 finals：{testFile, testName(名称+全名), status = finallyPassed? "passed" : "failed"}
  │    finallyPassed = 自身 state == passed ∧ 无任何 suite/module 祖先 errors（afterEach/afterAll/collection）
  ├─ commitObservationRun(runId, finals)
  │    对每个候选：有匹配 final 且全部 passed → 生成 runStatus="passed" + resultDigest 行；
  │    否则 dropped。temp 文件 + 原子 rename 发布。
  ▼
<run>.jsonl（仅 committed 行）
  │
  ▼  独立进程、测试之后：
usage-audit --run <runId> --strict
  ├─ loader：行内 runId == 请求 runId；evidenceDigest/resultDigest 重算匹配
  ├─ testedSourceSha == HEAD；testFile 在仓库中存在且包含该 testName 字面量
  ├─ 7 项 KEY_CAPABILITIES 全部 observed → exit 0；任一不满足 → exit 1
```

## 4. 验收证据（逐条 + 实际命令 + 退出码）

| 验收条目 | 证据 | 结果 |
|---|---|---|
| old 行复制到 new 文件：请求 new 时 observed=false | `usage-audit.test.ts` "rows copied verbatim from an OLD run file"/"N16: a different runId cannot read another run's success"；子进程 assert-fail 后再复制旧 run 行仍不 observed | PASS |
| 缺 runId 的 `--strict` 明确失败 | `node apps/cli/dist/main.js usage-audit --strict` → exit 1；输出 "requires --run \<runId\>" + "DIAGNOSTIC…never certify" | PASS |
| 先 observe 后 assertion fail：没有 committed passed 证据 | 子进程协议测试 "assert-fail run"：`[observation] committed 0 row(s), dropped 1 candidate(s)`，`loadObservationEvidence` 0 行，audit observed=false | PASS |
| 测试 body 通过、cleanup/hook 失败：最终严格审计不通过 | 子进程协议测试 "hook-fail run"：`committed 0 row(s), dropped 2 candidate(s)`，audit observed=false。vitest 4.1 实测 hook 失败后 test.state 仍为 "passed"，reporter 通过祖先 suite.errors() 判定 | PASS（实证修复） |
| 同 SHA 旧运行成功、新运行失败：新运行不能借用旧证据 | F03 单测 + 子进程 assert-fail（同 HEAD） | PASS |
| 不存在的 testName，即使文件存在且 row digest 正确，也不能证明 observed | `usage-audit.test.ts` "testName not declared in the testFile source is never observed（digests correct or not）" | PASS |
| 多 worker、retry、重复提交有确定结果，无跨 run 污染 | 单测：重复候选去重为 1 行、同名混合结果不提交、candidates 文件从不作证据；多文件并行命名运行（e4-09+协议+e3-13，3 worker）7 行提交、0 丢弃 | PASS |
| 真实生产 E2E 成功后，独立 usage-audit --strict 七项全部 observed | 见下方 4.1 实跑 | PASS |
| 用真实离线 Vitest 子进程测试最终结果协议 | `e4-r24-final-result-protocol.test.ts` 3 例（spawn 真实 `vitest.mjs run`） | PASS |
| 行内 runId == 请求 runId | loader 校验 + F03 单测；copy 行被丢弃并输出 degraded 诊断 | PASS |
| runId 路径穿越禁止 | `isSafeObservationRunId`：`../escape`、`a/b`、`a\b`、`..`、`.hidden` 全拒绝；路径派生前校验 | PASS |

### 4.1 本地端到端实跑（模拟 CI，clean tree = 05c90f2）

```text
$ E2E_OBSERVATION_RUN_ID=e4-r24-verify2-20260911-1344 E2E_OBSERVATION_EVIDENCE_DIR=.ci/obs-e2e2 \
    vitest run apps/cli/src/e4-09-production-e2e.test.ts
Test Files 1 passed · Tests 5 passed
[observation] run e4-r24-verify2-20260911-1344: committed 7 row(s), dropped 0 candidate(s)

$ usage-audit --run e4-r24-verify2-20260911-1344 --strict
  PASS createActivationRecorderV2   [tested,wired,observed]  level=observed
  PASS classifySecurityOutcomeV2    [tested,wired,observed]  level=observed
  PASS canonical V3 writer          [tested,wired,observed]  level=observed
  PASS strict promotion loader      [tested,wired,observed]  level=observed
  PASS resolveChampionHarness       [tested,wired,observed]  level=observed
  PASS durable RecoveryStore        [tested,wired,observed]  level=observed
  PASS GateEvidenceV2 generator     [tested,wired,observed]  level=observed
usage audit: PASS (all key capabilities observed)      ← exit 0
```

多文件并行（3 文件、命名运行）同样 7/0 提交、审计 PASS、exit 0。

## 5. 回归

- `pnpm typecheck`（tsc -b 全仓）：exit 0
- 定向回归：`e4-r24-final-result-protocol`（3）+ `usage-audit`（29）+ `e3-13`（3）+
  `e4-r21-release-reverify` + `release-verify`（60）+ `e4-09`（5）全部通过
- 全仓 `pnpm test` 按计划在 E4-R26 收口时于干净树运行（本任务精准范围结束）

## 6. 残余限制

- `resultDigest` 只证明行内 {testFile, testName, runStatus, runner} 与记录一致（内容完整性），
  不能单独证明测试"实际执行"——它依赖 runner 是最终结果来源这一约定。审计还叠加了
  testName-源码绑定与 SHA 匹配，仍不构成对模型质量或其外部语义的证明。
- 发布权威仍在 vitest runner 的可靠完成阶段；若未来引入非 vitest 测试框架，需实现等价
  final-result 发布者（reporter 接口按 runner 枚举维护）。
- F03/F04 的修复没有也不需要修改 Runtime；全部改动位于 CLI 证据链与 CI 编排层。

## 7. 涉及的既有脚本语义变化

`pnpm e4:verify-production-usage`（`usage-audit --strict`）在无 `--run` 时按设计返回非零并给出
指引——这正是 F03 的修复目标（旧的"无 run 扫描全局历史即 PASS"是缺陷）。release-grade 观测
证明迁移到 CI 中显式命名 run 的独立审计步骤。