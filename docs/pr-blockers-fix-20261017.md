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

额外复核修正 JWT 的误报边界：候选串仍须保持旧 eyJ 结构防护或能解码为合法 JWT header/claims JSON。正常限定代码符号 namespace.packagecomponent.functionmodule 不会被标记或遮盖；空白 JSON 的有效合成 JWT 仍会被遮盖，二者加入同一回归。


## 真实旧会话验收补充发现

初版修复 b4e6efe4 的定向/安全通过后，用真实 JSONL、HTTP provider、Web service/follow 和两次完整关闭并重建 harness（同一 Node 进程）继续验收，发现并修复：

1. R13-6：可选策略缺失时 policy.changed_on_resume 携带 undefined，JSONL 落盘后会丢字段，内存事件投影却会拒绝，导致旧会话切模型后的 Web 历史报错。所有缺失 hash 明确写 null，新增严格 JSON roundtrip 反例（toStrictEqual，避免普通 toEqual 忽略缺失字段）。
2. R13-7：相同策略漂移在每次 UI 元数据轮询重复落盘；并发/重复四次读取会生成四条相同事件。按完整观察指纹合并同一宿主内的相同报告；失败可重试，回到基线后再漂移仍重新报告。原冻结基线不变，不把报告去重当作接受新策略。
3. R11-3：已保存的 agent ID 在重启后的新注册表中不存在，分支创建被 Runtime 拒绝。只有提供持久化父会话且请求策略与父会话验证后的完整有效策略一致时，才允许继承该 ID；扩大 tools 等策略的请求在创建记录前拒绝。普通未知 agent 仍拒绝。

独立验收固化为 scripts/research/pr-blockers-20261017/legacy-model-switch.mjs 和常规 Web 回归，并纳入真实 Windows 专项。先执行真实 model-a HTTP turn，关闭宿主后把持久化消息转换为升级前不含 model 的格式；重新打开 follow 并选 model-b，再重启，执行真实 model-b 请求和创建分支。断言原已发布前缀逐条不变、旧 tab 观察到选择、新请求模型正确、分支旧/新答案分别保留 a/b 来源。重启可追加真实策略观察事件，不允许改写任何原前缀。原 b4 的 JSON 投影失败、随后 fork 的 unknown-agent 失败与两项 core 反例日志均保留。


## 原生 Windows CI 再发现与修正

原 b4e6efe4 的正式 Windows gate（run 39052571588，job 117453955086）保留 NOT_GREEN 原件，不能拿其本地 9954 通过冒充原生 Windows 全绿。新增两项处理：

- W-1：原双进程锚点测试明确记录 nulls=6454，但 corrupt/torn 断言已通过，表明完整版本可读，同时仍出现不存在的观察。生产写入没有删除 target 的退路，不能臆断具体扫描器或 OS 内部持有者。公有读 API 的 ENOENT 不再直接充当“批准未使用”的依据：已存在的 claim namespace 中先取得同一跨进程锚点锁再重读，已有完整记录的读仍走原直接路径；原本持锁的两个内部调用用 private reader，避免自锁。不存在的 namespace 不创建任何记录，坏文件/权限/锁失败仍具名拒绝。确定性用真实 writer lock 与可见名称缺口复现原返回 null，修正后读到完整已建立记录；原 400 次重写的双进程读断言一项未删。
- W-2：正式 gate 的并发 Web 准入用例触发了其额外 1500ms 看门狗；原测试并无产品 1.5s SLO。存储层本来允许 Windows 有界共享锁恢复，不能用这个常数当成功能契约。注入合法 2000ms 元数据 I/O 即可在本地确定性复现同一个测试失败。改为在真实模型闸门仍关闭、三个订阅持续打开时等待并断言“accepted + inbox 已持久化”，保持原外层 20s 死锁守护；正常/慢存储都测试。该修正不声称识别了原 CI 实例的具体延迟持有者，也不改变产品权限/准入语义或扩大验收为性能证明。

原 Windows 失败、对应本地反例与新增严格验收全部保留；只有后续最终源码首次通过原生 Windows/完整 CI 才满足合入条件，不取消/重跑原失败。


R13-2 调用链补齐：继续用同一基线写入故障检查 Web factory 与 Runtime facade，前者仍在冻结前发布 active，后者根本未冻结配置。两个新独立反例在 76caf6a3 上均失败。普通 Web factory 统一经过修正后的 sessionService；Runtime facade 保留调用者完整受限 agent，以 failed 初始化、冻结宿主基线、最后发布，隐藏 failed 会话仍不发布。另断言 facade 创建后的 read_file-only/deny/maxToolCalls=1 没有被注册表宽策略替换。所有 Web 新会话入口与 draft replacement 的初始化契约保持一致。


W-3：run 39055712482/job 117463135869 的步骤 9 原生回归成功，公开 Windows 回执为 PASS：42 文件、498 passed、0 failed、2 skipped，全部 12 个必跑原生进程用例执行成功。失败在步骤 10：新增用例的压缩记录超出脚本硬编码的单步骤 9 个注释分片上限，脚本在写出有效回执后抛错。原失败仍是失败，不记作 CI 全绿。新增 1000 条高熵名称记录的独立反例确定性复现该异常。修正为小报告发布全部无损分片，大报告保留完整 receipt.json artifact 并发布明确索引，绑定与回执相同的全部记录 SHA-256；不静默截断，也不修改实际 verdict。两种路径及无损重建均回归，后续源码必须重新通过原生 Windows gate。


## 合入前最终复核

固定 clean 源码 `b35bff6487396d5ad78877600ba79fed9b286ea7` 的类型、文档、报告脚本 7、安全 2147、定向 530（Linux 原生 Windows 用例 1 项明确跳过）、完整 suite 与独立旧会话验收均通过；精确数量与源码/工作树状态以 [原始回执](evidence/pr-blockers-fix-20261017/README.md) 为准。修复后的两个 PR head 均已首次通过四类分支工作流和主 CI 十项；真实 Windows 专项执行包含空格/空参数/中文/尾斜杠的实际 batch 启动、持久化故障与旧会话重建。所有原失败保留，包括原生 498 项已通过但注释预算导致报告失败的 76caf6a3。最终回执的大报告保留完整 artifact 并公开绑定哈希索引。

本次保留两条 PR 历史组合合入 main；最终 main 的新 SHA 必须重新完成四工作流及主 CI 十项，结果见 GitHub Checks 和工作区独立最终 CI 报告。本记录不把离线工程验收等同于付费模型质量，不发布 release。


## W-4：首个 main 的真实 UI 失败

#11/#13 的修复 head 均首次通过四类分支工作流及 push/PR 两次十项主 CI 后，已保留历史合入 e39fc6129bdf8998f6f1eeb18a2ca651ac38ba2c，GitHub 确认两 PR merged=true。该 main 的 Linux 安装 UI 在 daily/narrow/capabilities-and-task-filters 失败：按钮已出现并禁用，但脚本立即读取 body 时，pluginInventory/list 仍在返回；原始 run 39096821251/job 117585051194 保留为 NOT_GREEN。CLI 安装产物缺失是前置 UI 步骤失败后未运行 CLI 的后果，不另算作 CLI 产品缺陷。

真实 Chromium 加 350ms 单向 TCP 延迟、不拦截或改写任何 RPC，确定性复现同一 body 断言失败。进一步改成可见 status 等待时，desktop/mobile 通过，narrow 仍失败；浏览器明确记录 status 存在但宽度为零，导航侧栏占据 320px 视口的大部分空间，RPC 已正常成功。不能只增加等待，也不能把 DOM 存在当作内容可见。

修正验收流程：通过真实的收起侧栏按钮进入内容区域，等待 `role=status` 的实际能力说明可见，再断言 Add plugin 禁用；进入自动化任务时重新打开导航、选择后收起。能力场景保留 350ms 延迟，默认 6s 超时不变，没有 sleep、响应替换、去除用例或放宽结果断言。产品 Runtime、工具权限和宿主能力实现不变。桌面/390px/320px 目标场景均已通过；完整日常回归和最终精确 SHA CI 另记原始回执。

原 e39fc612 的所有工作流结束前不推送下一 main；新源码第一次运行 CI，未因路径触发的原生 Windows/普通安装工作流显式首次 dispatch 到同一新 main SHA，保留旧失败。证据及精确驱动哈希见追加归档，不能把旧分支绿结果或原生 Windows 单项通过冒充 e39fc612 全绿。

本地 W-4 结果：三尺寸目标 3/9、完整日常 42/117、Node 导航/连接/延迟 19 项通过、0 失败。详见 [原始失败与浏览器记录](evidence/pr-blockers-ui-capability-20261018/README.md)。这是驱动修正前后对照，未把整树冒充 clean；产品代码与先前 9965/16 的验收源码保持相同。最终新 main 四工作流另验。


## W-5：正式 Windows C7 的验收信号错误

3736aff7 的 UI 安装验收首次在 Linux/Windows 全部成功，原生 Windows/普通安装也成功，W-4 修正得到了实际验证。随后主 CI 的 Windows 正式 gate（run 39098597891/job 117590045045）中，C7 预期 completed 却观察到 cancelled。其余已完成步骤及原始失败均保留，不能记为四工作流全绿。

C7 唯一的外部取消信号来自测试自己的 AbortSignal.timeout(10000)，该用例验证的是命令退出码、文件修改与verification状态区分，并没有产品10秒完成SLO。保留该旧信号、改用合法11秒实际Node命令，即可确定性复现：signal.aborted=true、reason=TimeoutError、outcome=cancelled，以及同一个 completed 断言失败。exec 默认允许60秒。这个反例证明测试把“挂起守护”转换成了真实用户取消；不声称查明原 Windows 实例的特定I/O持有者。

修正仅作用于测试：应完成场景传入未取消的signal，由Vitest独立60秒外层看门狗识别挂起（仓库原默认300秒），不是把 Runtime 的 cancelled 状态改写成 completed。保留正常/11秒真实进程两项、命令exitCode=2/failed=true、文件URI转义、verification=unrun及新turn重置等全部原断言。两项C7与4项既有显式取消回归通过；Linux上2项原生Windows取消用例按既有条件跳过。C7加入真实Windows专项，避免只在长正式gate末尾验证。

产品Runtime、工具执行限制、取消机制和UI实现均未改变。原始10秒失败和真实长命令反例保留，最终新main按四工作流/十项主CI独立验收，不重跑或取消3736aff7失败。

W-5 原生回执进一步要求两项 C7 用例按完整名称各执行一次且 passed；缺失、重复或跳过不能生成 PASS。

W-5 原始CI、11秒真实命令反例及6pass/2skip取消邻接回归见[证据归档](evidence/pr-blockers-status-fixture-20261018/README.md)。产品实现不变，修正源码及最终main的类型/安全/定向/完整CI另按精确SHA记录。


## W-6：原始 Windows 点击超时与已完成视图的对照

adaa847f 的原生Windows回执为503pass/0fail/2skip，14个必跑用例含两项C7各passed一次；正式Windows也成功，同一clean本地完整suite9966pass/16skip，证据保留。其Windows安装UI（run39100358049/job117595340559）在desktop/presentation-controls的Trajectory原生click6秒超时，实际断在“visible/enabled/stable、已滚动、performing click”。

使用只读诊断工作流39101041479从原失败artifact投影daily记录，既不重跑应用也不更改原验收结论。原始失败记录的visibleText已包含Trajectory的Duration/Turns/Calls、实际read_file{path:demo.js}及工具输出，errors、RPC失败和外部请求均为空，socket未关闭。因此有“自动化点击未在6秒内完成”证据，没有“后端/视图完全没有响应”证据；不声称识别原Windows实例的具体调度或渲染延迟来源。

隔离故障探针仅在真实Trajectory click事件处理中阻塞7秒，不替换任何DOM内容或应用/RPC响应，精确复现同一performing click超时，超时后仍出现实际Trajectory工具数据。该探针用于故障对照，不当作普通用户验收；其源码、红绿记录单独归档。

修正测试的等待语义：先确认用量弹层关闭；只对Trajectory/Chat两次原生click允许最多30秒完成，保留真实可见/可用/稳定/命中测试；随后仍以原6秒状态等待要求aria-selected=true，再验证实际工具数据和Chat内容。没有catch超时后继续、force click或静默重试。普通42场景验收不注入故障处理器，也未修改产品UI或Runtime，更不作UI性能SLO证明。

新main须等adaa全部四工作流结束后正常快进推送，再完成四工作流精确SHA首次验收；路径未触发的Windows/普通安装只在新SHA首次dispatch，旧失败保留。

W-6同延迟红绿探针、普通42/117浏览器验收及原始Windows artifact只读投影见[证据归档](evidence/pr-blockers-ui-trajectory-20261018/README.md)。原adaa完整9966/16通过，但原Windows UI仍保持失败；最终新main另验。
