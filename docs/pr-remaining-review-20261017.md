# 剩余 PR 代码审查与安全合入（20261017）

本轮按用户追加授权审查全部 4 个开放 PR。先固定每个 head，再与已完成 UI/Windows
修正的 main 3b3f4e9f 合并检查；候选实现只在独立本地 worktree 中运行。确认可合入
#12、#14；#11、#13 存在独立复现的阻塞，不进入 main，也不把其已有绿测试当作充分验收。

| PR | 固定 head | 决定 | 与当前修复的关系 |
| --- | --- | --- | --- |
| #11 会话内切模型 | 44f3f51f6ecfdc0da653a6e76a4149d032729961 | 阻塞，保留开放 | 新增操作；现有 main 仍拒绝已开始会话改模型。自动合并保留 U6/U12 展示与 #8 前缀校验，但旧消息兼容和故障原子性仍失败 |
| #12 全仓审查材料 | 47797191b74f48fcf4e23210f9a7ff8613885e72 | 可合入 | 历史材料；补正原基线标签，明确 155 条发现不是最新 main 的已确认 bug 清单，修正控制字符 |
| #13 十一项 P1 修复 | 139a6d92fcf2f4c1ea8f13ce5aae920702d74f9f | 阻塞，保留开放 | 与 U1–U13 不是同一修复。缓存必须走真实稳定别名 owner，不能删掉已有前缀校验来换性能 |
| #14 仓库卫生 | ff39ebb895d5f105cb72113b79937a6c8d4480d3 | 可合入 | 11 个目录夹具文件保持原字节、补 LF 属性，删除两项无运行引用的生成物。证据保留提案只是文档，不执行历史改写或 LFS 迁移 |

## 确认的阻塞

| ID | 级别 | 代码与触发 | 独立复现 | 修正与再验收要求 |
| --- | --- | --- | --- | --- |
| R11-1 | P1 | apps/web/src/deepseek/projections.ts:210 的 assistant 来源仍回退到可变 session.model。升级前的 Message 不含 model 字段，setSessionModel 却允许更换 | 真实历史投影：切换后原记录的 source provider/model 改变，已持有前缀不再相等；新增不变性回归失败 | 在切换前持久化旧消息的不可变来源，或以可靠的初始模型与切换事件回放。验证升级前历史、旧 tab follow、刷新、分支和新请求均一致 |
| R11-2 | P1 | packages/core/src/runtime/runtime.ts:1962 的 setSessionModel 先保存 effectiveAgent，再更新 session 行；owner 的选择事件又是第三次写 | 注入第二次写失败：调用 reject、session 行仍旧模型，但 runtime.getSessionAgent 已返回新模型 | 使用现有存储能力形成可恢复的原子切换协议，覆盖每个写入阶段的失败/重启。不能只靠回滚在正常进程中碰巧成功 |
| R13-1 | P1 | packages/evaluation/src/gate-evidence-v2.ts:420 替换脱敏器时丢弃旧 JWT 广覆盖；共享模式要求 payload 以 eyJ 开头 | 有效 HS256 合成 JWT 的 JSON claims 含空白，payload 以 ewog 开头。原 main 对同一 JWT 脱敏通过，PR 原文泄漏，回归失败；实际生成的 Ed25519 私钥也仅遮住 PEM 头，完整密钥正文仍在输出中 | 共享分类与原防护取并集，私钥必须遮盖完整块；覆盖多种合法 JSON 编码，并检查完整落盘日志、摘要和错误面，不只测一个函数 |
| R13-2 | P1 | packages/harness/src/create-harness.ts:741 的 sessionService.create 在 runtime.createSession 已发布 active 后才写 p27 配置基线 | 注入基线保存失败：create reject，但 listSessions 仍列出 active 会话且无基线，回归失败 | 所有必需快照成功之前保持 failed 占位，最后才发布 active；失败和重启后都不得出现无基线可运行会话，并保留分支初始化语义 |
| R13-3 | P1，原性能缺陷未闭合 | apps/web/src/deepseek/events.ts:61 的缓存 tail read 经过 owners.listEvents；有稳定别名时仍全读/映射物理日志再过滤 | 实际 composition：普通无别名 owner 对照通过；先实际 selectModel 形成稳定别名后，空闲轮询连续 4 次全物理重放，≤1 的同一断言失败 | 从实际 owner 层提供有界尾读或可靠 watermark。保持已存在的 retired 前缀完整性检查；用物理读取计数/字节数测长日志、别名、审批/问答恢复 |
| R13-4 | P1，原漂移缺陷未闭合 | runtime.retryPolicyHashOf 固定只取前 8 次 decide，未涵盖配置中的更大尝试上限 | maxAttempts=16、只改 askOn：第 16 次真实行为从 fail_safe 变 ask，但重启不产生漂移事件；原 8 项通过，新增尾部回归失败 | 对 RecoveryPolicy 的完整规范值做稳定身份，或覆盖实际 cap 的边界行为。验证大上限、per-kind cap、askOn 和延迟，不能用固定 8 个样本代表完整策略 |
| R13-5 | P2，新增跨平台验收失败 | apps/cli/src/argv-launch.ts:89 的模拟 win32 测试在 Linux 实际创建小写 pnpm.cmd，而 PATHEXT 查找大写 .CMD | 原 PR 的两个新增测试文件各 2 项失败，未改它们的断言/fixture；原 GitHub Ubuntu job 117361958362 的 17 条注释也明确记录相同四项失败，head 139a6d92 | 修正可移植 fixture/平台 seam，并执行真实 Windows 启动及含空格路径。不能把 Linux 失败归为旧 Windows 环境问题 |

## 验收与边界

- #11 候选类型检查通过；7 个相关文件 102 通过、2 个独立反例失败，整体 NOT_GREEN。
- #13 候选类型检查通过；12 个定向文件 187 通过、6 失败，其中 2 个新产品反例、4 个 PR 自带用例。另有稳定别名实测失败、无别名对照通过，以及 retry cap=16 的尾部策略漂移反例失败（该文件原 8 项通过）；独立脱敏文件的 JWT/完整私钥材料两项均失败；相邻 owner/会话/活动/模型快照和安全矩阵 84 项通过，均保留原日志。
- #12 manifest 的 11,937 条路径无重复，与报告固定 SHA 的 git 跟踪清单逐项一致；不声称重新证明全部 155 条发现。
- #14 的 11 个目录夹具与原 main 完全相同，catalog SHA256 db48365207d017eee3191aaafd4ac4d611b19fcf23a27ddb419029453bd32d54。实际 Git checkout 的 core.autocrlf=true 配对验收也已完成：旧 main 的 catalog 摘要因 CRLF 转换失配，修正后全部 11 文件仍逐字节等于 Git blob（这不是原生 Windows OS 验收声明）。被删 .pyc/旧分享 zip 没有运行引用；原始历史证据不删除、不重编码。
- 安全组合 499bc4e9 的 apps/packages/CI/构建配置与完整通过的 f2788ee5 相同；scripts 仅删除生成的 .pyc。安全 2146 和 docs:verify 通过，完整 clean suite 的新回执在归档时补入。
- 合成 JWT 和运行时随机生成的私钥只用于本地确定性测试，没有外部账号权限，不是真实用户凭据。无 GitHub 连接器、子 agent、付费模型调用或 release。本轮不把修复建议自动扩大为 Runtime 重写。

最终 main 必须保留 #12/#14 的原 head 为祖先，并排除 #11/#13；推送前确认旧 main
四工作流均已结束，推送后按精确新 SHA 复核主 CI 十项与 Windows/两类安装工作流。
原失败不重跑、不取消，最终报告另存在工作区，避免归档再次改变已验收 SHA。


## 复算反例

在独立空 worktree 检出安全基底 `499bc4e9d9ccd61aece9d71d8acfa8cede06c68b`，
合并对应固定 PR head（`git merge --no-ff --no-commit <head>`）。再从最终 main
的 `docs/evidence/pr-review-20261017/` 应用对应 `pr11-independent-probes.diff`
或 `pr13-independent-probes.diff`；#13 另将 `pr13-review-redaction.test.ts` 复制到
`packages/evaluation/src/`。不要对用户有未提交改动的目录执行这些动作。

安装依赖并 `pnpm typecheck` 后，分别执行：

- #11：`pnpm exec vitest run apps/web/src/deepseek/projections.test.ts packages/core/src/runtime/effective-config.test.ts`，两个新增不变性反例预期失败。
- #13 脱敏/创建：`pnpm exec vitest run packages/evaluation/src/pr13-review-redaction.test.ts packages/harness/src/config-drift-create-session.test.ts`，预期暴露 JWT、私钥正文和 active 占位问题。
- #13 真实别名：`pnpm exec vitest run apps/web/src/deepseek/composition.integration.test.ts -t 'review PR13'`，无别名对照预期通过、有别名预期失败。
- #13 策略尾部：`pnpm exec vitest run packages/core/src/runtime/runtime-policy-drift.test.ts`，原八项预期通过、cap=16 的新项预期失败。
- Linux 启动器失败来自 PR 自带 `argv-launch.test.ts`、`release-artifacts-gate-launch.test.ts`，无需添加 reviewer probe；原 GitHub 注释可独立核对。

上述是拒绝合并的可复算失败，不是期望主分支持续保留的红测试。修正后必须
让这些不变性与真实 owner 预算通过，再完整验收新的组合源码；不能删断言过关。


安全合入源码 `499bc4e9d9ccd61aece9d71d8acfa8cede06c68b` 的 clean 完整 suite 实测 9874 通过、15 既有跳过、
0 失败（594 文件通过、2 跳过），运行前后 HEAD/工作树不变。此前 main
3b3f4e9f 的四工作流和十项主 CI 均已首次通过，原件见
[审查证据](evidence/pr-review-20261017/README.md)。最终合并提交仍需独立 CI。
