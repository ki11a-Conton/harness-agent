# 最终工程审查（执行中）

基线 main：5058d536d44acd61369d822cea4e160b553dff4b。独立工作区；本轮不发布 release/tag，交付后由用户本地测试决定。

## 已确认问题与修复方向

| ID | 严重性 | 实际触发与结果 | 修复与验收 |
| --- | --- | --- | --- |
| FA-1 | P1 | CLI 模型发出 ask_user 后未调用终端问答处理，退出码 1、原 turn 留在 waiting_for_user、pending ask 未回答。 | 接通实际问答 RPC、原 turn 恢复、EOF/Ctrl-C 和重启待答路径；断言答案只入原任务一次，不创建新任务，不跳过审批。 |
| FA-2 | P1 | 实际 exec 输出测试用合成 API key，模型 tool message 已脱敏，但 tool.output 和 tool.completed.outputPreview 事件仍含明文。 | 在生产工具事件边界保护未提交输出和结果预览；检查分片、超长、转义、失败、其他字段，事件/存储/UI/model 均不含合成 key。 |
| FA-3 | P1 | WorkspaceChangeTransaction 对工作区内指向外部目录的 symlink 可成功 snapshot/commit，实际改写外部文件。 | 原语在快照、提交和回滚前检查完整路径与文件身份，拒绝目标及祖先 symlink；原件不变，普通内部路径仍成功。 |
| FA-4 | P1 | 事务快照把非 UTF-8 字节解码成替换符，commit 后 rollback 无法恢复原字节；0755 可执行文件也会被临时文件默认模式替换为 0600。 | 快照拒绝不可无损解码的内容、保留原模式；读取错误不视为不存在，批量快照失败不留下半份新意图。 |
| FA-5 | P2 | Web 变更比较把两侧强制补上末尾换行，真实的仅换行修改会显示零 hunk、零增删；捕获 UTF-8 BOM 也会被解码器丢弃。 | 保留原始文本格式及标准 EOF 标记，BOM 不在捕获中剥离；换行/BOM/空文件比较回归。 |
| FA-6 | P1 | 问答暂停后 Actor 已 idle，session.cancel 返回 not_running，Ctrl-C 无法真正取消持久 waiting_for_user turn。 | Actor 独占并提交暂停 turn 的取消、撤回问题，合并重复请求并让 close 等待写入；不得改写已结束或其他会话。 |
| FA-7 | P1 | 完成后的同一个 turnId 再次调用 session.run 可再次执行模型；实际两次 completed、两次模型调用。 | Actor 和直接 Runtime API 均拒绝重跑 completed/cancelled turn，保留原记录和历史；有意的 failed 恢复与新 turn 继续验收。 |
| FA-8 | P1 | 实际 CLI 在 write_file → ask_user → 回答后，磁盘文件已修改，但原 turn 的 filesChanged、工具计数、副作用账本及预算被清空；暂停还会被作为失败送入完成回调。 | 为原 turn 保存问答暂停检查点，恢复真实 WorkingState、进度、账本与已消耗预算；人工等待不算执行时长；无可靠检查点的重启拒绝重置；暂停不调用完成反馈。验收实际写入后 CLI 退出/重启、原任务继续、预算/迭代上限及反馈。 |
| FA-9 | P1 | 同一 Runtime 的两个并发 session 共用 activeBudgetUsage 函数；实际 A 的文件工具检查点记录了 B 的 3 次调用消耗。 | 预算提供器按运行中的 session 隔离，所有检查点取本任务实时预算，结束时清理；跨会话错误请求不得清除正在运行的记录。可控并发回归。 |
| FA-10 | P1 | maxToolCalls 在工具返回后检查；设为 0，工具仍先派发，之后才报告 RESOURCE_LIMIT；已消耗预算的问答恢复也会多执行一次写入。 | 模型工具批次在派发前预留上限，仅派发允许的前缀；超额请求逐一给出未执行结果，保持 assistant/tool 协议连续；检查点包含本次已预留消耗。验收零额度、问答恢复和批量工具协议。 |
| FA-11 | P2，依赖公告 | 生产依赖锁定 fflate 0.8.2，公告 [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) 指出其 unzipSync 在畸形 ZIP64 上可死循环。当前服务端调用点为 zipSync 导出，本轮没有对外解压路径的攻击复现。 | 将 Web 依赖和锁文件固定到修复版 0.8.3；检查生产依赖 audit、实际会话 ZIP 导出/解包、冻结前端与独立包。保留原始供应商文件及来源记录。 |

## 初始检查

typecheck 通过。全量基线 549 文件，9,469 PASS / 6 FAIL / 15 skipped；6 个失败均由尚未提交的本轮计划文档触发 clean-source/晋升门拒绝，原件保留，不归为产品缺陷。最终全量必须在固定 clean 提交上重跑。首次离线安装缺 npm metadata，改用正常代理网络和可写 cache 后完成；未改变锁文件和安全门。

后续记录包括源码审查覆盖、RED/GREEN、固定源码工程门、安装包/浏览器、本地测试步骤和仍未支持的能力。不以测试通过声称不存在所有潜在 bug。

## 修复阶段验收

截至源码冻结前，14 个重点文件、202 项相关测试已通过，覆盖问答与重启、Actor 并发/取消、跨会话与重复回答、工具事件保护、事务路径/字节/模式、真实 Web 变更捕获、RPC 与两种协议传输。随后加入暂停完成回调、检查点缺失和迭代上限回归；最终结果以下文固定源码验收为准。

工具输出的未提交片段及截断预览不进入事件存储，事件保留字节数和 withheld 标志；完整工具结果仍走既有 Runtime 输出检查，再进入模型和历史。事务仍是受控写工具的协调原语，不能把路径复查声称为能抵抗任意外部进程竞争的 OS 沙箱。

审查覆盖：CLI 终端/问答/审批/恢复；Web 会话、模型配置、流式活动和工作区变更；Gateway/AppServer/SDK 的身份、取消与消息协议；Runtime/Actor、上下文、provider 流与错误恢复；工具、权限/沙箱与持久化；冻结前端资产、品牌和独立安装包。付费模型质量由用户本地实验；本轮不把脚本 provider 验收作为模型能力证据。
