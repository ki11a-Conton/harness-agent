# 精确源码 CI 复核

源码 `d6e00881dc804371165170c2a9a0697e34ff7b54`；结论 **PASS**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [38784015304](https://github.com/ki11a-Conton/harness-agent/actions/runs/38784015304) | completed/success | 10/0/0 |
| 原生 Windows | [38784015370](https://github.com/ki11a-Conton/harness-agent/actions/runs/38784015370) | completed/success | 1/0/0 |
| 安装包验收 | [38784015062](https://github.com/ki11a-Conton/harness-agent/actions/runs/38784015062) | completed/success | 3/0/1 |
| Web UI 安装验收 | [38784015436](https://github.com/ki11a-Conton/harness-agent/actions/runs/38784015436) | completed/success | 3/0/0 |

主 CI 任务：

- real formal offline (windows): completed/success (job 116591228359)
- real formal offline (ubuntu): completed/success (job 116591228589)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/success (job 116591228633)
- coverage gate (ubuntu): completed/success (job 116591228829)
- r97-r98 closed loop (windows-latest): completed/success (job 116591228851)
- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/success (job 116591228878)
- r97-r98 closed loop (ubuntu-latest): completed/success (job 116591228919)
- offline cold-start (ubuntu): completed/success (job 116591230509)
- dual-platform acceptance (same SHA): completed/success (job 116606077380)
- release attestation (P38-12): completed/success (job 116606325743)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。
