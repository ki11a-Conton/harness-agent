# 第一代模型链路源码对比与修复

审查基线为 `22d97d860cfa1001df578b1193b3bc4c8ee1bce1`。本页报告模型 provider、工具调用接收、上下文、重试取消及交叉审查发现的模型事件和技能入口接线；CLI/Web 的完整交互和发布由其他验收记录覆盖。源码文件及 SHA-256 见 [来源清单](gen1-model-source-manifest.json)。

## 实际源码对比

开源收集仓库 `HARNESS-SRC-FORK` 固定 SHA 为 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`；DeepSeek Harness 固定 SHA 为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。

| 来源与具体文件 | 从实现看到的优势 | Harness 已有机制 | 此次采用与后续差距 |
| --- | --- | --- | --- |
| pi：`packages/ai/src/utils/overflow.ts`、`utils/provider-retry.ts`（MIT） | 明确的跨供应商 overflow 模式；先排除 rate limit；SDK 重试取消可中断 | `decideModelRetry`、provider 内部退避、一次 reactive compact、checkpoint | 实际移植精确模式子集及排除规则；修复 Runtime 忽略安全重试标志和取消信号。复用既有 Timer，不引入第二套重试状态机 |
| pi：`packages/ai/src/api/openai-completions.ts`、`openai-responses.ts`、`anthropic-messages.ts`（MIT） | 在 provider 层选择 wire 参数、协议与工具消息转换；`maxTokensField` 是明确兼容能力 | OpenAI-compatible Chat Completions；DeepSeek `reasoning_content` 持久化回传；实际序列化后的工具协议检查 | 小型 `chatCompatibility` 能力表；只自动识别真实 OpenAI host 的已知 reasoning 家族。此次没有引入整个 pi SDK，Responses 和 Anthropic 原生协议尚未实现 |
| pi：`packages/coding-agent/src/core/compaction/compaction.ts`（MIT） | 最新真实 usage 加后续消息估算；保留最近 token 尾部；有精确文件与错误的摘要模板 | 多阶段压缩、WorkingState 摘要、protected facts 检查、完整 transcript、重新构建 step、rehydration | 已有机制覆盖相同职责，不再复制一套压缩器；按真实 usage 校准启发式估算仍是后续有价值的能力，需要带来源的压力案例及配对测量 |
| Codex：`codex-rs/core/src/client.rs`、`compact.rs`（Apache-2.0） | Responses/WebSocket 的会话路由状态、401 凭据刷新；typed `ContextWindowExceeded` 与 abort/budget 分开处理 | provider 错误分类、冻结请求身份、取消、上下文重建、session/checkpoint 恢复、工具副作用对账 | 学习明确区分错误类别；未复制 OpenAI OAuth、订阅认证、WebSocket 接口。当前版本依赖 API key 与 Chat Completions，不能声称兼容 Codex 订阅协议 |
| Hermes：`agent/context_compressor.py`、`agent/transports/chat_completions.py`、`run_agent.py`（MIT） | 分开保护 head/tail、auxiliary summary 的预算与失败；输出预留从实际 window 扣除；不同 provider 参数不混用 | 固定 output 预留、只读 TokenEstimator seam、摘要保护及失败可见事件 | 保留现有边界；provider 兼容能力显式声明。不复制其 7,000 行压缩器和模型路由分支；成熟多供应商模型目录、thinking/effort 旋钮和可选付费摘要是后续范围 |
| OpenCode：`packages/opencode/src/session/retry.ts`、`overflow.ts`（MIT） | typed context overflow 与普通 retry 分开；按照模型的输入/输出额度求 usable budget | 模型能力预算、provider Retry-After、Runtime 统一恢复策略 | 修复同类错误分类缺陷；未照搬其 Effect/session 状态体系或营销分支 |
| DeepSeek Harness：`packages/llm/llm-pi-ai/src/adapter.ts`、`packages/llm/llm/src/retry-policy.ts`（MIT） | 单请求冻结 model/profile/credential；pi 多协议目录；验证 thinking effort；SDK `maxRetries: 0` 防止两层隐形重试 | 不可变 step/config 指纹、单 provider 请求策略、显式 provider retry 事件及 native tools 权限链 | 保持现有分层；此次没有集成 DeepSeek 的 Cordis 服务注册体系。多协议目录与 provider-native replay bridge 是独立后续项目 |

只有 pi overflow 的模式子集实际采用了源代码，许可证与出处保留在 `third_party/coding-prompts/pi-MIT.txt` 以及对应源码注释。其他行表示读过源码后比较实现与适配成本，不表示代码已全部集成。未使用无许可证的泄漏材料。

## 可复现缺陷与修复

| 编号 | 基线实际行为 | 修复与验收 |
| --- | --- | --- |
| M1 请求模型与执行模型分裂 | `OpenAICompatibleProvider.createClient` 忽略 `ModelRef.modelId`；显式选择 `requested-model` 却发送 `environment-model` | precedence 为 call config > 固定 constructor identity > ModelRef > env/default。保留冻结 constructor 身份；实际 HTTP body 验证三种优先级 |
| M2 无关错误触发上下文压缩 | `/context\|token\|maximum\|.../` 将 invalid token、TPM 限制和不支持的 max_tokens 都判作 overflow | pi 精确模式子集 + provider status/kind 排除；6 个负例、6 个真正 overflow 正例、混合 rate-limit 例。错误不再写摘要/改变上下文 |
| M3 不安全模型请求被 Runtime 重发 | provider 已标记 `retryable:false` / `safeToRetry:false`，Runtime 仍按 generic recovery 重试；stream reset 实际 3 次，HTTP auth 实际 2 次 | 两个 false 标志都 fail closed；仅已确认 overflow 允许一次缩小上下文后的请求。400/401/403 实际调用数各为 1，工具执行为 0 |
| M4 取消必须等退避结束 | 30 秒 Runtime retry backoff 没有传 signal；取消后不推进 ManualTimer 无法结束 | 复用 `sleep(timer,delay,signal)`，下一次 model.started 前检查 abort。计时器不推进也能得到 cancelled，模型仍只调用 1 次，无残留 timer |
| M5 官方 reasoning 参数不兼容 | SDK 显式 output cap 一律序列化成 max_tokens；显式 temperature 对已知 reasoning 模型未经校验发送 | 精确官方 host + `o1/o3/o4`、`gpt-5` 家族选择 `max_completion_tokens`；排除 `-chat` 家族；不支持的显式 temperature 在本地报错，提示移除。代理字段使用显式 capability override，不猜未知供应商 |

M1–M4 最小 RED：2 文件，25 项中 **15 failed / 10 passed**。M5 从基线 `openai.ts` 的原始 Git blob 构造一次性 before fixture，运行相同实际序列化请求反例，**14 failed / 5 passed**；运行后删除了 before fixture，未回退共享工作区。

修复后模型与相关 Runtime、协议、host identity 回归：**23 文件、380 passed、0 failed、0 skipped**。新增测试为：

- `packages/model/src/gen1-model-identity.regressions.test.ts`
- `packages/model/src/gen1-reasoning-compatibility.regressions.test.ts`
- `packages/core/src/runtime/gen1-model-recovery.regressions.test.ts`

证据原始文件由执行器直接产生，待总体归档时纳入发布验收：`/tmp/gen1-model-red.{json,log}`、`/tmp/gen1-reasoning-red.{json,log}`、`/tmp/gen1-model-green-final.{json,log}`。`pnpm exec tsc -b packages/model packages/core` 通过；第一轮完整 `pnpm typecheck` 通过，第二轮其他并行功能尚未完成时有 CLI 类型错误，不能将该轮根检查报告为通过。最终发布必须重新通过固定源码的全套检查。

## 已支持的行为与诚实边界

真实 Harness → AppServer → SDK 的交叉验收另发现两处事件接线缺陷：`model.completed` 缺少 mapper 读取的答案 `text/final`，导致 SDK 的 `finalResponse` 为空；`text_delta` 只累积文本而未发 `model.delta`，导致 SDK 没有逐字输出。现在 completion 携带与持久 assistant 消息一致的文本，真实文本 chunk 发 `{kind: "text", text}`，thinking delta 仍只在内部回传。部分文本后收到不可安全重试的错误只保留 partial delta，没有虚构 completion/final；SDK/mapper 的真实集成验收另由会话记录覆盖。

交叉审查也发现 CLI 的 `agent skills` 接的是固定空数组，虽然 Runtime 已使用实际 `AR_SKILL_ROOTS`。新增 `Harness.listSkills()` 复用同一个 `discoverSkills` 和已有 `FileSkillLoader`，RPC 接受异步技能列表，CLI 接真实 Harness。技能仍按需加载正文；列举元数据没有绕过原来的 injection、secret 或 required-tools 正文准入。`AR_SKILL_ROOTS` 维持既有分号分隔格式和既有 roots 默认值，没有新策略。

两项接线最小 RED 为 **24 项、22 passed / 2 failed**：实际 CLI `(none)` 和 Runtime 缺少 partial text delta；恶意正文原准入反例已通过。修复后相关 Runtime、provider termination、实际 CLI 技能与 Harness 技能集成回归 **5 文件、119 passed / 0 failed / 0 skipped**。证据为 `/tmp/gen1-skills-stream-red-final.{json,log}` 与 `/tmp/gen1-skills-stream-green.{json,log}`；该补验与上面的 M1–M5 模型回归分开计数。

当前 Runtime 默认请求没有 temperature=0.2，也没有自动设置 maxTokens。M5 处理的是 SDK 明确请求这些参数的场景；不存在默认采样值强行发送导致官方模型拒绝的问题。生成参数缺省时，HTTP body 保持原样。

`api.openai.com` 必须是解析后的精确 host；`api.openai.com.evil.example`、DeepSeek 和自定义代理不会自动变成 OpenAI reasoning 模式。`gpt-5-chat-latest` 不被当作 reasoning 模型。当前没有 reasoning_effort API，因此 gpt-5.1/5.2 在某些非推理模式可接受 temperature 的细分条件暂不自动推测；默认省略 temperature，显式不兼容选项本地可见报错。

自定义 SDK 部署若确认代理只接受新字段，可声明：

```ts
new OpenAICompatibleProvider({
  apiKey,
  baseUrl,
  modelId,
  chatCompatibility: {
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
  },
});
```

错误类型、未知字段、无效 capability 值在发出请求前拒绝；不静默丢弃 output cap。DeepSeek thinking content 回传、协议终止证据、不完整工具意图禁止执行，以及原有 SDK 请求参数缺省行为均由旧回归覆盖。

以下差距仍存在，不能宣传为已经集成所有来源 agent 的功能：Anthropic Messages/原生 thinking block、OpenAI Responses/订阅 OAuth、多模态附件、自动 provider model 目录、可选择 thinking effort、使用实际 tokenizer/usage 校准的自适应预算、可选 LLM summarizer。这些是协议或策略扩展，需要各自真实 endpoint 配对验收；离线 fixture 只证明工程协议路径，不证明模型任务质量。

第一代全面检查至少覆盖：全部 `packages/model`、本页新增回归、`provider-termination`、`turn-helpers.protocol`、`runtime`、`step-snapshot`、`world-snapshot`、CLI/Web coding host 与 benchmark provider identity、安全/协议全套，以及真实 Windows 的取消和工具调用路径。

## 固定源码 CI 补验：保留结构化 overflow 合同

真实 Linux/Windows CI 和本地全量检查发现两项 `active-user-context.test.ts` 失败：provider 明确发送 `errorInfo("CONTEXT_OVERFLOW", "context full")`，精确文本模式未识别这个正式 ErrorCode，导致 reactive compact 未发生、turn 失败。这是本轮精确分类遗漏结构化合同的回归，不是模型任务质量失败。修复在既有认证、rate-limit kind/status、参数错误排除之后直接识别 `info.code === "CONTEXT_OVERFLOW"`；没有扩宽 context/token 文本 regex，没有新增 provider kind 或改变 unsafe partial-stream 重放规则。

隔离补修工作区基于 `0fe418975b225fb7e7d2ea2d17031f7b0d54542f`。最小 RED 为 2 文件、58 项中 6 FAIL/52 PASS，包含 CI 两项 user-anchor/reactive-tail 失败和四项结构化合同失败；修复后同组 58 PASS/0 FAIL/0 SKIP。新增 12 项覆盖 typed code 的空/普通消息、HTTP 400、矛盾的 401/403/429/rate-limit/参数错误排除、非 typed 的 context-full 不误判，以及最多一次改变上下文的恢复。

原 M1–M5 模型/Runtime/协议/身份组加 active-user-context 的补验为 **24 文件、416 PASS/0 FAIL/0 SKIP**；`pnpm exec tsc -b packages/core` 通过。原件为 `/tmp/gen1-typed-overflow-red.{json,log}`、`/tmp/gen1-typed-overflow-green.{json,log}`、`/tmp/gen1-typed-overflow-model-green.{json,log}`、`/tmp/gen1-typed-overflow-typecheck.log`。这些是补修工作树的定向证据；最终新提交的全量和远端双平台 CI 仍需重新执行，不将此前失败记录改写成 PASS。
