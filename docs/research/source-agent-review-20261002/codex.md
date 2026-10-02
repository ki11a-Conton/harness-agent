# Codex 源码对照研究（只读，2026-10-02）

## 快照、许可与范围

- 收集仓库 HEAD：`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，提交日期 2026-08-18，`codex-main` 子树：`d1891e779f69fce33fb7866a3e4e2120d94af15c`。这里没有可验证的上游 Codex commit，因此不把目录名、收集日期或者收集仓库的 SHA 写成上游版本。
- `codex-rs/Cargo.toml` 声明 `0.0.0`，`codex-cli/package.json` 声明 `0.0.0-dev`，不能据此声称某个稳定版本。
- 根 `LICENSE`：Apache-2.0；`NOTICE`：OpenAI copyright 2025，另列 Ratatui MIT 派生代码。推荐独立实现机制；若复制代码，保留适用的 Apache 许可、版权和 NOTICE，第三方部分单独核查。
- Harness 对照 HEAD：`acf8dcc394de6c6efefed52602e49014b372f372`。已读根 `AGENTS.md` 及 TOOL-001、CTX-001/002、LOOP-001。Runtime Freeze 的例外要求确定性缺陷/安全问题/真实性能证据；下列 C1/C2 有直接复现，C3 仅为策略候选。
- 本次没有修改生产源码、安装上游依赖、运行上游安装脚本或使用 GitHub 连接器。下文“直接复现”仅运行当前 Harness 已有 dist 导出的函数和短命 Node 子进程，不把静态阅读当作通过上游测试。

## 核心调用链覆盖

| 层 | Codex 实际路径、符号与观察 | 对照 Harness |
| --- | --- | --- |
| entry | `codex-rs/cli/src/main.rs:979` `main`，1041 的 exec 分派调用 `codex_exec::run_main`；交互分派最终调用 2410 的 `codex_tui::run_main` | CLI 装配 runtime/model/tools，不向 Core 引入 provider/UI 依赖 |
| loop | `codex-rs/core/src/session/mod.rs:456` `Session::spawn`；`session/turn.rs:153` `run_turn`，1325 `run_sampling_request`，2154 `try_run_sampling_request`；2198 的 `FuturesOrdered` 加 2105 `drain_in_flight` 将完成项按提交顺序进入历史 | `packages/core/src/runtime/runtime.ts`，`model-call-controller.ts`、`tool-call-controller.ts`，已有快照、预算、取消、工具结果顺序和 verification gate |
| tool/permission | `core/src/tools/parallel.rs:153` 支持并行的 handler 取读锁，其余取写锁；`tools/orchestrator.rs:135` `ToolOrchestrator::run` 从 approval requirement 构造 sandbox attempt；`tools/sandboxing.rs:70` `with_cached_approval` 只缓存 ApprovedForSession | `ToolCallController.executeToolCalls` 已有有界并行、资源冲突和串行变更；`ToolOrchestrator` 12 步 pipeline；`DefaultGrantCache` 已有 session/one_tool/one_call、权限差量、撤销 |
| context | `core/src/compact.rs:240` `run_compact_task_inner_impl`，309-317 在压缩请求仍超窗时删除最旧历史再尝试；`context_manager/normalize.rs:21` `ensure_call_outputs_present` 补 aborted output；`tools/context.rs:116` `McpToolOutput::response_payload` 对结构化内容也统一生成 model payload 再截断 | `ContextPipeline` 已有预算、压缩、保护事实校验；`ContextController` 自动摘要；`ModelCallController` 572-578 reactive compaction 重建快照；最近已优化消息字段计量和线性裁剪 |
| knowledge/verification | `core/src/agents_md.rs:52` `load_project_instructions`、99 `read_agents_md`、164 `agents_md_paths` 加 provenance 和总字节预算；`context/world_state/agents_md.rs:52` `render_diff` 不重复注入相同指令；`session/turn.rs:484` `run_turn_stop_hooks` 可阻止停机并继续循环 | `HierarchicalInstructionDiscovery` 已有层级/provenance/限额；`model-call-controller.ts:309` verification gate，322-349 有界失败重试；不应改成仅以模型 stop 作为完成 |

已阅读的上游相关测试：`codex-rs/core/src/tools/context_tests.rs`（尤其 137 `mcp_tool_output_response_item_truncates_large_structured_content`）、`codex-rs/utils/output-truncation/src/truncate_tests.rs`（尤其 95 UTF-8）、`codex-rs/apply-patch/src/seek_sequence.rs` 内嵌测试、`codex-rs/apply-patch/tests/suite/scenarios.rs` 与 fixtures、`codex-rs/core/tests/suite/tool_parallelism.rs`、`core/src/agents_md_tests.rs`。另定位到 `core/tests/suite/{compact,approvals}.rs`，只将其记为相关测试入口，不声称全量运行或逐例审查。

## C1：工具对象输出绕过预算与安全渲染——确定性缺陷/安全问题，优先

**借鉴机制**：Codex `core/src/tools/context.rs:116-145` 的 `McpToolOutput::response_payload` 把结构化结果转成模型实际看到的 payload 后，统一 `truncate_function_output_payload`；专门的对象大输出反例在 `core/src/tools/context_tests.rs:137-173`。这不是建议移植 Rust 类型系统，而是将边界绑定在实际模型文本，而非仅绑定某一种工具输出类型。

**Harness 已有能力及缺口**：

- `packages/core/src/runtime/context-controller.ts:474` `renderToolResultForContext` 已有脱敏、超预算 artifact、head/tail、sha256、注入扫描和安全事件。
- 但 482 的 `if (budget === undefined || typeof raw !== "string") return renderToolResult(result)` 同时跳过所有这些步骤。`turn-helpers.ts:61-71` 随后直接 `JSON.stringify` 对象。
- 正常内置 `exec` 就返回对象：`packages/tools/src/tools/exec.ts:192-205` 的 `{exitCode,stdout,stderr,truncated,durationMs,...}`。`read_file` 等结构化工具也不能默认视为已过边界。
- `packages/tools/src/orchestrator.ts:625-631` 的 `applyOutputLimit` 同样只限制 string。这里应区分执行结果契约/资源限制与模型文本限制，不能为修复随意把所有对象改为字符串，导致调用方失去结构化数据。
- 即使是 string，如果没有配置 `toolOutputBudget` 但配置了 redactor/detector，482 也把安全规则直接短路。

**直接复现，当前代码结果**：使用假的 `SECRET_SENTINEL` 与 `ATTACK_SENTINEL`（不是凭证），配置 `maxInlineBytes:32`，redactor 用计数器并替换 sentinel，detector 在出现 attack 时返回 hasInjection。

| 输入 | redactor 调用 | detector 调用 | 模型返回字节 | secret 可见 | attack 可见 |
| --- | ---: | ---: | ---: | --- | --- |
| string + 配置预算 | 1 | 1 | 93（blocked notice） | 否 | 否 |
| `{stdout:text,stderr:"",exitCode:0}` + 同样预算 | 0 | 0 | 10070 | 是 | 是 |
| string + 未配置预算、仍配置安全 hooks | 0 | 0 | 31 | 是 | 是 |

第二个输入包含约 10 KB stdout；对象路径没有任何安全事件。字符串控制组则各调用一次安全 hook 并发出两条安全事件。复现是同一控制器的实际方法调用，不是复制条件表达式做假测试。

**做什么/怎么做**：在已有 ContextController 内，先得到模型原本会看到的文本（包括对象序列化、错误状态文本），再执行脱敏/预算/注入扫描。预算只决定内联或 artifact，安全 hook 的生效不依赖预算是否启用。保留工具返回的原始结构、status、exitCode、证据与元数据；以实际模型文本作为安全边界。不要绕过 Orchestrator/Sandbox，不重写 loop。

**怎么验收**：

1. 对同一 string 与对象内容，脱敏和 detector 都执行，模型消息与内联 preview 不含 fake secret；对象中的注入标记被 withheld，并有 `security.injection_denied`、关联 toolCallId。没有预算但启用 hook 的情况也要通过。
2. 对真实 `exec` 返回对象做 Runtime/FakeModel 集成：超预算 stdout/stderr 不得原样塞入下一次模型请求，stderr 的末尾诊断仍可在 preview 或可读 artifact 找到。
3. artifact 保存**脱敏后的完整模型输出**（不要把原始秘密写入 artifact）；原始脱敏内容完整，字节数与 SHA-256 等于登记的 artifact；对象 stdout/stderr、状态字段、原始结果结构不被截断替换。注入内容是否仅在受信任审计 artifact 保留必须沿用当前策略并在测试中明确，不能再通过模型读取而无审查。
4. small object、string、失败状态、null/undefined、不能正常 JSON 序列化的值遵守原有错误/降级契约；不能以 metadata/evidence 或输出形状绕过安全流程。
5. 检查返回 preview 大小采用明确的 UTF-8 预算和固定元数据开销，不能把 `maxInlineBytes` 的旧“是否落盘阈值”未经说明改成整个 payload 的绝对硬顶。

## C2：进程与 Orchestrator 字节截断使用字符索引，分块解码损坏 UTF-8——独立确定性缺陷

**借鉴机制**：`codex-rs/utils/string/src/truncate.rs:86-123` 的 `split_string` 通过 `char_indices`、`len_utf8` 在字节预算内切完整字符。`utils/output-truncation/src/truncate_tests.rs:95-99` 对 emoji 明确测试。`utils/output-truncation/src/lib.rs:12-28` 对预览加 omission notice；其 warning/marker 是额外内容，不能盲目声称 Codex 的整个返回文本绝不超过 body budget。

**Harness 当前路径**：

- `packages/tools/src/process/executor.ts:387-398`，共享 `collect` 中 `data.toString()` 后用 `text.slice(0, cap)`；cap 是字节数，slice 是 UTF-16 code unit 数。
- 566-577 的 sandbox execution 收集路径复制了同一逻辑，修复只落在 collect 还不够。
- `packages/tools/src/orchestrator.ts:625-631` 比较 `Buffer.byteLength`，但切片仍用 `slice(0,maxBytes)`，有同样缺陷。
- `executor.test.ts:90-99` 现有截断测试只用 ASCII x，检查 length；`orchestrator.test.ts:398-417` 只检查 string length 较短和 marker，无 UTF-8 字节反例。

**直接复现，当前代码结果**：

1. `ProcessExecutor.runArgv({file:process.execPath,args:["-e","process.stdout.write('中'.repeat(100))"],cwd,maxOutputBytes:8})` 返回 8 个“中”，24 UTF-8 字节，`truncated:true`，突破 8 字节上限。
2. 子进程先写 emoji 的前两字节 `[0xf0,0x9f]`，100 ms 后写剩余 `[0x98,0x80]`，预算 100，返回 `���` 而不是 `😀`。这是流 chunk 边界解码问题，不是只修最终 slice 就能解决。
3. 当前 `ToolOrchestrator.prototype.applyOutputLimit` 对 100 个“中”及 cap 8 的结果主体也是 24 字节（不包括 marker）。

**做什么/怎么做**：保留每流独立输出上限、cancel/timeout/kill-tree/status 契约，在收集器用 byte-aware 限制与增量 UTF-8 解码（Node 原生 StringDecoder 或有限 Buffer 前缀），遇到预算落在字符中间时退到完整字符边界。流式 onOutput 也需增量解码，避免把 replacement 字符传播到事件；最终 incomplete/invalid UTF-8 的既有替代语义需明确。优先抽小的共享纯收集/解码 helper，覆盖 collect 与 sandbox 路径，不能因此改动安全后端或命令解释逻辑。

**怎么验收**：

1. 中文/emoji/混合 ASCII 的 cap 在 0、1、2、3、4、8 及边界±1，stdout/stderr 主体 `Buffer.byteLength <= cap`，不产生因截断造成的 lone surrogate/新 replacement 字符；marker 单独明确计量。
2. 对合法 UTF-8 每个可能字节分割位置，组合后的 collection 与 streaming events 无损；执行/exit status 与 cap 下方对照相同。使用 barrier/受控 fake stream 验收，不依赖长 sleep。
3. 超预算继续 drain，不能因停止监听产生 deadlock；stdout/stderr 独立、truncated 标志正确；事件回调异常仍按既有 nonFatal 语义。
4. legacy shell、runArgv、sandbox prepared launch 都覆盖相同收集规则；Windows 分支用平台合同验证，实际 Linux 运行不能声称 Windows 实机通过。
5. cancel、timeout、tree-kill、sandbox deny、安全 provenance 与既有 verification 测试通过；内存只保留预算内数据，无为截断复制全部巨大输出。

## C3：上下文定位补丁策略——只列候选，先做失败聚类再 paired eval

Codex `apply-patch/src/seek_sequence.rs:12-114` 按 exact→rstrip→trim→Unicode 标点归一化寻找上下文；`core/src/tools/handlers/apply_patch.rs:380-428` 先 parse/verify 环境文件系统，再进入工具 runtime。多 hunk 与多文件 fixture 说明它能把局部修改表达为上下文补丁。

Harness 并非没有精确编辑：`packages/tools/src/tools/edit-file.ts:45-50` 已有 first/occurrence/all 和 line range；`packages/tools/src/edit.ts:58` `applyReplace` 对 missing anchor 明确失败，且 `packages/agents/src/workspace-isolation.ts` 已有独立的 child workspace patch 与内容 hash 冲突检测。不能把这两种 patch 混为一谈，也不能声称必须添加一个大而全 patch Runtime。

可评估的缺口是模型遇到 `anchor not found`、多个相同片段或 CRLF 时，是否稳定选择重新读取局部上下文、加入唯一锚点/显式 occurrence 再编辑，而非整文件重写或持续猜测。先收集真实失败轨迹；在现有 agent prompt/skill、`packages/evaluation/src/arm-factory.ts` 的真实实验 arm 接口做一个精确上下文编辑 challenger，以原有 read_file/grep_search/edit_file 完成。

验收包含重复函数体、旧锚点已变、缩进敏感 Python、Unicode 引号确实改变语义、CRLF、并发外部更新。只有唯一可信定位时改目标；不唯一时 reread/失败，未授权路径仍被 sandbox 拒绝。对同模型/预算/种子/初始树做 paired eval，记录成功率、错误目标编辑次数、编辑失败后的模型/tool 回合、token/latency；没有失败聚类和成对证据就不推广。Codex 的宽松匹配返回首个结果，**不直接复制**为 Harness 默认行为；多文件 apply_hunks 逐文件执行且有 partial delta，也**不声称它是事务原子编辑**。

## 无需重复引入或不宜直接迁移

- 并发：Harness 已有有界读并行、结果按调用顺序、资源冲突检测、取消合成结算。Codex 全局 RwLock 可作审查参照；把 shell 广泛设成并行会改变安全/时序约束，没有测量依据不改。
- 审批缓存：Harness DefaultGrantCache 有能力身份、scope、撤销和严格匹配，已经比简单 ApprovedForSession map 更完整；不能为了少弹窗放松授权。
- 压缩：Harness 最近修复计量遗漏、linear history trim 和 protected facts，已有 reactive compaction。不能重复宣称缺失，也不能把 Codex 任意补 aborted output 的机制用于掩盖 Harness 既有内部协议损坏 fail-closed。
- 输出：Harness 已有 string 输出 head/tail + artifact/hash，问题是对象/预算缺省分支短路，不是需要再加一套全新输出管理服务。
- completion：Harness verification gate 及证据完整性规则必须保留；Codex stop hook 只能作为继续工作的机制参照，不能把模型 stop 等价成验收成功。

## 供总计划选择

C1 和 C2 有小而具体的确定性反例，满足 Runtime Freeze 维护例外，可安排 RED→局部修复→GREEN→相关安全/集成回归。二者应分开验收：对象边界修复不能掩盖 byte/stream 缺陷，UTF-8 修复也不能代替对象脱敏。C3 只作为失败聚类后才允许立项的 agent strategy challenger，不作为本轮必做 Runtime 重构。
