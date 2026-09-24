# E4-R16 报告：统一被评估和被安装的策略，并验证 pending target（N12）

```text
任务：E4-R16（修复 N12）
起始 SHA：1773aab（E4-R15 报告）
被测源码 SHA：fc951f0（E4-R16 提交，本地 main，未推送）
开发工作树 fingerprint：fc951f0 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（共享、版本化机制定义落地；startup 安装与 benchmark 评估同一文本；
      pending 无证据拒绝；策略实现 digest 进入 arm digest → 执行身份 → 晋升 target）
```

## 1. 缺陷与复现

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N12（策略漂移） | benchmark 使用 `BUDGET_AWARE_COMPLETION_GUIDANCE`（多行权威文本），startup 安装另一段 `CHAMPION_BUDGET_AWARE_GUIDANCE`（"相近含义"的短重写）——安装的不是被评估的策略 | 单一共享、版本化的策略定义 `BUDGET_AWARE_COMPLETION_GUIDANCE_V1`（评估层 `mechanism-guidance.ts`）；benchmark 与 champion application 消费同一份（旧常量名保留为同一值的导出，兼容性不变）；`CHAMPION_BUDGET_AWARE_GUIDANCE === BUDGET_AWARE_COMPLETION_GUIDANCE` 有回归断言 |
| N12（target 未绑实现） | arm-factory 的 `promptAdditionsDigest` 是静态字符串 `sha256Hex("budget-aware-completion:v1")`，不绑定真实文本；同名候选改指导语不会改变任何 target | `promptAdditionsDigest = budgetAwareCompletionGuidanceDigest()`（真实文本 sha256）→ 进入 arm digest → R13 执行身份（candidateConfigHash 链路）与 R15 晋升 target（expectedConfigDigest）——改指导语、不变 candidateId 也会使旧 target 失配（有回归测试） |
| N12（pending 可信性） | 仅凭 `applyPromotion` 写出的若干 flags（QUARANTINED + applied=false）即可在启动时被解析并 applied/PROVEN | `createHarnessWithChampion` 在 pending 路径要求 `evidenceRef` 非空——无 promotion 证据的 pending（手写/伪造/旧状态）保持隔离（profileRejected），永不 applied/PROVEN |

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/evaluation/src/mechanism-guidance.ts`（新） | 共享、版本化的策略定义：`BUDGET_AWARE_COMPLETION_GUIDANCE_V1` + `BUDGET_AWARE_COMPLETION_GUIDANCE_VERSION` + `budgetAwareCompletionGuidanceDigest()`（真实文本 sha256） |
| `packages/evaluation/src/arm-factory.ts` | `budget_aware_completion_v1` 的 `promptAdditionsDigest` 绑定真实文本 digest（替代静态字符串） |
| `apps/cli/src/benchmark-command.ts` | `BUDGET_AWARE_COMPLETION_GUIDANCE` = 共享定义（评估侧不变） |
| `apps/cli/src/champion-application.ts` | `CHAMPION_BUDGET_AWARE_GUIDANCE` = 同一共享定义；pending 无证据 → profileRejected |
| `apps/cli/src/champion-application-r16.test.ts`（新） | 6 条回归（策略一致、digest 绑定、pending 证据门、控制组） |
| r05/integration 测试 | 断言的子串更新为权威文本（机制安装仍被真实观测） |

Runtime Freeze 符合性：未改 Runtime；属 agent-strategy 定义层（evaluation 包）与
CLI 应用路径的 correctness 修复（策略一致 + pending 信任边界）。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| benchmark 与 startup 的候选机制 definition/digest 相同 | ✅ | 共享 `BUDGET_AWARE_COMPLETION_GUIDANCE_V1`；`CHAMPION_BUDGET_AWARE_GUIDANCE === BUDGET_AWARE_COMPLETION_GUIDANCE` 断言；真实 startup 的 main agent prompt 包含权威文本 |
| 改候选指导语或配置，不变 candidateId，也会使旧 target 失配 | ✅ | `promptAdditionsDigest`=真实文本 digest；重写文本 → arm digest 变化（computeSnapshotDigest 敏感）→ R15 expectedConfigDigest 变化 |
| 缺失/篡改 promotion evidence 的 pending 不会 applied/PROVEN | ✅ | evidenceRef 为空的 pending → profileRejected；state 文件 applied=false、validity 仍 QUARANTINED |
| 从真实合法 pending 启动，fake provider 收到共享策略，并产生可验证行为 | ✅ | r16 控制组 + r05 F12：真实 turn 的 system prompt 携带权威文本 |
| CLI/Web 各覆盖一次真实 startup 行为，baseline 对照不含候选机制 | ✅ | r05 F12 baseline 对照（C0 无 guidance）；integration E4-R08 Web startup 通过 |
| unsupported 机制仍拒绝；旧 CAS loser regression 仍通过 | ✅ | championMechanismInstallPlan 不变；r05 F13 CAS race 通过 |
| 不依赖旧标题文本误判新实现，也不仅用关键词相似度证明策略相同 | ✅ | 字节级相等断言 + digest 绑定 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| R16 目标集（r05/r16/integration/e4-09/harness-config/arm-factory） | 49 tests：45 passed / 4 failed（e4-09 脏树 dirty-refusal，pristine/CI 下通过） |
| `pnpm exec vitest run packages/evaluation` | PASS：78 files / **966 tests** |
| `pnpm exec vitest run apps/cli` | 33 files：369 passed / 4 failed（仅 e4-09） |

- reviewedSourceSha：`fc951f0`。
- 真实模型网络调用数：**0**；fake 调用数：0（测试用 capturing fake provider）。

## 5. 未完成 / 后续任务接口

- pending 的证据校验目前为 evidenceRef 存在性；证据文件本体（decision artifact /
  envelope digest）的完整性复验由 R19 统一 evidence 与 R20 收口覆盖。
- 若未来新增其他候选机制（memory/recovery 等），按同一模式在策略层提供共享、
  版本化的机制定义，startup/benchmark 共同消费。
