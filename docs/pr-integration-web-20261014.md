# PR 集成与 Web 连接状态修复

基线 main：`f1f5f71378da3fe28bb1e5ac52beb837444cc463`。用户授权接收可用 PR 到 main，并修复源码启动、本机 Web 右下角持续“重新连接中”。本轮在独立 worktree 工作；旧 v1.10.0 tag/发行资产和冻结实验原件保持原源码绑定。

## 接收范围

PR #3–#7 的固定 heads 已在本地组合，并保留全部祖先。#3 的指标/故障注入、#5 的 Runtime 遥测、#6 的证据一致性/观测覆盖、#7 的读回规则均接收有效部分并关闭审查反例。#4 作为 2026-10-08 的历史设计讨论保存，不把其旧源码描述当作当前 main 状态；它包含 #3 的祖先代码，不能按独立“纯文档”改动忽略。

| 问题 | 修复 | 验收 |
| --- | --- | --- |
| R1 不完整 A/B 被放行 | 必须条件全部明确 true，缺失单独报告；对比实际模型/基准/环境及任务集合 | 单个条件无法放行；正向与原门禁保留 |
| R2 重复协议漏跑/少跑/重复身份 | 保存逐任务重复身份，至少 3 个唯一有效样本，拒绝共享 group 和不足 group | 3 类确定反例 BLOCKED |
| R3 早期 PASS 覆盖后续失败 | 指标和 V3 builder 共用当前 turn 的终态验证判据 | PASS→FAIL 返回 FAIL |
| R4 孤立 Trace/坏请求不入分母 | 核对生命周期和调用关联、工具名与序列，保留坏请求的分母 | 孤立完成、缺终态、无 ID 请求拒绝或计为失败 |
| R5 部分未知 usage 被计完整成本 | 所有调用 usage 完整才生成完整成本，未知保留 null | 2 调用中 1 未知不报告完整成本 |
| R6 效应类别自我洗白/坏 JSON 崩溃 | 校验事实 type 与 class、未知 kind 及每个事实形状 | 拒绝伪造类别，null facts 不抛 TypeError |
| R7 consistency 失败但硬安全门通过 | 检查全部 outcome，任何不一致都阻断，不只看 hardBreach=true | ESCAPE + hardBreach=false 不能放行 |
| R8 V3 证据丢失/新 kind 静默降级 | 可选的 typed facts/hardBreach 无损解析，显式 escaped_unproven，读回保留结构化一致性结果 | 完整 writer/parser/digest/loader 往返及 tamper 检查 |
| R9 错误码命中 Object 原型 | 仅索引 own keys，未知 code 走明确拒绝分类 | constructor 等不能漏报 |
| R10 用错误码猜测已上报 | 核对相同 session/turn/call 的已提交事件，PermissionEngine 先完成事件提交 | 注入宿主和真实权限/沙箱/写安全链路恰好一个相关事件 |
| R11 未派发却称已重试 | 真正派发后记录 retry_safe，截止/取消拒绝单独记录 | 日志计数与真实 dispatcher 次数一致 |
| R12 真正失败被预期故障日志覆盖 | 两路输出先收集、按真实失败优先级排序，再限制行数；失败也上传 gate 原件 | 跨 stream 与晚到失败两项反例；不改变失败 verdict |

原有“零事件就算成功去重”和固定 a/b/c 却宣称同任务集的测试夹具已纠正，原用例及安全阈值保留。架构、工具权限、沙箱与验证边界不绕过。

## Web 复现与修复

全新状态从源码启动时，正常网络下持续 40 秒未出现错误提示；这不能确定用户本机的原始根因。本轮另取得两项确定复现：

1. 浏览器 navigator.onLine=false 会暂停 loopback 的连接循环，而真实 localhost HTTP/WebSocket 仍可访问。连接衍生模块对真正的 loopback 不用网卡 online/offline 提示判定可达性，健康握手和真实断开仍决定状态；远程地址保留原行为。
2. “重新连接中”的最短可见时间使用 Date.now。重连期间系统时间回拨 60 秒，可在健康握手之后继续显示一分钟以上。设置衍生模块改为单调时钟 performance.now；没有隐藏真实断线。

新增 2 个可复算衍生 entry，合计 10 个 JS entry 与 2 个 SVG；完整 66 entry 图及所有原 npm 字节/许可证保持校验。来源仍为固定官方 npm 发布物，不声称等同参考 Git 源码。

真实中英文浏览器在网卡离线提示下连接，实际停止并重启生产宿主，检查断开提示、恢复后清除提示，并让恢复后的 agent 真正读取 demo.js、把工具内容交给本地 HTTP 模型。0 付费调用，不替换后端响应；IPC 只调用真实 SIGTERM handler，不声称 native OS signal delivery。

## 修复阶段验收记录

源码构建 PASS；相关 272 项回归 PASS，含审查阶段 17 个 RED 反例转 GREEN。真实 PermissionEngine、Sandbox 与写安全护栏 3 项拒绝链路 PASS；真实浏览器中英 2 场景/10 断言 PASS；实际冻结 JS 提取的连接/时钟回归 5 项 PASS。

上述为修复阶段的记录；最终固定源码、全量、两平台 CI 与实际合并结果见下方。付费模型质量及完整默认 UI parity 仍未晋升。

12a43d30 本地全量通过（9,705 PASS / 15 SKIP），双平台 installed 与 Windows 专项也成功，但主 CI 第二轮 test gate 失败；原摘要被预期故障日志覆盖，且失败后原件上传被跳过。已保存失败 API 记录，补 R12 确定反例并修复诊断，不报告该候选整体通过，也不把未知原始失败宣称已经定位。新固定提交 3af15705 已重新执行完整验收，最终结果见下方。

## 源码启动复核

拉取 main 后停止旧 Web 进程，在仓库运行 `pnpm install --frozen-lockfile` 与 `pnpm build`，再启动 `node apps/web/dist/main.js`，默认 http://127.0.0.1:8787。浏览器刷新后验证实际读文件任务；Web 编程策略可按发行说明显式配置 HARNESS_AGENT_PROMPT=coding-v1。日志与实际状态仍异常时应保留错误进行定位，不用界面“连接成功”代替真实任务验收。

## 固定源码和验收边界

产品验收源码：`3af15705a9046a370617b9f0dd2948719fee7102`，Git tree：`8e82a39e4c96f2048ca432dcda8e76083f92adc5`。全量执行期间工作树 clean；归档提交仅保存文档与证据，不能代替上述源码 SHA 的运行结果。

| 验收 | 实际结果 |
| --- | --- |
| 本地全量 `pnpm test`（包含类型构建） | 565 文件 PASS / 2 文件 SKIP；9,707 PASS / 15 SKIP / 0 FAIL，退出 0 |
| 相关回归与真实拒绝链路 | 272 项相关测试通过；真实权限/沙箱/写安全 3 项通过，均包含于全量，不叠加总数 |
| 资源封存、发布脚本和生产依赖 | vendor verify PASS；Node 脚本 82 PASS；生产依赖公告 0 |
| 本地独立安装包 CLI | 50 断言、19 次 loopback HTTP 请求、真实验证/修复/审批/重启/篡改检查 PASS |
| 本地独立安装包 Web | 三视口 30 场景 / 75 断言 PASS；中英连接恢复 2 场景 / 10 断言 PASS |
| 固定源码真实 Windows 专项 | 393 PASS / 2 POSIX SKIP；12 项必跑测试通过；公开 annotations 无损还原用例记录并核对摘要 |

内部验收包 SHA-256：`78a5ac0e48e52dd018f356e17ed6a790b2022a4a95bb00d3a2b872c442c45548`，3,055 个 manifest 文件，没有工作区 symlink。包内版本仅用于已有 1.10.0 打包器的内部验收，未上传或覆盖公开 v1.10.0。

Windows 专项原始 Azure artifact 未下载；归档的是原生 GitHub API 的 check annotations、从其中无损恢复的全部 case records 和摘要复核，不冒充原始 vitest JSON。远端安装包工作流的通过按真实 job/step 状态记录，本地安装包的详细 receipt 和浏览器原件完整保存。

早期 `2b8265c0` 候选在修改适配版权说明后没有重新封存，资源校验实际拦截；相应候选 CI 和本地全量已取消，不能报告为通过。已重新生成封存和 module count，在固定 `12a43d30` 重新验收。另一次 Node 打包测试因 pnpm store 不可写失败，改用可写的显式测试 store 后通过；初始浏览器测试定位器未匹配省略号，纠正定位后保留真实状态断言。相关失败/取消原件随归档保存。

上述工程测试付费调用均为 0。用户本机原始“重新连接中”的具体触发仍缺机器日志，不能断言就是离线提示或系统时钟回拨；已证实并修复两条实际失败路径，并在真实后端停止/恢复后完成 agent 文件读取。付费模型质量、完整默认 UI parity、强隔离 PTY/Cordis/goal/队列原子编辑仍未在本轮晋升。

本地完整测试由 pnpm 11.21.0 启动；嵌套命令的默认 pnpm 为 11.19.0，版本分别记录于 receipt。正式两平台 CI 固定使用 pnpm 11.21.0 和 Node 22，不把两个环境混写成同一运行。

## 远端 CI 和实际合并

产品源码 `3af15705` 的完整 CI 第一轮 10 个任务全部 SUCCESS，包括两平台 verify、formal、closed loop、cold-start、coverage、same-SHA dual-platform acceptance 和 release attestation；不拼接重跑结果。独立 Windows、两平台 installed UI、CLI 及同包 Windows 消费的工作流也 SUCCESS，只有授权私有 draft 导出任务按既有分支条件 SKIP。

- [38588224938](https://github.com/ki11a-Conton/harness-agent/actions/runs/38588224938)：source `3af15705`，attempt 1，success。
- [38588224766](https://github.com/ki11a-Conton/harness-agent/actions/runs/38588224766)：source `3af15705`，attempt 1，success。
- [38588224455](https://github.com/ki11a-Conton/harness-agent/actions/runs/38588224455)：source `3af15705`，attempt 1，success。
- [38588224749](https://github.com/ki11a-Conton/harness-agent/actions/runs/38588224749)：source `3af15705`，attempt 1，success。

2026-10-14 15:57:14 UTC，main 从 `f1f5f713` 原子 fast-forward 到通过验收的 `3af15705`；PR #5–#7 先调整 base 为 main，五个原始 head 均保留为祖先。原始 PR 的独立 CI 并未改写成通过，实际验收的是包含修复的最终集成源码。

- [PR #3](https://github.com/ki11a-Conton/harness-agent/pull/3)：state=closed，merged=true，GitHub mergeCommitSha=`083b38cfba87cd1ce3fc3fd80f1515f9fe977218`。
- [PR #4](https://github.com/ki11a-Conton/harness-agent/pull/4)：state=closed，merged=true，GitHub mergeCommitSha=`8b6ed36d2bc09d56a1b010dc2924034e89b0947c`。
- [PR #5](https://github.com/ki11a-Conton/harness-agent/pull/5)：state=closed，merged=true，GitHub mergeCommitSha=`ba8740542b219fee9a50fd2e9f74e57fec5a5df4`。
- [PR #6](https://github.com/ki11a-Conton/harness-agent/pull/6)：state=closed，merged=true，GitHub mergeCommitSha=`a308eb3ce2a3c4e9d912a6ab94c5c9882e60b96b`。
- [PR #7](https://github.com/ki11a-Conton/harness-agent/pull/7)：state=closed，merged=true，GitHub mergeCommitSha=`36946e5cbec38aff76095461eed82f470e87fbf6`。

PR 的 mergeCommitSha 是 GitHub 记录的祖先/集成节点；main 只在最终修复源码通过后一次更新，没有逐个发布未修复的中间节点。最终报告与原件随后以归档子提交保存，产品测试仍绑定 `3af15705`。

[证据索引与字节复核](evidence/pr-20261014/README.md)保存初始反例、失败候选、当前通过结果、浏览器截图、CI/API 原件及逐项摘要。v1.10.0 tag 仍指向 `b65801e4`，既有 release id、四项 asset id/size/digest 均与合并前相同；没有新增发行。
