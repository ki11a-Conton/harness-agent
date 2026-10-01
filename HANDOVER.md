# HANDOVER.md — 本轮交接任务验收完成

仓库规模：`packages/（24 个包）`。当前计划是 `plan(20260930-061557).md`；没有悬空 plan.md。
Runtime Freeze、ToolOrchestrator/PermissionEngine/SandboxManager/Verification 约定继续适用。
默认离线；付费实验与 champion promotion 均 NOT_RUN。

## 本轮状态

| 任务 | 当前结论 | 证据入口 |
| --- | --- | --- |
| N1 / N3 / N4 | DONE，保留原实现和原验收 | docs/evidence/n1-worker-lifecycle.md、n3-dispatch-journal.md、n4-pricing-send-guard.md |
| N2 (a)(b)(c)(d) | DONE（Windows/Ubuntu CI）；release CLI E2E 四次内容 verifier 成功 | docs/evidence/n2-release-cli-forward.md |
| N5 | DONE（Windows/Ubuntu CI）；每平台 24/24 raw records、12 content successes | docs/evidence/n5-real-formal-offline.md |
| N6 | DONE；同 SHA 双平台 CI completed/success，三个 offline levels BOTH_PASS | docs/evidence/n6-dual-platform-final.md |
| task-5 / Phase E | 字段已存在并经 fixture producer 运行；不存在待实现的缺字段项 | scripts/e4/prereg-production-e2e.mjs |
| release CLI 真实内容闭环 | DONE；未扩 turn，未改 frozen verifier | apps/cli/src/n2-release-cli-forward.test.ts |

N5 的正确内容组、empty/wrong/skipped 三个负组、六项身份/isolation 反例全部完整运行。
CSV/countdown 两臂 correct=passed；三个内容负组皆 failed；六项身份负例物理调用均 0。
60 MEASURED 请求、1080 tokens、12 dispatched tools、24 coverage；独立 --verify exit 0。
实验统计结论仍 REJECT（其他控制任务保留真实失败），不能用于 promotion。
`--full` 仍 NOT_RUN，仅为尽力而为的可选诊断，不阻塞 N5 DONE。

## 本轮已收口：N6 同 SHA 双平台验收

验收实现提交为 `ad66f62004ed5e59a71b32839f8a4dab05124818`，
[workflow 36797936842 / attempt 1](https://github.com/ki11a-Conton/harness-agent/actions/runs/36797936842) 已 completed/success。
verify（两平台）、coverage、r97-r98-closed-loop（两平台）、real-formal-offline（两平台）、
release attestation 和 dual-platform acceptance 全部 success。下载后的两平台原始 bundle
独立 --verify 及 artifact-relative 双平台重验均 exit 0；三个要求的 offline levels BOTH_PASS。
Windows 全仓 7673 passed / 2 skipped；Ubuntu 7664 passed / 11 skipped；各 417 files passed。
每平台 producer 的八个命令均 exit 0，paidExperimentRun/championPromotion 均 NOT_RUN。

证据索引和 ZIP digest 固化于 `docs/evidence/n6-final-ci-attestation.json`，完整说明见
`docs/evidence/n6-dual-platform-final.md`。工作分支为 `codex/complete-handover-n5-n6`，已发布。
本轮无待实现任务；`--full`、付费实验、promotion 是未授权的后续事项，不冒充已运行。
后续文档提交不能借用此 SHA 为新 SHA 的 attestation，应读取该分支最新 workflow 的实际结果。

用户只需 Windows；不要求用户安装 Linux/WSL/Docker。
提交信息使用文件 + git commit -F；只 add 当前任务 scope，不 git add -A。
生产长链在干净隔离 worktree 内执行，不并发编辑其 tracked files；不 git stash。

## Historical / superseded

上一份交接的“提交未 push / 无 CI”已过期：远端 42ae7c2 已有完成但失败的 workflow，
两个 CI 失败点（浅克隆 pin 测试、空 cleanup catch）已修；它不是新提交的终验。
旧记录可从 git 历史或 N2/N5 报告的 Historical 段读取，不能当作当前证据。
