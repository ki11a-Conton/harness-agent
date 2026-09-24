# E4-R18 报告：让 observation 验证证据，而不是相信 JSONL 的 passed（N15/N16）

```text
任务：E4-R18（修复 N15/N16）
起始 SHA：2d21fe7（E4-R17 报告）
被测源码 SHA：43f20d7（E4-R18 提交，本地 main，未推送）
开发工作树 fingerprint：43f20d7 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（strict observation reader + 两阶段提交 + run 隔离；审计消费端
      精确 SHA/符号/测试文件校验；e4-09 真实 E2E 改为收集→提交→审计自证）
```

## 1. 缺陷与复现

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N15 | `loadObservationEvidence` 只查 schemaVersion+runStatus——合法 schema、runStatus=passed 但 testedSourceSha=null、symbol 错、test 文件不存在、evidenceDigest 全 0 的伪造行仍 observed=true | strict 解析：全部字段必填+类型、testedSourceSha 必须 40-hex git sha、evidenceDigest 对规范行体重算且必须匹配（伪造全 0 digest 拒绝）；schema 升到 `e4-r18-v1`（旧 `e4-r08-v1` 行缺 runId/完整性，一律拒绝） |
| N16 | `observeCapability` 在测试**后续断言前**就写 passed 行；全局追加 tmpdir JSONL（跨测试/跨重跑混入）；无最终测试结论关联 | 两阶段提交：`createObservationRun` 收集候选观察，**所有断言通过后**才由测试结束钩子 commit 写入；每次运行独立 runId 文件（`<dir>/<runId>.jsonl`）；审计消费**指定 runId**——旧成功运行无法掩盖当前失败 |

审计消费端（usage-audit.ts）：`observed` 要求 capabilityId 与**注册符号**匹配、
audited HEAD 与行 SHA 均已知且**精确相等**、行内 testFile 在根目录下真实存在。

## 2. 实现

| 文件 | 职责 |
|---|---|
| `apps/cli/src/observation-evidence.ts` | strict 解析（`observationEvidenceIssues`/`parseObservationEvidence`）；`computeObservationEvidenceDigest` 自排除 evidenceDigest；per-run 文件（`observationEvidencePathForRun`）；`createObservationRun`（observe/commit 两阶段）；`loadObservationEvidence(runId)`/`loadAllObservationEvidence`（诊断） |
| `apps/cli/src/usage-audit.ts` | `runId` 过滤；`evidenceFor` 精确 SHA/符号/测试文件存在校验 |
| `apps/cli/src/usage-audit.test.ts` | 16 条回归（伪造 digest、null SHA、错 symbol、虚构 testFile、stale SHA、错 runId、先观察后失败不留证明、committed 控制、注释/import/typeof 永不 observed） |
| `apps/cli/src/e4-09-production-e2e.test.ts` | 改为收集→全部断言后 commit→用自身 runId 做 strict audit 自证（7 个关键能力全 observed） |

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| bad digest、null/错 SHA、wrong symbol、缺 test-run、错 runId 都不能 observed | ✅ | 五条独立负例全绿 |
| 同一测试写 observation 后故意失败，最终 audit 仍失败 | ✅ | observe-then-fail 测试：commit 不调用 → 无文件 → observed=false |
| 同 SHA 先成功再失败，读取失败 runId 不会拿旧成功顶替 | ✅ | `old-successful-run` 已提交，审计 `current-failed-run` → false |
| 合法 run 的 runtime event、测试终态、artifact digest 可以关联并通过 | ✅ | committed 控制组：collector commit 后同 runId 审计 observed=true |
| 注释/import/typeof/文件名旧负例继续不能 observed | ✅ | F17 测试保持通过 |
| CLI/Web 真实能力发生与测试终态均有独立依据 | ✅ | e4-09 全链断言通过后才 commit；观测行含 invocation（真实阶段链）；审计只信 committed 行 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm exec vitest run apps/cli/src/usage-audit.test.ts` | PASS：**16 tests** |
| `pnpm exec vitest run apps/cli` | 379 tests：375 passed / 4 failed（仅 e4-09 脏树 dirty-refusal） |
| `pnpm test`（全仓） | 311 files：**5618 passed / 1 skipped / 4 failed**（仅 e4-09，pristine/CI 下通过） |

- reviewedSourceSha：`43f20d7`。
- 真实模型网络调用数：**0**；fake 调用数：0。

## 5. 未完成 / 后续任务接口

- 审计的 CLI 默认路径（无 runId）为诊断模式（扫描全部已提交 run）；release-grade
  必须传 runId——R19 registry 将把指定 run 的 evidence 文件接入 `capability:audit`
  门禁。
- 观测行与“runtime event/调用记录”的逐条关联保持 invocation 文本 + 产物 digest；
  更深的运行时事件引用若需要，由后续任务按同一格式扩展（字段必填约束已就位）。
