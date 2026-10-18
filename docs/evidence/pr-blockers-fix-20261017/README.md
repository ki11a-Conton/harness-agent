# PR #11/#13 修复与再验收证据

固定组合源码 `b35bff6487396d5ad78877600ba79fed9b286ea7`。做什么、怎么做和怎么验收见根计划与 [修复报告](../../pr-blockers-fix-20261017.md)。

local 保留原 e85a8941 的空 catch 安全/完整回归失败、新增 fixture 首次失败、真实旧会话 b4e6efe4 的 JSON 投影失败与修正后 fork 的未知 agent 失败；这些结果没有重跑覆盖。`pr13-report-ready-*` 才是最终固定 clean 组合的本地验收。中间 d7d7c60b/b4e6efe4 的绿测试不代替新增独立验收。

legacy/legacy-report-final/result.json 记录真实 JSONL、两次关闭/重建宿主、HTTP 两模型、已有 follow、历史前缀与分支模型来源的验收（同一 Node 进程内完整重建 harness）。常规 Web 用例启动独立 Node 验收进程，Windows 专项同样执行该用例。ci-native 的原生最终回执为 501 passed / 0 failed / 2 skipped，必跑用例全部通过；完整 503 项记录的哈希与 artifact 索引一致。

ci 保存合入前最新两个 PR 的四类工作流、push/PR 两种主 CI 和完整 job 原件。全部首次完成成功，主 CI 每次十项；仅普通安装流程的可选 export-existing-draft 可跳过。最终 main 是新的合并/归档提交，其四工作流必须另按最终 SHA 复核，不能拿这些分支结果冒充 main 验收。

log/mjs 使用确定性 gzip 保留原字节，copy-map 记录原件/归档双摘要；SHA256SUMS 覆盖本目录除自身的所有文件。无付费模型、连接器、子 agent 或 release。
