# HANDOVER.md — 未完成任务交接

仓库规模：`packages/（24 个包）`。当前计划是 `plan(20260930-061557).md`；没有悬空 plan.md。
Runtime Freeze、ToolOrchestrator/PermissionEngine/SandboxManager/Verification 约定继续适用。
默认离线；付费实验与 champion promotion 均 NOT_RUN。

## 本轮状态

| 任务 | 当前结论 | 证据入口 |
| --- | --- | --- |
| N1 / N3 / N4 | DONE，保留原实现和原验收 | docs/evidence/n1-worker-lifecycle.md、n3-dispatch-journal.md、n4-pricing-send-guard.md |
| N2 (a)(b)(c)(d) | DONE（Linux 容器实测）；release CLI E2E 四次内容 verifier 成功 | docs/evidence/n2-release-cli-forward.md |
| N5 | DONE（Linux 容器完整离线 gate）；24/24 raw records、12 content successes | docs/evidence/n5-real-formal-offline.md |
| N6 | 接线完成，最终同 SHA Windows/Ubuntu CI 结论待收 | docs/evidence/n6-dual-platform-final.md |
| task-5 / Phase E | 字段已存在并经 fixture producer 运行；不存在待实现的缺字段项 | scripts/e4/prereg-production-e2e.mjs |
| release CLI 真实内容闭环 | DONE；未扩 turn，未改 frozen verifier | apps/cli/src/n2-release-cli-forward.test.ts |

N5 的正确内容组、empty/wrong/skipped 三个负组、六项身份/isolation 反例全部完整运行。
CSV/countdown 两臂 correct=passed；三个内容负组皆 failed；六项身份负例物理调用均 0。
60 MEASURED 请求、1080 tokens、12 dispatched tools、24 coverage；独立 --verify exit 0。
实验统计结论仍 REJECT（其他控制任务保留真实失败），不能用于 promotion。
`--full` 仍 NOT_RUN，仅为尽力而为的可选诊断，不阻塞 N5 DONE。

## 尚待收口：N6 最终同 SHA 双平台验收

1. 从干净的最终提交运行新增 `real-formal-offline` Windows/Ubuntu matrix。
   producer 是 `scripts/e4/n6-real-formal-ci.mjs`；执行全仓 pnpm test（N2 E2E 显式开启）、
   fixture producer、真实两臂安装构建、formal 四变体与身份反例。
2. 下载 `n6-real-formal-<os>-<sha>-<run>-attempt-<attempt>`。
   每 leg 包含 ci-readiness.json、readiness-bundle/、formal/、fixture-bundle/、命令日志。
   join 要求 fixtureProtocolReady、realBuildOfflineReady、budgetEvidenceReady 三层。
3. 必须等 workflow completed，且 verify/coverage/r97-r98-closed-loop/real-formal-offline
   全部 success；不能只读 join 退出码，也不能借用旧 SHA 的绿灯。
4. 失败时按具名日志修复，保留 raw artifact；缺 Windows leg、旧 run/attempt、错误 SHA、
   无 dispatch/build/verifier 证据均不得被标 PASS。
5. 收回最终 CI URL 与 artifact 后更新 docs/evidence/n6-dual-platform-final.md 和
   current-prereg-status.md。本地 Linux 容器运行不是 GitHub Ubuntu attestation。

用户只需 Windows；不要求用户安装 Linux/WSL/Docker。
提交信息使用文件 + git commit -F；只 add 当前任务 scope，不 git add -A。
生产长链在干净隔离 worktree 内执行，不并发编辑其 tracked files；不 git stash。

## Historical / superseded

上一份交接的“提交未 push / 无 CI”已过期：远端 42ae7c2 已有完成但失败的 workflow，
两个 CI 失败点（浅克隆 pin 测试、空 cleanup catch）已修；它不是新提交的终验。
旧记录可从 git 历史或 N2/N5 报告的 Historical 段读取，不能当作当前证据。
