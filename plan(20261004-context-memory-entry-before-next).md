# Harness Agent：当前执行计划入口 — 默认指令预算与中英记忆检索

详细实施前规格：[plan(20261004-065049).md](plan(20261004-065049).md)。日期：2026-10-04。
实施基线：`17aa6c7471faf8bdec020b45bfe7b9bb45470131`。UI 已按顺序完成，记录在 [UI 完成计划](plan(20261004-ui-completed).md)；不覆盖原始制定快照或历史证据。

本轮先读源码并用生产类/Harness 请求复现，再制定这份计划。此前源代码借鉴工作中的 path-scoped adapter 已提供 bounded capture 和 admitted identity 的实现参照；本轮修复默认路径的确定性缺陷，不推广实验策略，也不改 Core。

已测基线：默认 50,000B 预算读取 16MiB 单行文件后输出 16,777,248B，多行输出 50,026B；0/1/4B 小预算也超限，cwd AGENTS 文件 symlink 读到外部正文。注入/预算拒绝正文未进入真实请求，却仍改变 step/model instructionFingerprint。记忆 30 项存储控制 21 通过/9 失败，12 个真实 Harness scripted 请求 6 通过/6 失败；SQLite FTS 有合法零命中和有正命中的子串遗漏，两种后端均不检索模型渲染的 When/Do/Avoid。

| 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- |
| A1 默认指令严格有界 | 保留 root→nested→cwd 顺序/来源/原始 size；读文件 handle 的有限前缀，拒绝 symlink/nonregular；输出 UTF-8、正文和截断 marker 合计不超过 cap。优先完整行，无可用完整行则 UTF-8 边界前缀。0/tiny/非法预算 fail closed，不整文件 readFile | 先新增行为 RED，再 GREEN；0/1/4/99/100/50k、ASCII/中文/emoji、exact cap、多行、16MiB 单行/多行、畸形 UTF-8、symlink/unreadable、顺序控制。观察应用捕获字节≤cap+4，输出≤cap，无引入替换字符导致溢出 | DONE |
| A2 指纹对应实际指令 | Harness 默认 composition adapter 只把 final admitted project blocks 的对应 discovery 内容作为 instructionSources；原 ContextPipeline raw discovery debug 合同和安全审计保留，不修改 Core | 真实 Harness 双 turn：允许正文改变请求及指纹；注入/预算拒绝正文变化均不改变指纹，仍有 security.injection_denied/context.dropped；step 与 model.started 一致；默认和 opt-in 已有集成继续通过 | DONE |
| A3 中英/结构化记忆召回 | 共享 literal substring/既有 token matcher 和可搜索正文投影（content+合法 structured.when/do/avoid）；JSONL 与 SQLite 补充投影命中，SQLite 保留既有 FTS 顺序、补集去重。不搜任意 metadata，不迁移 schema，不新依赖 | 原固定 30 项全部 PASS、12 请求全部 PASS，FTS 正命中+子串补集 2/2；旧 DB reopen、update/remove/migration、%/_/引号字面量、miss/type/scope/foreign session/inactive/injection/secret 控制；实际请求 memoryRefs 对应正文，候选仍走 TopK/safety gates | DONE |
| A4 性能/验收/发布 | 冻结候选源码，原样重跑审查探针并记录实际 source/dist/hash；10k 固定记忆数据测 warm FTS/中文/结构化/miss，报告新增 filtered-row 扫描成本，不宣称检索性能提升；联合全仓回归和原生 Git 发布 main | 定向 context/memory/Harness、typecheck/build/security/docs PASS；具名全仓 pnpm test 与 strict usage-audit PASS，新增测试无 skip；独立源码/证据审查、raw artifact hashes 与 diff check PASS；本地/远端 main SHA 一致 | DONE |

范围：packages/context 默认 discovery；packages/harness 默认 context composition 与对应回归；packages/memory 搜索及相关回归、研究脚本/证据。只改变已实测失效的读取、身份与召回合同。记忆存储接口不增无依据的候选上限；现有 search 无 limit，补集按 deleted/type/scope SQL 过滤后线性扫描，检索 TopK 和生命周期/session/安全门维持。性能结果如出现异常须报告并处理，不隐瞒线性成本。

限制：scripted provider 验证实际生产接线和请求内容，不是模型质量/任务成功收益评测。paid=0，realModelQuality、promotion NOT_RUN；不做 vector/RAG、不更改权限/沙箱/验收路径、不扩张 runtime 架构。默认 discovery 的原先“首行可越预算”例外由本计划的明确硬预算合同取代；历史任务记录和原证据不改写。

证据基线：`.ci/agent-context-memory-20261004/audit-context/` 与 `audit-memory/`；最终复制原始字节到 `docs/evidence/agent-context-memory-20261004/raw/`，索引 sha256/bytes，不覆盖基线。任务：[AGENT-CONTEXT-MEMORY-20261004.md](tasks/AGENT-CONTEXT-MEMORY-20261004.md)。GitHub 仅使用原生 Git/curl，最终联合测试源码与完成证据提交分开标识。

CI 验收补充（Windows ecc45e5）：既有 S2 CLI AB/BA 测试仅统计 readFile，A1 有界句柄读取使其观测为0。将该测试观察器改为首次实际 bytesRead 捕获计数，保留每请求4文档、目录扫描和固定输入/独立内容检查/ABBA身份的全部约束；追加 default readFile=0 断言，不恢复无界读取。纯测试接线变更纳入 A4 与 apps/cli/src/path-scoped-instructions.test.ts，不推广实验策略。原 CI FAIL 与本地中断的部分full记录保留，不能当完整PASS。

完成验收：冻结source35663ba，全仓8419PASS/12既有SKIP，strict usage-audit、security2135、typecheck/build/docs/两个artifact索引和diff全部PASS；同SHA Ubuntu/Windows CI37185965733的10/10 jobs成功。最终生产29/30/12/2及联合UI26场景74断言通过。原生Git main已发布并由两种ref方法核实等于受测source；最后文档完成记录提交的main最终SHA及核验在最终答复和ignored final-publication-verification.json标明。任务DONE；真实模型质量/promotion NOT_RUN，10k扫描成本如实见[最终报告](docs/evidence/agent-context-memory-20261004.md)。
