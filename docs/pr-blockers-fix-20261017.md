# PR #11/#13 阻塞修复记录

用户追加授权修复后合并；原 [审查报告](pr-remaining-review-20261017.md) 与其失败证据仍绑定原始 PR head，不改写历史结论。

## #11

模型选择改为单条 Session 记录原子提交：当前模型、不可变 initialModel 与带稳定 eventId 的 outbox 同写。原 effectiveAgent 策略快照保持不变；只有经过显式选择记录的模型覆盖它，其余权限、工具、提示词与限制仍从快照读取。单进程选择与运行收尾串行，切换事件在重试/重启时去重补齐，缺失事件无法恢复时禁止新的模型执行。持久化提交后 I/O 返回异常可能意味着已提交：重试和读取会恢复同一选择，不做不可靠回滚。

升级旧消息以首次切换同写的 initialModel 保持来源；新消息保留生成时模型。分支复制旧答案时填入原模型，同时把父会话当前有效模型用于分支策略，避免继承过时模型。完整原型策略不因选择扩大。

旧的纯投影 reviewer 反例在输入中直接改 session.model，未执行任何合法迁移写入，因此修复后的常规测试补上 Runtime 实际同写的选择记录；原始反例文件原封不动留在历史证据中，前缀不变断言保持不变。另增加真实 JSON 文件存储的 row-before/row-after/event-before/event-after 四个故障后重新构造 harness 的回归，以及旧答案分支回归。PR 原本要求改写策略快照的测试改为验证策略不可变和显式选择生效，属于协议修正。

定向 6 文件 76 项通过；类型通过。完整回归、安全和最终精确 SHA CI 独立记录，不以这些定向结果代替最终验收。不调用付费模型、不发布 release。

## #13

- R13-1：共享模式保留旧短 sk 防护，并覆盖 JWT 的合法空白 JSON 编码；私钥从 BEGIN 到配对 END 全块遮盖，截断块遮盖至 EOF。证据摘要在抽取/重排行之前脱敏整个 stdout+stderr，落盘日志与 runner failure.detail 同样验证。原两个独立反例和真实生成 Ed25519、签名 JWT 的输出面测试通过。
- R13-2：sessionService 创建时保持 failed，配置基线持久化成功后最后发布 active；branch 初始 failed 语义保持。baseline/publish 的前后四个中断后重建 harness，均无可运行的缺基线会话，原失败反例通过。
- R13-3：稳定 alias owner 在全局/物理坐标间转换 afterSequence 与 limit，尾读不再获取并映射整个当前 owner 日志；每次仍完整验证所有 retired draft 前缀。JSONL 缓存尾查找改为二分，8192 事件的实际缓存用例最多检查 15/16 个序号；真实 owner 长日志尾读只交付 1 条、空闲交付 0 条，损坏 retired 前缀仍拒绝。原有审批/问答恢复与 Web 邻接覆盖通过。
- R13-4：RecoveryPolicy 暴露完整规范身份，五种失败类型的有效 cap、delay、exhausted action 全部进入摘要；不再用前八次样本代表策略。cap=16 的原 askOn 反例、per-kind cap=64/1000000、单类型延迟及 Set 插入顺序对照通过。
- R13-5：Linux 上模拟 Windows 的 fixture 使用实际存在的小写扩展，不改变生产文件系统查找语义。Batch 文件必须经过 cmd.exe 的显式 /d /s /c 引号封套和 verbatim 参数；原“独立 argv 足以解决 cmd 解析”的说明不成立，已修正实现与断言。加入真实 Windows 路径含空格、空参数、中文、尾部反斜杠的实际 batch->Node 回归，纳入 Windows 专项。Linux 上此原生用例明确跳过，只有实际 Windows CI 通过后才算完成该项。

本地 Web 31 文件/233 项通过；核心阻塞与新增边界定向复核通过，类型与安全、完整 suite 另按固定 clean 提交执行。首次新增长日志 fixture 漏写持久化 record envelope 的失败已修正，原失败日志保留；未删减预算或前缀完整性断言。真实 Windows 和最终 main 验收仍待 CI，不能提前视作全绿。
安全门首次发现锁队列的空 catch，保留原失败；改为 previous.then(action, action)，前一任务的失败仍返回其调用者，新任务在两种结局后均执行，不静默吞掉业务失败。修复提交重新执行安全与完整回归。
