# 精确源码 CI 复核

源码 `3b3f4e9f81c19fa9f93f440d4b8ab7184d60a414`；结论 **PASS**。所有 workflow/job 的 SHA 和 attempt 已逐项核对。任务计数依次为成功/失败/跳过。

| 验收 | 运行 | 状态 | 任务计数 |
| --- | --- | --- | --- |
| 主 CI | [39029595652](https://github.com/ki11a-Conton/harness-agent/actions/runs/39029595652) | completed/success | 10/0/0 |
| 原生 Windows | [39029595651](https://github.com/ki11a-Conton/harness-agent/actions/runs/39029595651) | completed/success | 1/0/0 |
| 安装包验收 | [39029595616](https://github.com/ki11a-Conton/harness-agent/actions/runs/39029595616) | completed/success | 3/0/1 |
| Web UI 安装验收 | [39029595731](https://github.com/ki11a-Conton/harness-agent/actions/runs/39029595731) | completed/success | 3/0/0 |

主 CI 任务：

- offline cold-start (ubuntu): completed/success (job 117387211543)
- install · typecheck · test · build · benchmark-smoke · audit (windows-latest, windows): completed/success (job 117387211678)
- r97-r98 closed loop (ubuntu-latest): completed/success (job 117387211706)
- real formal offline (ubuntu): completed/success (job 117387211764)
- coverage gate (ubuntu): completed/success (job 117387211771)
- install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest, ubuntu): completed/success (job 117387211772)
- r97-r98 closed loop (windows-latest): completed/success (job 117387211774)
- real formal offline (windows): completed/success (job 117387211782)
- dual-platform acceptance (same SHA): completed/success (job 117393706891)
- release attestation (P38-12): completed/success (job 117393798088)

仅安装包流程的可选 export-existing-draft 允许跳过；主 CI 不接受跳过的发布证明或双平台汇总。CI 证明离线工程验收，不证明付费模型质量。
