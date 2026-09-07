# E4 状态矩阵 — 当前 HEAD 的诚实判定

> 本文件是 E4-00 交付的“当前状态页”。它描述**被评审的代码树**，不是承诺未来 HEAD 不变。
>
> - 评审基线 sourceSha（本状态页描述的代码树）：`ad37841dbcbfa1d3553e699ab482c1246a549f48`
> - 上一基线：`f73a337d71027afd48a8ac5ac0de1a7f4ae8497c`
> - 审查日期：2026-09-07
> - providerCalls（E4-00 本轮）：**0**（全部离线）
> - 严格 `sourceSha == git rev-parse HEAD` 的**门禁证据生成器**是 E4-10 的交付物（GateEvidenceV2）；
>   本状态页记录评审基线 SHA 以保证可追溯，测试断言其为 git 历史中的合法完整 SHA（祖先于 HEAD），
>   而非逐 commit 自指的相等（那会在提交本页后立即失效，正是 docs:verify 对 HANDOVER 规范段禁止易变 SHA 的原因）。

## 1. 门禁命令真实状态（评审基线 ad37841）

| 命令 | 状态 | 说明 |
|---|---|---|
| `pnpm typecheck` | PASS | tsc -b 全绿（E4-00 part1 后复验） |
| `pnpm build` | PASS | |
| `pnpm test` | PASS | 287 文件 / 5346 用例（评审基线） |
| `pnpm test:coverage` | PASS | statements 89.70% / branches 80.24% / functions 92.52% / lines 91.58% |
| `pnpm test:protocol` / `:security` / `:race` / `:chaos` | PASS | 专项全绿 |
| `pnpm docs:verify` | PASS（仅证旧 ledger 自洽） | 不证明 E3 当前交付闭环 |
| `pnpm capability:audit` | FAIL | 11 wired / 10 implemented-only，evidence freshness 失败 |
| `pnpm release:verify` | FAIL | 当前 HEAD 全部 release gate 为 NOT_RUN |
| `pnpm benchmark:smoke` | 不可信 | 进程退出 0，但 case 实际 FAIL |

## 2. 各 E3 任务重新判定

| E3 任务 | 判定 | E4 收口动作 |
|---|---|---|
| E3-01 preflight/paid-guard/dry-run | PARTIAL | E4-01 强制化 planDigest、0 上限语义、fail-closed 隔离 |
| E3-02 paired executor | 基本完成 | E4-02 补 canonical V3 sink，不重写 |
| E3-03 合约冻结 | 基本完成 | 保留测试 |
| E3-04 Artifact V3 | PARTIAL | E4-03 收紧 schema 与跨 artifact 绑定 |
| E3-05 activation/security | 未接入生产 | E4-04 接入真实事件采集 |
| E3-06 evaluator | PARTIAL | E4-05 修 pair key 多重集合、plan policy、重复计数 |
| E3-07 promotion | 高风险未完成 | E4-06 重建完整信任链 |
| E3-08 champion application | 仅 mapper/单测 | E4-07 接入真实 createHarness |
| E3-09 生产集成测试 | 未达定义 | E4-09 改真实流水线，不手工造结果 |
| E3-10 recovery durability | actor 完成、生产持久化缺失 | E4-08 注入 durable store |
| E3-11 gate truth source | 未完成 | E4-10 建当前 HEAD 证据生成器 |
| E3-12 文档 | PARTIAL | E4-00 当前 handoff 与 ledger 联动 |
| E3-13 adversarial E2E | 未达定义 | E4-09 真实 CLI/构造链覆盖 |
| E3-14 实跑与序列化 | 序列化已提交（ad37841）；实跑证据未纳入当前门禁 | 禁止凭 commit message 宣称完成 |
| E3-15 收口 | 未完成 | 在 E4-10 执行 |

## 3. 当前高风险阻断项（12）

1. 格式完整但内容伪造的 ACCEPT + 任意文本 candidate artifact 可过 production promotion loader。
2. V3 evaluator 只比 caseId 集合，不比 (caseId, repetition)；基线 rep=1、候选 rep=1/2 仍可 ACCEPT。
3. champion promote 直接写 applied=true，无 applicationPending 阶段。
4. champion profile resolver 未接入 CLI/Web 真实 createHarness。
5. “生产路径集成测试”手工造通过结果，未消费真实 paired executor 产物。
6. paired benchmark 先写 e3-02 中间格式再靠脚本手工转 V3，转换会猜/丢证据。
7. ActivationEvidenceV2 / SecurityOutcomeV2 未进真实 benchmark 记录链。
8. recovery actor 默认内存 store，真实重启不保留 attempts/backoff/lease。
9. 付费运行 planDigest 可省略；隔离探测异常降级继续；不安全结果无不可促销标记。
10. 根 plan.md/handoff/capability audit/release evidence 仍描述旧基线或当前 HEAD 为 NOT_RUN。
11. benchmark:smoke 退出 0 但 case 实际 FAIL。
12. 测试在仓库根遗留 `.e3-09-self-test`，违反无副作用门禁。

## 4. E4-00 进度

- ✅ 阻断项 #12：capability self-test 污染已修复（`selfTestInTempDir`，commit 259fba7），+3 回归测试。
- ✅ 阻断项 #10（部分）：根 `plan.md` 改为当前 E4 唯一入口，旧 E3 计划标记 HISTORICAL。
- ⏳ 待办：no-dirty-worktree 检查脚本/测试；docs:verify 增加“当前 plan 入口唯一且可发现”检查；
  e3-review-baseline.json 历史说明强化；E4-00-report.md。
