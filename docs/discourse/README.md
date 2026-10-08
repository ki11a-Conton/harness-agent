# 讨论记录：一个具备 Harness Engineering 能力的自主编程 Agent，必须具备什么？

本目录是一次**多智能体设计讨论**的原始记录。它存在的意义是让结论可复核：每一条主张都能追溯到"谁在什么视角下提出、谁反驳、主席如何裁决"。

## 讨论问题

> 一个具备 Harness Engineering 能力的自主编程 Agent，必须具备什么？

约束（对所有参与者）：
1. 每条主张必须**可判真假**，并给出**可观测判据**（事件、状态、计数、文件），禁止"应该有良好的错误处理"这类不可判据的表述。
2. 优先引用本仓库真实的模块/测试作为"已实现/未实现"的证据；没有实现就明说没有。
3. 每条主张必须写清**失败模式**与**最容易被伪造的方式**。
4. 参与者必须提交至少一节"我认为被高估的三件事"。
5. 0 网络、0 付费模型调用；不改生产代码与他人文件。

## 参与者与视角

| 代号 | Target | 视角 | 产出 |
| --- | --- | --- | --- |
| D1 | `runtime-lifecycle` | 运行时与生命周期（预算、状态机、恢复） | [WHA-01](WHA-01-runtime-lifecycle.md) + [rebuttal](WHA-01-runtime-lifecycle-rebuttal.md) |
| D2 | `verification-truth` | 验证与证据（什么算真的完成） | [WHA-02](WHA-02-verification-truth.md) + [rebuttal](WHA-02-verification-truth-rebuttal.md) |
| D3 | `boundary-security` | 安全与不可信边界（权限、隔离、注入） | [WHA-03](WHA-03-boundary-security.md) + [rebuttal](WHA-03-boundary-security-rebuttal.md) |
| D4 | `eval-measurement` | 评测与测量（指标口径、样本、门禁） | [WHA-04](WHA-04-eval-measurement.md) + [rebuttal](WHA-04-eval-measurement-rebuttal.md) |
| D5 | `human-ops-cost` | 人类协作、成本与可运维性 | [WHA-05](WHA-05-human-ops-cost.md) + [rebuttal](WHA-05-human-ops-cost-rebuttal.md) |
| R | ~~`red-team-skeptic`~~ → **由 D1 `runtime-lifecycle` 执行** | 红队：攻击 D2/D3/D4/D5 的清单 | [WHA-06](WHA-06-redteam.md) |
| 主席 | `lead` | 攻击 D1 的清单 + 裁决与合成 | [WHAT-A-HARNESS-AGENT-NEEDS.md](../harness-engineering/WHAT-A-HARNESS-AGENT-NEEDS.md) |

### 红队安排的变更（如实记录）

原计划的独立红队成员 `red-team-skeptic` **无法创建**：本会话团队**成员上限为 8**，`spawn_teammate` 返回 `Team member limit 8 reached`。D3 与 D5 在收尾时都**如实上报了投递失败**（`send_message` → `active teammate "red-team-skeptic" not found`），没有静默跳过，也没有自行越权创建成员。

因此红队职责改为：**D1 `runtime-lifecycle` 攻击 D2–D5 的清单**（`WHA-06-redteam.md`），**D1 自己的 `WHA-01` 由主席亲自攻击**——同一份文件由作者自己红队是无意义的。红队在报告中明确标注了这一安排、说明了视角偏置，并声明"全文行号均为静态读码所得、未执行任何测试"。

### 执行中断（如实记录）

讨论期间发生多次子代理执行中断：D2 与 D4 的**首轮**在开始阶段中断（未产出文件），D3 的**首轮**在即将落盘时中断，D2 在回应红队质疑时再次中断。处置方式：向仍存在的成员发送"**先写文件、后读材料**"的恢复指令；`WHA-02/03/04/05` 的 Round 1 与 rebuttal 最终均落盘。**没有任何中断被当作"该视角已放弃"处理**；无法执行的交付（向不存在的红队投递）被逐条记录。

> **更正（Lead）**：红队报告初稿曾据 Lead 的转述写下"D3 已停止工作、未获回应"。**该记载错误并已撤回**——D3 当时仍在工作，且向 D2 提出过实质质询（并获得四条复核回应，其中一条独立确认了 `execution-plan.ts:489` 的 `probeSourceSnapshot` 属**执行前**检查、不覆盖 run 内写入）。因此 D3 的"可声称范围收窄"**是有同侪复核的**，不是孤证。

## 轮次

| 轮次 | 动作 | 产出 |
| --- | --- | --- |
| Round 1 | 各讨论者在**不读他人**的前提下独立写出自己的主张清单 | `WHA-01..05-*.md` |
| Round 2 | 互相阅读，向至少 2 位同侪发送具体的同意/反对意见，再写自己的修订说明 | `WHA-01..05-*-rebuttal.md` |
| Round 3 | 红队逐份攻击：不可判据项、真但无用项、互相矛盾、缺席项、事故演练、建议删除项 | `WHA-06-redteam.md` |
| 裁决 | 主席把每条主张标为 CONVERGED / CONTESTED / REJECTED / UNVERIFIABLE，并分成"必修/加分" | `docs/harness-engineering/WHAT-A-HARNESS-AGENT-NEEDS.md` |

## 共享事实基础（所有参与者都可引用）

- 规格：`C:\Users\MECHREV\Downloads\Harness_Agent_核心指标与工程验收标准.md`（v1.0，2026-10-08）
- 本仓库规格一致性现状：[SPEC-CONFORMANCE.md](../harness-engineering/SPEC-CONFORMANCE.md)（已有 / 本 PR 新增 / 未覆盖）、[EVIDENCE-INDEX.md](../harness-engineering/EVIDENCE-INDEX.md)（含两处既有缺陷与集成断层）
- 真实运行证据：[N7-RESULT-20261007.md](../evidence/agent-next7-20261006/N7-RESULT-20261007.md)（判定 NOT_PROVEN 的真实原因）与 [N7-ERRATA-20261007.md](../evidence/agent-next7-20261006/N7-ERRATA-20261007.md)（独立复核推翻了我原先的部分统计与归因）

## 声明

本讨论**不产生任何模型质量结论**：全程 0 次付费模型调用，未运行任何真实评测任务。文中的"已验证"仅指"该主张在本仓库有可执行的判据/测试"，不等于"该能力在真实任务中有效"。
