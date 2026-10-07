# Coding 链残留问题审查（2026-10-07）

审查基线：`33eb6438130956be51706bb523071f7550ba83ab`。本轮确认的 7 类问题均有失败反例，均已修复；全仓与跨平台结果见完成报告。此前审查及冻结的 N7 NOT_PROVEN 事实保持原记录，不将 scripted 工程验收解释成付费模型质量证明。

| ID | 级别 | 触发与影响 | 解决办法 | 验收 |
| --- | --- | --- | --- | --- |
| C01 | P1 | 在别的目录启动 `run <project>` 时，宿主工具/沙箱/上下文/doctor 仍绑定启动目录，合法项目的读写执行会被错误限制 | 显式项目 cwd 传入生产 composition root；入口先检查目录；dataDir 按启动目录解析；不修改全局 cwd | 从另一目录操作带空格的真实临时 Git 项目，读、改、执行成功；无效目录在 provider 请求前拒绝 |
| C02 | P1 | CLI 等待完整回合才输出 ID，没有同进程审批输入，默认 ask 策略下无法交互完成写入/执行 | 运行时立即显示 ID，宿主输入队列处理单次 allow/deny；决定仍通过 RPC；EOF 拒绝；Ctrl-C 通过 runtime 取消；退出清理资源和审批等待 | 实际 CLI 五次独立 allow 完成任务；EOF 无写入；取消真实长进程；默认权限与沙箱保留 |
| C03 | P1 | session 在子项目时，自动验收发现父目录命令；父目录测试通过会掩盖子项目失败 | planner 将实际 session cwd 传给命令发现 | 父测试 exit 0、子测试 exit 7 时必须 verification_failed |
| C04 | P1 | 测试 manifest/recipe 修改后，缓存旧的通过命令使新失败测试被跳过 | 每次自动验证重新发现当前 checkout 的命令；保留普通上下文 warm cache；无命令时 fail closed | 同一会话 first pass 后把 test 改为 exit 9，第二回合必须失败 |
| C05 | P1 | 普通 exec 失败输出丢失；宿主验证 exec 结果也不进入模型历史，模型仅收到通用错误，无法利用编译/断言诊断修复 | 失败结果保留结构化 output；验证请求/结果形成完整工具协议对；经过现有脱敏、注入扫描、预算/制品边界；诊断不放入 system 指令 | 真实失败断言到达下一次 HTTP 模型请求；修复后验证通过；协议完整；失败 stdout/stderr 中秘密被脱敏、伪 SYSTEM 被拦截 |
| C06 | P2 | OPENAI_MODEL 指向自定义模型，但 CLI/Web 会话记录仍报 gpt-4o-mini，与 HTTP 实际 model 不一致 | 共用 interactive model ref 解析，provider 构造和宿主元数据绑定相同模型；正式实验独立冻结配置不变 | 实际 HTTP wire model 与导出的 session.json model 一致；Web 重启及后续回合仍一致 |
| C07 | P2 | 修复环中多次编辑同一路径，filesChanged 重复累积，文件清单与 Git diff 不一致 | 保持路径清单唯一，保留每次实际操作记录 | 真实项目两次编辑同一文件后只报告一个变更文件，Git diff 与独立测试核对 |

另补齐可选的显式编程验证入口：CLI `--verify <command>`，Web `HARNESS_VERIFY_COMMAND`。验证仍执行既有权限/审批/沙箱与有界修复，结果公开 completion grade；未配置验证只能是 unverified。没有改写 Runtime 架构、champion、模型策略或实验门限。

审查覆盖 CLI/Web 宿主、生产 provider、session/turn/followup、context 与工具结果、文件编辑/并发版本、进程 argv/取消、权限/沙箱、verification、持久化恢复、SDK/Gateway 协议、研究/发布脚本及 CI。未发现新问题的部分由既有回归和本轮全量检查支持；这不保证任意未来输入或外部模型都无 bug。
