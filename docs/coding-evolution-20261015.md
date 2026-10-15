# Coding agent C1–C7 实施

本轮依据 [研究报告](coding-agent-research-20261015.md)、[规格](../plan(20261015-104912).md) 与 [实施合同](../tasks/CODING-EVOLUTION-20261015.md)，在 `feat/coding-evolution-20261015` 实施。产品基线为 `2a141309`。没有发布 release，也没有凭离线 fixture 宣称新策略优于真实模型上的 v1。

| 项目 | 已实现 | 验收方法 |
| --- | --- | --- |
| C1 | 标准 OpenAI / DeepSeek usage 方言、缓存观测来源与冲突、缺失与零分开；运行指标统计覆盖率；Web 将总输入转换成浏览器缓存分类协议，避免重复加算 | 实际 HTTP/SSE → Runtime → JSONL 关闭重开 → Web；执行原封未改的浏览器用量函数，验证 200 输入含 128 缓存、20 输出的总量为 220 |
| C2 | 24 个真实历史任务，另加真实第二仓库的 2 项 Python 种子缺陷任务（含 tracked/untracked 用户改动保护），固定父版本、修复版本和独立测试 hash；导出的 `runCodingBenchmarkCase` 接现有 EvalRunner/EvalOutcome，检查验收文件未被修改 | 48 次真实 checkout/install/build；修复侧全绿；19 项旧侧断言失败、5 项经审查的缺失新增接口编译失败；任务21原验收无区分能力，换成真正新增的关闭竞态测试再跑两侧 |
| C3 | 独立 `coding-v2`，从实际工具定义贡献指引；三角色生成、确定顺序、冲突指引拒绝、分类恢复与真实验收；CLI/Web/SDK 共用选择器及 drift gate | 实际请求捕获、角色能力和预算、持久化恢复拒绝策略漂移；CI 在 Ubuntu/Windows 增加 v2 的真实 CLI/Web HTTP 验收 |
| C4 | 原有 MultiStageCompactor 上的结构化摘要和宿主回调 hook；保留目标、失败、未完成事项；失败/超时/丢关键事实回退；当前会话检索及已有项目记忆的按需检索 | 原有压缩/信任/恢复回归；实际 Runtime 调用搜索工具；外会话隔离、删除生效、脱敏和输出字节预算；回调源码及声明实现 ID 进入配置身份 |
| C5 | 可移植 Tree-sitter WASM 的 TS/JS/TSX/Python/Rust/Go AST 标签；相关代码候选关系图与排序；默认词法搜索不变 | 30 条人工标注查询、真实路径/行号、修改立即失效、忽略规则、symlink 竞态和拒绝读取、文件/时间/输出预算 |
| C6 | 可选的实际 wire 前缀观测：系统/工具/消息 hash、字节与公共前缀；跨临时客户端并按端点、模型、会话隔离 | 实际 HTTP 请求保持动态事实；换客户端仍可比较；LRU/异常隔离；日志不含正文、工具参数、原始会话 ID 或认证数据 |
| C7 | “编码状态”面板展示实际任务/验收/命令退出/文件/diff/计划；接原有取消、继续和 steer；不确定提交显式重试同一 requestId；编码文件的 VS Code URI | 真浏览器、真实生产 Web/Runtime、真实审批及磁盘变更；桌面和窄屏；断网提交与同 ID 重试；非零退出不伪装验收通过 |

## 开启与兼容性

构建仍使用 `pnpm install --frozen-lockfile`、`pnpm build`。在项目根目录，按既有文档配置模型端点、模型名和密钥，然后选择需要的策略。以下变量也适用于 CLI；Web 的通常启动命令仍是 `node apps/web/dist/main.js`，访问 `http://127.0.0.1:8787`。

```sh
export HARNESS_AGENT_PROMPT=coding-v2
export HARNESS_CONTEXT_SUMMARY=structured-v1
export HARNESS_MEMORY=1
export HARNESS_MEMORY_SEARCH=1
# 可选，仅记录 hash/长度；字节前缀不是提供商缓存命中率
export HARNESS_CACHE_DIAGNOSTICS=1
node apps/web/dist/main.js
```

PowerShell 使用 `$env:HARNESS_AGENT_PROMPT="coding-v2"` 等同名环境变量。项目记忆需要既有持久化目录配置；`HARNESS_MEMORY_SEARCH` 单独开启不绕过 `HARNESS_MEMORY`。已有会话的策略/摘要/工具配置受冻结配置身份约束；为新组合创建新会话，不能静默换旧会话的策略。未选择时仍沿用原有默认，不把尚未完成真实模型对照的候选推广成默认。

SDK：`agentPromptPolicy: createCodingPromptPolicy("coding-v2")`（从 `@ar/harness` 导入）；`contextSummary: { mode: "structured-v1" }`；`memory: { enabled: true, onDemand: true }`。外部摘要可用 `mode: "external-v1"`、`implementationId`、带 AbortSignal 的 `summarize` 回调及预算。宿主必须管理这类回调的模型费用和取消；`implementationId` 必须覆盖闭包内模型/配置身份，回调文本本身也会被 hash。没有隐式付费摘要调用。

工具仍走既有 ToolOrchestrator/PermissionEngine/SandboxManager。`symbol_search` 的 `mode: "syntax"` 才使用 AST；`repo_map` 的 `query` 和 `maxCodeTokens` 控制额外相关代码部分。工具报告 `semantic: false`：这是语法标签和候选引用，不是 LSP 语义解析，也没有把通用 embedding 冒充代码 embedding。WASM 和 ignore 库固定版本，许可在 `third_party/coding-index`。

`Usage.inputTokens`/`outputTokens` 现在可以缺失。SDK 消费者应判断已测值，不能将缺失当零；部分 usage 不足以证明完整费用。缓存写入未知时保持未知。Web wire 的 `inputTokens` 是未缓存分类，`totalTokens` 则来自后端总输入加输出；不可拿 wire 分类当成原生总输入做费用汇总。

## 实测中修复的问题

除了计划中的链路问题，还修复了实际 Web 终端的锁等待：创建终端等待人类审批时占用会话锁，事件流若同步读取同一会话摘要，会阻断下一条审批。摘要改为单个后台扫描并将结果送回同一有界通知队列，审批继续走原有拥有者和 correlation 校验。摘要内部故障仍会令该事件 generation 报错，不吞掉损坏。窄屏审批期间隐藏仍挂载的终端侧栏，回答后恢复，避免覆盖 Allow/Reject。

新增状态面板只在收到真实 verification 事件时显示验收通过；模型结束和命令退出零均不等同验收成功。编辑器入口是浏览器发出的已编码 VS Code 文件 URI，服务器没有伪装已经启动本地编辑器。

## 证据和限度

最终固定源码验收记录在 [实施进度](../plan(20261015-114843).md) 与 `docs/evidence/coding-evolution-20261015`。早期未提交/混合源码运行和失败记录保留，与最终记录分开。

C2 的主集是单项目历史回放，补充集是第二仓库的 Python 种子缺陷；两者都不能当作未见过的多仓库真实模型成功率。真实模型配对评测仍需遵守已有 paid admission、相同预算/权限、三次配对、交替顺序、独立验收和原始事件/费用/延迟证据；本轮付费调用为 0，质量收益、缓存收益、默认推广均为 NOT_PROVEN。Windows 验证以实际 CI 结果为准，Linux 和响应式浏览器不能替代真实 Windows/手机。

原有插件管理并不完整，受限宿主若不能提供强隔离，PTY 会明确拒绝；C7 没有改成无隔离执行，也不把这些边界称为全量上游 UI 功能已齐备。

跨平台复查发现并修复了事件 generation 关闭时未等待后台摘要 IO 的问题；现在关闭会发出取消并等待已开始的元数据操作完成。安装包构建也修复了对 `LICENSE-MIT` 的漏识别，保留真实依赖许可，不绕过缺失许可检查。索引总字节/标签预算现在在加入每个文件前检查，精确边界不再多收一个文件。

检索测量工具：`node scripts/research/coding-evolution-20261015/retrieval-measurement.mjs <output-dir>`。它记录分语言 gold/调用方、recall@5、原有词法与新语法路径的冷/热延迟和进程内存。数据集仅 60 文件/4200 字节，不能推导大型仓库 SLO，也不能把检索召回当作模型修复成功。

缓存计量收尾还覆盖了三类边界：估算/未知来源不进入实测命中率；后续累计 footer 修正输入总量后重新校验缓存子集；同一帧的标准缓存数与 DeepSeek miss 数互相矛盾时报告冲突。后续真实零观测仍可恢复，相关回归与正式费用门禁合计 70 项通过。

编辑器 URI 的补充验收覆盖了字面 `%20`、空格和 `#` 同时出现在真实文件名的情形：百分号先编码为 `%25`，URI 解码后必须等于磁盘文件名。该实际 Runtime 回归先红后绿，相关 Web 回归 43 项通过。

最终 CI 还发现完整测试的基础设施截止时间不够：`release gate coverage` 在恰好 600 秒收到 SIGTERM，报告尚未生成；本地同源码完整套件需约 18–22 分钟。完整 test/coverage 门禁和 release artifacts 的同类命令统一为 45 分钟上限，低于 CI job 的 60 分钟限制；其他门禁保持 10 分钟。覆盖率阈值、测试集合、失败出口和费用保护均未降低。82 项门禁、隔离和产物相关回归通过。
