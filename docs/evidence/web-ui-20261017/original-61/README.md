# 精确源码 CI 复核

源码 `61ef8e2030c40e81a1b768a741d5b63626edbab3`；结论 **NOT_GREEN**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [39005879802](https://github.com/ki11a-Conton/harness-agent/actions/runs/39005879802) | completed/success | 10/0/0 |
| 原生 Windows | [39005879806](https://github.com/ki11a-Conton/harness-agent/actions/runs/39005879806) | completed/success | 1/0/0 |
| 安装包验收 | [39005879714](https://github.com/ki11a-Conton/harness-agent/actions/runs/39005879714) | completed/success | 3/0/1 |
| Web UI 安装验收 | [39005879731](https://github.com/ki11a-Conton/harness-agent/actions/runs/39005879731) | completed/failure | 2/1/0 |

主 CI 任务：

- offline cold-start (ubuntu): completed/success (job 117318148059)
- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/success (job 117318148200)
- real formal offline (windows): completed/success (job 117318148215)
- coverage gate (ubuntu): completed/success (job 117318148220)
- r97-r98 closed loop (windows-latest): completed/success (job 117318148254)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/success (job 117318148259)
- r97-r98 closed loop (ubuntu-latest): completed/success (job 117318148290)
- real formal offline (ubuntu): completed/success (job 117318148298)
- dual-platform acceptance (same SHA): completed/success (job 117324496837)
- release attestation (P38-12): completed/success (job 117324572421)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。

未满足条件：

- official DeepSeek UI installed acceptance: completed/failure
- job 117318303214: installed (ubuntu-latest): completed/failure
