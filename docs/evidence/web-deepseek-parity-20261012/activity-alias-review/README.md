# Activity / alias 独立复核，2026-10-12

本目录保存原始 Vitest JSON，不覆盖此前 RED 或旧版本验收。最新 scoped 门是 `web-activity-final-27-green-20261012.json`：24 activity + 3 文件安全回归全部通过；`tsc -b apps/web --pretty false` 同次工作区通过。不是整仓最终门、浏览器完整 parity、Windows 或付费模型能力证明。`manifest.json` 记录报告 SHA-256 和审查时 Web service 源文件 hash。

## 发现和修复

| 问题 | 可复现行为 / 修复 | 原始证据 |
| --- | --- | --- |
| 当前原生 preset 也被拒绝 | 对真实会话调用 `agentPresets/select` 并选择其已经冻结的 agent id/name，旧代码总返回 locked。现使用实际 Runtime definition 做幂等 canonical id 返回；不存在的角色 not-found，其他角色仍保持冻结边界。投影显示实际 `session.agentId`。 | native-catalog RED 2 fail → GREEN 2 pass |
| 权限说明与实际 agent 不符 | 把真实 agent 的文件编辑规则设 deny，旧 `permissionPresets/catalog` 仍描述 profile 模板。现读取注册 default agent 的真实规则；未匹配 fallback 按原生 contract 为 ask。 | 同上 |
| alias 后 prompt 元数据写入错误 owner | 更换全新 Web draft 的模型后，原生 ToolContext 下的 metadata intent 被写入拒绝 private native id 的 facade，真实 prompt 没有开始。root 修复实际 owner 的 ToolOrchestrator/journal；本 review 用真实生产 composition 复验。 | alias-native-timer 原始 RED → GREEN |
| schedule 未知 endpoint 可落入 update | 直接调用 activity service 的 `schedule/unknown`，旧分支真正改写任务。HTTP transport 原本已有注册表拒绝，因此此漏洞的复现范围是 service 边界。增加精确 endpoint allowlist，保持任务不变。 | unknown-schedule RED → 最终 GREEN |
| task 文件 regular-file 检查后路径重开 | 真实文件在 lstat 后换成指向外部有效 JSON 的 symlink，旧 readFile 跟随链接读出外部内容。现从单一 no-follow descriptor 做 opened stat、路径及单链接检查，并按 16 MiB 限制实际读取字节。 | task-file-race RED 1 fail/1 pass → security GREEN |
| 任务变更与 draft replacement 缺共同锁 | create（human/model）、update/delete、preset 操作复用 owner 的 session lock；read/history 不锁，timer 不持 store 写链等待 prompt。测试持有真实 metadata commit 的返回窗口，模型替换等待，恢复后拒绝替换并保留任务。 | 最终真实 race test |

## 实际执行证据

alias timer 回归走完整生产 composition、实际 Harness/store/ToolOrchestrator/approval/sandbox 以及真实 loopback OpenAI SSE。更换模型保留 external id，native id 真正更换；模型看到 `schedule_create`，真实外层 edit approval 允许后才能写固定 task file；task 持久化 external owner；真实 wall-clock timer 向实际 selected native inbox 提交第二条 prompt，真正执行第二轮 actor turn。三次模型 HTTP 都使用选定模型，最后一条 user 输入是定时任务原文，task delivery messageId 等于真实 InboxPromptId。没有付费模型调用。

其余真实回归覆盖并发 drive 去重、崩溃后同 admission id 恢复、uncertain receipt 不假交付、CAS/延期 snapshot、stop-after-claim 窗口、多 tab committed invalidation、cross-session 任务拒绝、审批拒绝/沙箱拒绝、固定 metadata path injection、DST gap/overlap、子任务 UTF-8 output resume、foreign parent 拒绝、精确 job kill 不取消其他 turn、secondary workspace 的实际独立 skill roots、原生 update_plan timeline。

POSIX symlink-swap case 在 Windows 明确平台 skip；hardlink/byte-bound/corruption case 不跳过。本机结果是 Linux 27 pass / 0 fail / 0 skip，不能据此声称真实 Windows 已完成。

## 独立身份复核与仍有的能力缺口

检查了真实队列/问答/审批/任务/子会话路径：Web alias 私有 native id 拒绝；ask 的 session + original turn + callId 绑定；event result 使用 generation/event correlation；InboxPromotedTurnId 绑定原 user message；foreign parent/job/task 拒绝；model tool 身份原生、task/UI 身份 external。该范围内未再复现 cross-session 身份绕过。根目录另有 session/owner/full transport 回归，需和本 scoped 门一同验收。

以下仍是明确能力缺口，不在本目录假称已经实现：`session/updateQueue` 的原子 edit/remove/steer owner；可创建的非默认 root agent preset；现有 session 的原子 permissions preset 切换；Cordis 动态 host bundles；durable goal continuation；continuable subagent inbox；无强 sandbox 后端平台的终端。复现方式分别调用对应已注册 RPC；当前返回明确 unavailable/locked/not-resumable，不伪造 mutation 或执行结果。普通 native coding/default composition 有真实工具与 skill catalog，但完整 DeepSeek 控件 parity 仍需 root 对这些矩阵项给出最终状态。
