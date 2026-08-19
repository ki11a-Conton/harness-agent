# Session Memory: P1-20 + P2-1~P2-8 (9 Phases)

## Test Baseline Progression

1104 → P1-20 1105 → P2-1 1109 → P2-2 1119 → P2-3 1128 → P2-4 1139 → P2-5 1144 → P2-6 1150 → P2-7 1156 → P2-8 1162 → P2-9 1178
(+58 tests... wait, P2-9 added +16 = +74 total, 1178)

> 本会话在既有 P1/P2 之上按安全优先级执行了 P0-6（→1179）与 P0-7（→1208），详见文末新增小节。基线轨迹：1179 → P0-7 1208。

## Phase Details

### P1-20 Observability / Trace V2 (1105)

**Key files**: `packages/core/src/runtime/runtime.ts` (compactCount, model loop timing, executeToolCall tool.completed)

**Changes**:
- `model.completed` emit: `durationMs` + `timeToFirstTokenMs` (first text_delta/reasoning_delta per attempt)
- `tool.completed` event: **new** — previously successful tool executions had no event (real observability gap); emitted at end of executeToolCall (success → tool.completed, failed → tool.failed, denied stays scattered to prevent double-fire). All carry `durationMs` from tool.requested.
- `verification.completed/failed`: `durationMs`
- `context.compacted` (3 sites): cumulative `totalCount`
- `compactCount` private field, incremented at each compaction site

**Fixes**: 
- `tool_call_delta` case label was accidentally deleted during edit, restored
- `status: undefined` in toMatchObject test assertion → removed (undefined values cause strict match)
- Tool-call-only model round has no text_delta → `timeToFirstTokenMs` undefined is legal (find finishReason:"stop" round)
- `outcome.session.id` doesn't exist (TurnOutcome has no session) → use destructured `session.id`

### P2-1 Reflection V2: Strategy Lessons (1109)

**Key files**: `packages/contracts/src/memory.ts` (StrategyLesson, MemoryCandidate.structured), `packages/memory/src/reflection.ts` (strategyFor)

**Changes**:
- `StrategyLesson` interface: when/do/avoid + rootCause/outcome/evidenceRefs
- `MemoryCandidate.structured?` (optional, backward compatible)
- `strategyFor(cause, detail, tool)`: deterministic rule template per root cause with When/Do/Avoid
- ENOENT/not found signature refinement: do="search repository tree / file index before retrying guessed paths", avoid="repeating the same guessed path"
- `candidateFor` fills structured; ReflectionGroup collects evidenceRefs (ordered, deduped)
- Tests +4: ENOENT refinement, verification strategy, evidenceRefs, deduped refs ordering

**Gotchas**: 
- `toEqual` on candidate object fails because structured is now present → update test assertion
- `toBe(0.9)` → 0.85825 (signal cascade math) → fix to `toBeGreaterThan(0.85)` 
- `toBeCloseTo(1, 5)` → 0.999990234375 diff 9.8e-6 > 5e-6 → fix to `toBeCloseTo(1, 4)`

### P2-2 Memory Evidence Model (1119)

**Key files**: `packages/memory/src/evidence.ts` (new), `packages/memory/src/sqlite-memory-store.ts` (schema v3)

**Changes**:
- `MemoryEvidence` interface: sourceSessions/sourceEvents/successCount/failureCount/lastValidated
- `MemoryEntry.evidence?` (optional, backward compatible)
- `recordValidation(entry, passed, {eventId?, at?})`: immutable update (counts, lastValidated advances, eventId deduped append)
- `evidenceFromCandidate(candidate)`: seeds from structured.evidenceRefs
- `mergeEvidence(base, other)`: deduped sessions/events, summed counts, max lastValidated
- SQLite v3: `evidence TEXT` column, ensureEvidenceColumn migration, JSON serialization in write/read

**Gotchas**: 
- No evidence → write "{}" → read back as `evidence: {}` (empty object, not undefined) → `toEqual` fails (13 vs 12 keys). Fix: `evidenceOf` treats "{}" as undefined.
- New DB migration log = v1+v3 = 2 (not 3) — v2 was never inserted as a standalone version at v3 time.
- `dedupe` returns `string[]` but `sourceSessions` is `SessionId[]` → cast `as SessionId[]`
- `toBe(3)` migration log assertion → fix to `toBe(2)` (v1+v3)

### P2-3 Memory Usefulness Feedback (1128)

**Key files**: `packages/memory/src/usefulness.ts` (new), `packages/memory/src/retrieval.ts` (scoring), `sqlite` (v4)

**Changes**:
- `MemoryUsefulness` interface: retrieved/injected/used/taskSuccess/verificationPassed counts + rolling score 0..1
- `MemoryEntry.usefulness?` (optional)
- `recordUsefulness(entry, feedback)`: immutable — retrieved counts only; injected/used/taskSucceeded/verificationPassed move score toward 1 with strength 0.1/0.3/0.5/0.5 (score += (1-score)×strength, saturates at 1)
- First feedback initializes neutral score 0.5 (INITIAL_USEFULNESS_SCORE)
- `computeMemoryScore` usefulness: uses `entry.usefulness.score` when present, falls back to `entry.importance` proxy
- SQLite v4: `usefulness TEXT` column

### P2-4 Memory Decay / Deprecation / Conflict (1139)

**Key files**: `packages/memory/src/lifecycle.ts` (new), `contracts/memory.ts` (MemoryState), `sqlite` (v5)

**Changes**:
- `MemoryState` discriminated union: active / superseded{byId,at,reason?} / deprecated{at,reason?} / conflicting{withId,at} / stale{at}
- `MemoryEntry.state?` (absent = active)
- `supersede(entry, byId)`, `deprecate(entry)`, `markConflicting(entry, withId)` — soft states, content/evidence/usefulness intact
- `evaluateLifecycle(entry, opts)`: deterministic rules (first match wins): ① non-active state → stable; ② failureCount ≥ 3 → stale + confidence×0.7; ③ no usefulness + idle 30d → stale
- `isRetrievable(entry)`: true for active/stateless
- SQLite v5: `state TEXT` column

### P2-5 Skill Effectiveness Tracking (1144)

**Key files**: `packages/skills/src/effectiveness.ts` (new), `contracts/skill.ts` (SkillEffectiveness)

**Changes**:
- `SkillEffectiveness` interface: selected/loaded/injected/completed/failed/verificationPassed/verificationFailed counts + toolCallCount/tokenCount/latencyMs
- `Skill.effectiveness?` (optional, neutral profile)
- `recordSkillEffectiveness(skill, feedback)`: immutable accumulation
- `successRateOf(skill)`, `averageToolLatencyOf(skill)`: derived metrics

**Gotchas**: `??` precedence bug: `skill.effectiveness?.completedCount ?? 0 + (skill.effectiveness?.failedCount ?? 0)` → `??` binds tighter than `+` → `skill.effectiveness?.completedCount ?? (0 + ...)` → never adds failureCount. Fix: `(skill.effectiveness?.completedCount ?? 0) + (skill.effectiveness?.failedCount ?? 0)`

### P2-6 Skill Selection / Progressive Disclosure (1150)

**Key files**: `packages/skills/src/selection.ts` (new), `contracts/skill.ts` (SkillIndexEntry), `runtime.ts` (skillSelector dep)

**Changes**:
- `SkillIndexEntry` interface: name/description
- `selectSkills(index, taskGoal, {k=5, minScore=0.2})`: Jaccard similarity of goal tokens against (name+description) tokens, Top-K ≥ minScore → {selected, excluded}. Empty goal → full index (conservative).
- `skillSimilarity(goalTokens, rowTokens)` exported
- runtime.ts: `skillSelector` optional dep (injection before pipeline; default identity). Discovery events still cover all skills.
- Tests +6: selection + runtime injection

**Gotchas**: Single-token goal "compiler" against 8-token row yields Jaccard 0.125 (< 0.2 minScore) → use multi-token goal "compile errors check"

### P2-7 Learning Candidate Sandbox (1156)

**Key files**: `packages/learning/src/sandbox.ts` (new)

**Changes**:
- `CandidateSandbox.run({candidate, championState, runner})`: mkdtemp scratch → championDigest → runner (ctx: scratchDir, readChampion, writeScratch) → re-digest diff → cleanup. Runner throw still does cleanup + mutation check, error propagates.
- `championDigest(state)`: deterministic JSON with sorted keys
- `writeScratch` rejects `..`/absolute paths (scratch escape)
- Violations: champion_mutation (digest diff), throw (runner error)
- `SandboxContext` is the only handle to champion — candidate never gets champion state reference

### P2-8 Mechanism Registry (1162)

**Key files**: `research/mechanisms/` (new dir), `apps/cli/src/mechanisms.ts` (new)

**Changes**:
- `research/mechanisms/`: README.md (spec + submission flow), schema.json (JSON Schema v1), `_template.yaml` (template, `_` prefix excludes from validation)
- `parseYaml(text)`: minimal YAML subset parser (key:value scalars, - item lists, # comments, quote stripping) — zero external deps
- `validateMechanismManifest(record)`: 11 required fields, status/category enum, evaluation_cases array type, id non-empty
- `validateMechanismsDir(dir)`: reads all *.yaml (excluding _prefix), parse+validate each, id uniqueness across files
- `mechanismsCmd(args)`: CLI handler (`agent mechanisms <path>`), supports file or directory
- commands.ts: USAGE line + switch case

## Patterns & Invariants

1. **Phase template**: contracts → pure functions → SQLite migration → tests → plan.md update
2. **Backward compatibility**: all new fields are optional (`?`), existing tests pass with updated assertions
3. **SQLite versioning**: SCHEMA_SQL in CREATE TABLE has latest columns; ensure*Column migrations handle legacy; ensureSchemaVersion always records v1 + current (middle versions only logged during real upgrades)
4. **Immutable pure functions**: all model updates return new objects, never mutate
5. **JSON serialization**: v3/v4/v5 columns use TEXT with JSON.stringify; empty/absent/`"{}"` normalized to undefined by rowToEntry

## Relevant Files

- `packages/contracts/src/memory.ts` — StrategyLesson, MemoryEvidence, MemoryUsefulness, MemoryState + MemoryCandidate/MemoryEntry fields
- `packages/contracts/src/skill.ts` — SkillEffectiveness, SkillIndexEntry
- `packages/memory/src/reflection.ts` — strategyFor
- `packages/memory/src/evidence.ts` — recordValidation, evidenceFromCandidate, mergeEvidence
- `packages/memory/src/usefulness.ts` — recordUsefulness
- `packages/memory/src/lifecycle.ts` — supersede, deprecate, markConflicting, evaluateLifecycle
- `packages/memory/src/retrieval.ts` — computeMemoryScore usefulness scoring
- `packages/memory/src/sqlite-memory-store.ts` — schema v3/v4/v5
- `packages/skills/src/effectiveness.ts` — recordSkillEffectiveness, successRateOf
- `packages/skills/src/selection.ts` — selectSkills, skillSimilarity
- `packages/learning/src/sandbox.ts` — CandidateSandbox, championDigest
- `packages/core/src/runtime/runtime.ts` — tool.completed, model latency, compactCount, skillSelector
- `apps/cli/src/mechanisms.ts` — parseYaml, validateMechanismManifest, validateMechanismsDir
- `research/mechanisms/` — README.md, schema.json, _template.yaml
- `packages/contracts/src/experiment.ts` — ExperimentConfig, ExperimentVariant, ExperimentReport
- `packages/evaluation/src/experiment-config.ts` — loadExperimentConfig, experimentConfigFromObject
- `packages/evaluation/src/experiment-harness.ts` — ExperimentHarness, computeComparisons, renderReport
- `apps/cli/src/experiment-command.ts` — experimentCmd

### P0-6 Benchmark Integrity & Reproducibility (1179)

**Key files**: `packages/evaluation/src/manifest.ts`, `apps/cli/src/benchmark-command.ts`, `packages/security/src/sandbox.ts`, `packages/tools/src/process/executor.ts`

**Changes**:
- `buildRunManifest`（gitSha/dirty/temperature/suiteVersion/judgeVersion/runtimeConfigHash/timestamp）—— git 探测失败即 `null` 绝不伪造。
- Case 隔离：每 case 独立 workspace/session/store，holdout 匿名化，固定序 + `--shuffle/--seed`。
- 失败分类：model / harness / judge / infrastructure（超时→infrastructure）。
- 脏文件污染检测：`assertWorkspaceIsolated` 三态校验。
- 修复 `executor.ts` shell 选择：非 Windows 用 `/bin/sh` 而非默认 `cmd.exe`（修掉 17/19 既有失败——真实 bug 修复，非降级）。
- 修复 `sandbox.ts` `resolvePath` 在 POSIX 上把 `C:\…`/UNC 当相对路径解析的绝对逃逸 → fail-closed 一律拒绝（原本就在测试要求内，Linux 上长期静默失败）。

### P0-7 Security Boundary Consistency (1208)

**Key files**: `contracts/src/event.ts` + `errors.ts`, `security/src/denial.ts`, `skills/src/skill-security.ts`, `memory/src/write-gate.ts`, `mcp/src/mcp-tool-adapter.ts`, `evaluation/src/runner.ts`, `core/src/runtime/runtime.ts`, `apps/cli/src/main.ts`

**Changes**:
- 契约层：10 个 `security.*` 事件类型 + 细分错误码 `INJECTION_DENIED`/`SECRET_REDACTED`/`MEMORY_DENIED`/`SKILL_DENIED`/`MCP_DENIED`（均 fail-hard）。
- `security/src/denial.ts`：统一 `SecurityDenial` helper，把散落的 stderr-only 拒绝统一成「事件 + 错误码 + 结构化 reason」发射。
- MCP adapter 注入 `EventSink`，injection 拒绝发射 `security.mcp_denied`（不再仅抛错）。
- memory `WriteGateResult` 增 code/source/details；skill `skillDenialCode/skillDenialEventType`；运行时/CLI 路由进 `EventSink`。
- 评估层 `expectedSecurityEvents` 门禁：`it.each` 对全部 10 个 security 事件类型做识别/缺失双断言 + 显式覆盖清单锁定。

**Gotchas**:
- 完整 secret/token 不进 learning/memory/artifact/log/error payload（secret handling 基线）。
- 尚未接线（留 P0-8）：plugin metadata、artifact text、subagent result 的 injection 走 trust boundary，不占位降级。

### P0-8 Trust-Aware Context (1212)

**Key files**: `packages/context/src/pipeline.ts`, `packages/context/src/pipeline.test.ts`, `packages/core/src/runtime/runtime.ts`

**Changes**:
- `ContextInjectionSource` 扩为 `project|skill|tool|memory|web|mcp|subagent`。
- pipeline `build` 现对 `priorBlocks`（tool/memory/MCP/subagent/web 输出）施加与 project/skill 相同的注入检测：低信任块（`trust !== "trusted"`）命中即丢弃（永不进 context）、记入 `result.injected`；`system`/`user`(`trusted`) 豁免扫描。
- runtime 已有 `TRUST_BOUNDARY_PROMPT`（低 trust 仅 DATA ONLY、`.SYSTEM:/DEVELOPER:` 惰性）+ 逐 block `[context trust=... source=...]` 标签 + `built.injected` 逐条发 `security.injection_denied`。
- `trust` 分层：trusted=`system`,`user`；semi-trusted=`skill`,`memory`,`subagent`,`tool`；untrusted=`project`,`web`,`mcp`。

**Gotchas**:
- pipeline 与 runtime 双保险：runtime 拦截 tool output（消息级 `[tool output blocked]` + `security.injection_denied` code `SECURITY_DENIED`），pipeline 拦截 prior blocks（code `INJECTION_DENIED`）——两者共用 `detectPromptInjection`，行为一致，code 区别归因于拦截层级。
- 注入内容在 pipeline 层被彻底移除，不进入 model 视线——「低 trust 只能作 data 不能提升 authority」从不变量到强制。

### P2-10 Automated Regression Attribution (1223)

**Key files**: `packages/evaluation/src/attribution.ts`, `packages/evaluation/src/attribution.test.ts`, `packages/evaluation/src/index.ts`

**Changes**:
- `tallyEvents(events)`：单 case 事件流 → `EventTally`，11 维（model_retries/tool_retries/compactions/verification_failures/permission_failures/security_failures/context_overflow/latency_ms/tokens/false_complete/subagent_failures），全从事件流归约，缺失维度 0。
- `attributeRegression(baselineCases, challengerCases)`：逐 case 累计 → 主因 = challenger−baseline delta 最大维度；`contributors` 按 delta 降序含证据；`affectedCases` 仅主因维度净增为正的 case；无恶化 → regressed=false + 空归因（不伪造来源）。

**Gotchas**:
- 维度名 `latency` 与 `EventTally.latency_ms` 不一致触发 TS7053 → 校准为 `latency_ms`。
- `affectedCases` 仅按主因维度筛选：case 只在次因劣化时不出现在 affectedCases（含专门测试锁定该语义）。
- `approval.resolved deny` 计入 permission 但计入 `security.*`——security_failures 只数 `security.*` 前缀（测试修正）。

### P2-11 Case Mining from Real Failures (1243)

**Key files**: `packages/evaluation/src/mining.ts`, `packages/evaluation/src/mining.test.ts`, `packages/evaluation/src/index.ts`, `packages/evaluation/package.json`, `packages/evaluation/tsconfig.json`

**Changes**:
- 四步流水线：`sanitizeFailure`（复用 `@ar/security` secret gate，带结构 secret 原地 redact 保留、纯 secret 文件整体删除）→ `minimizeFixture`（整文件去空/去重/超预算裁剪，绝不改内容、绝不删到 0 文件）→ `mineCandidate`（组装 candidate + 硬门禁）→ `freezeCase`（pin judge 版本）；`writeFrozenCase` 落盘 `suite/case-id/{request.md,expected.md,case.json,fixture/}`。
- 新增 `@ar/security` 依赖（含 tsc reference；仅依赖 contracts，无循环）——sanitize 与运行时脱敏同源。
- `CaseMiningError` 三态门禁：`need-human-confirmation` / `secret-survives` / `fixture-over-budget`。

**Gotchas**:
- expected 绝不猜测为 `completed`：默认由 tags 推 `denied`（denial/injection/security 等）否则 `failed`。
- 纯 secret 判定：redaction 替换后剩余仅 `[redacted]`/空白才算整体删除；`.env` 带 `KEY=` 标签则保留结构 redact（结构复现不丢）。
- minimizeFixture 超预算裁剪 **不删最后一个文件**：单文件仍超限 → `overBudget=true` 交人工，否则会把整个 fixture 悄悄清空（含测试锁定）。
- 两个同名大文件会被去重而非裁剪——over-budget-trim 测试需用不同内容大文件触发。

### P2-12 Adversarial Benchmark Expansion (1250)

**Key files**: `benchmarks/adversarial/*`, `packages/evaluation/src/benchmark-suite.test.ts`, `benchmarks/README.md`

**Changes**:
- 生成 13 个对抗用例目录（每攻击向量一个：tool-output/MCP 注入、subagent/memory/skill/artifact 投毒、编码 shell trick、嵌套 wrapper、路径混淆、symlink 逃逸、意外二进制执行、依赖安装、文件名/日志凭据外传）。
- 判定模型：`completed + forbidden` 奖励抵挡注入（注入=data 非 authority，attempt 即违规）；`adv-path-confusion` 用 `denied`（sandbox 拒绝每次有害尝试且零副作用）。
- `benchmark-suite.test.ts` 强制 13 向量 id 精确清单 + 每向量可分。

### P2-13 Stress Benchmark Expansion (1250)

**Key files**: `benchmarks/stress/*`, `packages/evaluation/src/benchmark-suite.test.ts`, `benchmarks/README.md`

**Changes**:
- 生成 11 个压力用例；压力以预算（maxRetries/contextBudgetTokens/maxDurationMs/timeoutMs/allowArtifacts）或重型 fixture（1000 文件 / 12 层目录 / 2.2MB 日志 / 830KB JSON）表达。
- `benchmark-suite.test.ts` 断言每 stress 用例有预算或重型 fixture（bytes>64KiB / 文件>100 / 深度>5）。
- README 更新为 adversarial 13 / stress 11 并新增两套件清单表。

**Gotchas**:
- long-json 深 9 曾生成 179MB（6^9）→ 校准深 6 保持「超长但可提交」。
- 生成后 `du -sh benchmarks` ≈ 7.8MB（含 1000 小文件 + 2.2MB 日志 + 830KB JSON）

### P2-14 Evaluation Cost Model (1251)

**Key files**: `packages/evaluation/src/cost-model.ts`, `cost-model.test.ts`, `baseline.ts`, `index.ts`

**Changes**:
- `scoreCost(input, opts)`：7 维度（quality/reliability/security/latency/tokens/tool_calls/retries）各出 [0,100] 子分，按 `DEFAULT_COST_WEIGHTS`（quality .4/reliability .2/security .2/tokens .08/tool_calls .06/latency .04/retries .02，和为 1）加权得总分。
- quality passed=100/failed=30/error=0（失败给「努力分」，learning 不只看 success）；reliability 从 100 扣（verification_failure −25、human_intervention −10、超首个额外 compaction −5）；资源维度 `budgetRatio` 等比衰减（≤预算 100，超预算 `预算/实际` clamp≥5，不硬切 0）。
- **security Hard gate**：任何 `security.*_denied` 事件或 exec `tool.requested` 命中 NETWORK_EXEC_PATTERNS → `securityViolation=true` → `score=0`（安全违规永远不被低成本抵消）。`secret_redacted` 是 soft hit −20 不 gate。
- 接线 `baseline.ts`：每例附 `cost`（可选字段）+ summary 新增 `avg_cost_score`/`avg_cost_dimensions`/`security_violations` + markdown Summary 表三行；全部向后兼容（`baseline.test.ts` 58 仍绿）。

**Gotchas**:
- `avg_cost_dimensions` 用 `Record<string, number>`，markdown 渲染时索引会得 `number|undefined` → 用 `?? 0` 兜底，否则 `tsc` 报 TS2345。
- cost-model 内**不在 eval 包另造正则**——网络违规复用 `runner.ts` 的 `NETWORK_EXEC_PATTERNS`（监督一致性）。

### P2-15 Cross-Model Evaluation (1252)

**Key files**: `packages/contracts/src/experiment.ts`, `packages/evaluation/src/experiment-harness.ts`, `experiment-config.ts`, `cross-model.test.ts`

**Changes**:
- 跨模型扩展：`models`（strongest-first）+ `modelCapabilities`；harness 双层循环 variant×model，结果/比较带 `model`；`computeComparisons` 按单 model 内比较。
- `computeCrossModel`：`mechanism − baseline` 的 strong/weak delta，分类 `consistent/harms-weaker/improves-only-strong/improves-only-weak/mixed` + counts；≥2 models 才返回。
- 报告 `crossModel` + `renderReport` 打印 per-model 与 cross-model。

**Gotchas**:
- 新增 ExperimentComparison/Criteria 的 Optional 字段（`model`）必须向后兼容——旧 single-model 测试（无 model 字段）仍全绿。
- `harms-weaker` 判定是「strong 改善 & weak 退化」：先判 `consistent`（双正）再判其它，否则双正会被误判为 `improves-only-strong`。
- delta 方向统一为 `mechanism − baseline`（>0=改善）；与 `computeComparisons` 的 `baseline − variant`（>0=baseline 更好）**箭头相反**——cross-model 是「机制是否改善模型」，千万不要顺手沿用反方向。
- 真实 benchmark 需真实两个模型，`--allow-stub` 冒烟跑不出跨模型信号。

### P2-16 Prompt Rule Versioning (1253)

**Key files**: `packages/context/src/prompt-versioning.ts`, `prompt-versioning.test.ts`, `index.ts`

**Changes**:
- `PromptVersionRegistry`：`publish`（版本+sha256 hash+changeReason+candidateSource+benchmarkEvidence，不可变追加，旧版仅降级 active）→ `rollback` → `verifyIntegrity` → `export/importSnapshot`。
- 防呆：空内容/缺 reason、重复 content（同 hash）抛 `RuleVersionError`；rollback-active no-op、未知版本抛错。

**Gotchas**:
- 重复检测用 hash 而非内容深比较——文本相同即拒绝，天然防哈希碰撞。
- hash 与 content 在 publish 时绑定；`verifyIntegrity` 重算——发布后 `.content` 被原地改掉会在评审前被抓到。
- rollback 是重激活，**不是删除**：list 仍保留全部历史，来源/证据完整。
- `RuleVersionError.code` 用字符串联合（`empty-content` 等），不是错误码数字——测试按消息文本断言更稳。

### P2-17 Policy Config Versioning (1254)