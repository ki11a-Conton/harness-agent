# N6 — 双平台最终验收

## CURRENT — 2026-10-01

**接线完成；最终同 SHA GitHub Actions 结论待收。** 不声明 Windows/Ubuntu 已完成。
本轮基线为 42ae7c2；它的旧 [workflow](https://github.com/ki11a-Conton/harness-agent/actions/runs/36731649499)
已 completed/failure。Unit tests 的两个失败原因是历史 candidate 在浅克隆中缺失，以及
N3 temp-cleanup 的 empty catch；本轮已修复。旧 workflow 的 fixture join 成功只能证明
当时 fixtureProtocolReady，不能代替新增真实层要求。

## 实现

- 新增 real-formal-offline matrix，两平台 node 22、完整 git 历史、frozen-lockfile 安装。
- n6-real-formal-ci.mjs 执行并记录实际 typecheck/test/build 退出码；pnpm test 显式启用 N2
  release CLI E2E，四个原始 frozen verifier verdict 必须成功。
- fixture 与真实 formal 各保留独立 raw bundle；真实 bundle 先通过 N5 strict gate，再转换
  identity/schedule schema。每个 manifest/verifier/security/activation 和两个 journal 字节保留，
  调用现有 A6/readiness verifier 重算所有原始数据；没有从报告字符串导出 readiness。
- runId/attempt/platform 来自本次 workflow；SHA 来自本次干净 checkout，额外与 GITHUB_SHA
  比较。根路径存为 repo-relative，下载后 artifact-relative 解析，不记录不可迁移绝对路径。
- 双平台 join 要求三个 offline levels，同 SHA/run/attempt 且两个平台各自匹配；最终 failure
  step 同时检查 verify、coverage、旧 fixture loop、real-formal matrix 的真实 job 结果。
- paidExperimentRun / championPromotion 始终 NOT_RUN；producer 不创建付费授权。

## 已完成的本地证据

| 项 | 已测结果 |
| --- | --- |
| N5 real formal，driver a13ad35 | strict gate + 独立 --verify exit 0；24/24 raw records，12 实际内容成功 |
| 内容矩阵 | 两个用例 × 两臂；correct passed，empty/wrong/skipped failed |
| 预算 | 60 MEASURED 请求、1080 tokens、12 tool dispatch、24 coverage；delta 0 |
| release CLI E2E | 四次内容 verifier 成功；真实 write_file settlement |
| N6 adapter regressions | 两项通过；raw manifest bytes 不变，A6 重验2/2，旧 SHA 与内容篡改拒绝 |
| N5/provider/pair/gate + N6 定向套件 | 44 passed，1 historical comparison skipped |
| 全仓验收，driver 6a9b7ef | **417 files passed；7663 tests passed / 11 skipped**；pnpm test 显式启用 N2 E2E；375.93 s；exit 0 |
| typecheck / build，driver 6a9b7ef | **exit 0 / exit 0** |
| docs:verify / docs smoke | **全部 PASS / 4 passed** |
| N6 producer，driver 6a9b7ef | typecheck/test/build/fixture/pair/arms/formal/readiness **八个命令 exit 0** |
| 本地 readiness | fixtureProtocolReady / realBuildOfflineReady / budgetEvidenceReady **分别 PASS**；paid/promotion NOT_RUN |

原工作区第一次 full pnpm test 得 7659 passed / 1 failed / 12 skipped。
唯一失败是 R55 owned cleanup 留下空目录；同一个原始测试在隔离 worktree 全套 65/65 通过，
原工作区只选真实 chain 用例也通过。没有删测试或放宽 cleanup 断言。
最终全仓检查使用干净隔离 worktree，已 completed/exit 0。原工作区第一次失败保留为历史，不改写为通过。
本地 raw bundle 和命令日志保存在 `.ci/n6-local-acceptance/`；runId 为 local-n6-20261001，
仅是本地验收身份，不是 GitHub workflow run。

## 同 SHA 收证入口

```bash
node scripts/e4/n6-real-formal-ci.mjs --platform ubuntu --run-id <actual-run-id> --attempt <actual-attempt> --out .ci/n6-real-formal
node scripts/e4/dual-platform-acceptance.mjs --windows <windows-artifact>/ci-readiness.json --ubuntu <ubuntu-artifact>/ci-readiness.json --run-id <actual-run-id> --attempt <actual-attempt> --expect-sha <actual-driver-sha> --require fixtureProtocolReady,realBuildOfflineReady,budgetEvidenceReady --strict --out .ci/dual/verdict.json
```

本地 run id 必须明确标为 local；不能伪造 GitHub run。
最终 CI URL / run / attempt / artifact：**尚未收回**。

## 当前阻塞

本地实现已提交到 `codex/complete-handover-n5-n6`，但向该 GitHub 分支的推送被自动审批
拒绝，理由是用户授权拉取和完成工作，尚未明确授权发布到远端。未绕过审批，也未将
本地 Linux 证据记作 Windows/Ubuntu CI 完成。下一步需要用户授权推送该分支并运行 CI。
