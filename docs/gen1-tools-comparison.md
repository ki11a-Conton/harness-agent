# 第一代编码工具源码对比与验收

基线为 `22d97d860cfa1001df578b1193b3bc4c8ee1bce1`。本轮只扩展和修复 `packages/tools` 的文本读取、搜索与计算，不改 ToolOrchestrator / PermissionEngine / SandboxManager 边界，不修改冻结的 `coding-v1` 提示词正文或 N7 数据。

## 实际源码对比

完整文件 SHA256 与来源 Git SHA 见 [gen1-tools-source-manifest.json](gen1-tools-source-manifest.json)。工作区参考集合为 `HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，DeepSeek Harness 为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。

| 项目与已读源码 | 值得采用的能力 | Harness 基线已有能力与差距 | 本轮决定与映射 |
| --- | --- | --- | --- |
| pi，MIT：`packages/coding-agent/src/core/tools/read.ts`、`truncate.ts` | 1-based offset/limit，完整行与 UTF-8 字节预算，明确续读位置，超长首行不给误导续读 | read_file 有普通/版本化读取、权限前置、文件锁、描述符清理、FIFO 拒绝，但参数只有 path/versioned，大文件后半部分不能以本地工具分页访问 | 将分页和完整行预算算法适配到 `packages/tools/src/read-window.ts`；旧普通文件输出保持兼容 |
| pi，MIT：同目录 `grep.ts` | literal 查询，长匹配行截断，明确匹配上限及结果不完整 | grep_search 使用 JS regex，原来单文件被当目录、长行与大文件静默遗漏，模型不能看到 metadata 中的完整性 | 新增 literal 与 includeSummary；保持默认 hits[]，新增显式摘要 envelope；长行围绕真实匹配截断 |
| DeepSeek Harness，MIT：`packages/fs/tool-fs/src/read-render.ts`、`read.ts` | 大文件流式扫描，单个无换行巨行也不会无限扩大缓冲，扫描后给精确总行数 | 版本化 SHA 必须保持完整原始字节语义，不能把页面 SHA 冒充完整文件版本 | `read-window.ts` 以 64KiB 原始块扫描，最多保存页面预算内的完整行；同时统计总行数和可选完整 raw SHA256，不移植 Cordis/fs provider 或沙箱 |
| pi，MIT：`edit.ts`；DeepSeek Harness，MIT：`packages/fs/tool-fs/src/edit.ts` | 精确锚点/唯一匹配、改前观察与版本保护、diff | Harness 已有 occurrence/replaceAll、line range、strict profile、expectedSha256、CRLF/BOM 与无效 UTF-8 保护、同进程锁、版本冲突拒绝 | 保留现有工具与兼容接口；本轮验证分页得到的完整文件 SHA 可用于旧版本保护，没有加入宽松 Unicode 模糊匹配或新的写入路径 |
| Codex，Apache-2.0：`codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs` | 可持续命令会话、PTY、分段结果与终止/审批链 | Harness 已有普通 shell/结构化 argv、Windows shim、流式事件、取消/超时和进程树终止、输出截断、工作区 cwd 与沙箱执行；未提供可交互 PTY/后台任务句柄 | 本代保留经过现有 Windows 测试的前台执行，Rust unified-exec 不是可直接复制到本架构的单个 TS 工具。未将没有实现的 write_stdin/PTY 写入提示词 |
| Hermes，MIT：`tools/file_tools.py` | 分页、next_offset、超量读取的可恢复提示、实际工作区路径统一 | 本仓库已存在工作区解析、版本工具和 runtime 安全层，不需要复制 Hermes 的全局 task tracker 或另一套文件/终端策略 | 对照分页语义与恢复提示，未复制 Python 集成或内部路径策略 |

pi 算法出处与 Mario Zechner 版权在 `read-window.ts` 的文件头保留，完整许可为 `third_party/coding-prompts/pi-MIT.txt`。DeepSeek 流式扫描设计的归属在文件头保留，完整 MIT 原文为 `packages/tools/licenses/deepseek-harness-MIT.txt`，与来源 LICENSE 字节 SHA256 相同。其余本轮工具改动为 Harness 原代码修复；比较 Codex/Hermes 不表示复制其全部实现。无许可或明确泄漏的 Claude 源码没有被分析或移植。

## 可复现缺陷与修复

| 缺陷 | RED 证据与触发 | 最终行为 |
| --- | --- | --- |
| 单文件 grep 返回成功空数组 | `grep_search({path:"代码.ts",pattern:"needle"})`，文件实际含 needle；原代码 `readdir(file)` 吞错 | 对选定文件直接搜索，路径、行号、CRLF 文本与 Unicode 文件名保留 |
| 长行真实匹配被静默漏掉 | 2100 个 x 后跟 needle，原代码遇到 line.length>2000 直接 continue | 搜索完整受控文件文本，保留原始 column；围绕匹配输出最多约 2000 UTF-16 单位并标注 truncated，避免拆开 surrogate pair |
| 大文件/不可读文件被遗漏却看似完整零匹配 | >512KiB 文本实际含 needle，原来无诊断 | 默认旧数组在遗漏文件时返回明确 SCAN_INCOMPLETE 错误并保留正向 hits；includeSummary=true 返回 `{summary,hits}`，summary 放在前面且 complete=false。512KiB 搜索上限保持受控，不伪造全库负证据 |
| read 分页参数被默默忽略 | offset=2/limit=1 返回整文件；offset=0 也成功 | schema 验证正整数与上限，按页面返回内容及 startLine/endLine/totalLines/nextOffset，无效参数在打开描述符前拒绝 |
| 搜索取消后仍遍历/成功 | 第一次实际读取之后 abort，原 grep 继续读 sibling | grep、walk、repo_tree、symbol fallback 在 I/O 前后传播信号；无终态输出/证据，描述符/worker 释放 |
| 用户 regex 阻塞 UI，工具 timeout 无法触发 | 实际 dist/orchestrator：`(a+)+$` 搜索 60 个 a 后的 !；50ms abort、100ms tool timeout 均冻结，父进程 2 秒硬 deadline 杀死 | regex 只在计算 Worker 中运行；一个 Worker 和 5 秒总预算覆盖同次搜索的所有文件，外部工具 timeout/abort 可及时终止。相同 native dist probe 修复后 52ms cancelled、进程总 177ms |
| 固定 symbol fallback method regex 也会阻塞 | .py 文件 `"a(".repeat(200000)`，独立审查实际 dist 2 秒硬 deadline，50ms abort 冻结 | 固定全局 heuristic regex 复用同一纯计算 Worker；保留原先 pattern 顺序、kind/name/line/text，取消与超量失败不会被解释为零匹配 |
| TS index import/export 分类 regex 阻塞 | `imports.ts = "import " + "a ".repeat(100000)` 或 `"export {a ".repeat(40000)`，indexedSymbolSearch({symbol:"a"})，实际 dist 2 秒不返回且定时器冻结 | 改为线性 import head/from/binding 与 export head 分类；import 相同 native dist probe 修复后总 138ms，定时器运行；default/type/named alias/namespace/named export 分类均测试 |
| 默认整文件读取可以为巨大 regular file 分配内存 | 旧实现不检查大小即 handle.readFile | 默认 full read 对观测 size>16MiB 文件明确 READ_FILE_TOO_LARGE，不分配整文件；分页仍能以有界保存缓冲扫描/访问。普通文件旧字符串/版本对象保持兼容 |

Worker 使用自包含 Node data URL，只进行 regex/text 计算，没有 filesystem、child_process、网络操作；文件仍由现有权限与沙箱批准后读取。它可被开发 Vitest、普通 Node dist 和独立 portable JS 资产导入，生命周期在 finally 中 await terminate。固定字符串查询不启动 Worker。

## 新工具使用与边界

```text
read_file({path:"src/large.ts",offset:120,limit:60,maxBytes:4000,versioned:true})
grep_search({path:"src",pattern:"foo([value])",literal:true,includeSummary:true})
```

分页 offset 从 1 开始，limit 默认/上限 2000；maxBytes 默认 50KiB、上限 1MiB。只有显式提供 offset、limit 或 maxBytes 才选择分页输出。页面的 sha256 仍代表完整原始文件，且控制字段排在 content 前；页面内容只是局部，修改应使用 edit_file 和完整版本，不将页面直接作为 write_file 全文件覆盖。

首行本身超过字节预算时，content 为空并明确 firstLineExceedsLimit/hint，没有误导的 nextOffset；应增加 maxBytes 或在批准的 exec 中定向检查。分页为了完整 SHA/总行数仍扫描完整文件，I/O 时间取决于文件大小，取消在每个 64KiB 块后检查。它限制保存的内容和内存，不声称免除所有磁盘读取。

grep 的原始 hits[] 与 maxResults 上限保留；在输出正向命中之外，确认“没有结果”必须使用 includeSummary=true 并检查 complete=true。遇到 binary、ignored directory、oversized file 等情况要检查摘要/工具描述的搜索范围，不能推断所有文件类型都没有内容。symbol_search 仍为有明确 fallback/indexer 的 heuristic，未引入完整 LSP/语义解析。

文件版本锁只协调本进程内工具；改前 raw SHA 重查不能提供跨任意外部进程的原子 CAS。默认 full-read 16MiB 判断基于打开的描述符 stat，外部并发增长不是原子快照。TS index cache 的共享加载可为其他查询继续完成，取消一个查询不会拆掉其他查询的共享缓存。前台 exec 不等于 PTY/长期后台任务。上述边界保留说明，不称本代已覆盖其他 agent 的所有能力。

## 本轮定向验收

初始 `gen1-text-tools.regressions.test.ts` 6/6 RED；代码修复后的第一次 4 文件 57 项 GREEN。加入流式页面、许可、Worker、稀疏大文件拒绝、真实主线程阻塞修复后，最后定向回归为 **12 文件 224 项通过，0 失败/0 跳过**，记录为 `gen1-tools-final-v4.json`，`pnpm exec tsc -b packages/tools` 通过。这是工具子任务验收；完整产品的固定源码、Windows、CLI/Web、独立安装及 CI 证据由主验收另行绑定。

原始证据暂存，主验收归档时保留这些文件并绑定最终源码 SHA：

- `/tmp/gen1-text-tools-red.log`、`/tmp/gen1-text-tools-green-first.log`。
- `/tmp/gen1-grep-red-probe-20261008.mjs`、`/tmp/gen1-grep-redos-red.json`、`/tmp/gen1-grep-redos-green.json`。
- `/tmp/gen1-symbol-redos-probe.json`（独立复审提供）。
- `/tmp/gen1-index-symbol-redos-probe.mjs`、`/tmp/gen1-index-symbol-redos-red.json`、`/tmp/gen1-index-symbol-redos-green.json`。
- `/tmp/gen1-index-export-redos-probe.mjs`、`/tmp/gen1-index-export-redos-red.json`、`/tmp/gen1-index-export-redos-green.json`。
- `/tmp/gen1-symbol-redos-probe.mjs`、`/tmp/gen1-symbol-redos-green.json`。
- `/tmp/gen1-tools-final-v4.json`、`/tmp/gen1-tools-final-v4.log`、`/tmp/gen1-tools-typecheck-final.log`。

测试包含完整旧输出、CRLF/BOM/Unicode、跨块 UTF-8、完整 raw SHA、零/末尾空行、巨大无换行行、稀疏文件 admission、schema/权限拒绝零 I/O、取消与 Worker 生命周期、正则 flags/列号、多文件统一预算、literal 无 Worker、版本与编辑既有回归。没有付费模型调用；工具成功与真实模型质量提升是不同的证据。
