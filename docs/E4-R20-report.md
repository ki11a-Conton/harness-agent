# E4-R20 报告：逐验收条件收口，修正旧报告的过度关闭

```text
任务：E4-R20（总验收与文档纠偏）
起始 SHA：f134d14（E4-R19）
被测源码 SHA（收口验证的固定提交）：9a47e42（含全部 R12–R20 源码修复与文档；
      docs 报告使用 reviewedSourceSha=9a47e42，不制造 SHA 自引用循环）
开发工作树 fingerprint：9a47e42 之上干净（`git status` 为空）
状态：PASS（实现修复层与离线工程门禁层完成；runtimeReleaseReady=false ——
      Windows/Linux CI 复核需推送后执行，无推送授权，不伪称 READY）
```

## 1. 关闭矩阵（旧任务原验收条目 → 实现位置 → 真实测试 → 本轮 Nxx → 关闭状态）

| Nxx | 修复提交 | 关闭证据（negative-first 测试） | 状态 |
|---|---|---|---|
| N01 runner 吞失败原因 | e26af98（R12） | release-command/gate-evidence-v2 测试：真实失败项打印 + logRef digest 重算 | CLOSED |
| N02 CRLF digest 漂移 | e26af98（R12 `.gitattributes`） | 11 条 DIGEST_MISMATCH 复现一致；CRLF 不归一化回归 | CLOSED（Windows 实机复核见 §3） |
| N03 确认计划未绑身份 | 0676cdb（R13） | plan digest 对 model/policy/source/case 变更敏感；执行器消费同一确认计划 | CLOSED |
| N04 占位符身份 | 0676cdb（R13） | 真实 arm config hash、真实树指纹、dirty 可晋升拒绝 | CLOSED |
| N05 expected grid 重复键 | 0676cdb（R13） | C×R 唯一键、逻辑 arm 数 12 | CLOSED |
| N06 省略/置空 grid | d398482（R14） | 空/缺/重复网格 → INVALID | CLOSED |
| N07 重复执行凑 case 数 | d398482（R14） | uniqueCases=1、activationEligibleCases=1（3 次重复） | CLOSED |
| N08 securityOutcomes=[] | d398482（R14） | 缺记录/悬空 → INVALID；已观察 breach → REJECT | CLOSED |
| N09 runComplete=false 仍 ACCEPT | d398482（R14）+ 7311f6d（R15） | 评估器 INVALID + loader CANDIDATE_NOT_ELIGIBLE | CLOSED |
| N10 事实投影（verification/recovery/裁剪） | d398482（R14） | 终态 verification、真实 budgetExhausted、完整事件流安全归约 | CLOSED |
| N11 相对 decision 读取绕过 | 7311f6d（R15） | 相对引用 bundleRoot 解析、单一路径、replay 抛错拒绝 | CLOSED |
| N12 策略漂移 + pending 可信性 | fc951f0（R16） | 同一共享策略文本、实现 digest 绑定、pending 无证据拒绝 | CLOSED |
| N13 terminal ACK 假 ACK | 39adc9a（R17） | 终态写失败冻结队列、不消费、不重跑；store 恢复提交 | CLOSED |
| N14 wait-lease 无唤醒 | 39adc9a（R17） | 租约到期有限唤醒、到期后无外部消息继续 | CLOSED |
| N15 伪造 observation 行 | 43f20d7（R18） | 伪造 digest/null SHA/错 symbol/虚构 test → 不 observed | CLOSED |
| N16 提前写 passed + 全局 JSONL | 43f20d7（R18） | 两阶段提交、runId 隔离、先观察后失败不留证明 | CLOSED |
| N17 HEAD 运行中变更 | f134d14（R19） | A→B clean 运行 → state=invalid | CLOSED |
| N18 artifact 事后篡改 | f134d14（R19） | load 重新 digest → 篡改后 not_run | CLOSED |
| N19 缺字段对象绕过 verifier | f134d14（R19） | parser/loader/verifier 三入口一致拒绝 | CLOSED |
| N20 CLI 与 evidence 状态矛盾 | f134d14（R19） | 证据 failed/invalid 时打印 FAIL（child exit=0 也 FAIL） | CLOSED |
| N21 R06/R10 报告过度关闭 | 本任务 §2 | R06 队列 durable 声明已按 R17 实测修正；R08 观察格式按 R18 修正 | CLOSED |

## 2. 文档纠偏

- plan.md 现指向 `plan(20260910-070001).md` 为唯一当前入口（cfb6cd2）；旧的
  2026-09-09 计划保留为历史。docs:verify 的 E4-00 检查从 swap 开始一直红，
  现已转绿（`ALL CHECKS PASS`）。
- R06 报告“队列只在 durable terminal 后前进/已 durable 才 shift”的过度描述：
  以 R17 的 `needsReconcile` 实测为准——终态写失败时队列冻结、绝不 shift/consume。
- R08 报告“测试通过后写 observation”：以 R18 的两阶段提交为准——收集候选观察、
  全部断言通过后由测试结束钩子 commit。
- “管理员才能看日志”的无依据阻塞说明：R12 起 runner 保存完整日志并打印真实失败项，
  不再需要 admin 才能诊断（Windows 实机确认仍待推送后的 CI）。
- CRLF 归因：R12 精确复现（11 条 DIGEST_MISMATCH）并落地 `.gitattributes` 契约；
  “当前 Windows job 的失败确由 CRLF 造成”仍为强假设，待新 CI 输出确认（不伪称）。

## 3. 最终验证（固定 SHA 9a47e42，本地）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（exit 0） |
| `pnpm test`（全仓） | **5626 passed / 1 skipped / 0 failed**（308+ 个测试文件全绿——首次在干净工作树全绿，含此前 env 前置失败的 e4-09） |
| `pnpm build` | PASS |
| `pnpm docs:verify` | PASS（`ALL CHECKS PASS`，含 E4-00 计划入口与 E2-12 ledger） |
| R12–R19 各目标集 | 全部通过（129+44+39+16+… 逐任务记录于各报告） |

- 真实模型网络调用：**0**；fake 调用：0。
- runtimeReleaseReady：**false**——Linux/Windows/coverage CI 与 release attestation
  需推送后由 GitHub 运行（无推送授权，按计划 §3-12 不自动推送）；不把 mock 隔离
  当真实 OS 证明，不把 INCONCLUSIVE 改 ACCEPT。
- championPromotion：separate——真实模型质量未要求付费复跑，明确分开结论。

## 4. 未完成 / 环境依赖

- 推送后的 CI 复核（Windows docs gate、全平台矩阵、coverage、release attestation）。
- 真实模型 champion 质量结论（可选，不为此付费）。
- 全部未运行/无法证明项均有具体原因（推送授权缺失），未勾选完成。