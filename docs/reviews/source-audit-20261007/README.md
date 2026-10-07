# Harness Agent 最新 main 代码审查（2026-10-07）

本轮确认 **21 项代码缺陷、2 项开发依赖漏洞公告命中，另有 2 项文档问题**。21 项代码缺陷都有可重复反例。既有全量测试通过，说明这些反例补出了测试盲区，不能据此认定运行边界、文件合并和 Web 持久化已正确。

本次交付是审查结果、解决办法和验收条件。没有修改产品代码，没有编写或修改 `plan.md`，也没有将以下问题标记为已修复。清单覆盖本轮能确认的问题，不承诺未知缺陷已经全部发现。

## 版本、范围和证据

- 仓库：`https://github.com/ki11a-Conton/harness-agent`，使用原生 Git 获取，未使用 GitHub 连接器。
- 审查版本：`7203a01bf83e8ebe25e0971bb65a7bdeac6d9311`。最终远端复核见 [remote-final-ref.log](evidence/remote-final-ref.log)。
- 隔离工作树：`/workspace/harness-agent-audit-20261007`。原 `/workspace/harness-agent` 的 N8 草稿和未提交修改保留。
- 相对于原工作树 `5340bbcf196f54b283ad4351ef057189a07aca0b`，新增 7 个提交、41 个文件变化，主要涉及 P 候选策略、N7 冻结/容量修订及证据文档。
- 环境：Linux x86_64，Node `v24.19.0`，pnpm `11.21.0`；按照锁文件安装，重新编译后测试。
- 覆盖：24 个 packages 和 CLI/Web 两个应用的现有测试；针对 Runtime 完成/取消、委派和调度、文件合并、授权与沙箱、上下文交接、记忆隔离、MCP 参数、Web HTTP/重启、评测身份/恢复及依赖进行源码追踪与反例检查。各模块测试数量见 [suite-summary.json](evidence/suite-summary.json)。
- 所有新增反例使用临时目录、Scripted/Stub provider 或纯离线校验；**本轮付费 provider 调用为 0**。

主要证据：19 项非 Web 反例见 [repro-results.json](evidence/repro-results.json)，Web 两项见 [web-repro-results.json](evidence/web-repro-results.json)。原始测试 JSON、日志、依赖公告和文档核对结果在 [evidence](evidence/)，字节校验见 [manifest.json](evidence/manifest.json)。

## 已实际执行的验收

| 检查 | 本轮结果 | 证据/解释 |
| --- | --- | --- |
| `pnpm typecheck` | 通过，exit 0 | [typecheck.log](evidence/typecheck.log) |
| 官方 `pnpm test` | 488 个测试文件，8,990 通过、0 失败、12 跳过 | [full-tests.json.gz](evidence/full-tests.json.gz)，[full-tests.log](evidence/full-tests.log) |
| 补充性能测试 | 2 文件、5/5 通过 | [perf-tests.json](evidence/perf-tests.json) |
| 事件存储压力测试 | 50,000 次追加，1/1 通过，约 23.5 秒 | [store-soak-tests.json](evidence/store-soak-tests.json) |
| 官方默认排除的 R97 历史验收 | 补齐两个真实固定版本构建后 77/77 通过 | [r97-driver-with-arms-tests.json](evidence/r97-driver-with-arms-tests.json) |
| N2 默认关闭的离线端到端验收 | 显式启用后 1/1 通过，20 个真实 arm 执行 | [n2-release-e2e-tests.json](evidence/n2-release-e2e-tests.json) |
| E3 历史缺陷反例 | 13/13 通过 | [historical-defects-tests.json](evidence/historical-defects-tests.json) |
| R40 失败取证 | 1 项按设计失败，随后验证取证内容的 1 项通过 | 同上；源码明确要求制造 exit 2，不能计为当前产品 bug |
| N7/P 主实验与 holdout 冻结检查 | 四项全部通过 | `n7-*-freeze.log`、`p-*-freeze.log` |
| N7 真正 runner 的离线 dry run | main 512 arms/256 pairs；holdout 192 arms/96 pairs | [n7-main-dry](evidence/n7-main-dry/)、[n7-holdout-dry](evidence/n7-holdout-dry/)；不是模型质量成绩 |
| N7 用例验证器区分性 | 88/88：未修复代码失败、参考修复通过 | [n7-discrimination.log](evidence/n7-discrimination.log) |
| 本轮新增缺陷反例 | 21/21 复现确认；交付脚本也重跑成功 | 两份 `*-results.json`；**确认缺陷存在，不表示修复验收通过** |
| 依赖审计 | exit 1；3 个包公告命中，合并为 2 个 GHSA | [dependency-audit.json](evidence/dependency-audit.json) |

R97 首次额外运行的四项失败来自缺少两个指定历史构建；补齐 baseline `4f8d98ec65d475844d3ed4b959a3199f84ed5d03`、candidate `2314ce1db40bfa10dc58b0d136e0696450e90cc8` 后全通过。构建使用各自 checkout 的源码和锁文件，没有借用当前 `dist`。初次失败、安装和构建日志也保留在证据中，不列为产品缺陷。

官方 12 项跳过包括 10 项真实 Windows 进程测试、1 项默认关闭的 N2 端到端测试，以及 N5 历史对象检查的互斥分支；N5 的历史对象存在，字节级正向证明实际通过，跳过的是“对象不存在”的另一分支。逐项名称见 [skipped-tests.json](evidence/skipped-tests.json)。N2 随后显式启用并通过；真实 Windows 进程边界仍需 Windows 主机验收。

## 问题索引

P1 表示优先处理的安全边界、数据损坏、错误完成状态或资源泄漏；P2 表示功能、参数契约、隔离条件或研究可重复性缺陷。依赖公告保留其原始严重度，另根据开发依赖暴露面给出修复优先级。

| ID | 优先级 | 问题 |
| --- | --- | --- |
| [B01](#b01) | P2 | 上下文交接的条目总预算计算错误 |
| [B02](#b02) | P2 | 截断目标/约束导致语义丢失 |
| [B03](#b03) | P1 | 子任务新增文件覆盖父工作区并发新增文件 |
| [B04](#b04) | P1 | 二进制补丁经 UTF-8 转换损坏，内容哈希未校验 |
| [B05](#b05) | P2 | 子工作区复制丢失可执行权限，模式变化不进入补丁 |
| [B06](#b06) | P2 | 文件实际合并失败，元数据仍称已合并 |
| [B07](#b07) | P2 | 内存会话存储忽略列表过滤，错误拒绝委派 |
| [B08](#b08) | P2 | 调度拒绝后预留预算泄漏 |
| [B09](#b09) | P1 | 子任务初始化失败泄漏调度槽、工作区和沙箱准入 |
| [B10](#b10) | P1 | 子任务失败测试被报告为通过 |
| [B11](#b11) | P2 | MCP 可选参数被当成必填 |
| [B12](#b12) | P2 | MCP integer 接受小数，数值边界丢失 |
| [B13](#b13) | P1 | N7 非正常退出留下未封存 attempt，无法恢复 |
| [B14](#b14) | P1 | Web 未校验 Host/Origin/JSON Content-Type |
| [B15](#b15) | P1 | Web 重启丢失用户与持久化会话的绑定 |
| [B16](#b16) | P1 | 验证命令绕过 ToolOrchestrator、授权和沙箱 |
| [B17](#b17) | P1 | 审批落盘失败仍释放 allow 等待者 |
| [B18](#b18) | P2 | 共用数据目录时 repository 记忆跨仓库返回 |
| [B19](#b19) | P1 | 验证阶段取消后仍执行命令并报告 verified_complete |
| [B20](#b20) | P2 | 注册一个未启用候选就改变 baseline 执行身份 |
| [B21](#b21) | P1 | 内存会话存储丢弃冻结的子任务工具策略 |
| [B22](#b22) | P2 / 公告 moderate | Vitest/mocker 路径穿越、任意文件读取公告 |
| [B23](#b23) | P2 / 公告 high | source-map-js 事件循环拒绝服务公告 |

### B01

**上下文交接的条目总预算计算错误（P2）。** 位置：[state-handoff.ts:58](../../../packages/agents/src/state-handoff.ts#L58)，特别是第 87 行 `used += 1`。

复现：goal 1 条，constraints/plan/decisions 各 30 条，传 `maxEntries: 20`，得到 4 个 block、**55 条内容**。每轮扣的是一个 block，而下一轮切片却把 `used` 当成条目数。影响已导出的交接 helper；未将它夸大为所有生产委派都走此路径。

解决：按实际纳入的条目累加，全组共享同一个预算；校验预算为有限正整数，必要时另设整体字节预算。

修复后验收：跨多个分组的总条目始终不超过 20；覆盖空组、边界预算和非法选项；测试实际返回内容，而非仅测试 block 数。

### B02

**截断目标/约束导致语义丢失（P2）。** 位置：[state-handoff.ts:71](../../../packages/agents/src/state-handoff.ts#L71)。

复现：目标 `DO NOT DELETE protected-marker`，`maxBlockChars: 8`，下游只收到 `# Goal\nD`。默认 4,000 字符也会截断较长目标/约束，可能丢失否定词、路径或条件。

解决：以完整条目选择上下文；目标和安全约束保留完整语义，超限时返回明确的结构化错误或可检索引用。不能用任意字符切片代表权威目标。

修复后验收：约束完整保留或明确拒绝；不能输出半个否定句、仅标题的 block，或让后续子任务误以为约束不存在。

### B03

**子任务新增文件覆盖父工作区并发新增文件（P1）。** 位置：[workspace-manager.ts:99](../../../packages/harness/src/workspace-manager.ts#L99)、第 216 行。

复现：child 从不存在 `new.txt` 的父目录分出后新增该文件；父目录也新增同名文件。apply 返回 `applied: ["new.txt"], conflicts: []`，父文件由 `parent` 变成 `child`。新增条目没有基线 hash，因此绕过冲突检查。

解决：基线显式记录 `absent` 与 `present(hash)`；新增文件要求父路径仍不存在，并用排他创建或等效原子提交处理检查与写入之间的竞争。相同内容是否允许合并必须有明确规则。

修复后验收：同名并发新增产生冲突，父字节完全不变；加入父方创建目录、删除后重建和检查后并发创建用例。

### B04

**二进制补丁损坏且未校验内容哈希（P1）。** 位置：[workspace-manager.ts:292](../../../packages/harness/src/workspace-manager.ts#L292) 和第 128 行。

复现：child 写入字节 `00fffe8041`，diff 用 UTF-8 读成字符串，apply 写成 `00efbfbdefbfbdefbfbd41`；最终字节哈希与补丁声明的 `contentHash` 不同，仍标记 applied。图片、压缩包及含无效 UTF-8 的文件会被损坏。

解决：补丁传输原始字节，使用明确的 base64/二进制字段与格式版本；写入前核验大小和哈希。若暂时只支持文本，应检测并拒绝二进制，保持父文件不变，明确报告 unsupported。写入后的字节也需匹配声明。

修复后验收：PNG/ZIP、空字节、无效 UTF-8 的完整往返 SHA-256 一致；篡改 `contentHash` 或 payload 被拒绝且无部分写入。

### B05

**子工作区复制丢失可执行权限，模式变化不进入补丁（P2）。** 位置：[workspace-manager.ts:179](../../../packages/harness/src/workspace-manager.ts#L179)、第 204 行。

复现于 POSIX：父 `test.sh` 为 `0755`，child 副本为 `0600`，无法按脚本直接执行。diff 只比较内容 hash，chmod-only 变化也不会被发现。

解决：复制保留许可的文件模式；补丁记录模式和模式变化，合并时遵守批准的权限位策略；不得因此放开 setuid/setgid 或符号链接边界。

修复后验收：0755 脚本在 child 保留执行位；新脚本和 chmod-only 变化正确合并；真实 POSIX 验收，Windows 单独说明适用范围。

### B06

**物理合并失败，元数据仍称已合并（P2）。** 位置：[child-merge.ts:39](../../../packages/harness/src/child-merge.ts#L39)、第 47 行。

复现：child result 同时携带 `workspacePatch` 与 `changedArtifacts: [{path: "a.txt"}]`，父方已修改 `a.txt`。物理结果 `applied: []`、存在冲突，父 `filesChanged` 和返回 `metadata.mergedPaths` 却新增 `a.txt`。当前流程先接纳 child 元数据，再补充冲突而不撤回错误接纳。

解决：存在物理补丁时，仅将 `physical.applied` 对应的 child 文件变更加入父状态；保持父方原有追踪，不能为消除误报删掉父方已记录的路径。发现/建议等非文件内容独立合并。

修复后验收：conflict/skipped 路径不能被新标记为已合并；父原有 `filesChanged` 不丢；普通成功与无物理补丁的旧契约继续成立。

### B07

**内存会话存储忽略列表过滤，错误拒绝委派（P2）。** 位置：[mem-stores.ts:32](../../../packages/harness/src/mem-stores.ts#L32)。

复现：仅创建一个 root，`listSessions({parentId: root.id})` 就返回这个 root。本不应有 active child 的委派，在 `maxActiveChildren: 1` 时被拒绝为已有一个活动子任务。还会把其他 root 的会话计入当前树。

解决：MemSessionStore 实现与持久化 store 一致的 `parentId`/`status` 过滤，并在共同契约测试中验证各实现。

修复后验收：无 child 的 root 返回空列表；两个 root 的活动子任务计数互不影响；组合状态过滤正确，真正达到限制时仍拒绝。

### B08

**调度拒绝后预留预算泄漏（P2）。** 位置：[scheduler.ts:213](../../../packages/agents/src/scheduler.ts#L213)、第 223 行。

复现：根预算工具 100、token 1，请求工具预留 10。token 检查拒绝后运行/排队数均为 0，工具 remaining 却从 80 变 70。反复失败可耗尽整棵任务树的可用额度。

解决：先校验全部预算维度，再原子提交预留；或统一事务式回滚，覆盖拒绝、排队取消和初始化异常。

修复后验收：任何未入队/未运行的拒绝不改变预留计数；并发拒绝和取消后额度守恒，真实用量不被退款。

### B09

**子任务初始化失败泄漏资源（P1）。** 位置：[delegator.ts:309](../../../packages/agents/src/delegator.ts#L309)，主 `try/finally` 从第 335 行开始。

复现：真实 scheduler/工作区流程已建立后，向 context seed 的 `appendMessage` 注入磁盘失败；调用抛出，但 scheduler 仍有 running 条目、child 仍 active、工作区未 dispose、其 root 仍处于沙箱允许集合。`seedContext` 和启动事件在清理保护范围之外。

解决：从获取槽位/创建 child 起就覆盖整个初始化和运行生命周期；统一释放 scheduler、解绑运行状态、撤销 workspace 准入、删除临时副本及标记失败/取消。清理自身的异常需保留可观察证据。

修复后验收：context 写入和事件持久化分别失败时均无残留 running、active child 或准入路径；覆盖 writable/read-only 子任务；随后委派可正常启动。

### B10

**失败测试被报告为通过（P1）。** 位置：[delegator.ts:726](../../../packages/agents/src/delegator.ts#L726)，上游记录见 [turn-helpers.ts:150](../../../packages/core/src/runtime/turn-helpers.ts#L150)。

复现：真实 Runtime 发出 `exec: npm test`，工具返回 failed/exit 1；working failures 记录 `exec: exit code 1`，child `testsRun` 却为 `{description: "npm test", passed: true}`。`testsRun` 分类记录被无条件转换为成功。

解决：测试结果来源于实际工具结果/退出码/验证事件，携带稳定 call/event ref；记录命令与结果分开。未执行、拒绝、超时及状态未知不能标为 passed；父合并保留这些事实。

修复后验收：exit 1 必须 false；deny/未执行不能 true；同命令先失败后成功可区分尝试；模型仅声称成功不能覆盖验证失败。

### B11

**MCP 可选参数被当成必填（P2）。** 位置：[json-schema-zod.ts:26](../../../packages/mcp/src/json-schema-zod.ts#L26)、第 55 行。

复现：properties 为 name/string、count/integer，required 仅包含 name；合法 `{name: "sample"}` 因缺失 count 被拒绝。`requiredSet` 已计算但没有用于 `.optional()`。

解决：每个属性根据 required 集合决定 optional，并递归处理嵌套对象；保留 additionalProperties 的既有严格/透传策略。

修复后验收：省略可选参数可调用远端；省略必填参数拒绝；嵌套及 required 缺省情况按 JSON Schema 契约执行。

### B12

**MCP integer 接受小数，数值边界丢失（P2）。** 位置：[json-schema-zod.ts:36](../../../packages/mcp/src/json-schema-zod.ts#L36)。

复现：count 声明 integer/minimum 1，`{count: 0.5}` 被成功解析；integer 与 number 都返回裸 `z.number()`。远端可能拒绝请求或错误执行。

解决：integer 使用 `.int()`，落实声明的数值范围；若无法正确覆盖支持的 Schema 子集，采用权威 Schema 验证器或明确拒绝不支持的结构，避免静默弱化约束。

修复后验收：小数、越界和非数值拒绝，合法整数通过；number 的合法小数仍允许；添加端到端 MCP dispatch 参数断言。

### B13

**N7 硬退出后无法恢复未封存 attempt（P1）。** 位置：[n7-paired-campaign.mjs:74](../../../scripts/research/agent-next7-20261006/n7-paired-campaign.mjs#L74)、第 86、128–142 行。

复现：runner 在开始就创建 attempt，但 artifact index 在结束时才写。硬退出留下目录后，resume 对所有 attempt 先调用 `verifyIndex`，因缺失 `artifact-index.json` 抛出 ENOENT，无法到达现有请求/预算/journal 的恢复流程。本轮离线反例调用的就是 resume 使用的校验函数，没有制造一次付费崩溃实验。

解决：明确 OPEN/SEALED attempt 状态；持久化开始信息和逐 arm 检查点。恢复时分别核验已封存证据和开放 attempt 的请求/journal/预算记录；对于无法确认的消耗保持拒绝执行。不能简单跳过完整性检查、重置预算或重放已计费请求。

修复后验收：离线受控进程在 arm 写入后、最终封存前被 SIGKILL；重启可恢复已确认结果，已完成 arm 不重跑、预算不归零；损坏 journal 和 unknown 消耗在首个新请求前拒绝。

### B14

**Web Host/Origin/JSON Content-Type 边界缺失（P1）。** 位置：[server.ts:180](../../../apps/web/src/server.ts#L180)、第 499 行。

复现使用真正的 `apps/web/dist/main.js`：恶意 Host 的 GET `/api/sessions` 返回 200 并暴露会话；foreign Origin、`Sec-Fetch-Site: cross-site`、`Content-Type: text/plain` 的 POST `/api/messages` 返回 200，且外来文本实际进入 history。监听 loopback 本身不能检查浏览器页面来源。

解决：校验明确的 Host/端口允许集合、Origin 和状态修改请求的 CSRF/认证边界；JSON 接口要求正确 Content-Type。代理部署需显式配置可信代理与外部源，不得默认信任 forwarded headers；SSE/history 与修改接口一致保护。

修复后验收：恶意 Host、foreign Origin、simple-request text/plain 均被拒绝；合法页面的发送、取消、审批与 SSE 仍正常。随后在真实浏览器增加跨站请求/DNS rebinding 验收。本轮证明了服务端接受这些请求，**未声称完成真实浏览器 DNS 攻击利用**。

### B15

**Web 重启丢失会话绑定（P1）。** 位置：[bindings.ts:15](../../../apps/web/src/bindings.ts#L15)、[main.ts:56](../../../apps/web/src/main.ts#L56)。

复现：启动生产 Web，固定 from 发送消息，session 文件已持久化；退出并以相同 HARNESS_DATA_DIR 启动第二进程。sessions 变空，history 返回 `sessionId: null, messages: []`；相同 from 的后续消息创建另一 session。持久化的旧消息仍在文件中，丢的是访问/路由绑定。

解决：持久化 Web 用户/命名空间到 sessionId 的映射，启动时校验并恢复；Gateway 的 `sessionByUser` 必须使用同一映射或可恢复的权威 session 元数据。用户只能恢复所属会话。

修复后验收：真实进程重启后相同 from 的 sessionId 和消息保持，下一条消息接着旧会话；不同用户隔离；损坏/缺失绑定产生明确错误或受控修复，不伪装成空历史。

### B16

**验证命令绕过授权与沙箱（P1，优先修复）。** 位置：[task-verifier.ts:193](../../../packages/tools/src/verification/task-verifier.ts#L193)、第 200 行；生产装配见 [compose-verification.ts:43](../../../packages/harness/src/compose/compose-verification.ts#L43)。

复现使用真正 createHarness、默认 verifier 和实际 AgentDefinition 的 exec deny：配置文件系统 read-only、进程 confinement strong，TaskSpec 验证命令仍通过直接 ProcessExecutor 在 workspace 外创建文件；`tool.started` 为 0，turn 返回 `completed / verified_complete`。不是用不存在的 HarnessConfig.permissions 字段模拟授权，脚本先设置 AgentDefinition 策略并断言 Runtime 实际采用。

解决：验证命令接入经过授权的 ToolOrchestrator/执行适配层，绑定当前 session 的 PermissionEngine、SandboxManager、进程/网络/文件边界、预算与取消信号。Core 仅依赖接口，不能引入 tools/UI 依赖。实际强隔离不可用时必须先拒绝，不能换成直接 host 执行。Benchmark 对同一 verifier 的使用也需检查。

修复后验收：exec deny、只读、越界路径、禁止网络及强隔离不可用均不产生副作用；预批准的合法验证可完成，执行日志有真实边界和证据；不能仅改变完成标记而保留不受约束的进程执行。

### B17

**审批落盘失败仍释放 allow（P1）。** 位置：[approval.ts:242](../../../packages/security/src/approval.ts#L242)，第 246 行才 persist。

复现：真实 DurableApprovalStore 已保存 pending，在其临时写入路径创建目录导致 EISDIR。`resolve(allow)` 抛出落盘异常，但等待者已经获得 allow；磁盘仍为 pending 1/decisions 0，内存 pending 为 0。授权执行和审计持久化脱节。

解决：先构造待提交决策并原子持久化，成功后再提交内存状态和释放等待者；失败不授予许可、不更新授权缓存。若承诺掉电安全，还应落实文件及目录 fsync、恢复规则。

修复后验收：真实 write/rename 失败不释放 allow，受保护工具执行次数 0；重启后 pending/decision 一致；重复审批与超时竞争不会双重执行。

### B18

**repository 记忆跨仓库返回（P2，有明确配置条件）。** 位置：[create-harness.ts:375](../../../packages/harness/src/create-harness.ts#L375)、第 377 行；检索的 scope 类型过滤见 [retrieval.ts:204](../../../packages/memory/src/retrieval.ts#L204)。

复现：两个不同 Git remote 的项目 A/B 共用一个配置的数据目录，开启 memory。A 写 repository scope 内容后，B 的真实 memoryBridge.retrieve 返回 A 的条目。当前仅传递 `scope: repository` 层级，计算出的 repository identity 没有参与存储/查询归属。

解决：记忆条目与查询绑定可信的 repositoryId/workspaceId，进一步统一 agent/task-family 等归属；或按稳定身份分库。global 共享必须显式，历史无归属内容迁移/隔离而非默认为所有仓库可见。

修复后验收：同一数据根目录下不同仓库的 JSONL/SQLite 均隔离；同一仓库的 clone/worktree 根据预期共享；现有 session 归属安全测试继续通过。

### B19

**验证阶段取消后仍执行并报告完成（P1）。** 位置：[model-call-controller.ts:311](../../../packages/core/src/runtime/model-call-controller.ts#L311)、第 351–355 行；verifier 的进程请求缺少 signal。

复现：在真实 TaskVerifier `onStep(started)` 中中止 turn signal，随后命令仍创建文件，Runtime 返回 `completed / verified_complete`。此时不是执行完毕后才点取消，而是命令启动之前信号已 aborted。

解决：将同一个 AbortSignal/期限传到 verification 和 ProcessExecutor，取消子进程并回收；长 await 后及成功终态提交前再次检查取消。取消不得形成 verification.completed 或伪造 passed 证据。

修复后验收：启动前取消零执行；执行中取消终止/回收进程且无后续命令；只有一个 cancelled 终态，不能与 completed 并存；取消失败时明确记录未确认副作用。

### B20

**未启用候选改变 baseline 身份（P2，影响研究恢复）。** 位置：[arm-factory.ts:452](../../../packages/evaluation/src/arm-factory.ts#L452)、第 489 行。

复现：baseline 无安装 guidance，`promptAdditionsDigest: null`。只从 resolved snapshot 删除新注册但 OFF 的 `verified_completion_gate_v1` 记录，digest 就从 `00d2c921…f33e1fdc` 变成此前的 `ee589c7e…23d7895`，实际 baseline 配置和提示词相同。仓库 P 完成记录也说明了随之发生的 N7 ARM_DIGEST_DRIFT 与重新冻结。

解决：执行身份只绑定真实安装的配置/策略/提示词；完整候选注册表作为单独 inventory digest 保存。格式迁移版本化，保留旧证据，不回写旧结果身份。保留当前对真正运行差异的 fail-closed 检查。

修复后验收：仅添加 inactive 候选时 execution digest 不变；启用策略、版本或提示词改变时 digest 必变；旧记录不能被新身份冒用，resume 对真正差异仍拒绝。

### B21

**内存会话存储丢弃冻结的工具策略（P1）。** 位置：[mem-stores.ts:56](../../../packages/harness/src/mem-stores.ts#L56)，第 57 行 load 返回 undefined。

复现：真实 Runtime/MemSessionStore，基础 agent 有 exec，Delegator child 明确 `toolPolicy.allow: ["read_file"]`、writable false。child 的冻结策略没有保存，运行时回落到基础 agent，仍 dispatch 一次禁止的 exec。反例用捕获型 orchestrator，不执行该命令，不声称已造成 host 损害。

解决：内存 store 实现进程内 snapshot 保存/读取和防调用方修改的 clone，契约与 durable store 一致；预期存在冻结策略时，丢失 snapshot 不能静默扩大权限。生产默认 read-only agent 的预限制不替代这个公开委派契约。

修复后验收：child 仅允许 read_file，模型请求 exec 时 dispatch 次数 0；不同 child 的策略不串；冻结后修改基础 agent/返回快照不会扩大 child 权限。

### B22

**Vitest/mocker 已知文件读取漏洞公告命中（P2；公告 moderate）。** `pnpm-lock.yaml` 中 Vitest、`@vitest/mocker` 为 4.1.10，命中 [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。两个包对应同一公告，不能计成两种漏洞。

解决：Vitest、coverage-v8 和配套 mocker 对齐到已修补版本，公告要求至少 4.1.11；提交 lock 更新并复核解析树。

修复后验收：`pnpm audit --json` 不再命中该 GHSA；typecheck、全量测试及 coverage 初始化正常。当前公告命中位于开发依赖，本轮未尝试实际路径穿越利用，未证明生产 Web 暴露该漏洞。

### B23

**source-map-js 拒绝服务公告命中（P2；公告 high）。** 锁定 1.2.1，来自 Vite/PostCSS/magicast 开发链，命中 [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)：恶意 indexed source map offsets 可阻塞事件循环。

解决：更新相应上游依赖解析，必要时使用仓库统一 override 到已修补的 1.2.2 或更高兼容版本，并提交锁文件。

修复后验收：锁解析无受影响版本，该 GHSA 不再出现；构建、source map/coverage 和全量测试正常。命中为开发依赖，未将公告严重度直接等同于生产远程攻击面。

## 两项文档问题

**D01，P3：P 任务入口链接越出仓库。** [AGENT-P-20261006.md:3](../../../tasks/AGENT-P-20261006.md#L3) 使用 `../../plan.md` 和 `../../plan(20261006-191434).md`，解析到仓库父目录，文件不存在。应改成 `../plan…`。验收对所有任务文档的相对链接按其所在目录解析，仓库内目标存在。此处仅给建议，未修改用户要求暂缓的计划文件。

**D02，P2：历史 unchanged 字段与后来更新混用。** [unchanged-originals.json](../../evidence/agent-next7-20261006/execution/acceptance/unchanged-originals.json) 的 baseline 为 `d92d727689b9a2dc20bd09ea44348403f539def6`。其中 guidance、main prereg、holdout prereg 的 hash 与该 baseline 均不同，但三项仍 `unchanged: true`。`updatedInLaterRounds` 已披露更新原因，因此这是时间/范围字段含义不一致，不能据此断言证据伪造。

解决：保留最初验收包为不可变历史证据；后续重新冻结/预算修订写入单独 amendment receipt，明确源 SHA、变更路径、旧/新 hash 及新执行结果。若继续在同一文件表达，字段需区分 `unchangedSinceBaseline` 与 `amendedLater`。验收 `unchanged:true` 的条目逐字节匹配其声明 baseline，后续更新不沿用旧全量测试结论。实际 Git blob 对比见 [documentation-findings.json](evidence/documentation-findings.json)。

## 修复取舍与验收要求

优先解决 B16/B17/B21 的授权边界和 B14 的 Web 来源边界；接着处理 B03/B04 的文件损坏、B10/B19 的错误完成证据、B09 的生命周期、B15 的会话恢复及 B13 的实验恢复。其他 P2 项适合分别提交，避免用一次大规模重构修这些确定性问题。

Runtime 冻结规则仍适用。这些已复现的 correctness/security/integrity 问题属于仓库允许的维护理由；策略模型质量仍应走候选与成对评测流程。修复无需扩大 Core 的依赖方向。

每项修复应先把对应反例转换为符合预期的回归测试，证明旧版本失败、修复版本通过，再运行相关单元/集成/安全测试以及 `pnpm typecheck`、`pnpm test`。B03/B04/B15/B17 应保留真实文件/进程故障验收，B16/B19/B21 应验证实际执行次数与边界，不能仅 mock 最终 status。

目前未完成、也未声称完成的验收：真实 Windows 进程执行、真实浏览器视觉/按键全流程与攻击利用、付费 N7/P 模型质量 campaign、修复后回归验收。已有 Web 的 22 项测试和本轮真实 HTTP 进程测试通过/复现，不能替代这些范围。

## 重跑方式

在该审查版本及其工作树根目录执行，先依据锁文件安装并 build。以下两份脚本是**旧版本反例**：exit 0 的含义是成功复现缺陷，修复后会因旧的缺陷断言不成立而失败，必须改成正确行为的回归测试再验收。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
node scripts/research/source-audit-20261007/reproduce.mjs
node scripts/research/source-audit-20261007/web-reproduce.mjs
corepack pnpm test
corepack pnpm audit --json
```

反例默认输出到被忽略的 `.ci/source-audit-20261007/`，可用 `HARNESS_SOURCE_AUDIT_OUT` 指定输出目录；输出记录执行 checkout 的实际 Git HEAD，不写入认证凭据。临时项目、标记文件和 Web 子进程在退出时清理。

额外测试与离线冻结检查：

```bash
corepack pnpm exec vitest run packages/events/src/event-store.soak.test.ts
corepack pnpm exec vitest run packages/events/src/event-store.perf.test.ts packages/harness/src/perf-suite.perf.test.ts
node scripts/research/agent-next7-20261006/freeze-n7-preregistration.mjs --check
node scripts/research/agent-next7-20261006/freeze-n7-holdout-preregistration.mjs --check
node scripts/research/agent-p-20261006/freeze-p-preregistration.mjs --check
node scripts/research/agent-p-20261006/freeze-p-holdout-preregistration.mjs --check
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --dry --experiment main --out .ci/source-audit-20261007/n7-main
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --dry --experiment holdout --out .ci/source-audit-20261007/n7-holdout
```

R97 需先分别构建上面两个固定 SHA 的 worktree，再设置 `R97_ARM_BASELINE_DIR`、`R97_ARM_CANDIDATE_DIR` 后运行 `packages/evaluation/src/r97-driver-closed-loop.test.ts`。N2 使用 `N2_RUN_RELEASE_E2E=1` 运行 `apps/cli/src/n2-release-cli-forward.test.ts`。R40 单独运行预期非零退出，不应并入产品测试失败计数。
