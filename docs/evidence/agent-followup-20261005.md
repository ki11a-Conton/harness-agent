# Harness Agent：流式计量、符号搜索与指令捕获验收报告

2026-10-05。本轮按 [plan.md](../../plan.md) 完成 R1–R4；冻结源码的 15 个验收门全部通过，原生 main 源码发布已核对。后续完成提交仅包含文档、原始证据与字节属性；生产代码、测试和研究脚本保持冻结版本。

基线 `f71b444eec6b4024039716a1a0a01bade22c90b0`；实施前计划提交 `b00299e5d0da03656c00e2041fc261aa01af6c96`；实际验收源码 **`2476c23444079a2cba29480b35d65157cf30c0fd`**。[实施前规格](../../plan(20261005-033848).md) 是原始预注册规格的逐字节副本，SHA-256 `670466d824a03c6cb60113ff0f1756c110fdb7aa690ad10beb34264ab196b32a`；[任务合同](../../tasks/AGENT-FOLLOWUP-20261005.md) 说明 Runtime Freeze 的可复现缺陷例外和修改范围。

## 实际改动与生产实测

| 项目 | 做了什么 | 冻结源码的实际验收 |
| --- | --- | --- |
| R1 流式计量与取消 | 收齐正常 finish 后的独立 usage footer；footer 只更新计量；取消不能变成成功；区分调用者取消、超时、读取错误；最终释放 reader，清理失败只输出固定脱敏诊断 | [31 场景、26 次真实 HTTP](agent-followup-20261005/raw/frozen-2476c23/r1-provider/result.json)全部 PASS：同帧/分帧/跨网络分块、partial 与最终 snapshot、正常/异常结束、footer 注入、buffered/native abort、consumer break、读取/清理失败 |
| R2 搜索范围与混合语言 | 实际枚举和读取限于获准目录/文件；root+scope 隔离缓存与并发；绝对/相对路径一致；TS 无命中时恢复既有其他语言 fallback | [32 个生产工具场景](agent-followup-20261005/raw/frozen-2476c23/r2-symbol/result.json)全部 PASS，实际 ToolRegistry→Orchestrator→Permission→Sandbox；cold/warm/并发/切换范围不读取其他范围源码，deny/outside 零 source I/O |
| R3 opt-in 指令捕获 | NONBLOCK/no-follow、真实 regular file、descriptor/path revision 前后检查；完整捕获 `min(fileSize, cap+4)` 前缀；fatal UTF-8/BOM；失败不缓存、close 错误隔离 | [51 个生产场景](agent-followup-20261005/raw/frozen-2476c23/r3-instructions/result.json)全部 PASS，含实际 FIFO 非阻塞打开、竞态/错误注入、独立默认策略控制、6 个实际 Harness 场景/7 个 turn |

R2 仍保留 TS 命中优先和 regex heuristic，不声称混合返回所有语言的全部语义定义。R3 的 UTF-8 校验覆盖完整捕获的前缀；未读取的文件尾部不在验证范围内，预算外未完成码点按既有 bounded decode 规则处理，最终只输出完整码点。默认 instruction/memory 策略、marker、targets、Core、权限、Sandbox、Verification 均未修改。

[实际 CLI/Web main](agent-followup-20261005/raw/frozen-2476c23/r1-main/result.json) 使用本地 OpenAI 兼容 HTTP 服务：7 场景、10 次真实请求全部 PASS。CLI 工具闭环 2 次模型调用，durable accounting **input=20/output=12/source=measured**；Web 正常及工具闭环 3 次调用，**input=30/output=18/source=measured**。每次请求 10/6，最终 snapshots 不重复累加。完整请求与持久化事件保留，AGENTS 准入/拒绝、system 送达、Web memory 默认 OFF 控制通过。

## 联合验收

[最终 manifest](agent-followup-20261005/raw/frozen-2476c23/manifest.json) 的 15 门均 exit0，前后 clean SHA 一致；1,081 个 tracked source 文件与 3,488 个 build 文件的前后 SHA-256 相同。每门保留 argv、退出码、原始日志 bytes/hash；各生产 receipt 也绑定 clean source 和 source/dist 指纹。

| 验收门 | 实际结果 |
| --- | --- |
| 新增正式回归 | [4 文件、95 PASS、0 skip/todo](agent-followup-20261005/raw/frozen-2476c23/new-regressions.log)：model33、tools23、context34、Harness5 |
| 相关集成 | [59 文件、974 PASS、10 既有 skip](agent-followup-20261005/raw/frozen-2476c23/related-integration.log) |
| 全仓测试 | [463 文件 PASS/1 文件 skip；8,579 测试 PASS/12 skip](agent-followup-20261005/raw/frozen-2476c23/full.log)，0 fail/todo，exit0 |
| 同次运行 strict usage | [7 项关键能力全部 observed、PASS](agent-followup-20261005/raw/frozen-2476c23/usage-audit.log) |
| 相关安全 | [19 文件、2,135 PASS、0 skip](agent-followup-20261005/raw/frozen-2476c23/security.log)，原安全扫描未改 |
| Chromium 浏览器 | [27 场景、77 断言、0 errors](agent-followup-20261005/raw/frozen-2476c23/joint-browser/browser-result.json)，实际 Web/Gateway/Harness 及受控协议检查 |
| typecheck/build/docs、既有证据与 diff-check | PASS，原始命令和结果在 manifest |
| 独立最终复核 | [PASS](agent-followup-20261005/raw/review/final-runtime-review-2476c23.json)，核对源码/Git blobs、日志/receipt、产物、skip 和同 run usage |
| 原生 main 源码发布 | [PASS](agent-followup-20261005/raw/publication/source-verified.json)，本地、Git ls-remote、GitHub ref API 均为 `2476c23444079a2cba29480b35d65157cf30c0fd` |

全仓和 usage 属于同一具名 run `agent-followup-linux-2476c2344407-1791179412795188385`，7 条 observations、dropped=0。实际 12 项 skip 的 [来源及原始摘要复核](agent-followup-20261005/raw/review/skip-full-lineage-2476c23.json)：Windows executor7、Windows execution boundary3、历史 setup alternate proof1、opt-in release E2E1；四个测试文件与基线 Git blobs 逐字节相同。新增 95 项没有跳过。

## 保留的失败与证据来源

| 历史记录 | 原始结果和修正 |
| --- | --- |
| 正式 RED | [R1](agent-followup-20261005/raw/audit-model/formal-red-receipt.json) 18 fail/5 pass；[R2](agent-followup-20261005/raw/audit-tools/red-confirmed/manifest.json) 21 fail/2 pass；[R3](agent-followup-20261005/raw/scoped-read-red/receipt.json) 20 fail/14 pass，均0skip。相关生产文件为基线；当时工作区 dirty，不能冒充冻结验收 |
| 初次 model 定向检查 | [146 pass/1 fail](agent-followup-20261005/raw/audit-model/green-review-initial/model.log)。旧 mock 忽略 permanently expired whole-call signal 并期待成功；只修测试 oracle 为 timeout/禁止 completed/tool，保留2-fetch/1-retry，未重置 deadline |
| `be53708` 冻结 | [security 2134 pass/1 fail](agent-followup-20261005/raw/frozen-be53708/security.log)。静默 cleanup catch 被既有扫描发现；改固定脱敏诊断并增加2个releaseLock控制，扫描器未改 |
| `80a415d` 启动拒绝 | [exact-SHA guard FAIL、0 commands](agent-followup-20261005/raw/frozen-80a415d/manifest.json)。根代理错误提供期望SHA，当时实际cleanHEAD为670561b；不是runtime测试失败 |
| `670561b` 冻结 | [docs FAIL](agent-followup-20261005/raw/frozen-670561b/docs-verify.log)，安全已2135PASS。计划缺当前入口marker；2476c2仅修计划入口与标准timestamp规格链接，docs validator及实现/测试/探针未改 |

失败 manifest/logs 未改写 PASS。较早的独立源码/探针复核仍保留当时 full/usage PENDING，后续结论由新的最终复核提供。所有 dirty 探索明确标记，正式候选只认 clean2476c2。

上下文基线 JSON 有一项来源限制：`audit-context/baseline.json` 初版被更新为带 guarded FIFO 控制的 v2；初版 JSON 原字节未保存。不能称该名字仍是不可变 v1。[初版 stdout](agent-followup-20261005/raw/audit-context/baseline.stdout.log) 与 [stderr](agent-followup-20261005/raw/audit-context/baseline.stderr.log) 保留，正式引用 [v2 原件](agent-followup-20261005/raw/audit-context/baseline-v2.json)。baseline 缺 NONBLOCK 时先 guard 避免 native FIFO 阻塞，candidate 真正非阻塞打开并拒绝非regular。

R3 RED 测试后有 `Stats.mtimeMs` number|bigint 编译适配为 `Number(mtimeMs)+1`，断言不变；旧测试/生产快照和日志原件保存在 scoped-read-red，与原receipt哈希一致。

## 原字节归档与发布边界

[artifact-index.json](agent-followup-20261005/artifact-index.json) 收录 **406 文件、9,524,514 字节**，逐文件 SHA-256 与 bytes 校验通过；包含基线/RED、全部失败与 dirty 探索、最终冻结结果、独立复核和原生源码发布。原件完整按字节复制，未覆盖原始结果；raw 使用 `-text` 防止跨平台换行改写，Git staged blob 同样逐字节校验。

[归档后独立复核](agent-followup-20261005/archive-review.json) 核对原件/索引/working/staged Git bytes，以及完成文档与冻结实现的关系。后续完成提交与 tested source 分开：只有文档、证据、字节属性；最终 main 提交在原生推送后另行核对，不在报告中自引用尚未生成的提交SHA。没有把完成文档提交描述为再次运行过全仓测试。

paid=0；真实模型任务质量、champion promotion、Windows 实机执行均 **NOT_RUN**。本轮证明工程协议、计量、范围隔离和捕获正确性，不据此推断真实模型任务成功率提高；未复用其他源码的 GitHub CI 结果。
