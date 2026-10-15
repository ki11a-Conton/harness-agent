# 最新归档 CI 与模型配置 PR 审查

本轮通过原生 Git/HTTP 复核，未使用 GitHub 连接器。审查对象固定为 PR [#9](https://github.com/ki11a-Conton/harness-agent/pull/9) `e55718819fd577e3409343f15237f1e4e0ac2b14` 和 PR [#10](https://github.com/ki11a-Conton/harness-agent/pull/10) `ecc73a56138ee0737053ef126045823a7f4ef3ca`。分别应用完整 PR 差异到当前修复基线 `7e199f2a`，另在干净组合提交 `efcac4601bea7f56600a2244c95318fb966aecc6` 上运行全量。原用户工作区未修改。

## 归档 CI

`d202e952` 的四个工作流均未整体通过：Windows 的 Git checkout 在新增的过深证据路径上失败，最高相对路径 235 字符，报告 `Filename too long`；Windows 产品测试没有启动。不能将原产品源码 `4ee21776` 的成功结论当成归档提交通过。

已将这 10 个文件的原始字节移到短路径，保留原始清单和完整路径/字节/hash 映射，验证器增加本次归档 Git 相对路径不超过 190 字符的检查。逐个对比原 Git blob 相同。修复以 `7e199f2af93ba9ba884da934e2fc6d3008fb9ef6` 推送 main，文档与证据校验通过，没有产品代码变更。

截至本次复核，`7e199f2a` 的真实 Windows 专项和普通安装工作流通过；[UI 安装工作流](https://github.com/ki11a-Conton/harness-agent/actions/runs/38735564822) 的 Windows job 两次失败，第二次为 narrow-tall 的 models-editor（找不到编辑按钮）与 session-lifecycle（15 秒后仍显示 Stop generating）等待超时，Ubuntu job 通过。[主 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38735187914) 的状态为：主 CI 尚在运行。因此整体 CI 仍为 **NOT_GREEN**，不把 UI 失败推断为已确定的环境噪声或视作修复通过。

原始 API 记录、失败 annotations、修复后各 job/step 与源码 SHA 记录在本报告相邻证据目录。UI 安装的 Windows 首次复验在 mobile/session-lifecycle 点击等待失败，按原源码/原 archive 重跑该 job；这与原来的 checkout 长路径失败不同，保留首次失败而非改判。

## PR #9：可合并

未发现阻塞问题。UI 对话框的调用是没有模型会话的、服务端注册的私有工具调用；本 PR 针对 `web_model_discovery` 铸造单次网络许可，沙箱只允许请求 URL 的主机，文件只读、进程禁止。注册工具不进入模型可见目录，也没有修改 agent 的权限配置。

既有 Catalog 校验拒绝非 HTTP、URL 内凭据、query/fragment；`fetch` 保持 `redirect:error`、30 秒上限和 1 MiB/1000 项响应上限。一次性密钥仅由 ticket 在服务端闭包引用，结束后删除，没有写凭据文件或放进工具参数。会话内调用仍要求审批，原测试实际拒绝该审批并确认未请求端点。

实测：完整 PR 在当前 main 上 `catalog.test.ts` 19 项通过；额外增加跨重定向密钥保护、恶意目录回显密钥、非法 URL 拒绝三项，合计 22 项通过。PR head 的 push 四工作流及 pull_request CI 均成功，原始状态另存 `pr9-runs.json`。测试收尾的 bounded rm retry 没有放宽业务断言。

## PR #10：先修一处 P2

目标问题成立：无 dataDir 的宿主不应因为不存在 durable schedule 文件而阻止草稿选模型；内存事件序号也必须与持久化实现一样，从每会话 0 开始。当前实现对这两点的主要修复有效。

**[P2] 不可把“配置了持久化但执行器缺失”报告为空日程。** 位置：[activity.ts:335](https://github.com/ki11a-Conton/harness-agent/blob/ecc73a56138ee0737053ef126045823a7f4ef3ca/apps/web/src/deepseek/activity.ts#L335)，同类分支在 342/360 行。

`durableStorage()` 同时检查 dataDir 和 executeHostTool。`sessionActivity` / `stopSessionActivity` 对 `!durableStorage()` 直接返回三个 0，因此“持久化目录存在但 executor 不可用”也被认定为“没有任务”；`start()` 也会静默跳过。实际测试先创建一个已落盘的 active 周期任务，再让宿主 executor 不可用：两个方法均成功返回 0，恢复 executor 后同一文件仍显示 activeSchedules=1，文件字节完全没变。读取失败与任务已不存在不是同一事实，生命周期/活动查询应继续拒绝。这是非默认宿主/执行器缺失时的契约回归；默认 composition 当前始终提供 executor，不能把它夸大为所有正常启动都会触发。

最小修正：仅 `host.dataDir === undefined` 才使用空日程回退；配置了 dataDir 时保留 `schedule/unavailable`。`start` 同样只为无 dataDir 跳过，让执行器缺失通过原读取路径显式失败。建议同时合入反例，补丁为 `pr10-fail-closed-fix.patch`。

对照已实际执行：同一个反例在未应用 PR 的 main 上 PASS，在原 PR 上 FAIL，采用三行修正后 PASS；activity/composition/并发序号等合计 36 项通过，typecheck 通过。该补丁已在精确原 head 的文件上 `git apply --check`，可直接应用。

PR 原版的 harness/composition 439 项通过。另补 40 次交错并发事件的每会话序号、分页/stream/空会话检查；真实内存模式的连续三次换模型、向最终模型实际发送一次 HTTP 请求、输入后换模型拒绝，合计 10 项通过。额外测试与建议补丁是审查附件，未改远端 PR 分支。

## 组合及限制

干净组合源码 `efcac4601bea7f56600a2244c95318fb966aecc6` 的 `pnpm test`：579 文件通过/2 文件跳过，**9795 通过 / 15 平台跳过 / 0 失败**，968.09 秒；安全 2146 项通过。Linux Node v24.19.0，本地 pnpm CLI 11.19.0（项目/CI 声明 11.21.0）。两 PR 原版完整差异均可应用至当前 main，无合并冲突。

组合提交仅含原 PR 的 5 个文件差异，不含 P2 修正；因此全量套件结果不能推翻独立新增反例。建议修正后再把 #10 合并。此轮审查未进行付费模型调用，实际 HTTP 由本地测试服务返回，结论不包含模型质量。

PR #10 的原始 pull_request CI 曾在预算锁的 `held-a` barrier 测试失败，原件保留；它与此处可重现的存储回退问题不同。不能将现有 CI 绿灯或某次环境时序失败代替上述具体源码审查。

附件：[最小修正与反例](evidence/pr-review-20261015/pr10-fail-closed-fix.patch)、[完整证据清单](evidence/pr-review-20261015/inventory.json)。补丁应用目标为 `fix/web-memory-only-model-selection`，不是尚未合入该 PR 的 main。此轮仅对两个 PR 给出审查建议，远端 PR head 保持原值。

## 后续合并授权

用户在上述审查后明确要求合并 main；本次将 #10 的最小修正连同磁盘拒绝、并发序号和实际内存模型请求的回归一起提交，再合入 #9/#10。原审查结论与原失败证据不改写。另已复核 `7e199f2a` 的主 CI 最终成功；Windows UI 安装工作流的两次失败仍是该源码的真实结果。本次进度见 [合并计划](../plan(20261015-212057).md)。
