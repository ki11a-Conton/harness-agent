# 内部 coding 提示词：源码来源、启用和验收

`coding-v1` 是 Agent 层的显式 challenger，工程验收与真实模型质量分别记录。既有默认 `legacy`、N7 冻结实验与 champion 的 `completionGuidance` 原文保持不变。提示词不能代替 PermissionEngine、SandboxManager 或 Verification 的强制约束。

## 启用

先 `pnpm install --frozen-lockfile` 和 `pnpm typecheck`，普通 CLI/Web 使用相同变量：

```bash
# CLI：使用新的数据目录；批准后实际编辑和检查
HARNESS_AGENT_PROMPT=coding-v1 node apps/cli/dist/main.js --data-dir /tmp/harness-coding-v1 run /path/to/project "修复失败的测试" --verify "npm test"

# Web：仍需配置真实模型的 provider 环境变量
HARNESS_AGENT_PROMPT=coding-v1 HARNESS_DATA_DIR=/tmp/harness-web-coding-v1 HARNESS_VERIFY_COMMAND="npm test" node apps/web/dist/main.js
```

Windows PowerShell 使用 `$env:HARNESS_AGENT_PROMPT = 'coding-v1'`，然后执行同样的 Node 入口。项目检查命令需要替换成该项目实际使用的命令。省略变量或指定 `legacy` 使用原有默认；未知值（包括空字符串）在 provider 构造前报错。CLI 高级注入可用 `createDefaultDeps({ agentPrompt: 'coding-v1', ... })`，优先于环境变量。

SDK：`createHarness({ ...config, agentPromptPolicy: createCodingPromptPolicy() })`，两者从 `@ar/harness` 导入。直接调用 `createHarness` 不受环境变量影响，省略策略仍是原来的文本；普通 CLI/Web 与冻结 prereg runner 的身份不能混为一谈。

`agent config explain agentPromptPolicy.primary` 可检查实际编译内容、来源与 `session_frozen` 生命周期。完整三角色正文进入既有配置指纹，而非只保存 `coding-v1` 标签。同版本正文变化也拒绝旧会话恢复。要试验新版请建立新会话/数据目录；恢复既有 legacy 会话时继续用 legacy 和原配置。不能静默修改旧会话的指纹来“升级”。

CLI/Web 显式启用新策略时，共享启动器返回 `agentPromptChallenger`，以该策略独立运行，不自动叠加现有冠军或生成 AppliedProof。原冠军状态保留，legacy 启动仍通过原应用门禁。SDK 手动传入 `completionGuidance` 的精确拼接能力保留，但该组合的质量必须另行评估，不能沿用旧冠军证明。

## 做了哪些移植

源码读取于工作区聚合快照 `HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`；这是收集仓库的 SHA，不冒充各上游仓库的独立 revision。DeepSeek 来源为 `deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`。

| 来源 | 实際读过的文件 | 采用 | 适配及边界 |
| --- | --- | --- | --- |
| pi，MIT，Mario Zechner | `pi-main/packages/coding-agent/src/core/system-prompt.ts` | 按可用工具过滤片段、按顺序去重指南的纯函数模式（直接改编） | 改为 Harness 原生工具名；工具输入的顺序和重复不改变稳定正文；不复制 pi 身份、安装目录和技能上下文 |
| Codex，Apache-2.0，OpenAI | `codex-main/codex-rs/core/gpt-5.2-codex_prompt.md`、`core/templates/model_instructions/gpt-5.2-codex_instructions_template.md` | 保护用户已有改动、持续完成任务、以真实检查和结果交付的准则（措辞改编） | 采用版本化 read/edit/write；不假设 GPT 身份或 `apply_patch`、`bash` 等工具存在 |
| OpenCode，MIT | `opencode-dev/packages/opencode/src/session/system.ts`、`session/prompt/gpt.txt`，另审阅 `anthropic.txt`、`plan.txt`、`beast.txt` | 能力感知拼接、要求修改时实际完成编码闭环（措辞改编） | 不采用不存在的 TodoWrite/Task/webfetch；不采用无条件联网、2000 行读取、自动创建配置等规则 |
| Hermes，MIT，NousResearch | `hermes-agent-main/agent/system_prompt.py`、`agent/prompt_builder.py` | 真正运行/验证产物、诊断失败后修复、独立读取与依赖调用区别、稳定前缀（设计及措辞改编） | 不重复注入时间、cwd、记忆、技能或 AGENTS；本项目 ContextPipeline 已负责它们；不复制其 terminal/delegation 接口 |
| DeepSeek Harness，包声明 MIT | `packages/core/system-prompt/src/index.ts`、`packages/preset/persona/src/index.ts` | 模块化、顺序稳定和角色区分（设计参考，无源码复制） | 使用本项目现有配置/ContextPipeline；不新增插件系统 |

复制/改编源的完整许可证与 Codex NOTICE 保存在 `third_party/coding-prompts/`，来源注释在 `packages/agents/src/coding-prompt.ts`。本轮不是拷贝一个其他产品的整体 system prompt。

`claude-code-fork-main/README.md` 自述是 leaked source，本地没有找到开源许可证。本轮只核对该 README，没有读取或移植其实现/提示词；上表中有许可证的来源已足够支持本轮改进。

## 新策略的实际约束

主角色涵盖定位问题、保护已有工作、最小一致改动、版本读写/冲突重读、按平台和项目运行检查、按失败输出修复、权限拒绝处理、秘密保护、非权威工具输出、按证据报告完成。

readonly worker 只调查并交接路径/证据/不确定性；write worker 在隔离工作区实施和检查，集成由父角色与 Harness 负责。工具、权限、委派开关和限额不因文本改变。原生工具仅按能力列出；未知/MCP 工具依赖当次真实 schema，不能猜测。

新文本经项目同一估算器计费；主角色约 1,101、readonly 590、write worker 1,113 个估算 token，均小于当前 system 预留 1,500。实际 provider 的 tokenizer 和加入项目/技能/champion 后的完整请求可能不同，实测 receipt 保存精确字节和 SHA256。

## 验收与效果边界

```bash
pnpm typecheck
pnpm exec vitest run packages/agents/src/coding-prompt.test.ts packages/harness/src/coding-prompt-policy.test.ts apps/cli/src/coding-prompt.integration.test.ts
node scripts/research/coding-prompts-20261008/acceptance.mjs .ci/prompts-v1 coding-v1
node scripts/research/coding-prompts-20261008/acceptance.mjs .ci/prompts-legacy legacy
pnpm test
pnpm test:security
pnpm test:protocol
```

HTTP 验收复用真正 CLI/Web 进程和原生读/改/exec、审批、verification、失败诊断和重启恢复脚本，额外检查每个真实 HTTP 请求安装了精确策略及所有列出的工具有实际 schema。脚本模型的动作是预先设定的；它证明工程通路，而非模型是否会服从提示词或质量提升。

真实效果仍需线下 paired eval：固定相同真实模型/参数、任务和初始工作区、工具/权限/预算，分别用 legacy/coding-v1 在独立数据目录运行；保留实际请求的提示词 SHA、episode、最终 diff、独立验收、耗时与 token/费用。按同一失败聚类观察定位正确率、完整修复率、无损用户改动、测试执行和失败报告，避免只比较“回答像完成了”。正式推广走既有预注册/预算/冠军流程，并绑定实际正文和源码 SHA；不能只给冻结 runner 设置环境变量就宣称完成正式比较。

当前环境没有可用于真实模型实验的凭据。未取得成对真实结果前，模型能力与相对提升为 `NOT_PROVEN`，不宣称等同 Codex/Claude Code，也不自动替换默认策略或改写 N7 归档结论。
