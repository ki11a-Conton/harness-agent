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

## 5. E4 收口状态（E4-01 … E4-10，全部离线，providerCalls=0）

> 本节记录 §3 十二项阻断的收口，不改动 §1–§3 对评审基线 ad37841 的历史判定。
> 每项均有对应提交与报告（docs/E4-0N-report.md）。

| # | 阻断项 | 收口 | 任务 |
|---|---|---|---|
| 1 | 伪造 ACCEPT + 任意文本 candidate 可过 loader | strict-load 真实 V3 + evaluator 重放 + 交叉绑定 + 路径守卫；15 例伪造矩阵 | E4-06 |
| 2 | evaluator 只比 caseId 不比 (caseId, repetition) | canonical PairKey + 精确多重集合配对 | E4-05 |
| 3 | promote 直接写 applied=true | promote 只写 applicationPending（applied=false） | E4-07 |
| 4 | champion profile 未接真实 createHarness | CLI/Web 共用 createHarnessWithChampion，校验真实解析配置 + AppliedProof | E4-07 |
| 5 | 生产路径测试手工造通过结果 | 真实端到端链（每产物来自上一生产阶段）+ 对抗 E2E | E4-09 |
| 6 | paired benchmark 靠脚本手工转 V3 | 执行器进程内直产 canonical V3 + strict reload | E4-02 |
| 7 | Activation/SecurityEvidenceV2 未进真实链 | 接入真实事件采集（fact-site） | E4-04 |
| 8 | recovery 默认内存 store，重启不保留 | DurableRecoveryStore（原子文件 + CAS + 跨进程锁 + 隔离损坏）注入 createHarness | E4-08 |
| 9 | planDigest 可省略 / 隔离降级 / 不安全结果无标记 | preflight 强制 planDigest + fail-closed 隔离 + promotionEligible=false | E4-01 |
| 10 | 根 plan/handoff/audit/release 描述旧基线或 NOT_RUN | HEAD 绑定 gate evidence 生成器 + usage audit（7/7 observed）+ docs gate-command 检查 | E4-10 |
| 11 | benchmark:smoke 退出 0 但 case FAIL | 诚实 boot-smoke 语义：无 case/ERRORED/用量断裂即非 0 | E4-10 |
| 12 | 测试遗留 .e3-09-self-test 污染 | E4-00 已修（selfTestInTempDir） | E4-00 |

- 状态：E4-00 … E4-10 全部完成；E4-11（付费复跑）未授权，保持 NOT AUTHORIZED。
- 验证：`tsc -b` 全绿；全量测试套件通过；`usage-audit` 7/7 observed；`docs:verify` 退出 0；`benchmark:smoke` 退出 0。
