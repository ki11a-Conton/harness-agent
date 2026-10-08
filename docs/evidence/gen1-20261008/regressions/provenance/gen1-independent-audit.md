# 第一代独立正确性与安全复审

审查基线为 `22d97d860cfa1001df578b1193b3bc4c8ee1bce1`，在独立 worktree 完成。本文覆盖权限/沙箱/审批、持久 store、预算并发，以及其他实现分支的交叉审查；完整产品的固定源码、Windows、CLI/Web、portable 与 CI 验收由主报告另行绑定。没有付费模型调用，也不把这些工程证据称为模型质量晋升。

## 确定复现及修复

| 编号 | 真实触发与影响 | 最终修复与反例验收 |
| --- | --- | --- |
| A1 | `SqliteRuntimeStore.append` 接受声明 ABI=999 的事件，也不为缺省事件写入 ABI；list/stream 会照常回放。JSONL 与 SQLite 的恢复合同不同 | 新写入补当前 ABI；未知声明在事务前拒绝；list/stream 拒绝无版本或未来版本的已存事件。tool-outcome 不会一边拒绝事件一边提交 transcript |
| A2 | JSONLAskUserStore 首次 read 的 EISDIR/暂时 I/O 失败将 `loaded` 提前置 true。恢复正确文件后仍读取空缓存，随后 create 覆盖旧 pending question | 成功读完才发布 cache；失败可重试；共享首次加载 promise。同实例首次 list/create 并发也不能先写入新问题再被旧加载覆盖 |
| A3 | ask create/answer/withdraw 先改变缓存再 persist。原生 rename EISDIR 后，缓存已有 ghost create/answered/withdrawn，磁盘却仍 pending；answer 重试被 ASK_NOT_PENDING 拒绝 | 锁内构造 next Map 与不可变更新；persist 成功才替换 live cache。三个真实 I/O 失败反例验证缓存/磁盘保留旧状态，恢复目录后同操作可重试成功 |
| A4 | DurableApprovalStore 把所有 read 错当作全新文件，并接受 version=999、坏数组/条目；审批审计可能被忽略或后续覆盖 | 仅 ENOENT 创建新 store。未知版本、坏结构、重复 id、非法记录拒绝且不改原字节；合法无 version 历史文件保留，在下次真实 decision 时正规写为 v1 |
| A5 | 两个真实进程同一授权、不同目录；仅延迟 A 的原生 ledger temp write，B 也能 bootstrap。两者都得到 remaining=1 | authorization claim lock 覆盖整个 bootstrap：记录 claim、检查现有根、预算落盘、established marker。私有 under-lock helper 避免嵌套自锁；同一 latch 只允许一个 first-run 得到预算 |
| A6 | ledger/claim lock 存在但无法读取，例如它实际是目录，read catch→continue 绕过 deadline；持续 EPERM+名字暂缺也是无限 retry。实际 child 声明 100ms、1000ms 后仍未退出 | 每次 loop 共用原始 deadline；非 transient 读错立即可诊断拒绝；ENOENT/Windows transient 回到统一期限，不以未持锁状态执行。三个 native child 反例通过 |
| A7 | ledger 的两个 stale reclaimers 都读取 dead owner 后延迟 rm。A 先删除并新建活锁，B 按旧 read 删除 A 活锁；两个真实 critical sections 重叠 | 所有 contenders 通过短独占 `.reclaim` guard 再读/创建/回收主锁，guard 以 owner nonce 释放且不自动抢占。真实双 child latch 验证串行，不靠随机概率；遗留 guard 不被静默删除 |
| A8 | JSONL→SQLite migration 将源目录 ENOTDIR/读错当作空源；坏 wrapper/未来 event ABI 在 dry-run 看似干净；非 duplicate 目标写错只打印 stderr，仍计为成功源行 | 非 ENOENT 源列举失败传播；wrapper/payload/声明 ABI 在 dry-run 与实写采用同一验证，坏行不计为可迁移事件；已关闭真实 SQLite 的 target failure 必须传播，只有明确 duplicate 是 idempotent no-op |

空审批文件的行为有意收紧：一个已存在的空文件不是“不存在的新 store”，无法证明它原先没有 pending request/decision。现在拒绝加载，保留原字节，不在之后的 mutation 中把它覆盖成看似完整的新审计记录；专门回归覆盖这个边界。

现有 ABI 缺省输入仍可由新 append 正规 stamp。已经落盘的无版本事件读取需要显式迁移，不做隐式“把未知历史理解为当前”的恢复。显式 JSONL migration 可升级既有无内部 ABI 标记的旧 event document，但有声明的未来 ABI 不能猜测；原源文件不被修改。

## 多 host 与交叉审查

确认同一 dataDir 没有通用 cross-process host ownership：两个真实 createHarness 进程（SQLite 后端、0 次模型请求）同时加载空审批快照，随后各创建一个合法 request，最终磁盘仅保留第二个，第一进程内存仍认为自己的 request pending。SQLite 五个表的事务不会保护外部 JSON approval/candidate/recovery 文件。证据为 `gen1-data-dir-host-probe.mjs/.json`；主实现已据此安排 CLI/Web 产品入口的独占 host lease，最终入口拒绝/释放/重启验收见产品主报告。SDK/embedder 仍须自行保证同 dataDir 的单 host 生命周期，不能把 SQLite 解释为任意组件均可多 host 并发。

交叉审查 coding-v1 安装、新 ModelRef 接入、provider retryable/safeToRetry、上下文溢出识别、fork 冻结快照及历史/审批隔离，没有发现需要绕过 ToolOrchestrator / PermissionEngine / SandboxManager 的实现。fork 在 policy 或历史复制失败时保持 failed，不暴露可运行的 legacy fallback；branch 不复制父 inbox/ask/approval/turn 身份。主 agent 另有具体产品入口与协议验收。

工具的新纯计算 Worker 不读文件、不执行进程、不联网；授权后的文本才送入它，异常/总预算/取消不能伪装成 zero matches，finally 等待线程终止。初版 grep Worker 的复审又发现 symbol fallback method regex 同类主线程阻塞：400000B `.py` 为 `"a(".repeat(200000)`，50ms abort 未执行，真实子进程 2 秒硬期限仍卡住。工具实现已扩展同计算隔离，并继续修复 TS index import/export 分类的真实阻塞；详情与来源见 [gen1-tools-comparison.md](gen1-tools-comparison.md)。分页保持完整原始文件 SHA，首行超限不给重复同 offset 的误导续读。

## 局部验收与证据

所有下表 GREEN 都在本子任务最终相关实现上执行。源码随后由主 agent 固定到 clean SHA，再执行完整发布门；这些局部结果不替代固定源码 release attestation。

| 验证 | 结果 | 原始输出（主报告归档） |
| --- | --- | --- |
| 初始 store/approval/问答反例 | 13 FAIL / 1 PASS，修复后 14 PASS | `gen1-independent-red.{json,log}`、`gen1-independent-green.{json,log}` |
| ask 三种原生持久化失败 | 3 新反例 RED，原加载两个反例已 GREEN | `gen1-ask-mutations-red.{json,log}` |
| migration 反例 | 5 FAIL → 5 PASS | `gen1-migration-red.{json,log}`、最终 persistence 报告 |
| 持久 store 新旧回归 | **7 文件 60 PASS / 0 FAIL / 0 SKIP** | `gen1-persistence-release-final-green.{json,log}` |
| 预算 bootstrap 反例 | 1 FAIL → 1 PASS | `gen1-budget-bootstrap-red.{json,log}`、native bootstrap probe |
| 预算 read/期限反例 | 3 FAIL → 3 PASS | `gen1-lock-bounds-red.{json,log}`、最终预算报告 |
| 预算 takeover | 修前真实双进程 critical sections 重叠，修后 2 回归通过 | `gen1-ledger-takeover-probe.{mjs,json}`、`gen1-budget-guard-green.{json,log}` |
| 预算新旧回归 | **9 文件 110 PASS / 0 FAIL / 0 SKIP** | `gen1-budget-all-final-green.{json,log}` |
| security 全包 + harness matrix | **2143 PASS / 0 FAIL / 0 SKIP** | `gen1-audit-security-full.{json,log}` |
| no-silent-catch 静态回归 | **4 PASS / 0 FAIL**，migration 定稿后重验 | `gen1-audit-no-silent-catch-final.{json,log}` |
| packages/store/session/security/evaluation TypeScript build | 通过 | 主 fixed-source typecheck 再覆盖 |

RED 中预算 deadline/takeover 和 migration 是逐项暴露后的中间工作树反例；其具体触发、真实进程、原生 I/O 与退出/输出均保存。不把所有中间反例错误标成同一个未经复算的 source SHA。

## 必须诚实保留的边界

预算锁与 claim 的保证是本机、同协议 contenders 的恢复完整性，不是防御任意修改/删除文件的本机操作者。原 ledger unknown-owner 保守占用。claim 原有的旧无 owner 文本在足够旧时按 legacy debris 恢复合同保留，活的可解析 PID 不因年龄被抢；新 `.reclaim` guard 完全不做年龄抢锁。这个兼容区别不能被概括成“所有未知 owner 都会自动安全恢复”。

如果进程恰好在持有短 `.reclaim` guard 时被强杀，它会遗留 guard。之后明确报带路径的 BUDGET_LOCK_HELD/CAMPAIGN_CLAIM_LOCK_HELD，而不是递归猜测是否可以偷锁。操作者需确认原 host/PID 已死且无正在运行的相关 campaign 后，显式清理那一个 guard；主 ledger/claim/消费记录不应被删除。新 guard 的存在是用可诊断恢复步骤换取不双发预算。

原审批/JSONL adapters 的 single-writer 范围不因此变为分布式 store。现有版本化文件工具的锁与最终 SHA 重查也不等于跨任意外部进程的原子文件 CAS。真实模型的任务成功率、费用与多模型比较仍需单独 paired eval，状态保持 NOT_PROVEN。
