# Harness Agent：当前执行计划入口 — 文件读取的取消与资源清理

日期：2026-10-05（Asia/Shanghai）。基线 `9b0a46787ea6ffb17f8003bdf4953866e606151b`。生产修改前提交本计划。上一轮入口原字节保存在 [上一轮计划](plan(20261005-agent-next2-entry-before-next3).md)。不可变规格：[plan(20261005-210819).md](plan(20261005-210819).md)。任务合同：[AGENT-NEXT3-20261005.md](tasks/AGENT-NEXT3-20261005.md)。

## 审查依据

在干净基线上沿 production registry→ToolOrchestrator→Permission→Sandbox 的 native FIFO 实测：60ms 超时约62ms返回后 fileLockEntryCount=1、native read pending=1，后续同路径调用仍超时；只有350ms外部writer后资源释放。caller在20ms取消却到182ms外部writer后才结束。普通文件控制通过，起止源码/dist hash相同。原始证据保存在 `.ci/agent-next3-20261005/baseline-fifo/`，完成时原字节归档。这是 AGENTS.md Runtime Freeze 允许的 deterministic resource defect，非模型策略改写。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- | --- |
| F1 特殊文件隔离 | read_file 不因FIFO、设备或目录读取而阻塞agent工具通道 | 仅修改 read-file.ts：以只读非阻塞flag打开，使用该FileHandle.stat判断isFile；拒绝非普通文件，finally关闭已打开句柄。允许沙箱内指向普通文件的alias，保持原schema/output/evidence/error合同 | 基线正式RED→GREEN；native FIFO无需外部writer在250ms内failed，0 pending read/lock/owned descriptor；重复同路径不超时；FIFO alias及open前替换成FIFO也安全拒绝，目录/Unix socket控制。设备原生探针仅沙箱明确允许且权限通过时执行 | DONE |
| F2 取消清理 | 普通文件读取响应有效取消且释放资源 | 在打开/检查/读取边界检查原signal；FileHandle.readFile接收signal，AbortError映射cancelled，finally先关闭句柄再由既有withFileLock释放锁。保留原串行文件协作 | 受控native handle读取前/中取消、open/stat异常、read异常、排队取消/timeout、关闭失败控制；取消无success/evidence，owned handle关闭、锁最终0。实际timeout调度允许async close后一个有界250ms cleanup窗口，不假称Promise.race返回瞬间全部清理 | DONE |
| F3 普通文件兼容 | 内容、raw-byte hash、编辑闭环及安全门不回退 | 不改Core/Orchestrator/Permission/Sandbox/锁实现/写与编辑工具/依赖；regular file的UTF8解码、versioned输出与evidence保持 | 空文件/BOM/CRLF/Unicode/invalid UTF8/hash/路径alias/hardlink、缺失文件控制；权限拒绝/逃逸/pre-abort零open；既有r4/vs001/scoped-search回归与真实Harness搜索→read→conditional edit闭环通过 | DONE |
| F4 冻结联合验收 | 同一源码验证工程行为 | 实现/新增测试/可重跑实测脚本提交后冻结；typecheck/build、相关tools/Harness/security、生产探针、既有CLI/Web与browser；一次具名全仓及同run strict usage；源码/dist起止hash核对 | 各门exit0；新增Linux测试0skip/todo；全仓至少8690既有PASS+全部新增、469既有PASS文件+新增，恰好12既有skip且来源不变；strict同run7能力observed；生产探针PASS且引用确切clean源码 | DONE |
| F5 证据与发布 | 完成可复核结果并发布main | 原始baseline/RED/失败与final全部保留，SHA256索引+Git blob字节校验；完成docs单独commit；用户授权token仅原生Git/curl非强制推送+两种远端ref核对 | plan全部DONE、报告标识tested source与完成docs分开；旧证据完整性通过，本地clean且main原生Git/API SHA一致，无凭据落盘 | DONE |

## 边界

允许生产修改仅 `packages/tools/src/tools/read-file.ts`。必要新增回归、研究脚本、计划/任务/证据文档与原字节属性可新增；所有既有测试、其他生产源码、contracts、默认模型策略和权限/沙箱均不改。旧edit_file/checkFileVersion/write_file的特殊文件I/O不在本轮修复范围，不宣称所有文件工具已解决该问题。普通文件不引入新的大小上限，完整version/hash合同保持；输出限制仍由现有Orchestrator执行。不宣称非协作外部writer的atomic CAS或一般Sandbox TOCTOU已修复。

Linux native FIFO可实测；Windows原生执行、真实模型任务质量和策略promotion均NOT_RUN，无模型凭据、paid calls=0。本轮不新增子智能体；自行完成代码/证据复核。网络当前observations_current、unrestricted/enforced，无模型secret。GitHub禁止连接器，只使用已授权原生Git/curl。

## 完成记录

受测源码 `5e4d9b8f23e596e887c18a46f8e031d41b8a458e`。14个冻结门全部PASS：新增23项无skip/todo，全仓8713 PASS/12旧skip，same-run strict usage7项observed。18个生产场景与实际Harness搜索→versioned read→conditional edit通过；browser27场景/0error。

[验收报告](docs/evidence/agent-next3-20261005.md) 包含实现、实际计量、原始失败与边界，[完成入口快照](plan(20261005-agent-next3-completed).md)保留本入口。受测源码已原生Git/API核对发布，完成docs单独提交，所有生产/测试/脚本保持受测字节；最终完成检查及main SHA核对在收尾发布中执行。原始规格不修改。
