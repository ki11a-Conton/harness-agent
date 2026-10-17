# 精确源码 CI 复核

源码 `e4c333e2d7ca4908b6b8d92b0e9f730e9af709b0`；结论 **NOT_GREEN**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [39003848212](https://github.com/ki11a-Conton/harness-agent/actions/runs/39003848212) | completed/failure | 6/3/1 |
| 原生 Windows | [39003848237](https://github.com/ki11a-Conton/harness-agent/actions/runs/39003848237) | completed/success | 1/0/0 |
| 安装包验收 | [39003848217](https://github.com/ki11a-Conton/harness-agent/actions/runs/39003848217) | completed/success | 3/0/1 |
| Web UI 安装验收 | [39003848196](https://github.com/ki11a-Conton/harness-agent/actions/runs/39003848196) | completed/failure | 1/2/0 |

主 CI 任务：

- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/success (job 117312160126)
- real formal offline (windows): completed/success (job 117312160186)
- r97-r98 closed loop (windows-latest): completed/failure (job 117312160229)
- real formal offline (ubuntu): completed/success (job 117312160231)
- r97-r98 closed loop (ubuntu-latest): completed/failure (job 117312160237)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/success (job 117312160238)
- coverage gate (ubuntu): completed/success (job 117312160240)
- offline cold-start (ubuntu): completed/success (job 117312160371)
- dual-platform acceptance (same SHA): completed/failure (job 117317659493)
- release attestation (P38-12): completed/skipped (job 117317743473)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。

未满足条件：

- ci: completed/failure
- job 117312160229: r97-r98 closed loop (windows-latest): completed/failure
- job 117312160237: r97-r98 closed loop (ubuntu-latest): completed/failure
- job 117317659493: dual-platform acceptance (same SHA): completed/failure
- job 117317743473: release attestation (P38-12): completed/skipped
- official DeepSeek UI installed acceptance: completed/failure
- job 117312304704: installed (ubuntu-latest): completed/failure
- job 117312304714: installed (windows-latest): completed/failure
