# Harness Agent — 当前执行计划入口（E4：收口 E3 的生产可信链）

> 本文件是**唯一当前计划入口**。任何 coding agent 开始工作前先读本文件，再进入详细任务文件。
>
> 当前计划（详细任务规格）：`plan(20260907-004430).md`
>
> 审查基线（当前计划所评审的代码树）：`ad37841dbcbfa1d3553e699ab482c1246a549f48`
>
> 上一基线：`f73a337d71027afd48a8ac5ac0de1a7f4ae8497c`
>
> 仓库：`https://github.com/ki11a-Conton/harness-agent`
>
> 审查日期：2026-09-07
>
> 本轮（E4-00 至 E4-10）付费模型调用：**0**（全部离线，使用 fake provider）。

---

## 0. 历史计划（HISTORICAL — DO NOT EXECUTE AS CURRENT PLAN）

- **E3 计划**（原 `plan.md`，基线 `f73a337…`，审查日期 2026-09-02）已完成其代码提交并进入
  `main @ ad37841`。它描述的是 **f73a337 时点**的待办，**不代表当前缺陷仍存在**，也不得再当作
  当前计划执行。`e3-review-baseline.json` 同理，是 f73a337 的历史快照。
- 当前 E4 计划是对 `ad37841` 的**生产收口评审**：E3 已修复大量真实缺陷（R-01…R-12 的原始缺陷
  已修复或保留为严格兼容行为），但生产可信链仍有 12 个阻断项未闭环。E4 不扩大架构范围，只收口。

---

## 1. 当前任务索引与状态

| 任务 | 主题 | 依赖 | 状态 |
|---:|---|---|---|
| E4-00 | 冻结新基线 + 诚实状态页 + 修复工作区污染 + no-dirty 检查 | 无 | IN_PROGRESS |
| E4-01 | 执行计划/预算/隔离强制化、fail-closed | E4-00 | PENDING |
| E4-02 | 真实 paired benchmark 直接产出 canonical V3 | E4-01/03/04 | PENDING |
| E4-03 | 收紧 Artifact V3 schema + strict loader | E4-00 | PENDING |
| E4-04 | Activation/Security 接入真实执行链 | E4-03 | PENDING |
| E4-05 | evaluator 修复 (caseId,repetition) 多重集合配对 | E4-01/03 | PENDING |
| E4-06 | 重建 promotion 完整信任边界 | E4-03/05 | PENDING |
| E4-07 | applicationPending → 真实 createHarness → applied | E4-06 | PENDING |
| E4-08 | durable RecoveryStore 生产注入 | E4-00 | PENDING |
| E4-09 | 重写真实 production-path E2E | E4-02/05/06/07/08 | PENDING |
| E4-10 | 当前 HEAD 唯一门禁证据 + 诚实 smoke | E4-09 | PENDING |
| E4-11 | （可选）授权后的真实付费复跑 | E4-10 + 当轮授权 | NOT AUTHORIZED |

最短关键路径：`E4-00 → E4-01/E4-03 → E4-04 → E4-02 → E4-05 → E4-06 → E4-07 → E4-09 → E4-10 →（可选 E4-11）`。

---

## 2. 共同执行约束（每个任务都适用）

- E4-00 至 E4-10 全部离线；未获当轮明确授权不得设 `RUN_PAID_BENCHMARKS=1`，不得调用任何计费 provider。
- 不新增目录级重构、不换框架/包管理器、不建第二套平行实现、不用测试 helper 代替生产入口。
- 不删既有回归测试；不把严格错误降级为 warning；不用“字段非空”代替内容完整性验证。
- 不提交密钥、用户目录、绝对本机路径、临时 workspace 或大体积运行产物。
- 完成定义：生产代码已接入（非仅类型/helper）；至少一正一负测试；验收命令退出码符合语义；
  运行后 `git status --short` 为空；新产物有 schemaVersion/sourceSha/planDigest 或说明为何不需要。
- 禁止伪完成：只 export 无消费者、只验证 JSON 可解析、手工构造 passed=true、只查 caseId Set、
  只查文件 SHA、CLI 写 applied=true 但运行时未读取应用、smoke 退出 0 却忽略 case FAIL。

详细任务规格（做什么/怎么做/怎么验收/交付物）见 `plan(20260907-004430).md`。
