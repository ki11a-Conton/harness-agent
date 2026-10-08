# 内部 coding 提示词审查与改进计划（2026-10-08）

基线：`663b6552db0e7006e7e47c70b5ab68fb6212786b`。任务见 `tasks/CODING-PROMPTS-20261008.md`。

## 已确认的问题

| 编号 | 问题与源码证据 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- | --- |
| P01 | `create-harness.ts` 默认提示词仅列出能力、审批，没有编码、验证、失败修复闭环 | 增加版本化 coding 策略 | Agent 层纯函数生成 `coding-v1`：理解需求→检查项目→实施→真实检查→诊断修复→据实报告 | 捕获实际 ModelRequest；真实 CLI/Web HTTP + 文件编辑 + 失败后修复 + 独立测试 |
| P02 | CLI 导出的 `DEFAULT_SYSTEM_PROMPT` 与真正加载的 Harness 默认文本不同 | 消除文档/导出与执行路径漂移 | CLI 复用 Harness 默认常量，CLI/Web 使用同一个策略解析器 | 先保留实际请求不一致的 RED，再验证同一反例 GREEN |
| P03 | worker 提示词没有明确调查/写入范围、验收和交接规范 | 按角色/能力生成提示词 | readonly 仅调查；write worker 仅隔离工作区；不改变工具、权限、委派开关 | readonly 无编辑/exec 指令；原工具权限逐项保持；只按提供的工具渲染操作规则 |
| P04 | 复制其他 agent 的完整提示词会带入不存在的工具及平台假设 | 复用适合本项目的开源设计 | pi 的条件工具片段与去重；Codex 的保护用户改动；OpenCode 的行动闭环；Hermes 的真实结果与依赖顺序 | 工具白名单与渲染测试；结构化 exec/cwd 实测；记录许可证、来源及未采纳设计 |
| P05 | 新提示词如果只记录版本名，会允许同版本正文改变后静默恢复旧会话 | 记录实际正文、冻结会话策略 | 在既有 HarnessConfig/配置指纹中保存三角色编译后的正文；沿用现有 drift 拒绝 | 同版本改正文拒绝恢复；相同正文允许恢复；旧会话用 legacy 恢复 |
| P06 | 提示词工程测试不能证明真实模型能力达到 Codex/Claude Code 水平 | 分开工程验收与真实模型效果 | 新策略通过 `HARNESS_AGENT_PROMPT=coding-v1` 显式开启；默认 legacy 与冻结 N7/champion 实验保持原文；用户线下 paired eval 后决定推广 | 全量单测、security/protocol、HTTP coding 验收通过；真实模型状态保持 NOT_PROVEN，不伪造提升 |
| P07 | 组合反例：显式新正文与旧冠军自动叠加仍会生成 AppliedProof，证明未评估的组合 | 隔离 challenger 的冠军应用 | 共享 CLI/Web startup 对显式 Agent 策略走独立 createHarness；不自动叠加旧冠军、不写 AppliedProof；原冠军状态供 legacy 正常应用 | 两条实际 startup RED→GREEN；新策略 proof=null、状态文件未变；切回 legacy 后原冠军仍正常应用 |

## 源码分析结论

参考工作区 `/workspace/HARNESS-SRC-FORK`（`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`）和 `/workspace/deepseek-harness`（`5badb15009ae1756c3afe0ae0cef1faafc290ccc`）。完整映射在 `docs/coding-prompts.md`。

- pi：`packages/coding-agent/src/core/system-prompt.ts`，MIT，按可用工具生成并去重操作准则，可直接改编其小型纯函数模式。
- Codex：`codex-rs/core/gpt-5.2-codex_prompt.md` 与 `templates/model_instructions/gpt-5.2-codex_instructions_template.md`，Apache-2.0，保护已有改动、持续执行、明确验证结果。
- OpenCode：`src/session/system.ts`、`prompt/gpt.txt`，MIT，按能力/权限组装、用户要求行动时实际实施；不采用 `beast.txt` 的无条件联网、巨量读取和自动创建配置建议。
- Hermes：`agent/system_prompt.py`、`agent/prompt_builder.py`，MIT，真实产物和测试输出、失败后修复、独立读取并行而依赖调用顺序执行；稳定提示前缀与动态上下文分离。
- DeepSeek Harness：`packages/core/system-prompt/src/index.ts`，模块化、有顺序、按角色拼接的设计；本项目已有 ContextPipeline，不重造插件注册器。
- 名为 `claude-code-fork-main` 的目录 README 自述为 leaked source，且没有找到开源许可证；本轮不使用其实现或提示词。

## 实施顺序与验收边界

1. 编写本计划、任务文件；建立实际默认提示词请求的 RED 反例。
2. 实现 Agent 纯函数、Harness 编译策略、CLI/Web 策略选择；保存许可证与改编说明。
3. 加入实际请求、角色能力、预算、恢复漂移、champion 精确 suffix/legacy 不变的回归。
4. 运行 typecheck、针对性测试、实际 CLI/Web 本地 HTTP 验收；复用既有真实工具脚本，增加新策略上网线的断言。
5. 源码固定后运行完整测试、security、protocol；归档日志、实际提示词/字节与 SHA256、请求、结果和明确限制。
6. 原生 Git commit/push。证据记录验收源码 SHA；不改 frozen N7 结果、冠军或质量阈值。

完成条件：P01–P05 的工程验收通过，P06 的真实模型效果边界写清楚；新策略可由用户直接启用和回退。不能凭脚本模型选择的工具宣称新提示词提升了真实模型解题率。真实 paid paired eval 不在本环境伪造完成。
