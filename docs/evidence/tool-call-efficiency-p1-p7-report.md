# tool_call_efficiency_v1 — 预注册可执行闭环阶段报告（N0–N7）

> 本文件是 **N0–N7 阶段**的任务报告。它记录**已执行并验证**的事实，不把计划项写成已完成。
> 任何“运行前必须强制消费 preregistration”的结论，只有在 N2 落地后才可写 PASS；在此之前一律 PARTIAL。

- 阶段起点（固定审查 HEAD）：`1964c66bd3438846e7ef3b8ce76533ed29f3b450`
- 上一轮审查基线：`6d027c8936bccefa6ecb47d1ebfa56a56c89efe3`
- 外部付费模型调用：N0–N6 = **0**；N7 = **PAID_NOT_RUN**。

---

## N0 — 固定新基线并建立回归保护

结论：**PASS**（基线固定、P1–P4 未回归；P5 缺口经代码事实确认）
起始 SHA：`1964c66bd3438846e7ef3b8ce76533ed29f3b450`（工作树干净，分支 `main`）

### 0.1 基线

| 项 | 值 |
| --- | --- |
| 实际 HEAD | `1964c66bd3438846e7ef3b8ce76533ed29f3b450` |
| 分支 / 工作树 | `main` / 干净（`git status --short` 空） |
| 与审查基线差异 | `git log --oneline 6d027c8..1964c66`：4 个提交 |

4 个新增提交（6d027c8..1964c66）：

| SHA | 说明 |
| --- | --- |
| `e4b3b7c` | P1–P4：生产安装 / request-boundary 激活 / manifest system-prompt identity / guidance v2 |
| `30d56f7` | P5：preregistration builder + test + export |
| `138dbdd` | 报告收口（P5/P6） |
| `1964c66` | 报告记录 P6 双平台 CI 证据 |

### 0.2 P5 真实缺口（代码事实，不是推断）

对 `buildToolCallEfficiencyPreregistration` / `preregistrationDigest` / `preflightPaid` / `Preregistration`
做全仓搜索（排除 `*.test.ts`），非测试生产引用只有：

| 文件 | 类型 | 是否在 provider 前验证 |
| --- | --- | --- |
| `packages/evaluation/src/tool-call-efficiency-preregistration.ts` | 模块自身 | — |
| `packages/evaluation/src/index.ts` | 仅 re-export（`export * from "./tool-call-efficiency-preregistration.js"`） | 否 |
| `docs/E4-R99-R101-report.md` | 文档 | 否 |

**结论：没有任何正式入口（CLI / driver / worker）在 provider 构造前读取、重算或要求 approval 绑定该 digest。**
当前基线的正确答案是“**没有** consumer”。P5 只是 builder/test/export，**不得**写成已完成闭环。

### 0.3 回归矩阵（保护 P1–P4 与 baseline 非污染）

| 不变量 | 保护测试（文件） | 本轮观测 |
| --- | --- | --- |
| 生产 champion 安装**同一份**权威 guidance，且绑定模型可见 bytes | `apps/cli/src/champion-application-p1.test.ts`（4 例） | PASS |
| 与旧 budget-aware guidance **互斥**（不可并装） | 同上（`refuses the mutually-exclusive pair`） | PASS |
| 真实 request boundary 观察 guidance block（非标签） | `apps/cli/src/benchmark-command.test.ts`（N5 case） | PASS |
| activation evidence v2：prompt-guidance 必须携带 `guidanceVersion` 且 digest == 已批准 arm 摘要 | `packages/evaluation/src/activation-evidence-v2.ts` + `activation-evidence-execution.test.ts` | PASS |
| manifest / run identity 覆盖真实 system prompt | `packages/evaluation/src/manifest.test.ts`（31 例） | PASS |
| guidance v2 语义（model iteration ≠ tool calls；重试规则收窄） | `packages/evaluation/src/tool-call-efficiency.test.ts`（7 例） | PASS |
| baseline 无 candidate contamination | 上述 `tool-call-efficiency.test.ts` + `benchmark-command.test.ts` | PASS |
| activation evidence 基础契约 | `packages/evaluation/src/activation-evidence.test.ts`（13 例） | PASS |

本轮未新增测试：现有命名已足够清楚，且 P1–P4 保护已可机检；按 N0 要求“不为整理改生产代码”，保持零代码改动。

### 0.4 验收命令（实际运行）

| 命令 | 退出码 | 观测 |
| --- | --- | --- |
| `git status --short` | 0 | 空（检查前后一致，未覆盖用户改动） |
| `pnpm typecheck` | 0 | `tsc -b` 全仓通过 |
| `pnpm exec vitest run apps/cli/src/champion-application-p1.test.ts apps/cli/src/benchmark-command.test.ts packages/evaluation/src/tool-call-efficiency.test.ts packages/evaluation/src/activation-evidence.test.ts packages/evaluation/src/manifest.test.ts` | 0 | **5 files / 152 passed / 0 failed** |

### 0.5 零调用证明

- 上述测试均使用 `ScriptedModelProvider` / 纯函数，未构造真实 provider，未读取 API key，未产生网络请求。
- 外部 provider 调用：**0**；费用：**0**。

### 0.6 剩余风险 / 下一任务

- P5 仍无正式 consumer（F1），digest 覆盖不足（F4），repetitions 允许 1（F2），预算为自报估计（F3），
  eligible 集合自报（F5），AB/BA balance 非硬条件（F6），contract 与 decision policy 未统一冻结（F7）。
  以上由 N1–N4 关闭。
- **N1 是否解锁：是。**