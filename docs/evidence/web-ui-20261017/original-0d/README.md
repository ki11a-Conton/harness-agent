# 精确源码 CI 复核

源码 `0d960c2cf788435df532600124745399937d945f`；结论 **NOT_GREEN**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [39024543525](https://github.com/ki11a-Conton/harness-agent/actions/runs/39024543525) | completed/failure | 7/2/1 |
| 原生 Windows | [39024543509](https://github.com/ki11a-Conton/harness-agent/actions/runs/39024543509) | completed/success | 1/0/0 |
| 安装包验收 | [39024543507](https://github.com/ki11a-Conton/harness-agent/actions/runs/39024543507) | completed/success | 3/0/1 |
| Web UI 安装验收 | [39024543506](https://github.com/ki11a-Conton/harness-agent/actions/runs/39024543506) | completed/failure | 1/2/0 |

主 CI 任务：

- offline cold-start (ubuntu): completed/success (job 117372828599)
- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/success (job 117372828682)
- r97-r98 closed loop (ubuntu-latest): completed/success (job 117372828702)
- r97-r98 closed loop (windows-latest): completed/success (job 117372828726)
- coverage gate (ubuntu): completed/success (job 117372828735)
- real formal offline (ubuntu): completed/success (job 117372828744)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/failure (job 117372828747)
- real formal offline (windows): completed/success (job 117372828793)
- dual-platform acceptance (same SHA): completed/failure (job 117378215674)
- release attestation (P38-12): completed/skipped (job 117378315299)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。

未满足条件：

- ci: completed/failure
- job 117372828747: install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/failure
- job 117378215674: dual-platform acceptance (same SHA): completed/failure
- job 117378315299: release attestation (P38-12): completed/skipped
- official DeepSeek UI installed acceptance: completed/failure
- job 117372980452: installed (ubuntu-latest): completed/failure
- job 117372980480: installed (windows-latest): completed/failure
