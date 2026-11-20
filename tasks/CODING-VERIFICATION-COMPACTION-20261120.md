# 压缩后保留验收失败诊断

基线为 `f6a6c02e3b60880dad3da557071aa16978f0b2e6`。真实 Node 检查读到错误文件值时以退出码 8 失败，并输出带有期望值的诊断。自动压缩将其折叠进摘要水位，合法但简短的 handoff 只称检查失败。下一次模型请求缺少修复所需的原始诊断。

- Codex 用来源元数据选出需要跨窗口保留的工具输出。Harness 由执行验收的 Runtime 在真实失败结果上持久化标记。[Codex 源码](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/core/src/compact_retained_tool_outputs.rs#L6)
- Cline 用工具 ID 计算消息闭包，以免投影过程拆开调用和结果。Harness 调整自动压缩保留尾部的起点，继续用现有的历史水位、调用配对和 token 估算逻辑。[Cline 源码](https://github.com/cline/cline/blob/eff43e19b267e171f597ab03733bfed25090f72d/sdk/packages/core/src/extensions/context/budget-projection/project.ts#L612)

验收路径使用脚本模型、真实命令、文件修改和再次验收。对照要求摘要不含诊断，保留的工具消息与持久化消息逐字段相同，工具调用和结果配对。若整个批次与摘要及当前输入无法同置于预算中，按正常压缩规则退回摘要。旧记录没有标记时采用现有策略。代码沿用 ToolOrchestrator 及现有工具结果的脱敏和注入检查。

## 实测结果

在 JSONL 和 SQLite 的 560 行场景中，原有尾部选择都会覆盖失败诊断。脚本模型维持原文件值，在三次真实失败后得到 `verification_failed`。候选保留包含两条命令的完整批次，首次失败后即收到了原始断言，执行 `edit_file`，最终检查通过并得到 `verified_complete`。1450 行的诊断批次超过上下文预算，沿用原有摘要路径，原始消息保存在会话中。测试确认修复请求在 6200 token 总预算及 500 token 输出预留内，三组请求均符合工具协议。 [集成测试](../packages/harness/src/coding-verification.regressions.test.ts)
