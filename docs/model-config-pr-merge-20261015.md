# 模型配置 PR 合并验收

用户在代码审查后明确授权将 [#9](https://github.com/ki11a-Conton/harness-agent/pull/9) 与 [#10](https://github.com/ki11a-Conton/harness-agent/pull/10) 合入 main。本次使用原生 Git/HTTP，保留完整提交关系；原用户未提交工作区未修改。测试与归档生成于推送前，远端 merged 状态和合并后的 CI 以 GitHub 实际返回为准。

## 修正与合并

#9 保留 `4050e013` 与 `e5571881` 两个提交：UI 主动查询模型端点时获得单次、固定主机的网络授权，模型会话内的调用继续走审批，Catalog 校验、拒绝重定向、响应上限和密钥隔离保持生效。

#10 原 head `ecc73a56` 的无 dataDir 回退与每会话事件序号修正保留；另以 `797b17d29e571eedc86010dd1b14409b6854bc52` 推送原 PR 分支，修正有 dataDir、无 executor 时把磁盘任务误报为空的问题。查询、停止与启动均通过原读取路径明确拒绝。新增真实磁盘不变反例、40 次交错事件序号回归，以及内存模式连续选模型后实际发请求与输入后冻结的回归。

main 基线为 `7e199f2af93ba9ba884da934e2fc6d3008fb9ef6`，原生合并提交为 `0ed796c3`（#9）和 `e3233deb03fa4039c0565d32302edebde994b556`（#10）。PR #9 精确 head `e55718819fd577e3409343f15237f1e4e0ac2b14` 与 PR #10 修正 head `797b17d29e571eedc86010dd1b14409b6854bc52` 均已验证为候选祖先，避免只取 PR #9 的收尾提交而漏掉实际修复。Core/Runtime 无变更。

## 验收

固定干净源码 `e3233deb` 的 `pnpm test`：**9798 通过 / 15 跳过 / 0 失败**，包含 unit 与 integration；相关安全 **2146 通过**，类型检查、文档检查通过。修正后的 PR #10 精确源码上，activity/composition/事件序号专项 **36 通过**。CLI/Web 实际 loopback HTTP 验收 **19 请求、8 项策略与 50 项编码断言通过**，均使用本地脚本 provider，付费调用为 0，实际模型质量仍 NOT_PROVEN。

额外执行的 `pnpm capability:audit` 在该干净新 worktree 返回 1：21 个能力、11 wired、10 implemented-only、0 missing，实现/文档检查通过，但缺少当前 HEAD 正式 test gate 证据，evidenceFresh 与 requiredEvidenceFresh 失败。独立 `pnpm test` 不生成 GateEvidenceV2；未手写门禁、未借用旧 SHA、未为刷绿重复全量。正式 main CI 按仓库 workflow 执行 `release gate test` 产生当前源码证据后运行 capability 审计，不能提前算通过。

原 `7e199f2a` 的主 CI、真实 Windows 和普通安装最终成功；Windows UI 安装两次失败仍保留在上一轮报告。#10 修正分支的 Windows/安装/Web UI 工作流成功仅证明该分支，不替代最终 main 的验收。无 release 发布。

原始日志、源码/PR head、环境版本和本地审计失败均保存在[证据目录](evidence/model-pr-merge-20261015/README.md)。归档后仅文档、证据及证据专用的换行属性变化，产品代码维持上述测试源码；本次新增证据相对路径不超过 190 字符。运行 `python docs/evidence/model-pr-merge-20261015/verify-evidence.py` 校验字节和收据，不重放测试；原审查/C1 的冻结清单保持原值。
