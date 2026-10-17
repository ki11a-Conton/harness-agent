# 精确源码 CI 复核

源码 `bddf6f64efe6dbfe7ca02ad352a20735f6e7170b`；结论 **NOT_GREEN**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [38875780424](https://github.com/ki11a-Conton/harness-agent/actions/runs/38875780424) | completed/failure | 7/2/1 |
| 原生 Windows | [38875780375](https://github.com/ki11a-Conton/harness-agent/actions/runs/38875780375) | completed/success | 1/0/0 |
| 安装包验收 | [38875780438](https://github.com/ki11a-Conton/harness-agent/actions/runs/38875780438) | completed/success | 3/0/1 |
| Web UI 安装验收 | [38875780426](https://github.com/ki11a-Conton/harness-agent/actions/runs/38875780426) | completed/failure | 2/1/0 |

主 CI 任务：

- real formal offline (windows): completed/success (job 116890374733)
- r97-r98 closed loop (ubuntu-latest): completed/success (job 116890375023)
- coverage gate (ubuntu): completed/success (job 116890375069)
- real formal offline (ubuntu): completed/success (job 116890375241)
- r97-r98 closed loop (windows-latest): completed/success (job 116890375327)
- offline cold-start (ubuntu): completed/success (job 116890375333)
- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/failure (job 116890375341)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/success (job 116890375460)
- dual-platform acceptance (same SHA): completed/failure (job 116903867615)
- release attestation (P38-12): completed/skipped (job 116904066770)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。

未满足条件：

- ci: completed/failure
- job 116890375341: install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/failure
- job 116903867615: dual-platform acceptance (same SHA): completed/failure
- job 116904066770: release attestation (P38-12): completed/skipped
- official DeepSeek UI installed acceptance: completed/failure
- job 116890674268: installed (windows-latest): completed/failure
