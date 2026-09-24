# E2-00 — 证据基线固化与 C1 隔离报告

> 审查基线：`5a6f90c4767413ae1c89dca7a451a13ab5dd6cf0`
> 日期：2026-09-01（E2 轮次）

## 结论

当前 `adaptive_recovery_v2` 的历史晋级**不是有效晋级**。审计器对其既有证据给出
`validForPromotion=false`、`validity=INVALID_PROVENANCE`；生产解析的 active
champion 已安全回到 **C0**。C1 的历史记录与 evidence path 完整保留，可随时查询。

## 为什么 C1 不是有效晋级（审计原因码）

| 原因码 | 事实 |
|--------|------|
| `SOURCE_DIRTY` | baseline 记录 `c8fd5f8 dirty=true`，candidate 记录 `3cf62ab dirty=true` — 实际执行源码不可重建 |
| `SOURCE_SHA_MISMATCH` | baseline `c8fd5f8` ≠ candidate `3cf62ab` — 不同源码，非单变量比较 |
| `IMPLEMENTATION_NOT_IN_RECORDED_SOURCE` | candidate 运行 SHA `3cf62ab` ≠ 审查基线 `5a6f90c`，实现可能不存在于记录源码 |
| `SINGLE_RUN_INSUFFICIENT` | 每臂仅一次独立运行，无 repetition/interleave 元数据 |
| `REPETITION_RECOMMENDED_BUT_ACCEPTED` | 单次运行对却判 ACCEPT，与重复建议冲突 |
| `PRODUCTION_APPLICATION_UNPROVEN` | `champion-state.json` 标记 applied=true，但生产 harness 从未消费该状态 |

完整检查输出见 `docs/evolution/e2-baseline-audit.json`（确定性 JSON，无时间戳）。

## 隔离做了什么

- `champion-state.json`：level `C1 → C0`，`validity=QUARANTINED_PENDING_REEVALUATION`，
  新增 `quarantine` 记录（priorLevel=C1, priorCandidateId=adaptive_recovery_v2,
  reasonCodes 稳定码）。
- 历史记录**未删除、未改写**：C1 记录 + 原 evidence path
  (`benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/paired-report.txt`) 保留在
  `history` 中。
- 未修改 `benchmarks/results/` 下任何原始 benchmark JSON；审计引用原文件 SHA-256 digest。

## 解除隔离需要哪些任务

1. **E2-01** — Canonical ExperimentArtifact V3：loader 不再丢
   termination_reason/grade/verification/manifest。
2. **E2-02** — Strict Provenance V3：同源、同构建、同环境、同案例，dirty/SHA 不匹配必须拒绝。
3. **E2-05** — 真正 paired/interleaved/repeated 调度器：小样本单次运行不再可判 ACCEPT。
4. **E2-06** — 严格统计判定：小样本 `+1` 必须 `INCONCLUSIVE`。
5. **E2-07** — 不可伪造 promotion（机器 decision envelope）。
6. **E2-08** — Champion 配置真正进入生产 `createHarness`，用运行时 config digest 证明 applied。
7. **E2-15**（仅显式授权后）— AR2 正式成对付费复测。

在这些任务完成前，任何 promotion 都不得恢复 C1 的生产语义。
